/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/keyrotation-controller` — Wave 4 / KeyRotation sub-team
 * (v0.5.4-keyrotation).
 *
 * Pure-helper deliverables (consumed by the operator's main.ts +
 * cap-issuer + identity watcher):
 *
 *   1. `svid-policy.ts` — SVID rotation interval policy
 *      (24h default; min 1h; max 168h). Wired into Wave 3's
 *      MockIdentityWatcher: the watcher polls SPIRE for SVID
 *      metadata and emits `identity.rotation` (Wave 3 event) +
 *      `keyrotation.svid_rotated` (Wave 4 event) when age crosses
 *      the configured interval.
 *
 *   2. `cap-ttl.ts` — Capability bundle TTL policy
 *      (1h short-running default; long-running tasks get
 *      `min(24h, runConfig.timeoutSeconds + 300s)`). Wired into
 *      Wave 2's `cap-issuer.mintCapabilityForTask`.
 *
 *   3. `gateway-rotation.ts` — gateway-token rotation API integration
 *      per docs/GATEWAY-CONTRACT.md §4. Scheduled (24h cadence
 *      default) call into `POST /v1/admin/keys/rotate`; gracefully
 *      no-ops on 404 (gateway lacks the contract version) + emits
 *      `keyrotation.gateway_unsupported` for operator visibility.
 *
 *   4. Audit-event surface (in `@kagent/audit-events` additive):
 *      4 new event types — `keyrotation.svid_rotated`,
 *      `keyrotation.cap_minted_with_ttl`,
 *      `keyrotation.gateway_rotated`,
 *      `keyrotation.gateway_unsupported`.
 *
 *   5. Zero-downtime rotation chaos test (`test/chaos.test.ts`) —
 *      simulates a rotation cycle (SVID + cap + gateway-token
 *      simultaneously) and asserts no in-flight task fails.
 *
 * No K8s API surface lives here — these are pure functions consumed
 * by the operator. See `docs/WAVES.md` §6.5 for the brief.
 */

export {
  DEFAULT_SVID_ROTATION_INTERVAL_SECONDS,
  MIN_SVID_ROTATION_INTERVAL_SECONDS,
  MAX_SVID_ROTATION_INTERVAL_SECONDS,
  resolveSvidRotationPolicy,
  decideSvidRotation,
  SvidRotationPolicyError,
} from './svid-policy.js';
export type {
  SvidRotationPolicy,
  ResolveSvidPolicyInput,
  SvidRotationDecisionInput,
  SvidRotationDecision,
} from './svid-policy.js';

export {
  DEFAULT_SHORT_RUNNING_TTL_SECONDS,
  LONG_RUNNING_THRESHOLD_SECONDS,
  MAX_CAP_TTL_SECONDS,
  DEFAULT_LONG_TTL_GRACE_SECONDS,
  resolveCapTtlPolicy,
  decideCapTtl,
  CapTtlPolicyError,
} from './cap-ttl.js';
export type {
  CapTtlPolicy,
  ResolveCapTtlPolicyInput,
  CapTtlDecisionInput,
  CapTtlDecision,
} from './cap-ttl.js';

export {
  DEFAULT_GATEWAY_ROTATION_INTERVAL_MS,
  rotateGatewayOnce,
  scheduleGatewayRotation,
} from './gateway-rotation.js';
export type {
  GatewayRotationOutcome,
  GatewayFetchFn,
  GatewayFetchInit,
  GatewayFetchResponse,
  RotateGatewayInput,
  ScheduleGatewayRotationInput,
  ScheduledGatewayRotation,
} from './gateway-rotation.js';
