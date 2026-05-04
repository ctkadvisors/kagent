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

import {
  API_GROUP,
  API_VERSION,
  type Agent,
  type AgentTask,
  type AgentTaskCondition,
  type OutputRef,
  isAgent,
} from './crds/index.js';
import type { CapabilityRegistry } from './capability-registry.js';
import { StubCapabilityRegistry } from './capability-registry.js';
import type { Dispatcher } from './dispatcher.js';
import { isDispatchPublished, markJobPublished, readJob, unsuspendJob } from './job-annotator.js';
import { buildJobSpec, type BuildJobSpecOptions, jobNameForTask } from './job-spec.js';
import { mergePatchOptions } from './k8s.js';
import { mergeCondition, nextPhase } from './status-transitions.js';
import {
  PARENT_TASK_UID_LABEL,
  aggregateChildren,
  cycleCheck,
  type ChildRef,
  type ParentStatusProjection,
} from './task-graph.js';
import {
  IdempotencyCache,
  deriveIdempotencyKey,
  hashTaskInputs,
  validateAgentTaskInputs,
  validateRequiredOutputsPresent,
} from './task-admission.js';

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
  /* ---- WS-I parent re-aggregate plumbing.
   * These three optional fields are forwarded by `buildHandler` ->
   * `maybeReconcileParent` -> `reconcileParentFromChildEvent`. They
   * are NOT consulted by the dispatch path itself; carving them onto
   * `ReconcileDeps` keeps the operator boot wiring (`main()`) building
   * a single dep object.
   *
   * Production wiring: `listChildrenForParent` reads the AgentTask
   * informer cache (`Informer<AgentTask>.list(namespace)` filtered by
   * the parent-uid label); `getTaskByUid` reads the same cache by uid
   * for cycle detection; `emitCycleEvent` writes a v1 Event via
   * CoreV1Api when a cycle trips. Tests typically leave them all
   * unset — the parent re-aggregate path falls back to a fresh
   * namespaced LIST and skips cycle detection (fail-open). */
  readonly listChildrenForParent?: (parentUid: string, namespace: string) => readonly AgentTask[];
  readonly getTaskByUid?: (uid: string) => AgentTask | undefined;
  readonly emitCycleEvent?: (
    parent: { readonly name: string; readonly namespace: string; readonly uid: string },
    cycle: readonly string[],
  ) => Promise<void>;
  /**
   * LLM-gateway bundle (spec §3.2) — when true, the dispatch path
   * STOPS short of un-suspending the Job. The Job stays in
   * `spec.suspend: true` after the dispatch envelope is published +
   * annotated; the admission reconciler (`admission.ts`) is the one
   * that flips `spec.suspend: false` once per-(model, namespace) +
   * per-Agent capacity allows it.
   *
   * Default `false` / undefined → today's WS-F behavior preserved
   * (reconcile un-suspends immediately after publish + annotate).
   * The chart's `llmGateway.enabled=true` flips
   * `KAGENT_ADMISSION_CONTROL_ENABLED=true` on the operator
   * deployment, which `main.ts` reads + threads here.
   */
  readonly admissionControlEnabled?: boolean;

  /* ---- v0.2.0-typed-io — Wave 1 / I/O sub-team.
   * Idempotency-key dedupe + contract-violation audit. The cache is
   * shared across reconciles — main.ts builds one and threads it
   * here. Tests typically inject a fresh `new IdempotencyCache()`. */

  /**
   * Operator-local idempotency cache. When supplied AND the task has
   * `spec.idempotencyKey` set, admission consults this BEFORE Job
   * creation:
   *   - hit + same input hash → mark Completed with the prior task's
   *     cached outputs; emit `task.deduped`.
   *   - hit + different input hash → mark Failed with
   *     `reason: 'IdempotencyConflict'`.
   *   - miss → store + proceed to normal admission.
   * Absent / undefined = idempotency dedupe is OFF (back-compat).
   */
  readonly idempotencyCache?: IdempotencyCache;

  /**
   * Optional audit-emission hook for `contract.violated` events. Wave
   * 0 Audit integration — main.ts wires this to the
   * `@kagent/audit-events` AuditPublisher in production. Best-effort
   * (the publisher swallows its own errors); a thrown promise here is
   * caught + logged so a buggy override never breaks dispatch.
   */
  readonly emitContractViolated?: (fields: ContractViolatedAuditFields) => Promise<void>;

  /**
   * Optional audit-emission hook for `task.deduped` events fired by
   * the idempotency cache replay path. Same best-effort contract.
   */
  readonly emitTaskDeduped?: (fields: TaskDedupedAuditFields) => Promise<void>;
}

