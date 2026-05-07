/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 2 / Supervision sub-team — operator-side routing for the
 * supervision strategy engine. Wraps `@kagent/supervision`'s pure
 * decision core with the K8s I/O the operator needs:
 *
 *   1. classify the failure (structured vs infra)
 *   2. if infra → emit `infra.fault.observed`, do nothing more
 *   3. if structured → resolve the parent AgentTask + parent Agent
 *   4. fetch sibling AgentTasks via the
 *      `kagent.knuteson.io/parent-task-uid` informer-cache reader
 *   5. call `evaluateStrategy(strategy, failure, siblings)`
 *   6. enforce `maxRestarts` cap on `restart` actions
 *      (fail-closed with `reason: restart_limit_exceeded`)
 *   7. dispatch each `targets[]` action to the right K8s primitive:
 *        - terminate-and-restart-{tree,subset} → mark targets Failed
 *          with `reason: supervision_terminated` (operator's pure
 *          dispatch gives them a fresh terminal state; the operator
 *          does NOT recreate the underlying agent jobs in v0.3.1
 *          — re-issuing the AgentTask is the application's
 *          responsibility, the substrate just carved out a clean
 *          slate)
 *        - restart → patch `status.restartCount += 1` (defer the
 *          actual job recreation to the operator's standard
 *          dispatch path on the next informer event — the substrate
 *          does NOT re-create jobs in v0.3.1)
 *        - escalate-to-parent → walk parent chain + recurse with
 *          parent's strategy
 *
 * v0.3.1 NOTE on actual restart: this release LANDS the supervision
 * engine + restart-cap + audit emission. The actual "re-spawn the
 * Job" mechanic is deferred — re-creating a Job for a Failed
 * AgentTask requires either bumping the AgentTask's generation +
 * re-running reconcile, or creating a new AgentTask. Both are
 * application-layer / operator-recreate concerns that compose with
 * Workflows (Wave 2) and ResourceQuota / per-Agent in-flight caps
 * (Wave 4 Quotas). The substrate's job HERE is to (a) bound the
 * restart loop with the cap and (b) carve out the supervision
 * decision so the operator-recreate path knows what to do. The
 * audit emission carries the action for downstream tooling.
 *
 * Co-located with `reconcile.ts` so the existing reconciler keeps a
 * thin top-level surface; the heavy lifting lives here.
 */

import type { CustomObjectsApi } from '@kubernetes/client-node';

import {
  ALL_SUPERVISION_STRATEGIES,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_SUPERVISION_STRATEGY,
  evaluateStrategy,
  type SiblingTask,
  type SupervisionDecision,
  type SupervisionStrategy,
  type TaskRef,
} from '@kagent/supervision';

import {
  API_GROUP,
  API_VERSION,
  type Agent,
  type AgentTask,
  type AgentTaskCondition,
  isAgent,
  isAgentTask,
} from './crds/index.js';
import { classifyFailure, isInfraFault } from './failure-classifier.js';
import { mergePatchOptions } from './k8s.js';
import { mergeCondition, nextPhase } from './status-transitions.js';
import { PARENT_TASK_UID_LABEL } from './task-graph.js';

/**
 * Audit-emission hooks the supervision router calls. All best-effort
 * — failures are caught and logged; never propagate into the
 * reconcile path.
 */
export interface SupervisionAuditHooks {
  readonly emitSupervisionApplied?: (fields: SupervisionAppliedFields) => Promise<void>;
  readonly emitSupervisionRestartLimitExceeded?: (
    fields: SupervisionRestartLimitExceededFields,
  ) => Promise<void>;
  readonly emitInfraFault?: (fields: InfraFaultFields) => Promise<void>;
}

export interface SupervisionAppliedFields {
  readonly parentTaskUid: string | undefined;
  readonly parentTaskNamespace: string;
  readonly parentTaskName: string | undefined;
  readonly agentName: string;
  readonly strategy: SupervisionStrategy;
  readonly action: SupervisionDecision['action'];
  readonly failedTaskUid: string;
  readonly failureReason: string;
  readonly targets: readonly string[];
  readonly reason: string;
}

