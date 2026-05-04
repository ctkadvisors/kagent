/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/versioning-controller` — Wave 4 / Versioning sub-team
 * (v0.5.3-versioning).
 *
 * Pure-function deliverables consumed by the operator:
 *
 *   1. `validateAgentMutation` — admission-webhook validator that
 *      refuses any change to `Agent.spec.*` after publication. Allows
 *      the one-shot `kagent.knuteson.io/published: false → true`
 *      annotation flip; allows status / label / other-annotation
 *      writes freely.
 *
 *   2. `AgentVersionIndex` — informer-driven map keyed by Agent name
 *      with per-name version registries. The reconciler uses
 *      `lookupExact(name, version)` to fetch the precise Agent CR a
 *      pinned AgentTask was admitted against; new tasks call
 *      `lookupLatest(name)` for the version-pinning resolution.
 *
 *   3. `evaluateLifecycle` — pure decision function that classifies
 *      an Agent's `metadata.annotations` into `'active' | 'deprecated'
 *      | 'removed'`. The operator's deprecation sweeper invokes this
 *      on a 1h tick; new-task admission consults it to either emit
 *      the warning (`agent.deprecated_used`) or refuse outright
 *      (`policy_denied:agent_removed`).
 *
 * Defaults (per docs/WAVES.md §6.4):
 *   - Default `Agent.spec.version` when absent at admission: `'0.0.0'`.
 *   - Comparison: LEXICAL (substrate never parses semver).
 *   - Deprecation sweep tick: 1 hour.
 *   - Webhook failurePolicy default: `Fail` (refuse on webhook
 *     unreachable — tighter than K8s default `Ignore`).
 */

export {
  PUBLISHED_ANNOTATION,
  DEPRECATED_ANNOTATION,
  REMOVED_AT_ANNOTATION,
  DEFAULT_AGENT_VERSION,
} from './constants.js';

export { validateAgentMutation, reviewAgentAdmission, isStructurallyEqual } from './webhook.js';
export type {
  AdmissionReviewRequest,
  AdmissionReviewResponse,
  AgentMutationRefusalReason,
  ValidationResult,
} from './webhook.js';

export { AgentVersionIndex, compareVersions, resolveAgentVersion } from './version-index.js';
export type { AgentVersionIndexEntry, AgentVersionLookup } from './version-index.js';

export { evaluateLifecycle, lifecycleSweepTickMs } from './lifecycle.js';
export type { LifecycleStatus, LifecycleEvaluation } from './lifecycle.js';

export type {
  VersionedAgent,
  VersionedAgentAnnotations,
  VersionedAgentMetadata,
  VersionedAgentSpec,
} from './types.js';
