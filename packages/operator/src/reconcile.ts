/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Reconcile loop — the core operator behavior. Called by watch.ts on
 * every AgentTask add/update event.
 *
 * Steps (all idempotent; reconcile is safe to invoke multiple times
 * for the same task):
 *
 *   1. Skip if status.phase is already terminal (Completed | Failed)
 *      OR already 'Dispatched' (Phase 2 stops at dispatch; Phase 3
 *      will resume to watch for completion).
 *   2. Resolve the target Agent. If targetAgent is set, fetch by name.
 *      If targetCapability is set, Phase 2 fails fast (capability
 *      resolution lands in Phase 3 with the NATS KV registry).
 *   3. Build the Job spec, create it. AlreadyExists is treated as a
 *      successful idempotent path.
 *   4. Call Dispatcher.publish to put the task assignment on the bus.
 *      (Phase 2 is StubDispatcher; Phase 3 is real NATS.)
 *   5. Update AgentTask.status: phase=Dispatched, podName=<job>,
 *      startedAt=now.
 *
 * On any failure: status.phase = Failed with error message.
 */

import type { BatchV1Api, CustomObjectsApi, V1Job } from '@kubernetes/client-node';

import {
  API_GROUP,
  API_VERSION,
  type Agent,
  type AgentTask,
  type AgentTaskCondition,
  isAgent,
} from './crds/index.js';
import type { CapabilityRegistry } from './capability-registry.js';
import { StubCapabilityRegistry } from './capability-registry.js';
import type { Dispatcher } from './dispatcher.js';
import { buildJobSpec, type BuildJobSpecOptions, jobNameForTask } from './job-spec.js';
import { mergePatchOptions } from './k8s.js';
import { mergeCondition, nextPhase } from './status-transitions.js';
import {
  PARENT_TASK_UID_LABEL,
  aggregateChildren,
  type ChildRef,
  type ParentStatusProjection,
} from './task-graph.js';

export interface ReconcileDeps {
  readonly customApi: CustomObjectsApi;
  readonly batchApi: BatchV1Api;
  readonly dispatcher: Dispatcher;
  /**
   * Resolves AgentTask.spec.targetCapability → agent name. Optional;
   * defaults to a stub that always returns null (matches Phase 2
   * behavior where capability resolution fast-failed).
   */
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly jobSpecOptions?: BuildJobSpecOptions;
  /** Override `Date.now()` in tests for deterministic timestamps. */
  readonly now?: () => Date;
}

export interface ReconcileResult {
  readonly action: 'skipped' | 'dispatched' | 'failed';
  readonly reason?: string;
  readonly jobName?: string;
}

/**
 * Reconcile a single AgentTask. Returns the action taken — useful for
 * test assertions and operator-side metrics. Errors during status
 * update are logged but not re-thrown (a failed status update is
 * recoverable via the next watch event).
 */