export interface SupervisionRestartLimitExceededFields {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly restartCount: number;
  readonly maxRestarts: number;
}

export interface InfraFaultFields {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly agentName: string;
  readonly source: 'job' | 'pod';
  readonly reason: string;
  readonly message: string;
}

export interface SupervisionRouterDeps {
  readonly customApi: CustomObjectsApi;
  /**
   * Informer-cache reader: returns the AgentTasks whose
   * `parent-task-uid` label matches the given UID. Production wiring
   * supplies this from the same AgentTask informer the rest of the
   * operator uses; tests pass a captured array.
   */
  readonly listChildrenForParent?: (parentUid: string, namespace: string) => readonly AgentTask[];
  /**
   * Informer-cache reader: returns the AgentTask with the given UID
   * (any namespace the informer is watching). Production wiring threads
   * the same closure that already feeds `reconcileParentFromChildEvent`
   * (`main.ts:getTaskByUid`, backed by the AgentTask informer cache).
   * When wired, `fetchParentTask` and `fetchTaskByUid` short-circuit the
   * unbounded LIST and pull from cache (M2). Tests may leave it unset
   * (legacy LIST path remains correct).
   */
  readonly getTaskByUid?: (uid: string) => AgentTask | undefined;
  /**
   * Audit hooks (best-effort).
   */
  readonly audit?: SupervisionAuditHooks;
  /**
   * Override `Date.now()` for deterministic timestamps in tests.
   */
  readonly now?: () => Date;
  /**
   * Override the supervision-engine entry point. Tests use this to
   * verify the operator routes the engine output without running the
   * full pure decision (which is already covered by the engine's own
   * unit tests). Production leaves it unset → default = real engine.
   */
  readonly evaluate?: typeof evaluateStrategy;
}

/**
 * Result the operator gets back from the router so it can log + ack.
 */
export type SupervisionRoutingResult =
  | { kind: 'no-op'; reason: 'phase-not-failed' | 'no-parent' | 'no-agent' }
  | { kind: 'infra-fault-observed'; reason: string }
  | { kind: 'applied'; decision: SupervisionDecision; restartLimitTripped: readonly string[] }
  | { kind: 'escalated'; depth: number; finalDecision: SupervisionDecision };

/**
 * Top-level entry point. Called by reconcile.ts when an AgentTask
 * transitions to `Failed`. Pure-async: no in-flight state kept across
 * calls.
 */
