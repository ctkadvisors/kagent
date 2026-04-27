/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `StdoutSink` — color-coded human-readable trace pretty-printer (OBS-01).
 *
 * Implements `TraceSink` from `@kagent/agent-loop` (`packages/runtime/src/trace.ts:104-108`).
 * Writes one line per `TraceEntry` to a configurable `NodeJS.WritableStream`
 * (defaults to `process.stdout`). Auto-disables ANSI colors when the stream
 * is not a TTY OR when `NO_COLOR` is set (https://no-color.org/), forced
 * on via `FORCE_COLOR`, or overridden via the `color` option.
 *
 * Hand-rolled ANSI SGR codes (CONTEXT D-05) — six escape sequences, no
 * runtime deps. Format-helper signatures kept pure for testability.
 *
 * Sink-error discipline: attaches a single 'error' handler on the stream
 * at construct time that swallows EPIPE (RESEARCH §Pitfall 3) and best-
 * effort logs other errors. Per Phase 3 trace.ts:100-102, sinks SHOULD NOT
 * throw from emit().
 *
 * Omits `flush()` and `close()` per CONTEXT D-10 — `process.stdout` writes
 * are line-buffered by Node 22; no explicit drain needed.
 */

import type { TraceEntry, TraceSink } from '@kagent/agent-loop';
import { truncateForStorage } from '@kagent/agent-loop';

/**
 * Hand-rolled ANSI SGR palette (CONTEXT D-05) — 6 escape sequences only.
 * Per CONTEXT D-05 zero-dep lock, this sink MUST NOT depend on chalk,
 * picocolors, ansi-styles, kleur, or any other color library.
 */
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

/** Wrap text in the given SGR code when colors are enabled; pass-through otherwise. */
function colorize(text: string, code: string, useColor: boolean): string {
  return useColor ? `${code}${text}${ANSI.reset}` : text;
}

/**
 * Resolve the effective `useColor` boolean per CONTEXT D-07 precedence:
 * `FORCE_COLOR` (any non-empty value) > `NO_COLOR` (any value — even '') > `stream.isTTY`.
 *
 * Called ONCE at construct time per RESEARCH §Anti-pattern — env vars are
 * process-lifetime-stable and a per-emit branch is wasted work.
 */
function resolveColor(
  setting: 'auto' | 'always' | 'never',
  stream: NodeJS.WritableStream,
): boolean {
  if (setting === 'always') return true;
  if (setting === 'never') return false;
  // setting === 'auto'
  if (process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '') return true;
  if (process.env.NO_COLOR != null) return false; // ANY value disables per https://no-color.org/
  return (stream as NodeJS.WriteStream).isTTY === true;
}

/**
 * Options for `StdoutSink` constructor (CONTEXT D-06). All fields optional.
 */
export interface StdoutSinkOptions {
  /** Color mode. 'auto' detects TTY + honors FORCE_COLOR/NO_COLOR. Default: 'auto'. */
  color?: 'auto' | 'always' | 'never';
  /** Multi-line verbose dump per entry (default false = single-line compact). */
  verbose?: boolean;
  /** Write target. Default: process.stdout. Inject for tests + future Workers. */
  stream?: NodeJS.WritableStream;
}

/**
 * Compact-format one-liner per CONTEXT D-08:
 *
 * ```
 * [run-abc12345 #001] LLM   1240ms  gpt-4   in:340 out:120 tokens  $0.0024  → end_turn
 * [run-abc12345 #002] TOOL    45ms  http_ping (http)  ok                    → "{\"pong\":true}"
 * [run-abc12345 #003] ITER 0→1
 * ```
 *
 * - run_id is sliced to first 8 chars for scannability
 * - sequence is zero-padded to 3 chars
 * - trace_type is a fixed-width 4-char tag (`LLM `, `TOOL`, `ITER`)
 * - latency is right-padded to 6 chars + "ms"
 * - cost renders only when `cost_usd != null` (NOT just truthy — `0` is a valid cost)
 * - red `✗` replaces `ok` status when `is_error === true` OR `error != null`
 */
function formatCompact(entry: TraceEntry, useColor: boolean): string {
  const runIdShort = entry.run_id.slice(0, 8);
  const seq = String(entry.sequence).padStart(3, '0');
  const prefix = `[run-${runIdShort} #${seq}]`;

  if (entry.trace_type === 'iteration_boundary') {
    const iter = entry.iteration ?? 0;
    const label = colorize('ITER', ANSI.magenta, useColor);
    return `${prefix} ${label} ${iter}→${iter + 1}`;
  }

  const latency = `${String(entry.latency_ms).padStart(6)}ms`;
  const isError = entry.is_error === true || entry.error != null;
  const status = isError ? colorize('✗', ANSI.red, useColor) : 'ok';

  if (entry.trace_type === 'llm_call') {
    const label = colorize('LLM ', ANSI.cyan, useColor);
    const model = entry.model ?? '<unknown>';
    const inTokens = entry.input_tokens_est ?? 0;
    const outTokens = entry.output_tokens_est ?? 0;
    const cost = entry.cost_usd != null ? `  $${entry.cost_usd.toFixed(4)}` : '';
    const stop = entry.stop_reason ? `  → ${entry.stop_reason}` : '';
    const errMark = isError ? `  ${status}` : '';
    return `${prefix} ${label} ${latency}  ${model}   in:${inTokens} out:${outTokens} tokens${cost}${stop}${errMark}`;
  }

  // tool_call
  const label = colorize('TOOL', ANSI.yellow, useColor);
  const toolName = entry.tool_name ?? '<unknown>';
  const providerId = entry.tool_provider_id ? ` (${entry.tool_provider_id})` : '';
  const output = entry.tool_output ? `  → ${truncateForStorage(entry.tool_output, 60)}` : '';
  return `${prefix} ${label} ${latency}  ${toolName}${providerId}  ${status}${output}`;
}

/**
 * Verbose-format multi-line dump per CONTEXT D-09:
 *
 * - First line = compact-format header (identical to `formatCompact`)
 * - Following lines indented 4 spaces, containing field dumps
 * - `input_messages` + `output_content` previewed at ~200 chars with `...` suffix
 * - `tools_available` + `output_tool_calls` + `tool_input` + `tool_output` + `error` rendered verbatim
 * - `iteration_boundary` dumps only the header (no additional fields to display)
 */
function formatVerbose(entry: TraceEntry, useColor: boolean): string {
  const header = formatCompact(entry, useColor);
  if (entry.trace_type === 'iteration_boundary') return header;

  const lines = [header];
  const indent = '    ';

  if (entry.trace_type === 'llm_call') {
    if (entry.input_messages) {
      const preview =
        entry.input_messages.length > 200
          ? entry.input_messages.slice(0, 200) + '...'
          : entry.input_messages;
      lines.push(`${indent}input_messages: ${preview}`);
    }
    if (entry.tools_available) {
      lines.push(`${indent}tools_available: ${entry.tools_available}`);
    }
    if (entry.output_tool_calls) {
      lines.push(`${indent}output_tool_calls: ${entry.output_tool_calls}`);
    }
    if (entry.output_content) {
      const preview =
        entry.output_content.length > 200
          ? entry.output_content.slice(0, 200) + '...'
          : entry.output_content;
      lines.push(`${indent}output_content: ${preview}`);
    }
  } else {
    // tool_call
    if (entry.tool_input) lines.push(`${indent}tool_input: ${entry.tool_input}`);
    if (entry.tool_output) lines.push(`${indent}tool_output: ${entry.tool_output}`);
    if (entry.error) lines.push(`${indent}error: ${entry.error}`);
  }

  return lines.join('\n');
}

/**
 * Color-coded human-readable trace pretty-printer (OBS-01).
 *
 * Implements `TraceSink` from `@kagent/agent-loop`. Synchronous `emit()`
 * only — `flush()` and `close()` are OMITTED per CONTEXT D-10 because
 * `process.stdout` (the default target) is line-buffered by Node 22 and
 * requires no explicit drain.
 *
 * @example
 * ```ts
 * const sink = new StdoutSink({ color: 'auto', verbose: false });
 * executor.run(opts, { sinks: [sink] });
 * ```
 */
export class StdoutSink implements TraceSink {
  private readonly stream: NodeJS.WritableStream;
  private readonly verbose: boolean;
  private readonly useColor: boolean;

  constructor(opts: StdoutSinkOptions = {}) {
    this.stream = opts.stream ?? process.stdout;
    this.verbose = opts.verbose ?? false;
    // Compute ONCE at construct time (RESEARCH §Anti-patterns + §Open Question 3) —
    // env vars don't change mid-process; saves a per-event branch.
    this.useColor = resolveColor(opts.color ?? 'auto', this.stream);

    // EPIPE swallow per RESEARCH §Pitfall 3 — attach ONCE at construct time.
    // Without this, `pnpm demo | head -1` crashes with uncaught EPIPE on the
    // second emit. Best-effort log other errors to stderr.
    this.stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      // Sinks SHOULD NOT throw per trace.ts:100-102; best-effort log only.
      try {
        process.stderr.write(`StdoutSink: ${err.message}\n`);
      } catch {
        // stderr also broken — give up silently
      }
    });
  }

  emit(entry: TraceEntry): void {
    const line = this.verbose
      ? formatVerbose(entry, this.useColor)
      : formatCompact(entry, this.useColor);
    this.stream.write(line + '\n');
  }
}
