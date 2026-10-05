/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * A failed LLM call says why. The compact line printed `✗` with no reason (status,
 * message), so a run of fast failures could not be told apart from a throttle, a
 * gateway refusal or a broken backend without another tool.
 */

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import type { TraceEntry } from '@kagent/agent-loop';
import { StdoutSink } from './stdout-sink.js';

class MockWritable extends Writable {
  readonly chunks: string[] = [];
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  get content(): string {
    return this.chunks.join('');
  }
}

const failedLlm: TraceEntry = {
  schema_version: '1',
  run_id: 'abc12345-9876-5432-1098-fedcba000000',
  sequence: 7,
  trace_type: 'llm_call',
  timestamp_ms: 1700000000000,
  latency_ms: 8,
  is_error: true,
  error: 'LLM backend returned HTTP 429: in-flight cap reached',
};

describe('StdoutSink — failed LLM calls', () => {
  it('the compact line carries the error', () => {
    const stream = new MockWritable();
    const sink = new StdoutSink({ color: 'never', stream });
    sink.emit(failedLlm);
    expect(stream.content).toContain('✗');
    expect(stream.content).toContain('HTTP 429: in-flight cap reached');
  });
});
