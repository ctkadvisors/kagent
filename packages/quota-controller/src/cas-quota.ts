/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Per-tenant CAS storage cap.
 *
 * Periodic walker (default 10-minute cadence per
 * `docs/WAVES.md` §6.3) sums per-tenant CAS bytes by walking the
 * AgentTask informer cache + filesystem. Tenant identity is read
 * off the operator-stamped label `kagent.knuteson.io/tenant` on each
 * task; the task's `status.outputs[].ref` resolves to one or more
 * `cas:sha256:<hex>` URIs, each of which maps to a blob on disk.
 *
 * On every walk, the walker:
 *   1. Builds a `Map<tenant, bytes>` summing each blob's on-disk size
 *      against the tenant of the originating task.
 *   2. Compares against the resolved
 *      `Tenant.spec.defaultQuota.storage.casBytes` for each tenant.
 *   3. Maintains an in-process "tenant -> over-cap" set the
 *      admission gate (`checkTenantStorage`) reads on every new
 *      artifact admission. Refuses with
 *      `policy_denied:tenant_storage_exceeded` for tenants in the
 *      set.
 *
 * NOT a deletion path — CAS GC owns deletion (`cas-gc.ts` in the
 * operator). This walker only gates admission; existing blobs are
 * deleted once their reachability+TTL combo says so.
 *
 * Per docs/WAVES.md §6.3 deliverable 4 + docs/SUBSTRATE-V1.md §4.2.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { STORAGE_REFUSAL_REASON, type TaskShape } from './types.js';

/**
 * Default walker cadence. The brief locks 10 minutes; configurable
 * via `KAGENT_QUOTAS_CAS_WALK_INTERVAL_MINUTES` on the deployment.
 * Lower bound 1 minute (defense against typo'd 0).
 */
export const DEFAULT_CAS_WALK_INTERVAL_MS = 10 * 60 * 1000;
export const MIN_CAS_WALK_INTERVAL_MS = 60 * 1000;

/**
 * Parsed CAS URI — `cas:sha256:<64-hex>`. Anything else returns
 * undefined; the walker silently skips non-CAS / inline outputs.
 */
const CAS_URI_RE = /^cas:sha256:([0-9a-f]{64})$/;

function parseCasHash(uri: string | undefined): string | undefined {
  if (typeof uri !== 'string') return undefined;
  const m = CAS_URI_RE.exec(uri);
  return m === null ? undefined : m[1];
}

/**
 * Resolve a CAS hash to its on-disk path under
 * `<mountPath>/cas/sha256/<first-2>/<remaining-62>`. Mirrors the
 * sharding `cas-gc.ts:walkCasBlobs` uses.
 */
function casBlobPath(mountPath: string, hash: string): string {
  return resolve(mountPath, 'cas', 'sha256', hash.slice(0, 2), hash.slice(2));
}

/* =====================================================================
 * Walker — pure decision (sum bytes per tenant + decide who's over-cap).
 * ===================================================================== */

export interface CasWalkInput {
  /** Substrate-managed AgentTasks. Tenant identity read via `tenantLabel`. */
  readonly tasks: readonly TaskShape[];
  /** CAS PVC mount path on the operator pod (e.g. `/var/kagent/cas`). */
  readonly mountPath: string;
  /** Label key carrying tenant identity (`kagent.knuteson.io/tenant`). */
  readonly tenantLabel: string;
  /** Lookup tenant cap by name. Undefined → no cap (skip). */
  readonly capBytesLookup: (tenant: string) => number | undefined;
  /** Override `statSync` for tests. Defaults to `node:fs.statSync`. */
  readonly statFn?: (path: string) => { readonly size: number } | undefined;
}

export interface CasWalkPerTenant {
  readonly tenant: string;
  readonly bytesUsed: number;
  readonly bytesCap: number | undefined;
  readonly overCap: boolean;
  readonly artifactCount: number;
}

export interface CasWalkResult {
  readonly perTenant: ReadonlyMap<string, CasWalkPerTenant>;
  /** Set of tenants currently over their `storage.casBytes` cap. */
  readonly overCap: ReadonlySet<string>;
  /** Total blobs the walker stat'd (sum across tenants; diagnostics). */
  readonly scanned: number;
}

