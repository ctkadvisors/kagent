/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Canvas 2D scene renderer for the Command view.
 *
 * The renderer is a plain function — it takes the latest snapshot +
 * canvas context + frame timestamp and paints the scene. There's no
 * scene graph; we redraw every frame because the scene size is small
 * (dozens of structures + units) and 2D canvas at 60fps handles this
 * trivially.
 *
 * Visual language is deliberately Total-Annihilation / Warcraft-3-shaped:
 *
 *   - Dark navy background with a faint isometric-feeling grid.
 *   - Gateway = central hexagon with a thick border, pulsing accent ring.
 *   - Agent buildings = rectangular structures with a model badge,
 *     name, and a green/yellow/red status dot for in-flight load.
 *   - Faction territory = soft tinted polygon under each namespace's
 *     agents (the WC3 "minor faction" feel).
 *   - Tasks = small colored sprites that travel along belts. Phase
 *     drives sprite color (Pending=blue, Dispatched=yellow, Completed=
 *     green, Failed=red). Task animation is a sine-eased journey
 *     gateway → agent → gateway over the task's lifetime.
 *   - Hit-test rectangles per agent + the gateway are tracked separately
 *     so click handlers can resolve a click to a structure.
 */

import type { CommandSnapshot } from './state.js';
import type { LayoutResult } from './layout.js';
import type { TaskSummary } from '../types.js';
import {
  agentShapeForRole,
  drawHazardRing,
  drawVoxelShape,
  factionColor,
  gatewayShape,
  shapeScreenBounds,
} from './voxel.js';

export interface SelectionRef {
  readonly kind: 'agent' | 'gateway' | 'task' | null;
  readonly key: string | null;
}

export interface HitMap {
  /** Per-agent screen-space bounds for click hit-testing. */
  readonly agentRects: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>;
  /** Gateway hex bounding box. */
  readonly gateway: { x: number; y: number; r: number };
  /** Task sprites currently visible — for click-through to detail. */
  readonly taskSprites: ReadonlyMap<string, { x: number; y: number }>;
}

const COLOR_BG = '#070d18';
/** Major grid line — every 100px, the "rail" pitch. */
const COLOR_GRID = 'rgba(82, 200, 124, 0.07)';
/** Minor grid line — every 20px, the GRID_SNAP_PX from layout. */
const COLOR_GRID_FINE = 'rgba(82, 200, 124, 0.035)';
const COLOR_GATEWAY = '#fbbf24';
const COLOR_BELT = 'rgba(148, 163, 184, 0.18)';
const COLOR_BELT_HOT = 'rgba(251, 191, 36, 0.45)';
const COLOR_BELT_BUILDING = 'rgba(34, 211, 238, 0.5)';
const COLOR_AGENT_BORDER_BUSY = '#fbbf24';
const COLOR_AGENT_BORDER_FAILED = '#ef4444';
const COLOR_AGENT_TEXT = '#e2e8f0';
const COLOR_AGENT_SUB = '#94a3b8';
const COLOR_FACTION_TINT = 'rgba(59, 130, 246, 0.04)';
const COLOR_TASK_PENDING = '#60a5fa';
const COLOR_TASK_DISPATCHED = '#fbbf24';
const COLOR_TASK_COMPLETED = '#34d399';
const COLOR_TASK_FAILED = '#f87171';

const GATEWAY_HIT_R = 70; // circular click hit-test radius around the voxel HQ
const TASK_R = 5;

/** Build-out animation duration for an agent structure. */
const BUILD_MS = 1500;
/** Gateway gets a longer dramatic build-in (HQ structure). */
const GATEWAY_BUILD_MS = 2200;

interface SceneInputs {
  readonly snapshot: CommandSnapshot;
  readonly layout: LayoutResult;
  readonly selection: SelectionRef;
  readonly nowMs: number;
  /**
   * Per-key first-seen wallclock. Drives the build-out animation —
   * `progress = (nowMs - firstSeen) / BUILD_MS`. Keys are agent
   * `${ns}/${name}` plus the literal `gateway` for the HQ.
   */
  readonly firstSeen: ReadonlyMap<string, number>;
}