export async function routeFailureForSupervision(
  failedTask: AgentTask,
  deps: SupervisionRouterDeps,
): Promise<SupervisionRoutingResult> {
  // Step 1 — gate on phase. Idempotent re-fires on relist must be safe.
  if (failedTask.status?.phase !== 'Failed') {
    return { kind: 'no-op', reason: 'phase-not-failed' };
  }

  const namespace = failedTask.metadata.namespace ?? 'default';
  const reasonRaw = extractFailureReason(failedTask);

  // Step 2 — classify. Infra faults short-circuit (K8s' job
  // backoffLimit handles them); emit the audit event for visibility.
  if (isInfraFault(reasonRaw)) {
    await emitInfraSafe(deps, failedTask, reasonRaw);
    return { kind: 'infra-fault-observed', reason: reasonRaw ?? '(no-reason)' };
  }

  // The classifier returns 'unknown' for empty/undefined and any
  // string that isn't in either catalog. Per the design (conservative
  // default), unknown → supervision. Audit dashboards + the
  // emitInfraFault hook still get visibility on infra faults via the
  // path above.
  const cls = classifyFailure(reasonRaw);
  if (cls !== 'structured' && cls !== 'unknown') {
    return { kind: 'no-op', reason: 'phase-not-failed' };
  }

  // Step 3 — resolve parent. Tasks without a parent (root tasks) have
  // no supervisor; the operator simply marks them Failed and audit
  // dashboards pick up the terminal state via task.failed.
  const parentRef = parentRefFromLabel(failedTask);
  if (parentRef === null) {
    return { kind: 'no-op', reason: 'no-parent' };
  }

  // Walk the parent chain when escalation triggers. `currentParent`
  // is the supervisor we ask for a strategy; the failure being
  // supervised is always the most-recent failed task (which may be
  // the original `failedTask` or — when escalating — the parent
  // itself for the next level up).
  let currentFailed = failedTask;
  let currentReason = reasonRaw;
  let depth = 0;
  while (depth < MAX_ESCALATION_DEPTH) {
    const parentUid = currentFailed.metadata.labels?.[PARENT_TASK_UID_LABEL];
    if (typeof parentUid !== 'string' || parentUid.length === 0) {
      // Reached a root task during escalation — substrate-level
      // failure: operator marks the task Failed (already is) and
      // emits one terminal applied audit; the application has to
      // notice + act.
      return { kind: 'no-op', reason: 'no-parent' };
    }

    const parentTask = await fetchParentTask(deps, namespace, currentFailed);
    if (parentTask === null) {
      return { kind: 'no-op', reason: 'no-parent' };
    }

    const agent = await fetchAgent(deps, parentTask);
    if (agent === null) {
      return { kind: 'no-op', reason: 'no-agent' };
    }

    const strategy = resolveStrategy(agent);
    const siblings = listSiblings(deps, parentUid, namespace);

    const decision = (deps.evaluate ?? evaluateStrategy)(
      strategy,
      {
        ref: taskToRef(currentFailed),
        reason: currentReason ?? '',
        ...(currentFailed.status?.error !== undefined && {
          message: currentFailed.status.error,
        }),
      },
      siblings,
    );

    const restartLimitTripped = await dispatchDecision(decision, agent, parentTask, deps);

    await emitSupervisionAppliedSafe(
      deps,
      parentTask,
      agent,
      decision,
      currentFailed,
      currentReason,
    );

    if (decision.action !== 'escalate-to-parent') {
      return { kind: 'applied', decision, restartLimitTripped };
    }

    // Escalate: the supervisor itself becomes the failed child for
    // the next level up. Mark the parent Failed if it isn't already
    // (the substrate's "this whole subtree died" signal), then
    // recurse upward.
    await markEscalatedParentFailed(deps, parentTask, decision.reason);
    currentFailed = await refreshTaskOrDefault(deps, parentTask);
    currentReason = 'supervision_terminated';
    depth++;
  }

  // Defensive: an unbounded escalation chain shouldn't happen under
  // sane CRDs, but cap to prevent a misconfiguration spinning the
  // operator. Last-applied audit emission is enough signal.
  return {
    kind: 'escalated',
    depth,
    finalDecision: {
      action: 'escalate-to-parent',
      strategy: 'escalate',
      targets: [],
      reason: `escalation depth cap reached (${depth.toString()})`,
    },
  };
}

const MAX_ESCALATION_DEPTH = 8;

/**
 * Resolve `Agent.spec.supervisionStrategy` with v0.1 default. Unknown
 * strings (legacy CRDs that pre-date the enum) fall back to the
 * substrate default `one_for_one`. This is intentional: a
 * misspelled strategy MUST NOT silently change behavior.
 */
export function resolveStrategy(agent: Agent): SupervisionStrategy {
  const declared = (agent.spec as { supervisionStrategy?: unknown }).supervisionStrategy;
  if (typeof declared !== 'string') return DEFAULT_SUPERVISION_STRATEGY;
  if (!isKnownStrategy(declared)) return DEFAULT_SUPERVISION_STRATEGY;
  return declared;
}

function isKnownStrategy(s: string): s is SupervisionStrategy {
  return (ALL_SUPERVISION_STRATEGIES as readonly string[]).includes(s);
}

/**
 * Resolve `Agent.spec.maxRestarts` with v0.1 default + clamp.
 * Negative values fall back to the default; non-integer values are
 * rejected (the CRD `minimum: 0` schema gates this; defensive).
 */
