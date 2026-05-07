/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/* Disable strict-typing of mock factories — vitest's vi.fn returns
   `Mock<any, any>` and threading the K8s client signatures through is
   more churn than payoff for this test surface. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import {
  resolveMaxRestarts,
  resolveStrategy,
  routeFailureForSupervision,
  type SupervisionRouterDeps,
} from './supervision-router.js';
import { PARENT_TASK_UID_LABEL } from './task-graph.js';

interface MockCustomApi {
  getNamespacedCustomObject: ReturnType<typeof vi.fn>;
  patchNamespacedCustomObjectStatus: ReturnType<typeof vi.fn>;
  listNamespacedCustomObject: ReturnType<typeof vi.fn>;
}

function makeAgent(overrides: Partial<Agent['spec']> = {}, name = 'parent-agent'): Agent {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Agent',
    metadata: { name, namespace: 'default', uid: 'agent-uid' },
    spec: { model: 'workers-ai/test', ...overrides },
  };
}

function makeTask(opts: {
  name: string;
  uid: string;
  parentUid?: string;
  phase?: AgentTask['status'] extends infer S ? (S extends { phase?: infer P } ? P : never) : never;
  reason?: string;
  conditions?: AgentTask['status'] extends infer S
    ? S extends { conditions?: infer C }
      ? C
      : never
    : never;
  startedAt?: string;
  restartCount?: number;
  targetAgent?: string;
  errorMessage?: string;
}): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name: opts.name,
      namespace: 'default',
      uid: opts.uid,
      labels: opts.parentUid !== undefined ? { [PARENT_TASK_UID_LABEL]: opts.parentUid } : {},
    },
    spec: {
      targetAgent: opts.targetAgent ?? 'parent-agent',
      payload: null,
    },
    status: {
      ...(opts.phase !== undefined && { phase: opts.phase }),
      ...(opts.errorMessage !== undefined && { error: opts.errorMessage }),
      ...(opts.startedAt !== undefined && { startedAt: opts.startedAt }),
      ...(opts.restartCount !== undefined && { restartCount: opts.restartCount }),
      ...(opts.conditions !== undefined && { conditions: opts.conditions }),
      ...(opts.reason !== undefined &&
        opts.conditions === undefined && {
          conditions: [
            {
              type: 'Failed',
              status: 'True' as const,
              reason: opts.reason,
              message: 'test reason',
              lastTransitionTime: '2026-05-04T00:00:00Z',
            },
          ],
        }),
    },
  };
}

function buildDeps(
  opts: {
    parent?: AgentTask;
    agent?: Agent;
    siblings?: readonly AgentTask[];
    customGet?: ReturnType<typeof vi.fn>;
    customList?: ReturnType<typeof vi.fn>;
    customPatch?: ReturnType<typeof vi.fn>;
  } = {},
): SupervisionRouterDeps & {
  mocks: { customApi: MockCustomApi; audit: Record<string, ReturnType<typeof vi.fn>> };
} {
  const parent = opts.parent;
  const agent = opts.agent ?? makeAgent();
  const siblings = opts.siblings ?? [];

  const customApi: MockCustomApi = {
    getNamespacedCustomObject:
      opts.customGet ??
      vi.fn().mockImplementation(({ plural, name }: { plural: string; name: string }) => {
        if (plural === 'agents' && name === agent.metadata.name) return agent;
        if (plural === 'agenttasks' && parent !== undefined && name === parent.metadata.name) {
          return parent;
        }
        return null;
      }),
    listNamespacedCustomObject:
      opts.customList ??
      vi.fn().mockImplementation(() => {
        const items: AgentTask[] = [];
        if (parent !== undefined) items.push(parent);
        for (const s of siblings) items.push(s);
        return { items };
      }),
    patchNamespacedCustomObjectStatus: opts.customPatch ?? vi.fn().mockResolvedValue({}),
  };

  const audit = {
    emitSupervisionApplied: vi.fn().mockResolvedValue(undefined),
    emitSupervisionRestartLimitExceeded: vi.fn().mockResolvedValue(undefined),
    emitInfraFault: vi.fn().mockResolvedValue(undefined),
  };

  return {
    customApi: customApi as unknown as SupervisionRouterDeps['customApi'],
    listChildrenForParent: () => siblings,
    audit,
    now: () => new Date('2026-05-04T12:00:00Z'),
    mocks: { customApi, audit },
  };
}

describe('resolveStrategy + resolveMaxRestarts', () => {
  it('default strategy is one_for_one when undeclared', () => {
    expect(resolveStrategy(makeAgent())).toBe('one_for_one');
  });

  it('returns the declared strategy when valid', () => {
    expect(resolveStrategy(makeAgent({ supervisionStrategy: 'one_for_all' }))).toBe('one_for_all');
    expect(resolveStrategy(makeAgent({ supervisionStrategy: 'rest_for_one' }))).toBe(
      'rest_for_one',
    );
    expect(resolveStrategy(makeAgent({ supervisionStrategy: 'escalate' }))).toBe('escalate');
  });

  it('falls back to one_for_one for unknown strategies (defensive)', () => {
    expect(resolveStrategy(makeAgent({ supervisionStrategy: 'nonsense' as never }))).toBe(
      'one_for_one',
    );
  });

  it('default maxRestarts is 3 when undeclared', () => {
    expect(resolveMaxRestarts(makeAgent())).toBe(3);
  });

  it('returns the declared maxRestarts when a non-negative integer', () => {
    expect(resolveMaxRestarts(makeAgent({ maxRestarts: 0 }))).toBe(0);
    expect(resolveMaxRestarts(makeAgent({ maxRestarts: 7 }))).toBe(7);
  });

  it('falls back to default for negative or non-integer maxRestarts', () => {
    expect(resolveMaxRestarts(makeAgent({ maxRestarts: -1 }))).toBe(3);
    expect(resolveMaxRestarts(makeAgent({ maxRestarts: 1.5 }))).toBe(3);
  });
});

describe('routeFailureForSupervision — gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-op when task is not in phase=Failed', async () => {
    const failed = makeTask({
      name: 'c',
      uid: 'cu',
      parentUid: 'pu',
      phase: 'Dispatched',
      reason: 'MissingRequiredOutputs',
    });
    const deps = buildDeps();
    const result = await routeFailureForSupervision(failed, deps);
    expect(result).toEqual({ kind: 'no-op', reason: 'phase-not-failed' });
    expect(deps.mocks.audit.emitSupervisionApplied).not.toHaveBeenCalled();
  });

  it('infra fault short-circuits with infra-fault-observed audit', async () => {
    const failed = makeTask({
      name: 'c',
      uid: 'cu',
      parentUid: 'pu',
      phase: 'Failed',
      reason: 'OOMKilled',
      errorMessage: 'pod cu OOMKilled',
    });
    const deps = buildDeps();
    const result = await routeFailureForSupervision(failed, deps);
    expect(result.kind).toBe('infra-fault-observed');
    expect(deps.mocks.audit.emitInfraFault).toHaveBeenCalledTimes(1);
    expect(deps.mocks.audit.emitSupervisionApplied).not.toHaveBeenCalled();
  });

  it('no-op for root task with no parent label', async () => {
    const failed = makeTask({
      name: 'root',
      uid: 'rootu',
      phase: 'Failed',
      reason: 'MissingRequiredOutputs',
    });
    const deps = buildDeps();
    const result = await routeFailureForSupervision(failed, deps);
    expect(result.kind).toBe('no-op');
  });
});

describe('routeFailureForSupervision — informer-cache fast path (M2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses deps.getTaskByUid for parent + uid lookups, skipping the LIST', async () => {
    const parent = makeTask({ name: 'p', uid: 'pu', phase: 'Dispatched' });
    const failed = makeTask({
      name: 'c',
      uid: 'cu',
      parentUid: 'pu',
      phase: 'Failed',
      reason: 'MissingRequiredOutputs',
      restartCount: 0,
    });
    const agent = makeAgent({ supervisionStrategy: 'one_for_one', maxRestarts: 3 });
    const deps = buildDeps({ parent, agent, siblings: [failed] });
    // Wire the informer-cache reader. It should serve BOTH the parent
    // fetch AND the per-target fetch (dispatchDecision) without any
    // LIST being issued.
    const cache = new Map<string, AgentTask>([
      ['pu', parent],
      ['cu', failed],
    ]);
    const depsWithCache: SupervisionRouterDeps = {
      ...deps,
      getTaskByUid: (uid: string) => cache.get(uid),
    };

    const result = await routeFailureForSupervision(failed, depsWithCache);
    expect(result.kind).toBe('applied');
    // Cache hit on both parent and target → no LIST call.
    expect(deps.mocks.customApi.listNamespacedCustomObject).not.toHaveBeenCalled();
    // restartCount patched as usual.
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalled();
  });

  it('falls back to LIST when getTaskByUid misses (cold cache)', async () => {
    const parent = makeTask({ name: 'p', uid: 'pu', phase: 'Dispatched' });
    const failed = makeTask({
      name: 'c',
      uid: 'cu',
      parentUid: 'pu',
      phase: 'Failed',
      reason: 'MissingRequiredOutputs',
      restartCount: 0,
    });
    const agent = makeAgent({ supervisionStrategy: 'one_for_one', maxRestarts: 3 });
    const deps = buildDeps({ parent, agent, siblings: [failed] });
    const depsWithCache: SupervisionRouterDeps = {
      ...deps,
      // Cache returns undefined for every UID (cold-start race).
      getTaskByUid: () => undefined,
    };

    const result = await routeFailureForSupervision(failed, depsWithCache);
    expect(result.kind).toBe('applied');
    // LIST fallback fires for both fetchParentTask + fetchTaskByUid.
    expect(deps.mocks.customApi.listNamespacedCustomObject).toHaveBeenCalled();
  });
});

describe('routeFailureForSupervision — one_for_one (default)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits supervision.applied and patches restartCount on the failed child', async () => {
    const parent = makeTask({ name: 'p', uid: 'pu', phase: 'Dispatched' });
    const failed = makeTask({
      name: 'c2',
      uid: 'c2u',
      parentUid: 'pu',
      phase: 'Failed',
      reason: 'MissingRequiredOutputs',
      restartCount: 0,
    });
    const sibling = makeTask({
      name: 'c1',
      uid: 'c1u',
      parentUid: 'pu',
      phase: 'Dispatched',
    });
    const agent = makeAgent({ supervisionStrategy: 'one_for_one', maxRestarts: 3 });
    const deps = buildDeps({
      parent,
      agent,
      siblings: [sibling, failed],
    });
    const result = await routeFailureForSupervision(failed, deps);
    expect(result.kind).toBe('applied');
    expect(deps.mocks.audit.emitSupervisionApplied).toHaveBeenCalledTimes(1);
    const audit = deps.mocks.audit.emitSupervisionApplied.mock.calls[0]?.[0] as {
      strategy: string;
      action: string;
      targets: readonly string[];
    };
    expect(audit.strategy).toBe('one_for_one');
    expect(audit.action).toBe('restart');
    expect(audit.targets).toEqual(['c2u']);
    // restartCount patched
    const patchCall = deps.mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls.find(
      (c) =>
        ((c[0] as { name: string }).name === 'c2' &&
          (c[0] as { body: { status: { restartCount?: number } } }).body.status.restartCount ===
            1) ??
        false,
    );
    expect(patchCall).toBeDefined();
  });
});

describe('routeFailureForSupervision — restart limit fail-closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT bump restartCount when restartCount+1 > maxRestarts; emits restart_limit_exceeded', async () => {
    const parent = makeTask({ name: 'p', uid: 'pu', phase: 'Dispatched' });
    const failed = makeTask({
      name: 'c',
      uid: 'cu',
      parentUid: 'pu',
      phase: 'Failed',
      reason: 'MissingRequiredOutputs',
      restartCount: 3, // already at cap
    });
    const agent = makeAgent({ supervisionStrategy: 'one_for_one', maxRestarts: 3 });
    const deps = buildDeps({ parent, agent, siblings: [failed] });
    const result = await routeFailureForSupervision(failed, deps);
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.restartLimitTripped).toEqual(['cu']);
    }
    expect(deps.mocks.audit.emitSupervisionRestartLimitExceeded).toHaveBeenCalledTimes(1);
    const audit = deps.mocks.audit.emitSupervisionRestartLimitExceeded.mock.calls[0]?.[0] as {
      restartCount: number;
      maxRestarts: number;
    };
    expect(audit.restartCount).toBe(4);
    expect(audit.maxRestarts).toBe(3);
    // No restartCount bump patch issued.
    const bumpCall = deps.mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls.find(
      (c) =>
        (c[0] as { body: { status: { restartCount?: number } } }).body.status.restartCount === 4,
    );
    expect(bumpCall).toBeUndefined();
  });

  it('maxRestarts=0 fails-closed on first failure (never restarts)', async () => {
    const parent = makeTask({ name: 'p', uid: 'pu' });
    const failed = makeTask({
      name: 'c',
      uid: 'cu',
      parentUid: 'pu',
      phase: 'Failed',
      reason: 'MissingRequiredOutputs',
      restartCount: 0,
    });
    const agent = makeAgent({ supervisionStrategy: 'one_for_one', maxRestarts: 0 });
    const deps = buildDeps({ parent, agent, siblings: [failed] });
    const result = await routeFailureForSupervision(failed, deps);
    expect(result.kind).toBe('applied');
    expect(deps.mocks.audit.emitSupervisionRestartLimitExceeded).toHaveBeenCalledTimes(1);
  });
});

describe('routeFailureForSupervision — one_for_all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks every in-flight sibling Failed with reason supervision_terminated', async () => {
    const parent = makeTask({ name: 'p', uid: 'pu' });
    const failed = makeTask({
      name: 'c2',
      uid: 'c2u',
      parentUid: 'pu',
      phase: 'Failed',
      reason: 'MissingRequiredOutputs',
    });
    const sib1 = makeTask({ name: 'c1', uid: 'c1u', parentUid: 'pu', phase: 'Dispatched' });
    const sib3 = makeTask({ name: 'c3', uid: 'c3u', parentUid: 'pu', phase: 'Pending' });
    const sib4 = makeTask({ name: 'c4', uid: 'c4u', parentUid: 'pu', phase: 'Completed' });
    const agent = makeAgent({ supervisionStrategy: 'one_for_all' });
    const deps = buildDeps({ parent, agent, siblings: [sib1, failed, sib3, sib4] });

    const result = await routeFailureForSupervision(failed, deps);
    expect(result.kind).toBe('applied');

    // c1 + c3 (in-flight) get supervision_terminated patches; c4
    // (Completed) is skipped; c2 (already Failed) is skipped.
    const terminationPatches = deps.mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls
      .filter(
        (c) =>
          (c[0] as { body: { status: { phase?: string } } }).body.status.phase === 'Failed' &&
          (c[0] as { body: { status: { error?: string } } }).body.status.error?.startsWith(
            'supervision_terminated',
          ),
      )
      .map((c) => (c[0] as { name: string }).name);
    expect(new Set(terminationPatches)).toEqual(new Set(['c1', 'c3']));
  });
});

describe('routeFailureForSupervision — rest_for_one', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('terminates only siblings started AFTER the failed child', async () => {
    const parent = makeTask({ name: 'p', uid: 'pu' });
    const before = makeTask({
      name: 'before',
      uid: 'beforeu',
      parentUid: 'pu',
      phase: 'Dispatched',
      startedAt: '2026-05-04T10:00:00Z',
    });
    const failed = makeTask({
      name: 'failed',
      uid: 'failedu',
      parentUid: 'pu',
      phase: 'Failed',
      reason: 'MissingRequiredOutputs',
      startedAt: '2026-05-04T10:00:01Z',
    });
    const after1 = makeTask({
      name: 'after1',
      uid: 'after1u',
      parentUid: 'pu',
      phase: 'Dispatched',
      startedAt: '2026-05-04T10:00:02Z',
    });
    const after2 = makeTask({
      name: 'after2',
      uid: 'after2u',
      parentUid: 'pu',
      phase: 'Pending',
      startedAt: '2026-05-04T10:00:03Z',
    });
    const agent = makeAgent({ supervisionStrategy: 'rest_for_one' });
    const deps = buildDeps({ parent, agent, siblings: [before, failed, after1, after2] });

    const result = await routeFailureForSupervision(failed, deps);
    expect(result.kind).toBe('applied');

    const terminations = deps.mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls
      .filter(
        (c) =>
          (c[0] as { body: { status: { error?: string } } }).body.status.error?.startsWith(
            'supervision_terminated',
          ) ?? false,
      )
      .map((c) => (c[0] as { name: string }).name);
    expect(new Set(terminations)).toEqual(new Set(['after1', 'after2']));
  });
});

describe('routeFailureForSupervision — escalate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('walks the parent chain when the strategy is escalate', async () => {
    // Three-level tree: grandparent → parent → child.
    // parent's strategy = escalate; grandparent's strategy = one_for_one.
    const grandparent = makeTask({ name: 'gp', uid: 'gpu', phase: 'Dispatched' });
    const parent = makeTask({
      name: 'p',
      uid: 'pu',
      parentUid: 'gpu',
      phase: 'Dispatched',
      targetAgent: 'parent-agent',
    });
    const failed = makeTask({
      name: 'c',
      uid: 'cu',
      parentUid: 'pu',
      phase: 'Failed',
      reason: 'MissingRequiredOutputs',
    });
    const parentAgent = makeAgent({ supervisionStrategy: 'escalate' }, 'parent-agent');
    const grandparentAgent = makeAgent(
      { supervisionStrategy: 'one_for_one', maxRestarts: 3 },
      'grandparent-agent',
    );

    const customGet = vi
      .fn()
      .mockImplementation(({ plural, name }: { plural: string; name: string }) => {
        if (plural === 'agents' && name === 'parent-agent') return parentAgent;
        if (plural === 'agents' && name === 'grandparent-agent') return grandparentAgent;
        if (plural === 'agenttasks' && name === 'p') return parent;
        if (plural === 'agenttasks' && name === 'gp') return grandparent;
        return null;
      });

    const customList = vi.fn().mockImplementation(() => ({
      items: [grandparent, parent, failed],
    }));

    // Set the parent's targetAgent so it resolves grandparentAgent
    // when we walk up. Because makeTask's default targetAgent is
    // 'parent-agent', we need to wire it differently.
    parent.spec = { ...parent.spec, targetAgent: 'parent-agent' } as typeof parent.spec;
    grandparent.spec = {
      ...grandparent.spec,
      targetAgent: 'grandparent-agent',
    } as typeof grandparent.spec;

    const deps = buildDeps({
      siblings: [parent, failed],
      customGet,
      customList,
    });
    const result = await routeFailureForSupervision(failed, deps);
    // Two emissions: parent (escalate) + grandparent (one_for_one /
    // restart of parent task).
    expect(deps.mocks.audit.emitSupervisionApplied.mock.calls.length).toBeGreaterThanOrEqual(2);
    // result is `applied` (the final non-escalate decision) — we
    // expect one_for_one restart of parent at the end.
    expect(['applied', 'escalated']).toContain(result.kind);
  });
});
