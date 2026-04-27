/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Trace contract — `TraceEntry` schema (D-18), `TraceSink` interface (D-19/D-31),
 * and three pure-fn ports from the source repo's tracing module.
 *
 * `TraceEntry.schema_version` lives on EACH entry (not just an envelope) so
 * the Phase 6 JSONL sink supports mixed-version rotation and the M3 Langfuse
 * ingester handles migrations cleanly.
 *
 * `TraceSink` is the M3 integration slot for Langfuse / OpenTelemetry / AgentOps —
 * Phase 6 ships the local sinks (`StdoutSink`, `JsonlFileSink` per OBS-01/02);
 * M3 adds networked sinks against the same surface.
 *
 * The pure helpers (`estimateTokens`, `truncateForStorage`, `truncateMessages`)
 * port verbatim from the source repo's tracing module. The `TraceCollector`
 * factory pattern is reference-only — the executor inlines collector state into
 * `AgentExecutor.run()` per the loop pseudocode (D-14). Source DB-write helpers
 * (`persistSingleTrace`, `persistTraces`) DO NOT port — D-28 replaces with
 * `TraceSink.emit()` fan-out.
 */

import type { ChatMessage } from './llm-client.js';

/**
 * Trace entry — D-18.
 *
 * Snake_case field names match the on-wire JSONL format Phase 6 writes; the
 * literal `schema_version: '1'` lets sinks rotate when the schema bumps.
 * Per-trace-type fields are optional in the union shape — the executor only
 * populates the fields relevant to `trace_type`.
 */
export interface TraceEntry {
  /** Schema version literal. Bump when fields change semantically; never reuse. */
  schema_version: '1';
  /** Per-run correlation id. Matches `ExecutionResult.runId`. */
  run_id: string;
  /** Monotonic sequence within the run; assigned by the executor. */
  sequence: number;
  /** Discriminator. */
  trace_type: 'llm_call' | 'tool_call' | 'iteration_boundary';
  /** Unix milliseconds when the trace was emitted. */
  timestamp_ms: number;
  /** Operation duration in ms; 0 for `iteration_boundary` (instantaneous). */
  latency_ms: number;
  /** M2 delegation forward-compat slot (D-29). Always undefined in M1. */
  parent_run_id?: string;

  // ─── llm_call fields ───────────────────────────────────────────────
  /** Model id used for the call. */
  model?: string;
  /** Truncated stringification of the request messages (`truncateMessages`). */
  input_messages?: string;
  /** Truncated final content from the model. */
  output_content?: string;
  /** JSON-stringified tool_calls (if any). */
  output_tool_calls?: string;
  /** Estimated input tokens. May be backend-reported or `estimateTokens` fallback. */
  input_tokens_est?: number;
  /** Estimated output tokens. */
  output_tokens_est?: number;
  /** Backend-reported cost in USD. `null` when no backend reported (D-16). */
  cost_usd?: number | null;
  /** Mapped stop reason (see `ChatResult.stopReason`). */
  stop_reason?: string;
  /** JSON-stringified array of tool names available for this call. */
  tools_available?: string;

  // ─── tool_call fields ──────────────────────────────────────────────
  /** Tool name dispatched. */
  tool_name?: string;
  /** Provider id that owned the tool (D-11 federation attribution). */
  tool_provider_id?: string;
  /** Truncated JSON-stringification of `ToolCall.args`. */
  tool_input?: string;
  /** Truncated JSON-stringification of `ToolResult.content`. */
  tool_output?: string;
  /** Mirrors `ToolResult.isError`. */
  is_error?: boolean;

  // ─── iteration_boundary fields ─────────────────────────────────────
  /** 0-indexed iteration number. */
  iteration?: number;

  /** Surface for caught exceptions; populated when an LLM or tool call threw. */
  error?: string;
}

/**
 * Pluggable sink for trace events — D-19 / D-31.
 *
 * Executor fans out every emitted `TraceEntry` to every registered sink.
 * `emit()` is required; `flush()` + `close()` are OPTIONAL — sinks that
 * buffer (e.g., a future Langfuse batched sink) implement them, sinks
 * that write per-event (e.g., a stdout pretty-printer) skip both.
 *
 * Sinks SHOULD NOT throw from `emit()` — the executor swallows sink errors
 * to keep the run loop alive. A sink that needs to surface errors writes
 * to its own channel (stderr, in-memory error queue, etc.).
 */
export interface TraceSink {
  emit(entry: TraceEntry): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Rough token estimate — D-20 fallback.
 *
 * `~chars/4` ceiling. Used by the executor when `LLMClient.chat()` returns
 * `ChatResult.usage = undefined` (D-16). Backend-reported counts always
 * win over this estimate.
 *
 * Verbatim port from the source repo's tracing module.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate long strings for trace storage — D-20.
 *
 * Keeps the first 500 characters + a marker noting omitted-char count +
 * the last 200 characters. Default `maxChars = 700` matches the source
 * repo's pattern; consumers can override per-call.
 *
 * Verbatim port from the source repo's tracing module.
 */
export function truncateForStorage(text: string, maxChars = 700): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, 500);
  const tail = text.slice(-200);
  return `${head}\n...[truncated ${text.length - 700} chars]...\n${tail}`;
}

/**
 * Truncate a chat-message array for trace storage — D-20.
 *
 * Maps each message to `{role, content}` (drops `tool_calls`, `tool_call_id`,
 * `name` — those land in dedicated trace fields), truncates each `content`
 * via `truncateForStorage`, then `JSON.stringify`s the array.
 *
 * Verbatim port from the source repo's tracing module, with the parameter
 * type narrowed from loose `Array<{role, content}>` to `readonly ChatMessage[]`.
 */
export function truncateMessages(messages: readonly ChatMessage[]): string {
  const truncated = messages.map((m) => ({
    role: m.role,
    content: truncateForStorage(m.content || ''),
  }));
  return JSON.stringify(truncated);
}
