/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

// vitest's `vi.fn()` returns `Mock<any, any>` by default; .mockResolvedValue
// then propagates `any` through the test surface. Typing every fn() call
// against the K8s API shapes is more churn than payoff for a reconcile test
// — the intent is mock-call assertions, not type-level coverage.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import { StubDispatcher } from './dispatcher.js';
import {
  markAgentTaskFailedFromExternal,
  reconcileAgentTask,
  reconcileParentFromChildEvent,
  type ReconcileDeps,
} from './reconcile.js';
import { PARENT_TASK_NAME_LABEL, PARENT_TASK_UID_LABEL } from './task-graph.js';

/* =====================================================================
 * Mock factories — stand in for @kubernetes/client-node clients.
 * ===================================================================== */

interface MockCustomApi {
  getNamespacedCustomObject: ReturnType<typeof vi.fn>;
  patchNamespacedCustomObjectStatus: ReturnType<typeof vi.fn>;
}
interface MockBatchApi {
  createNamespacedJob: ReturnType<typeof vi.fn>;
  readNamespacedJob: ReturnType<typeof vi.fn>;
  patchNamespacedJob: ReturnType<typeof vi.fn>;
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
  // WS-F default: Job exists post-create, no `dispatch-published`
  // annotation yet → publish path runs. Tests that exercise the
  // re-reconcile path override readNamespacedJob to return a Job
  // carrying the annotation.
  const batchApi: MockBatchApi = {
    createNamespacedJob: vi.fn().mockResolvedValue({}),
    readNamespacedJob: vi.fn().mockResolvedValue({
      metadata: { name: 'kat-task-uid-1', namespace: 'default', annotations: {} },
      spec: { suspend: true },
    }),
    patchNamespacedJob: vi.fn().mockResolvedValue({}),
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

  it('creates the Job in suspended state (WS-F)', async () => {
    await reconcileAgentTask(task, deps);
    const callBody = deps.mocks.batchApi.createNamespacedJob.mock.calls[0]?.[0]?.body as {
      spec?: { suspend?: boolean };
    };
    expect(callBody?.spec?.suspend).toBe(true);
  });

  it('passes a dedupeId equal to the task UID on publish', async () => {
    const dispatcher = new StubDispatcher();
    const publishSpy = vi.spyOn(dispatcher, 'publish');
    const localDeps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      dispatcher,
    });
    await reconcileAgentTask(task, localDeps);
    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-uid-1' }), {
      dedupeId: 'task-uid-1',
    });
  });

  it('annotates the Job with dispatch-published="true" after publish', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.batchApi.patchNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'default',
        name: 'kat-task-uid-1',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            annotations: expect.objectContaining({
              'kagent.knuteson.io/dispatch-published': 'true',
            }),
          }),
        }),
      }),
    );
  });

  it('unsuspends the Job (spec.suspend=false) after publish + annotation', async () => {
    await reconcileAgentTask(task, deps);
    const calls = deps.mocks.batchApi.patchNamespacedJob.mock.calls;
    const unsuspendCall = calls.find((c: unknown[]) => {
      const arg = c[0] as { body?: { spec?: { suspend?: boolean } } };
      return arg?.body?.spec?.suspend === false;
    });
    expect(unsuspendCall).toBeDefined();
  });

  it('orders annotation BEFORE unsuspend (so a crash mid-flight strands a suspended-but-published Job, not a running-but-unmarked one)', async () => {
    const callOrder: string[] = [];
    const customDeps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        patchNamespacedJob: vi.fn().mockImplementation((arg: { body: unknown }) => {
          const body = arg.body as { metadata?: unknown; spec?: unknown };
          if (body.metadata !== undefined) callOrder.push('annotate');
          if (body.spec !== undefined) callOrder.push('unsuspend');
          return Promise.resolve({});
        }),
      },
      now: () => fixedNow,
    });
    await reconcileAgentTask(task, customDeps);
    expect(callOrder).toEqual(['annotate', 'unsuspend']);
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

  it('patches AgentTask.status with phase=Dispatched + podName + startedAt + observedGeneration + condition', async () => {
    await reconcileAgentTask(task, deps);
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'agenttasks',
        name: 't1',
        body: {
          status: expect.objectContaining({
            phase: 'Dispatched',
            podName: 'kat-task-uid-1',
            startedAt: fixedNow.toISOString(),
            observedGeneration: 0,
            conditions: expect.arrayContaining([
              expect.objectContaining({
                type: 'Dispatched',
                status: 'True',
                reason: 'JobCreated',
                lastTransitionTime: fixedNow.toISOString(),
              }),
            ]),
          }),
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) }),
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
    // markFailed → patchStatusWithRetry re-reads the AgentTask before
    // building the patch. Configure the mock to return the same task
    // shape on both Agent + AgentTask GETs (the build closure only
    // touches `status.phase` + `metadata.generation`, and an absent
    // status is fine).
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(task),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/no live agent satisfies capability 'researcher'/);
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { status: expect.objectContaining({ phase: 'Failed' }) },
      }),
      expect.objectContaining({ middleware: expect.any(Array) }),
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

