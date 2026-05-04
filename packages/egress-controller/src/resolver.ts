/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tenant-default egress resolver — Wave 4 / Egress sub-team
 * (v0.5.1-egress).
 *
 * Composes:
 *   1. Agent's explicit `spec.egress` (wins outright when set).
 *   2. Tenant's `spec.defaultEgress.allow[]` — glob list per Wave 4
 *      Tenancy. Each entry is treated as a domain (no `/` char) or a
 *      CIDR (contains `/`); the resolver routes accordingly.
 *   3. Substrate default-deny (no Agent allowlist) — the policy
 *      builder's default-deny posture covers DNS + NATS + gateway.
 *
 * Per docs/WAVES.md §6.2 deliverable 4 — the resolver is the
 * decision point; the builder consumes the resolver's output.
 *
 * Pure: no I/O. The operator's wiring layer feeds the matching
 * Tenant CR via the existing tenant informer's `lookupTenant`
 * callback.
 */

import type { AgentEgressLike, AgentLike, TenantLike } from './types.js';

/**
 * Whether an entry from `Tenant.spec.defaultEgress.allow[]` looks like
 * a CIDR (contains `/`). Coarse heuristic — the YAML schema doesn't
 * distinguish them.
 */
function looksLikeCidr(entry: string): boolean {
  return entry.includes('/');
}

/**
 * Resolve the effective `AgentEgress` for an Agent under a (possibly
 * unset) tenant.
 *
 * Precedence:
 *   1. Agent's own `spec.egress` (wins if set, even if empty — explicit
 *      empty = "Agent author opted into substrate default-deny").
 *   2. Tenant's `spec.defaultEgress.allow[]`, partitioned into domains
 *      + CIDRs by the heuristic above.
 *   3. `undefined` — caller passes the result to the builder; an
 *      `undefined` AgentEgress yields the default-deny policy.
 *
 * Pure: result is fully a function of inputs. Empty arrays in `agent.spec.egress`
 * are preserved (the builder treats them as default-deny, matching #1).
 */
export function resolveEffectiveEgress(
  agent: AgentLike,
  tenant?: TenantLike,
): AgentEgressLike | undefined {
  const explicit = agent.spec.egress;
  if (explicit !== undefined) return explicit;

  if (tenant === undefined) return undefined;
  const allow = tenant.spec.defaultEgress?.allow;
  if (allow === undefined || allow.length === 0) return undefined;

  const domains: string[] = [];
  const cidrs: string[] = [];
  for (const entry of allow) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (looksLikeCidr(entry)) cidrs.push(entry);
    else domains.push(entry);
  }
  if (domains.length === 0 && cidrs.length === 0) return undefined;

  return {
    ...(domains.length > 0 && { domains }),
    ...(cidrs.length > 0 && { cidrs }),
  };
}

/**
 * Decorator that returns a copy of the Agent with `spec.egress` set
 * to the resolved tenant default. The operator's wiring layer uses
 * this to feed the policy builder a single Agent shape regardless of
 * whether the allowlist came from the Agent or the Tenant.
 */
export function applyResolvedEgress(agent: AgentLike, tenant?: TenantLike): AgentLike {
  const resolved = resolveEffectiveEgress(agent, tenant);
  if (resolved === undefined) return agent;
  if (resolved === agent.spec.egress) return agent;
  return {
    ...agent,
    spec: {
      ...agent.spec,
      egress: resolved,
    },
  };
}