export async function reconcileAgentTask(
  task: AgentTask,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const phase = task.status?.phase;
  if (phase === 'Completed' || phase === 'Failed' || phase === 'Dispatched') {
    return { action: 'skipped', reason: `phase=${phase}` };
  }

  // Step 2 — resolve target Agent.
  const registry = deps.capabilityRegistry ?? new StubCapabilityRegistry();
  let agent: Agent;
  try {
    agent = await resolveTargetAgent(task, deps.customApi, registry);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markFailed(task, reason, deps);
    return { action: 'failed', reason };
  }

  // Step 3 — build + create the Job.
  const job = buildJobSpec(agent, task, deps.jobSpecOptions);
  try {
    await createJobIdempotent(job, deps.batchApi);
  } catch (err) {
    const reason = err instanceof Error ? `job creation failed: ${err.message}` : String(err);
    await markFailed(task, reason, deps);
    return { action: 'failed', reason };
  }

  // Step 4 — publish to the bus.
  try {
    await deps.dispatcher.publish({
      taskId: task.metadata.uid ?? '',
      agentId: agent.metadata.name ?? '',
      ...(task.spec.parentTask !== undefined && { parentTaskId: task.spec.parentTask }),
      originalUserMessage: task.spec.originalUserMessage ?? '',
      ...(task.spec.parentDistillation !== undefined && {
        parentDistillation: task.spec.parentDistillation,
      }),
      ...(task.spec.expectedTools !== undefined && {
        expectedTools: task.spec.expectedTools,
      }),
      payload: task.spec.payload,
    });
  } catch (err) {
    const reason = err instanceof Error ? `dispatch failed: ${err.message}` : String(err);
    await markFailed(task, reason, deps);
    return { action: 'failed', reason };
  }

  // Step 5 — update status. Routed through the conflict-aware retry
  // helper so a stale informer object can't dispatch over the top of
  // a terminal phase that landed between the relist and this point.
  const now = deps.now ?? (() => new Date());
  const ts = now().toISOString();
  await patchStatusWithRetry(task, deps.customApi, (current) => {
    const proposed = nextPhase(current.status?.phase, 'Dispatched');
    if (proposed === null) return null;
    return {
      phase: proposed,
      podName: jobNameForTask(task),
      startedAt: ts,
      observedGeneration: current.metadata.generation ?? 0,
      conditions: mergeCondition(current.status?.conditions, {
        type: 'Dispatched',
        status: 'True',
        reason: 'JobCreated',
        message: `Job ${jobNameForTask(task)} created`,
        lastTransitionTime: ts,
        ...(current.metadata.generation !== undefined && {
          observedGeneration: current.metadata.generation,
        }),
      }),
    };
  });

  return { action: 'dispatched', jobName: jobNameForTask(task) };
}

/**
 * Fetch the target Agent for a task. Two paths:
 *   - `targetAgent` set → fetch by name from the same namespace.
 *   - `targetCapability` set → ask the CapabilityRegistry to resolve
 *     it to an agent name, then fetch.
 *
 * Per docs/DESIGN-V0.1.md §4.1, exactly one of {targetAgent,
 * targetCapability} must be set; the CRD's `oneOf` schema enforces
 * this at admission, but we re-check defensively.
 */
async function resolveTargetAgent(
  task: AgentTask,
  customApi: CustomObjectsApi,
  registry: CapabilityRegistry,
): Promise<Agent> {
  const namespace = task.metadata.namespace ?? 'default';
  let agentName: string | undefined;

  if (typeof task.spec.targetAgent === 'string' && task.spec.targetAgent.length > 0) {
    agentName = task.spec.targetAgent;
  } else if (
    typeof task.spec.targetCapability === 'string' &&
    task.spec.targetCapability.length > 0
  ) {
    const resolved = await registry.resolveCapability(task.spec.targetCapability);
    if (resolved === null) {
      throw new Error(
        `no live agent satisfies capability '${task.spec.targetCapability}' ` +
          `(check NATS KV registry; agent pods write heartbeats on boot)`,
      );
    }
    agentName = resolved;
  } else {
    throw new Error('AgentTask has neither targetAgent nor targetCapability');
  }

  /* eslint-disable @typescript-eslint/no-unsafe-assignment */
  const res = await customApi.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace,
    plural: 'agents',
    name: agentName,
  });
  /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  if (!isAgent(res)) {
    throw new Error(`Agent ${namespace}/${agentName} returned malformed shape`);
  }
  return res;
}

/**
 * Create the Job; treat 409 AlreadyExists as success (idempotent
 * reconcile on retry/duplicate watch event).
 */
async function createJobIdempotent(job: V1Job, batchApi: BatchV1Api): Promise<void> {
  const namespace = job.metadata?.namespace ?? 'default';
  try {
    await batchApi.createNamespacedJob({ namespace, body: job });
  } catch (err) {
    if (isAlreadyExists(err)) return;
    throw err;
  }
}

/**
 * Match either the v0.x `{ statusCode: 409 }` shape or the v1.x
 * `ApiException` with `code: 409`. The k8s client error shape varies
 * by call path; checking both keeps reconcile resilient across patch
 * versions.
 */
function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 409 || e.statusCode === 409;
}