export function resolveMaxRestarts(agent: Agent): number {
  const declared = (agent.spec as { maxRestarts?: unknown }).maxRestarts;
  if (typeof declared !== 'number') return DEFAULT_MAX_RESTARTS;
  if (!Number.isInteger(declared)) return DEFAULT_MAX_RESTARTS;
  if (declared < 0) return DEFAULT_MAX_RESTARTS;
  return declared;
}

/**
 * Convert an AgentTask informer entry into the shape the supervision
 * engine consumes. Terminal-phase tasks are passed through; the
 * engine filters them on its own.
 */
function taskToSibling(t: AgentTask): SiblingTask {
  const phaseRaw = t.status?.phase;
  const phase: SiblingTask['phase'] =
    phaseRaw === 'Pending' ||
    phaseRaw === 'Dispatched' ||
    phaseRaw === 'Completed' ||
    phaseRaw === 'Failed'
      ? phaseRaw
      : 'Pending';
  return {
    ref: taskToRef(t),
    phase,
    ...(t.status?.startedAt !== undefined && { startedAt: t.status.startedAt }),
    ...(t.status?.restartCount !== undefined && { restartCount: t.status.restartCount }),
  };
}

function taskToRef(t: AgentTask): TaskRef {
  return {
    uid: t.metadata.uid ?? '',
    ...(t.metadata.name !== undefined && { name: t.metadata.name }),
    ...(t.metadata.namespace !== undefined && { namespace: t.metadata.namespace }),
  };
}

/**
 * Read the parent UID off the failed task's
 * `kagent.knuteson.io/parent-task-uid` label. Tasks without a parent
 * (i.e. root AgentTasks) return null — the operator does NOT
 * supervise root tasks (no supervisor exists; the application
 * decides whether to re-issue).
 */
function parentRefFromLabel(t: AgentTask): { uid: string; namespace: string } | null {
  const uid = t.metadata.labels?.[PARENT_TASK_UID_LABEL];
  if (typeof uid !== 'string' || uid.length === 0) return null;
  const namespace = t.metadata.namespace ?? 'default';
  return { uid, namespace };
}

/**
 * Pull the failure reason from `status.error` / `status.conditions[]`.
 * The operator + agent-pod write the reason in different places
 * depending on the failure source; this helper consolidates the read
 * so the classifier sees a single string per task.
 *
 * Priority order:
 *   1. last condition with `status: True` and a non-empty `reason`
 *      (most specific — `MissingRequiredOutputs`, `InvalidInputs`,
 *       `PolicyDenied`, ...)
 *   2. `status.error` (operator markFailed path; format `policy_denied:<X> — <msg>` or raw)
 *   3. `(no-reason)` sentinel
 */
function extractFailureReason(task: AgentTask): string | undefined {
  const conditions = task.status?.conditions ?? [];
  for (let i = conditions.length - 1; i >= 0; i--) {
    const c = conditions[i];
    if (c === undefined) continue;
    if (c.status === 'True' && typeof c.reason === 'string' && c.reason.length > 0) {
      return c.reason;
    }
  }
  const err = task.status?.error;
  if (typeof err === 'string' && err.length > 0) {
    // The operator's markFailed path writes
    // `policy_denied:<reason> — <message>`; strip the message portion
    // so the classifier sees the structured reason.
    const colonIdx = err.indexOf(':');
    const dashIdx = err.indexOf(' — ');
    if (colonIdx >= 0 && dashIdx > colonIdx) {
      return err.slice(0, dashIdx);
    }
    return err;
  }
  return undefined;
}