/**
 * Audit fields for `contract.violated` events (Wave 0 / Audit
 * sub-team). Emitted on InvalidInputs (admission-time) AND
 * MissingRequiredOutputs (terminal-time, when the agent-pod's
 * Completed write doesn't satisfy the Agent.spec.outputs contract).
 */
export interface ContractViolatedAuditFields {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly reason: 'InvalidInputs' | 'MissingRequiredOutputs' | 'IdempotencyConflict';
  readonly message: string;
}

export interface TaskDedupedAuditFields {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly idempotencyKey: string;
  readonly originalTaskUid: string;
}

export interface ReconcileResult {
  /**
   * `admission-pending` is the LLM-gateway path: dispatch envelope
   * published + Job created suspended, but un-suspend is deferred to
   * the admission reconciler (`admission.ts`). Status stays Pending
   * — the AgentTask transitions to Dispatched only when admission
   * un-suspends the Job.
   *
   * v0.2.0-typed-io additions:
   * - `invalid-inputs`     → typed-input contract failed admission;
   *                          task marked Failed with structured reason.
   * - `idempotent-replay`  → idempotency cache hit (same input hash);
   *                          task marked Completed with cached outputs.
   * - `idempotency-conflict` → cache hit with DIFFERENT input hash;
   *                          task marked Failed.
   */
  readonly action:
    | 'skipped'
    | 'dispatched'
    | 'admission-pending'
    | 'failed'
    | 'invalid-inputs'
    | 'idempotent-replay'
    | 'idempotency-conflict';
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

  /* ---- v0.2.0-typed-io — Wave 1 / I/O sub-team.
   * Step 2.1 — typed-input admission validation. Runs after Agent
   * resolution so the validator has the target's spec.inputs[] in
   * hand. On failure: mark AgentTask Failed with structured
   * reason='InvalidInputs', emit `contract.violated` audit event,
   * skip Job creation.
   * Back-compat: a v0.1 Agent without inputs[] + a v0.1 task without
   * inputs[] passes the validator trivially (empty contract). */
  const inputValidation = validateAgentTaskInputs(agent, task);
  if (!inputValidation.ok) {
    await markFailed(
      task,
      `policy_denied:${inputValidation.reason} — ${inputValidation.message}`,
      deps,
    );
    await emitContractViolatedSafe(deps, task, agent, {
      reason: inputValidation.reason,
      message: inputValidation.message,
    });
    return { action: 'invalid-inputs', reason: inputValidation.message };
  }

  /* ---- v0.2.0-typed-io — Wave 1 / I/O sub-team.
   * Step 2.2 — idempotency-key dedupe. Operator-local in-memory cache
   * keyed by (namespace, agent name, idempotencyKey). Cache miss
   * (or no key set) → fall through to normal dispatch; cache hit
   * with same input hash → mark Completed with cached outputs +
   * emit `task.deduped`; cache hit with different input hash →
   * mark Failed with `IdempotencyConflict`. */
  const dedupeOutcome = await applyIdempotencyDedupe(task, agent, deps);
  if (dedupeOutcome !== null) {
    return dedupeOutcome;
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

  // Step 5 — publish the dispatch envelope to the bus, with a
  // deterministic dedupe ID (task UID). When the Job's
  // `dispatch-published` annotation is already set, skip — a previous
  // reconcile already published and broker dedupe doesn't need to be
  // retested. On publish failure, the Job stays SUSPENDED (never
  // scheduled), and the task is marked Failed.
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

    // Step 6 — annotate the Job so a future reconcile knows publish
    // already happened. Best-effort: the message is already on the bus,
    // and broker dedupe (Nats-Msg-Id = task.uid) handles the
    // re-publish on retry if this annotation patch fails.
    try {
      await markJobPublished(deps.batchApi, namespace, jobName);
    } catch (err) {
      console.error(
        `[kagent-operator] published task ${namespace}/${task.metadata.name ?? '?'} but FAILED to stamp dispatch-published annotation; broker dedupe will protect a re-publish:`,
        err,
      );
    }
  }