async function markFailed(task: AgentTask, reason: string, deps: ReconcileDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const ts = now().toISOString();
  try {
    await patchStatusWithRetry(task, deps.customApi, (current) => {
      const proposed = nextPhase(current.status?.phase, 'Failed');
      // If the task is already Completed, never overwrite — the agent-pod
      // wrote success between the dispatch error and this fallback. The
      // outer reconcile error path is the cause; conditions[] still gets
      // an entry for visibility.
      if (proposed === null) {
        return {
          observedGeneration: current.metadata.generation ?? 0,
          conditions: mergeCondition(current.status?.conditions, {
            type: 'ReconcileError',
            status: 'True',
            reason: 'ReconcileFailedAfterTerminal',
            message: reason,
            lastTransitionTime: ts,
            ...(current.metadata.generation !== undefined && {
              observedGeneration: current.metadata.generation,
            }),
          }),
        };
      }
      return {
        phase: proposed,
        error: reason,
        completedAt: ts,
        observedGeneration: current.metadata.generation ?? 0,
        conditions: mergeCondition(current.status?.conditions, {
          type: 'Failed',
          status: 'True',
          reason: 'ReconcileError',
          message: reason,
          lastTransitionTime: ts,
          ...(current.metadata.generation !== undefined && {
            observedGeneration: current.metadata.generation,
          }),
        }),
      };
    });
  } catch (err) {
    // Status patch is best-effort; surface but don't propagate.
    console.error(
      `[kagent-operator] failed to patch status for ${task.metadata.namespace ?? '?'}/${task.metadata.name ?? '?'}:`,
      err,
    );
  }
}

interface StatusPatch {
  phase?: 'Pending' | 'Dispatched' | 'Completed' | 'Failed';
  podName?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** WS-E — see status-transitions.ts. */
  observedGeneration?: number;
  /** WS-E — append-only conditions list. */
  conditions?: readonly AgentTaskCondition[];
  /* ---- Workstream 5 / Phase 5 — child-aggregation projection.
   * Operator-owned (NOT agent-pod-owned). `reconcileParentFromChildEvent`
   * is the only writer. Carved out separately from `phase` so terminal
   * parents (Completed/Failed) keep getting children/aggregatePhase
   * refreshes as their children move through state. See TASK-GRAPH.md §4. */
  children?: readonly ChildRef[];
  aggregatePhase?: ParentStatusProjection['aggregatePhase'];
  successCount?: number;
  failureCount?: number;
  inFlightCount?: number;
}

async function patchStatus(
  task: AgentTask,
  customApi: CustomObjectsApi,
  patch: StatusPatch,
): Promise<void> {
  const namespace = task.metadata.namespace ?? 'default';
  const name = task.metadata.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('AgentTask is missing metadata.name');
  }
  await customApi.patchNamespacedCustomObjectStatus(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: 'agenttasks',
      name,
      body: { status: patch },
    },
    mergePatchOptions,
  );
}

/* =====================================================================
 * patchStatusWithRetry — WS-E.
 *
 * Read-build-write cycle that gives every status writer a fresh view of
 * the cluster's current state before computing the patch. The `build`
 * closure is invoked on each attempt with the freshly fetched object;
 * if it returns `null` the patch is treated as a no-op regression and
 * skipped (caller gets `{kind:'skipped', reason:'regression'}`).
 *
 * On a 409 conflict (concurrent writer) we retry up to `maxRetries`
 * times, re-reading the object on each attempt. On 404 we surface
 * `{kind:'skipped', reason:'not-found'}` (the AgentTask was deleted out
 * from under us — owner-GC race or operator-issued DELETE).
 *
 * ## Why a read-build-write cycle and not server-side
 * `replace-status` with metadata.resourceVersion?
 *
 * Kubernetes' merge-patch on the status subresource doesn't honor a
 * caller-supplied `metadata.resourceVersion` the way `replace-status`
 * (PUT) does. Switching every status writer to PUT would force us to
 * resend the full status object every time — including fields owned by
 * other writers (the agent-pod's `result`, the parent re-reconcile's
 * `children/aggregatePhase`). That couples writers we explicitly want
 * to keep loosely coupled. Read-build-write gives us the same effective
 * regression guard (the build closure inspects `current.status.phase`
 * and refuses backward transitions) while keeping each writer's patch
 * narrowly scoped to the fields it owns.
 *
 * The cost is a small race window between GET and PATCH where another
 * writer can land first. The 409 retry loop closes most of it; the
 * `nextPhase()` regression check inside the build closure closes the
 * rest (a write that races a terminal phase is rejected on the next
 * attempt's GET).
 * ===================================================================== */

