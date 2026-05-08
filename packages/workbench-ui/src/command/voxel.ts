/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure canvas-2D iso-voxel rasterizer — the Red Alert 2 / Westwood
 * voxel-rendering engine vibe, in a browser, with no WebGL.
 *
 * The Command view replaces flat rectangular agent cards with small
 * voxel structures: chunky 3-tier buildings with a base slab, body,
 * and antenna spire. Each voxel is drawn as 3 painter-sorted quads
 * (top + +x face + +y face), shaded by face orientation. Faction
 * color tints the body per namespace. Phase color drives the spire.
 *
 * Coordinate model:
 *
 *   World axes: x = east (right-up), y = south (left-up), z = up.
 *   Iso projection (camera at +x, -y, +z):
 *
 *     sx = (x - y) * VOXEL_SIZE * cos(30°)
 *     sy = (x + y) * VOXEL_SIZE * sin(30°) - z * VOXEL_SIZE
 *
 *   Visible faces of any voxel: top (+z), east (+x), south (+y).
 *
 * Painter's algorithm: sort voxels back-to-front by (x + y - z)
 * ascending. Within a voxel, order doesn't matter (the 3 visible
 * faces don't overlap each other).
 */

/**
 * Pixels per voxel side. 9 keeps structures substantial (the RA2-base
 * reference is the visual target — beefy industrial buildings, not
 * crowded miniatures) while still letting 25-30 agents fit on a 1080p
 * canvas given the wider ring spacing in layout.ts.
 */
export const VOXEL_SIZE = 9;
const COS30 = Math.sqrt(3) / 2; // 0.866
const SIN30 = 0.5;

export interface Voxel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: string;
}

export interface VoxelShape {
  /** Bounding extents — used by hit-testing + layout to know how much
   * room a structure takes. Footprint is in voxel units. */
  readonly footprint: { w: number; d: number; h: number };
  readonly voxels: readonly Voxel[];
}

export interface ShapeRenderOpts {
  /** Center pixel — where the bottom-center of the structure lands. */
  readonly cx: number;
  readonly cy: number;
  /**
   * Build progress [0, 1]. When < 1, only the bottom `progress * h`
   * voxel layers render — so the structure rises layer-by-layer
   * (RA2's "construction yard deploys building" feel).
   */
  readonly buildProgress: number;
  /** Optional spire-color override (drives phase indication on top tier). */
  readonly spireColor?: string;
  /** When true, draw a faint cyan selection outline around the footprint. */
  readonly selected?: boolean;
  /** When > 0, pulse window lights on the body. nowMs drives phase. */
  readonly busyPulse?: number;
  /** Wall-clock for animation (sin pulses, etc.). */
  readonly nowMs: number;
}

/**
 * Project a world-space point to screen-space (relative to a 0,0
 * world origin). Add the structure's center offset on the caller side.
 */
export function projectIso(wx: number, wy: number, wz: number): { sx: number; sy: number } {
  return {
    sx: (wx - wy) * VOXEL_SIZE * COS30,
    sy: (wx + wy) * VOXEL_SIZE * SIN30 - wz * VOXEL_SIZE,
  };
}

/**
 * Compute the screen-space AABB of a voxel shape rendered at (cx, cy).
 * Used for click hit-testing — full polygonal voxel hit-test is overkill
 * for our scene size; the bounding rectangle is fine.
 */
export function shapeScreenBounds(
  shape: VoxelShape,
  cx: number,
  cy: number,
): { x: number; y: number; w: number; h: number } {
  const { w, d, h } = shape.footprint;
  // 8 corners of the AABB.
  const corners: Array<[number, number, number]> = [
    [0, 0, 0],
    [w, 0, 0],
    [0, d, 0],
    [w, d, 0],
    [0, 0, h],
    [w, 0, h],
    [0, d, h],
    [w, d, h],
  ];
  let minSx = Infinity;
  let maxSx = -Infinity;
  let minSy = Infinity;
  let maxSy = -Infinity;
  for (const [vx, vy, vz] of corners) {
    const { sx, sy } = projectIso(vx - w / 2, vy - d / 2, vz);
    const px = cx + sx;
    const py = cy + sy;
    if (px < minSx) minSx = px;
    if (px > maxSx) maxSx = px;
    if (py < minSy) minSy = py;
    if (py > maxSy) maxSy = py;
  }
  return { x: minSx, y: minSy, w: maxSx - minSx, h: maxSy - minSy };
}

