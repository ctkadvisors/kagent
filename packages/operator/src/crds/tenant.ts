/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tenant CRD — v0.5.0-tenancy (Wave 4 / Tenancy sub-team).
 *
 * The substrate's multi-tenant boundary primitive. A `Tenant` CR
 * declares:
 *
 *   - The canonical tenant id (matches `metadata.name`).
 *   - The set of K8s namespaces this tenant may own Agents/Tasks in.
 *   - An optional override for the operator-CA issuer subject (so
 *     downstream cap-bundle verifiers can pin per-tenant).
 *   - An optional audit `subject` prefix override (default
 *     `tenant/<name>`).
 *   - Optional default quota + default egress hooks consumed by
 *     Wave 4 Quotas + Egress sub-teams (foundational; not enforced
 *     here).
 *
 * The operator stamps `metadata.labels['kagent.knuteson.io/tenant']`
 * onto every Agent + AgentTask at admission time using the tenant
 * resolved from:
 *   1. The Agent's own `metadata.labels.tenant` (explicit).
 *   2. The namespace's "default tenant" mapping (one Tenant CR whose
 *      `namespaceAllowlist` contains the namespace AND no other
 *      Tenant CR claims it — substrate forbids overlap).
 *   3. The cluster-wide default tenant (env
 *      `KAGENT_TENANCY_DEFAULT_TENANT`) when set.
 *
 * Cluster-scoped (NOT namespaced): a Tenant declares the
 * cross-namespace authority surface and the operator needs cluster-
 * wide visibility to detect overlapping `namespaceAllowlist` entries
 * before they cause cross-tenant data leakage. A namespace-scoped
 * Tenant CRD would require operators to write the same Tenant CR in
 * every namespace they expect that tenant to span — defeats the
 * abstraction.
 *
 * See:
 *   - docs/SUBSTRATE-V1.md §3.6 (Capability — `claims.tenant` is the
 *     hook this primitive populates) + §4.2 (Quota cascade)
 *   - docs/WAVES.md §6.1 (Wave 4 Tenancy sub-team brief)
 *   - docs/GATEWAY-CONTRACT.md §3 (the `X-Kagent-Tenant` header
 *     this primitive ultimately threads onto every gateway call)
 *
 * Mirror the YAML CRD schema at
 * `packages/operator/manifests/crds/tenants.yaml`. Drift caught by
 * `pnpm --filter @kagent/operator crd:check`.
 */

import type { V1ObjectMeta } from '@kubernetes/client-node';

import { API_GROUP_VERSION } from './types.js';

/* =====================================================================
 * Tenant.spec
 * ===================================================================== */

/**
 * Capability-bundle root override. The operator's default issuer
 * (`kagent.knuteson.io/operator`) is the substrate baseline; per-
 * tenant overrides let downstream verifiers pin caps to a tenant-
 * specific issuer string when the gateway's auth policy is shaped
 * around tenant identity rather than the substrate as a whole.
 *
 * v0.5.0 ships the field; the cap-issuer reads `issuer` and threads
 * it onto the JWT's `iss` claim when set. Unset = use the operator's
 * default.
 */
export interface TenantCapabilityRoot {
  /**
   * Override the JWT `iss` claim for caps minted under this tenant.
   * When unset, the operator's default issuer applies.
   */
  readonly issuer?: string;
}

/**
 * Compute-quota sub-shape — translated to a per-tenant-namespace K8s
 * `ResourceQuota` CR by `buildResourceQuotaForTenant` in the
 * `@kagent/quota-controller` package. K8s resource-quantity strings
 * pass straight through; `maxPods` becomes the `count/pods` quota
 * key.
 */
export interface TenantComputeQuota {
  /** K8s quantity, e.g. `'10'` or `'10000m'`. Mapped to ResourceQuota `requests.cpu`. */
  readonly cpuRequests?: string;
  /** K8s quantity, e.g. `'20Gi'`. Mapped to ResourceQuota `requests.memory`. */
  readonly memoryRequests?: string;
  /** Pod count cap per tenant namespace. Mapped to ResourceQuota `count/pods`. */
  readonly maxPods?: number;
}

/**
 * Gateway-quota sub-shape — enforced by `@kagent/quota-controller`'s
 * in-process gateway in-flight counter (per-tenant) at AgentTask
 * admission. `tokensPerHour` is documented as the next-rev hook (v1
 * carries the shape; the actual hourly-window accumulator is a v0.5.3
 * follow-up — refusing on `inFlightCap` first lets us prove the
 * enforcement loop end-to-end without a token-attribution backend).
 */
