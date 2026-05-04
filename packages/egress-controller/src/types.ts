/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Local structural types — kept narrow on purpose. Mirrors the
 * `cache-controller` pattern: the package consumes `Agent`-shaped and
 * `Tenant`-shaped data via duck-typed interfaces so it doesn't pull
 * the operator's full CRD type bundle into a leaf package.
 *
 * The operator imports the package and passes its real `Agent` /
 * `Tenant` CRs straight in — TypeScript's structural typing makes
 * the duck-type compat zero-cost at the call site.
 */

/**
 * `Agent.spec.egress` shape. Mirror of `AgentEgress` in
 * `packages/operator/src/crds/types.ts`. Re-declared locally so the
 * leaf package doesn't depend on the operator package.
 */
export interface AgentEgressLike {
  readonly domains?: readonly string[];
  readonly cidrs?: readonly string[];
  readonly ports?: readonly { readonly protocol: 'TCP' | 'UDP'; readonly port: number }[];
}

/**
 * Minimal Agent shape this package needs — name + namespace from
 * `metadata`, optional `spec.egress`, and the tenant label key on
 * `metadata.labels` for the resolver's lookup path.
 */
export interface AgentLike {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata: {
    readonly name?: string;
    readonly namespace?: string;
    readonly uid?: string;
    readonly labels?: Readonly<Record<string, string>>;
  };
  readonly spec: {
    readonly egress?: AgentEgressLike;
  };
}

/**
 * Minimal Tenant shape — `spec.defaultEgress.allow` is the FQDN/CIDR
 * glob list that the resolver merges into the per-Agent allowlist
 * when the Agent has no explicit `spec.egress`.
 *
 * The Tenancy sub-team's `TenantEgress.allow` is a glob-pattern
 * hostname list (per the same dialect as `CapabilityClaims.egress`).
 * The egress-controller treats each entry as either a domain (no `/`
 * char) or a CIDR (contains `/`) and routes it through the
 * NetworkPolicy / CiliumNetworkPolicy builder accordingly.
 */
export interface TenantLike {
  readonly metadata: {
    readonly name?: string;
  };
  readonly spec: {
    readonly name: string;
    readonly defaultEgress?: {
      readonly allow?: readonly string[];
    };
  };
}

/**
 * Substrate-internal egress endpoints the default-deny policy ALWAYS
 * lets through. The exact list is documented in
 * `packages/egress-controller/src/policy.ts` JSDoc; this type is the
 * carrier for tests + the operator's wiring layer.
 */
export interface SubstrateInternalEndpoints {
  /** kube-dns service IP / cluster CIDR + UDP 53 + TCP 53. */
  readonly kubeDnsCidr: string;
  /** NATS Service hostname (resolved via kubeDns). NATS port. */
  readonly natsHost: string;
  readonly natsPort: number;
  /** Optional gateway service hostname; resolved via kubeDns. */
  readonly gatewayHost?: string;
  readonly gatewayPort?: number;
}

/** Default substrate-internal endpoint set. Hard-coded conservative defaults. */
export const DEFAULT_SUBSTRATE_INTERNAL: SubstrateInternalEndpoints = {
  // K3s + the kagent helm chart ship kube-dns at the cluster's
  // service-CIDR `.10` slot; we use the cluster service CIDR
  // `10.43.0.0/16` (K3s default) as the conservative open. Operators
  // override via the `defaults` arg on `buildNetworkPolicyForAgent`
  // when their cluster uses a different service-CIDR.
  kubeDnsCidr: '10.43.0.0/16',
  natsHost: 'nats.kagent-system.svc.cluster.local',
  natsPort: 4222,
  gatewayHost: 'kagent-llm-gateway.kagent-system.svc.cluster.local',
  gatewayPort: 4000,
};

/**
 * Builder defaults — the substrate-internal endpoint set the
 * default-deny posture lets through. Override per-install via the
 * operator's wiring (env-driven) when running on a non-K3s cluster.
 */
export interface PolicyBuilderDefaults {
  readonly substrateInternal?: Partial<SubstrateInternalEndpoints>;
}
