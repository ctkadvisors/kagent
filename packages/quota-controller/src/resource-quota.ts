/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `buildResourceQuotaForTenant` — pure translation of a
 * `Tenant.spec.defaultQuota.compute` into a Kubernetes
 * `ResourceQuota` CR. The operator reconciler invokes this function
 * for each (tenant, namespace) pair and applies the resulting CR
 * server-side.
 *
 * Convention:
 *   - `metadata.name`         = `kagent-tenant-<tenant-name>`
 *   - `metadata.namespace`    = (passed in)
 *   - `metadata.labels`       = `kagent.knuteson.io/tenant=<name>` +
 *                               `kagent.knuteson.io/managed-by=kagent-operator`
 *   - `metadata.annotations`  = `kagent.knuteson.io/quota-source=tenant`
 *                               (forensics — distinguishes from
 *                               operator-authored vs cluster-admin
 *                               authored ResourceQuotas in the same ns)
 *   - `spec.hard`             = whichever of `requests.cpu` /
 *                               `requests.memory` / `count/pods`
 *                               the tenant's quota declared.
 *
 * Returns `undefined` when the tenant declares NO compute fields
 * (the operator skips the apply — substrate posture is "no entry"
 * not "open quota of 0"). This keeps the K8s ResourceQuota object
 * absent for tenants that opt out, so cluster-admin's own
 * ResourceQuotas in the same namespace remain untouched.
 *
 * Per docs/WAVES.md §6.3 deliverable 1 + docs/SUBSTRATE-V1.md §4.2
 * (Quota cascade).
 */

import type { V1ResourceQuota } from '@kubernetes/client-node';

import type { TenantShape } from './types.js';

/**
 * Stable label keys. Match the rest of the substrate's labels so
 * `kubectl get resourcequota -l kagent.knuteson.io/tenant=<name>`
 * is the canonical "show me this tenant's quotas" query.
 */
export const TENANT_LABEL = 'kagent.knuteson.io/tenant' as const;
export const MANAGED_BY_LABEL = 'kagent.knuteson.io/managed-by' as const;
export const MANAGED_BY_VALUE = 'kagent-operator' as const;
export const QUOTA_SOURCE_ANNOTATION = 'kagent.knuteson.io/quota-source' as const;
export const QUOTA_SOURCE_VALUE = 'tenant' as const;

/**
 * Compute the canonical ResourceQuota name. Single source of truth so
 * the reconciler + diff-checks + tests all agree. RFC 1123 DNS-label
 * compliant: lowercase + dashes; tenant names already conform via
 * `validateTenantNamespace`.
 */
export function resourceQuotaNameForTenant(tenantName: string): string {
  return `kagent-tenant-${tenantName}`;
}

export interface BuildResourceQuotaInput {
  /** Source tenant CR — `metadata.name` + `spec.defaultQuota.compute` are read. */
  readonly tenant: TenantShape;
  /** Target namespace (a member of `tenant.spec.namespaceAllowlist`). */
  readonly namespace: string;
}

/**
 * Build a `V1ResourceQuota` for a (tenant, namespace) pair. Returns
 * undefined when the tenant declares no compute caps — the caller
 * skips the apply (no quota → no CR; cluster-admin's own quotas in
 * the same namespace stay untouched).
 *
 * Pure: no I/O, no globals, no mutation. Operator's reconciler is
 * the only caller in production; tests assert the resulting CR's
 * shape.
 */
export function buildResourceQuotaForTenant(
  input: BuildResourceQuotaInput,
): V1ResourceQuota | undefined {
  const { tenant, namespace } = input;
  const compute = tenant.spec.defaultQuota?.compute;
  if (compute === undefined) return undefined;

  const hard: Record<string, string> = {};
  if (typeof compute.cpuRequests === 'string' && compute.cpuRequests.length > 0) {
    hard['requests.cpu'] = compute.cpuRequests;
  }
  if (typeof compute.memoryRequests === 'string' && compute.memoryRequests.length > 0) {
    hard['requests.memory'] = compute.memoryRequests;
  }
  if (typeof compute.maxPods === 'number' && compute.maxPods >= 0) {
    // K8s quantities are strings in the wire format. `count/pods` is
    // the official quota key for pod-count caps per the docs:
    // https://kubernetes.io/docs/concepts/policy/resource-quotas/#object-count-quota
    hard['count/pods'] = String(compute.maxPods);
  }

  // Empty compute object → no fields declared → behave as if undefined.
  if (Object.keys(hard).length === 0) return undefined;

  const tenantName = tenant.metadata.name ?? tenant.spec.name;
  const name = resourceQuotaNameForTenant(tenantName);

  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: {
      name,
      namespace,
      labels: {
        [TENANT_LABEL]: tenantName,
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      },
      annotations: {
        [QUOTA_SOURCE_ANNOTATION]: QUOTA_SOURCE_VALUE,
      },
    },
    spec: {
      hard,
    },
  };
}

/**
 * Diff helper — the reconciler compares `buildResourceQuotaForTenant`'s
 * output against the live ResourceQuota and only patches when the
 * `spec.hard` map differs. Pure; tests assert no-op vs. patch
 * decisions. Also returns true when either side has missing
 * apiVersion/kind/metadata, so the caller's invariant ("we only
 * compare ResourceQuota CRs we authored") shows up as a structured
 * mismatch rather than a silent equality.
 */
export function resourceQuotaSpecDiffers(
  a: V1ResourceQuota | undefined,
  b: V1ResourceQuota | undefined,
): boolean {
  if (a === undefined && b === undefined) return false;
  if (a === undefined || b === undefined) return true;
  const aHard = a.spec?.hard ?? {};
  const bHard = b.spec?.hard ?? {};
  const aKeys = Object.keys(aHard).sort();
  const bKeys = Object.keys(bHard).sort();
  if (aKeys.length !== bKeys.length) return true;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return true;
    const k = aKeys[i] as string;
    if (aHard[k] !== bHard[k]) return true;
  }
  return false;
}