/* =====================================================================
 * WS-F: suspended-publish dispatch ordering races. The reconcile flow
 * is publish-then-annotate-then-unsuspend; each scenario below pins
 * down a specific failure mode that the audit flagged.
 * ===================================================================== */

describe('reconcileAgentTask — WS-F dispatch ordering races', () => {
  /**
   * Re-reconcile after a successful publish: the Job already carries
   * the `dispatch-published: "true"` annotation. The reconcile must
   * SKIP publish (don't double-fire) and proceed straight to unsuspend.
   */
  it('skips publish when the Job already carries dispatch-published="true"', async () => {
    const task = makeTask();
    const dispatcher = new StubDispatcher();
    const publishSpy = vi.spyOn(dispatcher, 'publish');
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        // Job exists and was already published — re-reconcile path.
        readNamespacedJob: vi.fn().mockResolvedValue({
          metadata: {
            name: 'kat-task-uid-1',
            namespace: 'default',
            annotations: { 'kagent.knuteson.io/dispatch-published': 'true' },
          },
          spec: { suspend: true },
        }),
      },
      dispatcher,
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(publishSpy).not.toHaveBeenCalled();
    // Annotation patch is also skipped (we already have it).
    const annotationPatchCalls = deps.mocks.batchApi.patchNamespacedJob.mock.calls.filter(
      (c: unknown[]) => {
        const body = (c[0] as { body?: { metadata?: unknown } })?.body;
        return body?.metadata !== undefined;
      },
    );
    expect(annotationPatchCalls).toHaveLength(0);
    // Unsuspend still runs.
    const unsuspendCalls = deps.mocks.batchApi.patchNamespacedJob.mock.calls.filter(
      (c: unknown[]) => {
        const body = (c[0] as { body?: { spec?: { suspend?: boolean } } })?.body;
        return body?.spec?.suspend === false;
      },
    );
    expect(unsuspendCalls).toHaveLength(1);
  });

  /**
   * Crash between Job-create and publish: re-reconcile sees Job exists
   * (409 idempotent) and no `dispatch-published` annotation → publishes
   * with dedupeId = task.uid. Validates the dedupeId is stable across
   * reconcile retries (the broker takes care of deduping the actual
   * second publish; we just have to pin that the operator passes the
   * SAME id).
   */
  it('re-reconcile after Job-create crash → publishes with task-uid dedupeId (broker-side dedupe is the safety net)', async () => {
    const task = makeTask();
    const dispatcher = new StubDispatcher();
    const publishSpy = vi.spyOn(dispatcher, 'publish');
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        // Job-create returns 409 — already exists from a prior reconcile.
        createNamespacedJob: vi.fn().mockRejectedValue(conflict),
        // No annotation yet — prior reconcile crashed before publish or
        // before annotation-patch.
        readNamespacedJob: vi.fn().mockResolvedValue({
          metadata: { name: 'kat-task-uid-1', namespace: 'default', annotations: {} },
          spec: { suspend: true },
        }),
      },
      dispatcher,
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith(expect.anything(), { dedupeId: 'task-uid-1' });
  });

  /**
   * Annotation-patch failure post-publish must NOT mark the AgentTask
   * Failed — the message is on the bus. Operator returns dispatched;
   * the next reconcile would re-publish (broker dedupe drops it).
   */
  it('annotation-patch failure is logged but treated as success (broker dedupe handles re-publish)', async () => {
    const task = makeTask();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        patchNamespacedJob: vi.fn().mockImplementation((arg: { body: unknown }) => {
          const body = arg.body as { metadata?: unknown; spec?: unknown };
          if (body.metadata !== undefined) {
            return Promise.reject(new Error('apiserver flaky'));
          }
          return Promise.resolve({});
        }),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('dispatched');
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining('FAILED to stamp dispatch-published annotation'),
      expect.anything(),
    );
    // Status was still patched to Dispatched (best-effort marker for
    // user visibility; the in-cluster source of truth is the Job
    // annotation + the bus dedupe).
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { status: expect.objectContaining({ phase: 'Dispatched' }) },
      }),
      expect.anything(),
    );
    consoleErr.mockRestore();
  });

  /**
   * Unsuspend failure leaves the Job suspended. AgentTask is NOT marked
   * Failed (recoverable on next reconcile) and NOT marked Dispatched
   * (the pod hasn't run). Reconcile returns 'failed' so the caller can
   * record metrics/log noise, but the status stays untouched.
   */
  it('unsuspend failure returns action=failed and leaves AgentTask status untouched (informer relist retries)', async () => {
    const task = makeTask();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        patchNamespacedJob: vi.fn().mockImplementation((arg: { body: unknown }) => {
          const body = arg.body as { metadata?: unknown; spec?: { suspend?: boolean } };
          if (body.spec?.suspend === false) {
            return Promise.reject(new Error('forbidden'));
          }
          return Promise.resolve({});
        }),
      },
    });
    const result = await reconcileAgentTask(task, deps);
    expect(result.action).toBe('failed');
    expect(result.reason).toMatch(/unsuspend failed/);
    // Status NOT marked Failed (we want a relist to retry, not a sticky terminal).
    expect(deps.mocks.customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining('failed to unsuspend Job'),
      expect.anything(),
    );
    consoleErr.mockRestore();
  });

  /**
   * Publish failure pre-annotation: the Job is suspended and was
   * never told to run. Mark AgentTask Failed with reason "dispatch
   * failed" so the user sees a clear error.
   */
  it('publish failure marks Failed and never unsuspends the Job', async () => {
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
    // Never unsuspended — the Job stays asleep.
    const unsuspendCalls = deps.mocks.batchApi.patchNamespacedJob.mock.calls.filter(
      (c: unknown[]) => {
        const body = (c[0] as { body?: { spec?: { suspend?: boolean } } })?.body;
        return body?.spec?.suspend === false;
      },
    );
    expect(unsuspendCalls).toHaveLength(0);
  });

  /**
   * StubDispatcher invariants: the same dedupeId across two reconcile
   * passes results in a single bus publish. This is the contract the
   * production NatsDispatcher inherits via JetStream's `Nats-Msg-Id`
   * header — we test it on the stub because that's where the operator's
   * unit tests live, but the broker behavior is the real safety net.
   */
  it('StubDispatcher: two reconciles with the same task UID produce ONE publish', async () => {
    const task = makeTask();
    const dispatcher = new StubDispatcher();
    // First reconcile: simulate annotation-patch failure so the second
    // reconcile takes the re-publish path.
    const deps1 = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        patchNamespacedJob: vi.fn().mockImplementation((arg: { body: unknown }) => {
          const body = arg.body as { metadata?: unknown };
          if (body.metadata !== undefined) {
            return Promise.reject(new Error('flaky annotation-patch'));
          }
          return Promise.resolve({});
        }),
      },
      dispatcher,
    });
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reconcileAgentTask(task, deps1);
    expect(dispatcher.published).toHaveLength(1);

    // Second reconcile: Job exists, annotation still absent (because
    // patch failed). Operator passes the same dedupeId; StubDispatcher
    // drops the duplicate, mirroring JetStream's behavior.
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    const deps2 = makeDeps({
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      },
      batchApi: {
        createNamespacedJob: vi.fn().mockRejectedValue(conflict),
        readNamespacedJob: vi.fn().mockResolvedValue({
          metadata: { name: 'kat-task-uid-1', namespace: 'default', annotations: {} },
          spec: { suspend: true },
        }),
      },
      dispatcher,
    });
    await reconcileAgentTask(task, deps2);
    // Still ONE published task — the dedupeId protected the bus.
    expect(dispatcher.published).toHaveLength(1);
    expect(dispatcher.seenDedupeIds.has('task-uid-1')).toBe(true);
    consoleErr.mockRestore();
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

