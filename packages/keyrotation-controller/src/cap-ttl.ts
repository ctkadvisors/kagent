/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Capability bundle TTL policy (v0.5.4-keyrotation, Wave 4 / KeyRotation
 * sub-team).
 *
 * Substrate-level policy on capability JWT TTLs:
 *
 *   - Default: 1h for short-running tasks (no `runConfig.timeoutSeconds`
 *     OR `runConfig.timeoutSeconds <= 3600`)
 *   - Long-running tasks (`runConfig.timeoutSeconds > 3600`):
 *     TTL = min(24h, runConfig.timeoutSeconds + 300s)
 *     The 300s grace ("5min beyond timeout") gives the agent-pod
 *     enough headroom for graceful shutdown / final status patch
 *     without the cap expiring mid-flight; the 24h ceiling caps the
 *     blast radius of a leaked cap (substrate refuses to issue a cap
 *     that lives longer than the 24h SVID rotation horizon).
 *
 * The cap-issuer (operator-side) consumes this policy when computing
 * `exp` for a freshly minted capability bundle. The previous
 * cap-issuer behavior (timeoutSeconds + 60s slack OR JWT helper
 * default) is replaced by this Wave 4 policy when KEYROTATION is
 * enabled.
 *
 * Pure: no I/O. No audit emission here — the cap-issuer fires
 * `keyrotation.cap_minted_with_ttl` after applying the policy so the
 * tier the resolver hit is auditable.
 */

/**
 * Default short-running TTL = 1 hour, in seconds. Aligned with
 * Helm value `keyRotation.cap.shortTtlMinutes` (default 60).
 */
export const DEFAULT_SHORT_RUNNING_TTL_SECONDS = 60 * 60;

/**
 * Threshold (seconds) above which a task's `runConfig.timeoutSeconds`
 * triggers the long-running TTL path. = 1 hour.
 */
export const LONG_RUNNING_THRESHOLD_SECONDS = 60 * 60;

/**
 * Hard ceiling for any cap TTL = 24 hours, in seconds. Substrate
 * refuses to issue caps living longer than the SVID rotation horizon.
 */
export const MAX_CAP_TTL_SECONDS = 24 * 60 * 60;

/**
 * Default grace beyond the task's `timeoutSeconds` for the long-running
 * TTL path = 300 seconds. Helm value `keyRotation.cap.longTtlGraceSeconds`.
 */
export const DEFAULT_LONG_TTL_GRACE_SECONDS = 300;

/**
 * The `CapTtlPolicy` — the resolved + validated policy the cap-issuer
 * applies. Constructed via `resolveCapTtlPolicy(...)`.
 */
export interface CapTtlPolicy {
  /** TTL applied to short-running tasks (seconds). */
  readonly shortTtlSeconds: number;
  /** Grace seconds added to long-running tasks' timeoutSeconds. */
  readonly longTtlGraceSeconds: number;
  /** Hard ceiling — caps may not exceed this. */
  readonly maxTtlSeconds: number;
  /** Threshold above which a task is "long-running" (seconds). */
  readonly longRunningThresholdSeconds: number;
}

/**
 * Inputs to `resolveCapTtlPolicy`. Helm exposes
 * `keyRotation.cap.shortTtlMinutes` (default 60) and
 * `keyRotation.cap.longTtlGraceSeconds` (default 300); main.ts
 * passes their parsed numeric values here.
 */
export interface ResolveCapTtlPolicyInput {
  /** Minutes; undefined = default 60. */
  readonly shortTtlMinutes?: number;
  /** Seconds; undefined = default 300. */
  readonly longTtlGraceSeconds?: number;
}

/**
 * Substrate-policy validation error — analogous to
 * `SvidRotationPolicyError`. Thrown when configured values are
 * non-positive or above the hard ceilings.
 */
export class CapTtlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapTtlPolicyError';
  }
}

