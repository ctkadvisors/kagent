/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure-functional NetworkPolicy + CiliumNetworkPolicy builders.
 *
 * Wave 4 / Egress sub-team (v0.5.1-egress). See
 * docs/SUBSTRATE-V1.md §3.1 (`Agent.spec.egress`) +
 * docs/WAVES.md §6.2.
 *
 * `buildNetworkPolicyForAgent` and `buildCiliumNetworkPolicyForAgent`
 * are pure: they take an `Agent` (any structural match for
 * `AgentLike`), an optional `PolicyBuilderDefaults`, and return the
 * desired Kubernetes object. The operator's `applyNetworkPolicyForAgent`
 * wraps these with the K8s API call.
 *
 * ## Default-deny posture
 *
 * When `agent.spec.egress` is unset (and after `resolveEffectiveEgress`
 * also returns no Agent-level allowlist), the builder emits a
 * NetworkPolicy that allows ONLY:
 *
 *   1. **DNS** — UDP 53 + TCP 53 to the cluster's kube-dns service CIDR.
 *      Without DNS the agent-pod cannot resolve any service name; this
 *      is the bare minimum a substrate-internal pod needs to function.
 *   2. **NATS** — TCP 4222 to the NATS Service hostname. Required for
 *      the Wave 0 audit stream + Wave 3 events bus + Wave 3 blackboard
 *      KV. Resolved via DNS (rule #1) at connect time.
 *   3. **LLM gateway** — TCP 4000 to the kagent-llm-gateway Service
 *      hostname. Required for the agent-pod's LLM client when the
 *      gateway is enabled. Resolved via DNS.
 *
 * Operators on a non-K3s cluster override the kubeDns / NATS / gateway
 * service IPs via `PolicyBuilderDefaults.substrateInternal`. The
 * defaults match the chart's default install (kube-system + kagent-system).
 *
 * ## Cilium detection
 *
 * `detectCiliumInstalled` looks for the `cilium-config` ConfigMap in
 * `kube-system`. When present, the egress-controller emits Cilium
 * `CiliumNetworkPolicy` (with `toFQDNs` for domain matching). When
 * absent, it emits plain `NetworkPolicy` (CIDR-only — domains are
 * resolved best-effort at reconcile time by the operator's wiring).
 */

import type { CoreV1Api, V1NetworkPolicy } from '@kubernetes/client-node';

import {
  DEFAULT_SUBSTRATE_INTERNAL,
  type AgentEgressLike,
  type AgentLike,
  type PolicyBuilderDefaults,
  type SubstrateInternalEndpoints,
} from './types.js';

/** kagent label keys reused on every materialized policy. */
export const POLICY_MANAGED_LABEL_KEY = 'kagent.knuteson.io/managed-by';
export const POLICY_MANAGED_LABEL_VALUE = 'kagent-egress-controller';
/** Stable selector key — agent-pods are stamped with `kagent.knuteson.io/agent=<name>`. */
export const AGENT_LABEL_KEY = 'kagent.knuteson.io/agent';

/** Policy name prefix for both NetworkPolicy and CiliumNetworkPolicy. */
export const POLICY_NAME_PREFIX = 'kagent-egress-' as const;

/* =====================================================================
 * Cilium CNP types — minimal structural shape so we don't depend on
 * Cilium's npm package. The operator submits these via
 * `customApi.createNamespacedCustomObject` against
 * `cilium.io/v2/CiliumNetworkPolicy`.
 * ===================================================================== */

export interface CiliumEndpointSelector {
  readonly matchLabels?: Readonly<Record<string, string>>;
}

export interface CiliumPortProtocol {
  readonly port: string;
  readonly protocol?: 'TCP' | 'UDP' | 'ANY';
}

export interface CiliumPortRule {
  readonly ports?: readonly CiliumPortProtocol[];
}

export interface CiliumEgressRule {
  readonly toFQDNs?: readonly { readonly matchName?: string; readonly matchPattern?: string }[];
  readonly toCIDR?: readonly string[];
  readonly toEndpoints?: readonly CiliumEndpointSelector[];
  readonly toPorts?: readonly CiliumPortRule[];
}

export interface CiliumNetworkPolicy {
  readonly apiVersion: 'cilium.io/v2';
  readonly kind: 'CiliumNetworkPolicy';
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly ownerReferences?: readonly {
      readonly apiVersion: string;
      readonly kind: string;
      readonly name: string;
      readonly uid: string;
      readonly controller?: boolean;
      readonly blockOwnerDeletion?: boolean;
    }[];
  };
  readonly spec: {
    readonly endpointSelector: CiliumEndpointSelector;
    readonly egress?: readonly CiliumEgressRule[];
  };
}

/* =====================================================================
 * Helpers — substrate-internal endpoint resolution + naming.
 * ===================================================================== */

/**
 * Resolve the effective substrate-internal endpoint set, layering
 * operator-provided overrides over the hard-coded conservative
 * defaults.
 */
export function resolveSubstrateInternal(
  defaults?: PolicyBuilderDefaults,
): SubstrateInternalEndpoints {
  const override = defaults?.substrateInternal;
  if (override === undefined) return DEFAULT_SUBSTRATE_INTERNAL;
  return {
    kubeDnsCidr: override.kubeDnsCidr ?? DEFAULT_SUBSTRATE_INTERNAL.kubeDnsCidr,
    natsHost: override.natsHost ?? DEFAULT_SUBSTRATE_INTERNAL.natsHost,
    natsPort: override.natsPort ?? DEFAULT_SUBSTRATE_INTERNAL.natsPort,
    ...(override.gatewayHost !== undefined
      ? { gatewayHost: override.gatewayHost }
      : DEFAULT_SUBSTRATE_INTERNAL.gatewayHost !== undefined
        ? { gatewayHost: DEFAULT_SUBSTRATE_INTERNAL.gatewayHost }
        : {}),
    ...(override.gatewayPort !== undefined
      ? { gatewayPort: override.gatewayPort }
      : DEFAULT_SUBSTRATE_INTERNAL.gatewayPort !== undefined
        ? { gatewayPort: DEFAULT_SUBSTRATE_INTERNAL.gatewayPort }
        : {}),
  };
}

/** Stable policy name for the Agent — `kagent-egress-<agent-name>`. */
export function policyNameForAgent(agent: AgentLike): string {
  const name = agent.metadata.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('agent.metadata.name is required to derive a policy name');
  }
  return `${POLICY_NAME_PREFIX}${name}`;
}

