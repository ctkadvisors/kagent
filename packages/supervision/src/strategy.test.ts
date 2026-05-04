/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { assertStrategyAllowed, evaluateStrategy } from './strategy.js';
import type { FailedChild, SiblingTask, SupervisionStrategy, TaskRef } from './types.js';
import {
  ALL_SUPERVISION_STRATEGIES,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_SUPERVISION_STRATEGY,
} from './types.js';

function tref(uid: string, name = uid): TaskRef {
  return { uid, name, namespace: 'default' };
}

function sib(
  uid: string,
  phase: SiblingTask['phase'],
  startedAt?: string,
  restartCount = 0,
): SiblingTask {
  const ref: TaskRef = { uid, name: uid, namespace: 'default' };
  return {
    ref,
    phase,
    ...(startedAt !== undefined && { startedAt }),
    restartCount,
  };
}

const failed: FailedChild = {
  ref: tref('child-2'),
  reason: 'MissingRequiredOutputs',
  message: 'output `summary` not present',
};

describe('@kagent/supervision — defaults + enum', () => {
  it('exports all four strategies in OTP order', () => {
    expect(ALL_SUPERVISION_STRATEGIES).toEqual([
      'one_for_one',
      'one_for_all',
      'rest_for_one',
      'escalate',
    ]);
  });

  it('default strategy is one_for_one (preserves v0.1 implicit behavior)', () => {
    expect(DEFAULT_SUPERVISION_STRATEGY).toBe('one_for_one');
  });

  it('default maxRestarts is 3', () => {
    expect(DEFAULT_MAX_RESTARTS).toBe(3);
  });
});

describe('evaluateStrategy — one_for_one', () => {
  it('targets only the failed child', () => {
    const decision = evaluateStrategy('one_for_one', failed, [
      sib('child-1', 'Dispatched', '2026-05-04T10:00:00Z'),
      sib('child-2', 'Failed', '2026-05-04T10:00:01Z'),
      sib('child-3', 'Dispatched', '2026-05-04T10:00:02Z'),
    ]);
    expect(decision.action).toBe('restart');
    expect(decision.targets).toHaveLength(1);
    expect(decision.targets[0]?.uid).toBe('child-2');
    expect(decision.strategy).toBe('one_for_one');
    expect(decision.reason).toContain('one_for_one');
    expect(decision.reason).toContain('MissingRequiredOutputs');
  });

  it('does not include any sibling regardless of phase', () => {
    const decision = evaluateStrategy('one_for_one', failed, [
      sib('child-1', 'Dispatched'),
      sib('child-2', 'Failed'),
      sib('child-3', 'Pending'),
      sib('child-4', 'Completed'),
    ]);
    expect(decision.targets.map((t) => t.uid)).toEqual(['child-2']);
  });

  it('handles an empty sibling list', () => {
    const decision = evaluateStrategy('one_for_one', failed, []);
    expect(decision.action).toBe('restart');
    expect(decision.targets).toHaveLength(1);
  });
});

describe('evaluateStrategy — one_for_all', () => {
  it('terminates every in-flight sibling + the failed child', () => {
    const decision = evaluateStrategy('one_for_all', failed, [
      sib('child-1', 'Dispatched', '2026-05-04T10:00:00Z'),
      sib('child-2', 'Failed', '2026-05-04T10:00:01Z'),
      sib('child-3', 'Dispatched', '2026-05-04T10:00:02Z'),
      sib('child-4', 'Pending'),
    ]);
    expect(decision.action).toBe('terminate-and-restart-tree');
    // child-1 + child-3 + child-4 are in-flight; failed (child-2) appended.
    expect(decision.targets.map((t) => t.uid).sort()).toEqual([
      'child-1',
      'child-2',
      'child-3',
      'child-4',
    ]);
    expect(decision.strategy).toBe('one_for_all');
  });

  it('skips terminal siblings (Completed / Failed siblings stay)', () => {
    const decision = evaluateStrategy('one_for_all', failed, [
      sib('child-1', 'Completed'),
      sib('child-2', 'Failed'),
      sib('child-3', 'Failed'),
      sib('child-4', 'Dispatched'),
    ]);
    // Only child-4 (in-flight) + the failed child get targeted.
    expect(decision.targets.map((t) => t.uid).sort()).toEqual(['child-2', 'child-4']);
  });

  it('always includes the failed child even when the snapshot omits it', () => {
    const decision = evaluateStrategy('one_for_all', failed, [
      sib('child-1', 'Dispatched'),
      sib('child-3', 'Pending'),
    ]);
    expect(decision.targets.map((t) => t.uid).sort()).toEqual(['child-1', 'child-2', 'child-3']);
  });

  it('de-dupes when the failed child appears in the sibling list', () => {
    // Failed child shows up once in the snapshot AND must not appear
    // twice in targets.
    const decision = evaluateStrategy('one_for_all', failed, [
      sib('child-1', 'Dispatched'),
      sib('child-2', 'Dispatched'), // failed child as still-in-flight
    ]);
    expect(decision.targets.filter((t) => t.uid === 'child-2')).toHaveLength(1);
  });

  it('handles empty sibling list gracefully', () => {
    const decision = evaluateStrategy('one_for_all', failed, []);
    expect(decision.targets).toHaveLength(1);
    expect(decision.targets[0]?.uid).toBe('child-2');
  });
});

