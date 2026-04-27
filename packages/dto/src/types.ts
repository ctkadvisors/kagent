/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Read-model DTOs — list-row + detail-page shapes the Workbench API
 * facade returns to any client (GUI, CLI, webhooks, scheduler). Pure
 * data; the mapping logic lives in `map.ts`.
 *
 * Field-level immutability (`readonly`) is enforced everywhere so a
 * downstream consumer can't accidentally mutate a cached projection.
 *
 * Forward-compatibility note: every field marked optional MAY be filled
 * in by future operator versions; clients MUST tolerate missing values
 * rather than asserting on shape.
 */

import type { V1ContainerStatus } from '@kubernetes/client-node';

import type { AgentTaskPhase, AggregatePhase, ChildRef } from './crds.js';
import type { FailureVerdict } from './failure.js';

/* =====================================================================
 * TaskSummary — list-row shape.
 *
 * The minimum a list view needs: identity, lifecycle phase, who ran it,
 * timestamps, and "is this run interesting" signals (suspicious flags +
 * terminal failure verdict, when present). Anything heavier — the
 * payload, full result, distillation chain — lives on TaskDetail.
 * ===================================================================== */

export interface TaskSummary {
  /** AgentTask metadata.name — stable per-task identifier in its namespace. */
  readonly name: string;

  /** AgentTask metadata.namespace — defaults to 'default' on the K8s side. */
  readonly namespace: string;

  /** AgentTask metadata.uid — globally unique per task instance. */
  readonly uid: string;

  /** Lifecycle phase. Undefined when the operator hasn't observed the task yet. */
  readonly phase?: AgentTaskPhase;

  /** Target Agent name (from spec.targetAgent). */
  readonly targetAgent?: string;

  /** Target capability tag (from spec.targetCapability), if dispatch is by capability. */
  readonly targetCapability?: string;

  /**
   * Model identifier used for this run. Sourced from the referenced
   * Agent.spec.model when an Agent fixture is supplied to the mapper —
   * lets test harnesses + CLI tools render this without a network
   * roundtrip. Undefined when the Agent isn't supplied or doesn't
   * resolve.
   */
  readonly model?: string;

  /** AgentTask metadata.creationTimestamp (ISO 8601). */
  readonly createdAt?: string;

  /** Status.startedAt (ISO 8601) — when the agent-pod began executing. */
  readonly startedAt?: string;

  /** Status.completedAt (ISO 8601) — when the agent-pod finished writing status. */
  readonly completedAt?: string;

  /** Pod that ran (or is running) this task; copied from status.podName. */
  readonly podName?: string;

  /**
   * Operator-set error message when phase=Failed. Surfaced from
   * status.error so list rows can show a one-line failure reason
   * without the consumer fetching detail.
   */
  readonly error?: string;

  /**
   * Detector-emitted suspicious-tag list. Empty array = clean run;
   * non-empty = at least one structural problem (F1, synthesis_low_yield,
   * etc., per HARNESS-LESSONS §6). Undefined = no verdict written yet.
   */
  readonly suspicious?: readonly string[];

  /**
   * Number of artifacts produced by this task — derived from
   * `status.artifacts.length`. Surfaced on the list row so the
   * Workbench can render an "n artifacts" affordance without the
   * detail fetch. Undefined = task hasn't reported artifacts yet
   * (distinct from 0 = explicitly produced none).
   */
  readonly artifactCount?: number;

  /**
   * Number of children this task has delegated to — derived from
   * `status.children.length`. Surfaced on the list row so the
   * Workbench can show a "child task badge" (and pivot into the task
   * graph view) without fetching detail. Undefined = no projection
   * written yet (operator hasn't observed any children).
   */
  readonly childCount?: number;

  /**
   * Aggregate phase across this task's children, distinct from `phase`
   * (which describes the parent's own pod-side work). Mirror of
   * `status.aggregatePhase` from the operator's task-graph projection.
   */
  readonly aggregatePhase?: AggregatePhase;
}