/** Stable owner-reference into the Agent CR. */
export function ownerRefForAgent(agent: AgentLike):
  | {
      readonly apiVersion: string;
      readonly kind: string;
      readonly name: string;
      readonly uid: string;
      readonly controller: boolean;
      readonly blockOwnerDeletion: boolean;
    }
  | undefined {
  const apiVersion = agent.apiVersion;
  const kind = agent.kind;
  const name = agent.metadata.name;
  const uid = agent.metadata.uid;
  if (
    typeof apiVersion !== 'string' ||
    typeof kind !== 'string' ||
    typeof name !== 'string' ||
    typeof uid !== 'string'
  ) {
    return undefined;
  }
  return {
    apiVersion,
    kind,
    name,
    uid,
    controller: true,
    blockOwnerDeletion: true,
  };
}

/* =====================================================================
 * NetworkPolicy builder (plain K8s networking.k8s.io/v1).
 *
 * Builds a `policyTypes: [Egress]` policy that ALLOWS:
 *   - The Agent's declared `spec.egress.cidrs[]` + `ports[]`.
 *   - Substrate-internal: kube-dns CIDR + NATS service-CIDR + gateway
 *     service-CIDR (CIDR-resolved via kubeDnsCidr — plain NP can't
 *     match a service name).
 *
 * Does NOT honor `spec.egress.domains[]` directly — plain NP has no
 * native FQDN matcher. The operator's wiring layer is expected to
 * resolve domains via DNS at reconcile time and merge the resulting
 * addresses onto `spec.egress.cidrs[]` BEFORE calling this builder
 * (best-effort; pinned for the policy's lifetime). When `domains[]` is
 * declared without resolution, the builder emits a JSDoc-recorded
 * WARN annotation (`kagent.knuteson.io/egress-domains-unresolved: <N>`)
 * so audit consumers can spot the gap.
 * ===================================================================== */