export function drawScene(ctx: CanvasRenderingContext2D, inputs: SceneInputs): HitMap {
  const { width, height } = ctx.canvas;
  const { snapshot, layout, selection, nowMs, firstSeen } = inputs;

  // Background + grid.
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height);

  // Faction tint — a soft polygon hugging each namespace's agents.
  drawFactionTints(ctx, layout);

  // Belts (gateway → each agent), drawn first so structures sit on top.
  // Belts adopt the construction palette while either endpoint is still
  // building, so the line "extends" visually before the destination
  // structure rises.
  const gatewayProgress = buildProgress(firstSeen.get('gateway'), nowMs, GATEWAY_BUILD_MS);
  for (const pos of layout.agents.values()) {
    const inFlight = countInFlightFor(snapshot, pos.key);
    const agentProgress = buildProgress(firstSeen.get(pos.key), nowMs, BUILD_MS);
    const beltProgress = Math.min(gatewayProgress, agentProgress);
    drawBelt(ctx, layout.gateway, pos, inFlight, beltProgress);
  }

  // Agent structures.
  const agentRects = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const pos of layout.agents.values()) {
    const a = snapshot.agents.get(pos.key);
    const inFlight = countInFlightFor(snapshot, pos.key);
    const failed = countFailedRecentFor(snapshot, pos.key, nowMs);
    const progress = buildProgress(firstSeen.get(pos.key), nowMs, BUILD_MS);
    const rect = drawAgentBuilding(
      ctx,
      pos,
      a?.name ?? pos.key,
      a?.model ?? a?.modelClass ?? '—',
      inFlight,
      failed,
      selection.kind === 'agent' && selection.key === pos.key,
      progress,
      nowMs,
      pos.faction,
      a?.tools,
    );
    agentRects.set(pos.key, rect);
  }

  // Gateway HQ (last among structures so its glow sits on top).
  drawGateway(
    ctx,
    layout.gateway,
    snapshot.gatewayCapacity.length,
    nowMs,
    selection.kind === 'gateway',
    gatewayProgress,
  );

  // Task units travel on belts.
  const taskSprites = drawTaskUnits(ctx, snapshot, layout, nowMs);

  return {
    agentRects,
    // Voxel HQ is anchored at (gateway.x, gateway.y + 22) per drawGateway;
    // hit-test as a circle a bit larger than the projected footprint.
    gateway: { x: layout.gateway.x, y: layout.gateway.y + 22, r: GATEWAY_HIT_R },
    taskSprites,
  };
}

/**
 * PCB-style two-tier grid: faint 20px minor lines (matches the
 * GRID_SNAP_PX in layout.ts) + slightly stronger 100px major rails.
 * Reads as "circuit substrate" rather than "graph paper."
 */
function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // Minor grid (20px).
  ctx.strokeStyle = COLOR_GRID_FINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 20) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += 20) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();

  // Major grid (100px) — a "rail" every 5 minor cells.
  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 100) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += 100) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
}