  // Step 7 — unsuspend so K8s schedules the pod. On failure, leave
  // status alone; the informer relist will re-fire reconcile and step 4
  // will see the published annotation, skip publish, and retry the
  // unsuspend.
  //
  // LLM-gateway bundle (spec §3.2): when admission control is enabled,
  // SKIP this step entirely — the admission reconciler
  // (`admission.ts`) is the only writer that may un-suspend, doing so
  // only when per-(model, namespace) + per-Agent capacity allows. The
  // dispatch envelope is already on the bus + the
  // `dispatch-published` annotation is set, so the agent-pod has
  // everything it needs the moment admission un-suspends. Status
  // stays Pending until then so the workbench surfaces "queued for
  // capacity" correctly.
  if (deps.admissionControlEnabled === true) {
    return { action: 'admission-pending', jobName };
  }
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

  // Step 8 — update AgentTask status to Dispatched. Routed through the
  // WS-E conflict-aware retry helper so a stale informer object can't
  // dispatch over the top of a terminal phase that landed between the
  // relist and this point. Append a `Dispatched` condition.
  const now = deps.now ?? (() => new Date());
  const ts = now().toISOString();
  await patchStatusWithRetry(task, deps.customApi, (current) => {
    const proposed = nextPhase(current.status?.phase, 'Dispatched');
    if (proposed === null) return null;
    return {
      phase: proposed,
      podName: jobName,
      startedAt: ts,
      observedGeneration: current.metadata.generation ?? 0,
      conditions: mergeCondition(current.status?.conditions, {
        type: 'Dispatched',
        status: 'True',
        reason: 'JobCreated',
        message: `Job ${jobName} created`,
        lastTransitionTime: ts,
        ...(current.metadata.generation !== undefined && {
          observedGeneration: current.metadata.generation,
        }),
      }),
    };
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
  /**
   * Optional informer-cache reader. When supplied, used instead of a
   * fresh `LIST agenttasks --label-selector=parent-task-uid=<uid>` API
   * call — see WS-I spec point 3 ("watch-cache discipline"). Returns
   * the parent's currently-known children from the operator's cached
   * AgentTask informer. Falls back to the API list when undefined
   * (the unit-test default; production wiring in main.ts always
   * supplies the cache reader).
   */
  readonly listChildren?: (parentUid: string, namespace: string) => readonly AgentTask[];
  /**
   * Optional UID → AgentTask lookup, sourced from the same informer
   * cache. Required for cycle detection — without it `cycleCheck` has
   * nothing to walk and we fail-open (existing behavior, per WS-I
   * spec point 7 "fail-open today"). When supplied, every projection
   * pass runs `cycleCheck(parent.uid, child.uid, getTaskByUid)` for
   * each child; any non-ok result aborts the patch and emits an Event.
   */
  readonly getTaskByUid?: (uid: string) => AgentTask | undefined;
  /**
   * Optional event emitter. Called when cycle detection trips. Receives
   * the parent identity (for the involvedObject ref) and the cycle path
   * (for the message body). Best-effort — failures are logged but not
   * propagated; the patch is still skipped regardless. When undefined
   * the operator only logs a warning.
   */
  readonly emitCycleEvent?: (
    parent: { readonly name: string; readonly namespace: string; readonly uid: string },
    cycle: readonly string[],
  ) => Promise<void>;
}

export type ReconcileParentFromChildAction =
  | {
      kind: 'updated';
      aggregatePhase: ParentStatusProjection['aggregatePhase'];
      childCount: number;
    }
  | {
      /**
       * Idempotency guard — projection equals the parent's existing
       * `status.children/aggregatePhase/successCount/failureCount/
       * inFlightCount`, so no PATCH is issued. Spec point 4: "must
       * produce zero K8s writes" when projection hasn't changed.
       */
      kind: 'unchanged';
      aggregatePhase: ParentStatusProjection['aggregatePhase'];
      childCount: number;
    }
  | { kind: 'skipped'; reason: 'not-found' | 'missing-uid' | 'cycle-detected' };

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

  // List children — prefer the informer-cache reader (WS-I spec point 3
  // "watch-cache discipline"). Falls back to a fresh namespaced LIST
  // for unit tests and any caller that hasn't wired the cache yet.
  let items: AgentTask[];
  if (deps.listChildren !== undefined) {
    items = [...deps.listChildren(parentUid, ref.namespace)];
  } else {
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
    items = Array.isArray(itemsRaw) ? (itemsRaw as AgentTask[]) : [];
  }

  // WS-I spec point 7 — cycle detection. With the cache reader present
  // (`getTaskByUid`), walk each child's parent chain back to the root.
  // If any child appears as an ancestor of the parent we're projecting,
  // the graph is corrupt; refuse the patch + emit a K8s Event so the
  // bug surfaces in `kubectl describe`. Without the lookup we fail
  // open (no-op cycle check), preserving prior behavior.
  if (deps.getTaskByUid !== undefined) {
    for (const child of items) {
      const childUid = child.metadata.uid;
      if (typeof childUid !== 'string' || childUid.length === 0) continue;
      const result = cycleCheck(parentUid, childUid, deps.getTaskByUid);
      if (!result.ok) {
        const cyclePath = result.cycle;
        console.warn(
          `[kagent-operator] AgentTaskCycleDetected on ${ref.namespace}/${ref.name} ` +
            `(parent uid=${parentUid}, offending child uid=${childUid}, ` +
            `cycle=${cyclePath.join(' → ')}); skipping projection patch`,
        );
        if (deps.emitCycleEvent !== undefined) {
          try {
            await deps.emitCycleEvent(
              { name: ref.name, namespace: ref.namespace, uid: parentUid },
              cyclePath,
            );
          } catch (err) {
            // Event emission is best-effort — never let a hiccup turn
            // a refusal-to-patch into a thrown exception that the
            // informer would log as a watch error.
            console.error(
              `[kagent-operator] failed to emit AgentTaskCycleDetected Event for ${ref.namespace}/${ref.name}:`,
              err,
            );
          }
        }
        return { kind: 'skipped', reason: 'cycle-detected' };
      }
    }
  }

  const projection = aggregateChildren(items);

  // WS-I spec point 4 — idempotency. Re-firing on every relist must
  // produce ZERO K8s writes when the projection hasn't changed. Diff
  // every field we own; if all match, return `unchanged` without
  // touching etcd. The diff is field-level (not just count-level) so
  // a stale `children[]` entry (e.g. a deleted child still in
  // parent.status) re-triggers the patch.
  if (projectionMatchesStatus(projection, parent.status)) {
    return {
      kind: 'unchanged',
      aggregatePhase: projection.aggregatePhase,
      childCount: projection.children.length,
    };
  }

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

/**
 * True iff every projection field matches the corresponding field on
 * `current` (the parent's existing `status`). Carved out so the
 * idempotency check stays close to the field set the writer owns —
 * if a future field is added to the projection, both this comparator
 * and `patchStatus`'s body need to learn about it.
 */
function projectionMatchesStatus(
  projection: ParentStatusProjection,
  current: AgentTask['status'] | undefined,
): boolean {
  if (current === undefined) return false;
  if (current.aggregatePhase !== projection.aggregatePhase) return false;
  if (current.successCount !== projection.successCount) return false;
  if (current.failureCount !== projection.failureCount) return false;
  if (current.inFlightCount !== projection.inFlightCount) return false;
  return childRefArraysEqual(current.children, projection.children);
}

function childRefArraysEqual(
  a: AgentTask['status'] extends infer S
    ? S extends { children?: infer C }
      ? C | undefined
      : never
    : never,
  b: readonly ChildRef[],
): boolean {
  if (a === undefined) return b.length === 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.name !== y.name) return false;
    if (x.namespace !== y.namespace) return false;
    if (x.uid !== y.uid) return false;
    if (x.phase !== y.phase) return false;
    if (x.completedAt !== y.completedAt) return false;
    if (x.error !== y.error) return false;
  }
  return true;
}

