/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Component 4 — `KagentTraceSinkAdapter` (R3 §4.1).
 *
 * Bridges Vercel AI SDK's `streamText` lifecycle (its `onStepStart` /
 * `onStepFinish` / `onToolCallFinish` hooks) into kagent's `TraceEntry`
 * schema in `@kagent/agent-loop/src/trace.ts` so the existing
 * `computeQualityFlags` lookback walker (which reads
 * `iteration_boundary` markers + `tool_call` entries per
 * `quality-flags.ts:182-210`) sees a compatible trace shape.
 *
 * Mapping (R3 §1 row "Vercel AI SDK"):
 *   - Each AI SDK `step` boundary  → kagent `iteration_boundary` entry.
 *   - Each AI SDK `step` finish    → kagent `llm_call` entry with
 *                                    `model`, `input_tokens_est`,
 *                                    `output_tokens_est`, `stop_reason`.
 *   - Each AI SDK `toolCall` finish → kagent `tool_call` entry.
 *   - Final stream finish           → kagent `run_complete` entry with
 *                                    cumulative tokens + status.
 *
 * The adapter exposes `onChunk`/`onStepFinish`/`onToolCallFinish`
 * callbacks that the runner passes directly into `streamText`'s
 * options. Internally the adapter owns a monotonically-increasing
 * sequence counter so the produced `TraceEntry`s match the executor's
 * sequence-number invariant (every entry's `sequence` strictly
 * greater than the previous, single counter shared across all entry
 * types — `executor.ts:24-27` invariant 1).
 *
 * Production wiring (R3-LOW-2): the bridge accepts an optional
 * `traceSinks?: readonly TraceSink[]` array. Each entry pushed onto
 * the in-memory `traces` collection is ALSO forwarded to every
 * registered sink via `sink.emit(entry)`. This mirrors
 * `executor.ts:emitToSinks` — production OTel / Langfuse / Stdout
 * sinks see the same record stream the kagent reference loop emits.
 * Caller is expected to construct sinks via the existing
 * `@kagent/trace-sinks` factories (or any custom `TraceSink`
 * implementation). Sink errors are swallowed — emit MUST NOT crash
 * the run, matching the reference loop's invariant in
 * `trace.ts:169-172`.
 *
 * Back-compat: when `traceSinks` is undefined the bridge behaves
 * exactly as the pre-R3 in-memory collector — `traces()` returns
 * the same array and tests that read the array continue to work.
 */

import type { TraceEntry, TraceSink } from '@kagent/agent-loop';
import { estimateTokens, truncateForStorage, truncateMessages } from '@kagent/agent-loop';

export interface TraceSinkBridgeOpts {
  readonly runId: string;
  /** Model id surfaced on `llm_call` entries. */
  readonly model?: string;
  /**
   * Optional fan-out sinks — every emitted `TraceEntry` is forwarded
   * via `sink.emit(entry)` so production OTel / Langfuse / Stdout
   * sinks receive the same stream the kagent reference loop emits.
   * Construct via `@kagent/trace-sinks` factories or any custom
   * `TraceSink` implementation. Sink errors are swallowed — emit
   * MUST NOT crash the run.
   */
  readonly traceSinks?: readonly TraceSink[];
}

/**
 * Subset of AI SDK `StepResult` we read. Typed locally so the bridge
 * doesn't pin to an exact AI SDK minor version.
 */
// Fields are typed as `T | undefined` rather than optional `?: T` so the
// shape stays assignable from AI SDK's `OnStepFinishEvent` which declares
// `usage.inputTokens: number | undefined` (required key, possibly
// undefined value). Under `exactOptionalPropertyTypes: true` an
// `inputTokens?: number` accessor is NOT assignable from a required
// `inputTokens: number | undefined` source — so we model presence-with-
// possibly-undefined explicitly.
interface StepLike {
  readonly text?: string;
  readonly finishReason?: string;
  readonly usage?: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
  };
  readonly toolCalls?: readonly { readonly toolName?: string; readonly input?: unknown }[];
  readonly toolResults?: readonly {
    readonly toolName?: string;
    readonly output?: unknown;
  }[];
  readonly request?: { readonly body?: unknown };
}

/**
 * Handle returned by the bridge — the runner wires the callbacks to
 * `streamText` opts and reads `traces()` after the stream completes.
 */
export interface TraceSinkBridgeHandle {
  /** Pass to streamText's `onStepFinish` opt. */
  readonly onStepFinish: (step: StepLike) => void;
  /**
   * Pass to streamText's `onFinish` opt. Stamps the terminal
   * `run_complete` entry — caller passes cumulative tokens +
   * status from its budget extractor.
   */
  readonly onFinish: (info: {
    readonly finalText: string | null;
    readonly status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'budget_exceeded';
    readonly cumulativeInputTokens: number;
    readonly cumulativeOutputTokens: number;
  }) => void;
  /**
   * Open a new iteration boundary. The runner calls this BEFORE each
   * `streamText` step the agent loop executes. (The AI SDK's loop is
   * implicit inside `streamText`; the bridge expects the runner to
   * snapshot iteration boundaries at the same granularity the
   * detector's lookback walker assumes.)
   */
  readonly openIteration: () => void;
  /** All entries collected so far — read after the stream finishes. */
  readonly traces: () => readonly TraceEntry[];
}

