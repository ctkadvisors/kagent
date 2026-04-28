/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure formatter that converts internal `TraceEntry` instances into
 * explicit Langfuse + OTel-GenAI semconv attributes.
 *
 * Design: kept separate from `OtelTraceSink` so the formatting rules
 * are table-tested in isolation, and so a future non-OTel Langfuse
 * sink (Langfuse SDK fallback) can reuse the same shape.
 *
 * Why this exists: pre-WS-D-followup the sink emitted only `kagent.*`-
 * keyed attributes, which Langfuse rendered as opaque generic spans —
 * not first-class generations / tool executions. WS-D landed
 * deterministic trace IDs (navigation); this lands the *payload shape*
 * (evidence). See:
 *
 *  - Langfuse OTel ingestion (precedence: explicit `langfuse.*` keys
 *    win over generic OTel mapping):
 *    https://langfuse.com/integrations/native/opentelemetry
 *  - OTel GenAI semconv (`gen_ai.operation.name`, `gen_ai.usage.*`,
 *    `gen_ai.tool.*`, `execute_tool <name>` span name convention):
 *    https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 *
 * `kagent.*` attributes still ship as secondary debug metadata so
 * existing log-grep workflows + the WS-D determinism tests don't
 * break.
 */

import type { TraceEntry } from '@kagent/agent-loop';

/**
 * Content-capture policy for input/output bodies attached to spans.
 *
 *  - `none`        — omit input/output entirely (only metadata + token usage on the span)
 *  - `preview`     — truncate per-string to {@link DEFAULT_PREVIEW_CHARS}; outer JSON shape preserved
 *  - `full`        — emit complete content
 *  - `artifact-ref` — write full body to the kagent-artifacts PVC; emit an `inline://` ref.
 *                     RESERVED — depends on the Phase 5 P3 artifact writer; not yet implemented.
 *                     `parseContentMode` rejects this value with a clear error today so callers
 *                     don't silently get truncated content when they asked for full-fidelity refs.
 */
export type ContentMode = 'none' | 'preview' | 'full' | 'artifact-ref';

/** Default per-string truncation budget when `mode === 'preview'`. */
export const DEFAULT_PREVIEW_CHARS = 512;

/** Default mode when `KAGENT_TRACE_CONTENT_MODE` is unset. */
export const DEFAULT_CONTENT_MODE: ContentMode = 'preview';

/**
 * Parse a string env value into a {@link ContentMode}. Returns
 * {@link DEFAULT_CONTENT_MODE} for unset / empty input. Throws on
 * unknown values rather than silently downgrading, so a typo in an
 * operator's Helm values surfaces at boot.
 *
 * `artifact-ref` parses successfully but throws an explicit
 * NotImplemented error — it's accepted as a future contract value, not
 * silently treated as `preview`, because callers asking for ref-mode
 * specifically WANT the full body recoverable.
 */
export function parseContentMode(raw: string | undefined): ContentMode {
  if (raw === undefined || raw === '') return DEFAULT_CONTENT_MODE;
  switch (raw) {
    case 'none':
    case 'preview':
    case 'full':
      return raw;
    case 'artifact-ref':
      throw new Error(
        "KAGENT_TRACE_CONTENT_MODE='artifact-ref' is reserved — depends on the Phase 5 P3 artifact writer (write_artifact tool + kagent-artifacts PVC), not yet wired. Use 'preview' or 'full' until then.",
      );
    default:
      throw new Error(
        `KAGENT_TRACE_CONTENT_MODE='${raw}' is not a valid ContentMode; expected one of: none, preview, full`,
      );
  }
}

/**
 * Optional per-run metadata stamped onto the root `agent.run` span as
 * Langfuse trace-level fields. Sourced from the agent-pod's
 * operator-injected env (`KAGENT_AGENT_NAME`, `KAGENT_TASK_NAMESPACE`,
 * `Agent.spec.sandboxProfile`, …) — the executor itself doesn't know
 * these, so the sink takes them via constructor option and applies
 * them when the root span is created.
 */
