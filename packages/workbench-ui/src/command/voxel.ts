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

/** Pixels per voxel side. 10 reads cleanly at homelab cluster sizes. */
export const VOXEL_SIZE = 10;
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
 * Faction color from namespace. Hashes namespace name + uses a
 * fixed palette (so the colors read as deliberate "factions" — RA2
 * Allies-blue / Soviets-red / Yuri-purple — rather than randomly
 * assigned). Falls back through the palette in hash order, so the
 * same namespace always lands on the same color across reloads.
 */
const FACTION_PALETTE: readonly string[] = [
  '#3b82f6', // Allied blue
  '#dc2626', // Soviet red
  '#8b5cf6', // Yuri purple
  '#10b981', // Forest green
  '#f59e0b', // Sand
  '#0ea5e9', // Sky
  '#ec4899', // Pink
  '#14b8a6', // Teal
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
 * Build the default agent shape with a faction-colored body.
 */
export function defaultAgentShape(bodyColor: string): VoxelShape {
  const voxels: Voxel[] = [];

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
  // Top layer (z=3): 3x3 minus center.
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      if (x === 1 && y === 1) continue;
      voxels.push({ x, y, z: 3, color: bodyColor });
    }
  }
  // Spire (z=4): single voxel at center.
  voxels.push({ x: 1, y: 1, z: 4, color: SPIRE_DEFAULT });

  return {
    footprint: { w: 3, d: 3, h: 5 },
    voxels,
  };
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
