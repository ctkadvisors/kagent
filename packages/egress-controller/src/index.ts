/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/egress-controller` — per-Agent NetworkPolicy +
 * CiliumNetworkPolicy generation from `Agent.spec.egress`, with
 * tenant-default fallback (`Tenant.spec.defaultEgress`) and substrate
 * default-deny baseline.
 *
 * Wave 4 / Egress sub-team (v0.5.1-egress). See:
 *   - docs/SUBSTRATE-V1.md §3.1 (`Agent.spec.egress`) + §3.6 (Capability)
 *   - docs/WAVES.md §6.2 (Wave 4 / Egress sub-team brief)
 *
 * The package is pure-functional below the apply boundary:
 *   - `buildNetworkPolicyForAgent` / `buildCiliumNetworkPolicyForAgent`
 *     are pure builders; testable without a KubeConfig.
 *   - `resolveEffectiveEgress` / `applyResolvedEgress` are pure
 *     decision helpers; substrate uses them to merge the tenant
 *     default into the per-Agent allowlist.
 *   - `applyNetworkPolicyForAgent` / `deleteNetworkPolicyForAgent`
 *     own the K8s API calls — operator wires its existing
 *     `NetworkingV1Api` + `CustomObjectsApi` into these.
 *
 * The operator's `// === Wave 4 — Egress ===` block in `main.ts`
 * watches Agent CRs and dispatches into `applyNetworkPolicyForAgent`
 * on every add/update; `deleteNetworkPolicyForAgent` runs on the
 * delete path (ownerRef cascade is the safety net; explicit delete is
 * faster + observable).
 */

export {
  AGENT_LABEL_KEY,
  POLICY_MANAGED_LABEL_KEY,
  POLICY_MANAGED_LABEL_VALUE,
  POLICY_NAME_PREFIX,
  buildCiliumNetworkPolicyForAgent,
  buildNetworkPolicyForAgent,
  detectCiliumInstalled,
  ownerRefForAgent,
  policyNameForAgent,
  resolveSubstrateInternal,
} from './policy.js';
export type {
  BuildNetworkPolicyResult,
  CiliumEgressRule,
  CiliumEndpointSelector,
  CiliumNetworkPolicy,
  CiliumPortProtocol,
  CiliumPortRule,
} from './policy.js';

export { applyResolvedEgress, resolveEffectiveEgress } from './resolver.js';

export {
  TENANT_LABEL_KEY,
  applyNetworkPolicyForAgent,
  deleteNetworkPolicyForAgent,
} from './apply.js';
export type {
  ApplyEgressDeps,
  ApplyEgressResult,
  EgressMode,
  PolicyAppliedEmissionData,
} from './apply.js';

export { DEFAULT_SUBSTRATE_INTERNAL } from './types.js';
export type {
  AgentEgressLike,
  AgentLike,
  PolicyBuilderDefaults,
  SubstrateInternalEndpoints,
  TenantLike,
} from './types.js';