export interface RunContext {
  /** Stable agent identity — `Agent.metadata.name` from the CRD. */
  readonly agentName?: string;
  /** Stable per-task identity — `AgentTask.metadata.uid`. */
  readonly taskUid?: string;
  /** Display-friendly task name — `AgentTask.metadata.name`. */
  readonly taskName?: string;
  /** Cluster namespace where the task runs. */
  readonly namespace?: string;
  /** `Agent.spec.sandboxProfile` — `'default' | 'strict'`. */
  readonly sandboxProfile?: string;
  /** Free-form additional tags. Merged with the auto-generated tag list. */
  readonly extraTags?: readonly string[];
}

/**
 * Build the trace-level Langfuse fields applied to the root
 * `agent.run` span. These keys take precedence over generic OTel
 * mapping per Langfuse's ingestion docs.
 */
export function formatRootSpanAttrs(
  runId: string,
  runContext: RunContext | undefined,
): Record<string, string | number | boolean | string[]> {
  const ctx = runContext ?? {};
  const tags = [
    'kagent',
    ...(ctx.sandboxProfile !== undefined ? [`sandbox:${ctx.sandboxProfile}`] : []),
    ...(ctx.namespace !== undefined ? [`ns:${ctx.namespace}`] : []),
    ...(ctx.extraTags ?? []),
  ];
  const traceName =
    ctx.agentName !== undefined && ctx.taskName !== undefined
      ? `${ctx.agentName}:${ctx.taskName}`
      : (ctx.agentName ?? `kagent.run:${runId}`);

  const attrs: Record<string, string | number | boolean | string[]> = {
    'langfuse.trace.name': traceName,
    'langfuse.trace.tags': tags,
    // Secondary debug metadata — kept for WS-D determinism tests + log-grep flows.
    'kagent.run_id': runId,
  };
  if (ctx.agentName !== undefined) {
    attrs['langfuse.trace.metadata.kagent_agent'] = ctx.agentName;
    attrs['kagent.agent_name'] = ctx.agentName;
  }
  if (ctx.taskUid !== undefined) {
    attrs['langfuse.trace.metadata.kagent_task_uid'] = ctx.taskUid;
    attrs['kagent.task_uid'] = ctx.taskUid;
  }
  if (ctx.taskName !== undefined) {
    attrs['langfuse.trace.metadata.kagent_task_name'] = ctx.taskName;
  }
  if (ctx.namespace !== undefined) {
    attrs['langfuse.trace.metadata.kagent_namespace'] = ctx.namespace;
  }
  if (ctx.sandboxProfile !== undefined) {
    attrs['langfuse.trace.metadata.kagent_sandbox_profile'] = ctx.sandboxProfile;
  }
  attrs['langfuse.trace.metadata.kagent_run_id'] = runId;
  return attrs;
}

/**
 * Format an LLM-call entry as a Langfuse generation + OTel GenAI chat
 * span. Returns the attribute bag; the caller's responsibility is to
 * start a span named `agent.llm.call` with these attributes.
 */
