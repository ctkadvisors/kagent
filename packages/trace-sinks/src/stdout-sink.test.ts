/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * StdoutSink behavioral tests.
 *
 * Critical — RESEARCH §Pitfall 1: ALWAYS inject MockWritable via stream
 * option; NEVER assert against process.stdout directly. Vitest captures
 * stdout — process.stdout.isTTY === false under test.
 *
 * Env-var manipulation uses vi.stubEnv() (vitest 4.x) to scope per-test
 * — never mutate process.env directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { TraceEntry } from '@kagent/agent-loop';
import { StdoutSink } from './stdout-sink.js';

class MockWritable extends Writable {
  readonly chunks: string[] = [];
  isTTY = false; // tests that need TTY-true set this manually
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  get content(): string {
    return this.chunks.join('');
  }
}

const llmEntry: TraceEntry = {
  schema_version: '1',
  run_id: 'abc12345-9876-5432-1098-fedcba000000',
  sequence: 1,
  trace_type: 'llm_call',
  timestamp_ms: 1700000000000,
  latency_ms: 1240,
  model: 'gpt-4',
  input_tokens_est: 340,
  output_tokens_est: 120,
  cost_usd: 0.0024,
  stop_reason: 'end_turn',
  input_messages: '[{"role":"user","content":"hello world"}]',
  output_content: 'Hi there',
};

const toolEntry: TraceEntry = {
  schema_version: '1',
  run_id: 'abc12345-9876-5432-1098-fedcba000000',
  sequence: 2,
  trace_type: 'tool_call',
  timestamp_ms: 1700000000100,
  latency_ms: 45,
  tool_name: 'http_ping',
  tool_provider_id: 'http',
  tool_input: '{}',
  tool_output: '{"pong":true}',
  is_error: false,
};

const iterEntry: TraceEntry = {
  schema_version: '1',
  run_id: 'abc12345-9876-5432-1098-fedcba000000',
  sequence: 3,
  trace_type: 'iteration_boundary',
  timestamp_ms: 1700000000200,
  latency_ms: 0,
  iteration: 0,
};

const errorToolEntry: TraceEntry = {
  ...toolEntry,
  sequence: 4,
  is_error: true,
  tool_output: 'connection refused',
};

describe('StdoutSink — color resolution (CONTEXT D-07)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Test 1 — color: 'always' emits cyan-wrapped LLM line", () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'always', stream });
    sink.emit(llmEntry);
    expect(stream.content).toContain('\x1b[36m'); // cyan
    expect(stream.content).toContain('\x1b[0m'); // reset
  });

  it("Test 2 — color: 'never' emits plain text (no ANSI)", () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit(llmEntry);
    expect(stream.content).not.toContain('\x1b[');
  });

  it("Test 3 — color: 'auto' + NO_COLOR set disables colors", () => {
    vi.stubEnv('NO_COLOR', '1');
    const stream = new MockWritable();
    stream.isTTY = true; // would otherwise trigger color
    const sink = new StdoutSink({ color: 'auto', stream });
    sink.emit(llmEntry);
    expect(stream.content).not.toContain('\x1b[');
  });

  it("Test 4 — color: 'auto' + NO_COLOR='' (empty string) ALSO disables (per https://no-color.org/)", () => {
    vi.stubEnv('NO_COLOR', '');
    const stream = new MockWritable();
    stream.isTTY = true;
    const sink = new StdoutSink({ color: 'auto', stream });
    sink.emit(llmEntry);
    expect(stream.content).not.toContain('\x1b[');
  });

  it("Test 5 — color: 'auto' + FORCE_COLOR set enables colors even when stream.isTTY=false", () => {
    vi.stubEnv('FORCE_COLOR', '1');
    const stream = new MockWritable();
    stream.isTTY = false;
    const sink = new StdoutSink({ color: 'auto', stream });
    sink.emit(llmEntry);
    expect(stream.content).toContain('\x1b[');
  });

  it("Test 6 — color: 'auto' + neither env set + isTTY=true enables colors", () => {
    // vi.stubEnv with undefined removes the var from process.env.
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', undefined);
    const stream = new MockWritable();
    stream.isTTY = true;
    const sink = new StdoutSink({ color: 'auto', stream });
    sink.emit(llmEntry);
    expect(stream.content).toContain('\x1b[');
  });

  it("Test 7 — color: 'auto' + neither env set + isTTY=false disables colors", () => {
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', undefined);
    const stream = new MockWritable();
    stream.isTTY = false;
    const sink = new StdoutSink({ color: 'auto', stream });
    sink.emit(llmEntry);
    expect(stream.content).not.toContain('\x1b[');
  });

  it("Test 7b — color: 'auto' + FORCE_COLOR='' (empty string) does NOT force (falls through to NO_COLOR/isTTY)", () => {
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('NO_COLOR', undefined);
    const stream = new MockWritable();
    stream.isTTY = false;
    const sink = new StdoutSink({ color: 'auto', stream });
    sink.emit(llmEntry);
    expect(stream.content).not.toContain('\x1b[');
  });
});

