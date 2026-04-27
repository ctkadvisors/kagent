/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@ctkadvisors/local-trace-sinks` — Two `TraceSink` impls for `@kagent/agent-loop`:
 *
 *   - `StdoutSink` (OBS-01) — color-coded human-readable per-step pretty-printer.
 *     Auto-disables ANSI when stdout is not a TTY (CI logs, piped output).
 *
 *   - `JsonlFileSink` (OBS-02) — one line per `TraceEntry` to
 *     `runs/<run-id>.jsonl`. Append-mode write stream; explicit
 *     `flush()` + `close()`.
 *
 * Both sinks are zero-runtime-dep (Node 22 built-ins only — `node:fs`,
 * `process.stdout`, hand-rolled ANSI SGR codes).
 *
 * This package exports NO error subclass family (CONTEXT D-25). Sinks
 * swallow runtime errors per the `TraceSink` contract
 * (`packages/runtime/src/trace.ts:100-102`). Construction-time errors
 * (e.g., invalid `runId` containing path-traversal chars) throw
 * `InvalidConfigError` — import directly from `@kagent/agent-loop` for
 * `instanceof` checks. Same sibling-package discipline as Phase 5
 * in-process / http / mcp provider packages.
 */

export { StdoutSink } from './stdout-sink.js';
export { JsonlFileSink } from './jsonl-file-sink.js';
export type { StdoutSinkOptions } from './stdout-sink.js';
export type { JsonlFileSinkOptions } from './jsonl-file-sink.js';
