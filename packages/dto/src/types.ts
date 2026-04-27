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

import type { AgentTaskPhase } from './crds.js';
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