export interface TenantGatewayQuota {
  /** Concurrent in-flight gateway requests cap (per tenant). */
  readonly inFlightCap?: number;
  /**
   * Per-tenant token budget (tokens/hour). Carried in v0.5.2; the
   * actual accumulator + refusal lands in a follow-up release once
   * per-tenant token attribution is wired through the gateway.
   */
  readonly tokensPerHour?: number;
}

/**
 * Storage-quota sub-shape — enforced by `@kagent/quota-controller`'s
 * periodic CAS walker. `casBytes` is the hard cap; new artifact
 * admissions refuse with `policy_denied:tenant_storage_exceeded` once
 * the walker reports the tenant over budget. `artifactCount` is a
 * loose count cap — surfaces a `quota.compute_warning` when
 * approached, but does NOT refuse (artifact volume varies wildly
 * with payload size; the bytes cap is the substrate's authoritative
 * boundary).
 */
export interface TenantStorageQuota {
  /** CAS PVC consumption cap (bytes). E.g. `100 * 1024 * 1024 * 1024` = 100 GiB. */
  readonly casBytes?: number;
  /**
   * Artifact count cap (loose). Crossing 80% emits a warning; never
   * refuses admission — `casBytes` is the hard boundary.
   */
  readonly artifactCount?: number;
}

/**
 * Default per-tenant compute / gateway / storage quota — the Wave 4
 * Quotas sub-team's authoritative shape (v0.5.2-quotas).
 *
 * Per docs/WAVES.md §6.3:
 *   - `compute.*`  → `@kagent/quota-controller` materializes a K8s
 *                    `ResourceQuota` per (tenant, namespace) pair.
 *   - `gateway.*`  → in-process counter map per tenant; admission
 *                    refuses new AgentTasks with
 *                    `policy_denied:tenant_gateway_inflight_exceeded`
 *                    when `inFlightCap` is exceeded.
 *   - `storage.*`  → periodic CAS walker (10-minute cadence) sums
 *                    per-tenant bytes; admission refuses new
 *                    artifacts with
 *                    `policy_denied:tenant_storage_exceeded` when
 *                    over `casBytes`.
 *
 * Every field is optional — a tenant with `defaultQuota: {}` (or no
 * quota at all) gets the chart-level defaults
 * (`quotas.defaultGatewayInFlightCap`, `quotas.defaultCasBytesGiB`)
 * if `quotas.enabled=true`, otherwise no enforcement at all (back-
 * compat with v0.5.0 single-tenant installs).
 *
 * Schema is locked at v0.5.2 — additions are SemVer-minor; renames
 * are SemVer-major + a CRD-bump cycle.
 */
export interface TenantQuota {
  readonly compute?: TenantComputeQuota;
  readonly gateway?: TenantGatewayQuota;
  readonly storage?: TenantStorageQuota;
}

/**
 * Default per-tenant egress allowlist. Wave 4 Egress sub-team
 * consumes this; v0.5.0 carries the shape. The list is a glob
 * pattern set per the same dialect as `CapabilityClaims.egress`.
 */
export interface TenantEgress {
  /**
   * Glob list of hostnames the tenant's Agents may reach by default
   * (e.g. `'api.github.com'`, `'*.googleapis.com'`). An Agent's own
   * `Agent.spec.egress` further narrows this; the substrate-enforced
   * authority is the cap-bundle's `claims.egress` after composition.
   */
  readonly allow?: readonly string[];
}

export interface TenantSpec {
  /**
   * Canonical tenant id. MUST equal `metadata.name`; the operator's
   * admission validator rejects mismatches at create time so
   * downstream code never has to reconcile a name/id drift.
   */
  readonly name: string;
  /**
   * Namespace allowlist — the set of K8s namespaces this tenant may
   * own Agents/Tasks in. Two tenants MUST NOT overlap on a namespace;
   * the controller surfaces overlap as `phase: Failed` with a
   * `NamespaceOverlap` condition.
   */
  readonly namespaceAllowlist: readonly string[];
  /**
   * Capability-root override (optional; defaults to the operator's
   * issuer subject).
   */
  readonly capabilityRoot?: TenantCapabilityRoot;
  /**
   * Audit subject prefix override (optional). Defaults to
   * `tenant/<metadata.name>` per the audit-events convention.
   */
  readonly auditSubject?: string;
  /**
   * Default quota for Agents in this tenant. Wave 4 Quotas
   * consumes; v0.5.0 leaves enforcement to that sub-team.
   */
  readonly defaultQuota?: TenantQuota;
  /**
   * Default egress allowlist for Agents in this tenant. Wave 4
   * Egress consumes; v0.5.0 leaves NetworkPolicy materialization
   * to that sub-team.
   */
  readonly defaultEgress?: TenantEgress;
}

/* =====================================================================
 * Tenant.status
 * ===================================================================== */

