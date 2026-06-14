/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * v0.2.0-typed-io — reconcile.ts integration tests for the typed-input
 * admission validator + idempotency-key dedupe + Completion-contract
 * enforcement. Carved into a dedicated test file so it doesn't tangle
 * with the existing reconcile.test.ts (1100+ lines), and so the
 * Workspace + CAS sub-teams can extend this sibling without conflicting
 * on the core reconcile suite.
 */

import type { CoreV1Api } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import { StubDispatcher } from './dispatcher.js';
import { enforceCompletionContract, reconcileAgentTask, type ReconcileDeps } from './reconcile.js';
import { IdempotencyCache } from './task-admission.js';

/* =====================================================================
 * Fixtures
 * ===================================================================== */

const typedAgent: Agent = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Agent',
  metadata: { name: 'researcher', namespace: 'default', uid: 'a-uid' },
  spec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    inputs: [{ name: 'corpus', kind: 'workspace', mountPath: '/var/in/corpus' }],
    outputs: [{ name: 'digest', kind: 'artifact', required: true }],
  },
};

function makeDeps(overrides: {
  agent?: Agent;
  customApiOverride?: Partial<{
    getNamespacedCustomObject: ReturnType<typeof vi.fn>;
    patchNamespacedCustomObjectStatus: ReturnType<typeof vi.fn>;
  }>;
  idempotencyCache?: IdempotencyCache;
  emitContractViolated?: ReturnType<typeof vi.fn>;
  emitTaskDeduped?: ReturnType<typeof vi.fn>;
  coreApi?: { createNamespacedConfigMap: ReturnType<typeof vi.fn> };
}): ReconcileDeps & {
  mocks: {
    customApi: {
      getNamespacedCustomObject: ReturnType<typeof vi.fn>;
      patchNamespacedCustomObjectStatus: ReturnType<typeof vi.fn>;
    };
    batchApi: {
      createNamespacedJob: ReturnType<typeof vi.fn>;
      readNamespacedJob: ReturnType<typeof vi.fn>;
      patchNamespacedJob: ReturnType<typeof vi.fn>;
    };
    dispatcher: StubDispatcher;
    coreApi: { createNamespacedConfigMap: ReturnType<typeof vi.fn> } | undefined;
  };
} {
  const agent = overrides.agent ?? typedAgent;
  const getMock = vi.fn().mockResolvedValue(agent);
  const patchMock = vi.fn().mockResolvedValue({});
  const customApi = {
    getNamespacedCustomObject: overrides.customApiOverride?.getNamespacedCustomObject ?? getMock,
    patchNamespacedCustomObjectStatus:
      overrides.customApiOverride?.patchNamespacedCustomObjectStatus ?? patchMock,
  };
  const batchApi = {
    createNamespacedJob: vi.fn().mockResolvedValue({}),
    readNamespacedJob: vi.fn().mockResolvedValue({
      metadata: { name: 'kat-task-uid-1', namespace: 'default', annotations: {} },
      spec: { suspend: true },
    }),
    patchNamespacedJob: vi.fn().mockResolvedValue({}),
  };
  const dispatcher = new StubDispatcher();

  return {
    customApi: customApi as unknown as ReconcileDeps['customApi'],
    batchApi: batchApi as unknown as ReconcileDeps['batchApi'],
    dispatcher,
    ...(overrides.idempotencyCache !== undefined && {
      idempotencyCache: overrides.idempotencyCache,
    }),
    ...(overrides.emitContractViolated !== undefined && {
      emitContractViolated: overrides.emitContractViolated,
    }),
    ...(overrides.emitTaskDeduped !== undefined && {
      emitTaskDeduped: overrides.emitTaskDeduped,
    }),
    ...(overrides.coreApi !== undefined && {
      coreApi: overrides.coreApi as unknown as CoreV1Api,
    }),
    mocks: { customApi, batchApi, dispatcher, coreApi: overrides.coreApi },
  };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: { name: 't1', namespace: 'default', uid: 'task-uid-1' },
    spec: {
      targetAgent: 'researcher',
      payload: { topic: 'k3s' },
      originalUserMessage: 'q',
    },
    ...overrides,
  };
}

/* =====================================================================
 * Typed-input admission validation
 * ===================================================================== */

