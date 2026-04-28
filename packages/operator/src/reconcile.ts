/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Reconcile loop — the core operator behavior. Called by watch.ts on
 * every AgentTask add/update event.
 *
 * WS-F suspended-publish ordering. The dispatch sequence is split into
 * three durable steps so a crash anywhere is recoverable without
 * double-firing the bus or orphaning work:
 *
 *   1. Skip if status.phase is already terminal (Completed | Failed)
 *      OR already 'Dispatched' (Phase 2 stops at dispatch; Phase 3
 *      will resume to watch for completion).
 *   2. Resolve the target Agent.
 *   3. Build a SUSPENDED Job spec (`spec.suspend: true`) and create
 *      it. K8s holds off scheduling the pod. AlreadyExists (409) on
 *      retry is treated as success — the Job's annotations carry the
 *      "did we publish?" marker, not its existence.
 *   4. Re-read the Job by name and inspect its annotations:
 *      - If `kagent.knuteson.io/dispatch-published: "true"` is set,
 *        skip the publish (this is a re-reconcile after an earlier
 *        successful publish; we just need to unsuspend).
 *      - Otherwise, publish to the bus with `dedupeId = task.uid`
 *        so the broker's dedupe (JetStream `Nats-Msg-Id`) drops any
 *        duplicate from a re-reconcile after annotation-patch failure.
 *   5. Stamp `dispatch-published: "true"` on the Job. Failure here
 *      is non-fatal (the bus already has the message; broker dedupe
 *      handles the re-publish on retry — see step 4).
 *   6. Patch `spec.suspend: false` to release K8s scheduling.
 *   7. Patch AgentTask.status: phase=Dispatched, podName, startedAt.
 *
 * Failure-mode behavior:
 *   - Step 4 publish fails  → leave Job suspended; mark AgentTask
 *     Failed with reason "publish failed"; operator recovers via a
 *     fresh AgentTask or external Failed-status clear.
 *   - Step 5 mark fails     → log loudly; treat as success (the
 *     message is on the bus; re-reconcile re-publishes; broker dedupe
 *     drops it — see WS-F dedupeId design).
 *   - Step 6 unsuspend fails → log loudly; status stays as-is;
 *     informer relist re-fires reconcile and retries.
 *
 * On any earlier failure (Agent resolution, Job creation): status.phase
 * = Failed with error message.
 */

import type { BatchV1Api, CustomObjectsApi, V1Job } from '@kubernetes/client-node';