/* =====================================================================
 * TaskDetail — detail-page shape, extends TaskSummary.
 *
 * Adds the heavy-fields view: original user message, payload,
 * full result blob, expected-tools list, parent distillation chain,
 * a subset of pod container statuses, and an events placeholder.
 * ===================================================================== */

export interface TaskDetail extends TaskSummary {
  /**
   * Originating user message. Required at the protocol level for
   * delegation chains so sub-agents can't be context-stripped — see
   * HARNESS-LESSONS §4. Sourced from spec.originalUserMessage.
   */
  readonly originalUserMessage?: string;

  /** Free-form payload the agent loop received. Substrate-opaque. */
  readonly payload?: unknown;

  /** Full result blob from status.result (e.g. { content: '...' }). */
  readonly result?: unknown;

  /** Tool category names the spec requested (feeds the F2 detector). */
  readonly expectedTools?: readonly string[];

  /**
   * Parent-agent distillation of the request, when this task is a
   * delegation. Sourced from spec.parentDistillation.
   */
  readonly parentDistillation?: string;

  /** UID of the AgentTask that delegated this one (if any). */
  readonly parentTask?: string;

  /**
   * Container-status subset for the run pod. We forward the K8s shape
   * verbatim (V1ContainerStatus) because the Workbench wants
   * waiting/running/terminated state + restartCount for the failure
   * panel. Empty array when no Pod fixture supplied.
   */
  readonly containerStatuses: readonly V1ContainerStatus[];

  /**
   * Recent K8s events scoped to this task — empty placeholder in v0.1.
   *
   * v0.2 plan: the Workbench API facade will batch-fetch events via
   * `kubectl get events --field-selector involvedObject.uid=<task.uid>`
   * (and any related Job/Pod UIDs) and pass them to `taskDetail` so
   * this array carries `{ type, reason, message, lastTimestamp }`.
   * Defining the field today keeps the DTO contract stable so the v0.2
   * change is purely additive on the mapper side.
   */
  readonly eventsSummary: readonly EventSummary[];

  /**
   * Full artifact projection for the detail view. Mirrors
   * `status.artifacts` 1:1 (uri/mediaType/sizeBytes/name/producedAt
   * — checksum dropped, the UI doesn't render it). Empty array when
   * the task produced none; undefined when no projection has been
   * written yet (distinct cases for the UI).
   */
  readonly artifacts?: readonly ArtifactSummary[];

  /** Children spawned by this task — operator-owned task-graph projection. */
  readonly children?: readonly ChildRef[];

  /** Children currently in `phase=Completed`. Mirror of `status.successCount`. */
  readonly successCount?: number;

  /** Children currently in `phase=Failed`. Mirror of `status.failureCount`. */
  readonly failureCount?: number;

  /** Children that have not reached a terminal phase yet. */
  readonly inFlightCount?: number;
}

/**
 * Lightweight K8s event projection — placeholder for v0.2 when the
 * Workbench API batches events. Mirrors V1Event but stripped to the
 * fields a UI list-item actually needs.
 */
export interface EventSummary {
  /** 'Normal' | 'Warning'. */
  readonly type?: string;
  /** Short machine-readable reason (e.g. 'BackOff', 'Pulled'). */
  readonly reason?: string;
  /** Human-readable detail. */
  readonly message?: string;
  /** ISO 8601 timestamp of the most recent occurrence. */
  readonly lastTimestamp?: string;
}

/* =====================================================================
 * AgentSummary — Agent-list-row shape.
 *
 * Minimum a "what agents are deployed in this namespace" view needs:
 * identity, model, capabilities, configured tools, and a coarse count
 * of recent task activity. Counts are derived from a caller-supplied
 * task list snapshot (no network access from this layer).
 * ===================================================================== */

export interface AgentSummary {
  /** Agent metadata.name. */
  readonly name: string;

