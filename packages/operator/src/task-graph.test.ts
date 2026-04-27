/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION, type AgentTask, type AgentTaskPhase } from './crds/index.js';
import {
  PARENT_TASK_NAME_LABEL,
  PARENT_TASK_UID_LABEL,
  aggregateChildren,
  buildChildTaskManifest,
  childRef,
  cycleCheck,
  parentTaskRefFromChild,
  type ChildTaskSpec,
} from './task-graph.js';

/* =====================================================================
 * Fixtures
 * ===================================================================== */

function makeParent(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    // overrides.metadata REPLACES the default — tests need to be able
    // to omit uid / name to exercise the missing-field branches.
    metadata: overrides.metadata ?? {
      name: 'parent-task',
      namespace: 'default',
      uid: 'parent-uid-1',
    },
    spec: {
      targetAgent: 'planner',
      payload: { topic: 'k3s' },
      originalUserMessage: 'plan a k3s upgrade',
      ...overrides.spec,
    },
    ...(overrides.status !== undefined && { status: overrides.status }),
  };
}

function makeChildTaskSpec(overrides: Partial<ChildTaskSpec> = {}): ChildTaskSpec {
  return {
    name: 'child-1',
    namespace: 'default',
    targetAgent: 'researcher',
    originalUserMessage: 'plan a k3s upgrade',
    payload: { subtask: 'fetch release notes' },
    ...overrides,
  };
}

function makeChild(
  uid: string,
  phase: AgentTaskPhase | undefined,
  parentUid = 'parent-uid-1',
  parentName = 'parent-task',
): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name: `child-${uid}`,
      namespace: 'default',
      uid,
      labels: {
        [PARENT_TASK_UID_LABEL]: parentUid,
        [PARENT_TASK_NAME_LABEL]: parentName,
      },
    },
    spec: {
      targetAgent: 'researcher',
      payload: {},
      parentTask: parentUid,
      originalUserMessage: 'plan a k3s upgrade',
    },
    ...(phase !== undefined && {
      status: {
        phase,
        ...(phase === 'Completed' || phase === 'Failed'
          ? { completedAt: '2026-04-26T12:00:00.000Z' }
          : {}),
        ...(phase === 'Failed' ? { error: 'boom' } : {}),
      },
    }),
  };
}

/* =====================================================================
 * buildChildTaskManifest
 * ===================================================================== */