import { API_GROUP, API_VERSION, type Agent, type AgentTask, isAgent } from './crds/index.js';
import type { CapabilityRegistry } from './capability-registry.js';
import { StubCapabilityRegistry } from './capability-registry.js';
import type { Dispatcher } from './dispatcher.js';
import { isDispatchPublished, markJobPublished, readJob, unsuspendJob } from './job-annotator.js';
import { buildJobSpec, type BuildJobSpecOptions, jobNameForTask } from './job-spec.js';
import { mergePatchOptions } from './k8s.js';
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

  // Step 3 — build + create the Job, SUSPENDED. K8s won't schedule
  // the pod until step 6 patches `spec.suspend: false`. The reconcile
  // loop forwards the operator's `jobSpecOptions` (image/env/PVC/etc)
  // and sets `suspend: true` over the top — operators stay free to
  // override the rest, but the suspended-create invariant is owned by
  // reconcile.
  const job = buildJobSpec(agent, task, { ...deps.jobSpecOptions, suspend: true });
  const namespace = task.metadata.namespace ?? 'default';
  const jobName = jobNameForTask(task);
  try {
    await createJobIdempotent(job, deps.batchApi);
  } catch (err) {
    const reason = err instanceof Error ? `job creation failed: ${err.message}` : String(err);
    await markFailed(task, reason, deps);
    return { action: 'failed', reason };
  }

  // Step 4 — decide whether to publish. The Job's
  // `dispatch-published: "true"` annotation is the durable "we already
  // published" marker; absence means publish was either never attempted
  // (first reconcile) or failed mid-flight (retry path). Re-read the
  // Job (not the cached `job` we just built) so a 409 retry sees the
  // server's annotations.
  let alreadyPublished = false;
  try {
    const live = await readJob(deps.batchApi, namespace, jobName);
    alreadyPublished = isDispatchPublished(live);
  } catch (err) {
    // A read failure here is non-fatal — we'd rather re-publish (broker
    // dedupe handles it) than leave the Job suspended forever. Log and
    // proceed with `alreadyPublished = false`.
    console.error(
      `[kagent-operator] failed to re-read Job ${namespace}/${jobName} for annotation check; proceeding with publish:`,
      err,
    );
  }

  if (!alreadyPublished) {
    try {
      await deps.dispatcher.publish(
        {
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
        },
        { dedupeId: task.metadata.uid ?? '' },
      );
    } catch (err) {
      const reason = err instanceof Error ? `dispatch failed: ${err.message}` : String(err);
      // Job stays suspended — never scheduled. Mark task Failed.
      await markFailed(task, reason, deps);
      return { action: 'failed', reason };
    }

    // Step 5 — annotate the Job so a future reconcile knows publish
    // already happened. JSDoc on `markJobPublished` documents the
    // failure-mode contract: we treat this as best-effort — the
    // message is already on the bus, and broker dedupe (Nats-Msg-Id =
    // task.uid) handles the re-publish on retry.
    try {
      await markJobPublished(deps.batchApi, namespace, jobName);
    } catch (err) {
      console.error(
        `[kagent-operator] published task ${namespace}/${task.metadata.name ?? '?'} but FAILED to stamp dispatch-published annotation; broker dedupe will protect a re-publish:`,
        err,
      );
    }
  }

  // Step 6 — unsuspend so K8s schedules the pod. On failure, leave
  // status alone; the informer relist will re-fire reconcile and step 4
  // will see the published annotation, skip publish, and retry the
  // unsuspend.
  try {
    await unsuspendJob(deps.batchApi, namespace, jobName);
  } catch (err) {
    console.error(
      `[kagent-operator] failed to unsuspend Job ${namespace}/${jobName}; informer relist will retry:`,
      err,
    );
    // Don't mark Failed — this is recoverable. Don't mark Dispatched
    // either — the pod hasn't started.
    return { action: 'failed', reason: 'unsuspend failed' };
  }

  // Step 7 — update AgentTask status to Dispatched.
  const now = deps.now ?? (() => new Date());
  await patchStatus(task, deps.customApi, {
    phase: 'Dispatched',
    podName: jobName,
    startedAt: now().toISOString(),
  });

  return { action: 'dispatched', jobName };
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
  try {
    await patchStatus(task, deps.customApi, {
      phase: 'Failed',
      error: reason,
      completedAt: now().toISOString(),
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
  | { kind: 'skipped'; reason: 'already-completed' | 'already-failed' | 'not-found' };

export async function markAgentTaskFailedFromExternal(
  ref: { readonly namespace: string; readonly name: string },
  failure: { readonly reason: string; readonly message: string; readonly source: 'job' | 'pod' },
  deps: MarkFailureDeps,
): Promise<MarkFailureAction> {
  const now = deps.now ?? (() => new Date());
  let current: AgentTask | undefined;
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
    current = res as AgentTask;
  } catch (err) {
    if (isNotFound(err)) return { kind: 'skipped', reason: 'not-found' };
    throw err;
  }

  const phase = current?.status?.phase;
  if (phase === 'Completed') return { kind: 'skipped', reason: 'already-completed' };
  if (phase === 'Failed') return { kind: 'skipped', reason: 'already-failed' };

  const errorPrefix = `[${failure.source}/${failure.reason}] `;
  await patchStatus(current, deps.customApi, {
    phase: 'Failed',
    error: errorPrefix + failure.message,
    completedAt: now().toISOString(),
  });
  return { kind: 'marked-failed', previousPhase: phase ?? '(unset)' };
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
 * whenever a child AgentTask event fires (any AgentTask carrying the
 * `kagent.knuteson.io/parent-task-name` label). Mirrors the shape of
 * `markAgentTaskFailedFromExternal`: read the parent, decide an action,
 * patch a NARROWLY-SCOPED slice of status, return an action verdict.
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
