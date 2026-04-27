/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * JsonlFileSink behavioral tests.
 *
 * Critical:
 *   - Pitfall 2: macOS `os.tmpdir()` returns a symlinked path; NEVER assert
 *     on absolute paths. Compare DATA only.
 *   - Pitfall 4: `close()` may race with the `'error'` event; tests for
 *     error paths verify both branches.
 *   - Pitfall 5: round-trip parse uses `.filter(Boolean)` before `JSON.parse`.
 *
 * `mkdtempSync` per `beforeEach` + `rmSync` recursive per `afterEach` for
 * parallel-test safety (RESEARCH §Code Examples lines 487-503).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { TraceEntry } from '@kagent/agent-loop';
import { InvalidConfigError } from '@kagent/agent-loop';
import { JsonlFileSink } from './jsonl-file-sink.js';

// ─── Synthetic TraceEntry fixtures ──────────────────────────────────────

const sampleEntry: TraceEntry = {
  schema_version: '1',
  run_id: 'r1',
  sequence: 0,
  trace_type: 'iteration_boundary',
  timestamp_ms: 1700000000000,
  latency_ms: 0,
  iteration: 0,
};

const llmEntry: TraceEntry = {
  schema_version: '1',
  run_id: 'r1',
  sequence: 1,
  trace_type: 'llm_call',
  timestamp_ms: 1700000001000,
  latency_ms: 1240,
  model: 'gpt-4',
  input_tokens_est: 340,
  output_tokens_est: 120,
  cost_usd: 0.0024,
  stop_reason: 'end_turn',
};

const toolEntry: TraceEntry = {
  schema_version: '1',
  run_id: 'r1',
  sequence: 2,
  trace_type: 'tool_call',
  timestamp_ms: 1700000002000,
  latency_ms: 45,
  tool_name: 'http_ping',
  tool_provider_id: 'http',
  tool_input: '{}',
  tool_output: '{"pong":true}',
  is_error: false,
};

// ─── Per-test tmp dir harness ───────────────────────────────────────────

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phase6-jsonl-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('JsonlFileSink — basic writes (CONTEXT D-12, D-16)', () => {
  it('Test 1 — writes one line per emit to <dir>/<runId>.jsonl', async () => {
    const sink = new JsonlFileSink({ runId: 'r1', dir });
    sink.emit(sampleEntry);
    sink.emit(llmEntry);
    await sink.flush();
    await sink.close();

    const content = readFileSync(join(dir, 'r1.jsonl'), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual(sampleEntry);
    expect(JSON.parse(lines[1]!)).toEqual(llmEntry);
  });

  it('Test 2 — file path is exactly <dir>/<runId>.jsonl per ROADMAP SC2', async () => {
    const sink = new JsonlFileSink({ runId: 'my-run-123', dir });
    sink.emit(sampleEntry);
    await sink.close();
    expect(existsSync(join(dir, 'my-run-123.jsonl'))).toBe(true);
  });

  it('Test 3 — every line carries schema_version "1" (kernel trace.ts:38 lock)', async () => {
    const sink = new JsonlFileSink({ runId: 'r1', dir });
    sink.emit(sampleEntry);
    sink.emit(llmEntry);
    sink.emit(toolEntry);
    await sink.close();
    const lines = readFileSync(join(dir, 'r1.jsonl'), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line) as TraceEntry;
      expect(parsed.schema_version).toBe('1');
    }
  });
});

describe('JsonlFileSink — lazy open (CONTEXT D-12)', () => {
  it('Test 4 — file is NOT created on construction (lazy open per D-12)', () => {
    // Intentionally construct but never emit; cast to void to satisfy no-unused-vars.
    void new JsonlFileSink({ runId: 'never-emit', dir });
    expect(existsSync(join(dir, 'never-emit.jsonl'))).toBe(false);
  });

  it('Test 5 — file IS created on first emit (after flush)', async () => {
    const sink = new JsonlFileSink({ runId: 'r1', dir });
    expect(existsSync(join(dir, 'r1.jsonl'))).toBe(false);
    sink.emit(sampleEntry);
    // createWriteStream opens the fd asynchronously; flush() drains writes
    // and guarantees the file is on disk by the time it resolves.
    await sink.flush();
    expect(existsSync(join(dir, 'r1.jsonl'))).toBe(true);
    await sink.close();
  });
});