export function formatLlmCallAttrs(
  entry: TraceEntry,
  contentMode: ContentMode,
): Record<string, string | number | boolean> {
  const inputTokens = entry.input_tokens_est ?? 0;
  const outputTokens = entry.output_tokens_est ?? 0;
  const totalTokens = inputTokens + outputTokens;

  const attrs: Record<string, string | number | boolean> = {
    // Langfuse explicit keys (highest precedence in their OTel ingestion).
    // Per Langfuse OTel ingestion docs, `usage_details` and `cost_details`
    // are JSON-string-shaped attributes — Langfuse parses them and renders
    // each sub-key as a row in the Generation viewer. Emitting them as
    // dotted-suffix scalars (`usage_details.input`) historically rendered
    // as opaque OTel attribute keys, not first-class generation usage.
    'langfuse.observation.type': 'generation',
    'langfuse.observation.name': 'agent.llm.call',
    'langfuse.observation.usage_details': JSON.stringify({
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
    }),
    // Portable OTel GenAI semconv.
    'gen_ai.operation.name': 'chat',
    'gen_ai.usage.input_tokens': inputTokens,
    'gen_ai.usage.output_tokens': outputTokens,
    // Secondary kagent.* metadata (preserved for log-grep + WS-D tests).
    'kagent.run_id': entry.run_id,
    'kagent.sequence': entry.sequence,
    'kagent.latency_ms': entry.latency_ms,
    'kagent.input_tokens': inputTokens,
    'kagent.output_tokens': outputTokens,
  };

  if (entry.model !== undefined) {
    attrs['langfuse.observation.model.name'] = entry.model;
    attrs['gen_ai.request.model'] = entry.model;
    attrs['gen_ai.response.model'] = entry.model;
    attrs['kagent.model'] = entry.model;
  }
  if (entry.cost_usd !== undefined && entry.cost_usd !== null) {
    attrs['langfuse.observation.cost_details'] = JSON.stringify({ total: entry.cost_usd });
    attrs['kagent.cost_usd'] = entry.cost_usd;
  }
  if (entry.stop_reason !== undefined) {
    attrs['kagent.stop_reason'] = entry.stop_reason;
  }

  // Content body (input messages + output content/tool_calls). Both halves
  // are serialized through `toLangfuseJsonString`, which guarantees the
  // attribute is ALWAYS a valid JSON string (parses-as-JSON when the
  // source data is JSON-shaped; wraps as `{"preview":"<text>"}` otherwise)
  // — Langfuse's Generation viewer only renders input/output as a
  // structured tree when the value parses, so emitting raw text would
  // collapse to an opaque blob.
  const inputBody = toLangfuseJsonString(entry.input_messages, contentMode);
  if (inputBody !== undefined) {
    attrs['langfuse.observation.input'] = inputBody;
  }
  const outputBody = formatLlmOutput(entry, contentMode);
  if (outputBody !== undefined) {
    attrs['langfuse.observation.output'] = outputBody;
  }

  return attrs;
}

/**
 * Format a tool-call entry as an OTel GenAI tool execution. Returns
 * `{ spanName, attributes }` — caller starts a span with the returned
 * name (`execute_tool ${toolName}` per the GenAI semconv) and attaches
 * the attribute bag.
 */
export function formatToolCallAttrs(
  entry: TraceEntry,
  contentMode: ContentMode,
): { spanName: string; attributes: Record<string, string | number | boolean> } {
  const toolName = entry.tool_name ?? 'unknown';
  const spanName = `execute_tool ${toolName}`;
  const attrs: Record<string, string | number | boolean> = {
    'langfuse.observation.type': 'span',
    'langfuse.observation.name': spanName,
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': toolName,
    // Secondary kagent.* metadata.
    'kagent.run_id': entry.run_id,
    'kagent.sequence': entry.sequence,
    'kagent.latency_ms': entry.latency_ms,
    'kagent.tool_name': toolName,
  };
  if (entry.tool_provider_id !== undefined) {
    attrs['kagent.tool_provider_id'] = entry.tool_provider_id;
  }
  if (entry.is_error !== undefined) {
    attrs['kagent.is_error'] = entry.is_error;
    if (entry.is_error === true) {
      attrs['langfuse.observation.level'] = 'ERROR';
    }
  }

  // langfuse.observation.input/output MUST be valid JSON strings for the
  // Langfuse viewer to render them as structured trees. gen_ai.tool.call.*
  // ride the raw (content-mode-applied) payload — OTel GenAI semconv
  // doesn't require a JSON string and existing collectors expect the
  // tool's literal arg/result text.
  const langfuseInput = toLangfuseJsonString(entry.tool_input, contentMode);
  if (langfuseInput !== undefined) {
    attrs['langfuse.observation.input'] = langfuseInput;
  }
  const langfuseOutput = toLangfuseJsonString(entry.tool_output, contentMode);
  if (langfuseOutput !== undefined) {
    attrs['langfuse.observation.output'] = langfuseOutput;
  }
  const rawInput = applyContentMode(entry.tool_input, contentMode);
  if (rawInput !== undefined) {
    attrs['gen_ai.tool.call.arguments'] = rawInput;
  }
  const rawOutput = applyContentMode(entry.tool_output, contentMode);
  if (rawOutput !== undefined) {
    attrs['gen_ai.tool.call.result'] = rawOutput;
  }

  return { spanName, attributes: attrs };
}

