/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `applyNetworkPolicyForAgent` — operator-side wiring that turns a
 * resolved Agent + tenant lookup into a server-side NetworkPolicy
 * (or CiliumNetworkPolicy) create-or-update. Pure-functional below
 * the apply boundary: the builders are testable in isolation; this
 * module owns the K8s API calls (and only that).
 *
 * Wave 4 / Egress sub-team (v0.5.1-egress).
 */

import type { CustomObjectsApi, NetworkingV1Api, V1NetworkPolicy } from '@kubernetes/client-node';

import {
  buildCiliumNetworkPolicyForAgent,
  buildNetworkPolicyForAgent,
  policyNameForAgent,
  type CiliumNetworkPolicy,
} from './policy.js';
import { applyResolvedEgress } from './resolver.js';
import type { AgentLike, PolicyBuilderDefaults, TenantLike } from './types.js';

/** Egress materialization mode — `auto` is the default. */
export type EgressMode = 'auto' | 'networkpolicy' | 'cilium';

export interface ApplyEgressDeps {
  readonly networkingApi: NetworkingV1Api;
  readonly customApi: CustomObjectsApi;
  /** Cluster detection result (cached at operator boot). */
  readonly ciliumDetected: boolean;
  /** Operator's mode override; defaults to `auto`. */
  readonly mode?: EgressMode;
  /** Substrate-internal endpoint overrides. */
  readonly defaults?: PolicyBuilderDefaults;
  /**
   * Tenant lookup for the resolver — given the Agent's
   * `metadata.labels[TENANT_LABEL]`, return the matching Tenant CR
   * or undefined. Operator threads its existing tenant informer.
   */
  readonly lookupTenant?: (tenantName: string) => TenantLike | undefined;
  /**
   * Audit hook — `egress.policy_applied`. Best-effort; failures
   * logged + swallowed. Operator wires this to its CloudEvents
   * publisher.
   */
  readonly onPolicyApplied?: (data: PolicyAppliedEmissionData) => Promise<void> | void;
}

/** Audit emission payload — mirrors `EgressPolicyAppliedData` in `@kagent/audit-events`. */
export interface PolicyAppliedEmissionData {
  readonly agentName: string;
  readonly agentNamespace: string;
  readonly agentUid: string | undefined;
  readonly tenant: string | undefined;
  readonly mode: 'networkpolicy' | 'cilium';
  readonly source: 'agent' | 'tenant' | 'default-deny';
  readonly policyName: string;
  readonly cidrCount: number;
  readonly domainCount: number;
  readonly portCount: number;
}

/** Tenant label key — duplicated locally to avoid the @kagent/operator dep. */
export const TENANT_LABEL_KEY = 'kagent.knuteson.io/tenant';

export interface ApplyEgressResult {
  readonly mode: 'networkpolicy' | 'cilium';
  readonly policyName: string;
  readonly source: 'agent' | 'tenant' | 'default-deny';
  readonly applied: boolean;
}

/**
 * Idempotent create-or-update: try create first, fall back to
 * server-side replace on 409.
 */
