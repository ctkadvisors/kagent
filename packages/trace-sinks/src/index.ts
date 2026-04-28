/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/trace-sinks` — TraceSink implementations for `@kagent/agent-loop`:
 *
 *   - `StdoutSink` — color-coded human-readable per-step pretty-printer.
 *     Auto-disables ANSI when stdout is not a TTY (CI logs, piped output).
 *
 *   - `JsonlFileSink` — one line per `TraceEntry` to
 *     `runs/<run-id>.jsonl`. Append-mode write stream; explicit
 *     `flush()` + `close()`.
 *
 *   - `OtelTraceSink` — emits OTel spans via OTLP/HTTP. Langfuse 4.x
 *     ingests OTLP natively at `<base>/api/public/otel/v1/traces`,
 *     so pointing this sink at Langfuse needs only a base-URL config.
 *
 * The first two sinks are zero-runtime-dep; OtelTraceSink requires the
 * `@opentelemetry/*` packages declared as dependencies of this package.
 *
 * Sinks swallow runtime errors per the `TraceSink` contract.
 * Construction-time errors (e.g., invalid `runId` containing
 * path-traversal chars) throw `InvalidConfigError` — import directly
 * from `@kagent/agent-loop` for `instanceof` checks.
 */

export { StdoutSink } from './stdout-sink.js';
export { JsonlFileSink } from './jsonl-file-sink.js';
export type { StdoutSinkOptions } from './stdout-sink.js';
export type { JsonlFileSinkOptions } from './jsonl-file-sink.js';

export {
  OtelTraceSink,
  isOtelEnabled,
  langfuseTraceUrl,
  setupOtelExporter,
  traceIdFromRunId,
} from './otel-sink.js';
export type { OtelTraceSinkOptions } from './otel-sink.js';

export {
  DEFAULT_CONTENT_MODE,
  DEFAULT_PREVIEW_CHARS,
  applyContentMode,
  formatLlmCallAttrs,
  formatRootSpanAttrs,
  formatRunCompleteAttrs,
  formatToolCallAttrs,
  parseContentMode,
  toLangfuseJsonString,
  truncatePreservingJson,
} from './langfuse-otel-format.js';
export type { ContentMode, RunContext } from './langfuse-otel-format.js';
