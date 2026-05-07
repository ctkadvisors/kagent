/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Deterministic spatial layout for the Command view.
 *
 * Positions are computed from `namespace/name` so the same Agent lands in
 * the same spot on every reload (no jitter when the SSE stream re-asserts
 * the cache shape).
 *
 * Topology:
 *
 *   - Gateway is the central HQ at the canvas centroid.
 *   - Agents are grouped by namespace into "factions" — each faction
 *     occupies an arc around the gateway. The arc center is hashed from
 *     the namespace, so two namespaces that pre-existed don't shuffle
 *     when a third lands.
 *   - Within a faction, agents are placed at increasing radii outward
 *     along the arc — first agent closest to gateway, second one ring
 *     out, etc. — so the topology grows like a real RTS base.
 *
 * The layout output is purely (x, y) per agent + the gateway center; the
 * scene renderer draws the structures, belts, units. Belts are implicit
 * — straight line from gateway to each agent — so layout doesn't need
 * to track them.
 */

export interface CanvasBounds {
  readonly width: number;
  readonly height: number;
}

export interface AgentNode {
  readonly key: string; // `${namespace}/${name}`
  readonly namespace: string;
  readonly name: string;
  readonly model?: string;
  readonly modelClass?: string;
  readonly scenario?: string;
  readonly tools?: readonly string[];
}

export interface AgentPosition {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number; // distance from gateway center
  readonly faction: string; // namespace
}

export interface LayoutResult {
  readonly gateway: { x: number; y: number };
  readonly agents: ReadonlyMap<string, AgentPosition>;
  readonly factions: ReadonlyMap<string, { angle: number; count: number }>;
}

/**
 * 32-bit FNV-1a — tiny non-cryptographic hash, no deps. Good enough for
 * "stable positional jitter from a string."
 */
function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Returns a number in [0, 1) deterministically derived from `seed`. */
function seedToUnit(seed: number): number {
  return (seed >>> 8) / 0x01000000;
}

const RING_BASE = 180; // px from gateway to first ring
const RING_STEP = 110; // px between rings
const PER_RING = 6; // agents per ring before stepping out
const FACTION_ARC = Math.PI / 2; // radians a single faction spans

export function computeLayout(agents: readonly AgentNode[], bounds: CanvasBounds): LayoutResult {
  const cx = bounds.width / 2;
  const cy = bounds.height / 2;

  // Group by namespace.
  const byFaction = new Map<string, AgentNode[]>();
  for (const a of agents) {
    const list = byFaction.get(a.namespace);
    if (list === undefined) {
      byFaction.set(a.namespace, [a]);
    } else {
      list.push(a);
    }
  }
  // Stable iteration: alphabetize namespaces so factions don't shuffle.
  const factionNames = Array.from(byFaction.keys()).sort((a, b) => a.localeCompare(b));

  const positions = new Map<string, AgentPosition>();
  const factionMeta = new Map<string, { angle: number; count: number }>();

  for (const ns of factionNames) {
    // Arc center angle hashed from namespace. Two stable, well-known
    // namespaces always land at the same compass bearing.
    const arcCenter = seedToUnit(hash32(ns)) * Math.PI * 2;
    const list = byFaction.get(ns) ?? [];
    // Sort within faction by name so per-faction order is stable too.
    const sorted = list.slice().sort((a, b) => a.name.localeCompare(b.name));

    factionMeta.set(ns, { angle: arcCenter, count: sorted.length });

    for (let i = 0; i < sorted.length; i++) {
      const node = sorted[i];
      if (node === undefined) continue;
      const ring = Math.floor(i / PER_RING);
      const inRing = i % PER_RING;
      const ringSize = Math.min(PER_RING, sorted.length - ring * PER_RING);
      // Spread within the faction arc; if only one agent in a ring,
      // place it at arc center.
      const t = ringSize === 1 ? 0 : (inRing / Math.max(1, ringSize - 1) - 0.5) * FACTION_ARC;
      const angle = arcCenter + t;
      const radius = RING_BASE + ring * RING_STEP;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      positions.set(node.key, {
        key: node.key,
        x,
        y,
        radius,
        faction: ns,
      });
    }
  }

  return {
    gateway: { x: cx, y: cy },
    agents: positions,
    factions: factionMeta,
  };
}