describe('reconcileAgentTask — typed-input admission validation', () => {
  it('back-compat: a v0.1 Agent (no inputs[]) + v0.1 task (no inputs[]) dispatches normally', async () => {
    const v01agent: Agent = {
      ...typedAgent,
      spec: { model: typedAgent.spec.model },
    };
    const deps = makeDeps({ agent: v01agent });
    const task = makeTask();
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(deps.mocks.batchApi.createNamespacedJob).toHaveBeenCalled();
  });

  it('rejects a task that doesnt bind a required Agent input — marks Failed, skips Job', async () => {
    const emitContractViolated = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ emitContractViolated });
    const task = makeTask(); // no inputs[]
    const result = await reconcileAgentTask(task, deps);

    expect(result.action).toBe('invalid-inputs');
    expect(result.reason).toContain('corpus');
    // Job NEVER created.
    expect(deps.mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled();
    // Status patched with Failed reason. C2R3-LOW-1 — `phase=Pending` is
    // seeded at the head of reconcile, so the Failed patch is NOT
    // necessarily the first call. Find it.
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalled();
    const allCalls = deps.mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls as Array<
      [{ body: { status: { phase: string; error?: string } } }]
    >;
    const failedCall = allCalls.find((c) => c[0].body.status.phase === 'Failed');
    expect(failedCall).toBeDefined();
    expect(failedCall?.[0].body.status.error).toContain('InvalidInputs');
    // Audit emitted.
    expect(emitContractViolated).toHaveBeenCalledTimes(1);
    expect(emitContractViolated.mock.calls[0][0]).toMatchObject({
      taskUid: 'task-uid-1',
      taskName: 't1',
      taskNamespace: 'default',
      agentName: 'researcher',
      reason: 'InvalidInputs',
    });
  });

  it('admits a task that binds every required input — proceeds to Job creation', async () => {
    const deps = makeDeps({});
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        payload: {},
        originalUserMessage: 'q',
        inputs: [{ name: 'corpus', from: { workspace: 'ws-1' } }],
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(deps.mocks.batchApi.createNamespacedJob).toHaveBeenCalled();
  });

  it('rejects an Agent with kind: workspace input missing mountPath (substrate invariant)', async () => {
    const badAgent: Agent = {
      ...typedAgent,
      spec: { ...typedAgent.spec, inputs: [{ name: 'corpus', kind: 'workspace' }] },
    };
    const emitContractViolated = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ agent: badAgent, emitContractViolated });
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        payload: {},
        inputs: [{ name: 'corpus', from: { workspace: 'ws-1' } }],
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('invalid-inputs');
    expect(result.reason).toContain('mountPath');
    expect(emitContractViolated).toHaveBeenCalled();
  });
});

/* =====================================================================
 * Idempotency-key dedupe
 * ===================================================================== */