describe('evaluateStrategy — rest_for_one', () => {
  it('terminates failed child + every sibling started AFTER it (start-order)', () => {
    const siblings = [
      sib('a', 'Dispatched', '2026-05-04T10:00:00Z'),
      sib('b', 'Dispatched', '2026-05-04T10:00:01Z'),
      sib('child-2', 'Failed', '2026-05-04T10:00:02Z'),
      sib('c', 'Dispatched', '2026-05-04T10:00:03Z'),
      sib('d', 'Pending', '2026-05-04T10:00:04Z'),
    ];
    const decision = evaluateStrategy('rest_for_one', failed, siblings);
    expect(decision.action).toBe('terminate-and-restart-subset');
    // Order: failed first, then siblings in start-order.
    expect(decision.targets.map((t) => t.uid)).toEqual(['child-2', 'c', 'd']);
  });

  it('preserves siblings started BEFORE the failed child', () => {
    const decision = evaluateStrategy('rest_for_one', failed, [
      sib('a', 'Dispatched', '2026-05-04T10:00:00Z'),
      sib('b', 'Dispatched', '2026-05-04T10:00:01Z'),
      sib('child-2', 'Failed', '2026-05-04T10:00:02Z'),
    ]);
    // Only the failed child; nothing started after it.
    expect(decision.targets.map((t) => t.uid)).toEqual(['child-2']);
  });

  it('treats undefined startedAt as "later" (sorts last)', () => {
    const decision = evaluateStrategy('rest_for_one', failed, [
      sib('a', 'Dispatched', '2026-05-04T10:00:00Z'),
      sib('child-2', 'Failed', '2026-05-04T10:00:01Z'),
      sib('b', 'Pending'), // no startedAt → sorts after failed child
    ]);
    expect(decision.targets.map((t) => t.uid)).toEqual(['child-2', 'b']);
  });

  it('skips terminal siblings even when started after', () => {
    const decision = evaluateStrategy('rest_for_one', failed, [
      sib('child-2', 'Failed', '2026-05-04T10:00:00Z'),
      sib('completed-after', 'Completed', '2026-05-04T10:00:01Z'),
      sib('failed-after', 'Failed', '2026-05-04T10:00:02Z'),
      sib('alive-after', 'Dispatched', '2026-05-04T10:00:03Z'),
    ]);
    expect(decision.targets.map((t) => t.uid)).toEqual(['child-2', 'alive-after']);
  });

  it('falls back to one_for_one semantics when failed child is missing from snapshot', () => {
    // Informer-cache lag race: failed child not yet in the list.
    const decision = evaluateStrategy('rest_for_one', failed, [
      sib('a', 'Dispatched', '2026-05-04T10:00:00Z'),
      sib('b', 'Pending', '2026-05-04T10:00:01Z'),
    ]);
    expect(decision.action).toBe('terminate-and-restart-subset');
    expect(decision.targets.map((t) => t.uid)).toEqual(['child-2']);
    expect(decision.reason).toContain('informer lag');
  });

  it('preserves stable input order on tie (same startedAt)', () => {
    // Two siblings started at the same instant; ordering must come
    // from input order so tests are deterministic.
    const decision = evaluateStrategy('rest_for_one', failed, [
      sib('child-2', 'Failed', '2026-05-04T10:00:00Z'),
      sib('after-a', 'Dispatched', '2026-05-04T10:00:01Z'),
      sib('after-b', 'Dispatched', '2026-05-04T10:00:01Z'),
    ]);
    expect(decision.targets.map((t) => t.uid)).toEqual(['child-2', 'after-a', 'after-b']);
  });
});

