/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/supervision` — Erlang/OTP-style supervision strategies for
 * AgentTask trees. The four strategies map 1:1 to OTP supervisor
 * behaviors (`one_for_one | one_for_all | rest_for_one | escalate`):
 *
 *   - **`one_for_one`** — restart only the failed child. Siblings
 *     continue. This is the substrate's default + matches v0.1's
 *     implicit "fail one, others continue" semantics, so existing
 *     Agents that don't declare a strategy keep their behavior.
 *   - **`one_for_all`** — terminate every sibling AND the failed child;
 *     restart the whole task tree from a clean slate.
 *   - **`rest_for_one`** — terminate the failed child + every sibling
 *     started AFTER it (in start-order); restart that subset. Siblings
 *     started BEFORE the failed child are preserved.
 *   - **`escalate`** — terminate this whole subtree and propagate the
 *     failure upward to the parent AgentTask. The parent's strategy
 *     then handles this subtree as a single failed child.
 *
 * The engine is **stateless** + **pure-functional**. Given an in-order
 * sibling list + the failed child + the strategy, it returns a
 * `SupervisionDecision` describing what action to take and which task
 * UIDs the action targets. No K8s, no audit, no I/O — the operator
 * reconciler is the I/O surface; this module is the pure decision core.
 *
 * Per docs/WAVES.md §4.2.
 */

/** Strategy enum mirrored on `Agent.spec.supervisionStrategy`. */
export type SupervisionStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one' | 'escalate';

/** All four strategies, frozen for runtime enumeration. */
export const ALL_SUPERVISION_STRATEGIES: readonly SupervisionStrategy[] = Object.freeze([
  'one_for_one',
  'one_for_all',
  'rest_for_one',
  'escalate',
] as const);

/** Default strategy when an Agent doesn't declare one. */
export const DEFAULT_SUPERVISION_STRATEGY: SupervisionStrategy = 'one_for_one';

/** Default `maxRestarts` cap when an Agent doesn't declare one. */
export const DEFAULT_MAX_RESTARTS = 3;

/**
 * Lightweight reference to an AgentTask. The engine is K8s-agnostic:
 * `uid` is opaque (the operator passes `metadata.uid`); `name` and
 * `namespace` are carried only for human-readable logging in the
 * decision payload, never inspected.
 */
export interface TaskRef {
  readonly uid: string;
  readonly name?: string;
  readonly namespace?: string;
}

/**
 * Snapshot of a sibling AgentTask the engine consumes when computing
 * a decision. Carries just enough state for the strategy to decide
 * whether the sibling is currently in-flight (and thus a restart /
 * terminate target) or already terminal.
 *
 * `startedAt` orders siblings for `rest_for_one` — operator wires this
 * from `AgentTask.status.startedAt` (RFC 3339 ISO timestamp). Tasks
 * without a startedAt sort last (still-pending tasks have no concrete
 * start order; treating them as "after" is consistent with the OTP
 * "terminated children after this one" reading).
 */
export interface SiblingTask {
  readonly ref: TaskRef;
  /**
   * Phase at decision time. Terminal (`Completed | Failed`) tasks are
   * NEVER targeted by terminate / restart actions — the strategy
   * engine only acts on in-flight siblings (`Pending | Dispatched`).
   */
  readonly phase: 'Pending' | 'Dispatched' | 'Completed' | 'Failed';
  /**
   * RFC 3339 ISO timestamp; used for `rest_for_one` ordering. May be
   * absent for tasks that haven't dispatched yet (they sort last).
   */
  readonly startedAt?: string;
  /**
   * Current restart counter on `AgentTask.status.restartCount`.
   * Operator uses this to compare against `maxRestarts` after the
   * engine returns its decision. Carried on the snapshot so future
   * strategies can self-reference (today's strategies don't read it).
   */
  readonly restartCount?: number;
}

/**
 * Information about the failure that triggered the supervision pass.
 * Kept tiny — the engine doesn't classify reasons, the
 * `failure-classifier` module on the operator side does that BEFORE
 * supervision even runs (infra faults short-circuit; only structured
 * violations enter the engine).
 */
export interface FailedChild {
  readonly ref: TaskRef;
  /**
   * Structured reason from the operator's failure classifier. Kept as
   * an opaque string here — the engine treats every reason the same;
   * the audit emission carries the reason verbatim.
   */
  readonly reason: string;
  /** Optional message for operator/audit visibility. Not consulted. */
  readonly message?: string;
}

/**
 * The four action verbs the engine emits. The operator reconciler
 * dispatches each to the correct K8s primitive:
 *
 *   - `restart` — patch `restartCount += 1` and re-dispatch (subject
 *     to `maxRestarts` fail-closed).
 *   - `terminate-and-restart-tree` — patch every target Failed with
 *     `reason: supervision_terminated`, then restart the parent's
 *     entire children list as a fresh tree.
 *   - `terminate-and-restart-subset` — patch the subset Failed with
 *     `reason: supervision_terminated`, then restart that subset.
 *   - `escalate-to-parent` — propagate this failure up; operator
 *     re-runs supervision on the parent AgentTask using the parent
 *     Agent's strategy.
 */
export type SupervisionAction =
  | 'restart'
  | 'terminate-and-restart-tree'
  | 'terminate-and-restart-subset'
  | 'escalate-to-parent';

/**
 * Pure decision object — what the operator must do. `targets[]` is
 * the in-order list of task UIDs the action applies to:
 *
 *   - `restart`                       → exactly one entry: the failed child.
 *   - `terminate-and-restart-tree`    → every in-flight sibling + the failed child.
 *   - `terminate-and-restart-subset`  → the failed child + every sibling started after it.
 *   - `escalate-to-parent`            → exactly one entry: the failed child
 *                                       (operator walks parent chain itself).
 *
 * `strategy` echoes the input strategy for audit-event convenience.
 * `reason` is the engine's human-readable explanation for the
 * decision (used in audit + condition messages).
 */
export interface SupervisionDecision {
  readonly action: SupervisionAction;
  readonly strategy: SupervisionStrategy;
  readonly targets: readonly TaskRef[];
  readonly reason: string;
}
