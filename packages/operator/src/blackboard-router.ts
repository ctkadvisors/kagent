/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 3 / Blackboard sub-team — operator-side router.
 *
 * Reads AgentTask events and orchestrates per-task-tree NATS KV
 * bucket lifecycle:
 *
 *   - **Root admission** → `BlackboardBucketManager.ensureBucket(rootUid)`.
 *     A "root" task has no `spec.parentTask` AND no `parentTaskRefFromChild`
 *     (label/annotation/ownerRef-derived parent). Children share the
 *     root's bucket via `KAGENT_BLACKBOARD_BUCKET` stamped at job-spec
 *     render time (see job-spec.ts).
 *
 *   - **Root completion** → schedule `destroyBucket(rootUid)` after
 *     the root task's TTL elapses. This file just emits the schedule
 *     decision; the operator's main.ts owns the timer.
 *
 * Both calls are best-effort. A NATS outage at admission time does
 * NOT block dispatch — the tools register but cap-gated calls fail
 * with a structured error inside the agent loop, which is what the
 * substrate spec promises.
 *
 * Symmetric pattern with `supervision-router.ts` and the rest of the
 * "router-per-cross-cutting-concern" pieces in this package: pure
 * decision logic, dependency-injected I/O, exhaustive unit tests.
 */

import type { AgentTask } from './crds/index.js';
import { parentTaskRefFromChild } from './task-graph.js';

/**
 * Determine whether an AgentTask is a tree root (has no parent).
 * Symmetric with `parentTaskRefFromChild`: a child returns a non-null
 * parent ref; a root returns null.
 *
 * Pure predicate — no I/O. Used by both the admission ensure-path
 * and the completion destroy-path so both code paths agree on which
 * tasks own a bucket.
 */
export function isRootTask(task: AgentTask): boolean {
  // Belt: explicit `spec.parentTask` is the v0.1+ canonical signal.
  if (typeof task.spec.parentTask === 'string' && task.spec.parentTask.length > 0) {
    return false;
  }
  // Suspenders: label/annotation/ownerRef-derived parent metadata.
  // `buildChildTaskManifest` stamps these on every spawned child.
  return parentTaskRefFromChild(task) === null;
}

/**
 * Resolve the root UID for a task — its OWN UID when it is a root,
 * the `spec.parentTask` (chain-walk required for grandchildren).
 *
 * For v0.4.1 we keep the implementation simple: every spawned child
 * carries `spec.parentTask = parent.uid` AND a label
 * `kagent.knuteson.io/parent-task-uid`. We do NOT walk the chain to
 * the true root here — the operator's reconcile path will see the
 * grandchild and the parent's reconciler already provisioned the
 * root bucket. Stamping the root UID on every spawned child is the
 * Wave 3 / Blackboard sub-team's responsibility (job-spec.ts threads
 * `KAGENT_BLACKBOARD_BUCKET` from a top-down ROOT_TASK_UID lookup),
 * which is the production path.
 *
 * For non-root tasks we return null; the caller skips ensureBucket.
 * Caller is expected to also enforce `isRootTask` before treating
 * a UID as a bucket key.
 */
export function rootUidForTask(task: AgentTask): string | null {
  if (!isRootTask(task)) return null;
  const uid = task.metadata.uid;
  if (typeof uid !== 'string' || uid.length === 0) return null;
  return uid;
}

/**
 * Convert an AgentTask's runConfig.timeoutSeconds to ms (with
 * fallback to deprecated `task.spec.timeoutSeconds`). Used by the
 * router to size the bucket TTL. Returns undefined when neither is
 * set; caller defaults to `DEFAULT_BUCKET_TTL_MS` in that case.
 */
export function bucketTtlMsFromTask(task: AgentTask): number | undefined {
  const seconds = task.spec.runConfig?.timeoutSeconds ?? task.spec.timeoutSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return seconds * 1000;
}

/**
 * Phase-tested terminal predicate. The completion router fires bucket
 * GC only on Completed | Failed | Cancelled — i.e., terminal phases
 * the substrate's own state machine never re-enters.
 */
export function isTerminalPhase(phase: string | undefined): boolean {
  return phase === 'Completed' || phase === 'Failed' || phase === 'Cancelled';
}

/**
 * Pure decision: given a (root) task event, what should the
 * blackboard router do? The caller (main.ts handler) translates the
 * decision into BucketManager calls + audit events.
 */
export type BlackboardRouterDecision =
  | {
      readonly kind: 'ensure';
      readonly rootUid: string;
      readonly ttlMs: number | undefined;
    }
  | {
      readonly kind: 'destroy';
      readonly rootUid: string;
      readonly ttlMs: number | undefined;
    }
  | { readonly kind: 'noop'; readonly reason: string };

/**
 * Decide what (if anything) to do for a given AgentTask event. Pure.
 *
 * Semantics:
 *   - Non-root task → noop (root path owns the bucket).
 *   - Root task with terminal phase → destroy (after caller-owned ttl).
 *   - Root task without terminal phase → ensure (admission path).
 *   - Root task with no UID stamped yet → noop (K8s assigns UID on
 *     first persist; the next reconcile sees the UID).
 */
export function decideBlackboardAction(task: AgentTask): BlackboardRouterDecision {
  const rootUid = rootUidForTask(task);
  if (rootUid === null) {
    return { kind: 'noop', reason: 'not-root-or-no-uid' };
  }
  const phase = task.status?.phase;
  const ttlMs = bucketTtlMsFromTask(task);
  if (isTerminalPhase(phase)) {
    return { kind: 'destroy', rootUid, ttlMs };
  }
  return { kind: 'ensure', rootUid, ttlMs };
}
