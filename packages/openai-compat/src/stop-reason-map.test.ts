/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * INT-01 — stop-reason-map pure-fn tests.
 * Coverage target: 100% line + 100% branch (VALIDATION §Coverage Targets).
 */

import { describe, it, expect } from 'vitest';
import { mapFinishReason } from './stop-reason-map.js';

describe('mapFinishReason (VALIDATION row 6 / D-12)', () => {
  it('VALIDATION.6: stop → end_turn', () => {
    expect(mapFinishReason('stop')).toBe('end_turn');
  });

  it('VALIDATION.6: tool_calls → tool_use', () => {
    expect(mapFinishReason('tool_calls')).toBe('tool_use');
  });

  it('VALIDATION.6: function_call → tool_use (legacy alias)', () => {
    expect(mapFinishReason('function_call')).toBe('tool_use');
  });

  it('VALIDATION.6: length → max_tokens', () => {
    expect(mapFinishReason('length')).toBe('max_tokens');
  });

  it('VALIDATION.6: content_filter → end_turn (preserves Phase 3 union per RESEARCH)', () => {
    expect(mapFinishReason('content_filter')).toBe('end_turn');
  });

  it('VALIDATION.6: null → undefined', () => {
    expect(mapFinishReason(null)).toBeUndefined();
  });

  it('VALIDATION.6: undefined → undefined', () => {
    expect(mapFinishReason(undefined)).toBeUndefined();
  });

  it('VALIDATION.6: unknown values → undefined (forward-compat)', () => {
    expect(mapFinishReason('some_future_reason')).toBeUndefined();
    expect(mapFinishReason('')).toBeUndefined();
  });
});