export type TenantPhase = 'Pending' | 'Ready' | 'Failed';

/**
 * Standard Kubernetes condition pattern. Mirrors the other Wave 1+
 * controllers. Known condition types emitted by the tenant
 * controller:
 *
 *   - `NamespaceAllowlistResolved` — at least one allowlisted ns
 *      exists in the cluster
 *   - `NamespaceOverlap`           — another Tenant claims the same ns
 *   - `Ready`                      — phase=Ready convenience boolean
 *   - `Failed`                     — terminal-bad; cause in `message`
 */
export interface TenantCondition {
  readonly type: string;
  readonly status: 'True' | 'False' | 'Unknown';
  readonly reason?: string;
  readonly message?: string;
  readonly lastTransitionTime: string;
  readonly observedGeneration?: number;
}

export interface TenantStatus {
  readonly phase?: TenantPhase;
  /** `metadata.generation` the operator most recently reconciled. */
  readonly observedGeneration?: number;
  readonly conditions?: readonly TenantCondition[];
  /**
   * Operator-observed: how many of the allowlisted namespaces
   * actually exist in the cluster. Drives the `NamespaceAllowlistResolved`
   * condition.
   */
  readonly namespaceCount?: number;
  /** Operator-observed: count of Agents currently labeled with this tenant. */
  readonly agentCount?: number;
  /** Operator-observed: count of non-terminal AgentTasks under this tenant. */
  readonly activeTaskCount?: number;
}

/* =====================================================================
 * Tenant top-level CR
 * ===================================================================== */

export interface Tenant {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'Tenant';
  readonly metadata: V1ObjectMeta;
  readonly spec: TenantSpec;
  readonly status?: TenantStatus;
}

/* =====================================================================
 * Type guard — runtime check for events handed back as `unknown`.
 * ===================================================================== */

export function isTenant(obj: unknown): obj is Tenant {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'Tenant') return false;
  const spec = o.spec as { name?: unknown; namespaceAllowlist?: unknown } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (typeof spec.name !== 'string' || spec.name.length === 0) return false;
  if (!Array.isArray(spec.namespaceAllowlist)) return false;
  for (const ns of spec.namespaceAllowlist) {
    if (typeof ns !== 'string' || ns.length === 0) return false;
  }
  return true;
}

/* =====================================================================
 * Helpers — readiness predicates + label conventions.
 * ===================================================================== */

/**
 * Label key the operator stamps on Agent + AgentTask resources at
 * admission time. Resource ⊂ tenant relationship is expressed via
 * this label; informer-cache filtering reads it as the tenancy scope.
 *
 * Stable across versions (no migrations); future tenancy revs that
 * want to add per-tenant sub-scopes will compose additional label
 * keys, never rename this one.
 */
export const TENANT_LABEL = 'kagent.knuteson.io/tenant';

/** Default audit subject prefix per Wave 0 audit-events convention. */
export function defaultAuditSubject(t: Tenant): string {
  if (typeof t.spec.auditSubject === 'string' && t.spec.auditSubject.length > 0) {
    return t.spec.auditSubject;
  }
  const name = t.metadata.name ?? t.spec.name;
  return `tenant/${name}`;
}

/**
 * Whether the tenant's `phase: Ready` is true AND the namespaceCount
 * is at least 1 (i.e. at least one allowlisted namespace exists).
 * Mirrors `isWorkspaceReady` — defensive readiness check used by
 * downstream consumers (cap-issuer, admission) before treating a
 * tenant as a valid scope.
 */
export function isTenantReady(t: Tenant): boolean {
  if (t.status === undefined) return false;
  if (t.status.phase !== 'Ready') return false;
  return (t.status.namespaceCount ?? 0) >= 1;
}

/** Whether the tenant is in a terminal-bad phase. Matches `isWorkspaceFailed`. */
export function isTenantFailed(t: Tenant): boolean {
  return t.status?.phase === 'Failed';
}

/**
 * Resolve the effective issuer subject for a tenant — `spec.capabilityRoot.issuer`
 * when set, otherwise undefined (caller falls back to the operator default).
 * Pure helper used by the cap-issuer's tenant-claim path.
 */
export function resolveTenantIssuer(t: Tenant): string | undefined {
  return t.spec.capabilityRoot?.issuer;
}

/**
 * Whether this tenant's namespace allowlist admits the given namespace.
 * Pure helper used by admission to refuse tenant/namespace mismatches.
 */
export function tenantAdmitsNamespace(t: Tenant, namespace: string): boolean {
  if (typeof namespace !== 'string' || namespace.length === 0) return false;
  for (const ns of t.spec.namespaceAllowlist) {
    if (ns === namespace) return true;
  }
  return false;
}