describe('markAgentTaskFailedFromExternal', () => {
  const ref = { namespace: 'kagent-system', name: 'smoke-test' };
  const failure = {
    reason: 'ImagePullBackOff',
    message: 'manifest unknown',
    source: 'pod' as const,
  };
  const fixedNow = new Date('2026-04-27T05:30:00.000Z');

  it('marks Failed when AgentTask is currently Dispatched', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValue(makeTask({ status: { phase: 'Dispatched' } })),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    expect(action).toEqual({ kind: 'marked-failed', previousPhase: 'Dispatched' });
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: expect.objectContaining({
            phase: 'Failed',
            error: '[pod/ImagePullBackOff] manifest unknown',
            completedAt: fixedNow.toISOString(),
          }),
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) }),
    );
  });

  it('appends a JobFailedAfterComplete condition when AgentTask is already Completed (WS-E: never overwrite success)', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValue(makeTask({ status: { phase: 'Completed' } })),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    expect(action).toEqual({ kind: 'condition-appended', previousPhase: 'Completed' });
    // The patch landed but did NOT include `phase` — terminal-monotonic.
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
    const patchCall = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
      body: { status: Record<string, unknown> };
    };
    expect(patchCall.body.status).not.toHaveProperty('phase');
    expect(patchCall.body.status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'JobFailedAfterComplete',
          status: 'True',
          reason: 'ImagePullBackOff',
        }),
      ]),
    );
  });

  it('appends a fresh failure condition when AgentTask is already Failed (multi-mode failures stay observable)', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValue(makeTask({ status: { phase: 'Failed' } })),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    expect(action).toEqual({ kind: 'condition-appended', previousPhase: 'Failed' });
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
    const patchCall = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
      body: { status: Record<string, unknown> };
    };
    expect(patchCall.body.status).not.toHaveProperty('phase');
    expect(patchCall.body.status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ImagePullBackOff',
          status: 'True',
        }),
      ]),
    );
  });

  it('skips silently when AgentTask is gone (404 — race vs. owner GC)', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'skipped', reason: 'not-found' });
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  it('marks Failed when status.phase is unset (early failure before reconcile)', async () => {
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeTask()),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const action = await markAgentTaskFailedFromExternal(ref, failure, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      now: () => fixedNow,
    });
    expect(action).toEqual({ kind: 'marked-failed', previousPhase: '(unset)' });
  });
});