function drawFactionTints(ctx: CanvasRenderingContext2D, layout: LayoutResult): void {
  // Group agent positions by faction.
  const byFaction = new Map<string, { x: number; y: number }[]>();
  for (const pos of layout.agents.values()) {
    const list = byFaction.get(pos.faction);
    if (list === undefined) byFaction.set(pos.faction, [{ x: pos.x, y: pos.y }]);
    else list.push({ x: pos.x, y: pos.y });
  }
  for (const points of byFaction.values()) {
    if (points.length < 2) continue;
    // Convex-ish hull approximation: sort by angle around centroid.
    let cx = 0;
    let cy = 0;
    for (const p of points) {
      cx += p.x;
      cy += p.y;
    }
    cx /= points.length;
    cy /= points.length;
    const sorted = points
      .slice()
      .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    ctx.fillStyle = COLOR_FACTION_TINT;
    ctx.beginPath();
    sorted.forEach((p, i) => {
      // Inflate each point outward from centroid so the polygon hugs
      // the structures from below.
      const dx = p.x - cx;
      const dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const inflate = 80;
      const px = p.x + (dx / len) * inflate;
      const py = p.y + (dy / len) * inflate;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Manhattan-routed PCB trace from gateway to agent. Two segments
 * meeting at a right angle — pick the corner direction based on
 * which axis has greater separation, so the bend lands at the
 * "wider" side of the L. Glowing copper-tone via pads sit at both
 * endpoints; in-flight tasks heat the trace amber.
 */
function drawBelt(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  inFlight: number,
  buildProg: number,
): void {
  // Compute the L-shape corner: turn at whichever axis covers more
  // distance, so the bend is closer to the gateway-side and the long
  // run extends out toward the agent. This reads cleanly as "bus →
  // branch."
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const horizontalFirst = Math.abs(dx) >= Math.abs(dy);
  const corner = horizontalFirst ? { x: to.x, y: from.y } : { x: from.x, y: to.y };

  if (buildProg < 1) {
    // Animate the L-shape extending in two phases: corner first
    // (proportional to first segment), then to the agent.
    const eased = easeOutCubic(buildProg);
    const seg1Len = horizontalFirst ? Math.abs(dx) : Math.abs(dy);
    const seg2Len = horizontalFirst ? Math.abs(dy) : Math.abs(dx);
    const totalLen = seg1Len + seg2Len;
    const drawn = totalLen * eased;
    let mid: { x: number; y: number };
    let endpoint: { x: number; y: number };
    if (drawn <= seg1Len) {
      mid = from;
      const t = seg1Len === 0 ? 0 : drawn / seg1Len;
      endpoint = horizontalFirst
        ? { x: from.x + dx * t, y: from.y }
        : { x: from.x, y: from.y + dy * t };
    } else {
      mid = corner;
      const t = seg2Len === 0 ? 0 : (drawn - seg1Len) / seg2Len;
      endpoint = horizontalFirst
        ? { x: corner.x, y: corner.y + dy * t }
        : { x: corner.x + dx * t, y: corner.y };
    }
    ctx.strokeStyle = COLOR_BELT_BUILDING;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    if (mid !== from) ctx.lineTo(corner.x, corner.y);
    ctx.lineTo(endpoint.x, endpoint.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawVia(ctx, from.x, from.y, COLOR_BELT_BUILDING);
    return;
  }

  // Steady-state PCB trace — copper-tone idle, amber when in-flight.
  const traceColor = inFlight > 0 ? COLOR_BELT_HOT : COLOR_BELT;
  ctx.strokeStyle = traceColor;
  ctx.lineWidth = inFlight > 0 ? 1.75 : 1.25;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(corner.x, corner.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  // Via pads: small glowing circles at both endpoints + the bend.
  drawVia(ctx, from.x, from.y, traceColor);
  drawVia(ctx, corner.x, corner.y, traceColor);
  drawVia(ctx, to.x, to.y, traceColor);
}

/** PCB via — small pad with a brighter center dot. */
function drawVia(ctx: CanvasRenderingContext2D, x: number, y: number, ringColor: string): void {
  ctx.fillStyle = ringColor;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a2336';
  ctx.beginPath();
  ctx.arc(x, y, 1, 0, Math.PI * 2);
  ctx.fill();
}

interface AgentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawAgentBuilding(
  ctx: CanvasRenderingContext2D,
  pos: { x: number; y: number },
  name: string,
  modelLabel: string,
  inFlight: number,
  failed: number,
  selected: boolean,
  buildProg: number,
  nowMs: number,
  namespace: string,
  tools: readonly string[] | undefined,
): AgentRect {
  // Spire color signals phase: red on recent failures, amber when busy,
  // cyan when idle. Drives the top-most voxel of the structure.
  const spireColor =
    failed > 0 ? COLOR_AGENT_BORDER_FAILED : inFlight > 0 ? COLOR_AGENT_BORDER_BUSY : '#22d3ee';

  // Per-namespace faction color for the body voxels — muted industrial
  // palette per voxel.ts. Distinguishing between agents in the same
  // faction comes from the SHAPE variant (orchestrator twin-tower /
  // fabricator smokestack / default ziggurat) rather than color alone.
  const body = factionColor(namespace);
  const shape = agentShapeForRole(body, tools);

  // Center the voxel structure on (pos.x, pos.y). Voxel rises from
  // ground upward; we want pos.y to be the BASE of the structure
  // (z=0 footprint plane) so labels can sit underneath.
  const cx = pos.x;
  const cy = pos.y + 6; // small downward bias so the structure sits centered visually

  // Early construction phase (p < 0.06): cyan placement marker only.
  if (buildProg < 0.06) {
    drawPlacementMarker(ctx, cx, cy, shape.footprint.w, shape.footprint.d, nowMs);
    const bounds = shapeScreenBounds(shape, cx, cy);
    return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
  }

  // Hazard-stripe ring on the ground. Drawn BEFORE the voxel structure
  // so the building sits on top of it. RA2 War Factory / Construction
  // Yard ground markings.
  if (buildProg >= 0.3) {
    drawHazardRing(ctx, cx, cy, shape.footprint.w, shape.footprint.d);
  }

  // Voxel rise — the shape function filters voxels by build height.
  drawVoxelShape(ctx, shape, {
    cx,
    cy,
    buildProgress: buildProg,
    spireColor,
    selected,
    busyPulse: buildProg >= 1 ? inFlight : 0,
    nowMs,
  });

  // Construction-phase progress label below the structure.
  const bounds = shapeScreenBounds(shape, cx, cy);
  if (buildProg < 1) {
    ctx.fillStyle = '#22d3ee';
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`▣ ${String(Math.round(buildProg * 100))}%`, cx, bounds.y + bounds.h + 14);
    return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
  }

  // Steady-state name plate beneath the structure.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR_AGENT_TEXT;
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(truncate(name, 18), cx, bounds.y + bounds.h + 4);
  ctx.fillStyle = COLOR_AGENT_SUB;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(truncate(shortenModel(modelLabel), 22), cx, bounds.y + bounds.h + 18);

  // In-flight count badge floats above the spire.
  if (inFlight > 0) {
    const above = bounds.y - 8;
    ctx.fillStyle = COLOR_AGENT_BORDER_BUSY;
    ctx.beginPath();
    ctx.arc(cx, above, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b1220';
    ctx.font = '700 10px ui-sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(inFlight), cx, above);
  }

  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
}

function drawPlacementMarker(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  d: number,
  nowMs: number,
): void {
  // Pulsing iso diamond on the ground plane.
  const pulse = (Math.sin(nowMs / 140) + 1) / 2;
  ctx.strokeStyle = `rgba(34, 211, 238, ${String(0.5 + pulse * 0.4)})`;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  // Diamond corners at z=0 in voxel coords, projected manually.
  const COS30 = Math.sqrt(3) / 2;
  const SIN30 = 0.5;
  const VS = 10;
  const corners = [
    { dx: (-w / 2 - -d / 2) * VS * COS30, dy: (-w / 2 + -d / 2) * VS * SIN30 },
    { dx: (w / 2 - -d / 2) * VS * COS30, dy: (w / 2 + -d / 2) * VS * SIN30 },
    { dx: (w / 2 - d / 2) * VS * COS30, dy: (w / 2 + d / 2) * VS * SIN30 },
    { dx: (-w / 2 - d / 2) * VS * COS30, dy: (-w / 2 + d / 2) * VS * SIN30 },
  ];
  ctx.beginPath();
  ctx.moveTo(cx + corners[0]!.dx, cy + corners[0]!.dy);
  for (let i = 1; i < corners.length; i++) {
    ctx.lineTo(cx + corners[i]!.dx, cy + corners[i]!.dy);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  // Center stub.
  ctx.fillStyle = `rgba(34, 211, 238, ${String(0.4 + pulse * 0.5)})`;
  ctx.beginPath();
  ctx.arc(cx, cy, 2 + pulse * 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawGateway(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  modelCount: number,
  nowMs: number,
  selected: boolean,
  buildProg: number,
): void {
  const shape = gatewayShape();
  const cx = center.x;
  // Voxel HQ is taller than agent buildings — anchor the BASE plane
  // a touch higher than `center.y` so the structure visually centers
  // on the canvas center rather than rising entirely below it.
  const cy = center.y + 22;

  // Pulsing aura ring beneath the structure (steady-state only).
  if (buildProg >= 1) {
    const pulse = (Math.sin(nowMs / 600) + 1) / 2;
    ctx.strokeStyle = `rgba(251, 191, 36, ${String(0.15 + pulse * 0.3)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy + 4, GATEWAY_HIT_R + pulse * 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Voxel HQ.
  drawVoxelShape(ctx, shape, {
    cx,
    cy,
    buildProgress: buildProg,
    spireColor: '#fde68a',
    selected,
    busyPulse: buildProg >= 1 && modelCount > 0 ? modelCount : 0,
    nowMs,
  });

  // Label below the structure.
  const bounds = shapeScreenBounds(shape, cx, cy);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (buildProg < 1) {
    ctx.fillStyle = '#22d3ee';
    ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`▣ HQ ${String(Math.round(buildProg * 100))}%`, cx, bounds.y + bounds.h + 6);
  } else {
    ctx.fillStyle = COLOR_GATEWAY;
    ctx.font = '700 12px ui-sans-serif';
    ctx.fillText('GATEWAY', cx, bounds.y + bounds.h + 4);
    ctx.fillStyle = COLOR_AGENT_SUB;
    ctx.font = '10px ui-monospace';
    ctx.fillText(
      modelCount > 0 ? `${String(modelCount)} models` : 'no models',
      cx,
      bounds.y + bounds.h + 18,
    );
  }
}

/**
 * Compute build progress in [0, 1]. Clamps if `firstSeen` is missing
 * (defensive — return 1 so a structure that somehow lacks a first-seen
 * stamp still renders cleanly rather than getting stuck mid-build).
 */
function buildProgress(firstSeen: number | undefined, nowMs: number, durationMs: number): number {
  if (firstSeen === undefined) return 1;
  const elapsed = nowMs - firstSeen;
  if (elapsed >= durationMs) return 1;
  if (elapsed <= 0) return 0;
  return elapsed / durationMs;
}

function drawTaskUnits(
  ctx: CanvasRenderingContext2D,
  snapshot: CommandSnapshot,
  layout: LayoutResult,
  nowMs: number,
): Map<string, { x: number; y: number }> {
  const sprites = new Map<string, { x: number; y: number }>();
  for (const t of snapshot.tasks.values()) {
    const agentKey = t.targetAgent ? `${t.namespace}/${t.targetAgent}` : null;
    const pos = agentKey !== null ? layout.agents.get(agentKey) : undefined;
    if (pos === undefined) continue;

    const xy = positionForTask(t, layout.gateway, pos, nowMs);
    if (xy === null) continue;
    sprites.set(`${t.namespace}/${t.name}`, xy);

    const color = colorForPhase(t.phase);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(xy.x, xy.y, TASK_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  return sprites;
}

/**
 * Position a task sprite along the gateway↔agent belt based on phase
 * + age. Pending/Dispatched: traveling outbound from gateway → agent.
 * Completed: orbiting the agent (returning home, then idle). Failed:
 * stuck near the agent flashing.
 */
function positionForTask(
  t: TaskSummary,
  gateway: { x: number; y: number },
  agent: { x: number; y: number },
  nowMs: number,
): { x: number; y: number } | null {
  const phase = t.phase ?? 'Pending';
  const created = t.createdAt !== undefined ? Date.parse(t.createdAt) : NaN;
  const completed = t.completedAt !== undefined ? Date.parse(t.completedAt) : NaN;

  if (phase === 'Pending' || phase === 'Dispatched') {
    // Travel from gateway → agent over a 4s outbound window. After
    // arrival, hold near the agent with a small wobble (in-flight).
    const ageMs = Number.isNaN(created) ? 1500 : Math.max(0, nowMs - created);
    const TRAVEL_MS = 4_000;
    const travel = Math.min(1, ageMs / TRAVEL_MS);
    if (travel < 1) {
      const eased = easeOutCubic(travel);
      return {
        x: gateway.x + (agent.x - gateway.x) * eased,
        y: gateway.y + (agent.y - gateway.y) * eased,
      };
    }
    // Wobble at the agent.
    const wobble = Math.sin(nowMs / 200) * 6;
    return { x: agent.x + wobble, y: agent.y - 18 };
  }
  if (phase === 'Completed') {
    // Travel back from agent → gateway over 3s after completion. After
    // that, hide (the SSE stream will eventually drop the task from
    // the cache or the user will refetch).
    const since = Number.isNaN(completed) ? 0 : Math.max(0, nowMs - completed);
    const RETURN_MS = 3_000;
    if (since > RETURN_MS + 2_000) return null; // settled, don't render
    const t01 = Math.min(1, since / RETURN_MS);
    const eased = easeInOutCubic(t01);
    return {
      x: agent.x + (gateway.x - agent.x) * eased,
      y: agent.y + (gateway.y - agent.y) * eased,
    };
  }
  if (phase === 'Failed') {
    // Pulse near the agent with a red glow handled by the caller's
    // color. Position is a small jitter to sell "broken."
    const j = Math.sin(nowMs / 120) * 4;
    return { x: agent.x + j, y: agent.y - 18 - j };
  }
  return null;
}

function colorForPhase(phase: TaskSummary['phase']): string {
  switch (phase) {
    case 'Pending':
      return COLOR_TASK_PENDING;
    case 'Dispatched':
      return COLOR_TASK_DISPATCHED;
    case 'Completed':
      return COLOR_TASK_COMPLETED;
    case 'Failed':
      return COLOR_TASK_FAILED;
    default:
      return COLOR_TASK_PENDING;
  }
}

function countInFlightFor(snapshot: CommandSnapshot, agentKey: string): number {
  let n = 0;
  for (const t of snapshot.tasks.values()) {
    const k = t.targetAgent ? `${t.namespace}/${t.targetAgent}` : '';
    if (k !== agentKey) continue;
    if (t.phase === 'Pending' || t.phase === 'Dispatched') n++;
  }
  return n;
}

function countFailedRecentFor(snapshot: CommandSnapshot, agentKey: string, nowMs: number): number {
  let n = 0;
  const RECENT_MS = 60_000;
  for (const t of snapshot.tasks.values()) {
    const k = t.targetAgent ? `${t.namespace}/${t.targetAgent}` : '';
    if (k !== agentKey) continue;
    if (t.phase !== 'Failed') continue;
    const c = t.completedAt !== undefined ? Date.parse(t.completedAt) : NaN;
    if (Number.isNaN(c) || nowMs - c < RECENT_MS) n++;
  }
  return n;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Strip the LiteLLM provider prefix + cluster path so badges stay
 * legible inside the 140px-wide agent body. Examples:
 *   workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct → llama-4-scout
 *   workers-ai/@cf/meta/llama-3.3-70b-instruct        → llama-3.3-70b
 *   nemotron-3-nano:4b                                → nemotron-3-nano:4b
 */
function shortenModel(model: string): string {
  if (model === '—') return model;
  const tail = model.split('/').pop() ?? model;
  const stripped = tail.replace(/-instruct$/, '').replace(/-\d+b-\d+e$/, '');
  return stripped;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
