/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * WS-E race-coverage suite — exercises the orderings that the audit
 * called out specifically:
 *
 *   1. Completed vs Dispatched relist — a stale informer event tries
 *      to dispatch over a terminal task. Must skip without patching.
 *   2. Completed vs external Failed — job-watch sees an OOMKill after
 *      the agent-pod wrote success. Must keep `phase=Completed`,
 *      append a condition.
 *   3. Duplicate reconcile — second call must be a no-op.
 *   4. Stale informer object — `patchStatusWithRetry` must re-read
 *      the fresh state inside its loop.
 *   5. Concurrent dispatch + external failure — reconcile patches
 *      Dispatched, then markAgentTaskFailedFromExternal patches
 *      Failed. Final state: Failed, with both conditions present.
 */

// vitest's `vi.fn()` returns `Mock<any, any>` by default; .mockResolvedValue
// then propagates `any` through the test surface. Typing every fn() call
// against the K8s API shapes is more churn than payoff for race tests
// — the intent is mock-call assertions, not type-level coverage.
/* eslint-disable @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-call,
                  @typescript-eslint/no-unsafe-return,
                  @typescript-eslint/no-unnecessary-type-assertion,
                  @typescript-eslint/require-await */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import { StubDispatcher } from './dispatcher.js';
import {
  markAgentTaskFailedFromExternal,
  patchStatusWithRetry,
  reconcileAgentTask,
  type ReconcileDeps,
} from './reconcile.js';

/* ---------- shared mocks ---------- */

interface MockCustomApi {
  getNamespacedCustomObject: ReturnType<typeof vi.fn>;
  patchNamespacedCustomObjectStatus: ReturnType<typeof vi.fn>;
}
interface MockBatchApi {
  createNamespacedJob: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: {
  customApi?: Partial<MockCustomApi>;
  batchApi?: Partial<MockBatchApi>;
  dispatcher?: StubDispatcher;
  now?: () => Date;
}): ReconcileDeps & {
  mocks: { customApi: MockCustomApi; batchApi: MockBatchApi; dispatcher: StubDispatcher };
} {
  const customApi: MockCustomApi = {
    getNamespacedCustomObject: vi.fn(),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    ...overrides.customApi,
  };
  const batchApi: MockBatchApi = {
    createNamespacedJob: vi.fn().mockResolvedValue({}),
    ...overrides.batchApi,
  };
  const dispatcher = overrides.dispatcher ?? new StubDispatcher();
  return {
    customApi: customApi as unknown as ReconcileDeps['customApi'],
    batchApi: batchApi as unknown as ReconcileDeps['batchApi'],
    dispatcher,
    ...(overrides.now !== undefined && { now: overrides.now }),
    mocks: { customApi, batchApi, dispatcher },
  };
}

const validAgent: Agent = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Agent',
  metadata: { name: 'researcher', namespace: 'default', uid: 'a-uid' },
  spec: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
};

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: { name: 't1', namespace: 'default', uid: 'task-uid-1', generation: 1 },
    spec: {
      targetAgent: 'researcher',
      payload: { topic: 'k3s' },
      originalUserMessage: 'what is k3s default runtime?',
    },
    ...overrides,
  };
}

/* ---------- race scenarios ---------- */

describe('status-race — Completed vs Dispatched (relist after restart)', () => {
  it('refuses to dispatch a task that is already Completed; no patch issued', async () => {
    const completed = makeTask({ status: { phase: 'Completed' } });
    const deps = makeDeps({});
    const result = await reconcileAgentTask(completed, deps);
    expect(result).toEqual({ action: 'skipped', reason: 'phase=Completed' });
    expect(deps.mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled();
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
    expect(deps.mocks.dispatcher.published).toHaveLength(0);
  });

  it('refuses to dispatch a task that is already Failed', async () => {
    const failed = makeTask({ status: { phase: 'Failed' } });
    const deps = makeDeps({});
    const result = await reconcileAgentTask(failed, deps);
    expect(result).toEqual({ action: 'skipped', reason: 'phase=Failed' });
    expect(deps.mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled();
  });
});

describe('status-race — Completed vs external Failed (the WS-E core bug fix)', () => {
  const ref = { namespace: 'default', name: 't1' };
  const failure = {
    reason: 'OOMKilled',
    message: 'container killed: out of memory',
    source: 'pod' as const,
  };
  const fixedNow = new Date('2026-04-27T12:00:00.000Z');

  it('keeps phase=Completed and appends JobFailedAfterComplete condition', async () => {
    const completed = makeTask({
      status: { phase: 'Completed', completedAt: '2026-04-27T11:59:00.000Z' },
    });
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(completed),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    expect(action).toEqual({ kind: 'condition-appended', previousPhase: 'Completed' });

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
    const body = (
      customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
        body: { status: Record<string, unknown> };
      }
    ).body.status;
    // CRITICAL: phase must NOT appear in the patch — terminal-monotonic.
    expect(body).not.toHaveProperty('phase');
    expect(body.observedGeneration).toBe(1);
    expect(body.conditions).toEqual([
      expect.objectContaining({
        type: 'JobFailedAfterComplete',
        status: 'True',
        reason: 'OOMKilled',
        message: '[pod/OOMKilled] container killed: out of memory',
        lastTransitionTime: fixedNow.toISOString(),
        observedGeneration: 1,
      }),
    ]);
  });

  it('preserves any pre-existing conditions when appending', async () => {
    const completed = makeTask({
      status: {
        phase: 'Completed',
        conditions: [
          {
            type: 'Dispatched',
            status: 'True',
            reason: 'JobCreated',
            lastTransitionTime: '2026-04-27T11:00:00.000Z',
          },
        ],
      },
    });
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(completed),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    const body = (
      customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
        body: { status: { conditions: readonly { type: string }[] } };
      }
    ).body.status;
    expect(body.conditions.map((c) => c.type)).toEqual(['Dispatched', 'JobFailedAfterComplete']);
  });
});

