/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Verifies the AgentTask informer routing wired in `main.buildHandler`.
 *
 * Two cases:
 *
 *   1. An AgentTask event WITHOUT the `parent-task-name` label fires
 *      ONLY the existing `reconcileAgentTask` path. The new
 *      `reconcileParentFromChildEvent` path stays inert.
 *   2. An AgentTask event WITH the `parent-task-name` label fires BOTH
 *      paths — `reconcileAgentTask` for the event's own task AND
 *      `reconcileParentFromChildEvent` for the parent referenced by
 *      the labels. This is the Workstream 5 / Phase 5 wire-up that
 *      lets parent.status.children stay live as children transition.
 *
 * We mock the K8s API to assert call shape, not behavior — the
 * downstream path semantics are covered exhaustively in
 * `reconcile.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import { StubDispatcher } from './dispatcher.js';
import { buildHandler } from './main.js';
import type { ReconcileDeps } from './reconcile.js';
import { PARENT_TASK_NAME_LABEL, PARENT_TASK_UID_LABEL } from './task-graph.js';

interface MockCustomApi {
  getNamespacedCustomObject: ReturnType<typeof vi.fn>;
  patchNamespacedCustomObjectStatus: ReturnType<typeof vi.fn>;
  listNamespacedCustomObject: ReturnType<typeof vi.fn>;
}

interface MockBatchApi {
  createNamespacedJob: ReturnType<typeof vi.fn>;
}

const validAgent: Agent = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Agent',
  metadata: { name: 'researcher', namespace: 'default', uid: 'a-uid' },
  spec: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
};

function makeChildTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name: 'child-1',
      namespace: 'default',
      uid: 'child-uid-1',
      labels: {
        [PARENT_TASK_UID_LABEL]: 'parent-uid-1',
        [PARENT_TASK_NAME_LABEL]: 'parent-task',
      },
    },
    spec: {
      targetAgent: 'researcher',
      payload: {},
      parentTask: 'parent-uid-1',
      originalUserMessage: 'plan a k3s upgrade',
    },
    ...overrides,
  };
}

function makeParentTask(): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    // No labels — parent has no parent of its own. Critically does NOT
    // carry the `parent-task-name` label, so its OWN events do not
    // trigger reconcileParentFromChildEvent.
    metadata: { name: 'parent-task', namespace: 'default', uid: 'parent-uid-1' },
    spec: {
      targetAgent: 'researcher',
      payload: {},
      originalUserMessage: 'plan a k3s upgrade',
    },
    status: { phase: 'Dispatched' }, // skip path so dispatch is a no-op
  };
}

function buildDeps(parentForGet: AgentTask): {
  deps: ReconcileDeps;
  mocks: { customApi: MockCustomApi; batchApi: MockBatchApi };
} {
  const customApi: MockCustomApi = {
    // The getNamespacedCustomObject mock serves both:
    //   - reconcileAgentTask's Agent fetch
    //   - reconcileParentFromChildEvent's parent AgentTask fetch
    // We disambiguate via the call's `plural` field.
    getNamespacedCustomObject: vi.fn().mockImplementation((req: { plural: string }) => {
      if (req.plural === 'agents') return Promise.resolve(validAgent);
      if (req.plural === 'agenttasks') return Promise.resolve(parentForGet);
      throw new Error(`unexpected plural ${req.plural}`);
    }),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
  };
  const batchApi: MockBatchApi = {
    createNamespacedJob: vi.fn().mockResolvedValue({}),
  };
  return {
    deps: {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      batchApi: batchApi as unknown as ReconcileDeps['batchApi'],
      dispatcher: new StubDispatcher(),
    },
    mocks: { customApi, batchApi },
  };
}

describe('buildHandler — child-event routing', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence the operator's structured logging during tests; we assert
    // on mock-call shape instead. Restored automatically by vitest's
    // unhandled-spy detection at the file boundary.
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('an event WITHOUT the parent label fires ONLY reconcileAgentTask', async () => {
    const parent = makeParentTask();
    const { deps, mocks } = buildDeps(parent);
    const handler = buildHandler(deps);

    // Use the parent task itself — it has no parent-task-name label.
    await handler.onUpdate(parent);

    // reconcileAgentTask short-circuits on phase=Dispatched, so the only
    // customApi calls we expect are the (zero) calls for parent
    // re-aggregate. Crucially, listNamespacedCustomObject MUST NOT be
    // called — that's the smoking-gun for the second path firing.
    expect(mocks.customApi.listNamespacedCustomObject).not.toHaveBeenCalled();
    expect(mocks.customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('an event WITH the parent label fires BOTH reconcileAgentTask AND parent re-aggregate', async () => {
    const parent = makeParentTask();
    const { deps, mocks } = buildDeps(parent);
    const handler = buildHandler(deps);

    // Child task (terminal so reconcileAgentTask short-circuits — we
    // care about the routing, not the dispatch result).
    const child = makeChildTask({ status: { phase: 'Completed' } });
    await handler.onUpdate(child);

    // Path 1 (reconcileAgentTask) — phase=Completed → skip path. The
    // dispatcher is the cleanest signal it ran without dispatching.
    const dispatcher = deps.dispatcher as StubDispatcher;
    expect(dispatcher.published).toHaveLength(0);

    // Path 2 (reconcileParentFromChildEvent) — fired exactly once with
    // the parent ref derived from the child's labels.
    expect(mocks.customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'agenttasks',
        namespace: 'default',
        name: 'parent-task',
      }),
    );
    // List call uses the parent UID from the GET response (not from the
    // child's label) — this is the contract that lets us tolerate a
    // stale label by re-reading the parent's true UID.
    expect(mocks.customApi.listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'kagent.knuteson.io',
      version: 'v1alpha1',
      namespace: 'default',
      plural: 'agenttasks',
      labelSelector: 'kagent.knuteson.io/parent-task-uid=parent-uid-1',
    });
    // The aggregate patch lands on the parent.
    expect(mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'agenttasks',
        name: 'parent-task',
        body: {
          status: expect.objectContaining({
            aggregatePhase: expect.any(String),
            children: expect.any(Array),
          }),
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) }),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    // Reference consoleLogSpy so the unused-binding rule stays quiet —
    // the spy itself is wired in beforeEach for routing-side logging
    // we don't want to assert against, but vitest GCs it on its own.
    expect(consoleLogSpy).toBeDefined();
  });

  it('a failure in the parent re-aggregate path is logged but does NOT throw', async () => {
    const parent = makeParentTask();
    const customApi: MockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockImplementation((req: { plural: string }) => {
        if (req.plural === 'agents') return Promise.resolve(validAgent);
        // Parent fetch blows up with a NON-404 error so the path
        // doesn't gracefully short-circuit — this exercises the
        // catch-and-log shielding in maybeReconcileParent.
        return Promise.reject(new Error('apiserver hiccup'));
      }),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    };
    const deps: ReconcileDeps = {
      customApi: customApi as unknown as ReconcileDeps['customApi'],
      batchApi: {
        createNamespacedJob: vi.fn().mockResolvedValue({}),
      } as unknown as ReconcileDeps['batchApi'],
      dispatcher: new StubDispatcher(),
    };
    const handler = buildHandler(deps);
    const child = makeChildTask({ status: { phase: 'Completed' } });

    // The handler MUST resolve, not throw — child-aggregation failures
    // should not propagate up to the informer (which would cause the
    // 5-second restart loop).
    await expect(handler.onUpdate(child)).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
    // Use parent locally to keep the variable referenced; the test
    // asserts via mocks above.
    expect(parent.metadata.name).toBe('parent-task');
  });
});