/**
 * Render a voxel shape to canvas at (cx, cy). The structure's
 * footprint center sits at (cx, cy) on the BASE plane (z=0).
 */
export function drawVoxelShape(
  ctx: CanvasRenderingContext2D,
  shape: VoxelShape,
  opts: ShapeRenderOpts,
): void {
  const { cx, cy, buildProgress, spireColor, selected, busyPulse, nowMs } = opts;
  const { w, d, h } = shape.footprint;

  // Filter voxels by build-progress: only show layers up to the
  // "current build height." Within the current layer, fade in.
  const buildH = buildProgress * h;
  const currentLayerFloor = Math.floor(buildH);
  const layerProgress = buildH - currentLayerFloor;

  // Painter's algorithm: sort voxels by (x + y - z) ascending. Back-
  // first ordering so closer voxels overdraw farther ones cleanly.
  const voxels = shape.voxels
    .filter((v) => v.z < currentLayerFloor || (v.z === currentLayerFloor && layerProgress > 0))
    .slice()
    .sort((a, b) => {
      const ka = a.x + a.y - a.z;
      const kb = b.x + b.y - b.z;
      return ka - kb;
    });

  // Selection ring under the structure (drawn first so it sits below).
  if (selected === true) {
    drawFootprintRing(ctx, cx, cy, w, d, '#22d3ee');
  }

  for (const v of voxels) {
    // Center the shape on (cx, cy) in world space — shift voxel
    // coordinates so footprint center lands at world origin.
    const ox = v.x - w / 2;
    const oy = v.y - d / 2;
    const oz = v.z;

    // Apply layer-fade for the topmost in-progress layer: the layer
    // currently rising is alpha-faded based on layerProgress.
    let alpha = 1;
    if (v.z === currentLayerFloor) alpha = Math.max(0.15, layerProgress);

    // The spire (top voxels) uses the override color when given.
    const baseColor = v.z === h - 1 && spireColor !== undefined ? spireColor : v.color;

    drawVoxelCube(ctx, ox, oy, oz, cx, cy, baseColor, alpha);

    // Window lights on body voxels when busy. A subtle yellow rectangle
    // centered on the south face of mid-tier voxels.
    if (busyPulse !== undefined && busyPulse > 0 && v.z >= 1 && v.z < h - 1) {
      drawWindowLight(ctx, ox, oy, oz, cx, cy, nowMs);
    }
  }
}

/**
 * Render one voxel cube — 3 visible faces (top, +x, +y) with face-
 * angle-based shading.
 */
function drawVoxelCube(
  ctx: CanvasRenderingContext2D,
  vx: number,
  vy: number,
  vz: number,
  cx: number,
  cy: number,
  baseColor: string,
  alpha: number,
): void {
  // Project the 7 visible corners. Back-bottom-left (000) is occluded
  // by the front faces of any neighbor and never rendered, so skip it.
  const p100 = projectIso(vx + 1, vy, vz);
  const p010 = projectIso(vx, vy + 1, vz);
  const p110 = projectIso(vx + 1, vy + 1, vz);
  const p001 = projectIso(vx, vy, vz + 1);
  const p101 = projectIso(vx + 1, vy, vz + 1);
  const p011 = projectIso(vx, vy + 1, vz + 1);
  const p111 = projectIso(vx + 1, vy + 1, vz + 1);

  ctx.globalAlpha = alpha;

  const topColor = lighten(baseColor, 0.18);
  const xFaceColor = baseColor;
  const yFaceColor = darken(baseColor, 0.32);

  // +Y face (south, the most "front-facing" wall — darkest by convention).
  ctx.fillStyle = yFaceColor;
  fillQuad(ctx, p010, cx, cy, p110, p111, p011);

  // +X face (east).
  ctx.fillStyle = xFaceColor;
  fillQuad(ctx, p100, cx, cy, p110, p111, p101);

  // Top face (+z) — drawn last among the three so it sits cleanly on top.
  ctx.fillStyle = topColor;
  fillQuad(ctx, p001, cx, cy, p101, p111, p011);

  // 1px outline on edges for the chunky pixel-art feel.
  ctx.globalAlpha = alpha * 0.9;
  ctx.strokeStyle = darken(baseColor, 0.55);
  ctx.lineWidth = 0.75;
  // Top quad outline.
  ctx.beginPath();
  ctx.moveTo(cx + p001.sx, cy + p001.sy);
  ctx.lineTo(cx + p101.sx, cy + p101.sy);
  ctx.lineTo(cx + p111.sx, cy + p111.sy);
  ctx.lineTo(cx + p011.sx, cy + p011.sy);
  ctx.closePath();
  ctx.stroke();

  ctx.globalAlpha = 1;
}