export function buildTraceSinkBridge(opts: TraceSinkBridgeOpts): TraceSinkBridgeHandle {
  const traces: TraceEntry[] = [];
  const seq = { value: 0 };
  let iterationCounter = 0;
  const sinks: readonly TraceSink[] = opts.traceSinks ?? [];

  // R3-LOW-2 — fan-out helper. Push to in-memory collection AND
  // forward to every registered sink. Sink errors are swallowed
  // (matches `executor.ts:emitToSinks` + `trace.ts:169-172`
  // invariant). Awaiting `emit()` is fire-and-forget here: the bridge
  // doesn't have a per-step async boundary to safely await on (the
  // AI SDK's `onStepFinish` is sync), so we kick the promise and
  // attach a `.catch` to swallow rejection. Sinks that need flush
  // semantics expose `flush()` separately and the integrator awaits
  // it after the run completes.
  const fanOut = (entry: TraceEntry): void => {
    traces.push(entry);
    for (const sink of sinks) {
      try {
        const r = sink.emit(entry);
        if (r && typeof r.catch === 'function') {
          r.catch(() => {
            /* sink errors must not crash the run */
          });
        }
      } catch {
        /* sink errors must not crash the run */
      }
    }
  };

  const openIteration = (): void => {
    const entry: TraceEntry = {
      schema_version: '1',
      run_id: opts.runId,
      sequence: seq.value++,
      trace_type: 'iteration_boundary',
      timestamp_ms: Date.now(),
      latency_ms: 0,
      iteration: iterationCounter++,
    };
    fanOut(entry);
  };

  const onStepFinish = (step: StepLike): void => {
    // Emit the llm_call trace. Mirror the field shape produced by
    // `executor.ts:886-914` so the detector + downstream sinks see
    // the same record shape.
    const inputText = stringifyStepInput(step);
    const llmEntry: TraceEntry = {
      schema_version: '1',
      run_id: opts.runId,
      sequence: seq.value++,
      trace_type: 'llm_call',
      timestamp_ms: Date.now(),
      latency_ms: 0,
      ...(opts.model !== undefined && { model: opts.model }),
      input_messages: truncateMessages([{ role: 'user', content: inputText }]),
      output_content: truncateForStorage(step.text ?? ''),
      input_tokens_est: step.usage?.inputTokens ?? estimateTokens(inputText),
      output_tokens_est: step.usage?.outputTokens ?? estimateTokens(step.text ?? ''),
      cost_usd: null,
      ...(step.finishReason !== undefined && { stop_reason: step.finishReason }),
    };
    fanOut(llmEntry);
    // Tool calls: emit one tool_call entry per result.
    const results = step.toolResults ?? [];
    for (const r of results) {
      const tcEntry: TraceEntry = {
        schema_version: '1',
        run_id: opts.runId,
        sequence: seq.value++,
        trace_type: 'tool_call',
        timestamp_ms: Date.now(),
        latency_ms: 0,
        ...(typeof r.toolName === 'string' && { tool_name: r.toolName }),
        tool_provider_id: 'vercel-ai-adapter',
        tool_input: truncateForStorage(safeStringify(findCallInput(step.toolCalls, r.toolName))),
        tool_output: truncateForStorage(safeStringify(r.output)),
        is_error: detectToolError(r.output),
      };
      fanOut(tcEntry);
    }
  };

  const onFinish = (info: {
    readonly finalText: string | null;
    readonly status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'budget_exceeded';
    readonly cumulativeInputTokens: number;
    readonly cumulativeOutputTokens: number;
  }): void => {
    const entry: TraceEntry = {
      schema_version: '1',
      run_id: opts.runId,
      sequence: seq.value++,
      trace_type: 'run_complete',
      timestamp_ms: Date.now(),
      latency_ms: 0,
      final_content: info.finalText,
      final_status: info.status,
      cumulative_input_tokens: info.cumulativeInputTokens,
      cumulative_output_tokens: info.cumulativeOutputTokens,
      cumulative_cost_usd: null,
      hit_iteration_cap: false,
    };
    fanOut(entry);
  };

  return {
    onStepFinish,
    onFinish,
    openIteration,
    traces: () => traces,
  };
}

/* =====================================================================
 * Internals — string-coercion helpers. Defensive: trace recording
 * MUST NOT crash the run (mirrors the `truncateForStorage` invariant
 * in `@kagent/agent-loop/trace.ts:185-201`).
 * ===================================================================== */

function stringifyStepInput(step: StepLike): string {
  // The step's `request.body` is the most authoritative input shape
  // when present (provider-specific). Fall back to an empty string —
  // input_tokens_est uses estimateTokens against this.
  if (step.request?.body !== undefined) {
    return safeStringify(step.request.body);
  }
  return '';
}

function findCallInput(calls: StepLike['toolCalls'], name: string | undefined): unknown {
  if (!calls || name === undefined) return undefined;
  for (const c of calls) {
    if (c.toolName === name) return c.input;
  }
  return undefined;
}

function detectToolError(output: unknown): boolean {
  if (output === null || typeof output !== 'object') return false;
  const o = output as { isError?: unknown };
  return o.isError === true;
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}