/* =====================================================================
 * v0.2.0-typed-io — typed-input + idempotency helpers.
 * ===================================================================== */

/**
 * Apply the operator-local idempotency-key dedupe BEFORE Job creation.
 * Returns:
 *   - null            → cache disabled, key absent, or miss → caller
 *                        proceeds with normal dispatch.
 *   - 'idempotent-replay'    → cache hit (same input hash). Task
 *                        has been marked Completed with cached
 *                        outputs; caller short-circuits.
 *   - 'idempotency-conflict' → cache hit (different input hash).
 *                        Task marked Failed; caller short-circuits.
 */
async function applyIdempotencyDedupe(
  task: AgentTask,
  agent: Agent,
  deps: ReconcileDeps,
): Promise<ReconcileResult | null> {
  if (deps.idempotencyCache === undefined) return null;
  const agentName = agent.metadata.name ?? '';
  const key = deriveIdempotencyKey(task, agentName);
  if (key === null) return null;

  const inputHash = hashTaskInputs(task);
  const taskUid = task.metadata.uid ?? '';
  const decision = deps.idempotencyCache.checkAndStore(key, inputHash, taskUid);

  if (decision.kind === 'miss') return null;

  if (decision.kind === 'replay') {
    // Stripe-pattern replay: surface the cached outputs verbatim, mark
    // Completed without ever invoking the agent loop. Best-effort
    // status patch — informer relist re-fires reconcile if it failed.
    await markCompletedFromIdempotentReplay(task, decision.outputs, deps);
    await emitTaskDedupedSafe(deps, task, agent, key.idempotencyKey, decision.originalTaskUid);
    return {
      action: 'idempotent-replay',
      reason: `replayed outputs from ${decision.originalTaskUid}`,
    };
  }

  // conflict
  const message =
    `idempotencyKey '${key.idempotencyKey}' was first used by task ` +
    `${decision.originalTaskUid} with a different input hash ` +
    `(stored=${decision.storedHash}, incoming=${decision.incomingHash}); ` +
    'idempotency requires same key + same inputs to dedupe.';
  await markFailed(task, `policy_denied:IdempotencyConflict — ${message}`, deps);
  await emitContractViolatedSafe(deps, task, agent, {
    reason: 'IdempotencyConflict',
    message,
  });
  return { action: 'idempotency-conflict', reason: message };
}

