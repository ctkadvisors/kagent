/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/locality-controller` — Wave 3 / Locality sub-team
 * (v0.4.4-locality).
 *
 * Three pure-function deliverables consumed by the operator:
 *
 *   1. `deriveNodeAffinity(agent, task, lookup) → V1Affinity | undefined`
 *      Workspace-derived NodeAffinity: when an Agent declares a
 *      `kind: 'workspace'` input bound to a Workspace whose PV is
 *      node-pinned, emit `requiredDuringSchedulingIgnoredDuringExecution`
 *      mirroring the PV's `nodeAffinity.required.nodeSelectorTerms[]`.
 *      Tie-break across multiple workspaces: largest `bytesUsed`.
 *
 *   2. Speculative execution: `evaluateSpeculative` decides per
 *      AgentTask whether to spawn a duplicate (same idempotency key →
 *      Wave 1 cache prevents double-effect; first to Completed wins;
 *      loser → status `superseded`). Per-Agent in-process latency
 *      histograms (100-sample ring buffer).
 *
 *   3. Pod-pressure circuit breaker: `checkPodPressure` (lives in the
 *      operator's `admission.ts` to keep the gate close to the rest
 *      of the admission machinery). When pending agent-pod count >
 *      `KAGENT_LOCALITY_MAX_PENDING_PODS` (default 50), admission
 *      defers with `policy_denied:pod_pressure_threshold`.
 *
 * Defaults (per docs/WAVES.md §5.5):
 *   - affinity:                  ENABLED
 *   - speculative:               DISABLED (doubles spawns; opt-in)
 *   - speculative threshold:     3.0× per-Agent median latency
 *   - circuit breaker:           50 pending agent-pods
 */

export { deriveNodeAffinity } from './node-affinity.js';
export type { WorkspaceLookup } from './node-affinity.js';

export {
  buildTwinManifest,
  DEFAULT_HISTOGRAM_CAPACITY,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_SPECULATIVE_THRESHOLD,
  evaluateSpeculative,
  LatencyHistogram,
  LatencyHistogramRegistry,
  SPECULATIVE_PRIMARY_UID_LABEL,
  SPECULATIVE_TWIN_LABEL,
} from './speculative.js';
export type {
  EvaluateSpeculativeInput,
  SpawnTwinFn,
  SpeculativeAuditHooks,
  SpeculativeDecision,
  SpeculativeEngineOptions,
  SpeculativeSpawnedFields,
  SpeculativeSupersededFields,
  TwinManifest,
} from './speculative.js';

export type {
  AffinityAgent,
  AffinityAgentSpec,
  AffinityAgentTaskSpec,
  AffinityInputBinding,
  AffinityInputDecl,
  AffinityTask,
  Workspace,
  WorkspaceStatusShape,
} from './types.js';
