/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 4 / Quotas sub-team — minimal structural shapes the helpers
 * need from the operator's CRD types. Kept narrow + structural so the
 * package has zero workspace-level dep on `@kagent/operator` (which
 * already depends on this package via main.ts wiring — a back-edge
 * would create the import cycle).
 *
 * Same pattern as `@kagent/locality-controller`: TypeScript's
 * structural typing lets the operator pass its full Tenant /
 * AgentTask CRs into these helpers verbatim.
 */

import type { V1ObjectMeta } from '@kubernetes/client-node';

/* =====================================================================
 * Tenant compute / gateway / storage quota sub-shapes — mirror
 * `crds/tenant.ts` (the operator's canonical TS surface). Re-declared
 * structurally here to keep the dependency edge clean (no
 * `@kagent/operator` import).
 * ===================================================================== */

export interface TenantComputeQuotaShape {
  readonly cpuRequests?: string;
  readonly memoryRequests?: string;
  readonly maxPods?: number;
}

export interface TenantGatewayQuotaShape {
  readonly inFlightCap?: number;
  readonly tokensPerHour?: number;
}

export interface TenantStorageQuotaShape {
  readonly casBytes?: number;
  readonly artifactCount?: number;
}

export interface TenantQuotaShape {
  readonly compute?: TenantComputeQuotaShape;
  readonly gateway?: TenantGatewayQuotaShape;
  readonly storage?: TenantStorageQuotaShape;
}

export interface TenantSpecShape {
  readonly name: string;
  readonly namespaceAllowlist: readonly string[];
  readonly defaultQuota?: TenantQuotaShape;
}

export interface TenantShape {
  readonly metadata: V1ObjectMeta;
  readonly spec: TenantSpecShape;
}

/* =====================================================================
 * AgentTask shape — only the fields the gateway counter + storage
 * walker need. Tenant identity is read off the operator-stamped
 * label `kagent.knuteson.io/tenant` (see `crds/tenant.ts:TENANT_LABEL`).
 * ===================================================================== */

export interface TaskShape {
  readonly metadata: V1ObjectMeta;
  readonly status?: {
    readonly phase?: string;
    readonly outputs?: ReadonlyArray<{
      readonly ref?: string;
      readonly name?: string;
    }>;
  };
}

/**
 * Refusal taxonomy strings — mirrors the in-pod / depth-cap /
 * pod-pressure / tenant-namespace pattern. Stable across versions
 * (audit consumers index on these literals).
 */
export const GATEWAY_INFLIGHT_REFUSAL_REASON =
  'policy_denied:tenant_gateway_inflight_exceeded' as const;
export const STORAGE_REFUSAL_REASON = 'policy_denied:tenant_storage_exceeded' as const;