async function fetchParentTask(
  deps: SupervisionRouterDeps,
  namespace: string,
  child: AgentTask,
): Promise<AgentTask | null> {
  // M2 — informer-cache fast path. When `deps.getTaskByUid` is wired
  // (production main.ts threads the same informer-backed closure that
  // feeds `reconcileParentFromChildEvent`), look up the parent in the
  // local cache rather than issuing an unbounded namespaced LIST. The
  // legacy LIST stays as a fallback for tests and for clusters where
  // the cache hasn't synced yet.
  const parentUid = child.metadata.labels?.[PARENT_TASK_UID_LABEL];
  if (typeof parentUid !== 'string' || parentUid.length === 0) return null;

  if (deps.getTaskByUid !== undefined) {
    const cached = deps.getTaskByUid(parentUid);
    if (cached !== undefined) return cached;
    // Cache miss — informer hasn't seen this UID yet (e.g., race with
    // an apiserver write that the informer hasn't reflected). Fall
    // through to the LIST so the router stays correct under cold
    // cache.
  }

  try {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await deps.customApi.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: 'agenttasks',
    });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    const items = (res as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    for (const it of items) {
      if (!isAgentTask(it)) continue;
      if (it.metadata.uid === parentUid) return it;
    }
    return null;
  } catch (err) {
    console.error(
      '[kagent-operator] supervision-router: failed to LIST agenttasks for parent fetch:',
      err,
    );
    return null;
  }
}

async function fetchAgent(deps: SupervisionRouterDeps, parent: AgentTask): Promise<Agent | null> {
  const targetAgent = parent.spec.targetAgent;
  if (typeof targetAgent !== 'string' || targetAgent.length === 0) return null;
  const namespace = parent.metadata.namespace ?? 'default';
  try {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await deps.customApi.getNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: 'agents',
      name: targetAgent,
    });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    if (isAgent(res)) return res;
    return null;
  } catch (err) {
    console.warn(
      `[kagent-operator] supervision-router: Agent ${namespace}/${targetAgent} fetch failed:`,
      err,
    );
    return null;
  }
}

function listSiblings(
  deps: SupervisionRouterDeps,
  parentUid: string,
  namespace: string,
): readonly SiblingTask[] {
  if (deps.listChildrenForParent === undefined) return [];
  return deps.listChildrenForParent(parentUid, namespace).map(taskToSibling);
}

/**
 * Apply a supervision decision: enforce maxRestarts, patch target
 * tasks. Returns the list of UIDs that tripped the restart cap (so
 * the caller can emit a distinct `supervision.restart_limit_exceeded`
 * audit per).
 */
async function dispatchDecision(
  decision: SupervisionDecision,
  agent: Agent,
  parent: AgentTask,
  deps: SupervisionRouterDeps,
): Promise<readonly string[]> {
  if (decision.action === 'escalate-to-parent') {
    // The router's outer loop handles escalation; nothing to dispatch
    // here.
    return [];
  }

  const maxRestarts = resolveMaxRestarts(agent);
  const namespace = parent.metadata.namespace ?? 'default';
  const limitTripped: string[] = [];

  for (const target of decision.targets) {
    if (target.uid.length === 0) continue;
    const targetTask = await fetchTaskByUid(deps, namespace, target.uid);
    if (targetTask === null) continue;

    if (decision.action === 'restart') {
      const next = (targetTask.status?.restartCount ?? 0) + 1;
      if (next > maxRestarts) {
        // Fail-closed: do NOT bump restartCount; mark the task with
        // a structured restart_limit_exceeded condition. The task is
        // already Failed; we append a condition + emit the audit.
        await appendCondition(deps, targetTask, {
          type: 'RestartLimitExceeded',
          status: 'True',
          reason: 'restart_limit_exceeded',
          message: `restartCount ${next.toString()} exceeds maxRestarts ${maxRestarts.toString()}`,
        });
        await emitRestartLimitSafe(deps, targetTask, agent, next, maxRestarts);
        limitTripped.push(target.uid);
        continue;
      }
      // Bump the counter. Production v0.3.1 does NOT spawn a fresh
      // Job here; the substrate's job is to record the restart
      // intent + cap policy, not to re-issue work (see file-level
      // JSDoc).
      await patchRestartCount(deps, targetTask, next, decision.reason);
      continue;
    }

    // terminate-and-restart-{tree,subset}: mark the target Failed
    // with `reason: supervision_terminated`. Skip when already Failed
    // — we don't want to overwrite a more-specific cause.
    if (target.uid === decision.targets[0]?.uid && targetTask.status?.phase === 'Failed') {
      // The triggering failed task is in the targets list; leave it.
      continue;
    }
    if (targetTask.status?.phase === 'Failed' || targetTask.status?.phase === 'Completed') {
      continue;
    }
    await markTerminatedBySupervision(deps, targetTask, decision.reason);
  }

  return limitTripped;
}