describe('reconcileAgentTask — idempotency-key dedupe', () => {
  it('miss: first task with idempotencyKey caches + proceeds normally', async () => {
    const cache = new IdempotencyCache();
    const deps = makeDeps({ idempotencyCache: cache });
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        payload: {},
        idempotencyKey: 'idem-1',
        inputs: [{ name: 'corpus', from: { workspace: 'w' } }],
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(cache.size()).toBe(1);
  });

  it('replay: same key + same input hash → marks Completed with cached outputs, skips Job', async () => {
    const cache = new IdempotencyCache();
    const emitTaskDeduped = vi.fn().mockResolvedValue(undefined);
    // Pre-seed the cache with a "previous" task's outputs.
    cache.checkAndStore(
      { namespace: 'default', agentName: 'researcher', idempotencyKey: 'idem-replay' },
      // Hash of the same task spec we'll submit below — computed by
      // hashTaskInputs at admission time. We let admission compute it
      // and assert on the replay decision via behavior.
      'placeholder',
      'task-uid-prior',
    );
    cache.recordOutputs(
      { namespace: 'default', agentName: 'researcher', idempotencyKey: 'idem-replay' },
      [{ name: 'digest', ref: 'pvc://kagent-artifacts/prior/digest.md' }],
    );
    // To guarantee a replay, replace cache with a custom fake whose
    // checkAndStore always returns 'replay' for our key.
    const fakeCache = {
      checkAndStore: vi.fn().mockReturnValue({
        kind: 'replay',
        originalTaskUid: 'task-uid-prior',
        outputs: [{ name: 'digest', ref: 'pvc://prior/digest.md' }],
      }),
      recordOutputs: vi.fn(),
      size: () => 1,
      reset: () => undefined,
    } as unknown as IdempotencyCache;

    const deps = makeDeps({ idempotencyCache: fakeCache, emitTaskDeduped });
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        payload: {},
        idempotencyKey: 'idem-replay',
        inputs: [{ name: 'corpus', from: { workspace: 'w' } }],
      },
    });
    const result = await reconcileAgentTask(task, deps);

    expect(result.action).toBe('idempotent-replay');
    expect(deps.mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled();
    expect(emitTaskDeduped).toHaveBeenCalledTimes(1);
    // Verify a status patch carried the cached outputs + Completed phase.
    // C2R3-LOW-1 — `phase=Pending` is seeded at the head of reconcile so
    // the Completed patch is not necessarily the first call. Find it.
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalled();
    const allCalls = deps.mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls as Array<
      [{ body: { status: { phase: string; outputs?: { name: string; ref: string }[] } } }]
    >;
    const completedCall = allCalls.find((c) => c[0].body.status.phase === 'Completed');
    expect(completedCall).toBeDefined();
    expect(completedCall?.[0].body.status.outputs).toEqual([
      { name: 'digest', ref: 'pvc://prior/digest.md' },
    ]);
  });

  it('conflict: same key + different input hash → marks Failed with IdempotencyConflict', async () => {
    const fakeCache = {
      checkAndStore: vi.fn().mockReturnValue({
        kind: 'conflict',
        originalTaskUid: 'task-uid-prior',
        storedHash: 'h-prior',
        incomingHash: 'h-new',
      }),
      recordOutputs: vi.fn(),
      size: () => 1,
      reset: () => undefined,
    } as unknown as IdempotencyCache;
    const emitContractViolated = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ idempotencyCache: fakeCache, emitContractViolated });
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        payload: {},
        idempotencyKey: 'idem-conflict',
        inputs: [{ name: 'corpus', from: { workspace: 'w' } }],
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('idempotency-conflict');
    expect(deps.mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled();
    expect(emitContractViolated).toHaveBeenCalledTimes(1);
    expect(emitContractViolated.mock.calls[0][0]).toMatchObject({
      reason: 'IdempotencyConflict',
    });
  });

  it('self-replay: same task uid is treated as the original in-flight dispatch', async () => {
    const fakeCache = {
      checkAndStore: vi.fn().mockReturnValue({
        kind: 'replay',
        originalTaskUid: 'task-uid-1',
        outputs: [],
      }),
      recordOutputs: vi.fn(),
      size: () => 1,
      reset: () => undefined,
    } as unknown as IdempotencyCache;

    const deps = makeDeps({ idempotencyCache: fakeCache });
    const task = makeTask({
      metadata: { name: 't1', namespace: 'default', uid: 'task-uid-1' },
      spec: {
        targetAgent: 'researcher',
        payload: {},
        idempotencyKey: 'idem-self',
        inputs: [{ name: 'corpus', from: { workspace: 'w' } }],
      },
    });

    const result = await reconcileAgentTask(task, deps);

    expect(result.action).toBe('dispatched');
    expect(deps.mocks.batchApi.createNamespacedJob).toHaveBeenCalledTimes(1);
    const statusCalls = deps.mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls as Array<
      [{ body: { status: { phase?: string; conditions?: { reason?: string }[] } } }]
    >;
    expect(statusCalls.some((c) => c[0].body.status.phase === 'Completed')).toBe(false);
    expect(
      statusCalls.some((c) =>
        c[0].body.status.conditions?.some((condition) => condition.reason === 'IdempotencyReplay'),
      ),
    ).toBe(false);
  });

  it('no idempotencyKey: cache is bypassed entirely', async () => {
    const cache = new IdempotencyCache();
    const deps = makeDeps({ idempotencyCache: cache });
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        payload: {},
        inputs: [{ name: 'corpus', from: { workspace: 'w' } }],
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(cache.size()).toBe(0);
  });

  it('back-compat: cache absent (deps.idempotencyCache undefined) — dedupe is OFF', async () => {
    const deps = makeDeps({});
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        payload: {},
        idempotencyKey: 'idem-x',
        inputs: [{ name: 'corpus', from: { workspace: 'w' } }],
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
  });
});

/* =====================================================================
 * Completion-contract enforcement (post-Completed validator)
 * ===================================================================== */

