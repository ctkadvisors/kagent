/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Component 1 — `KagentContextSafetyMiddleware` (R3 §4.1).
 *
 * Vercel AI SDK `LanguageModelV3` middleware that mirrors
 * `@kagent/agent-loop`'s `chatWithRetry` pre-call refusal at the
 * 95% threshold (default) — the substrate's circuit breaker, ported
 * to a Vercel-AI-SDK call boundary.
 *
 * Reads:
 *   - `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` (operator-projected per
 *     `docs/CONTEXT-AWARENESS.md` §4.1).
 *   - `KAGENT_CONTEXT_SAFETY_THRESHOLD` (default `0.95`).
 *
 * Maintains cumulative input/output token state across `doGenerate`
 * and `doStream` invocations on the same middleware instance. A new
 * middleware instance per agent-task run keeps the accounting
 * isolated — `streamText` calls into the same wrapped model multiple
 * times within one agent loop, all of which share the same cumulative
 * counter (matching `@kagent/agent-loop`'s per-run `RunBudget`).
 *
 * Refusal shape mirrors `LLMClientHttpError(0, 'context_window_substrate_refused: …')`
 * from `@kagent/agent-loop/errors.ts`. Vercel AI SDK propagates thrown
 * errors out of the wrapped model verbatim, so `streamText` /
 * `generateText` callers see the exact same structured reason the
 * kagent agent-loop produces.
 *
 * Back-compat (R3 §4.5): when `contextWindowTokens` is undefined the
 * middleware is a no-op — the underlying model is called unmodified.
 * Mirrors `RunBudget.contextWindowTokens === undefined` semantics.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';

import { estimateTokens } from '@kagent/agent-loop';

/**
 * The kagent-shaped error that the middleware throws when the
 * cumulative-tokens-vs-window check fails. Mirrors
 * `LLMClientHttpError(0, 'context_window_substrate_refused: …')` from
 * `@kagent/agent-loop/errors.ts` — `status: 0` so any retry policy
 * gated to `status === 429` (matching the agent-loop's contract)
 * cannot kick in. The `message` carries the structured reason the
 * status writer surfaces verbatim.
 */
export class KagentContextWindowRefusedError extends Error {
  readonly status = 0 as const;
  readonly cumulativeTokens: number;
  readonly contextWindowTokens: number;
  readonly safetyThreshold: number;
  constructor(cumulativeTokens: number, contextWindowTokens: number, safetyThreshold: number) {
    super(
      `context_window_substrate_refused: cumulative=${String(cumulativeTokens)} window=${String(contextWindowTokens)} threshold=${String(safetyThreshold)}`,
    );
    this.name = 'KagentContextWindowRefusedError';
    this.cumulativeTokens = cumulativeTokens;
    this.contextWindowTokens = contextWindowTokens;
    this.safetyThreshold = safetyThreshold;
  }
}

/**
 * Construction inputs. All optional with sensible defaults so the
 * middleware can be built from a bare `process.env` if desired.
 *
 * Production path (in a kagent pod): the runner's wireup parses
 * `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` + `KAGENT_CONTEXT_SAFETY_THRESHOLD`
 * once, calls `buildKagentContextSafetyMiddleware` with the resolved
 * numbers, and hands the resulting middleware to `wrapLanguageModel`.
 *
 * Test path: opts are passed directly so the middleware can be
 * exercised without env state.
 */
export interface KagentContextSafetyOpts {
  /** Model's declared context-window. Undefined = no-op (back-compat). */
  readonly contextWindowTokens?: number;
  /** Refusal threshold in `(0, 1]`. Defaults to 0.95 per §4.1. */
  readonly safetyThreshold?: number;
}

/**
 * Stateful middleware instance. The cumulative counters are private
 * fields; `currentCumulativeTokens()` exposes a read-only snapshot
 * for tests and the budget extractor.
 *
 * One instance per agent-task run. The middleware does not reset
 * itself between runs — the caller (typically `runVercelAiAgentTask`)
 * constructs a fresh instance per task.
 */
export class KagentContextSafetyMiddleware {
  readonly specificationVersion = 'v3' as const;

  private readonly contextWindowTokens: number | undefined;
  private readonly safetyThreshold: number;
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;

  constructor(opts: KagentContextSafetyOpts = {}) {
    this.contextWindowTokens = opts.contextWindowTokens;
    this.safetyThreshold = opts.safetyThreshold ?? 0.95;
    if (
      !Number.isFinite(this.safetyThreshold) ||
      this.safetyThreshold <= 0 ||
      this.safetyThreshold > 1
    ) {
      // Mirrors `executor.ts:651-660` — fail-FAST on misconfiguration
      // rather than silently degrading.
      throw new Error(
        `KagentContextSafetyMiddleware: safetyThreshold must be in (0, 1] (got ${String(this.safetyThreshold)})`,
      );
    }
  }

  /** Read-only snapshot for the budget extractor + tests. */
  currentCumulativeTokens(): { input: number; output: number; total: number } {
    return {
      input: this.cumulativeInputTokens,
      output: this.cumulativeOutputTokens,
      total: this.cumulativeInputTokens + this.cumulativeOutputTokens,
    };
  }

  /**
   * Pre-call check shared by `wrapGenerate` + `wrapStream`. Returns
   * void on success; throws `KagentContextWindowRefusedError` when
   * cumulative tokens have reached the threshold. Gated on
   * `contextWindowTokens !== undefined` so the back-compat path is a
   * no-op (matches `RunBudget.contextWindowTokens` semantics).
   */
  private assertBelowThreshold(): void {
    const window = this.contextWindowTokens;
    if (window === undefined) return;
    const used = this.cumulativeInputTokens + this.cumulativeOutputTokens;
    const limit = this.safetyThreshold * window;
    if (used >= limit) {
      throw new KagentContextWindowRefusedError(used, window, this.safetyThreshold);
    }
  }

  /** Update accounting after a successful call. */
  private recordUsage(input: number | undefined, output: number | undefined): void {
    if (typeof input === 'number' && Number.isFinite(input)) {
      this.cumulativeInputTokens += input;
    }
    if (typeof output === 'number' && Number.isFinite(output)) {
      this.cumulativeOutputTokens += output;
    }
  }

  /**
   * Vercel AI SDK middleware contract — `wrapGenerate`. Refuses
   * before forwarding when the threshold is reached.
   *
   * Usage accounting (R3-LOW-1, C2R3-LOW-2):
   *
   * - Optional-chains `result.usage.{inputTokens,outputTokens}?.total`
   *   so a non-conformant provider that omits one of those keys does
   *   NOT throw `TypeError`. The audit (audit-rev3/C2.md §3 C2R3-LOW-2)
   *   flagged the previous unconditional `.total` access as a way to
   *   crash the safety-net on usage-less responses.
   * - When the provider omits usage entirely (Cloudflare Workers AI is
   *   a known case), fall back to `estimateTokens(...)` over the
   *   request prompt + the result's text — same heuristic the
   *   reference agent-loop's executor applies at
   *   `executor.ts:957-963`. Without this fallback the cumulative
   *   counter silently stays at 0, the threshold never trips, and
   *   the safety-net no-ops.
   */
  wrapGenerate = async ({
    doGenerate,
    params,
  }: {
    doGenerate: () => PromiseLike<LanguageModelV3GenerateResult>;
    doStream: () => PromiseLike<LanguageModelV3StreamResult>;
    params: LanguageModelV3CallOptions;
    model: LanguageModelV3;
  }): Promise<LanguageModelV3GenerateResult> => {
    this.assertBelowThreshold();
    const result = await doGenerate();
    const inputTokens = result.usage.inputTokens?.total;
    const outputTokens = result.usage.outputTokens?.total;
    if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
      this.recordUsage(inputTokens, outputTokens);
    } else {
      // R3-LOW-1 fallback — provider omitted (or partially-omitted)
      // usage. Estimate from the in-band content shapes available.
      const fallbackInput =
        inputTokens ?? estimateTokens(stringifyPromptForEstimate(params.prompt));
      const fallbackOutput =
        outputTokens ?? estimateTokens(stringifyResultContentForEstimate(result.content));
      this.recordUsage(fallbackInput, fallbackOutput);
    }
    return result;
  };

  /**
   * Vercel AI SDK middleware contract — `wrapStream`. Refuses before
   * forwarding when the threshold is reached. Stream usage is
   * surfaced via the terminal `finish` chunk; we capture it via a
   * `TransformStream` so the cumulative counter stays in sync with
   * `wrapGenerate`'s post-call accounting.
   */
  wrapStream = async ({
    doStream,
    params,
  }: {
    doGenerate: () => PromiseLike<LanguageModelV3GenerateResult>;
    doStream: () => PromiseLike<LanguageModelV3StreamResult>;
    params: LanguageModelV3CallOptions;
    model: LanguageModelV3;
  }): Promise<LanguageModelV3StreamResult> => {
    this.assertBelowThreshold();
    const result = await doStream();
    // Wrap the stream to observe the terminal `finish` chunk's usage
    // without consuming the stream. `TransformStream` is the
    // documented pattern in the AI SDK middleware guide.
    //
    // Type-erasure note: the AI SDK's `LanguageModelV3StreamPart`
    // union is provider-specific; declaring the TransformStream
    // generic over it would couple us to that exact shape. We treat
    // the chunk as `unknown` inside the transformer, narrow with a
    // structural type guard for the `finish` variant, and cast the
    // resulting transformed stream back to the SDK's expected
    // `LanguageModelV3StreamResult.stream` type — the wire shape is
    // unchanged; only the local TS view widened.
    //
    // R3-LOW-1 — when the provider omits usage on the finish chunk
    // (or omits one of input/output), the safety-net would silently
    // no-op. Mirror executor.ts:957-963's fallback: estimate input
    // tokens from the request prompt and output tokens from the
    // accumulated text-delta content seen on the stream. Buffer
    // text-delta chunks so the estimate at finish-time has the full
    // assistant turn to measure.
    const recordUsage = this.recordUsage.bind(this);
    const promptText = stringifyPromptForEstimate(params.prompt);
    let outputText = '';
    const transformed = result.stream.pipeThrough(
      new TransformStream<unknown, unknown>({
        transform(chunk, controller) {
          // Structural narrow — the `finish` variant carries `.usage`.
          // Any provider that omits usage on a finish chunk produces
          // undefined, which the fallback below handles.
          const c = chunk as {
            type?: string;
            text?: string;
            delta?: string;
            usage?: {
              inputTokens?: { total?: number };
              outputTokens?: { total?: number };
            };
          };
          if (c?.type === 'text-delta') {
            // Provider-version-tolerant: AI SDK 6 surfaces the delta
            // under `delta` (current) or `text` (older). Use whichever
            // is a non-empty string. Falls through harmlessly when
            // neither is present.
            if (typeof c.delta === 'string') outputText += c.delta;
            else if (typeof c.text === 'string') outputText += c.text;
          }
          if (c?.type === 'finish') {
            const inputTokens = c.usage?.inputTokens?.total;
            const outputTokens = c.usage?.outputTokens?.total;
            if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
              recordUsage(inputTokens, outputTokens);
            } else {
              const fallbackInput = inputTokens ?? estimateTokens(promptText);
              const fallbackOutput = outputTokens ?? estimateTokens(outputText);
              recordUsage(fallbackInput, fallbackOutput);
            }
          }
          controller.enqueue(chunk);
        },
      }),
    ) as LanguageModelV3StreamResult['stream'];
    return { ...result, stream: transformed };
  };
}