async function fetchTaskByUid(
  deps: SupervisionRouterDeps,
  namespace: string,
  uid: string,
): Promise<AgentTask | null> {
  // M2 — informer-cache fast path. See `fetchParentTask` for the same
  // pattern + cold-cache fallback rationale.
  if (deps.getTaskByUid !== undefined) {
    const cached = deps.getTaskByUid(uid);
    if (cached !== undefined) return cached;
  }
  try {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await deps.customApi.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: 'agenttasks',
    });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    const items = (res as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    for (const it of items) {
      if (!isAgentTask(it)) continue;
      if (it.metadata.uid === uid) return it;
    }
    return null;
  } catch {
    return null;
  }
}

async function patchRestartCount(
  deps: SupervisionRouterDeps,
  task: AgentTask,
  next: number,
  reason: string,
): Promise<void> {
  const namespace = task.metadata.namespace ?? 'default';
  const name = task.metadata.name;
  if (typeof name !== 'string' || name.length === 0) return;
  const ts = (deps.now ?? (() => new Date()))().toISOString();
  const condition: AgentTaskCondition = {
    type: 'SupervisionRestart',
    status: 'True',
    reason: 'supervision_restart',
    message: `restart #${next.toString()} (${reason})`,
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
            restartCount: next,
            conditions: mergeCondition(task.status?.conditions, condition),
          },
        },
      },
      mergePatchOptions,
    );
  } catch (err) {
    console.error(
      `[kagent-operator] supervision-router: failed to patch restartCount on ${namespace}/${name}:`,
      err,
    );
  }
}

async function markTerminatedBySupervision(
  deps: SupervisionRouterDeps,
  task: AgentTask,
  reason: string,
): Promise<void> {
  const namespace = task.metadata.namespace ?? 'default';
  const name = task.metadata.name;
  if (typeof name !== 'string' || name.length === 0) return;
  const ts = (deps.now ?? (() => new Date()))().toISOString();
  const phase = task.status?.phase;
  const proposed = nextPhase(phase, 'Failed');
  if (proposed === null) return;

  const condition: AgentTaskCondition = {
    type: 'SupervisionTerminated',
    status: 'True',
    reason: 'supervision_terminated',
    message: reason,
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
            phase: proposed,
            error: `supervision_terminated: ${reason}`,
            completedAt: ts,
            conditions: mergeCondition(task.status?.conditions, condition),
          },
        },
      },
      mergePatchOptions,
    );
  } catch (err) {
    console.error(
      `[kagent-operator] supervision-router: failed to mark ${namespace}/${name} terminated:`,
      err,
    );
  }
}

async function appendCondition(
  deps: SupervisionRouterDeps,
  task: AgentTask,
  partial: Omit<AgentTaskCondition, 'lastTransitionTime'>,
): Promise<void> {
  const namespace = task.metadata.namespace ?? 'default';
  const name = task.metadata.name;
  if (typeof name !== 'string' || name.length === 0) return;
  const ts = (deps.now ?? (() => new Date()))().toISOString();
  const condition: AgentTaskCondition = {
    ...partial,
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
            conditions: mergeCondition(task.status?.conditions, condition),
          },
        },
      },
      mergePatchOptions,
    );
  } catch (err) {
    console.error(
      `[kagent-operator] supervision-router: failed to append condition on ${namespace}/${name}:`,
      err,
    );
  }
}

