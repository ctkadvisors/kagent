/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * In-memory cache of `ModelEndpoint` CRs keyed by `spec.model`. The
 * router consults this on every /v1/chat/completions to find which
 * backend to dispatch to without round-tripping the K8s API.
 *
 * The actual K8s informer (watch loop) lives in `model-watch.ts`;
 * this module is the pure data structure so router tests can drive
 * it directly without booting an informer.
 *
 * M20 — Collision detection. Two CRs claiming the same `spec.model`
 * but different `spec.backendUrl` previously resulted in the second
 * upsert silently replacing the first (Map.set overwrites). Worse,
 * the eviction order depended on K8s informer event ordering and
 * `setTimeout` reconnect jitter, so the gateway's effective routing
 * table was non-deterministic.
 *
 * Fix: every entry remembers the CR's identity (`namespace/name`).
 * `upsert` rejects (returns `'collision'`) when the incoming CR has
 * the same `spec.model` as an existing entry but a different CR
 * identity — admission rejection at the in-process boundary. The
 * informer logs a structured warning and keeps the existing entry,
 * so the gateway's routing decisions stay deterministic and the
 * operator sees the misconfiguration in logs.
 *
 * The same CR re-applying its own `spec` (resourceVersion bump,
 * status update) IS still admitted — identity match means it's the
 * same CR, just a re-emission.
 */

import { normalizeBounds } from './bounds.js';
import type { ModelEndpoint } from './types.js';

export interface ModelLookup {
  readonly endpoint: ModelEndpoint;
  /** Resolved bounds — falls back to spec defaults when omitted. */
  readonly seed: number;
  readonly max: number;
  readonly minSafe: number;
}

/**
 * M20 — outcome of an upsert attempt. `applied` is the normal happy
 * path; `collision` means we kept the existing entry because the
 * incoming CR conflicted. `noop` is a defensive sentinel for ill-shaped
 * inputs (kept here so callers don't have to guess).
 */
export type UpsertResult =
  | { kind: 'applied' }
  | {
      kind: 'collision';
      reason: 'model-name-collision';
      existing: { namespace: string; name: string; backendUrl: string };
      incoming: { namespace: string; name: string; backendUrl: string };
    };

interface IndexEntry {
  readonly endpoint: ModelEndpoint;
  /** CR identity — `namespace/name`. */
  readonly identity: string;
}

function crIdentity(ep: ModelEndpoint): string {
  return `${ep.metadata.namespace ?? '<no-ns>'}/${ep.metadata.name}`;
}

export class ModelIndex {
  private readonly map = new Map<string, IndexEntry>();

  /** Replace the entire index — used on initial K8s list. */
  replaceAll(endpoints: readonly ModelEndpoint[]): void {
    this.map.clear();
    for (const ep of endpoints) this.upsert(ep);
  }

  /**
   * Insert or update a single ModelEndpoint by `spec.model`.
   *
   * M20 — when an entry already exists under `spec.model`, the upsert
   * is admitted iff the incoming CR has the SAME `namespace/name`
   * identity as the existing entry. A different CR claiming the same
   * model name is rejected with `kind: 'collision'`; the existing
   * entry stays in place. The caller (informer) is expected to log a
   * structured warning so the operator can fix the misconfiguration.
   */
  upsert(endpoint: ModelEndpoint): UpsertResult {
    const incomingIdentity = crIdentity(endpoint);
    const existing = this.map.get(endpoint.spec.model);
    if (existing !== undefined && existing.identity !== incomingIdentity) {
      const [existingNs, existingName] = existing.identity.split('/');
      const [incomingNs, incomingName] = incomingIdentity.split('/');
      return {
        kind: 'collision',
        reason: 'model-name-collision',
        existing: {
          namespace: existingNs ?? '<no-ns>',
          name: existingName ?? '<unknown>',
          backendUrl: existing.endpoint.spec.backendUrl,
        },
        incoming: {
          namespace: incomingNs ?? '<no-ns>',
          name: incomingName ?? '<unknown>',
          backendUrl: endpoint.spec.backendUrl,
        },
      };
    }
    this.map.set(endpoint.spec.model, { endpoint, identity: incomingIdentity });
    return { kind: 'applied' };
  }

  /**
   * Remove from the index by `spec.model` (the deleted CR's model
   * name). M20 — only removes the entry if it belongs to the named
   * CR; a delete event from a non-owning CR is ignored (defensive
   * against post-collision tombstones). When `crIdentityHint` is
   * undefined, behaves as before (unconditional delete by model name).
   */
  delete(modelName: string, crIdentityHint?: string): void {
    if (crIdentityHint === undefined) {
      this.map.delete(modelName);
      return;
    }
    const existing = this.map.get(modelName);
    if (existing === undefined) return;
    if (existing.identity === crIdentityHint) {
      this.map.delete(modelName);
    }
  }

  /** All currently-tracked endpoint specs (read-only snapshot). */
  list(): readonly ModelEndpoint[] {
    return [...this.map.values()].map((e) => e.endpoint);
  }

  /**
   * Lookup by the OpenAI request's `model` field.
   *
   * C3-REV3-H1 — bounds projection funnels through `normalizeBounds`
   * so the AIMD `minSafe >= 1` invariant is preserved on the router's
   * read path. Without the clamp here, the router would call
   * `aimd.updateBounds` with the raw spec value on every request,
   * overwriting the watch-time normalization for any CR carrying
   * `spec.minSafe: 0` and restoring the original B5 DoS.
   */
  lookup(model: string): ModelLookup | null {
    const entry = this.map.get(model);
    if (entry === undefined) return null;
    const ep = entry.endpoint;
    const bounds = normalizeBounds(ep);
    return {
      endpoint: ep,
      seed: bounds.seed,
      max: bounds.max,
      minSafe: bounds.minSafe,
    };
  }
}
