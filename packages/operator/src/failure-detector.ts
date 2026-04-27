/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure failure-classification logic. Given a Job (and optionally its
 * Pod), returns a FailureVerdict the operator can surface back into
 * AgentTask.status.phase=Failed, or null if the resource is healthy or
 * still progressing.
 *
 * Kept side-effect-free so the unit tests can drive every branch with
 * inline fixtures — the watcher / status-writer wiring lives separately
 * in `job-watch.ts` + `reconcile.ts`.
 */

import type { V1Job, V1Pod } from '@kubernetes/client-node';

export interface FailureVerdict {
  /** Short machine-readable tag (e.g. `JobFailed`, `ImagePullBackOff`). */
  readonly reason: string;
  /** Human-readable detail surfaced into AgentTask.status.error. */
  readonly message: string;
  /** Which resource type the verdict came from. */
  readonly source: 'job' | 'pod';
}

/**
 * Container-waiting reasons we treat as terminal even though kubelet
 * will keep retrying. Once any of these fires the AgentTask should be
 * surfaced as Failed so the user can debug — otherwise a misconfigured
 * image silently pins the task in Dispatched until somebody looks at
 * the cluster directly.
 */
const TERMINAL_WAITING_REASONS: ReadonlySet<string> = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'CrashLoopBackOff',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
  'InvalidImageName',
  'PreCreateHookError',
  'PostStartHookError',
]);

/**
 * Classify a Job. Returns a verdict when the Job is in a terminal
 * failure state (condition Failed=True, or `status.failed` exhausted
 * the backoffLimit), or null otherwise. A Job with `status.succeeded`
 * is NEVER a failure here — the agent-pod owns success-side status
 * writeback, so the Job's success signal is informational only.
 */
export function detectJobFailure(job: V1Job): FailureVerdict | null {
  const conditions = job.status?.conditions ?? [];
  const failed = conditions.find((c) => c.type === 'Failed' && c.status === 'True');
  if (failed !== undefined) {
    return {
      reason: failed.reason ?? 'JobFailed',
      message:
        failed.message ?? `Job ${job.metadata?.name ?? '(unknown)'} reached condition Failed=True`,
      source: 'job',
    };
  }
  // Active-deadline timeouts in older clusters surface as type=Failed
  // reason=DeadlineExceeded — already caught above. Newer clusters use
  // a separate condition type=DeadlineExceeded; cover both.
  const deadline = conditions.find((c) => c.type === 'DeadlineExceeded' && c.status === 'True');
  if (deadline !== undefined) {
    return {
      reason: 'DeadlineExceeded',
      message:
        deadline.message ??
        `Job ${job.metadata?.name ?? '(unknown)'} exceeded activeDeadlineSeconds`,
      source: 'job',
    };
  }
  // Backoff exhaustion without an explicit Failed condition (rare —
  // controller usually sets the condition first, but defensive).
  const failedCount = job.status?.failed ?? 0;
  const backoffLimit = job.spec?.backoffLimit ?? 6;
  if (failedCount > backoffLimit) {
    return {
      reason: 'BackoffLimitExceeded',
      message: `Job ${job.metadata?.name ?? '(unknown)'} failed ${failedCount} times (backoffLimit=${backoffLimit})`,
      source: 'job',
    };
  }
  return null;
}

/**
 * Classify a Pod. Returns a verdict for any of:
 *   - phase=Failed (container exited non-zero with no retry)
 *   - PodScheduled=False reason=Unschedulable (no node has capacity)
 *   - container waiting in a terminal reason (image pull failures,
 *     config errors, runtime errors)
 *
 * Returns null for Pending without a terminal waiting reason, and for
 * Running / Succeeded.
 */
export function detectPodFailure(pod: V1Pod): FailureVerdict | null {
  const podName = pod.metadata?.name ?? '(unknown)';

  if (pod.status?.phase === 'Failed') {
    return {
      reason: pod.status.reason ?? 'PodFailed',
      message: pod.status.message ?? `Pod ${podName} reached phase=Failed`,
      source: 'pod',
    };
  }

  const conditions = pod.status?.conditions ?? [];
  const podScheduled = conditions.find((c) => c.type === 'PodScheduled');
  if (
    podScheduled !== undefined &&
    podScheduled.status === 'False' &&
    podScheduled.reason === 'Unschedulable'
  ) {
    return {
      reason: 'Unschedulable',
      message: podScheduled.message ?? `Pod ${podName} unschedulable`,
      source: 'pod',
    };
  }

  const containerStatuses = pod.status?.containerStatuses ?? [];
  for (const cs of containerStatuses) {
    const waiting = cs.state?.waiting;
    if (waiting?.reason !== undefined && TERMINAL_WAITING_REASONS.has(waiting.reason)) {
      const detail = waiting.message !== undefined ? `: ${waiting.message}` : '';
      return {
        reason: waiting.reason,
        message: `${podName} container ${cs.name} ${waiting.reason}${detail}`,
        source: 'pod',
      };
    }
  }

  return null;
}

/**
 * Convenience wrapper — Pod verdicts are usually more specific than
 * Job verdicts (the Job condition often just says "BackoffLimit
 * exceeded" while the Pod tells you WHY), so prefer Pod when both
 * have something to say.
 */
export function detectFailure(job: V1Job, pod?: V1Pod): FailureVerdict | null {
  if (pod !== undefined) {
    const podVerdict = detectPodFailure(pod);
    if (podVerdict !== null) return podVerdict;
  }
  return detectJobFailure(job);
}
