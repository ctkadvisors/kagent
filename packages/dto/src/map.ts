/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure mapping helpers — `taskSummary`, `taskDetail`, `podFailureSummary`.
 * Every helper:
 *
 *   1. Takes plain object inputs (no K8s clients, no fetch).
 *   2. Tolerates partial fixtures (missing status, missing pod, missing
 *      Agent reference) — degrades to undefined fields rather than
 *      throwing. The brief is explicit: a list view must still render
 *      even when the operator hasn't observed the task yet.
 *   3. Returns frozen-shape DTOs (typescript readonly enforced; no
 *      runtime Object.freeze — keeps the helpers cheap).
 *
 * Naming: these are the only public mappers; never expose intermediate
 * "build the X part of Y" helpers as exports — keeps the public surface
 * tractable for SemVer.
 */

import type { V1ContainerStatus, V1Job, V1Pod } from '@kubernetes/client-node';

import type { Agent, AgentTask } from './crds.js';
import { detectFailure } from './failure.js';
import type { EventSummary, PodFailureSummary, TaskDetail, TaskSummary } from './types.js';

/* =====================================================================
 * Task mappers
 * ===================================================================== */

export interface TaskSummaryOptions {
  readonly job?: V1Job;
  readonly pod?: V1Pod;
  readonly agent?: Agent;
}

/**
 * Map an AgentTask (+ optional Job/Pod/Agent context) into a list-row
 * summary. The mapper NEVER reads from the cluster — all fields come
 * from the supplied inputs.
 *
 * `opts.job` and `opts.pod` are intentionally NOT used to surface
 * suspicious-tags; those come from `task.status.structuralVerdict`
 * which the agent-pod writes. Job/Pod ARE used (transitively, by
 * callers wanting podFailureSummary) to surface terminal failure
 * messages — see `podFailureSummary` below.
 */
export function taskSummary(task: AgentTask, opts: TaskSummaryOptions = {}): TaskSummary {
  const status = task.status;
  const meta = task.metadata;

  return {
    name: meta.name ?? '',
    namespace: meta.namespace ?? 'default',
    uid: meta.uid ?? '',
    ...(status?.phase !== undefined && { phase: status.phase }),
    ...(task.spec.targetAgent !== undefined && { targetAgent: task.spec.targetAgent }),
    ...(task.spec.targetCapability !== undefined && {
      targetCapability: task.spec.targetCapability,
    }),
    ...(opts.agent?.spec.model !== undefined && { model: opts.agent.spec.model }),
    ...(meta.creationTimestamp !== undefined && {
      createdAt: toIso(meta.creationTimestamp),
    }),
    ...(status?.startedAt !== undefined && { startedAt: status.startedAt }),
    ...(status?.completedAt !== undefined && { completedAt: status.completedAt }),
    ...(status?.podName !== undefined && { podName: status.podName }),
    ...(status?.error !== undefined && { error: status.error }),
    ...(status?.structuralVerdict?.suspicious !== undefined && {
      suspicious: status.structuralVerdict.suspicious,
    }),
  };
}

export interface TaskDetailOptions extends TaskSummaryOptions {
  /**
   * Pre-projected K8s events. v0.1 callers don't pass anything; v0.2
   * Workbench facade will batch-fetch + project before calling.
   */
  readonly events?: readonly EventSummary[];
}

/**
 * Map an AgentTask into a detail-page projection. Extends taskSummary
 * with the heavy fields the list view doesn't carry.
 */
export function taskDetail(task: AgentTask, opts: TaskDetailOptions = {}): TaskDetail {
  const summary = taskSummary(task, opts);
  const containerStatuses: readonly V1ContainerStatus[] = opts.pod?.status?.containerStatuses ?? [];

  return {
    ...summary,
    ...(task.spec.originalUserMessage !== undefined && {
      originalUserMessage: task.spec.originalUserMessage,
    }),
    ...(task.spec.payload !== undefined && { payload: task.spec.payload }),
    ...(task.status?.result !== undefined && { result: task.status.result }),
    ...(task.spec.expectedTools !== undefined && { expectedTools: task.spec.expectedTools }),
    ...(task.spec.parentDistillation !== undefined && {
      parentDistillation: task.spec.parentDistillation,
    }),
    ...(task.spec.parentTask !== undefined && { parentTask: task.spec.parentTask }),
    containerStatuses,
    eventsSummary: opts.events ?? [],
  };
}

/* =====================================================================
 * Failure mapper
 * ===================================================================== */

/**
 * Wraps `detectFailure` so the DTO layer doesn't re-derive K8s failure
 * classification logic. Returns null when the Job (and optional Pod)
 * are healthy / still progressing.
 *
 * Surface choice: returns the rich `PodFailureSummary` (verdict +
 * pod/container deep-link bits) rather than the bare verdict, so a
 * Workbench panel can render "ImagePullBackOff in pod kat-9b-xyz
 * container agent" without the consumer touching the V1Pod shape.
 */
export function podFailureSummary(job: V1Job, pod?: V1Pod): PodFailureSummary | null {
  const verdict = detectFailure(job, pod);
  if (verdict === null) return null;

  const summary: {
    verdict: typeof verdict;
    podName?: string;
    containerName?: string;
    lastTransitionTime?: string;
  } = { verdict };

  if (pod?.metadata?.name !== undefined) {
    summary.podName = pod.metadata.name;
  }

  // For container-waiting verdicts, find the container that triggered
  // it so the UI can link to its logs.
  if (verdict.source === 'pod' && pod !== undefined) {
    const triggeringContainer = pod.status?.containerStatuses?.find((cs) => {
      const waiting = cs.state?.waiting;
      return waiting?.reason === verdict.reason;
    });
    if (triggeringContainer !== undefined) {
      summary.containerName = triggeringContainer.name;
    }

    // Best-effort transition timestamp: pod condition or container
    // state.waiting.message rarely carries timestamps directly, so fall
    // back to the pod's most-recent condition lastTransitionTime.
    const podConditions = pod.status?.conditions ?? [];
    const mostRecent = podConditions
      .map((c) => c.lastTransitionTime)
      .filter((t): t is Date => t !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (mostRecent !== undefined) {
      summary.lastTransitionTime = toIso(mostRecent);
    }
  } else if (verdict.source === 'job') {
    const jobConditions = job.status?.conditions ?? [];
    const mostRecent = jobConditions
      .map((c) => c.lastTransitionTime)
      .filter((t): t is Date => t !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (mostRecent !== undefined) {
      summary.lastTransitionTime = toIso(mostRecent);
    }
  }

  return summary;
}

/* =====================================================================
 * Internal helpers
 * ===================================================================== */

function toIso(value: Date | string): string {
  if (typeof value === 'string') return value;
  return value.toISOString();
}