describe('buildChildTaskManifest', () => {
  it('produces correct apiVersion + kind + namespace', () => {
    const parent = makeParent();
    const child = buildChildTaskManifest(parent, makeChildTaskSpec());
    expect(child.apiVersion).toBe(API_GROUP_VERSION);
    expect(child.kind).toBe('AgentTask');
    expect(child.metadata.namespace).toBe('default');
    expect(child.metadata.name).toBe('child-1');
  });

  it('attaches parent-task-uid + parent-task-name labels', () => {
    const parent = makeParent();
    const child = buildChildTaskManifest(parent, makeChildTaskSpec());
    expect(child.metadata.labels?.[PARENT_TASK_UID_LABEL]).toBe('parent-uid-1');
    expect(child.metadata.labels?.[PARENT_TASK_NAME_LABEL]).toBe('parent-task');
  });

  it('attaches a non-controller ownerReference back to the parent with blockOwnerDeletion=true', () => {
    const parent = makeParent();
    const child = buildChildTaskManifest(parent, makeChildTaskSpec());
    const refs = child.metadata.ownerReferences;
    expect(refs).toBeDefined();
    expect(refs).toHaveLength(1);
    const ref = refs![0];
    expect(ref.apiVersion).toBe(API_GROUP_VERSION);
    expect(ref.kind).toBe('AgentTask');
    expect(ref.name).toBe('parent-task');
    expect(ref.uid).toBe('parent-uid-1');
    // Per TASK-GRAPH.md §5 — the Job is the controller-owner, so the
    // parent-AgentTask ownerRef must be non-controller.
    expect(ref.controller).toBe(false);
    expect(ref.blockOwnerDeletion).toBe(true);
  });

  it('sets spec.parentTask = parent.metadata.uid', () => {
    const parent = makeParent();
    const child = buildChildTaskManifest(parent, makeChildTaskSpec());
    expect(child.spec.parentTask).toBe('parent-uid-1');
  });

  it('preserves all caller-supplied spec fields', () => {
    const parent = makeParent();
    const spec = makeChildTaskSpec({
      payload: { foo: 'bar', nested: { n: 1 } },
      originalUserMessage: 'hi',
      parentDistillation: 'fetch release notes',
      expectedTools: ['fetch_url', 'web_search'] as const,
      timeoutSeconds: 300,
    });
    const child = buildChildTaskManifest(parent, spec);
    expect(child.spec.payload).toEqual({ foo: 'bar', nested: { n: 1 } });
    expect(child.spec.originalUserMessage).toBe('hi');
    expect(child.spec.parentDistillation).toBe('fetch release notes');
    expect(child.spec.expectedTools).toEqual(['fetch_url', 'web_search']);
    expect(child.spec.timeoutSeconds).toBe(300);
  });

  it('emits targetAgent when only targetAgent is set', () => {
    const parent = makeParent();
    const child = buildChildTaskManifest(parent, makeChildTaskSpec({ targetAgent: 'researcher' }));
    expect(child.spec.targetAgent).toBe('researcher');
    expect(child.spec.targetCapability).toBeUndefined();
  });

  it('emits targetCapability when only targetCapability is set', () => {
    const parent = makeParent();
    const child = buildChildTaskManifest(
      parent,
      makeChildTaskSpec({
        targetAgent: undefined,
        targetCapability: 'web-research',
      }),
    );
    expect(child.spec.targetCapability).toBe('web-research');
    expect(child.spec.targetAgent).toBeUndefined();
  });

  it('throws when neither targetAgent nor targetCapability is set', () => {
    const parent = makeParent();
    expect(() =>
      buildChildTaskManifest(
        parent,
        makeChildTaskSpec({ targetAgent: undefined, targetCapability: undefined }),
      ),
    ).toThrow(/exactly one of \{targetAgent, targetCapability\}/);
  });

  it('throws when both targetAgent AND targetCapability are set', () => {
    const parent = makeParent();
    expect(() =>
      buildChildTaskManifest(
        parent,
        makeChildTaskSpec({ targetAgent: 'researcher', targetCapability: 'web-research' }),
      ),
    ).toThrow(/not both/);
  });

  it('throws when parent metadata.uid is missing', () => {
    const parent = makeParent({ metadata: { name: 'parent-task', namespace: 'default' } });
    expect(() => buildChildTaskManifest(parent, makeChildTaskSpec())).toThrow(
      /missing metadata.uid/,
    );
  });

  it('throws when parent metadata.name is missing', () => {
    const parent = makeParent({
      metadata: { namespace: 'default', uid: 'parent-uid-1' },
    });
    expect(() => buildChildTaskManifest(parent, makeChildTaskSpec())).toThrow(
      /missing metadata.name/,
    );
  });

  it('throws when child namespace differs from parent namespace', () => {
    const parent = makeParent();
    expect(() => buildChildTaskManifest(parent, makeChildTaskSpec({ namespace: 'other' }))).toThrow(
      /must equal parent namespace/,
    );
  });

  it('inherits parent namespace via the equality check (parent in non-default ns)', () => {
    const parent = makeParent({
      metadata: { name: 'parent-task', namespace: 'team-a', uid: 'parent-uid-1' },
    });
    const child = buildChildTaskManifest(parent, makeChildTaskSpec({ namespace: 'team-a' }));
    expect(child.metadata.namespace).toBe('team-a');
  });
});

/* =====================================================================
 * childRef
 * ===================================================================== */

