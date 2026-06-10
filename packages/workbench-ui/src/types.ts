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
 * Phase 1 / DISP-04 EXCEPTION: `DispositionOverlayRow` is re-exported
 * from `@kagent/dto` directly because it's the SAME read DTO the
 * workbench-api emits — a single source of truth across the
 * substrate-API-UI tier boundary (per plan 03 D-DISP-03-A). Schema
 * drift between API and UI is caught at runtime by
 * `assertIsDispositionOverlayRow`.
 *
 * TODO(post-mvp): generate these from the workbench-api OpenAPI spec
 * when one exists, or move to a shared zero-runtime types package.
 */

// Phase 1 / DISP-04 — shared DTOs for the disposition slice. The
// workbench-api computes them; the workbench-ui renders them in the
// Command Center DispositionOverlay. Same type both sides means no
// duplication and no drift.
export type {
  DispositionOverBudgetReason,
  DispositionOverlayRow,
  DispositionProposalKind,
} from '@kagent/dto/disposition';

// Phase 4 / REV-01 — ReviewQueueRow read projection.
// Same source-of-truth pattern as DispositionOverlayRow above: the
// workbench-api computes these rows, workbench-ui renders them in the
// #/review page and inline ReviewActions component. Runtime drift
// defense: assertIsReviewQueueRow in api.ts fetchReviewQueue.
export type { ArtifactRefSummary, ReviewQueueRow, ReviewReason } from '@kagent/dto/review-queue';

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
  /** Optional Langfuse/OTel trace deep-link for list-row observability. */
  readonly traceLink?: TraceLinkSummary;
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
  /**
   * Logical model-capability tier (e.g. `tool-caller-default`). Set
   * when the Agent CR uses the `modelClass` primitive instead of a
   * literal `model` pin. Surfaces alongside `model` so the UI can
   * label the tier even when no physical model is set at the Agent layer.
   */
  readonly modelClass?: string;
  readonly sandboxProfile?: 'default' | 'strict';
  readonly tools?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly toolProfileRef?: string;
  readonly agentType?: string;
  readonly recentTaskCounts?: {
    readonly pending: number;
    readonly dispatched: number;
    readonly completed: number;
    readonly failed: number;
  };
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

/* =====================================================================
 * Channel sessions — `/api/sessions`.
 * ===================================================================== */

export interface ChannelSessionSummary {
  readonly id: string;
  readonly namespace?: string;
  readonly targetAgent?: string;
  readonly turnCount: number;
  readonly lastPhase?: AgentTaskPhase;
  readonly lastActivityAt?: string;
  readonly lastMessagePreview?: string;
}

export interface ChannelTaskLink {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly phase?: AgentTaskPhase;
  readonly ui: string;
}

export interface ChannelMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt?: string;
  readonly task?: ChannelTaskLink;
}

export interface ChannelSessionDetail extends ChannelSessionSummary {
  readonly messages: readonly ChannelMessage[];
}

export interface SessionProfile {
  readonly id: string;
  readonly profileName: string;
  readonly source: 'Agent';
  readonly targetAgent: string;
  readonly namespace: string;
  readonly model?: string;
  readonly modelClass?: string;
  readonly toolProfileRef?: string;
  readonly sandboxProfile?: 'default' | 'strict';
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly defaults: {
    readonly runConfig: {
      readonly timeoutSeconds: number;
      readonly maxIterations: number;
    };
  };
  readonly launchability: {
    readonly state:
      | 'ready'
      | 'blocked_by_backoff'
      | 'blocked_by_model_tool_compatibility'
      | 'blocked_by_missing_runtime'
      | 'disabled_by_killswitch';
    readonly reasons: readonly string[];
  };
}

export interface SendSessionMessageRequest {
  readonly targetAgent: string;
  readonly message: string;
  readonly namespace?: string;
  readonly runConfig?: {
    readonly timeoutSeconds?: number;
    readonly maxIterations?: number;
  };
}