function fillQuad(
  ctx: CanvasRenderingContext2D,
  a: { sx: number; sy: number },
  cx: number,
  cy: number,
  b: { sx: number; sy: number },
  c: { sx: number; sy: number },
  d: { sx: number; sy: number },
): void {
  ctx.beginPath();
  ctx.moveTo(cx + a.sx, cy + a.sy);
  ctx.lineTo(cx + b.sx, cy + b.sy);
  ctx.lineTo(cx + c.sx, cy + c.sy);
  ctx.lineTo(cx + d.sx, cy + d.sy);
  ctx.closePath();
  ctx.fill();
}

function drawWindowLight(
  ctx: CanvasRenderingContext2D,
  vx: number,
  vy: number,
  vz: number,
  cx: number,
  cy: number,
  nowMs: number,
): void {
  // Pulse: 0.5..1 amplitude on a 1.4Hz wave, voxel-position-phased
  // so neighboring windows blink slightly out of sync.
  const phase = (vx + vy * 1.7) * 1.3;
  const pulse = (Math.sin(nowMs / 110 + phase) + 1) / 2;
  const alpha = 0.35 + pulse * 0.55;

  // Center of the +y face.
  const front = projectIso(vx + 0.5, vy + 1, vz + 0.5);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#fde68a'; // warm amber window glow
  ctx.shadowColor = '#fde68a';
  ctx.shadowBlur = 4;
  ctx.fillRect(cx + front.sx - 1.5, cy + front.sy - 1.5, 3, 3);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

function drawFootprintRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  d: number,
  color: string,
): void {
  // Diamond outline on the ground plane, slightly inflated.
  const corners = [
    projectIso(-w / 2 - 0.4, -d / 2 - 0.4, 0),
    projectIso(w / 2 + 0.4, -d / 2 - 0.4, 0),
    projectIso(w / 2 + 0.4, d / 2 + 0.4, 0),
    projectIso(-w / 2 - 0.4, d / 2 + 0.4, 0),
  ];
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx + corners[0]!.sx, cy + corners[0]!.sy);
  for (let i = 1; i < corners.length; i++) {
    ctx.lineTo(cx + corners[i]!.sx, cy + corners[i]!.sy);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * RA2-style hazard-stripe ring around a structure's ground footprint.
 * Yellow-and-black diagonal "DO NOT CROSS" border that you see at the
 * base of every Construction Yard / War Factory.
 *
 * Implementation: draw a series of small alternating-color quads
 * along each of the 4 footprint edges in iso projection. The
 * diagonal stripe pattern emerges naturally from the iso angle.
 */
export function drawHazardRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  d: number,
): void {
  const STRIPE_COUNT_PER_EDGE = 8;
  const RING_WIDTH = 0.35; // voxel units, outward from footprint
  const HALF_W = w / 2;
  const HALF_D = d / 2;

  // 4 edges, each from corner to corner. For each edge, walk in
  // STRIPE_COUNT segments, alternating yellow/black.
  type Edge = { from: [number, number]; to: [number, number]; outward: [number, number] };
  const edges: Edge[] = [
    { from: [-HALF_W, -HALF_D], to: [HALF_W, -HALF_D], outward: [0, -RING_WIDTH] },
    { from: [HALF_W, -HALF_D], to: [HALF_W, HALF_D], outward: [RING_WIDTH, 0] },
    { from: [HALF_W, HALF_D], to: [-HALF_W, HALF_D], outward: [0, RING_WIDTH] },
    { from: [-HALF_W, HALF_D], to: [-HALF_W, -HALF_D], outward: [-RING_WIDTH, 0] },
  ];

  for (const edge of edges) {
    const [x0, y0] = edge.from;
    const [x1, y1] = edge.to;
    const [ox, oy] = edge.outward;
    for (let s = 0; s < STRIPE_COUNT_PER_EDGE; s++) {
      const t0 = s / STRIPE_COUNT_PER_EDGE;
      const t1 = (s + 1) / STRIPE_COUNT_PER_EDGE;
      const ax = x0 + (x1 - x0) * t0;
      const ay = y0 + (y1 - y0) * t0;
      const bx = x0 + (x1 - x0) * t1;
      const by = y0 + (y1 - y0) * t1;
      // Quad: inner edge (a, b) → outer edge (a+outward, b+outward).
      const pa = projectIso(ax, ay, 0);
      const pb = projectIso(bx, by, 0);
      const pc = projectIso(bx + ox, by + oy, 0);
      const pd = projectIso(ax + ox, ay + oy, 0);
      ctx.fillStyle = s % 2 === 0 ? '#fbbf24' : '#1a1a1a';
      ctx.beginPath();
      ctx.moveTo(cx + pa.sx, cy + pa.sy);
      ctx.lineTo(cx + pb.sx, cy + pb.sy);
      ctx.lineTo(cx + pc.sx, cy + pc.sy);
      ctx.lineTo(cx + pd.sx, cy + pd.sy);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/* =====================================================================
 * Color helpers — hex parsing, lighten/darken, faction palette.
 * ===================================================================== */

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (m === null) return null;
  const v = parseInt(m[1]!, 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number): string => {
    const v = Math.round(clamp01(n / 255) * 255);
    return v.toString(16).padStart(2, '0');
  };
  return `#${c(r)}${c(g)}${c(b)}`;
}

function lighten(hex: string, amount: number): string {
  const c = parseHex(hex);
  if (c === null) return hex;
  return toHex(c.r + (255 - c.r) * amount, c.g + (255 - c.g) * amount, c.b + (255 - c.b) * amount);
}

function darken(hex: string, amount: number): string {
  const c = parseHex(hex);
  if (c === null) return hex;
  return toHex(c.r * (1 - amount), c.g * (1 - amount), c.b * (1 - amount));
}

/**
 * Industrial-muted palette inspired by the RA2 base reference render.
 * Steel-grey / military-olive / rust-orange / deep-slate hues — the
 * structures should read as factories and warehouses on a concrete
 * pad, not as RGB-saturated faction icons. Differentiation between
 * factions is intentionally subtle here; per-agent ROLE drives the
 * shape variant (twin-tower / smokestack / ziggurat) which gives
 * stronger visual identity than color alone.
 */
const FACTION_PALETTE: readonly string[] = [
  '#3a5a78', // steel blue
  '#7c6f4a', // military olive
  '#7c3a3a', // rust orange
  '#5a4a3a', // dark bronze
  '#3a4a5a', // deep slate
  '#475569', // cool slate-600
  '#56574c', // muted khaki
  '#6b3f3f', // brick
];

function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function factionColor(namespace: string): string {
  const idx = hash32(namespace) % FACTION_PALETTE.length;
  return FACTION_PALETTE[idx]!;
}

/* =====================================================================
 * Default building shape — a 3×3 footprint × 5-tall ziggurat with a
 * single-voxel spire. Reads as "small RA2 building" at VOXEL_SIZE=10.
 *
 *   Layer 4 (z=4):    . . .          (single spire voxel at center)
 *                     . S .
 *                     . . .
 *   Layer 3 (z=3):    □ □ □          (top tier, full 3×3 minus center
 *                     □ . □           cutout for "command spire")
 *                     □ □ □
 *   Layer 2 (z=2):    □ □ □          (mid tier, full 3×3)
 *                     □ □ □
 *                     □ □ □
 *   Layer 1 (z=1):    □ □ □          (mid tier, full 3×3)
 *                     □ □ □
 *                     □ □ □
 *   Layer 0 (z=0):    ▓ ▓ ▓          (concrete base)
 *                     ▓ ▓ ▓
 *                     ▓ ▓ ▓
 * ===================================================================== */

const BASE_COLOR = '#475569'; // slate-600 — concrete base
const SPIRE_DEFAULT = '#22d3ee'; // cyan accent

/**
 * Build the default agent shape with a faction-colored body —
 * generic 3×3×5 ziggurat with central spire. Used for agents that
 * have no distinguishing tools (pure summarizer / verifier roles).
 */
export function defaultAgentShape(bodyColor: string): VoxelShape {
  const voxels: Voxel[] = [];
  const accent = lighten(bodyColor, 0.18);

  // Base layer (z=0): 3x3 concrete.
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      voxels.push({ x, y, z: 0, color: BASE_COLOR });
    }
  }
  // Body layers 1-2 (z=1, 2): 3x3 faction color.
  for (let z = 1; z <= 2; z++) {
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        voxels.push({ x, y, z, color: bodyColor });
      }
    }
  }
  // Top layer (z=3): 3x3 minus center, accent-tinted (an "upper deck"
  // band — gives industrial roof articulation without breaking
  // silhouette).
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      if (x === 1 && y === 1) continue;
      voxels.push({ x, y, z: 3, color: accent });
    }
  }
  // Spire (z=4): single voxel at center.
  voxels.push({ x: 1, y: 1, z: 4, color: SPIRE_DEFAULT });

  return {
    footprint: { w: 3, d: 3, h: 5 },
    voxels,
  };
}

