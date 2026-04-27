/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `JsonlFileSink` — per-run JSON-Lines trace file writer (OBS-02).
 *
 * Implements `TraceSink` from `@kagent/agent-loop` (`packages/runtime/src/trace.ts:104-108`).
 * Writes one `JSON.stringify(entry) + "\n"` per emit to
 * `<dir>/<runId>.jsonl` using `fs.createWriteStream({flags: 'a'})` opened
 * lazily on first emit (CONTEXT D-12). Append-mode survives crashes —
 * partial files are resumable by the future M3 Langfuse ingester.
 *
 * Lifecycle (consumer-owned per Phase 5 `McpToolProvider` precedent):
 *   - `emit(entry)`     — sync; queues write to internal stream buffer
 *   - `flush()`         — drains pending writes via empty-write trick (D-13)
 *   - `close()`         — idempotent; awaits `'finish'` event (D-14)
 *
 * Error handling (CONTEXT D-15 + Phase 3 `trace.ts:100-102`):
 *   - Stream `'error'` event → log to stderr ONCE + set `disabled = true`
 *   - Subsequent `emit()` calls become no-ops (sink is inert)
 *   - `flush()` and `close()` errors propagate (consumer asked)
 *   - `emit()` after `close()` throws `InvalidConfigError` (programmer error)
 *
 * Security: `runId` is sanity-checked at construct time for path-traversal
 * characters (per RESEARCH §Open Question 1 + `security_threat_model`).
 * Defense-in-depth — even though the kernel always supplies `randomUUID()`,
 * a future consumer overriding runId could pass `../../etc/passwd`.
 *
 * Schema: each line is a complete `TraceEntry` carrying its own
 * `schema_version` literal (kernel `trace.ts:38` locks `'1'`). No outer
 * envelope (D-16). Round-trip read:
 * `readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse)`.
 */

import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import type { TraceEntry, TraceSink } from '@kagent/agent-loop';
import { InvalidConfigError } from '@kagent/agent-loop';

/**
 * Allowed `runId` characters — alphanumerics, hyphen, underscore, period.
 * Matches the shape of `randomUUID()` (the kernel default at
 * `executor.ts:56`) AND most consumer-supplied IDs. Rejects: `/`, `\`, `\0`,
 * control chars, spaces, and other path-traversal vectors.
 *
 * Defense-in-depth per RESEARCH §Open Question 1 + `security_threat_model`.
 * Cost: 3 lines + tests. Closes the obvious foot-gun even though the kernel
 * always supplies safe UUIDs.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9_.-]+$/;

/**
 * Options for `JsonlFileSink` constructor (CONTEXT D-11).
 */
export interface JsonlFileSinkOptions {
  /**
   * Run identifier; used to name the output file as `<dir>/${runId}.jsonl`.
   * Required. Sanitized for path-traversal characters at construct time.
   */
  runId: string;
  /**
   * Output directory. Defaults to `'runs'` (relative to process cwd).
   * Created recursively at first emit if `autoCreateDir` is true (default).
   */
  dir?: string;
  /**
   * Injectable `node:fs` namespace for tests + future Workers. Defaults
   * to the real `node:fs`.
   */
  fs?: typeof import('node:fs');
  /**
   * Create the output directory recursively at first emit. Default `true`.
   * Set to `false` to fail fast (error during emit-time `mkdirSync`) if
   * the consumer expects the dir to already exist.
   */
  autoCreateDir?: boolean;
}

/**
 * Per-run JSON-Lines trace file writer (OBS-02).
 *
 * Implements `TraceSink` from `@kagent/agent-loop`. Lazy `createWriteStream`
 * on first emit per CONTEXT D-12; idempotent `close()` per D-14.
 *
 * @example
 * ```ts
 * const sink = new JsonlFileSink({ runId: 'abc123', dir: 'runs' });
 * executor.run(opts, { sinks: [sink] });
 * await sink.close();
 * ```
 */
export class JsonlFileSink implements TraceSink {
  private readonly runId: string;
  private readonly dir: string;
  private readonly fs: typeof import('node:fs');
  private readonly autoCreateDir: boolean;
  private readonly path: string;
  private stream: nodeFs.WriteStream | undefined;
  private disabled = false;
  private closed = false;

  constructor(opts: JsonlFileSinkOptions) {
    if (typeof opts.runId !== 'string' || opts.runId.length === 0) {
      throw new InvalidConfigError('runId', 'must be a non-empty string');
    }
    if (!SAFE_RUN_ID.test(opts.runId)) {
      throw new InvalidConfigError(
        'runId',
        'contains forbidden characters (path traversal protection — allowed: A-Za-z0-9_.-)',
      );
    }
    this.runId = opts.runId;
    this.dir = opts.dir ?? 'runs';
    this.fs = opts.fs ?? nodeFs;
    this.autoCreateDir = opts.autoCreateDir ?? true;
    this.path = path.join(this.dir, `${this.runId}.jsonl`);
  }

  emit(entry: TraceEntry): void {
    if (this.disabled) return;
    if (this.closed) {
      throw new InvalidConfigError('JsonlFileSink', 'emit() called after close()');
    }
    if (!this.stream) this.openStream();
    // Stream may have failed during openStream → disabled would be true.
    if (this.disabled || !this.stream) return;
    this.stream.write(JSON.stringify(entry) + '\n');
  }

  async flush(): Promise<void> {
    if (!this.stream) return; // never opened — nothing to flush
    if (this.disabled) return; // post-error no-op
    await new Promise<void>((resolve, reject) => {
      // Empty-write drain trick per CONTEXT D-13 + RESEARCH §Code Examples.
      // Callback fires after all prior writes are accepted by the OS.
      this.stream!.write('', (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return; // idempotent per D-14
    this.closed = true;
    if (!this.stream) return; // never opened
    await new Promise<void>((resolve, reject) => {
      // Race-safe finish per RESEARCH §Pitfall 4 — listen on BOTH events;
      // 'error' may fire after end() if a buffered write errored late.
      this.stream!.once('finish', resolve);
      this.stream!.once('error', reject);
      this.stream!.end();
    });
  }

  private openStream(): void {
    try {
      if (this.autoCreateDir) {
        this.fs.mkdirSync(this.dir, { recursive: true });
      }
      this.stream = this.fs.createWriteStream(this.path, { flags: 'a' });
      this.stream.on('error', (err: Error) => {
        // Sinks SHOULD NOT throw per Phase 3 trace.ts:100-102.
        // Log ONCE to stderr + set disabled flag → subsequent emits no-op.
        try {
          process.stderr.write(`JsonlFileSink: ${err.message}\n`);
        } catch {
          // stderr also broken — give up silently
        }
        this.disabled = true;
      });
    } catch (err) {
      // mkdirSync threw (autoCreateDir=false + missing dir, or permission
      // denied) — surface to the consumer because this is either a
      // construction-time programmer error OR an explicit "fail-fast"
      // decision. Mark disabled so subsequent emits don't keep retrying.
      this.disabled = true;
      throw err;
    }
  }
}