/**
 * Walk the AgentTask informer cache; sum on-disk CAS bytes per
 * tenant; return the over-cap set. Pure (modulo the FS stat read,
 * which the caller can override for tests).
 */
export function walkCasUsageByTenant(input: CasWalkInput): CasWalkResult {
  const stat =
    input.statFn ??
    ((path: string): { readonly size: number } | undefined => {
      try {
        const s = statSync(path);
        if (!s.isFile()) return undefined;
        return { size: s.size };
      } catch {
        return undefined;
      }
    });

  const bytesByTenant = new Map<string, number>();
  const countByTenant = new Map<string, number>();
  let scanned = 0;

  // Dedupe blob hashes per tenant — the same blob can be referenced
  // by N tasks of the same tenant, but we only count it once towards
  // the tenant's cap (CAS is content-addressed: one blob, one byte
  // count). Cross-tenant duplicates count under EACH tenant — the
  // substrate's accounting boundary is the tenant, not the blob.
  const seenPerTenant = new Map<string, Set<string>>();

  for (const t of input.tasks) {
    const tenant = t.metadata?.labels?.[input.tenantLabel];
    if (typeof tenant !== 'string' || tenant.length === 0) continue;
    const outputs = t.status?.outputs ?? [];
    for (const o of outputs) {
      const hash = parseCasHash(o.ref);
      if (hash === undefined) continue;
      let seen = seenPerTenant.get(tenant);
      if (seen === undefined) {
        seen = new Set();
        seenPerTenant.set(tenant, seen);
      }
      if (seen.has(hash)) continue;
      seen.add(hash);
      const path = casBlobPath(input.mountPath, hash);
      const s = stat(path);
      scanned++;
      if (s === undefined) continue;
      bytesByTenant.set(tenant, (bytesByTenant.get(tenant) ?? 0) + s.size);
      countByTenant.set(tenant, (countByTenant.get(tenant) ?? 0) + 1);
    }
  }

  const perTenant = new Map<string, CasWalkPerTenant>();
  const overCap = new Set<string>();
  for (const [tenant, bytesUsed] of bytesByTenant) {
    const bytesCap = input.capBytesLookup(tenant);
    const over = typeof bytesCap === 'number' && bytesCap >= 0 && bytesUsed > bytesCap;
    perTenant.set(tenant, {
      tenant,
      bytesUsed,
      bytesCap,
      overCap: over,
      artifactCount: countByTenant.get(tenant) ?? 0,
    });
    if (over) overCap.add(tenant);
  }
  return { perTenant, overCap, scanned };
}

/* =====================================================================
 * Admission gate — pure check used by `task-admission.ts`.
 * ===================================================================== */

export type StorageCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: typeof STORAGE_REFUSAL_REASON;
      readonly message: string;
      readonly tenant: string;
    };

/**
 * `checkTenantStorage(tenant, overCapSet)` — pure admission check.
 * The reconciler holds the live over-cap set (rebuilt by the walker
 * every interval) and asks this helper at AgentTask admission time.
 *
 * No tenant resolved → trivially OK (back-compat with v0.5.0 fail-
 * open posture).
 */
export function checkTenantStorage(
  tenant: string | undefined,
  overCap: ReadonlySet<string>,
): StorageCheck {
  if (typeof tenant !== 'string' || tenant.length === 0) return { ok: true };
  if (!overCap.has(tenant)) return { ok: true };
  return {
    ok: false,
    reason: STORAGE_REFUSAL_REASON,
    message: `${STORAGE_REFUSAL_REASON} — tenant=${tenant} CAS storage cap exceeded; new artifact admissions refused until walker observes recovery`,
    tenant,
  };
}

/* =====================================================================
 * Long-running walker controller wrapper.
 * ===================================================================== */

export interface CasQuotaControllerHandle {
  /** Stop the timer; safe to call more than once. */
  stop(): void;
  /** Test/observability surface: most-recent walk result. */
  lastResult(): CasWalkResult | undefined;
  /** Test surface: live over-cap set. Mutated each tick. */
  overCap(): ReadonlySet<string>;
}

