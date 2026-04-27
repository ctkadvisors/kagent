/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

// vitest's `vi.fn()` returns `Mock<any, any>` by default; .mockResolvedValue
// then propagates `any` through the test surface. Typing every fn() call
// against the K8s API shapes is more churn than payoff for a reconcile test
// — the intent is mock-call assertions, not type-level coverage.
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import { StubDispatcher } from './dispatcher.js';
import { reconcileAgentTask, type ReconcileDeps } from './reconcile.js';

/* =====================================================================
 * Mock factories — stand in for @kubernetes/client-node clients.
 * ===================================================================== */

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
  capabilityRegistry?: ReconcileDeps['capabilityRegistry'];
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
    ...(overrides.capabilityRegistry !== undefined && {
      capabilityRegistry: overrides.capabilityRegistry,
    }),
    ...(overrides.now !== undefined && { now: overrides.now }),
    mocks: { customApi, batchApi, dispatcher },
  };
}

/* =====================================================================
 * Fixtures
 * ===================================================================== */

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
    metadata: { name: 't1', namespace: 'default', uid: 'task-uid-1' },
    spec: {
      targetAgent: 'researcher',
      payload: { topic: 'k3s' },
      originalUserMessage: 'what is k3s default runtime?',
    },
    ...overrides,
  };
}

/* =====================================================================
 * Tests
 * ===================================================================== */

describe('reconcileAgentTask — skip paths', () => {
  it.each(['Completed', 'Failed', 'Dispatched'] as const)('skips when phase=%s', async (phase) => {
    const task = makeTask({ status: { phase } });
    const deps = makeDeps({});
    const result = await reconcileAgentTask(task, deps);
    expect(result).toEqual({ action: 'skipped', reason: `phase=${phase}` });
    expect(deps.mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled();
    expect(deps.mocks.dispatcher.published).toHaveLength(0);
  });

  it('does NOT skip when phase is undefined (treated as Pending)', async () => {
    const task = makeTask();
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
  });
});

describe('reconcileAgentTask — happy path (targetAgent)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let task: AgentTask;
  const fixedNow = new Date('2026-04-26T10:00:00.000Z');

  beforeEach(() => {
    task = makeTask();
    deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      now: () => fixedNow,
    });
  });

  it('returns action=dispatched with the deterministic Job name', async () => {
    const result = await reconcileAgentTask(task, deps);
    expect(result).toEqual({ action: 'dispatched', jobName: 'kat-task-uid-1' });
  });

  it('fetches the target Agent in the same namespace as the task', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: 'default',
        plural: 'agents',
        name: 'researcher',
      }),
    );
  });

  it('creates a Job in the AgentTask namespace', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.batchApi.createNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'default',
        body: expect.objectContaining({
          kind: 'Job',
          metadata: expect.objectContaining({ name: 'kat-task-uid-1' }),
        }),
      }),
    );
  });

  it('publishes a DispatchedTask envelope with the originalUserMessage + payload', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.dispatcher.published).toHaveLength(1);
    expect(deps.mocks.dispatcher.published[0]).toMatchObject({
      taskId: 'task-uid-1',
      agentId: 'researcher',
      originalUserMessage: 'what is k3s default runtime?',
      payload: { topic: 'k3s' },
    });
  });

  it('threads parentTask + parentDistillation + expectedTools into the envelope', async () => {
    const delegated = makeTask({
      spec: {
        ...task.spec,
        parentTask: 'parent-uid',
        parentDistillation: 'distilled prompt',
        expectedTools: ['fetch_url'],
      },
    });
    await reconcileAgentTask(delegated, deps);
    expect(deps.mocks.dispatcher.published[0]).toMatchObject({
      parentTaskId: 'parent-uid',
      parentDistillation: 'distilled prompt',
      expectedTools: ['fetch_url'],
    });
  });

  it('patches AgentTask.status with phase=Dispatched + podName + startedAt', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'agenttasks',
        name: 't1',
        body: {
          status: {
            phase: 'Dispatched',
            podName: 'kat-task-uid-1',
            startedAt: fixedNow.toISOString(),
          },
        },
      }),
    );
  });
});

describe('reconcileAgentTask — capability resolution', () => {
  it('dispatches when registry resolves capability → agent', async () => {
    const { StaticCapabilityRegistry } = await import('./capability-registry.js');
    const task = makeTask({
      spec: {
        targetCapability: 'research',
        payload: {},
        originalUserMessage: 'do the thing',
      },
    });
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      capabilityRegistry: new StaticCapabilityRegistry({ research: 'researcher' }),
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(deps.mocks.customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'researcher' }),
    );
  });
});

describe('reconcileAgentTask — failure paths', () => {
  it('marks Failed when targetCapability is set but the registry returns null', async () => {
    const task = makeTask({
      spec: {
        targetCapability: 'researcher',
        payload: {},
      },
    });
    const deps = makeDeps({}); // default: StubCapabilityRegistry → null
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/no live agent satisfies capability 'researcher'/);
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { status: expect.objectContaining({ phase: 'Failed' }) },
      }),
    );
  });

  it('marks Failed when neither targetAgent nor targetCapability is set', async () => {
    const task = makeTask({ spec: { payload: {} } });
    const deps = makeDeps({});
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/neither targetAgent nor targetCapability/);
  });

  it('marks Failed when the resolved object has a malformed Agent shape', async () => {
    const task = makeTask();
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi
          .fn()
          .mockResolvedValue({ apiVersion: 'kagent.dev/v1', kind: 'Agent' }),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/malformed shape/);
  });

  it('marks Failed when the Agent fetch rejects', async () => {
    const task = makeTask();
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockRejectedValue(new Error('not found')),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/not found/);
  });

  it('marks Failed when Job creation throws a non-409 error', async () => {
    const task = makeTask();
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        createNamespacedJob: vi.fn().mockRejectedValue(new Error('forbidden')),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/job creation failed.*forbidden/);
  });

  it('treats Job creation 409 AlreadyExists as success (idempotency)', async () => {
    const task = makeTask();
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        createNamespacedJob: vi.fn().mockRejectedValue(conflict),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
  });

  it('marks Failed when Dispatcher.publish throws', async () => {
    const task = makeTask();
    const dispatcher = new StubDispatcher();
    vi.spyOn(dispatcher, 'publish').mockRejectedValueOnce(new Error('bus down'));
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      dispatcher,
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/dispatch failed.*bus down/);
  });
});

describe('reconcileAgentTask — namespace defaulting', () => {
  it("uses 'default' namespace when AgentTask has none set", async () => {
    const task = makeTask({
      metadata: { name: 't1', uid: 'task-uid-1' /* no namespace */ },
    });
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
    });
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'default' }),
    );
    expect(deps.mocks.batchApi.createNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'default' }),
    );
  });
});