describe('JsonlFileSink — append mode (CONTEXT D-12 flags:"a")', () => {
  it('Test 6 — second JsonlFileSink with same path APPENDS (does not overwrite)', async () => {
    const sink1 = new JsonlFileSink({ runId: 'r1', dir });
    sink1.emit(sampleEntry);
    await sink1.close();

    const sink2 = new JsonlFileSink({ runId: 'r1', dir });
    sink2.emit(llmEntry);
    await sink2.close();

    const lines = readFileSync(join(dir, 'r1.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual(sampleEntry);
    expect(JSON.parse(lines[1]!)).toEqual(llmEntry);
  });
});

describe('JsonlFileSink — flush (CONTEXT D-13 empty-write trick)', () => {
  it('Test 7 — flush() resolves after queued writes drain', async () => {
    const sink = new JsonlFileSink({ runId: 'r1', dir });
    sink.emit(sampleEntry);
    await sink.flush();
    // After flush resolves, file content is visible to a synchronous reader.
    const content = readFileSync(join(dir, 'r1.jsonl'), 'utf8');
    expect(content.length).toBeGreaterThan(0);
    expect(JSON.parse(content.trim())).toEqual(sampleEntry);
    await sink.close();
  });

  it('Test 8 — flush() is no-op when stream never opened (no emits)', async () => {
    const sink = new JsonlFileSink({ runId: 'r1', dir });
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});

describe('JsonlFileSink — close (CONTEXT D-14 idempotent)', () => {
  it('Test 9 — close() is idempotent (second call no-op)', async () => {
    const sink = new JsonlFileSink({ runId: 'r1', dir });
    sink.emit(sampleEntry);
    await sink.close();
    await expect(sink.close()).resolves.toBeUndefined();
  });

  it('Test 10 — emit() after close() throws InvalidConfigError', async () => {
    const sink = new JsonlFileSink({ runId: 'r1', dir });
    sink.emit(sampleEntry);
    await sink.close();
    expect(() => {
      sink.emit(llmEntry);
    }).toThrow(InvalidConfigError);
  });

  it('Test 11 — close() is no-op when stream never opened (no emits)', async () => {
    const sink = new JsonlFileSink({ runId: 'r1', dir });
    await expect(sink.close()).resolves.toBeUndefined();
  });
});

describe('JsonlFileSink — error swallowing (CONTEXT D-15)', () => {
  it('Test 12 — fs error during emit triggers disabled=true; subsequent emits are no-op (no throw)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    class FailingWriteStream extends Writable {
      override _write(
        _chunk: Buffer | string,
        _enc: BufferEncoding,
        cb: (err?: Error) => void,
      ): void {
        cb();
      }
    }
    const failingStream = new FailingWriteStream();

    const mockFs = {
      ...nodeFs,
      mkdirSync: () => undefined,
      createWriteStream: () => failingStream,
    } as unknown as typeof import('node:fs');

    const sink = new JsonlFileSink({ runId: 'r1', dir, fs: mockFs, autoCreateDir: false });
    sink.emit(sampleEntry); // opens stream + attaches 'error' handler
    failingStream.emit('error', new Error('disk full'));
    expect(() => {
      sink.emit(llmEntry);
    }).not.toThrow(); // no-op now
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('JsonlFileSink: disk full'));

    stderrSpy.mockRestore();
  });

  it('Test 12b — stderr.write throw during error logging is swallowed silently', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr also broken');
    });

    class FailingWriteStream extends Writable {
      override _write(
        _chunk: Buffer | string,
        _enc: BufferEncoding,
        cb: (err?: Error) => void,
      ): void {
        cb();
      }
    }
    const failingStream = new FailingWriteStream();

    const mockFs = {
      ...nodeFs,
      mkdirSync: () => undefined,
      createWriteStream: () => failingStream,
    } as unknown as typeof import('node:fs');

    const sink = new JsonlFileSink({ runId: 'r1', dir, fs: mockFs, autoCreateDir: false });
    sink.emit(sampleEntry); // opens stream + attaches 'error' handler
    // Emitting 'error' triggers the handler; stderr.write throws; catch swallows.
    expect(() => {
      failingStream.emit('error', new Error('disk full'));
    }).not.toThrow();
    // Subsequent emit is a no-op because disabled was still set.
    expect(() => {
      sink.emit(llmEntry);
    }).not.toThrow();

    stderrSpy.mockRestore();
  });
});