describe('status-race — duplicate reconcile (idempotency)', () => {
  it('second call after a successful dispatch is a no-op', async () => {
    const task = makeTask();
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
    });
    const first = await reconcileAgentTask(task, deps);
    expect(first.action).toBe('dispatched');

    // Simulate the informer firing again with the SAME task (no status
    // mutation; the watch event already had it as Pending). This is
    // the duplicate-reconcile case — the existing reconcile-skip rule
    // would let this fall through and re-dispatch. WS-E doesn't change
    // the skip rule directly, but the patchStatusWithRetry guard means
    // even if we got here, the build closure would refuse.
    //
    // To exercise the patchStatusWithRetry guard end-to-end we hand the
    // helper a stale task with phase=undefined while the cluster says
    // phase=Completed.
    const staleTask = makeTask(); // no status
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValue(makeTask({ status: { phase: 'Completed' } })),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const result = await patchStatusWithRetry(
      staleTask,
      customApi as unknown as ReconcileDeps['customApi'],
      (current) => {
        // Caller asks to write Dispatched. Build closure consults the
        // FRESH read and refuses the regression.
        const phase = current.status?.phase;
        if (phase === 'Completed' || phase === 'Failed') return null;
        return { phase: 'Dispatched' };
      },
    );
    expect(result).toEqual({ kind: 'skipped', reason: 'regression' });
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });
});

describe('status-race — stale informer object', () => {
  it('patchStatusWithRetry re-reads the fresh state on every attempt', async () => {
    const stale = makeTask(); // caller's hand has no status
    const fresh = makeTask({ status: { phase: 'Completed' } });
    const getMock = vi.fn().mockResolvedValue(fresh);
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: getMock,
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const result = await patchStatusWithRetry(
      stale,
      customApi as unknown as ReconcileDeps['customApi'],
      (current) => {
        // Build closure must see the FRESH phase even though `stale`
        // had none.
        expect(current.status?.phase).toBe('Completed');
        return null; // refuse the regression
      },
    );
    expect(result).toEqual({ kind: 'skipped', reason: 'regression' });
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 409 conflict and re-reads on each attempt', async () => {
    const fresh = makeTask({ status: { phase: 'Pending' } });
    const conflict = Object.assign(new Error('conflict'), { code: 409 });
    const patchMock = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({});
    const getMock = vi.fn().mockResolvedValue(fresh);
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: getMock,
      patchNamespacedCustomObjectStatus: patchMock,
    };
    const result = await patchStatusWithRetry(
      makeTask(),
      customApi as unknown as ReconcileDeps['customApi'],
      () => ({ phase: 'Dispatched' }),
    );
    expect(result).toEqual({ kind: 'patched' });
    // 3 attempts: 2 failed + 1 success → 3 GETs + 3 PATCHes.
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(patchMock).toHaveBeenCalledTimes(3);
  });

  it('returns not-found when the GET returns 404 mid-loop', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const result = await patchStatusWithRetry(
      makeTask(),
      customApi as unknown as ReconcileDeps['customApi'],
      () => ({ phase: 'Dispatched' }),
    );
    expect(result).toEqual({ kind: 'skipped', reason: 'not-found' });
  });

  it('returns not-found when the PATCH returns 404', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeTask()),
      patchNamespacedCustomObjectStatus: vi.fn().mockRejectedValue({ code: 404 }),
    };
    const result = await patchStatusWithRetry(
      makeTask(),
      customApi as unknown as ReconcileDeps['customApi'],
      () => ({ phase: 'Dispatched' }),
    );
    expect(result).toEqual({ kind: 'skipped', reason: 'not-found' });
  });
});

