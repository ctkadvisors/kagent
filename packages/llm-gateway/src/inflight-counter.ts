/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Per-(model, endpoint) in-flight request counter — held in process
 * memory inside one gateway Pod. Single replica is the v1 design (see
 * spec §6); HA via Redis or leader-election is deferred until throughput
 * proves we need it.
 *
 * Why a plain Map+number is "atomic enough" here: Node runs JS on a
 * single thread. Pre-/post-increment of a Map<string, number> entry
 * cannot interleave; the only race surface is async hand-off between
 * acquire() and release(). The router pattern is `try { acquire();
 * await dispatch(); } finally { release(); }`, which preserves the
 * count regardless of interleaving across parallel inbound requests.
 *
 * `release()` clamps at zero so a buggy double-release can't drive the
 * counter negative (a negative count would corrupt admission decisions
 * silently — the at-cap check would let everything through).
 */

type Key = string;

export interface InFlightSnapshotEntry {
  readonly model: string;
  readonly endpoint: string;
  readonly inFlight: number;
}

export class InFlightCounter {
  private readonly map = new Map<Key, number>();

  /** Increment in-flight for (model, endpoint). */
  acquire(model: string, endpoint: string): void {
    const key = makeKey(model, endpoint);
    this.map.set(key, (this.map.get(key) ?? 0) + 1);
  }

  /** Decrement in-flight for (model, endpoint), clamped at zero. */
  release(model: string, endpoint: string): void {
    const key = makeKey(model, endpoint);
    const cur = this.map.get(key) ?? 0;
    const next = cur - 1;
    if (next <= 0) {
      this.map.delete(key);
    } else {
      this.map.set(key, next);
    }
  }

  /** Current in-flight count for (model, endpoint). */
  current(model: string, endpoint: string): number {
    return this.map.get(makeKey(model, endpoint)) ?? 0;
  }

  /**
   * Stable, deterministic snapshot suitable for /admin/capacity. Sorted
   * by key so callers and tests can compare without flake.
   */
  snapshot(): readonly InFlightSnapshotEntry[] {
    const out: InFlightSnapshotEntry[] = [];
    for (const [key, count] of this.map) {
      const sep = key.indexOf('|');
      out.push({
        model: key.slice(0, sep),
        endpoint: key.slice(sep + 1),
        inFlight: count,
      });
    }
    out.sort((a, b) => {
      if (a.model !== b.model) return a.model < b.model ? -1 : 1;
      return a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0;
    });
    return out;
  }
}

function makeKey(model: string, endpoint: string): Key {
  return `${model}|${endpoint}`;
}
