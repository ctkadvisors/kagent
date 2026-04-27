/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import type { RunResult } from './runner.js';
import { buildStatusPatch } from './status.js';

const baseResult: RunResult = {
  runId: 'task-uid-1',
  status: 'completed',
  finalContent: 'K3s uses containerd by default.',
  flags: [],
  traces: [],
  budget: {
    cumulativeInputTokens: 10,
    cumulativeOutputTokens: 5,
    cumulativeCostUsd: 0,
  },
};

const fixedNow = new Date('2026-04-26T10:00:00.000Z');

describe('buildStatusPatch', () => {
  it('maps status=completed to phase=Completed with content + verdict', () => {
    const patch = buildStatusPatch(baseResult, fixedNow);
    expect(patch.phase).toBe('Completed');
    expect(patch.result).toEqual({ content: 'K3s uses containerd by default.' });
    expect(patch.completedAt).toBe('2026-04-26T10:00:00.000Z');
    expect(patch.structuralVerdict?.suspicious).toEqual([]);
    expect(patch.error).toBeUndefined();
  });

  it('includes detector flags in structuralVerdict.suspicious', () => {
    const result: RunResult = {
      ...baseResult,
      flags: ['methodology_fabrication', 'truncated_synthesis'],
    };
    const patch = buildStatusPatch(result, fixedNow);
    expect(patch.structuralVerdict?.suspicious).toEqual([
      'methodology_fabrication',
      'truncated_synthesis',
    ]);
  });

  it('maps status=failed to phase=Failed with error message', () => {
    const result: RunResult = {
      ...baseResult,
      status: 'failed',
      error: { message: 'LLM timeout' },
    };
    const patch = buildStatusPatch(result, fixedNow);
    expect(patch.phase).toBe('Failed');
    expect(patch.error).toBe('LLM timeout');
    expect(patch.result).toBeUndefined();
  });

  it('maps non-completed terminal statuses to Failed with synthetic message', () => {
    for (const status of ['cancelled', 'budget_exceeded', 'timeout'] as const) {
      const result: RunResult = { ...baseResult, status };
      const patch = buildStatusPatch(result, fixedNow);
      expect(patch.phase).toBe('Failed');
      expect(patch.error).toMatch(/loop ended with status=/);
    }
  });

  it('preserves verdict on Failed too', () => {
    const result: RunResult = {
      ...baseResult,
      status: 'failed',
      flags: ['synthesis_low_yield'],
      error: { message: 'thing' },
    };
    const patch = buildStatusPatch(result, fixedNow);
    expect(patch.structuralVerdict?.suspicious).toEqual(['synthesis_low_yield']);
  });
});