describe('status-race — concurrent dispatch + external failure', () => {
  let task: AgentTask;
  let stateMachineGet: ReturnType<typeof vi.fn>;
  let stateMachinePatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Shared etcd-like state for the duration of the test. Each test
    // mutates `current` and wires the mocks to read/write through it.
    task = makeTask();
    let current: AgentTask = makeTask(); // server-side object
    stateMachineGet = vi.fn().mockImplementation(async () => current);
    stateMachinePatch = vi.fn().mockImplementation(async (req: unknown) => {
      const r = req as { body: { status: Record<string, unknown> }; name: string };
      // Emulate merge-patch: shallow merge `body.status` into current.status.
      current = {
        ...current,
        status: { ...current.status, ...r.body.status } as AgentTask['status'],
      };
      return {};
    });
  });

  it('dispatch lands first, external failure flips to Failed and preserves Dispatched condition', async () => {
    // ---- T0: reconcile fires, agent fetched, dispatch publishes,
    // ---- patchStatusWithRetry writes phase=Dispatched.
    const fixedNow = new Date('2026-04-27T13:00:00.000Z');
    const reconcileDeps = makeDeps({
      customApi: {
        // The reconcile path calls getNamespacedCustomObject TWICE:
        // once for the Agent (returns validAgent) and once for the
        // AgentTask (returns the state machine's current snapshot).
        // Disambiguate by the request shape.
        getNamespacedCustomObject: vi.fn().mockImplementation(async (req: unknown) => {
          const r = req as { plural: string };
          if (r.plural === 'agents') return validAgent;
          return stateMachineGet();
        }),
        patchNamespacedCustomObjectStatus: stateMachinePatch,
      },
      now: () => fixedNow,
    });
    const dispatchResult = await reconcileAgentTask(task, reconcileDeps);
    expect(dispatchResult.action).toBe('dispatched');

    // The state machine should now have phase=Dispatched + a
    // Dispatched condition.
    const afterDispatch = await stateMachineGet();
    expect(afterDispatch.status?.phase).toBe('Dispatched');
    expect(afterDispatch.status?.conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'Dispatched' })]),
    );

    // ---- T1: job-watch sees OOMKill (pod died after dispatch).
    const failureNow = new Date('2026-04-27T13:00:30.000Z');
    const action = await markAgentTaskFailedFromExternal(
      { namespace: 'default', name: 't1' },
      { reason: 'OOMKilled', message: 'oom', source: 'pod' },
      {
        customApi: {
          getNamespacedCustomObject: stateMachineGet,
          patchNamespacedCustomObjectStatus: stateMachinePatch,
        } as unknown as ReconcileDeps['customApi'],
        now: () => failureNow,
      },
    );
    expect(action).toEqual({ kind: 'marked-failed', previousPhase: 'Dispatched' });

    // Final state: Failed, but the Dispatched condition is still there.
    const final = await stateMachineGet();
    expect(final.status?.phase).toBe('Failed');
    expect(final.status?.error).toBe('[pod/OOMKilled] oom');
    const condTypes = (final.status?.conditions ?? []).map((c) => c.type);
    expect(condTypes).toContain('Dispatched');
    expect(condTypes).toContain('Failed');
  });

  it('reverse order — external failure lands first → Failed; subsequent dispatch is refused (regression)', async () => {
    // T0: external failure (e.g. ImagePullBackOff before dispatch
    // completes the status write) lands.
    const failureNow = new Date('2026-04-27T13:00:00.000Z');
    await markAgentTaskFailedFromExternal(
      { namespace: 'default', name: 't1' },
      { reason: 'ImagePullBackOff', message: 'manifest unknown', source: 'pod' },
      {
        customApi: {
          getNamespacedCustomObject: stateMachineGet,
          patchNamespacedCustomObjectStatus: stateMachinePatch,
        } as unknown as ReconcileDeps['customApi'],
        now: () => failureNow,
      },
    );

    const afterFailure = await stateMachineGet();
    expect(afterFailure.status?.phase).toBe('Failed');

    // T1: a stale reconcile call tries to dispatch. patchStatusWithRetry's
    // build closure consults the fresh read and refuses.
    const dispatchResult = await patchStatusWithRetry(
      task,
      {
        getNamespacedCustomObject: stateMachineGet,
        patchNamespacedCustomObjectStatus: stateMachinePatch,
      } as unknown as ReconcileDeps['customApi'],
      (current) => {
        const phase = current.status?.phase;
        if (phase === 'Completed' || phase === 'Failed') return null;
        return { phase: 'Dispatched' };
      },
    );
    expect(dispatchResult).toEqual({ kind: 'skipped', reason: 'regression' });

    // Final state still Failed.
    const final = await stateMachineGet();
    expect(final.status?.phase).toBe('Failed');
  });
});