/* =====================================================================
 * reconcileParentFromChildEvent — Workstream 5 / Phase 5 wire-up.
 *
 * Mirrors the markAgentTaskFailedFromExternal block above: every test
 * spins up a mock CustomObjectsApi configured with the parent GET
 * response and the children LIST response, calls the new entry point,
 * and asserts both the action verdict AND the patch body. The KEY
 * INVARIANT throughout: the patch body MUST NOT contain `phase` —
 * that field's ownership stays with the agent-pod and the failure
 * detector. See TASK-GRAPH.md §6.
 * ===================================================================== */

interface MockListCustomApi extends MockCustomApi {
  listNamespacedCustomObject: ReturnType<typeof vi.fn>;
}

function makeListCustomApi(overrides: Partial<MockListCustomApi> = {}): MockListCustomApi {
  return {
    getNamespacedCustomObject: vi.fn(),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    ...overrides,
  };
}

/**
 * Build a child AgentTask in the shape the operator's LIST returns:
 * carrying the parent labels and a status.phase.
 */
function makeChild(
  uid: string,
  phase: 'Pending' | 'Dispatched' | 'Completed' | 'Failed' | undefined,
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
    ...(phase !== undefined && { status: { phase } }),
  };
}

const PARENT_REF = { namespace: 'default', name: 'parent-task' };