export type PatchStatusResult =
  | { kind: 'patched' }
  | { kind: 'skipped'; reason: 'regression' | 'not-found' }
  | { kind: 'failed'; error: Error };

export async function patchStatusWithRetry(
  task: AgentTask,
  customApi: CustomObjectsApi,
  build: (current: AgentTask) => StatusPatch | null,
  maxRetries = 3,
): Promise<PatchStatusResult> {
  const namespace = task.metadata.namespace ?? 'default';
  const name = task.metadata.name;
  if (typeof name !== 'string' || name.length === 0) {
    return { kind: 'failed', error: new Error('AgentTask is missing metadata.name') };
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let current: AgentTask;
    try {
      /* eslint-disable @typescript-eslint/no-unsafe-assignment */
      const res = await customApi.getNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: 'agenttasks',
        name,
      });
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */
      current = res as AgentTask;
    } catch (err) {
      if (isNotFound(err)) return { kind: 'skipped', reason: 'not-found' };
      lastErr = err;
      // GET failures are not retryable except for transient errors —
      // surface immediately to keep behavior simple.
      throw err;
    }

    const patch = build(current);
    if (patch === null) {
      return { kind: 'skipped', reason: 'regression' };
    }

    try {
      await customApi.patchNamespacedCustomObjectStatus(
        {
          group: API_GROUP,
          version: API_VERSION,
          namespace,
          plural: 'agenttasks',
          name,
          body: { status: patch },
        },
        mergePatchOptions,
      );
      return { kind: 'patched' };
    } catch (err) {
      lastErr = err;
      if (isNotFound(err)) return { kind: 'skipped', reason: 'not-found' };
      if (!isConflict(err)) {
        throw err;
      }
      // 409 — loop and re-read.
    }
  }
  // Exhausted retries — surface the last conflict as a thrown error so
  // callers (markFailed's catch, etc.) can log + move on.
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`patchStatusWithRetry: exhausted ${maxRetries} retries`);
}

function isConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 409 || e.statusCode === 409;
}

/**
 * External entry point — used by the Job/Pod watcher to mark an
 * AgentTask Failed when its underlying K8s primitives died before the
 * agent-pod could write status itself (image pull failures, OOMKill,
 * unschedulable pod, etc).
 *
 * Reads the current AgentTask first to avoid clobbering a Completed
 * status the agent-pod successfully wrote in the same window. Returns
 * the action taken so the watcher can log usefully.
 */
export interface MarkFailureDeps {
  readonly customApi: CustomObjectsApi;
  readonly now?: () => Date;
}

export type MarkFailureAction =
  | { kind: 'marked-failed'; previousPhase: string }
  | { kind: 'condition-appended'; previousPhase: 'Completed' | 'Failed' }
  | { kind: 'skipped'; reason: 'not-found' };

/**
 * WS-E behavior:
 *   - Pending / Dispatched / unset → write `phase=Failed` AND append a
 *     condition with the failure context.
 *   - Completed → DO NOT overwrite phase. Append a
 *     `JobFailedAfterComplete` condition so the post-success failure
 *     stays visible without erasing the success signal.
 *   - Failed → append a fresh condition (multiple failure modes — image
 *     pull → OOM → etc — all stay observable).
 *
 * Both branches go through `patchStatusWithRetry`; the build closure
 * uses `nextPhase()` to enforce monotonicity and re-reads on 409.
 */
