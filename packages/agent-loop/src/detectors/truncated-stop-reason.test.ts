/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import type { TraceEntry } from '../trace.js';
import { computeQualityFlags } from './quality-flags.js';

function llm(out: number, content: string, stop?: string): TraceEntry {
  return {
    schema_version: '1',
    run_id: 'r1',
    sequence: 1,
    trace_type: 'llm_call',
    timestamp_ms: 0,
    latency_ms: 100,
    output_tokens_est: out,
    output_content: content,
    ...(stop !== undefined && { stop_reason: stop }),
  };
}
const flagged = (out: number, content: string, stop?: string): boolean =>
  computeQualityFlags([llm(out, content, stop)], content, 'decide').includes('truncated_synthesis');

const BOSS =
  'Decided the three queued items: 12864 floor stands, 12865 floor stands, 12866 floor stands. ' +
  'Each names a path outside every writable grant, so no proposal was posted for them. ' +
  'The fourth item was already disposed.\n\nnothing queued';

describe('truncated_synthesis and the stop reason', () => {
  it('does not flag a short answer the engine ended itself, whatever its last character', () => {
    expect(flagged(260, BOSS, 'end_turn')).toBe(false);
  });

  it('flags a length stop even when the text happens to end on a full stop', () => {
    expect(flagged(16000, 'A long answer that was cut by the cap. '.repeat(40), 'max_tokens')).toBe(
      true,
    );
  });

  it('keeps the punctuation rule when no stop reason is known, or the answer is cap-sized', () => {
    expect(flagged(260, BOSS)).toBe(true);
    expect(flagged(4096, BOSS.repeat(30), 'end_turn')).toBe(true);
    expect(flagged(260, BOSS + '.', 'end_turn')).toBe(false);
  });
});
