/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * SVID rotation interval policy (v0.5.4-keyrotation, Wave 4 / KeyRotation
 * sub-team).
 *
 * Substrate-level policy on per-pod SPIFFE SVID rotation:
 *
 *   - Default: 24h (rotate any SVID older than 24h)
 *   - Minimum: 1h (substrate refuses values lower; SPIRE itself defaults
 *     to 1h on the workload-API stream so a sub-1h interval would just
 *     produce churn the rotation engine couldn't honor)
 *   - Maximum: 168h / 1 week (substrate refuses values higher; an SVID
 *     older than a week violates SOC2 short-lived-credential controls)
 *
 * The Wave 3 Identity sub-team's MockIdentityWatcher polls SPIRE for
 * SVID metadata; this module decides "should THIS SVID rotate now?"
 * given (a) the configured interval, (b) the SVID's notBefore, and
 * (c) the current wall-clock.
 *
 * Pure: no I/O. The watcher calls `decideSvidRotation(...)` per
 * polled SVID; on `'rotate'` the watcher fires `keyrotation.svid_rotated`
 * (this module emits NO audit events itself — emission is the watcher's
 * responsibility, gate-kept by `decideSvidRotation`).
 */

/**
 * Default rotation interval = 24 hours, expressed in seconds. Aligns
 * with the brief: "Default 24h (configurable via Helm
 * `keyRotation.svid.intervalHours`)".
 */
export const DEFAULT_SVID_ROTATION_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * Minimum allowed rotation interval = 1 hour. Substrate refuses lower
 * values. SPIRE's workload-API stream defaults to ~1h on its own; a
 * sub-1h policy here would be ignored by the underlying stream so we
 * fail-fast on the configuration boundary.
 */
export const MIN_SVID_ROTATION_INTERVAL_SECONDS = 60 * 60;

/**
 * Maximum allowed rotation interval = 168 hours (1 week). Substrate
 * refuses higher values. SOC2 short-lived-credential controls treat
 * "fresh-each-week" as the upper bound for production-grade SVIDs.
 */
export const MAX_SVID_ROTATION_INTERVAL_SECONDS = 168 * 60 * 60;

/**
 * `SvidRotationPolicy` — the resolved + validated interval the watcher
 * applies. Constructed via `resolveSvidRotationPolicy(...)`.
 */
export interface SvidRotationPolicy {
  /** Effective rotation interval in seconds. */
  readonly intervalSeconds: number;
}

/**
 * Inputs to `resolveSvidRotationPolicy`. The Helm chart writes
 * `keyRotation.svid.intervalHours` into the operator's env as
 * `KAGENT_KEYROTATION_SVID_INTERVAL_HOURS`; main.ts reads + parses +
 * passes it here.
 */
export interface ResolveSvidPolicyInput {
  /** Hours; undefined = use DEFAULT_SVID_ROTATION_INTERVAL_SECONDS. */
  readonly intervalHours?: number;
}

/**
 * Substrate-policy validation error. Thrown by
 * `resolveSvidRotationPolicy` on a configured value below MIN or above
 * MAX. The operator's main.ts catches this and refuses to boot with
 * KAGENT_KEYROTATION_ENABLED=true — fail-fast on misconfiguration is
 * the substrate's contract.
 */
export class SvidRotationPolicyError extends Error {
  constructor(
    message: string,
    readonly receivedSeconds: number,
    readonly minSeconds: number,
    readonly maxSeconds: number,
  ) {
    super(message);
    this.name = 'SvidRotationPolicyError';
  }
}

/**
 * Resolve + validate the SVID rotation policy from Helm-provided
 * inputs. Returns the policy on success, throws
 * `SvidRotationPolicyError` on out-of-bounds.
 *
 *   - undefined / null / non-finite → default 24h
 *   - <1h → reject (SvidRotationPolicyError)
 *   - >168h → reject (SvidRotationPolicyError)
 *   - everything in between → accept
 *
 * Hour granularity: the chart exposes hours; we convert to seconds for
 * arithmetic in the rotation decision path.
 */
export function resolveSvidRotationPolicy(input: ResolveSvidPolicyInput): SvidRotationPolicy {
  const hours = input.intervalHours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
    return { intervalSeconds: DEFAULT_SVID_ROTATION_INTERVAL_SECONDS };
  }
  const seconds = Math.floor(hours * 60 * 60);
  if (seconds < MIN_SVID_ROTATION_INTERVAL_SECONDS) {
    throw new SvidRotationPolicyError(
      `SVID rotation interval ${seconds}s (${hours}h) below minimum ${MIN_SVID_ROTATION_INTERVAL_SECONDS}s (1h)`,
      seconds,
      MIN_SVID_ROTATION_INTERVAL_SECONDS,
      MAX_SVID_ROTATION_INTERVAL_SECONDS,
    );
  }
  if (seconds > MAX_SVID_ROTATION_INTERVAL_SECONDS) {
    throw new SvidRotationPolicyError(
      `SVID rotation interval ${seconds}s (${hours}h) above maximum ${MAX_SVID_ROTATION_INTERVAL_SECONDS}s (168h / 1 week)`,
      seconds,
      MIN_SVID_ROTATION_INTERVAL_SECONDS,
      MAX_SVID_ROTATION_INTERVAL_SECONDS,
    );
  }
  return { intervalSeconds: seconds };
}

/**
 * Decision input — the watcher hands per-poll metadata for one SVID.
 */
export interface SvidRotationDecisionInput {
  readonly spiffeId: string;
  /** SVID's notBefore (UTC). */
  readonly notBefore: Date;
  /** Current wall-clock; injectable for tests. */
  readonly now: Date;
  readonly policy: SvidRotationPolicy;
}

/**
 * Decision verdict. `keep` = age < interval, no rotation needed.
 * `rotate` = age ≥ interval, watcher should fire
 * `keyrotation.svid_rotated` (and its inner `identity.rotation`
 * companion).
 */
export type SvidRotationDecision =
  | { readonly verdict: 'keep'; readonly ageSeconds: number; readonly intervalSeconds: number }
  | { readonly verdict: 'rotate'; readonly ageSeconds: number; readonly intervalSeconds: number };

/**
 * Decide whether to rotate THIS SVID right now.
 *
 * Algorithm:
 *   - age = floor((now - notBefore) / 1000)
 *   - if age < policy.intervalSeconds → 'keep'
 *   - else → 'rotate'
 *
 * Edge case: if `notBefore > now` (clock skew or freshly-issued SVID
 * with future notBefore), we treat age as 0 + 'keep'. The watcher
 * doesn't refuse the SVID; SPIRE's own clock-skew tolerance handles
 * that case downstream.
 */
export function decideSvidRotation(input: SvidRotationDecisionInput): SvidRotationDecision {
  const ageMs = input.now.getTime() - input.notBefore.getTime();
  const ageSeconds = Math.max(0, Math.floor(ageMs / 1000));
  const intervalSeconds = input.policy.intervalSeconds;
  if (ageSeconds < intervalSeconds) {
    return { verdict: 'keep', ageSeconds, intervalSeconds };
  }
  return { verdict: 'rotate', ageSeconds, intervalSeconds };
}