export interface BuildNetworkPolicyResult {
  readonly policy: V1NetworkPolicy;
  /** Names of `spec.egress.domains[]` not resolved into CIDRs. */
  readonly unresolvedDomains: readonly string[];
}

export function buildNetworkPolicyForAgent(
  agent: AgentLike,
  defaults?: PolicyBuilderDefaults,
): BuildNetworkPolicyResult {
  const internal = resolveSubstrateInternal(defaults);
  const namespace = agent.metadata.namespace ?? 'default';
  const name = policyNameForAgent(agent);
  const agentName = agent.metadata.name as string;
  const owner = ownerRefForAgent(agent);

  const egressDecl: AgentEgressLike | undefined = agent.spec.egress;
  const cidrs = egressDecl?.cidrs ?? [];
  const ports = egressDecl?.ports ?? [];
  const declaredDomains = egressDecl?.domains ?? [];

  type EgressRule = {
    to?: { ipBlock?: { cidr: string } }[];
    ports?: { protocol: 'TCP' | 'UDP'; port: number }[];
  };

  // Substrate-internal allowance — DNS first (everything else needs
  // to resolve a hostname), then NATS + gateway via the kubeDns CIDR.
  const egressRules: EgressRule[] = [
    // DNS — UDP 53 + TCP 53 to kube-dns service CIDR.
    {
      to: [{ ipBlock: { cidr: internal.kubeDnsCidr } }],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
    // Substrate services — NATS + gateway. We can't pin to a service
    // name in plain NP, so we widen to the cluster service-CIDR (same
    // CIDR as kubeDns since K3s places all ClusterIPs in the service
    // CIDR). The NATS + gateway ports are the discriminators.
    {
      to: [{ ipBlock: { cidr: internal.kubeDnsCidr } }],
      ports: [{ protocol: 'TCP', port: internal.natsPort }],
    },
  ];
  if (internal.gatewayHost !== undefined && internal.gatewayPort !== undefined) {
    egressRules.push({
      to: [{ ipBlock: { cidr: internal.kubeDnsCidr } }],
      ports: [{ protocol: 'TCP', port: internal.gatewayPort }],
    });
  }

  // Agent-declared CIDR allowlist — one rule per CIDR × ports cross-
  // product. When `ports[]` is empty, allow all ports.
  const declaredRules: EgressRule[] = [];
  for (const cidr of cidrs) {
    declaredRules.push({
      to: [{ ipBlock: { cidr } }],
      ...(ports.length > 0 && {
        ports: ports.map((p) => ({ protocol: p.protocol, port: p.port })),
      }),
    });
  }

  const annotations: Record<string, string> = {};
  if (declaredDomains.length > 0) {
    annotations['kagent.knuteson.io/egress-domains-unresolved'] = String(declaredDomains.length);
    annotations['kagent.knuteson.io/egress-domains'] = declaredDomains.join(',');
  }

  const policy: V1NetworkPolicy = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name,
      namespace,
      labels: {
        [POLICY_MANAGED_LABEL_KEY]: POLICY_MANAGED_LABEL_VALUE,
        [AGENT_LABEL_KEY]: agentName,
      },
      ...(Object.keys(annotations).length > 0 && { annotations }),
      ...(owner !== undefined && { ownerReferences: [owner] }),
    },
    spec: {
      podSelector: {
        matchLabels: {
          [AGENT_LABEL_KEY]: agentName,
        },
      },
      policyTypes: ['Egress'],
      egress: [...(egressRules ?? []), ...(declaredRules ?? [])],
    },
  };

  return { policy, unresolvedDomains: declaredDomains };
}

/* =====================================================================
 * Cilium CiliumNetworkPolicy builder.
 *
 * Honors `spec.egress.domains[]` natively via `toFQDNs`. CIDRs route
 * through `toCIDR`. Substrate-internal allowance is expressed as
 * `toEndpoints` against the kube-system namespace (kube-dns) +
 * substrate-system namespace (NATS + gateway).
 * ===================================================================== */