describe('StdoutSink — compact format (CONTEXT D-08)', () => {
  it('Test 8 — LLM line includes run-id-short, seq-padded, model, tokens, cost, stop_reason', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit(llmEntry);
    const line = stream.content;
    expect(line).toContain('[run-abc12345 #001]');
    expect(line).toContain('LLM');
    expect(line).toContain('1240ms');
    expect(line).toContain('gpt-4');
    expect(line).toContain('in:340');
    expect(line).toContain('out:120');
    expect(line).toContain('$0.0024');
    expect(line).toContain('end_turn');
    expect(line.split('\n').filter(Boolean).length).toBe(1); // single line
  });

  it('Test 9 — TOOL line includes tool_name, provider_id, ok status, output preview', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit(toolEntry);
    const line = stream.content;
    expect(line).toContain('[run-abc12345 #002]');
    expect(line).toContain('TOOL');
    expect(line).toContain('45ms');
    expect(line).toContain('http_ping');
    expect(line).toContain('(http)');
    expect(line).toContain('ok');
    expect(line).toContain('{"pong":true}');
  });

  it('Test 10 — TOOL error line uses ✗ marker', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit(errorToolEntry);
    expect(stream.content).toContain('✗');
  });

  it('Test 11 — ITER line shows iteration boundary 0→1', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit(iterEntry);
    expect(stream.content).toContain('ITER');
    expect(stream.content).toContain('0→1');
  });

  it('Test 11b — ITER with no iteration field defaults to 0→1', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    const noIter: TraceEntry = {
      schema_version: '1',
      run_id: 'abc12345-xxxxxxxx',
      sequence: 9,
      trace_type: 'iteration_boundary',
      timestamp_ms: 0,
      latency_ms: 0,
    };
    sink.emit(noIter);
    expect(stream.content).toContain('0→1');
  });

  it('Test 12 — cost rendered when cost_usd is 0 (NOT just truthy — D-08 spec)', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit({ ...llmEntry, cost_usd: 0 });
    expect(stream.content).toContain('$0.0000');
  });

  it('Test 13 — cost OMITTED when cost_usd is null', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit({ ...llmEntry, cost_usd: null });
    expect(stream.content).not.toContain('$');
  });

  it('Test 13b — cost OMITTED when cost_usd is undefined (missing field)', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    const noCost: TraceEntry = { ...llmEntry, cost_usd: undefined };
    sink.emit(noCost);
    expect(stream.content).not.toContain('$');
  });

  it('Test 13c — LLM line with unknown model renders <unknown>', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit({ ...llmEntry, model: undefined });
    expect(stream.content).toContain('<unknown>');
  });

  it('Test 13d — LLM stop_reason omitted when not set', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit({ ...llmEntry, stop_reason: undefined });
    expect(stream.content).not.toContain('→');
  });

  it('Test 13e — TOOL with `error` field (no is_error) still renders ✗ marker', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit({ ...toolEntry, is_error: undefined, error: 'boom' });
    expect(stream.content).toContain('✗');
  });

  it('Test 13f — TOOL with no tool_output omits "→" output section', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit({ ...toolEntry, tool_output: undefined });
    expect(stream.content).not.toContain('→');
  });

  it('Test 13g — TOOL with unknown tool_name renders <unknown>; no provider renders no parens', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit({ ...toolEntry, tool_name: undefined, tool_provider_id: undefined });
    expect(stream.content).toContain('<unknown>');
    expect(stream.content).not.toContain('(http)');
  });

  it('Test 13h — LLM line with error renders ✗ status marker', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit({ ...llmEntry, is_error: true, error: 'rate limit' });
    expect(stream.content).toContain('✗');
  });

  it('Test 13i — LLM line with zero input/output tokens omitted renders in:0 out:0', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit({ ...llmEntry, input_tokens_est: undefined, output_tokens_est: undefined });
    expect(stream.content).toContain('in:0');
    expect(stream.content).toContain('out:0');
  });
});