/**
 * Orchestrator silhouette: 4×3 footprint with twin towers rising from
 * a shared base. Used for agents that have `spawn_child_task` —
 * "command complex" feel, two pillars channelling flow outward.
 *
 *   Top:        ╔═══╗ ═══╗     ╔═══╗ . . . ╔═══╗     (twin spire)
 *               ║ T ║ . . ║     ║ ⊞ ║ . . . ║ ⊞ ║
 *   Mid:        ║ ▓ ║ ▓ ▓ ║     ║ ▓ ║ ▓ ▓ ▓ ║ ▓ ║
 *   Base:       ▓▓▓▓ concrete pad ▓▓▓▓
 */
export function orchestratorAgentShape(bodyColor: string): VoxelShape {
  const voxels: Voxel[] = [];
  const accent = lighten(bodyColor, 0.2);

  // Base (z=0): 4x3 concrete pad.
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 3; y++) {
      voxels.push({ x, y, z: 0, color: BASE_COLOR });
    }
  }
  // Mid body z=1: full 4×3 in body color.
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 3; y++) {
      voxels.push({ x, y, z: 1, color: bodyColor });
    }
  }
  // Mid body z=2: connecting bridge — 4×3 minus the gap-row middle.
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 3; y++) {
      // Cut a "courtyard" between the towers — leaves x=1,2 at y=1
      // hollow so the two towers read as separate.
      if ((x === 1 || x === 2) && y === 1) continue;
      voxels.push({ x, y, z: 2, color: bodyColor });
    }
  }
  // Twin towers z=3,4: x=0 and x=3 only, full y=0..2.
  for (let z = 3; z <= 4; z++) {
    for (const tx of [0, 3]) {
      for (let y = 0; y < 3; y++) {
        voxels.push({ x: tx, y, z, color: bodyColor });
      }
    }
  }
  // Tower caps z=5: accent-colored tops.
  for (const tx of [0, 3]) {
    for (let y = 0; y < 3; y++) {
      if (y !== 1) continue; // single cap voxel per tower
      voxels.push({ x: tx, y, z: 5, color: accent });
    }
  }
  // Central command spire z=5: bridges the towers symbolically.
  voxels.push({ x: 1, y: 1, z: 3, color: accent });
  voxels.push({ x: 2, y: 1, z: 3, color: accent });
  // Spire tops.
  voxels.push({ x: 0, y: 1, z: 6, color: SPIRE_DEFAULT });
  voxels.push({ x: 3, y: 1, z: 6, color: SPIRE_DEFAULT });

  return {
    footprint: { w: 4, d: 3, h: 7 },
    voxels,
  };
}