describe('JsonlFileSink — autoCreateDir (CONTEXT D-11)', () => {
  it('Test 13 — autoCreateDir=true (default) creates missing nested dir on first emit', async () => {
    const nestedDir = join(dir, 'nested', 'subdir');
    expect(existsSync(nestedDir)).toBe(false);
    const sink = new JsonlFileSink({ runId: 'r1', dir: nestedDir });
    sink.emit(sampleEntry);
    // mkdirSync runs synchronously in openStream(), so the dir is present
    // immediately — but the file fd opens async, so drain via flush().
    expect(existsSync(nestedDir)).toBe(true);
    await sink.flush();
    expect(existsSync(join(nestedDir, 'r1.jsonl'))).toBe(true);
    await sink.close();
  });

  it('Test 14 — autoCreateDir=false + missing dir → stream errors async → sink disables (does NOT throw from emit)', async () => {
    // mkdirSync is skipped; createWriteStream succeeds lazily; the underlying
    // open(2) fails async → 'error' event fires → CONTEXT D-15 swallow path.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const missingDir = join(dir, 'definitely-not-there');
    const sink = new JsonlFileSink({ runId: 'r1', dir: missingDir, autoCreateDir: false });
    // emit() itself does not throw — the real fs error surfaces on the
    // stream 'error' event, which the sink catches and sets disabled=true.
    expect(() => {
      sink.emit(sampleEntry);
    }).not.toThrow();
    // Drain libuv ticks so the async open(2) failure surfaces. Poll up
    // to ~250ms — typical resolution is <5ms but CI hosts vary.
    for (let i = 0; i < 50 && stderrSpy.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('JsonlFileSink:'));
    // Subsequent emits are no-ops.
    expect(() => {
      sink.emit(llmEntry);
    }).not.toThrow();
    // The file was never created.
    expect(existsSync(join(missingDir, 'r1.jsonl'))).toBe(false);
    stderrSpy.mockRestore();
  });

  it('Test 14c — autoCreateDir=false + mkdirSync injected to throw → emit propagates synchronously', () => {
    // Cover the `openStream` try/catch throw path explicitly: if mkdirSync
    // throws (permission denied, etc.) AND autoCreateDir=true wraps it in
    // the try, we rethrow after setting disabled. Use autoCreateDir=true
    // with a failing mock fs to hit this branch.
    const failingMkdir = () => {
      throw new Error('EACCES: permission denied');
    };
    const mockFs = {
      ...nodeFs,
      mkdirSync: failingMkdir,
    } as unknown as typeof import('node:fs');
    const sink = new JsonlFileSink({ runId: 'r1', dir, fs: mockFs, autoCreateDir: true });
    expect(() => {
      sink.emit(sampleEntry);
    }).toThrow('EACCES');
    // Sink is now disabled — subsequent emits no-op (no throw).
    expect(() => {
      sink.emit(llmEntry);
    }).not.toThrow();
  });

  it('Test 14b — autoCreateDir=false with an existing dir writes successfully', async () => {
    // dir itself exists (mkdtempSync created it); autoCreateDir=false should just open the stream.
    const sink = new JsonlFileSink({ runId: 'r1', dir, autoCreateDir: false });
    sink.emit(sampleEntry);
    await sink.close();
    const content = readFileSync(join(dir, 'r1.jsonl'), 'utf8');
    expect(JSON.parse(content.trim())).toEqual(sampleEntry);
  });
});

describe('JsonlFileSink — runId sanity check (RESEARCH §Open Question 1; security)', () => {
  it('Test 15 — empty runId throws InvalidConfigError', () => {
    expect(() => new JsonlFileSink({ runId: '', dir })).toThrow(InvalidConfigError);
  });

  it('Test 16 — runId with "/" throws InvalidConfigError (path traversal protection)', () => {
    expect(() => new JsonlFileSink({ runId: 'foo/bar', dir })).toThrow(InvalidConfigError);
  });

  it('Test 17a — runId with "\\" throws InvalidConfigError', () => {
    expect(() => new JsonlFileSink({ runId: 'foo\\bar', dir })).toThrow(InvalidConfigError);
  });

  it('Test 17b — runId with a space throws InvalidConfigError', () => {
    expect(() => new JsonlFileSink({ runId: 'foo bar', dir })).toThrow(InvalidConfigError);
  });

  it('Test 17c — runId "../escape" throws InvalidConfigError (contains /)', () => {
    expect(() => new JsonlFileSink({ runId: '../escape', dir })).toThrow(InvalidConfigError);
  });

  it('Test 17d — runId with null byte throws InvalidConfigError', () => {
    expect(() => new JsonlFileSink({ runId: 'foo\0bar', dir })).toThrow(InvalidConfigError);
  });

  it('Test 18 — UUID-shaped runId is accepted (kernel default at executor.ts:56)', () => {
    expect(
      () => new JsonlFileSink({ runId: '550e8400-e29b-41d4-a716-446655440000', dir }),
    ).not.toThrow();
  });
});