describe('childRef', () => {
  it('maps a Pending child', () => {
    const ref = childRef(makeChild('c1', 'Pending'));
    expect(ref).toEqual({
      name: 'child-c1',
      namespace: 'default',
      uid: 'c1',
      phase: 'Pending',
    });
  });

  it('maps a Dispatched child', () => {
    const ref = childRef(makeChild('c1', 'Dispatched'));
    expect(ref.phase).toBe('Dispatched');
    expect(ref.completedAt).toBeUndefined();
    expect(ref.error).toBeUndefined();
  });

  it('maps a Completed child with completedAt', () => {
    const ref = childRef(makeChild('c1', 'Completed'));
    expect(ref.phase).toBe('Completed');
    expect(ref.completedAt).toBe('2026-04-26T12:00:00.000Z');
    expect(ref.error).toBeUndefined();
  });

  it('maps a Failed child with completedAt + error', () => {
    const ref = childRef(makeChild('c1', 'Failed'));
    expect(ref.phase).toBe('Failed');
    expect(ref.completedAt).toBe('2026-04-26T12:00:00.000Z');
    expect(ref.error).toBe('boom');
  });

  it('omits optional fields when status is absent', () => {
    const ref = childRef(makeChild('c1', undefined));
    expect(ref.phase).toBeUndefined();
    expect(ref.completedAt).toBeUndefined();
    expect(ref.error).toBeUndefined();
    expect(ref.uid).toBe('c1');
  });
});

/* =====================================================================
 * parentTaskRefFromChild
 * ===================================================================== */

describe('parentTaskRefFromChild', () => {
  it('returns null when parent labels are missing', () => {
    const child: AgentTask = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: { name: 'orphan', namespace: 'default', uid: 'o-uid' },
      spec: { targetAgent: 'x', payload: {}, originalUserMessage: 'hi' },
    };
    expect(parentTaskRefFromChild(child)).toBeNull();
  });

  it('returns null when parent-name label is empty', () => {
    const child: AgentTask = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: {
        name: 'c1',
        namespace: 'default',
        uid: 'c-uid',
        labels: { [PARENT_TASK_NAME_LABEL]: '', [PARENT_TASK_UID_LABEL]: 'p-uid' },
      },
      spec: { targetAgent: 'x', payload: {}, originalUserMessage: 'hi' },
    };
    expect(parentTaskRefFromChild(child)).toBeNull();
  });

  it('returns parent ref with uid when both labels present', () => {
    const ref = parentTaskRefFromChild(makeChild('c1', 'Pending'));
    expect(ref).toEqual({
      name: 'parent-task',
      namespace: 'default',
      uid: 'parent-uid-1',
    });
  });

  it('returns parent ref without uid when only name label present', () => {
    const child: AgentTask = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: {
        name: 'c1',
        namespace: 'team-a',
        uid: 'c-uid',
        labels: { [PARENT_TASK_NAME_LABEL]: 'parent-task' },
      },
      spec: { targetAgent: 'x', payload: {}, originalUserMessage: 'hi' },
    };
    expect(parentTaskRefFromChild(child)).toEqual({
      name: 'parent-task',
      namespace: 'team-a',
    });
  });

  it('round-trips through buildChildTaskManifest', () => {
    const parent = makeParent({
      metadata: { name: 'rt-parent', namespace: 'team-b', uid: 'rt-uid' },
    });
    const built = buildChildTaskManifest(
      parent,
      makeChildTaskSpec({ namespace: 'team-b', name: 'rt-child' }),
    );
    const ref = parentTaskRefFromChild(built);
    expect(ref).toEqual({
      name: 'rt-parent',
      namespace: 'team-b',
      uid: 'rt-uid',
    });
  });
});

/* =====================================================================
 * aggregateChildren — full truth-table coverage.
 * ===================================================================== */