  /** Agent metadata.namespace. */
  readonly namespace: string;

  /** Model identifier (Agent.spec.model). */
  readonly model: string;

  /** Sandbox profile — 'default' or 'strict'. Falls back to 'default' when unset. */
  readonly sandboxProfile: 'default' | 'strict';

  /** Capability tags the agent satisfies (Agent.spec.capabilities). */
  readonly capabilities: readonly string[];

  /** Tool names the agent is allowed to invoke (Agent.spec.tools). */
  readonly tools: readonly string[];

  /**
   * Recent task-phase counts. Filled when the caller supplies a
   * `tasks` snapshot to the mapper; defaults to all-zero otherwise.
   * The mapper does NOT fetch tasks itself — substrate stays pure.
   */
  readonly recentTaskCounts: AgentTaskCounts;
}

export interface AgentTaskCounts {
  readonly pending: number;
  readonly dispatched: number;
  readonly completed: number;
  readonly failed: number;
}

/* =====================================================================
 * PodFailureSummary — terminal-failure projection for a Job/Pod pair.
 *
 * Wraps FailureVerdict (re-exported from index) with the K8s-side
 * identifiers a UI needs to deep-link to logs. Returns null when no
 * terminal failure is detectable — list-row callers display a blank
 * cell.
 * ===================================================================== */

export interface PodFailureSummary {
  /** The verdict (reason/message/source). */
  readonly verdict: FailureVerdict;

  /** Pod metadata.name — undefined when the verdict came from the Job alone. */
  readonly podName?: string;

  /**
   * Container the verdict applies to. Set when a container-waiting
   * reason (ImagePullBackOff, etc.) triggered the verdict; undefined
   * for Pod-level (Unschedulable, phase=Failed) and Job-level verdicts.
   */
  readonly containerName?: string;

  /**
   * ISO 8601 timestamp of the most recent transition we could pull from
   * Pod conditions / waiting state. Undefined when nothing's available.
   */
  readonly lastTransitionTime?: string;
}

/* =====================================================================
 * TraceLink — observability deep-link.
 *
 * The substrate emits OTel spans (Phase 4 onward); v0.1 trace store is
 * "OTLP-collector or nothing" with Langfuse landing in v0.2. The link
 * lets a Workbench detail panel render a "View trace" affordance
 * without the DTO layer knowing the provider URL by heart.
 * ===================================================================== */

export interface TraceLink {
  readonly provider: 'langfuse' | 'jaeger' | 'otel-collector';
  /** Trace / run identifier — usually the AgentTask UID re-used as the trace ID. */
  readonly runId: string;
  /**
   * Fully-resolved deep-link, when the caller supplied a `baseUrl` to
   * the mapper. Undefined when no baseUrl is configured (the substrate
   * doesn't know where the trace UI lives).
   */
  readonly url?: string;
}

/* =====================================================================
 * ArtifactSummary — placeholder for the Phase 5 Artifacts workstream.
 *
 * docs/ARTIFACTS.md proposes `ArtifactRef` with required fields uri /
 * name / mediaType / sizeBytes / checksum / producedAt / producedBy.
 * This DTO carries a SUBSET — only what a list-row needs — so the
 * Workbench can render artifact lists today even though the operator
 * hasn't started writing AgentTaskStatus.artifacts yet.
 *
 * When the Artifacts workstream lands, ArtifactSummary collapses into
 * ArtifactRef (or wraps it 1:1) — no breaking change for consumers
 * because the field set here is a strict subset.
 * ===================================================================== */

export interface ArtifactSummary {
  /** Backend-addressable URI (pvc://… in v0.1, s3://… in v0.2). */
  readonly uri: string;

  /** RFC 6838 media type, when known. */
  readonly mediaType?: string;

  /** Byte count at write time, when known. */
  readonly sizeBytes?: number;

  /** UID of the AgentTask that produced this artifact, when known. */
  readonly producedByTask?: string;
}