export async function applyNetworkPolicyForAgent(
  agent: AgentLike,
  deps: ApplyEgressDeps,
): Promise<ApplyEgressResult> {
  const tenantName = agent.metadata.labels?.[TENANT_LABEL_KEY];
  const tenant =
    typeof tenantName === 'string' && deps.lookupTenant !== undefined
      ? deps.lookupTenant(tenantName)
      : undefined;

  const decoratedAgent = applyResolvedEgress(agent, tenant);
  const source: ApplyEgressResult['source'] =
    agent.spec.egress !== undefined
      ? 'agent'
      : decoratedAgent.spec.egress !== undefined
        ? 'tenant'
        : 'default-deny';

  const useCilium = decideMode(deps);
  const policyName = policyNameForAgent(decoratedAgent);
  const namespace = decoratedAgent.metadata.namespace ?? 'default';

  let cidrCount = 0;
  let domainCount = 0;
  let portCount = 0;

  if (useCilium) {
    const cnp = buildCiliumNetworkPolicyForAgent(decoratedAgent, deps.defaults);
    domainCount = decoratedAgent.spec.egress?.domains?.length ?? 0;
    cidrCount = decoratedAgent.spec.egress?.cidrs?.length ?? 0;
    portCount = decoratedAgent.spec.egress?.ports?.length ?? 0;
    await applyCiliumCnp(cnp, namespace, deps.customApi);
  } else {
    const { policy } = buildNetworkPolicyForAgent(decoratedAgent, deps.defaults);
    domainCount = decoratedAgent.spec.egress?.domains?.length ?? 0;
    cidrCount = decoratedAgent.spec.egress?.cidrs?.length ?? 0;
    portCount = decoratedAgent.spec.egress?.ports?.length ?? 0;
    await applyNetworkPolicy(policy, namespace, deps.networkingApi);
  }

  if (deps.onPolicyApplied !== undefined) {
    try {
      await deps.onPolicyApplied({
        agentName: decoratedAgent.metadata.name ?? '',
        agentNamespace: namespace,
        agentUid: decoratedAgent.metadata.uid,
        tenant: tenantName,
        mode: useCilium ? 'cilium' : 'networkpolicy',
        source,
        policyName,
        cidrCount,
        domainCount,
        portCount,
      });
    } catch (err) {
      // Audit is best-effort; never block reconciliation.
      console.warn('[kagent-egress] policy_applied audit hook raised (dropping):', err);
    }
  }

  return { mode: useCilium ? 'cilium' : 'networkpolicy', policyName, source, applied: true };
}

function decideMode(deps: ApplyEgressDeps): boolean {
  switch (deps.mode ?? 'auto') {
    case 'cilium':
      return true;
    case 'networkpolicy':
      return false;
    case 'auto':
    default:
      return deps.ciliumDetected;
  }
}

async function applyNetworkPolicy(
  policy: V1NetworkPolicy,
  namespace: string,
  api: NetworkingV1Api,
): Promise<void> {
  try {
    await api.createNamespacedNetworkPolicy({ namespace, body: policy });
    return;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code;
    const statusCode = (err as { code?: number; statusCode?: number }).statusCode;
    if (code !== 409 && statusCode !== 409) throw err;
  }
  // Conflict — replace the existing object.
  const name = policy.metadata?.name;
  if (typeof name !== 'string') throw new Error('NetworkPolicy missing metadata.name');
  await api.replaceNamespacedNetworkPolicy({ namespace, name, body: policy });
}

async function applyCiliumCnp(
  cnp: CiliumNetworkPolicy,
  namespace: string,
  api: CustomObjectsApi,
): Promise<void> {
  const group = 'cilium.io';
  const version = 'v2';
  const plural = 'ciliumnetworkpolicies';
  try {
    await api.createNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      body: cnp,
    });
    return;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code;
    const statusCode = (err as { code?: number; statusCode?: number }).statusCode;
    if (code !== 409 && statusCode !== 409) throw err;
  }
  const name = cnp.metadata.name;
  await api.replaceNamespacedCustomObject({
    group,
    version,
    namespace,
    plural,
    name,
    body: cnp,
  });
}

/**
 * Delete the per-Agent policy. Called on Agent deletion (ownerRef
 * cascade reaps; explicit delete is faster + observable, mirrors
 * workspace-controller).
 */
export async function deleteNetworkPolicyForAgent(
  agent: AgentLike,
  deps: ApplyEgressDeps,
): Promise<void> {
  const policyName = policyNameForAgent(agent);
  const namespace = agent.metadata.namespace ?? 'default';
  const useCilium = decideMode(deps);
  try {
    if (useCilium) {
      await deps.customApi.deleteNamespacedCustomObject({
        group: 'cilium.io',
        version: 'v2',
        namespace,
        plural: 'ciliumnetworkpolicies',
        name: policyName,
      });
    } else {
      await deps.networkingApi.deleteNamespacedNetworkPolicy({
        namespace,
        name: policyName,
      });
    }
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code;
    const statusCode = (err as { code?: number; statusCode?: number }).statusCode;
    if (code === 404 || statusCode === 404) return;
    throw err;
  }
}
