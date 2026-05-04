/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Per-tenant gateway in-flight counter.
 *
 * The substrate's "concurrent in-flight gateway requests cap per
 * tenant". When AgentTask admission fires `acquire(tenant)` and the
 * counter would exceed `inFlightCap`, admission refuses with
 * `policy_denied:tenant_gateway_inflight_exceeded` and the AgentTask
 * is marked Failed. On Completed/Failed task transitions, the
 * reconciler calls `release(tenant)` to free the slot.
 *
 * v0.5.2 keeps state in-process. This is fine for the substrate's
 * single-replica leader-elected operator (per `docs/WAVES.md` §6.3
 * + the substrate's v0.1 leader-election constraint). When the
 * operator deploys multi-replica with leader election, only the
 * leader admits AgentTasks — the counter therefore lives on the
 * leader. A replica failover loses in-flight counts; on rebuild the
 * reconciler re-counts via the AgentTask informer's
 * `phase ∉ {Completed, Failed}` set, so a failover re-converges in
 * one informer-resync (~30s). Multi-replica with shared state
 * (Redis-backed) is the v0.5.3 follow-up; the public API on this
 * counter stays stable across that change.
 *
 * Per docs/WAVES.md §6.3 deliverable 2 + docs/SUBSTRATE-V1.md §4.2.
 */

import { GATEWAY_INFLIGHT_REFUSAL_REASON, type TaskShape } from './types.js';

/**
 * Result of `tryAcquire`. `ok: true` lets the caller proceed; the
 * caller is responsible for the matched `release()` (typically wired
 * via the informer's onCompleted/onFailed handlers).
 */
export type GatewayAcquireResult =
  | { readonly ok: true; readonly observed: number; readonly cap: number | undefined }
  | {
      readonly ok: false;
      readonly reason: typeof GATEWAY_INFLIGHT_REFUSAL_REASON;
      readonly message: string;
      readonly observed: number;
      readonly cap: number;
      readonly tenant: string;
    };

/**
 * In-process per-tenant gateway-call in-flight counter. Map<tenant, count>.
 *
 * The cap is read from the resolved tenant via `capLookup` at every
 * `tryAcquire` so cluster admins editing a Tenant CR's
 * `defaultQuota.gateway.inFlightCap` take effect on the next
 * admission without an operator restart.
 */
export class GatewayInFlightCounter {
  private readonly counts = new Map<string, number>();

  /**
   * Cap-lookup callback. Returns the cap configured for a tenant
   * (typically `tenant.spec.defaultQuota.gateway.inFlightCap`),
   * falling back to a chart-level default. `undefined` = no cap;
   * `tryAcquire` always succeeds.
   */
  constructor(private readonly capLookup: (tenantName: string) => number | undefined) {}

  /**
   * Reserve a slot for `tenant`. On success returns `{ ok: true }`
   * and increments the in-flight counter. On refusal returns the
   * structured rejection envelope (caller emits
   * `quota.gateway_inflight_exceeded` audit + marks the AgentTask
   * Failed with `policy_denied:tenant_gateway_inflight_exceeded`).
   *
   * No tenant resolved (legacy single-tenant install) → trivially OK,
   * never refuses. The substrate's tenancy fail-open posture (per
   * Wave 4 / Tenancy v0.5.0) carries through here.
   */
  tryAcquire(tenant: string | undefined): GatewayAcquireResult {
    if (typeof tenant !== 'string' || tenant.length === 0) {
      return { ok: true, observed: 0, cap: undefined };
    }
    const cap = this.capLookup(tenant);
    const current = this.counts.get(tenant) ?? 0;
    if (typeof cap !== 'number' || cap < 0) {
      this.counts.set(tenant, current + 1);
      return { ok: true, observed: current + 1, cap: undefined };
    }
    if (current >= cap) {
      return {
        ok: false,
        reason: GATEWAY_INFLIGHT_REFUSAL_REASON,
        message: `${GATEWAY_INFLIGHT_REFUSAL_REASON} — tenant=${tenant} observed=${String(current)} cap=${String(cap)}`,
        observed: current,
        cap,
        tenant,
      };
    }
    this.counts.set(tenant, current + 1);
    return { ok: true, observed: current + 1, cap };
  }

  /**
   * Release a slot for `tenant`. Idempotent: decrementing past zero
   * stays at zero (defense against stray Completed-after-Failed
   * double-fire from the K8s informer). No-op when tenant is
   * undefined.
   */
  release(tenant: string | undefined): void {
    if (typeof tenant !== 'string' || tenant.length === 0) return;
    const current = this.counts.get(tenant) ?? 0;
    if (current <= 1) {
      this.counts.delete(tenant);
      return;
    }
    this.counts.set(tenant, current - 1);
  }

  /** Test/diagnostic surface — current count for a tenant. Undefined → 0. */
  observed(tenant: string): number {
    return this.counts.get(tenant) ?? 0;
  }

  /** Test surface — clear all counters. */
  reset(): void {
    this.counts.clear();
  }

  /**
   * Recompute counters from the AgentTask informer. Called on
   * operator boot AND on leader-election handover (both via main.ts
   * wiring) so a fresh leader's view matches reality. Counts every
   * non-terminal task (`phase ∉ {Completed, Failed}`).
   *
   * The label-key for tenant is passed in so this module stays
   * dependency-free against `crds/tenant.ts` (avoids the import
   * cycle the locality-controller pattern documents).
   */
  rebuildFromTasks(tasks: readonly TaskShape[], tenantLabel: string): void {
    this.counts.clear();
    for (const t of tasks) {
      const phase = t.status?.phase;
      if (phase === 'Completed' || phase === 'Failed') continue;
      const tenant = t.metadata?.labels?.[tenantLabel];
      if (typeof tenant !== 'string' || tenant.length === 0) continue;
      this.counts.set(tenant, (this.counts.get(tenant) ?? 0) + 1);
    }
  }
}

/**
 * Pure decision helper — reuses `GatewayInFlightCounter`'s logic
 * without owning state. Useful for tests / callers that want a
 * read-only check without mutating the counter (e.g. dry-run /
 * observability paths). Not used in the production hot path —
 * `tryAcquire` is.
 */
export function checkGatewayInFlight(
  tenant: string,
  observed: number,
  cap: number | undefined,
): GatewayAcquireResult {
  if (typeof cap !== 'number' || cap < 0) {
    return { ok: true, observed, cap: undefined };
  }
  if (observed >= cap) {
    return {
      ok: false,
      reason: GATEWAY_INFLIGHT_REFUSAL_REASON,
      message: `${GATEWAY_INFLIGHT_REFUSAL_REASON} — tenant=${tenant} observed=${String(observed)} cap=${String(cap)}`,
      observed,
      cap,
      tenant,
    };
  }
  return { ok: true, observed, cap };
}