/**
 * Mark a task Completed with the cached outputs from an idempotent
 * replay. Mirrors the agent-pod's terminal status patch shape.
 * Routed through `patchStatusWithRetry` for the standard 409 + WS-E
 * regression-guard handling.
 */
async function markCompletedFromIdempotentReplay(
  task: AgentTask,
  outputs: readonly OutputRef[],
  deps: ReconcileDeps,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const ts = now().toISOString();
  try {
    await patchStatusWithRetry(task, deps.customApi, (current) => {
      const proposed = nextPhase(current.status?.phase, 'Completed');
      if (proposed === null) return null;
      return {
        phase: proposed,
        completedAt: ts,
        observedGeneration: current.metadata.generation ?? 0,
        outputs: [...outputs],
        conditions: mergeCondition(current.status?.conditions, {
          type: 'IdempotentReplay',
          status: 'True',
          reason: 'IdempotencyReplay',
          message: 'replayed cached outputs from prior task with same idempotencyKey',
          lastTransitionTime: ts,
          ...(current.metadata.generation !== undefined && {
            observedGeneration: current.metadata.generation,
          }),
        }),
      };
    });
  } catch (err) {
    console.error(
      `[kagent-operator] failed to patch idempotent-replay status for ${task.metadata.namespace ?? '?'}/${task.metadata.name ?? '?'}:`,
      err,
    );
  }
}

/**
 * v0.2.0-typed-io — observe an agent-pod's `phase=Completed` status
 * patch and validate that every required Agent output is present.
 * When the contract is violated, force the AgentTask back to Failed
 * via a raw merge-patch (bypassing WS-E's terminal-absorbing rule —
 * this is the operator overriding the agent-pod's terminal write,
 * which is structurally distinct from the regression cases WS-E
 * guards against).
 *
 * Idempotent: re-firing on every relist is safe — the operator
 * stamps a `MissingRequiredOutputs` condition the first time and
 * the merge-patch with `phase: Failed` is a no-op once landed.
 *
 * Returns one of:
 *   - 'no-op'           → phase != Completed, or no required outputs
 *                          declared, or all required outputs present.
 *   - 'forced-failed'   → required outputs missing; phase forced to
 *                          Failed; audit emitted; cache cleared.
 *   - 'cached-replay'   → required outputs present; if an idempotency
 *                          cache is wired, the outputs are recorded
 *                          for future replay.
 */
