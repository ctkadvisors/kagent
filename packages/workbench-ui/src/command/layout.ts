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

/**
 * Circuit-board layout — each faction occupies a contiguous angular sector
 * around the gateway. Agents inside a sector lay out on a polar grid
 * (one or more rings, indexed by the number of agents in the faction).
 *
 *   - SECTOR_GUTTER_FRAC: leave 12% of the sector angle empty between
 *     adjacent factions so trace lanes don't merge across factions.
 *   - GRID_SNAP_PX: round agent positions to this multiple so the
 *     resulting layout reads as a grid rather than free-form polar.
 *     Manhattan trace routing depends on this — endpoints aligned to
 *     a grid produce clean L-shape segments instead of jagged paths.
 *   - RING_BASE / RING_STEP: keep the inner ring well clear of the
 *     gateway HQ (which now has a 5×5 voxel footprint) and the
 *     outer rings well clear of each other (so labels never collide).
 */
const RING_BASE = 290;
const RING_STEP = 170;
const PER_RING = 6;
const SECTOR_GUTTER_FRAC = 0.12;
const MIN_FACTION_ARC = Math.PI * 0.45; // 81° — single-faction floor
const GRID_SNAP_PX = 20;

function snap(n: number): number {
  return Math.round(n / GRID_SNAP_PX) * GRID_SNAP_PX;
}

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
  const factionNames = Array.from(byFaction.keys()).sort((a, b) => a.localeCompare(b));

  // ── Sector assignment ──
  // Each faction gets a contiguous angular sector. Sector centers are
  // chosen by hash(namespace) for stability across reloads. With N
  // factions, each gets 360°/N of the circle minus a small gutter.
  const N = factionNames.length;
  const sectorArc = N === 0 ? Math.PI * 2 : (Math.PI * 2) / N;
  const factionArc = Math.max(MIN_FACTION_ARC, sectorArc * (1 - SECTOR_GUTTER_FRAC));

  // Hash-driven faction → sector-index assignment so the same set of
  // namespaces always lands in the same compass arrangement.
  type FactionEntry = { ns: string; hash: number };
  const factionsByHash: FactionEntry[] = factionNames
    .map((ns) => ({ ns, hash: hash32(ns) }))
    .sort((a, b) => a.hash - b.hash);

  const positions = new Map<string, AgentPosition>();
  const factionMeta = new Map<string, { angle: number; count: number }>();

  for (let fi = 0; fi < factionsByHash.length; fi++) {
    const entry = factionsByHash[fi];
    if (entry === undefined) continue;
    const { ns } = entry;
    // Sector center: equally spaced around the circle, with a global
    // phase offset hashed from the cluster's faction set. The offset
    // keeps the layout from always landing the same way relative to
    // the canvas (e.g., faction 0 always at 3 o'clock would feel
    // arbitrary; offsetting by a hash makes it look intentional).
    const phase = N > 0 ? (seedToUnit(hash32(factionNames.join('|'))) - 0.5) * sectorArc : 0;
    const sectorCenter = phase + (fi / Math.max(1, N)) * Math.PI * 2;

    const list = byFaction.get(ns) ?? [];
    const sorted = list.slice().sort((a, b) => a.name.localeCompare(b.name));

    factionMeta.set(ns, { angle: sectorCenter, count: sorted.length });

    for (let i = 0; i < sorted.length; i++) {
      const node = sorted[i];
      if (node === undefined) continue;
      const ring = Math.floor(i / PER_RING);
      const inRing = i % PER_RING;
      const ringSize = Math.min(PER_RING, sorted.length - ring * PER_RING);
      const t = ringSize === 1 ? 0 : (inRing / Math.max(1, ringSize - 1) - 0.5) * factionArc;
      const angle = sectorCenter + t;
      const radius = RING_BASE + ring * RING_STEP;
      const x = snap(cx + Math.cos(angle) * radius);
      const y = snap(cy + Math.sin(angle) * radius);
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
    gateway: { x: snap(cx), y: snap(cy) },
    agents: positions,
    factions: factionMeta,
  };
}