/* =====================================================================
 * Helpers — R3-LOW-1 estimate fallback. Defensive: a wide variety of
 * `params.prompt` shapes flow through AI SDK middleware (string vs
 * `ModelMessage[]` vs provider-specific extensions). The estimator
 * coerces each into a stable string for `estimateTokens` (which is
 * `Math.ceil(text.length / 4)`). Any failure to coerce returns an
 * empty string — the estimate is then 0, mirroring the pre-fix
 * behavior for the unrecognized case (no regression).
 * ===================================================================== */

function stringifyPromptForEstimate(prompt: unknown): string {
  if (prompt === undefined || prompt === null) return '';
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    // AI SDK's `ModelMessage[]` shape — concatenate `content` fields.
    // Each message's `content` is either a string or an array of
    // `ContentPart`s with `text` fields. Walk both shapes.
    const parts: string[] = [];
    for (const m of prompt) {
      const msg = m as { content?: unknown };
      if (typeof msg.content === 'string') {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          const part = p as { text?: unknown; type?: unknown };
          if (typeof part.text === 'string') parts.push(part.text);
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}

function stringifyResultContentForEstimate(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      const part = p as { text?: unknown };
      if (typeof part.text === 'string') parts.push(part.text);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Helper-style alias. Returns a `LanguageModelV3Middleware` shape so
 * the caller can pass directly to `wrapLanguageModel({ middleware })`.
 * Exposed alongside the class export so integrators can pick whichever
 * shape is more natural — the class for direct usage when the cumulative
 * snapshot is needed (e.g. by the budget extractor), the helper for
 * one-shot wrapping where the snapshot is not.
 */
export function buildKagentContextSafetyMiddleware(opts: KagentContextSafetyOpts = {}): {
  readonly middleware: LanguageModelV3Middleware;
  readonly instance: KagentContextSafetyMiddleware;
} {
  const instance = new KagentContextSafetyMiddleware(opts);
  // The class IS structurally a LanguageModelV3Middleware; cast is
  // safe because `specificationVersion` + `wrapGenerate` + `wrapStream`
  // are the required surface.
  return { middleware: instance, instance };
}
