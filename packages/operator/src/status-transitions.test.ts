/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import type { AgentTaskCondition } from './crds/index.js';
import { mergeCondition, nextPhase } from './status-transitions.js';

describe('nextPhase — forward edges', () => {
  it('undefined → Pending OK', () => {
    expect(nextPhase(undefined, 'Pending')).toBe('Pending');
  });

  it('undefined → Dispatched OK', () => {
    expect(nextPhase(undefined, 'Dispatched')).toBe('Dispatched');
  });

  it('Pending → Dispatched OK', () => {
    expect(nextPhase('Pending', 'Dispatched')).toBe('Dispatched');
  });

  it('Dispatched → Completed OK', () => {
    expect(nextPhase('Dispatched', 'Completed')).toBe('Completed');
  });

  it('Dispatched → Failed OK', () => {
    expect(nextPhase('Dispatched', 'Failed')).toBe('Failed');
  });

  it('Pending → Completed OK (early success path)', () => {
    expect(nextPhase('Pending', 'Completed')).toBe('Completed');
  });

  it('Pending → Failed OK (early failure path)', () => {
    expect(nextPhase('Pending', 'Failed')).toBe('Failed');
  });
});

describe('nextPhase — terminal monotonicity (the WS-E core invariant)', () => {
  it('Completed → Failed BLOCKED (returns null)', () => {
    expect(nextPhase('Completed', 'Failed')).toBeNull();
  });

  it('Failed → Completed BLOCKED (returns null)', () => {
    expect(nextPhase('Failed', 'Completed')).toBeNull();
  });

  it('Completed → Completed OK (idempotent rewrite)', () => {
    expect(nextPhase('Completed', 'Completed')).toBe('Completed');
  });

  it('Failed → Failed OK (idempotent rewrite)', () => {
    expect(nextPhase('Failed', 'Failed')).toBe('Failed');
  });

  it('Completed → Pending BLOCKED', () => {
    expect(nextPhase('Completed', 'Pending')).toBeNull();
  });

  it('Completed → Dispatched BLOCKED', () => {
    expect(nextPhase('Completed', 'Dispatched')).toBeNull();
  });

  it('Failed → Pending BLOCKED', () => {
    expect(nextPhase('Failed', 'Pending')).toBeNull();
  });

  it('Failed → Dispatched BLOCKED', () => {
    expect(nextPhase('Failed', 'Dispatched')).toBeNull();
  });

  it('Dispatched → Pending BLOCKED (regression)', () => {
    expect(nextPhase('Dispatched', 'Pending')).toBeNull();
  });
});

describe('mergeCondition', () => {
  const t0 = '2026-04-27T05:00:00.000Z';
  const t1 = '2026-04-27T05:00:01.000Z';

  function cond(
    type: string,
    status: AgentTaskCondition['status'],
    lastTransitionTime: string,
    extras: Partial<AgentTaskCondition> = {},
  ): AgentTaskCondition {
    return { type, status, lastTransitionTime, ...extras };
  }

  it('appends a new type', () => {
    const result = mergeCondition([cond('Dispatched', 'True', t0)], cond('Failed', 'True', t1));
    expect(result).toHaveLength(2);
    expect(result[0]?.type).toBe('Dispatched');
    expect(result[1]?.type).toBe('Failed');
  });

  it('appends to an undefined list', () => {
    const result = mergeCondition(undefined, cond('Dispatched', 'True', t0));
    expect(result).toEqual([cond('Dispatched', 'True', t0)]);
  });

  it('appends to an empty list', () => {
    const result = mergeCondition([], cond('Dispatched', 'True', t0));
    expect(result).toEqual([cond('Dispatched', 'True', t0)]);
  });

  it('same-type-same-status preserves lastTransitionTime', () => {
    // The transition didn't happen — only the message/reason changed.
    // The Kubernetes convention is to PRESERVE lastTransitionTime so
    // observers can tell when the status field actually flipped.
    const existing = [
      cond('Dispatched', 'True', t0, { reason: 'first', message: 'first message' }),
    ];
    const incoming = cond('Dispatched', 'True', t1, {
      reason: 'second',
      message: 'second message',
    });
    const result = mergeCondition(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0]?.lastTransitionTime).toBe(t0);
    expect(result[0]?.reason).toBe('second');
    expect(result[0]?.message).toBe('second message');
  });

  it('same-type-different-status updates lastTransitionTime', () => {
    // The status field flipped — the transition just happened.
    // lastTransitionTime takes the new value.
    const existing = [cond('Failed', 'False', t0, { message: 'not yet' })];
    const incoming = cond('Failed', 'True', t1, { message: 'now failed' });
    const result = mergeCondition(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('True');
    expect(result[0]?.lastTransitionTime).toBe(t1);
    expect(result[0]?.message).toBe('now failed');
  });

  it('does not mutate the existing array', () => {
    const existing = [cond('Dispatched', 'True', t0)];
    const snapshot = JSON.stringify(existing);
    mergeCondition(existing, cond('Failed', 'True', t1));
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('preserves order when replacing in place', () => {
    const existing = [
      cond('Dispatched', 'True', t0),
      cond('JobFailedAfterComplete', 'True', t0),
      cond('Failed', 'False', t0),
    ];
    const incoming = cond('JobFailedAfterComplete', 'True', t1, { reason: 'OOMKilled' });
    const result = mergeCondition(existing, incoming);
    expect(result.map((c) => c.type)).toEqual(['Dispatched', 'JobFailedAfterComplete', 'Failed']);
    // same-status — lastTransitionTime preserved
    expect(result[1]?.lastTransitionTime).toBe(t0);
    expect(result[1]?.reason).toBe('OOMKilled');
  });
});
