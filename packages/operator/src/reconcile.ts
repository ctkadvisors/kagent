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

import { API_GROUP, API_VERSION, type Agent, type AgentTask, isAgent } from './crds/index.js';
import type { CapabilityRegistry } from './capability-registry.js';
import { StubCapabilityRegistry } from './capability-registry.js';
import type { Dispatcher } from './dispatcher.js';
import { buildJobSpec, type BuildJobSpecOptions, jobNameForTask } from './job-spec.js';
import { mergePatchOptions } from './k8s.js';

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

  // Step 5 — update status.
  const now = deps.now ?? (() => new Date());
  await patchStatus(task, deps.customApi, {
    phase: 'Dispatched',
    podName: jobNameForTask(task),
    startedAt: now().toISOString(),
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