export async function markAgentTaskFailedFromExternal(
  ref: { readonly namespace: string; readonly name: string },
  failure: { readonly reason: string; readonly message: string; readonly source: 'job' | 'pod' },
  deps: MarkFailureDeps,
): Promise<MarkFailureAction> {
  const now = deps.now ?? (() => new Date());
  const ts = now().toISOString();
  const errorPrefix = `[${failure.source}/${failure.reason}] `;

  // Probe for the not-found case so the early-return contract still
  // holds. `patchStatusWithRetry` re-fetches inside its loop, so a
  // disappearing object between this probe and the loop is handled too.
  // Carrying the synthetic AgentTask shape avoids a redundant GET when
  // the object is present (the helper does its own fresh GET inside).
  const probeTask: AgentTask = {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'AgentTask',
    metadata: { namespace: ref.namespace, name: ref.name },
    spec: { payload: null },
  };

  // Tracked across the build closure invocation. Annotate the union
  // explicitly so TS doesn't narrow on the seed value.
  type ResolvedKind = 'marked-failed' | 'condition-appended';
  const state: { previousPhase: string | undefined; kind: ResolvedKind } = {
    previousPhase: undefined,
    kind: 'marked-failed',
  };

  const result = await patchStatusWithRetry(probeTask, deps.customApi, (current) => {
    const phase = current.status?.phase;
    state.previousPhase = phase;

    const conditionType =
      phase === 'Completed'
        ? 'JobFailedAfterComplete'
        : phase === 'Failed'
          ? failure.reason || 'AdditionalFailure'
          : 'Failed';

    const newCondition: AgentTaskCondition = {
      type: conditionType,
      status: 'True',
      reason: failure.reason,
      message: errorPrefix + failure.message,
      lastTransitionTime: ts,
      ...(current.metadata.generation !== undefined && {
        observedGeneration: current.metadata.generation,
      }),
    };

    if (phase === 'Completed' || phase === 'Failed') {
      // Additive only — never overwrite a terminal phase.
      state.kind = 'condition-appended';
      return {
        observedGeneration: current.metadata.generation ?? 0,
        conditions: mergeCondition(current.status?.conditions, newCondition),
      };
    }

    // Pending / Dispatched / unset → mark Failed AND record condition.
    const proposed = nextPhase(phase, 'Failed');
    if (proposed === null) {
      // Defensive — shouldn't be reachable given the branch above.
      state.kind = 'condition-appended';
      return {
        observedGeneration: current.metadata.generation ?? 0,
        conditions: mergeCondition(current.status?.conditions, newCondition),
      };
    }
    state.kind = 'marked-failed';
    return {
      phase: proposed,
      error: errorPrefix + failure.message,
      completedAt: ts,
      observedGeneration: current.metadata.generation ?? 0,
      conditions: mergeCondition(current.status?.conditions, newCondition),
    };
  });

  if (result.kind === 'skipped' && result.reason === 'not-found') {
    return { kind: 'skipped', reason: 'not-found' };
  }
  if (result.kind === 'skipped' && result.reason === 'regression') {
    // Build closure refused — the append-only branches always return a
    // patch so this is unreachable in practice. Surface a condition-
    // appended verdict so callers never see an unhandled case.
    const prior = state.previousPhase;
    return {
      kind: 'condition-appended',
      previousPhase: prior === 'Completed' || prior === 'Failed' ? prior : 'Failed',
    };
  }

  if (state.kind === 'condition-appended') {
    const prior = state.previousPhase;
    return {
      kind: 'condition-appended',
      previousPhase: prior === 'Completed' || prior === 'Failed' ? prior : 'Failed',
    };
  }
  return { kind: 'marked-failed', previousPhase: state.previousPhase ?? '(unset)' };
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 404 || e.statusCode === 404;
}