/**
 * Format the run-completion entry as the final attribute bag stamped
 * onto the root `agent.run` span just before it ends. Carries totals,
 * final status, and final output content (subject to {@link ContentMode}).
 */
export function formatRunCompleteAttrs(
  entry: TraceEntry,
  contentMode: ContentMode,
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    'kagent.run_id': entry.run_id,
  };
  if (entry.final_status !== undefined) {
    attrs['langfuse.observation.status_message'] = entry.final_status;
    attrs['kagent.final_status'] = entry.final_status;
  }
  if (entry.cumulative_input_tokens !== undefined) {
    attrs['langfuse.trace.metadata.cumulative_input_tokens'] = entry.cumulative_input_tokens;
    attrs['kagent.cumulative_input_tokens'] = entry.cumulative_input_tokens;
  }
  if (entry.cumulative_output_tokens !== undefined) {
    attrs['langfuse.trace.metadata.cumulative_output_tokens'] = entry.cumulative_output_tokens;
    attrs['kagent.cumulative_output_tokens'] = entry.cumulative_output_tokens;
  }
  if (entry.cumulative_cost_usd !== undefined && entry.cumulative_cost_usd !== null) {
    attrs['langfuse.trace.metadata.cumulative_cost_usd'] = entry.cumulative_cost_usd;
    attrs['kagent.cumulative_cost_usd'] = entry.cumulative_cost_usd;
  }
  if (entry.hit_iteration_cap !== undefined) {
    attrs['kagent.hit_iteration_cap'] = entry.hit_iteration_cap;
  }

  const finalContent = applyContentMode(entry.final_content, contentMode);
  if (finalContent !== undefined) {
    attrs['langfuse.trace.output'] = finalContent;
  }

  return attrs;
}

/**
 * Apply a {@link ContentMode} to an optional content body. Returns
 * `undefined` when the value is missing OR mode is `'none'` (caller
 * should NOT attach the attribute in that case).
 *
 * For `'preview'`, attempts JSON-aware truncation so the outer JSON
 * array/object shape survives — Langfuse parses input/output as JSON
 * when it can, and a string-truncated JSON would render as a single
 * blob in the UI. Falls back to whole-string truncation for non-JSON
 * payloads.
 */
export function applyContentMode(
  value: string | null | undefined,
  mode: ContentMode,
  perStringLimit = DEFAULT_PREVIEW_CHARS,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (mode === 'none') return undefined;
  if (mode === 'full') return value;
  if (mode === 'artifact-ref') {
    // Reserved — parseContentMode throws before we get here, but
    // guard anyway in case a caller bypasses parseContentMode.
    throw new Error(
      "applyContentMode: 'artifact-ref' mode is not implemented; depends on Phase 5 P3 artifact writer",
    );
  }
  // mode === 'preview'
  return truncatePreservingJson(value, perStringLimit);
}

/**
 * Truncate a string while preserving its outer JSON shape if it parses
 * as JSON. Walks parsed object/array trees, truncating any string
 * values longer than `perStringLimit` to `<head>…(truncated N chars)`.
 * Re-stringifies and returns. Non-JSON inputs fall back to a single
 * head-truncation, also formatted with the `…(truncated …)` suffix.
 *
 * The point: Langfuse's Generation viewer renders input/output as JSON
 * when the body parses; arbitrary mid-character truncation would
 * collapse it back to an opaque string. WS-D-followup spec §2e calls
 * out this exact requirement.
 */
export function truncatePreservingJson(value: string, perStringLimit: number): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      const truncated = walkAndTruncate(parsed, perStringLimit);
      return JSON.stringify(truncated);
    }
  } catch {
    // Not JSON — fall through to plain string truncation.
  }
  if (value.length <= perStringLimit) return value;
  return `${value.slice(0, perStringLimit)}…(truncated ${value.length - perStringLimit} chars)`;
}

function walkAndTruncate(node: unknown, perStringLimit: number): unknown {
  if (typeof node === 'string') {
    if (node.length <= perStringLimit) return node;
    return `${node.slice(0, perStringLimit)}…(truncated ${node.length - perStringLimit} chars)`;
  }
  if (Array.isArray(node)) {
    return node.map((n) => walkAndTruncate(n, perStringLimit));
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walkAndTruncate(v, perStringLimit);
    }
    return out;
  }
  return node;
}