function makeParent(overrides: Partial<AgentTask> = {}): AgentTask {
  return makeTask({
    metadata: { name: 'parent-task', namespace: 'default', uid: 'parent-uid-1' },
    ...overrides,
  });
}

describe('reconcileParentFromChildEvent — child aggregation projection', () => {
  it('projects empty list → aggregatePhase=Pending with all counts at 0', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'updated', aggregatePhase: 'Pending', childCount: 0 });
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            children: [],
            aggregatePhase: 'Pending',
            successCount: 0,
            failureCount: 0,
            inFlightCount: 0,
          },
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) }),
    );
  });

  it('projects 3 Completed children → AllComplete with successCount=3', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [
          makeChild('c1', 'Completed'),
          makeChild('c2', 'Completed'),
          makeChild('c3', 'Completed'),
        ],
      }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'updated', aggregatePhase: 'AllComplete', childCount: 3 });
    const patchCall = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
      body: { status: { successCount: number; failureCount: number; inFlightCount: number } };
    };
    expect(patchCall.body.status.successCount).toBe(3);
    expect(patchCall.body.status.failureCount).toBe(0);
    expect(patchCall.body.status.inFlightCount).toBe(0);
  });

  it('projects 1 Failed + 2 Completed → AnyFailed with failureCount=1, successCount=2', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [
          makeChild('c1', 'Completed'),
          makeChild('c2', 'Completed'),
          makeChild('c3', 'Failed'),
        ],
      }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'updated', aggregatePhase: 'AnyFailed', childCount: 3 });
    const patchCall = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
      body: { status: { successCount: number; failureCount: number; inFlightCount: number } };
    };
    expect(patchCall.body.status.failureCount).toBe(1);
    expect(patchCall.body.status.successCount).toBe(2);
    expect(patchCall.body.status.inFlightCount).toBe(0);
  });

  it('returns skipped/not-found when the parent AgentTask is gone (404)', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action).toEqual({ kind: 'skipped', reason: 'not-found' });
    expect(customApi.listNamespacedCustomObject).not.toHaveBeenCalled();
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  it('still updates children/aggregatePhase when parent is already terminal (Completed) without touching status.phase', async () => {
    const completedParent = makeParent({ status: { phase: 'Completed' } });
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(completedParent),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [makeChild('c1', 'Failed')],
      }),
    });
    const action = await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(action.kind).toBe('updated');
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1);
    const body = (
      customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0] as {
        body: { status: Record<string, unknown> };
      }
    ).body.status;
    // CRITICAL: the patch body must NOT include `phase`. Aggregate state is
    // parallel data — terminal parents stay terminal; only their child
    // projection refreshes.
    expect(body).not.toHaveProperty('phase');
    expect(body.aggregatePhase).toBe('AnyFailed');
  });

  it('LISTs children with the right labelSelector (parent-task-uid=<uid>) in the parent namespace', async () => {
    const customApi = makeListCustomApi({
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    });
    await reconcileParentFromChildEvent(PARENT_REF, {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
    });
    expect(customApi.listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'kagent.knuteson.io',
      version: 'v1alpha1',
      namespace: 'default',
      plural: 'agenttasks',
      labelSelector: 'kagent.knuteson.io/parent-task-uid=parent-uid-1',
    });
  });
});