describe('aggregateChildren', () => {
  it('returns Pending for an empty list', () => {
    const result = aggregateChildren([]);
    expect(result.aggregatePhase).toBe('Pending');
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.inFlightCount).toBe(0);
    expect(result.children).toEqual([]);
  });

  it('returns Dispatched when all children are Pending', () => {
    const result = aggregateChildren([makeChild('a', 'Pending'), makeChild('b', 'Pending')]);
    expect(result.aggregatePhase).toBe('Dispatched');
    expect(result.inFlightCount).toBe(2);
  });

  it('returns Dispatched when all children are Dispatched', () => {
    const result = aggregateChildren([makeChild('a', 'Dispatched'), makeChild('b', 'Dispatched')]);
    expect(result.aggregatePhase).toBe('Dispatched');
    expect(result.inFlightCount).toBe(2);
  });

  it('returns Dispatched for a mix of Pending + Dispatched (no terminals)', () => {
    const result = aggregateChildren([makeChild('a', 'Pending'), makeChild('b', 'Dispatched')]);
    expect(result.aggregatePhase).toBe('Dispatched');
    expect(result.inFlightCount).toBe(2);
  });

  it('returns AllComplete when every child is Completed', () => {
    const result = aggregateChildren([
      makeChild('a', 'Completed'),
      makeChild('b', 'Completed'),
      makeChild('c', 'Completed'),
    ]);
    expect(result.aggregatePhase).toBe('AllComplete');
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(0);
    expect(result.inFlightCount).toBe(0);
  });

  it('returns AnyFailed when any child Failed (even one)', () => {
    const result = aggregateChildren([
      makeChild('a', 'Completed'),
      makeChild('b', 'Failed'),
      makeChild('c', 'Completed'),
    ]);
    expect(result.aggregatePhase).toBe('AnyFailed');
    expect(result.failureCount).toBe(1);
    expect(result.successCount).toBe(2);
  });

  it('returns AnyFailed even when other children are still in flight (cancellationPolicy=propagate fast-fail)', () => {
    const result = aggregateChildren([
      makeChild('a', 'Failed'),
      makeChild('b', 'Pending'),
      makeChild('c', 'Dispatched'),
    ]);
    expect(result.aggregatePhase).toBe('AnyFailed');
    expect(result.failureCount).toBe(1);
    expect(result.inFlightCount).toBe(2);
  });

  it('returns PartiallyComplete when some Completed + some still in flight (no failures)', () => {
    const result = aggregateChildren([
      makeChild('a', 'Completed'),
      makeChild('b', 'Dispatched'),
      makeChild('c', 'Pending'),
    ]);
    expect(result.aggregatePhase).toBe('PartiallyComplete');
    expect(result.successCount).toBe(1);
    expect(result.inFlightCount).toBe(2);
  });

  it('counts a child without status.phase as in-flight', () => {
    const result = aggregateChildren([makeChild('a', undefined)]);
    expect(result.inFlightCount).toBe(1);
    expect(result.aggregatePhase).toBe('Dispatched');
  });

  it('is order-independent (same set of phases → same result regardless of order)', () => {
    // Manual property check — every permutation of a representative
    // multi-phase fixture must produce identical counts + aggregatePhase.
    const phases: AgentTaskPhase[] = ['Completed', 'Failed', 'Pending', 'Dispatched'];
    const baseChildren = phases.map((p, i) => makeChild(`c${i}`, p));
    const baseline = aggregateChildren(baseChildren);

    // Reverse order.
    const reversed = aggregateChildren([...baseChildren].reverse());
    expect(reversed.aggregatePhase).toBe(baseline.aggregatePhase);
    expect(reversed.successCount).toBe(baseline.successCount);
    expect(reversed.failureCount).toBe(baseline.failureCount);
    expect(reversed.inFlightCount).toBe(baseline.inFlightCount);

    // Shuffled order (deterministic permutation).
    const shuffled = [baseChildren[2], baseChildren[0], baseChildren[3], baseChildren[1]];
    const shuffledResult = aggregateChildren(shuffled);
    expect(shuffledResult.aggregatePhase).toBe(baseline.aggregatePhase);
    expect(shuffledResult.successCount).toBe(baseline.successCount);
    expect(shuffledResult.failureCount).toBe(baseline.failureCount);
    expect(shuffledResult.inFlightCount).toBe(baseline.inFlightCount);
  });

  it('order-independent across all 24 permutations of 4 distinct phases', () => {
    const phases: AgentTaskPhase[] = ['Completed', 'Failed', 'Pending', 'Dispatched'];
    const children = phases.map((p, i) => makeChild(`c${i}`, p));

    function permutations<T>(arr: readonly T[]): T[][] {
      if (arr.length <= 1) return [arr.slice()];
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const tail of permutations(rest)) {
          out.push([arr[i], ...tail]);
        }
      }
      return out;
    }

    const baseline = aggregateChildren(children);
    const perms = permutations(children);
    expect(perms).toHaveLength(24);
    for (const perm of perms) {
      const result = aggregateChildren(perm);
      expect(result.aggregatePhase).toBe(baseline.aggregatePhase);
      expect(result.successCount).toBe(baseline.successCount);
      expect(result.failureCount).toBe(baseline.failureCount);
      expect(result.inFlightCount).toBe(baseline.inFlightCount);
    }
  });
});