export interface CasQuotaControllerConfig {
  readonly mountPath: string;
  readonly intervalMs: number;
  readonly tenantLabel: string;
}

export interface CasQuotaControllerDeps {
  readonly listAgentTasks: () => readonly TaskShape[];
  readonly capBytesLookup: (tenant: string) => number | undefined;
  /** Best-effort emission of `quota.storage_exceeded` per over-cap tenant. */
  readonly emitStorageExceeded?: (data: {
    tenant: string;
    bytesUsed: number;
    bytesCap: number;
  }) => Promise<void> | void;
  readonly log?: (msg: string) => void;
  readonly statFn?: CasWalkInput['statFn'];
  /** Wall clock injection point for tests (not used by walk-itself). */
  readonly now?: () => number;
}

/**
 * Boot the walker: kicks off a periodic timer calling
 * `walkCasUsageByTenant` every `config.intervalMs`. Errors are
 * caught + logged; a failed walk does NOT crash the operator.
 *
 * Returns a handle exposing `stop()` and the live `overCap()` set —
 * the handle is THE source the admission gate reads (operator's
 * `task-admission.ts` calls `controller.overCap()` at admission time
 * via the wired `checkTenantStorage` callback).
 */
export function startCasQuotaController(
  config: CasQuotaControllerConfig,
  deps: CasQuotaControllerDeps,
): CasQuotaControllerHandle {
  if (config.intervalMs < MIN_CAS_WALK_INTERVAL_MS) {
    throw new Error(
      `cas-quota: intervalMs (${String(config.intervalMs)}) must be >= ${String(MIN_CAS_WALK_INTERVAL_MS)}`,
    );
  }
  const log = deps.log ?? ((m: string) => console.log(m));
  let last: CasWalkResult | undefined;
  let over: ReadonlySet<string> = new Set();
  // Track tenants we've already emitted `quota.storage_exceeded` for
  // this controller-lifecycle so we don't spam the audit stream once
  // per walk while the tenant remains over-cap. Clears the entry
  // when the tenant drops back under cap.
  const emitted = new Set<string>();

  const tick = (): void => {
    try {
      const result = walkCasUsageByTenant({
        tasks: deps.listAgentTasks(),
        mountPath: config.mountPath,
        tenantLabel: config.tenantLabel,
        capBytesLookup: deps.capBytesLookup,
        ...(deps.statFn !== undefined && { statFn: deps.statFn }),
      });
      last = result;
      over = result.overCap;
      log(
        `[kagent-operator/cas-quota] walk done — tenants=${String(result.perTenant.size)} ` +
          `scanned=${String(result.scanned)} overCap=${String(over.size)}`,
      );
      // Emit + clear-emitted-set bookkeeping.
      for (const tenant of over) {
        if (emitted.has(tenant)) continue;
        const per = result.perTenant.get(tenant);
        if (per === undefined || per.bytesCap === undefined) continue;
        emitted.add(tenant);
        if (deps.emitStorageExceeded !== undefined) {
          try {
            void Promise.resolve(
              deps.emitStorageExceeded({
                tenant,
                bytesUsed: per.bytesUsed,
                bytesCap: per.bytesCap,
              }),
            );
          } catch (err) {
            log(
              `[kagent-operator/cas-quota] emit storage_exceeded failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      // Clear emitted entries that are no longer over-cap.
      for (const tenant of [...emitted]) {
        if (!over.has(tenant)) emitted.delete(tenant);
      }
    } catch (err) {
      log(
        `[kagent-operator/cas-quota] walk failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Kick a synchronous initial walk so the over-cap set is populated
  // before the first AgentTask admission (otherwise admission fail-
  // opens for the first interval window — defensible but not what
  // the substrate intends).
  tick();

  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  log(
    `[kagent-operator/cas-quota] started — mountPath=${config.mountPath} intervalMs=${String(config.intervalMs)} tenantLabel=${config.tenantLabel}`,
  );

  return {
    stop(): void {
      clearInterval(timer);
    },
    lastResult(): CasWalkResult | undefined {
      return last;
    },
    overCap(): ReadonlySet<string> {
      return over;
    },
  };
}
