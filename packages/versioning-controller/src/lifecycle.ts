/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Deprecation lifecycle — Wave 4 / Versioning sub-team
 * (v0.5.3-versioning). Per docs/WAVES.md §6.4 deliverable 5:
 *
 *   - `kagent.knuteson.io/deprecated: 'true'` — Agent still serves
 *     in-flight tasks, NEW tasks emit a warning audit event
 *     (`agent.deprecated_used`). The substrate does NOT refuse the
 *     task — operators see a deprecation signal and migrate at their
 *     own pace.
 *
 *   - `kagent.knuteson.io/removed-at: '<RFC 3339>'` — past this date,
 *     NEW tasks REFUSE with `policy_denied:agent_removed`. In-flight
 *     tasks continue (their pinned `agentVersion` keeps the immutable
 *     Agent CR alive in the index).
 *
 * Sweep cadence: 1 hour (`lifecycleSweepTickMs`). The operator's
 * versioning-controller runs the sweeper on a `setInterval`; tests
 * invoke `evaluateLifecycle` directly.
 *
 * The sweeper itself does NOT mutate the cluster — it just walks the
 * `AgentVersionIndex`, classifies each entry, and emits diagnostic
 * logs. The actual gating (refuse-on-removed, warn-on-deprecated) is
 * enforced at AgentTask admission time via `pinAgentVersion` in
 * `task-admission.ts` consuming this same `evaluateLifecycle` helper.
 */

import { DEPRECATED_ANNOTATION, REMOVED_AT_ANNOTATION } from './constants.js';
import type { VersionedAgent } from './types.js';

/**
 * Default sweep interval — 1 hour. Documented in the JSDoc on the
 * sweeper wiring. Operators don't tune this in v0.5.3; the field is
 * exported for tests + future configurability.
 */
export const lifecycleSweepTickMs = 60 * 60 * 1000;

/**
 * Coarse lifecycle classification:
 *   - `'active'`     — no deprecation annotation, no removed-at.
 *   - `'deprecated'` — `deprecated: 'true'` set; `removed-at` absent
 *                      OR not yet past.
 *   - `'removed'`    — `removed-at` set AND past the current time.
 */
export type LifecycleStatus = 'active' | 'deprecated' | 'removed';

export interface LifecycleEvaluation {
  readonly status: LifecycleStatus;
  /**
   * When `status === 'deprecated'`, the diagnostic message used in
   * `agent.deprecated_used` audit emission. When `status === 'removed'`,
   * the structured refusal reason for `policy_denied:agent_removed`.
   * Empty string for `'active'`.
   */
  readonly message: string;
  /**
   * Parsed `removed-at` epoch-ms. Undefined when the annotation is
   * unset or unparseable. Useful for diagnostics + the sweep tick log.
   */
  readonly removedAtMs?: number;
}

/**
 * Pure decision: classify an Agent's annotations as active /
 * deprecated / removed. Pass `now` (defaults to `Date.now()`); tests
 * pin a fixed clock.
 */
export function evaluateLifecycle(
  agent: VersionedAgent,
  now: number = Date.now(),
): LifecycleEvaluation {
  const annotations = agent.metadata.annotations ?? {};
  const removedAtRaw = annotations[REMOVED_AT_ANNOTATION];
  const deprecatedRaw = annotations[DEPRECATED_ANNOTATION];

  const removedAtMs =
    typeof removedAtRaw === 'string' && removedAtRaw.length > 0
      ? parseRfc3339(removedAtRaw)
      : undefined;

  if (removedAtMs !== undefined && removedAtMs <= now) {
    const ns = agent.metadata.namespace ?? 'default';
    const nm = agent.metadata.name ?? '(no-name)';
    return {
      status: 'removed',
      message: `policy_denied:agent_removed — Agent ${ns}/${nm} (removed-at=${removedAtRaw}, now=${new Date(now).toISOString()})`,
      removedAtMs,
    };
  }

  if (typeof deprecatedRaw === 'string' && deprecatedRaw.trim().toLowerCase() === 'true') {
    const ns = agent.metadata.namespace ?? 'default';
    const nm = agent.metadata.name ?? '(no-name)';
    const ev: LifecycleEvaluation = {
      status: 'deprecated',
      message: `agent.deprecated_used — Agent ${ns}/${nm} is deprecated; migrate to a newer version. Removal scheduled: ${removedAtRaw ?? '(none)'}`,
      ...(removedAtMs !== undefined && { removedAtMs }),
    };
    return ev;
  }

  return removedAtMs !== undefined
    ? { status: 'active', message: '', removedAtMs }
    : { status: 'active', message: '' };
}

/**
 * Parse an RFC 3339 timestamp into epoch-ms; return undefined on
 * malformed input rather than NaN so the classifier can tell
 * "annotation set, unparseable" apart from "annotation absent".
 */
function parseRfc3339(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
