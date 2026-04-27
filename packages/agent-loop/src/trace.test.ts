/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Trace utility pure-fn coverage + TraceSink fan-out scaffold.
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens, truncateForStorage, truncateMessages } from './trace.js';
import type { TraceEntry, TraceSink } from './trace.js';
import type { ChatMessage } from './llm-client.js';

describe('trace — pure fns', () => {
  it('SC6.1: estimateTokens chars-over-4 ceiling — empty/short/long inputs', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(401))).toBe(101);
  });

  it('SC6.2: truncateForStorage — short returns identity; long returns head 500 + marker + tail 200', () => {
    expect(truncateForStorage('short')).toBe('short');
    expect(truncateForStorage('a'.repeat(700))).toBe('a'.repeat(700)); // exactly at boundary stays identity
    const long = 'h'.repeat(500) + 'm'.repeat(500) + 't'.repeat(200);
    const truncated = truncateForStorage(long);
    expect(truncated).toContain('h'.repeat(500));
    expect(truncated).toContain('t'.repeat(200));
    expect(truncated).toContain('[truncated 500 chars]');
  });

  it('SC6.3: truncateMessages — empty array returns "[]"; populated array returns JSON with truncated content', () => {
    expect(truncateMessages([])).toBe('[]');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ];
    const result = truncateMessages(messages);
    const parsed = JSON.parse(result) as Array<{ role: string; content: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.role).toBe('user');
    expect(parsed[0]?.content).toBe('hi');
    expect(parsed[1]?.content).toBe('hello there');
  });
});

describe('TraceEntry shape', () => {
  it('TraceEntry has schema_version: "1" literal type on every entry (D-18)', () => {
    const entry: TraceEntry = {
      schema_version: '1',
      run_id: 'r1',
      sequence: 0,
      trace_type: 'iteration_boundary',
      timestamp_ms: Date.now(),
      latency_ms: 0,
      iteration: 0,
    };
    expect(entry.schema_version).toBe('1');
  });

  it('TraceEntry trace_type union covers llm_call | tool_call | iteration_boundary', () => {
    const a: TraceEntry['trace_type'] = 'llm_call';
    const b: TraceEntry['trace_type'] = 'tool_call';
    const c: TraceEntry['trace_type'] = 'iteration_boundary';
    expect([a, b, c]).toEqual(['llm_call', 'tool_call', 'iteration_boundary']);
  });
});

describe('TraceSink interface shape', () => {
  it('TraceSink shape — emit required, flush optional, close optional', () => {
    const minimal: TraceSink = {
      emit: () => undefined,
    };
    const full: TraceSink = {
      emit: () => undefined,
      flush: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    expect(typeof minimal.emit).toBe('function');
    expect(typeof full.flush).toBe('function');
    expect(typeof full.close).toBe('function');
  });
});
