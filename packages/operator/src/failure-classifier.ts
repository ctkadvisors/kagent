/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure-functional failure classifier — Wave 2 / Supervision sub-team
 * (v0.3.1).
 *
 * Distinguishes **structured violations** (an application-layer
 * contract failure) from **infrastructure faults** (K8s primitives
 * dying outside the agent's control). Only structured violations
 * trigger the supervision strategy engine. Infra faults flow through
 * K8s' own backoffLimit; the operator emits an `infra.fault.observed`
 * audit event for visibility but does NOT restart-route via
 * supervision (otherwise a flaky node would multiply runaway-loop
 * traffic).
 *
 * Single source of truth for the dichotomy. The operator's
 * reconciler asks `classifyFailure(reason)` BEFORE calling the
 * supervision engine; the integration test asserts both paths.
 *
 * Side-effect-free + dependency-free; co-located with
 * `failure-detector.ts` so the existing terminal-failure surface
 * stays cohesive.
 */

/**
 * Three classes of terminal-state cause:
 *
 *   - `structured`     — application-layer contract failure. The
 *                        agent-pod (or operator admission) attributed
 *                        the failure to a known structured reason
 *                        like `MissingRequiredOutputs`,
 *                        `InvalidInputs`, `capability_violation`,
 *                        `contract.violated`. Supervision strategy
 *                        applies.
 *   - `infra`          — K8s / kubelet / image-registry / scheduler
 *                        fault. `OOMKilled`, `ImagePullBackOff`,
 *                        `Unschedulable`, `BackoffLimitExceeded`,
 *                        `DeadlineExceeded`, etc. Supervision is
 *                        NOT routed; K8s Job backoffLimit handles it
 *                        (operator emits `infra.fault.observed`).
 *   - `unknown`        — reason not in either catalog. Conservative
 *                        default treats this as STRUCTURED so an
 *                        Agent-attributed `Failed` (without an
 *                        explicit substrate reason tag) still
 *                        flows through supervision. Operators can
 *                        broaden the structured catalog over time.
 */
export type FailureClass = 'structured' | 'infra' | 'unknown';

/**
 * Reason tags the operator + agent-pod emit for structured contract
 * violations. Mirrors the call-site catalog at v0.2.0 + v0.3.0:
 *
 *   - `InvalidInputs`            — admission typed-input check
 *                                  (reconcile.ts step 2.1)
 *   - `MissingRequiredOutputs`   — completion-contract check
 *                                  (reconcile.ts enforceCompletionContract)
 *   - `IdempotencyConflict`      — same idempotency key, different
 *                                  input hash
 *   - `capability_violation`     — caps subset check failed
 *                                  (admission.ts validateCapabilityBounds)
 *   - `policy_denied:*`          — admission policy denial family
 *                                  (depth_exceeded, capability_violation,
 *                                  IdempotencyConflict, …)
 *   - `verify_failed`            — verifyContract substrate hook
 *                                  refused Completed
 *   - `contract.violated`        — generic structured-violation tag
 *                                  used in audit events
 */
const STRUCTURED_REASONS: ReadonlySet<string> = new Set([
  'InvalidInputs',
  'MissingRequiredOutputs',
  'IdempotencyConflict',
  'capability_violation',
  'verify_failed',
  'contract.violated',
  'PolicyDenied',
  'restart_limit_exceeded',
  'supervision_terminated',
]);

/**
 * Reason tags the failure-detector + watchers emit for infrastructure
 * faults. Includes the conditions surfaced by `detectJobFailure` /
 * `detectPodFailure` plus a few common names operators see in
 * `kubectl describe`.
 */
const INFRA_REASONS: ReadonlySet<string> = new Set([
  'JobFailed',
  'BackoffLimitExceeded',
  'DeadlineExceeded',
  'OOMKilled',
  'PodFailed',
  'Unschedulable',
  'ImagePullBackOff',
  'ErrImagePull',
  'CrashLoopBackOff',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
  'InvalidImageName',
  'PreCreateHookError',
  'PostStartHookError',
  'NodeNotReady',
  'NodeLost',
  'Evicted',
  'ContainerCannotRun',
]);

/**
 * Classify a failure reason. Accepts the raw reason string the
 * operator already attributes (typically the `reason` field of an
 * `AgentTaskCondition` or the `reason` from a
 * `failure-detector.FailureVerdict`). Returns the failure-class so
 * the reconciler routes accordingly.
 *
 * Matching is case-sensitive but tolerant of common compound forms:
 *   - exact match in either catalog
 *   - `policy_denied:<X>` prefix → structured
 *   - `Job/<X>` or `Pod/<X>` prefix (the `failure-source/<reason>`
 *     shape `markAgentTaskFailedFromExternal` writes) → strip the
 *     prefix and re-match
 *   - empty / undefined → unknown (conservative — treat as structured)
 */
export function classifyFailure(reason: string | undefined): FailureClass {
  if (typeof reason !== 'string' || reason.length === 0) return 'unknown';

  // Strip a `Job/` or `Pod/` source prefix the watcher pipeline writes.
  const sourceStripped = stripSourcePrefix(reason);

  // `policy_denied:<X>` prefix is unconditionally structured (admission
  // refusals are application-policy decisions, not infra faults).
  if (sourceStripped.startsWith('policy_denied:')) return 'structured';

  if (STRUCTURED_REASONS.has(sourceStripped)) return 'structured';
  if (INFRA_REASONS.has(sourceStripped)) return 'infra';
  // Some Pod / Job conditions arrive as the literal "PodFailed"
  // wrapped — handle a few common case-variants.
  if (sourceStripped.toLowerCase().includes('imagepull')) return 'infra';
  if (sourceStripped.toLowerCase().includes('oomkilled')) return 'infra';
  if (sourceStripped.toLowerCase().includes('evicted')) return 'infra';

  return 'unknown';
}

/**
 * `Job/Failed` → `Failed`. `Pod/OOMKilled` → `OOMKilled`. Idempotent
 * for inputs without a recognized prefix.
 */
function stripSourcePrefix(reason: string): string {
  const prefixes = ['Job/', 'Pod/', 'job/', 'pod/'];
  for (const p of prefixes) {
    if (reason.startsWith(p)) return reason.slice(p.length);
  }
  return reason;
}

/**
 * Convenience predicate: should the operator route this failure
 * through the supervision strategy engine? `unknown` is treated as
 * structured (conservative — supervision still applies, default
 * `one_for_one` matches v0.1's implicit behavior).
 */
export function shouldTriggerSupervision(reason: string | undefined): boolean {
  const cls = classifyFailure(reason);
  return cls === 'structured' || cls === 'unknown';
}

/**
 * Convenience predicate: is this an infrastructure-attributable
 * failure (operator emits `infra.fault.observed`, lets K8s
 * backoffLimit handle the retry)?
 */
export function isInfraFault(reason: string | undefined): boolean {
  return classifyFailure(reason) === 'infra';
}