/* =====================================================================
 * cycleCheck
 * ===================================================================== */

describe('cycleCheck', () => {
  /** Build a fake parent-lookup over a fixed graph keyed by uid. */
  function lookup(graph: Record<string, AgentTask>): (uid: string) => AgentTask | undefined {
    return (uid) => graph[uid];
  }

  it('rejects self-as-child (single-node cycle)', () => {
    const result = cycleCheck('a', 'a', () => undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cycle).toEqual(['a', 'a']);
    }
  });

  it('rejects multi-hop cycle (candidate is ancestor 2 hops up)', () => {
    // Chain: a -> b -> c. Trying to add c as a child of a would close a cycle.
    const graph: Record<string, AgentTask> = {
      a: makeChild('a', undefined, 'b'),
      b: makeChild('b', undefined, 'c'),
      c: makeChild('c', undefined, ''),
    };
    const result = cycleCheck('a', 'c', lookup(graph));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cycle).toEqual(['a', 'b', 'c']);
    }
  });

  it('rejects deep cycle (candidate is the chain root)', () => {
    // Chain: a -> b -> c -> d. Trying to add d as child of a is a cycle.
    const graph: Record<string, AgentTask> = {
      a: makeChild('a', undefined, 'b'),
      b: makeChild('b', undefined, 'c'),
      c: makeChild('c', undefined, 'd'),
      d: makeChild('d', undefined, ''),
    };
    const result = cycleCheck('a', 'd', lookup(graph));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cycle).toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('accepts legitimate fan-out (candidate is unrelated)', () => {
    // Chain: a -> b. Adding x (unrelated) as child of a is fine.
    const graph: Record<string, AgentTask> = {
      a: makeChild('a', undefined, 'b'),
      b: makeChild('b', undefined, ''),
    };
    const result = cycleCheck('a', 'x', lookup(graph));
    expect(result.ok).toBe(true);
  });

  it('accepts when parent has no parentTask (root node fan-out)', () => {
    const graph: Record<string, AgentTask> = {
      root: makeChild('root', undefined, ''),
    };
    const result = cycleCheck('root', 'newchild', lookup(graph));
    expect(result.ok).toBe(true);
  });

  it('treats missing-parent (chain has GC-d ancestor) as no cycle', () => {
    // a's parentTask points to "b", but b is not in the graph (lookup
    // returns undefined). Should accept rather than reject.
    const graph: Record<string, AgentTask> = {
      a: makeChild('a', undefined, 'b'),
    };
    const result = cycleCheck('a', 'newchild', lookup(graph));
    expect(result.ok).toBe(true);
  });

  it('accepts when getParent returns undefined for the parent itself', () => {
    // No graph entries at all — parentUid is itself unknown. No cycle possible.
    const result = cycleCheck('a', 'b', () => undefined);
    expect(result.ok).toBe(true);
  });

  it('terminates safely when the existing graph already contains a loop', () => {
    // Pre-existing corrupt graph: a -> b -> a. Should terminate, not spin.
    const graph: Record<string, AgentTask> = {
      a: makeChild('a', undefined, 'b'),
      b: makeChild('b', undefined, 'a'),
    };
    const result = cycleCheck('a', 'newchild', lookup(graph));
    // The pre-existing loop is its own bug; this edge introduces no cycle
    // with `newchild`. Helper bails safely rather than infinite-looping.
    expect(result.ok).toBe(true);
  });
});