export function buildCiliumNetworkPolicyForAgent(
  agent: AgentLike,
  defaults?: PolicyBuilderDefaults,
): CiliumNetworkPolicy {
  const internal = resolveSubstrateInternal(defaults);
  const namespace = agent.metadata.namespace ?? 'default';
  const name = policyNameForAgent(agent);
  const agentName = agent.metadata.name as string;
  const owner = ownerRefForAgent(agent);

  const egressDecl: AgentEgressLike | undefined = agent.spec.egress;
  const domains = egressDecl?.domains ?? [];
  const cidrs = egressDecl?.cidrs ?? [];
  const ports = egressDecl?.ports ?? [];

  const portsRule: CiliumPortRule | undefined =
    ports.length > 0
      ? {
          ports: ports.map((p) => ({ port: String(p.port), protocol: p.protocol })),
        }
      : undefined;

  const rules: CiliumEgressRule[] = [];

  // Substrate-internal — DNS first.
  rules.push({
    toEndpoints: [
      {
        matchLabels: {
          'k8s:io.kubernetes.pod.namespace': 'kube-system',
          'k8s-app': 'kube-dns',
        },
      },
    ],
    toPorts: [
      {
        ports: [
          { port: '53', protocol: 'UDP' },
          { port: '53', protocol: 'TCP' },
        ],
      },
    ],
  });

  // Substrate — NATS via the well-known service hostname (Cilium's DNS
  // proxy resolves on the agent's behalf when DNS visibility is open).
  rules.push({
    toFQDNs: [{ matchName: internal.natsHost }],
    toPorts: [{ ports: [{ port: String(internal.natsPort), protocol: 'TCP' }] }],
  });

  if (internal.gatewayHost !== undefined && internal.gatewayPort !== undefined) {
    rules.push({
      toFQDNs: [{ matchName: internal.gatewayHost }],
      toPorts: [{ ports: [{ port: String(internal.gatewayPort), protocol: 'TCP' }] }],
    });
  }

  // Agent-declared FQDN allowlist — Cilium's native toFQDNs.
  if (domains.length > 0) {
    rules.push({
      toFQDNs: domains.map((d) => (d.includes('*') ? { matchPattern: d } : { matchName: d })),
      ...(portsRule !== undefined && { toPorts: [portsRule] }),
    });
  }

  // Agent-declared raw CIDRs.
  if (cidrs.length > 0) {
    rules.push({
      toCIDR: [...cidrs],
      ...(portsRule !== undefined && { toPorts: [portsRule] }),
    });
  }

  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name,
      namespace,
      labels: {
        [POLICY_MANAGED_LABEL_KEY]: POLICY_MANAGED_LABEL_VALUE,
        [AGENT_LABEL_KEY]: agentName,
      },
      ...(owner !== undefined && { ownerReferences: [owner] }),
    },
    spec: {
      endpointSelector: {
        matchLabels: {
          [AGENT_LABEL_KEY]: agentName,
        },
      },
      egress: rules,
    },
  };
}

/* =====================================================================
 * Cluster detection — looks for the `cilium-config` ConfigMap in
 * `kube-system` to decide which builder applies. Default-OFF posture
 * on lookup failure: emit plain NetworkPolicy when in doubt (cluster
 * may have a Cilium-aware admission webhook but no cilium-config CM
 * in kube-system; the operator's `mode` env is the explicit override).
 * ===================================================================== */

/**
 * Detect Cilium by reading `kube-system/cilium-config`. Returns
 * `false` when the ConfigMap is missing OR the CoreV1Api call fails
 * — fail-safe to plain NetworkPolicy.
 *
 * The operator's wiring layer caches the result (Cilium install is
 * not hot-swapped); we re-detect on operator restart.
 */
export async function detectCiliumInstalled(coreApi: CoreV1Api): Promise<boolean> {
  try {
    await coreApi.readNamespacedConfigMap({ name: 'cilium-config', namespace: 'kube-system' });
    return true;
  } catch (err) {
    // Match shape of `ApiException` — code 404 is the expected miss;
    // other errors fail-safe.
    const code = (err as { code?: number; statusCode?: number }).code;
    const statusCode = (err as { code?: number; statusCode?: number }).statusCode;
    if (code === 404 || statusCode === 404) return false;
    return false;
  }
}