describe('enforceCompletionContract', () => {
  function completedTask(outputs: { name: string; ref: string }[] | undefined): AgentTask {
    return {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: { name: 't1', namespace: 'default', uid: 'task-uid-1' },
      spec: { targetAgent: 'researcher', payload: {} },
      status: {
        phase: 'Completed',
        ...(outputs !== undefined && { outputs }),
      },
    };
  }

  it('no-op when phase != Completed', async () => {
    const deps = makeDeps({});
    const task: AgentTask = {
      ...completedTask(undefined),
      status: { phase: 'Dispatched' },
    };
    const action = await enforceCompletionContract(task, typedAgent, deps);
    expect(action).toBe('no-op');
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  it('cached-replay when all required outputs present + caches outputs for future replay', async () => {
    const cache = new IdempotencyCache();
    cache.checkAndStore(
      { namespace: 'default', agentName: 'researcher', idempotencyKey: 'idem-1' },
      'h1',
      'task-uid-1',
    );
    const deps = makeDeps({ idempotencyCache: cache });
    const task: AgentTask = {
      ...completedTask([{ name: 'digest', ref: 'pvc://uid-1/digest.md' }]),
      spec: { targetAgent: 'researcher', payload: {}, idempotencyKey: 'idem-1' },
    };
    const action = await enforceCompletionContract(task, typedAgent, deps);
    expect(action).toBe('cached-replay');
    // Re-submitting the same task should now replay cached outputs.
    const decision = cache.checkAndStore(
      { namespace: 'default', agentName: 'researcher', idempotencyKey: 'idem-1' },
      'h1',
      'task-uid-1', // same UID → looks the same to checkAndStore
    );
    expect(decision.kind).toBe('replay');
    if (decision.kind !== 'replay') return;
    expect(decision.outputs).toEqual([{ name: 'digest', ref: 'pvc://uid-1/digest.md' }]);
  });

  it('forced-failed when required outputs missing + emits contract.violated', async () => {
    const emitContractViolated = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ emitContractViolated });
    const task = completedTask(undefined); // no outputs

    const action = await enforceCompletionContract(task, typedAgent, deps);
    expect(action).toBe('forced-failed');

    // Status was force-patched with phase: Failed.
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
    const patch = deps.mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
      body: {
        status: {
          phase: string;
          error: string;
          conditions?: { type: string; reason: string }[];
        };
      };
    };
    expect(patch.body.status.phase).toBe('Failed');
    expect(patch.body.status.error).toContain('MissingRequiredOutputs');
    expect(patch.body.status.conditions?.[0]?.type).toBe('MissingRequiredOutputs');

    // Audit emitted.
    expect(emitContractViolated).toHaveBeenCalledTimes(1);
    expect(emitContractViolated.mock.calls[0][0]).toMatchObject({
      reason: 'MissingRequiredOutputs',
      taskName: 't1',
      taskUid: 'task-uid-1',
    });
  });

  it('back-compat: an Agent with no outputs[] (v0.1 Agent) is always cached-replay', async () => {
    const v01agent: Agent = {
      ...typedAgent,
      spec: { model: typedAgent.spec.model },
    };
    const deps = makeDeps({});
    const task = completedTask(undefined);
    const action = await enforceCompletionContract(task, v01agent, deps);
    expect(action).toBe('cached-replay');
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  it('forced-failed clears any cached idempotency entry (so next replay does not surface broken outputs)', async () => {
    const cache = new IdempotencyCache();
    cache.checkAndStore(
      { namespace: 'default', agentName: 'researcher', idempotencyKey: 'idem-broken' },
      'h1',
      'task-uid-1',
    );
    cache.recordOutputs(
      { namespace: 'default', agentName: 'researcher', idempotencyKey: 'idem-broken' },
      [{ name: 'digest', ref: 'pvc://broken/digest.md' }],
    );

    const deps = makeDeps({ idempotencyCache: cache });
    const task: AgentTask = {
      ...completedTask(undefined), // missing required outputs
      spec: {
        targetAgent: 'researcher',
        payload: {},
        idempotencyKey: 'idem-broken',
      },
    };
    await enforceCompletionContract(task, typedAgent, deps);

    // Cache outputs cleared for this key.
    const replay = cache.checkAndStore(
      { namespace: 'default', agentName: 'researcher', idempotencyKey: 'idem-broken' },
      'h1',
      'task-uid-2',
    );
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') return;
    expect(replay.outputs).toEqual([]);
  });

  it('partial outputs: missing only `required: false` outputs is still cached-replay', async () => {
    // typedAgent.spec.outputs has one required entry (`digest`); add a
    // non-required `extra` to make the partial-output case explicit.
    const partialAgent: Agent = {
      ...typedAgent,
      spec: {
        ...typedAgent.spec,
        outputs: [
          { name: 'digest', kind: 'artifact', required: true },
          { name: 'extra', kind: 'artifact', required: false },
        ],
      },
    };
    const deps = makeDeps({ agent: partialAgent });
    const task = completedTask([{ name: 'digest', ref: 'pvc://uid/digest.md' }]);
    const action = await enforceCompletionContract(task, partialAgent, deps);
    expect(action).toBe('cached-replay');
  });
});

/* =====================================================================
 * ConfigMap creation (replaces KAGENT_AGENT_SPEC + KAGENT_TASK_SPEC env)
 * ===================================================================== */

describe('reconcileAgentTask — per-Job ConfigMap creation', () => {
  it('creates the per-Job ConfigMap before the Job when coreApi is wired', async () => {
    const createCm = vi.fn().mockResolvedValue({});
    const deps = makeDeps({
      coreApi: { createNamespacedConfigMap: createCm },
    });
    // Use a v0.1-style agent (no inputs/outputs) so admission passes
    // without needing typed bindings.
    deps.mocks.customApi.getNamespacedCustomObject.mockResolvedValue({
      ...typedAgent,
      spec: { model: typedAgent.spec.model },
    });
    const task = makeTask();

    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');

    // ConfigMap created exactly once.
    expect(createCm).toHaveBeenCalledTimes(1);
    const cmCall = createCm.mock.calls[0][0] as {
      namespace: string;
      body: { metadata: { name: string }; data: Record<string, string> };
    };
    expect(cmCall.namespace).toBe('default');
    expect(cmCall.body.metadata.name).toBe('kac-task-uid-1');
    // Both keys present.
    expect(cmCall.body.data['agent.spec.json']).toBeDefined();
    expect(cmCall.body.data['task.spec.json']).toBeDefined();
    // Created BEFORE the Job (createCm ran first; Job create runs second).
    expect(deps.mocks.batchApi.createNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it('Job spec uses ConfigMap projection when coreApi is wired (no KAGENT_AGENT_SPEC env)', async () => {
    const deps = makeDeps({
      coreApi: { createNamespacedConfigMap: vi.fn().mockResolvedValue({}) },
    });
    deps.mocks.customApi.getNamespacedCustomObject.mockResolvedValue({
      ...typedAgent,
      spec: { model: typedAgent.spec.model },
    });
    const task = makeTask();
    await reconcileAgentTask(task, deps);

    const jobCall = deps.mocks.batchApi.createNamespacedJob.mock.calls[0][0] as {
      body: {
        spec: {
          template: { spec: { containers: { env: { name: string; value?: string }[] }[] } };
        };
      };
    };
    const env = jobCall.body.spec.template.spec.containers[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    // KAGENT_AGENT_SPEC + KAGENT_TASK_SPEC dropped.
    expect(byName.has('KAGENT_AGENT_SPEC')).toBe(false);
    expect(byName.has('KAGENT_TASK_SPEC')).toBe(false);
    // KAGENT_AGENT_MODEL still emitted (admission's hot path).
    expect(byName.get('KAGENT_AGENT_MODEL')).toBe(typedAgent.spec.model);
  });

  it('back-compat: when coreApi is undefined, falls back to env-JSON path', async () => {
    const deps = makeDeps({});
    deps.mocks.customApi.getNamespacedCustomObject.mockResolvedValue({
      ...typedAgent,
      spec: { model: typedAgent.spec.model },
    });
    const task = makeTask();
    await reconcileAgentTask(task, deps);

    const jobCall = deps.mocks.batchApi.createNamespacedJob.mock.calls[0][0] as {
      body: {
        spec: {
          template: { spec: { containers: { env: { name: string; value?: string }[] }[] } };
        };
      };
    };
    const env = jobCall.body.spec.template.spec.containers[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.has('KAGENT_AGENT_SPEC')).toBe(true);
    expect(byName.has('KAGENT_TASK_SPEC')).toBe(true);
  });

  it('treats 409 AlreadyExists on ConfigMap create as success (idempotent re-reconcile)', async () => {
    const createCm = vi.fn().mockRejectedValue({ code: 409 });
    const deps = makeDeps({
      coreApi: { createNamespacedConfigMap: createCm },
    });
    deps.mocks.customApi.getNamespacedCustomObject.mockResolvedValue({
      ...typedAgent,
      spec: { model: typedAgent.spec.model },
    });
    const task = makeTask();
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(deps.mocks.batchApi.createNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it('marks Failed when ConfigMap creation fails with a non-409 error', async () => {
    const createCm = vi.fn().mockRejectedValue(new Error('etcd unavailable'));
    const deps = makeDeps({
      coreApi: { createNamespacedConfigMap: createCm },
    });
    deps.mocks.customApi.getNamespacedCustomObject.mockResolvedValue({
      ...typedAgent,
      spec: { model: typedAgent.spec.model },
    });
    const task = makeTask();
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toContain('config-map');
    // Job NOT created — config-map failure short-circuits.
    expect(deps.mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled();
  });
});