async function markEscalatedParentFailed(
  deps: SupervisionRouterDeps,
  parent: AgentTask,
  reason: string,
): Promise<void> {
  const phase = parent.status?.phase;
  if (phase === 'Failed') return; // already terminal
  await markTerminatedBySupervision(deps, parent, `escalate: ${reason}`);
}

async function refreshTaskOrDefault(
  deps: SupervisionRouterDeps,
  parent: AgentTask,
): Promise<AgentTask> {
  const namespace = parent.metadata.namespace ?? 'default';
  const name = parent.metadata.name;
  if (typeof name !== 'string' || name.length === 0) return parent;
  try {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await deps.customApi.getNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: 'agenttasks',
      name,
    });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    if (isAgentTask(res)) return res;
    return parent;
  } catch {
    return parent;
  }
}

/* =====================================================================
 * Best-effort audit emission helpers.
 * ===================================================================== */

async function emitInfraSafe(
  deps: SupervisionRouterDeps,
  task: AgentTask,
  reasonRaw: string | undefined,
): Promise<void> {
  if (deps.audit?.emitInfraFault === undefined) return;
  try {
    await deps.audit.emitInfraFault({
      taskUid: task.metadata.uid ?? '',
      taskNamespace: task.metadata.namespace ?? 'default',
      taskName: task.metadata.name ?? '',
      agentName: task.spec.targetAgent ?? '',
      source: classifyInfraSource(reasonRaw),
      reason: stripInfraSourcePrefix(reasonRaw ?? ''),
      message: task.status?.error ?? reasonRaw ?? '',
    });
  } catch (err) {
    console.warn('[kagent-operator] supervision-router: emitInfraFault hook raised:', err);
  }
}

async function emitSupervisionAppliedSafe(
  deps: SupervisionRouterDeps,
  parent: AgentTask,
  agent: Agent,
  decision: SupervisionDecision,
  failed: AgentTask,
  failureReason: string | undefined,
): Promise<void> {
  if (deps.audit?.emitSupervisionApplied === undefined) return;
  try {
    await deps.audit.emitSupervisionApplied({
      parentTaskUid: parent.metadata.uid,
      parentTaskNamespace: parent.metadata.namespace ?? 'default',
      parentTaskName: parent.metadata.name,
      agentName: agent.metadata.name ?? '',
      strategy: decision.strategy,
      action: decision.action,
      failedTaskUid: failed.metadata.uid ?? '',
      failureReason: failureReason ?? '(no-reason)',
      targets: decision.targets.map((t) => t.uid),
      reason: decision.reason,
    });
  } catch (err) {
    console.warn('[kagent-operator] supervision-router: emitSupervisionApplied hook raised:', err);
  }
}

async function emitRestartLimitSafe(
  deps: SupervisionRouterDeps,
  task: AgentTask,
  agent: Agent,
  restartCount: number,
  maxRestarts: number,
): Promise<void> {
  if (deps.audit?.emitSupervisionRestartLimitExceeded === undefined) return;
  try {
    await deps.audit.emitSupervisionRestartLimitExceeded({
      taskUid: task.metadata.uid ?? '',
      taskNamespace: task.metadata.namespace ?? 'default',
      taskName: task.metadata.name ?? '',
      agentName: agent.metadata.name ?? '',
      restartCount,
      maxRestarts,
    });
  } catch (err) {
    console.warn(
      '[kagent-operator] supervision-router: emitSupervisionRestartLimitExceeded hook raised:',
      err,
    );
  }
}

function classifyInfraSource(reason: string | undefined): 'job' | 'pod' {
  if (typeof reason !== 'string') return 'job';
  if (reason.startsWith('Pod/') || reason.startsWith('pod/')) return 'pod';
  return 'job';
}

function stripInfraSourcePrefix(reason: string): string {
  const prefixes = ['Job/', 'Pod/', 'job/', 'pod/'];
  for (const p of prefixes) {
    if (reason.startsWith(p)) return reason.slice(p.length);
  }
  return reason;
}