/* =====================================================================
 * reconcileParentFromChildEvent
 *
 * External entry point — called by the AgentTask informer in `main.ts`
 * whenever an AgentTask event resolves to a parent ref via
 * `parentTaskRefFromChild` (label, annotation, or ownerRef). Mirrors
 * the shape of `markAgentTaskFailedFromExternal`: read the parent,
 * decide an action, patch a NARROWLY-SCOPED slice of status, return an
 * action verdict.
 *
 * Responsibility split (parallel to failure-detector ↔ reconcile):
 *
 *   - failure-detector / job-watch  → owns `status.phase=Failed` writes
 *     when Job/Pod terminal states race ahead of the agent-pod.
 *   - reconcileParentFromChildEvent → owns `status.children` /
 *     `status.aggregatePhase` projection. NEVER touches `status.phase`,
 *     so terminal parents (Completed/Failed) still get their child
 *     projection refreshed on subsequent child events.
 *
 * Idempotent: re-firing on every relist (informer resync) writes the
 * same projection; merge-patch semantics make the no-op cheap.
 * ===================================================================== */

export interface ReconcileParentFromChildDeps {
  readonly customApi: CustomObjectsApi;
}

export type ReconcileParentFromChildAction =
  | {
      kind: 'updated';
      aggregatePhase: ParentStatusProjection['aggregatePhase'];
      childCount: number;
    }
  | { kind: 'skipped'; reason: 'not-found' | 'missing-uid' };

/**
 * Re-aggregate a parent AgentTask's child projection. Steps:
 *
 *   1. GET the parent. 404 → `{ kind: 'skipped', reason: 'not-found' }`
 *      (the parent may have been deleted between the child event and
 *      this reconcile firing — race vs. cascade-GC).
 *   2. Confirm `metadata.uid` is present. Without it we cannot construct
 *      a label selector for the children list — extremely defensive,
 *      should never happen for a CR returned by the apiserver.
 *   3. LIST all AgentTasks in the parent's namespace whose
 *      `kagent.knuteson.io/parent-task-uid` label matches the parent's
 *      UID. The label was stamped on each child by
 *      `buildChildTaskManifest` in `task-graph.ts`.
 *   4. Run `aggregateChildren` (pure helper) to fold the list into a
 *      `ParentStatusProjection`.
 *   5. PATCH parent.status with the projection. Crucially, the patch
 *      body NEVER includes `phase` — that field's ownership stays with
 *      the agent-pod (success path) and `markAgentTaskFailedFromExternal`
 *      (failure path).
 */
export async function reconcileParentFromChildEvent(
  ref: { readonly namespace: string; readonly name: string },
  deps: ReconcileParentFromChildDeps,
): Promise<ReconcileParentFromChildAction> {
  let parent: AgentTask | undefined;
  try {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await deps.customApi.getNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: ref.namespace,
      plural: 'agenttasks',
      name: ref.name,
    });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    parent = res as AgentTask;
  } catch (err) {
    if (isNotFound(err)) return { kind: 'skipped', reason: 'not-found' };
    throw err;
  }

  const parentUid = parent.metadata.uid;
  if (typeof parentUid !== 'string' || parentUid.length === 0) {
    return { kind: 'skipped', reason: 'missing-uid' };
  }

  // LIST children — namespaced because children always live in the same
  // namespace as their parent (enforced by `buildChildTaskManifest`).
  /* eslint-disable @typescript-eslint/no-unsafe-assignment */
  const listRes = await deps.customApi.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ref.namespace,
    plural: 'agenttasks',
    labelSelector: `${PARENT_TASK_UID_LABEL}=${parentUid}`,
  });
  /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  const itemsRaw = (listRes as { items?: unknown }).items;
  const items: AgentTask[] = Array.isArray(itemsRaw) ? (itemsRaw as AgentTask[]) : [];

  const projection = aggregateChildren(items);

  // Narrow patch — children/aggregatePhase only. NEVER includes `phase`.
  await patchStatus(parent, deps.customApi, {
    children: projection.children,
    aggregatePhase: projection.aggregatePhase,
    successCount: projection.successCount,
    failureCount: projection.failureCount,
    inFlightCount: projection.inFlightCount,
  });

  return {
    kind: 'updated',
    aggregatePhase: projection.aggregatePhase,
    childCount: projection.children.length,
  };
}
