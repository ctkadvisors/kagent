/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wire-shape types the UI consumes from the workbench-api.
 *
 * These mirror @kagent/dto's `TaskSummary`, `TaskDetail`, `AgentSummary`
 * but are re-declared here to keep the UI a leaf in the dep graph
 * (no @kagent imports). The API is the source of truth; if a field
 * shape drifts, surface it here as a UI bug.
 *
 * TODO(post-mvp): generate these from the workbench-api OpenAPI spec
 * when one exists, or move to a shared zero-runtime types package.
 */

export type AgentTaskPhase = 'Pending' | 'Dispatched' | 'Completed' | 'Failed';

/**
 * Aggregate phase across child tasks — operator-owned projection.
 * Mirror of @kagent/dto's `AggregatePhase`.
 */
export type AggregatePhase =
  | 'Pending'
  | 'Dispatched'
  | 'PartiallyComplete'
  | 'AllComplete'
  | 'AnyFailed';

export interface TaskSummary {
  readonly name: string;
  readonly namespace: string;
  readonly uid: string;
  readonly phase?: AgentTaskPhase;
  readonly targetAgent?: string;
  readonly targetCapability?: string;
  readonly model?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly podName?: string;
  readonly error?: string;
  readonly suspicious?: readonly string[];
  /** Number of artifacts attached to status.artifacts. Undefined = no projection yet. */
  readonly artifactCount?: number;
  /** Number of children spawned via task-graph delegation. Undefined = none observed. */
  readonly childCount?: number;
  /** Aggregate phase across `children`, distinct from `phase`. */
  readonly aggregatePhase?: AggregatePhase;
}

export interface CacheChangeEvent {
  readonly kind: 'task' | 'agent' | 'job' | 'pod';
  readonly op: 'upsert' | 'delete';
  readonly key: string;
}