/**
 * Combine an LLM-call entry's `output_content` + `output_tool_calls`
 * into a single JSON-string Langfuse output payload. Either or both
 * may be absent; returns undefined when both are.
 *
 * The result is ALWAYS a valid JSON string — `output_content` is
 * placed under a `content` key, `output_tool_calls` is parsed
 * structurally when it parses (otherwise wrapped as
 * `{preview: "..."}` to preserve the JSON-string guarantee for
 * downstream Langfuse rendering, never raw-concatenated into the
 * outer JSON).
 */
function formatLlmOutput(entry: TraceEntry, contentMode: ContentMode): string | undefined {
  if (contentMode === 'none') return undefined;
  const content = entry.output_content;
  const toolCallsRaw = entry.output_tool_calls;
  if (
    (content === undefined || content === null || content === '') &&
    (toolCallsRaw === undefined || toolCallsRaw === null || toolCallsRaw === '')
  ) {
    return undefined;
  }
  let parsedToolCalls: unknown;
  if (toolCallsRaw !== undefined && toolCallsRaw !== null && toolCallsRaw !== '') {
    try {
      parsedToolCalls = JSON.parse(toolCallsRaw);
    } catch {
      // Non-JSON tool_calls fragment — wrap as a `{preview}` object so
      // the outer JSON shape stays parseable. This is per spec point 6:
      // "Do not concatenate raw fragments into JSON."
      parsedToolCalls = { preview: toolCallsRaw };
    }
  }
  const composed: Record<string, unknown> = {};
  if (content !== undefined && content !== null && content !== '') {
    composed.content = content;
  }
  if (parsedToolCalls !== undefined) {
    composed.tool_calls = parsedToolCalls;
  }
  const stringified = JSON.stringify(composed);
  return contentMode === 'full'
    ? stringified
    : truncatePreservingJson(stringified, DEFAULT_PREVIEW_CHARS);
}

/**
 * Serialize an arbitrary input/output payload as a Langfuse-friendly
 * JSON string. The Langfuse Generation/Span viewer only renders
 * input/output as a structured tree when the value parses as JSON;
 * arbitrary text collapses to an opaque blob. To make every emitted
 * `langfuse.observation.input` and `langfuse.observation.output`
 * uniformly viewer-friendly:
 *
 *   - JSON-shaped sources are parsed and re-stringified (with
 *     {@link walkAndTruncate} for `'preview'`) so the outer shape
 *     survives truncation.
 *   - Non-JSON sources are wrapped as `{"preview": "<text>"}` so the
 *     attribute is always a parseable JSON string. The `preview`-key
 *     wrapping is a deliberate marker for the Langfuse UI: it tells
 *     the reader the body wasn't structured.
 *
 * Returns `undefined` when the value is missing OR mode is `'none'`
 * (caller should NOT attach the attribute in that case).
 */
export function toLangfuseJsonString(
  value: string | null | undefined,
  mode: ContentMode,
  perStringLimit = DEFAULT_PREVIEW_CHARS,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (mode === 'none') return undefined;
  if (mode === 'artifact-ref') {
    throw new Error(
      "toLangfuseJsonString: 'artifact-ref' mode is not implemented; depends on Phase 5 P3 artifact writer",
    );
  }
  // Try JSON first — re-stringify so output is canonical (no whitespace
  // / dangling input artifacts) and so preview mode can walk + truncate.
  try {
    const parsed = JSON.parse(value) as unknown;
    if (mode === 'full') return JSON.stringify(parsed);
    return JSON.stringify(walkAndTruncate(parsed, perStringLimit));
  } catch {
    // Non-JSON: wrap as { "preview": "<text>" } so the attribute remains
    // a valid JSON string. Apply preview truncation to the inner text so
    // the wrapper stays bounded.
    const text =
      mode === 'full'
        ? value
        : value.length <= perStringLimit
          ? value
          : `${value.slice(0, perStringLimit)}…(truncated ${value.length - perStringLimit} chars)`;
    return JSON.stringify({ preview: text });
  }
}