/**
 * Fabricator silhouette: 3×3 ziggurat with a side-mounted smokestack
 * and conveyor extension. For agents with `write_artifact` — they
 * produce things; the structure has a chimney and a side dock.
 *
 *   Top:                         . . S      (smokestack tower offset)
 *   Mid:        . . .  ║ ║       . . S
 *   Body:       ▓ ▓ ▓  ║ ║       ▓ ▓ S
 *   Base:       ▓▓▓▓▓▓▓▓ concrete pad ▓▓▓
 */
export function fabricatorAgentShape(bodyColor: string): VoxelShape {
  const voxels: Voxel[] = [];
  const accent = lighten(bodyColor, 0.18);
  const stackColor = darken(bodyColor, 0.3);

  // Base (z=0): 4x3 (extends one cell south for conveyor dock).
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 3; y++) {
      voxels.push({ x, y, z: 0, color: BASE_COLOR });
    }
  }
  // Main body (z=1, 2): 3x3 ziggurat at x=0..2.
  for (let z = 1; z <= 2; z++) {
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        voxels.push({ x, y, z, color: bodyColor });
      }
    }
  }
  // Top deck (z=3): 3x3 accent.
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      if (x === 1 && y === 1) continue;
      voxels.push({ x, y, z: 3, color: accent });
    }
  }
  // Conveyor dock — single voxel at x=3, y=1, z=1 (extends the base).
  voxels.push({ x: 3, y: 1, z: 1, color: stackColor });
  // Smokestack — 4 voxels rising at x=2, y=2, z=3..6 (off-center
  // chimney, contrasts the central spire).
  for (let z = 3; z <= 6; z++) {
    voxels.push({ x: 2, y: 2, z, color: stackColor });
  }
  // Stack cap with smoke-glow color.
  voxels.push({ x: 2, y: 2, z: 7, color: '#fbbf24' });
  // Central spire (shorter than orchestrator's).
  voxels.push({ x: 1, y: 1, z: 4, color: SPIRE_DEFAULT });

  return {
    footprint: { w: 4, d: 3, h: 8 },
    voxels,
  };
}