describe('StdoutSink — verbose format (CONTEXT D-09)', () => {
  it('Test 14 — verbose LLM produces multi-line output with indented field dump', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', verbose: true, stream });
    sink.emit(llmEntry);
    const lines = stream.content.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    expect(stream.content).toContain('input_messages:');
    expect(stream.content).toContain('output_content:');
  });

  it('Test 15 — verbose ITER produces single header line (no fields)', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', verbose: true, stream });
    sink.emit(iterEntry);
    const lines = stream.content.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('Test 16 — verbose TOOL with error includes error field dump', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', verbose: true, stream });
    sink.emit({ ...errorToolEntry, error: 'oops' });
    expect(stream.content).toContain('error: oops');
  });

  it('Test 17 — verbose LLM truncates long input_messages preview to ~200 chars', () => {
    const longMsg = 'x'.repeat(500);
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', verbose: true, stream });
    sink.emit({ ...llmEntry, input_messages: longMsg });
    expect(stream.content).toContain('...');
    expect(stream.content).not.toContain('x'.repeat(300)); // not the full 500
  });

  it('Test 17b — verbose LLM truncates long output_content preview to ~200 chars', () => {
    const longOut = 'y'.repeat(500);
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', verbose: true, stream });
    sink.emit({ ...llmEntry, output_content: longOut });
    expect(stream.content).toContain('...');
    expect(stream.content).not.toContain('y'.repeat(300));
  });

  it('Test 17c — verbose LLM renders tools_available + output_tool_calls when present', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', verbose: true, stream });
    sink.emit({
      ...llmEntry,
      tools_available: '["http_ping"]',
      output_tool_calls: '[{"name":"http_ping","args":{}}]',
    });
    expect(stream.content).toContain('tools_available: ["http_ping"]');
    expect(stream.content).toContain('output_tool_calls:');
  });

  it('Test 17d — verbose LLM with short messages does NOT append ellipsis', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', verbose: true, stream });
    sink.emit({ ...llmEntry, input_messages: 'short', output_content: 'brief' });
    expect(stream.content).toContain('input_messages: short');
    expect(stream.content).toContain('output_content: brief');
    expect(stream.content).not.toContain('...');
  });

  it('Test 17e — verbose TOOL renders tool_input when present', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', verbose: true, stream });
    sink.emit(toolEntry);
    expect(stream.content).toContain('tool_input: {}');
    expect(stream.content).toContain('tool_output: {"pong":true}');
  });

  it('Test 17f — verbose LLM with all optional fields omitted produces only header', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', verbose: true, stream });
    const minimal: TraceEntry = {
      schema_version: '1',
      run_id: 'abc12345-xxxxxxxx',
      sequence: 99,
      trace_type: 'llm_call',
      timestamp_ms: 0,
      latency_ms: 10,
    };
    sink.emit(minimal);
    const lines = stream.content.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

describe('StdoutSink — defaults + EPIPE swallow', () => {
  it('Test 18 — default constructor uses process.stdout (no stream injection)', () => {
    // Cannot assert on process.stdout content under Vitest (RESEARCH §Pitfall 1).
    // Just construct + emit + expect no throw.
    const sink = new StdoutSink();
    expect(() => sink.emit(iterEntry)).not.toThrow();
  });

  it('Test 19 — EPIPE emitted on the stream is swallowed (no re-throw)', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    // Simulate EPIPE — should be swallowed by the sink's 'error' handler.
    expect(() =>
      stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })),
    ).not.toThrow();
    // Subsequent emits still work (sink not disabled by EPIPE alone)
    expect(() => sink.emit(iterEntry)).not.toThrow();
  });

  it('Test 19b — non-EPIPE stream error logs to stderr and does not throw', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() =>
        stream.emit('error', Object.assign(new Error('disk full'), { code: 'ENOSPC' })),
      ).not.toThrow();
      expect(stderrSpy).toHaveBeenCalled();
      const call = stderrSpy.mock.calls[0];
      expect(String(call?.[0])).toContain('StdoutSink');
      expect(String(call?.[0])).toContain('disk full');
    } finally {
      stderrSpy.mockRestore();
    }
    // Sink remains usable after logged error
    expect(() => sink.emit(iterEntry)).not.toThrow();
  });

  it('Test 19c — non-EPIPE stream error with stderr.write throwing is swallowed silently', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    expect(sink).toBeInstanceOf(StdoutSink);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr broken');
    });
    try {
      expect(() =>
        stream.emit('error', Object.assign(new Error('disk full'), { code: 'ENOSPC' })),
      ).not.toThrow();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('Test 20 — useColor is frozen at construct time (env change post-construct is ignored)', () => {
    vi.stubEnv('NO_COLOR', undefined);
    const stream = new MockWritable();
    stream.isTTY = true;
    const sink = new StdoutSink({ color: 'auto', stream });
    // After construct, set NO_COLOR — the sink should still emit colors (frozen).
    vi.stubEnv('NO_COLOR', '1');
    sink.emit(llmEntry);
    expect(stream.content).toContain('\x1b[');
    vi.unstubAllEnvs();
  });
});