export interface SendSessionMessageResponse {
  readonly sessionId: string;
  readonly task: ChannelTaskLink & {
    readonly createdAt?: string;
  };
}

/* =====================================================================
 * Gateway page — `/api/gateway/*` and ModelEndpoint mutation surface.
 * Mirrors `packages/workbench-api/src/gateway-client.ts` shapes; declared
 * here so the UI stays leaf-deps-only.
 * ===================================================================== */

export interface GatewayCapacityRow {
  readonly model: string;
  readonly endpoint: string;
  readonly backendKind: string;
  readonly inFlight: number;
  readonly currentCap: number;
  readonly seed: number;
  readonly max: number;
  readonly minSafe: number;
  readonly recentP50Ms: number | null;
  /**
   * The underlying ModelEndpoint CR's metadata.name. Workbench-api
   * joins this from the K8s API; absent when the join failed (RBAC,
   * missing CR, etc.) — UI hides the slider in that case.
   */
  readonly crName?: string;
  readonly crNamespace?: string;
}

export interface GatewayCapacityResponse {
  readonly rows: readonly GatewayCapacityRow[];
  readonly fetchedAt: string;
}

export interface GatewayUsageRow {
  readonly id?: number | string;
  readonly requestId: string;
  readonly model: string;
  readonly backend: string;
  readonly backendUrl: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly statusCode: number;
  readonly streaming: boolean;
  // Nullable string fields: gateway projects SQL NULLs as JSON null (NOT
  // missing/undefined). UI must guard with `!= null`, never `!== undefined`,
  // or `null.slice` will throw at render time.
  readonly taskUid?: string | null;
  readonly agentName?: string | null;
  readonly errorMessage?: string | null;
  readonly occurredAt?: string;
}

export interface GatewayUsageResponse {
  readonly rows: readonly GatewayUsageRow[];
  readonly fetchedAt: string;
}

export interface GatewayProviderDispatchState {
  readonly providerDispatchDisabled: boolean;
}

export interface PatchInFlightRequest {
  readonly seed?: number;
  readonly max?: number;
  readonly minSafe?: number;
}

/* =====================================================================
 * Cluster page — `/api/cluster/*`. Mirrors workbench-api/routes/cluster.ts
 * shapes; UI stays leaf-deps-only.
 * ===================================================================== */

export interface ClusterNodeRow {
  readonly name: string;
  readonly role: string;
  readonly kubeletVersion: string;
  readonly osImage: string;
  readonly containerRuntime: string;
  readonly ready: 'True' | 'False' | 'Unknown';
  readonly conditions: ReadonlyArray<{
    readonly type: string;
    readonly status: string;
    readonly reason?: string;
  }>;
  readonly capacity: Readonly<Record<string, string>>;
  readonly managedPodCount: number;
  readonly lastHeartbeatAt?: string;
}

export interface ClusterPodRow {
  readonly namespace: string;
  readonly name: string;
  readonly node: string | null;
  readonly phase: string;
  readonly taskUid?: string;
  readonly taskName?: string;
  readonly agentName?: string;
}

export interface ClusterTaskRow {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly phase: string;
  readonly targetAgent?: string;
  readonly model?: string;
  readonly podName?: string;
  readonly nodeName?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly parentTaskUid?: string;
  readonly childCount: number;
  readonly errorMessage?: string;
  readonly lastResultPreview?: string;
}

export interface ClusterSnapshot {
  readonly fetchedAt: string;
  readonly nodes: readonly ClusterNodeRow[];
  readonly pods: readonly ClusterPodRow[];
  readonly activeTasks: readonly ClusterTaskRow[];
  readonly recentTasks: readonly ClusterTaskRow[];
  readonly counts: {
    readonly nodes: number;
    readonly managedPods: number;
    readonly active: number;
    readonly recent: number;
    readonly agents: number;
  };
}