/**
 * Pick the right shape for an agent based on its tool set.
 *  - `spawn_child_task` → orchestrator (twin-tower complex)
 *  - `write_artifact`   → fabricator (smokestack)
 *  - otherwise          → default (ziggurat)
 *
 * If an agent has BOTH tools, orchestrator wins — the child-spawning
 * shape is the more visually distinct silhouette.
 */
export function agentShapeForRole(
  bodyColor: string,
  tools: readonly string[] | undefined,
): VoxelShape {
  if (tools !== undefined) {
    if (tools.includes('spawn_child_task')) return orchestratorAgentShape(bodyColor);
    if (tools.includes('write_artifact')) return fabricatorAgentShape(bodyColor);
  }
  return defaultAgentShape(bodyColor);
}

/* =====================================================================
 * Gateway HQ — bigger 5×5 footprint × 6 high, multi-tier with a tall
 * antenna and corner buttresses. RA2 Construction Yard / Allied Tech
 * Center vibe.
 * ===================================================================== */

export function gatewayShape(): VoxelShape {
  const voxels: Voxel[] = [];
  const HQ_BODY = '#1e40af'; // deep blue
  const HQ_TOP = '#fbbf24'; // amber accent — matches the steady-state hex glow
  const HQ_SPIRE = '#fde68a'; // bright yellow antenna

  // Base (z=0): 5x5 concrete.
  for (let x = 0; x < 5; x++) {
    for (let y = 0; y < 5; y++) {
      voxels.push({ x, y, z: 0, color: BASE_COLOR });
    }
  }
  // Body lower (z=1, 2): 5x5 deep blue.
  for (let z = 1; z <= 2; z++) {
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        voxels.push({ x, y, z, color: HQ_BODY });
      }
    }
  }
  // Setback (z=3): 3x3 centered.
  for (let x = 1; x < 4; x++) {
    for (let y = 1; y < 4; y++) {
      voxels.push({ x, y, z: 3, color: HQ_BODY });
    }
  }
  // Roof platform (z=4): 3x3 with amber top.
  for (let x = 1; x < 4; x++) {
    for (let y = 1; y < 4; y++) {
      voxels.push({ x, y, z: 4, color: HQ_TOP });
    }
  }
  // Spire base (z=5): single voxel.
  voxels.push({ x: 2, y: 2, z: 5, color: HQ_SPIRE });

  return {
    footprint: { w: 5, d: 5, h: 6 },
    voxels,
  };
}