export async function enforceCompletionContract(
  task: AgentTask,
  agent: Agent,
  deps: ReconcileDeps,
): Promise<'no-op' | 'forced-failed' | 'cached-replay'> {
  if (task.status?.phase !== 'Completed') return 'no-op';

  const validation = validateRequiredOutputsPresent(agent, task.status.outputs);
  if (validation.ok) {
    // Successful Completed — record cached outputs for future replay
    // when an idempotency key was used.
    if (deps.idempotencyCache !== undefined) {
      const agentName = agent.metadata.name ?? '';
      const key = deriveIdempotencyKey(task, agentName);
      if (key !== null) {
        deps.idempotencyCache.recordOutputs(key, task.status.outputs ?? []);
      }
    }
    return 'cached-replay';
  }

  // Contract violation — force Failed via raw merge-patch. Skip
  // patchStatusWithRetry's nextPhase guard (Completed→Failed is the
  // intended override here). Append the structured condition so
  // observers see why.
  const now = deps.now ?? (() => new Date());
  const ts = now().toISOString();
  const namespace = task.metadata.namespace ?? 'default';
  const name = task.metadata.name;
  if (typeof name !== 'string' || name.length === 0) return 'no-op';

  const newCondition: AgentTaskCondition = {
    type: 'MissingRequiredOutputs',
    status: 'True',
    reason: validation.reason,
    message: validation.message,
    lastTransitionTime: ts,
    ...(task.metadata.generation !== undefined && {
      observedGeneration: task.metadata.generation,
    }),
  };

  try {
    await deps.customApi.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: 'agenttasks',
        name,
        body: {
          status: {
            phase: 'Failed' as const,
            error: `policy_denied:${validation.reason} — ${validation.message}`,
            completedAt: ts,
            ...(task.metadata.generation !== undefined && {
              observedGeneration: task.metadata.generation,
            }),
            conditions: mergeCondition(task.status?.conditions, newCondition),
          },
        },
      },
      mergePatchOptions,
    );
  } catch (err) {
    console.error(
      `[kagent-operator] failed to force AgentTask ${namespace}/${name} Failed for contract violation:`,
      err,
    );
    return 'no-op';
  }

  await emitContractViolatedSafe(deps, task, agent, {
    reason: validation.reason,
    message: validation.message,
  });

  // Clear any cached idempotency entry for this key — we don't want
  // a violated Completed to seed a future replay with broken outputs.
  if (deps.idempotencyCache !== undefined) {
    const agentName = agent.metadata.name ?? '';
    const key = deriveIdempotencyKey(task, agentName);
    if (key !== null) {
      deps.idempotencyCache.recordOutputs(key, []);
    }
  }
  return 'forced-failed';
}

/** Best-effort `contract.violated` audit emission. */
async function emitContractViolatedSafe(
  deps: ReconcileDeps,
  task: AgentTask,
  agent: Agent,
  fields: {
    readonly reason: ContractViolatedAuditFields['reason'];
    readonly message: string;
  },
): Promise<void> {
  if (deps.emitContractViolated === undefined) return;
  try {
    await deps.emitContractViolated({
      taskUid: task.metadata.uid ?? '',
      taskNamespace: task.metadata.namespace ?? 'default',
      taskName: task.metadata.name ?? '',
      agentName: agent.metadata.name ?? '',
      reason: fields.reason,
      message: fields.message,
    });
  } catch (err) {
    console.warn(
      '[kagent-operator] reconcile: emitContractViolated hook raised (audit dropped):',
      err,
    );
  }
}

/** Best-effort `task.deduped` audit emission. */
async function emitTaskDedupedSafe(
  deps: ReconcileDeps,
  task: AgentTask,
  agent: Agent,
  idempotencyKey: string,
  originalTaskUid: string,
): Promise<void> {
  if (deps.emitTaskDeduped === undefined) return;
  try {
    await deps.emitTaskDeduped({
      taskUid: task.metadata.uid ?? '',
      taskNamespace: task.metadata.namespace ?? 'default',
      taskName: task.metadata.name ?? '',
      agentName: agent.metadata.name ?? '',
      idempotencyKey,
      originalTaskUid,
    });
  } catch (err) {
    console.warn(
      '[kagent-operator] reconcile: emitTaskDeduped hook raised (audit dropped):',
      err,
    );
  }
}
