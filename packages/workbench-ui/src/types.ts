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

/**
 * Container-status subset we render on the detail page. Mirrors
 * V1ContainerStatus from `@kubernetes/client-node` but copied here to
 * keep the UI a leaf in the dep graph (no `@kagent` / `@kubernetes`
 * imports). Fields the UI actually uses are typed; the rest is
 * dropped — the API is the source of truth.
 */
export interface ContainerStatusSummary {
  readonly name: string;
  readonly ready?: boolean;
  readonly restartCount?: number;
  readonly image?: string;
  readonly state?: {
    readonly waiting?: { readonly reason?: string; readonly message?: string };
    readonly running?: { readonly startedAt?: string };
    readonly terminated?: {
      readonly exitCode?: number;
      readonly reason?: string;
      readonly message?: string;
      readonly finishedAt?: string;
    };
  };
}

export interface ChildRefSummary {
  readonly name: string;
  readonly namespace?: string;
  readonly uid?: string;
  readonly phase?: AgentTaskPhase;
}

export interface ArtifactSummaryRow {
  readonly name?: string;
  readonly uri: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly producedAt?: string;
}

export interface TraceLinkSummary {
  readonly provider: 'langfuse' | 'jaeger' | 'otel-collector';
  readonly runId: string;
  readonly url?: string;
}

export interface TaskPilotEvidence {
  readonly audit: {
    readonly labels: Readonly<Record<string, string>>;
    readonly annotations: Readonly<Record<string, string>>;
    readonly tenant?: string;
    readonly createdBy?: string;
    readonly managedBy?: string;
    readonly parentTaskUid?: string;
  };
  readonly policy: {
    readonly agentResolved: boolean;
    readonly tools?: readonly string[];
    readonly capabilities?: readonly string[];
    readonly allowedChildAgents?: readonly string[];
    readonly allowedChildTemplates?: readonly string[];
    readonly maxConcurrentChildren?: number;
    readonly maxInFlightTasks?: number;
  };
  readonly taskGraph: {
    readonly childCount?: number;
    readonly successCount?: number;
    readonly failureCount?: number;
    readonly inFlightCount?: number;
    readonly aggregatePhase?: AggregatePhase;
    readonly parentTask?: string;
  };
  readonly artifacts: {
    readonly count?: number;
  };
  readonly structuralVerdict?: {
    readonly suspicious: readonly string[];
  };
  readonly verification?: {
    readonly passed: boolean;
    readonly mode: string;
    readonly reason?: string;
    readonly completedAt?: string;
  };
  readonly capabilityRef?: string;
  readonly runConfig?: Readonly<Record<string, unknown>>;
}

export interface TaskDetail extends TaskSummary {
  readonly originalUserMessage?: string;
  readonly payload?: unknown;
  readonly result?: unknown;
  readonly expectedTools?: readonly string[];
  readonly parentDistillation?: string;
  readonly parentTask?: string;
  readonly containerStatuses: readonly ContainerStatusSummary[];
  readonly children?: readonly ChildRefSummary[];
  readonly artifacts?: readonly ArtifactSummaryRow[];
  readonly successCount?: number;
  readonly failureCount?: number;
  readonly inFlightCount?: number;
  /**
   * Optional Langfuse trace deep-link. Populated by the workbench-api
   * when `LANGFUSE_BASE_URL` is set. Trace ID is the sha256-derived
   * OTel trace ID (matches what `OtelTraceSink` actually emits) — see
   * `@kagent/dto`'s `traceLink()` mapper.
   */
  readonly traceLink?: TraceLinkSummary;
  readonly pilotEvidence?: TaskPilotEvidence;
}

export interface CacheChangeEvent {
  readonly kind: 'task' | 'agent' | 'job' | 'pod';
  readonly op: 'upsert' | 'delete';
  readonly key: string;
}

/* =====================================================================
 * Write surface (POST /api/tasks) — WS-J. Mirrors workbench-api's
 * `CreateTaskRequest` / `CreateTaskResponse` / `CreateTaskErrorBody`.
 * ===================================================================== */

export interface AgentSummaryRow {
  readonly name: string;
  readonly namespace: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly capabilities?: readonly string[];
}

export interface CreateTaskRequest {
  readonly targetAgent: string;
  readonly originalUserMessage: string;
  readonly namespace?: string;
  readonly name?: string;
  readonly runConfig?: {
    readonly timeoutSeconds?: number;
    readonly maxIterations?: number;
  };
  readonly labels?: Readonly<Record<string, string>>;
  readonly payload?: unknown;
}

export interface CreateTaskResponse {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly createdAt: string;
  readonly phase: 'Pending';
  readonly _links: { readonly detail: string; readonly ui: string };
}

/**
 * 4xx error body shape — the workbench-api returns `error` (always)
 * + `fields[]` (on 400/422 validation failures).
 */
export interface CreateTaskError {
  readonly status: number;
  readonly error: string;
  readonly fields?: ReadonlyArray<{
    readonly field: string;
    readonly code: string;
    readonly detail?: string;
  }>;
}