/**
 * Resolve + validate the cap TTL policy from Helm-provided inputs.
 *
 *   - undefined / non-finite / non-positive shortTtlMinutes →
 *     default 60min
 *   - shortTtlMinutes * 60 > maxTtlSeconds → reject
 *   - undefined / non-finite / negative longTtlGraceSeconds →
 *     default 300s
 *   - longTtlGraceSeconds > maxTtlSeconds → reject
 */
export function resolveCapTtlPolicy(input: ResolveCapTtlPolicyInput): CapTtlPolicy {
  const minutes = input.shortTtlMinutes;
  let shortTtlSeconds: number;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    shortTtlSeconds = DEFAULT_SHORT_RUNNING_TTL_SECONDS;
  } else {
    shortTtlSeconds = Math.floor(minutes * 60);
  }
  if (shortTtlSeconds > MAX_CAP_TTL_SECONDS) {
    throw new CapTtlPolicyError(
      `cap shortTtl ${shortTtlSeconds}s above ceiling ${MAX_CAP_TTL_SECONDS}s (24h)`,
    );
  }

  const grace = input.longTtlGraceSeconds;
  let longTtlGraceSeconds: number;
  if (typeof grace !== 'number' || !Number.isFinite(grace) || grace < 0) {
    longTtlGraceSeconds = DEFAULT_LONG_TTL_GRACE_SECONDS;
  } else {
    longTtlGraceSeconds = Math.floor(grace);
  }
  if (longTtlGraceSeconds > MAX_CAP_TTL_SECONDS) {
    throw new CapTtlPolicyError(
      `cap longTtlGrace ${longTtlGraceSeconds}s above ceiling ${MAX_CAP_TTL_SECONDS}s (24h)`,
    );
  }

  return {
    shortTtlSeconds,
    longTtlGraceSeconds,
    maxTtlSeconds: MAX_CAP_TTL_SECONDS,
    longRunningThresholdSeconds: LONG_RUNNING_THRESHOLD_SECONDS,
  };
}

/**
 * Decision input — the cap-issuer hands the task's
 * `runConfig.timeoutSeconds` (or undefined for short-running tasks)
 * + the resolved policy.
 */
export interface CapTtlDecisionInput {
  /** From AgentTask.spec.runConfig.timeoutSeconds (or legacy timeoutSeconds). */
  readonly timeoutSeconds: number | undefined;
  readonly policy: CapTtlPolicy;
}

/**
 * Resolved cap TTL + the policy tier that produced it. The cap-issuer
 * stamps `tier` on the audit envelope so dashboards can split usage.
 */
export interface CapTtlDecision {
  readonly ttlSeconds: number;
  readonly tier: 'short-running' | 'long-running-grace' | 'long-running-clamped';
}

/**
 * Compute the cap TTL for an admitted AgentTask.
 *
 * Algorithm:
 *
 *   - timeoutSeconds undefined OR ≤ longRunningThresholdSeconds
 *     → tier=short-running, ttl = policy.shortTtlSeconds
 *
 *   - timeoutSeconds > longRunningThresholdSeconds
 *     → candidate = timeoutSeconds + policy.longTtlGraceSeconds
 *     → if candidate ≤ policy.maxTtlSeconds:
 *         tier=long-running-grace, ttl = candidate
 *       else:
 *         tier=long-running-clamped, ttl = policy.maxTtlSeconds
 *
 * The clamp tier exists so audit dashboards can spot a task whose
 * declared timeout EXCEEDED what the substrate is willing to back —
 * useful for compliance / SOC2 boundary detection.
 */
export function decideCapTtl(input: CapTtlDecisionInput): CapTtlDecision {
  const t = input.timeoutSeconds;
  const policy = input.policy;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= policy.longRunningThresholdSeconds) {
    return { ttlSeconds: policy.shortTtlSeconds, tier: 'short-running' };
  }
  const candidate = Math.floor(t) + policy.longTtlGraceSeconds;
  if (candidate <= policy.maxTtlSeconds) {
    return { ttlSeconds: candidate, tier: 'long-running-grace' };
  }
  return { ttlSeconds: policy.maxTtlSeconds, tier: 'long-running-clamped' };
}