describe('evaluateStrategy — escalate', () => {
  it('produces an escalate-to-parent action with only the failed child as target', () => {
    const decision = evaluateStrategy('escalate', failed, [
      sib('child-1', 'Dispatched'),
      sib('child-2', 'Failed'),
      sib('child-3', 'Dispatched'),
    ]);
    expect(decision.action).toBe('escalate-to-parent');
    expect(decision.targets).toHaveLength(1);
    expect(decision.targets[0]?.uid).toBe('child-2');
    expect(decision.reason).toContain('escalate');
  });

  it('emits the same shape regardless of sibling phases', () => {
    const decision = evaluateStrategy('escalate', failed, []);
    expect(decision.action).toBe('escalate-to-parent');
    expect(decision.targets).toEqual([failed.ref]);
  });
});

describe('evaluateStrategy — defensive paths', () => {
  it('every strategy returns a decision (no exceptions on unusual inputs)', () => {
    for (const s of ALL_SUPERVISION_STRATEGIES) {
      expect(() => evaluateStrategy(s, failed, [])).not.toThrow();
    }
  });

  it('unknown strategy falls back to one_for_one', () => {
    // Type-erased call mimics a malformed CR slipping past admission.
    const decision = evaluateStrategy(
      'totally-bogus' as unknown as SupervisionStrategy,
      failed,
      [],
    );
    expect(decision.action).toBe('restart');
  });

  it('decision.strategy echoes the input strategy', () => {
    for (const s of ALL_SUPERVISION_STRATEGIES) {
      const d = evaluateStrategy(s, failed, []);
      expect(d.strategy).toBe(s);
    }
  });

  it('decision.reason is non-empty + carries the failure reason', () => {
    for (const s of ALL_SUPERVISION_STRATEGIES) {
      const d = evaluateStrategy(s, failed, []);
      expect(d.reason.length).toBeGreaterThan(0);
      // escalate doesn't include the raw reason in the message because
      // the parent's strategy will re-classify; assert reason exists
      // either way.
      if (s !== 'escalate') {
        expect(d.reason).toContain(failed.reason);
      } else {
        expect(d.reason).toContain('escalate');
      }
    }
  });
});

describe('assertStrategyAllowed — cap-claim gating', () => {
  it('returns null when claims is undefined (ungated)', () => {
    expect(assertStrategyAllowed('one_for_all', undefined)).toBeNull();
  });

  it('returns null when claims has no supervisionStrategies allowlist', () => {
    expect(assertStrategyAllowed('one_for_all', { tools: ['*'] })).toBeNull();
  });

  it('returns null when strategy is in the allowlist', () => {
    const claims = {
      tools: [],
      supervisionStrategies: ['one_for_one', 'one_for_all'],
    } as unknown as Parameters<typeof assertStrategyAllowed>[1];
    expect(assertStrategyAllowed('one_for_all', claims)).toBeNull();
  });

  it('returns a denial reason when strategy is not in the allowlist', () => {
    const claims = {
      tools: [],
      supervisionStrategies: ['one_for_one'],
    } as unknown as Parameters<typeof assertStrategyAllowed>[1];
    const reason = assertStrategyAllowed('escalate', claims);
    expect(reason).not.toBeNull();
    expect(reason).toContain('escalate');
    expect(reason).toContain('one_for_one');
  });

  it('denies when the allowlist is empty', () => {
    const claims = {
      tools: [],
      supervisionStrategies: [],
    } as unknown as Parameters<typeof assertStrategyAllowed>[1];
    expect(assertStrategyAllowed('one_for_one', claims)).not.toBeNull();
  });
});
