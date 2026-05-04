/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/quota-controller` — Wave 4 / Quotas sub-team
 * (v0.5.2-quotas).
 *
 * Three pure-function deliverables consumed by the operator:
 *
 *   1. `buildResourceQuotaForTenant({ tenant, namespace })` →
 *      `V1ResourceQuota | undefined`. Translates a Tenant CR's
 *      `spec.defaultQuota.compute` into a per-(tenant, namespace)
 *      Kubernetes `ResourceQuota` CR. Returns undefined when no
 *      compute caps are declared (cluster-admin's own quotas in the
 *      same namespace stay untouched).
 *
 *   2. `GatewayInFlightCounter` + `tryAcquire/release` —
 *      in-process per-tenant counter of concurrent in-flight gateway
 *      requests. Refuses with
 *      `policy_denied:tenant_gateway_inflight_exceeded` when the
 *      tenant's `defaultQuota.gateway.inFlightCap` is exceeded.
 *      Single-replica leader-elected operator constraint
 *      (substrate's v0.1 posture) keeps state local; the public API
 *      stays stable across the v0.5.3+ multi-replica refinement.
 *
 *   3. `walkCasUsageByTenant` + `startCasQuotaController` +
 *      `checkTenantStorage` — periodic 10-minute walker sums on-disk
 *      CAS bytes per tenant; admission refuses new artifact-emitting
 *      AgentTasks with `policy_denied:tenant_storage_exceeded` when
 *      a tenant is over `defaultQuota.storage.casBytes`. Walker does
 *      NOT delete (CAS GC owns deletion).
 *
 * Defaults (per docs/WAVES.md §6.3):
 *   - quotas.enabled:                 false (opt-in)
 *   - defaultGatewayInFlightCap:      100
 *   - defaultCasBytesGiB:             10
 *   - casWalkIntervalMinutes:         10
 *
 * See:
 *   - docs/SUBSTRATE-V1.md §4.2 (Quota cascade)
 *   - docs/WAVES.md §6.3 (Wave 4 Quotas brief)
 */

export {
  buildResourceQuotaForTenant,
  resourceQuotaNameForTenant,
  resourceQuotaSpecDiffers,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  QUOTA_SOURCE_ANNOTATION,
  QUOTA_SOURCE_VALUE,
  TENANT_LABEL,
} from './resource-quota.js';
export type { BuildResourceQuotaInput } from './resource-quota.js';

export { GatewayInFlightCounter, checkGatewayInFlight } from './gateway.js';
export type { GatewayAcquireResult } from './gateway.js';

export {
  DEFAULT_CAS_WALK_INTERVAL_MS,
  MIN_CAS_WALK_INTERVAL_MS,
  checkTenantStorage,
  startCasQuotaController,
  walkCasUsageByTenant,
} from './cas-quota.js';
export type {
  CasQuotaControllerConfig,
  CasQuotaControllerDeps,
  CasQuotaControllerHandle,
  CasWalkInput,
  CasWalkPerTenant,
  CasWalkResult,
  StorageCheck,
} from './cas-quota.js';

export { GATEWAY_INFLIGHT_REFUSAL_REASON, STORAGE_REFUSAL_REASON } from './types.js';
export type {
  TaskShape,
  TenantComputeQuotaShape,
  TenantGatewayQuotaShape,
  TenantQuotaShape,
  TenantShape,
  TenantSpecShape,
  TenantStorageQuotaShape,
} from './types.js';
