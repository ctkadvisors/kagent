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
import {
  PARENT_TASK_NAME_ANNOTATION,
  PARENT_TASK_NAME_LABEL,
  PARENT_TASK_UID_LABEL,
} from './task-graph.js';

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

  it('long parent name (annotation only, no name label) still routes to parent re-aggregate', async () => {
    const longParentName = `parent-${'a'.repeat(70)}`;
    const parent: AgentTask = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: { name: longParentName, namespace: 'default', uid: 'parent-uid-long' },
      spec: { targetAgent: 'researcher', payload: {}, originalUserMessage: 'long' },
      status: { phase: 'Dispatched' },
    };
    const { deps, mocks } = buildDeps(parent);
    const handler = buildHandler(deps);

    // Child built the way `buildChildTaskManifest` actually emits it for a
    // long parent name: UID label + full-name annotation, NO name label.
    const child: AgentTask = makeChildTask({
      metadata: {
        name: 'child-long',
        namespace: 'default',
        uid: 'child-uid-long',
        labels: { [PARENT_TASK_UID_LABEL]: 'parent-uid-long' },
        annotations: { [PARENT_TASK_NAME_ANNOTATION]: longParentName },
      },
      status: { phase: 'Completed' },
    });
    await handler.onUpdate(child);

    // Parent ref recovered from the annotation, then GET'd by name.
    expect(mocks.customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'agenttasks',
        namespace: 'default',
        name: longParentName,
      }),
    );
    // Children listed by UID (not name), so long names don't break the
    // label-selector watch path.
    expect(mocks.customApi.listNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        labelSelector: 'kagent.knuteson.io/parent-task-uid=parent-uid-long',
      }),
    );
    expect(mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalled();
  });

  /* -----------------------------------------------------------------
   * Phase 5 P4 — supervision-aware ordering. When a CHILD event
   * carries `phase: Failed` AND supervision is enabled for the
   * operator, supervision MUST run BEFORE the parent re-aggregate so
   * the projection reflects post-supervision state (e.g. siblings
   * the supervisor just `supervision_terminated`).
   *
   * The test asserts ordering by recording the relative timestamps of
   * the supervision-router call and the parent-status PATCH call. The
   * supervision call must come first (lower call-order index).
   *
   * When the failed task is a ROOT (no parent label), supervision
   * still routes (it short-circuits with `no-op/no-parent`) and the
   * parent re-aggregate doesn't run at all — neither path touches
   * etcd, so we just confirm zero patches landed.
   * ----------------------------------------------------------------- */
  it('failed CHILD with supervision enabled: supervision runs BEFORE parent re-aggregate', async () => {
    const parent = makeParentTask();
    const { deps, mocks } = buildDeps(parent);

    // Track call order across both paths via a shared counter so we
    // can assert "supervision happened first" without relying on
    // microtask scheduling implementation details.
    const callOrder: string[] = [];
    mocks.customApi.listNamespacedCustomObject = vi.fn().mockImplementation(() => {
      callOrder.push('parent-list');
      return Promise.resolve({ items: [] });
    });
    mocks.customApi.patchNamespacedCustomObjectStatus = vi.fn().mockImplementation(() => {
      callOrder.push('parent-patch');
      return Promise.resolve({});
    });

    // Patch routeFailureForSupervision at the module level so
    // buildHandler's internal call routes through our spy. The spy
    // pushes 'supervision' onto the shared `callOrder` so we can
    // assert ordering relative to the parent-aggregate path.
    const mod = await import('./supervision-router.js');
    const spyRoute = vi.spyOn(mod, 'routeFailureForSupervision').mockImplementation(() => {
      callOrder.push('supervision');
      return Promise.resolve({ kind: 'no-op', reason: 'no-parent' });
    });

    const handler = buildHandler(deps, {
      enabled: true,
      router: {
        customApi: deps.customApi,
      } as unknown as Parameters<typeof buildHandler>[1] extends infer S
        ? S extends { router: infer R }
          ? R
          : never
        : never,
    });

    // Failed child with parent labels (this is the supervision-active
    // path the ordering branch should take).
    const failedChild = makeChildTask({ status: { phase: 'Failed', error: 'invalid_inputs' } });
    await handler.onUpdate(failedChild);

    // supervision-router must have been called.
    expect(spyRoute).toHaveBeenCalled();

    // The first ordering-relevant entry MUST be 'supervision' — it
    // ran before parent re-aggregate (which manifests as a parent-list
    // and parent-patch call, both downstream of `maybeReconcileParent`).
    expect(callOrder.indexOf('supervision')).toBeGreaterThanOrEqual(0);
    const supervisionIdx = callOrder.indexOf('supervision');
    const parentListIdx = callOrder.indexOf('parent-list');
    // parent-list happens (the parent re-aggregate ran second), and
    // it happens AFTER supervision.
    expect(parentListIdx).toBeGreaterThanOrEqual(0);
    expect(supervisionIdx).toBeLessThan(parentListIdx);

    spyRoute.mockRestore();
  });

  it('failed CHILD with supervision DISABLED: parent re-aggregate runs (default order, no supervision call)', async () => {
    const parent = makeParentTask();
    const { deps, mocks } = buildDeps(parent);
    const mod = await import('./supervision-router.js');
    const spyRoute = vi
      .spyOn(mod, 'routeFailureForSupervision')
      .mockResolvedValue({ kind: 'no-op', reason: 'no-parent' });

    // supervision-router deps wired but `enabled: false` → guard in
    // `maybeRouteSupervision` short-circuits without calling the
    // router.
    const handler = buildHandler(deps, {
      enabled: false,
      router: {
        customApi: deps.customApi,
      } as unknown as Parameters<typeof buildHandler>[1] extends infer S
        ? S extends { router: infer R }
          ? R
          : never
        : never,
    });

    const failedChild = makeChildTask({ status: { phase: 'Failed', error: 'invalid_inputs' } });
    await handler.onUpdate(failedChild);

    // supervision-router was NOT called (enabled=false).
    expect(spyRoute).not.toHaveBeenCalled();
    // Parent re-aggregate STILL ran — the default order is preserved
    // when the supervision-deferral guard is off.
    expect(mocks.customApi.listNamespacedCustomObject).toHaveBeenCalled();
    expect(mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalled();
    spyRoute.mockRestore();
  });

  it('non-failed child events keep the default order: parent re-aggregate first, then supervision (no-op)', async () => {
    const parent = makeParentTask();
    const { deps, mocks } = buildDeps(parent);
    const mod = await import('./supervision-router.js');
    const spyRoute = vi.spyOn(mod, 'routeFailureForSupervision');

    const callOrder: string[] = [];
    mocks.customApi.listNamespacedCustomObject = vi.fn().mockImplementation(() => {
      callOrder.push('parent-list');
      return Promise.resolve({ items: [] });
    });

    const handler = buildHandler(deps, {
      enabled: true,
      router: {
        customApi: deps.customApi,
      } as unknown as Parameters<typeof buildHandler>[1] extends infer S
        ? S extends { router: infer R }
          ? R
          : never
        : never,
    });

    // Completed child (NOT failed) — supervision routing should
    // short-circuit on phase != Failed; default ordering applies.
    const completedChild = makeChildTask({ status: { phase: 'Completed' } });
    await handler.onUpdate(completedChild);

    // supervision-router call short-circuits before reaching the
    // strategy engine (phase != Failed). It MAY still be invoked by
    // `maybeRouteSupervision` per its current implementation — that
    // function gates on phase=Failed BEFORE calling the router. Per
    // current code the router is NOT called for non-failed phases.
    expect(spyRoute).not.toHaveBeenCalled();

    // Parent re-aggregate ran (the LIST call confirms the path
    // executed); default order means it happened during the normal
    // onUpdate sequence.
    expect(callOrder.indexOf('parent-list')).toBeGreaterThanOrEqual(0);
    spyRoute.mockRestore();
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
