/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Canvas 2D scene renderer for the Command view.
 *
 * The renderer is a plain function — it takes the latest snapshot +
 * canvas context + frame timestamp and paints the scene. No scene
 * graph; we redraw every frame because the scene size is small
 * (dozens of structures + units) and 2D canvas at 60fps handles this
 * trivially.
 *
 * Visual language is deliberately Total-Annihilation / Warcraft-3-shaped:
 *
 *   - Dark navy background with a faint isometric-feeling grid.
 *   - Gateway = central voxel HQ with a thick border, pulsing aura.
 *   - Agent buildings = voxel structures with hazard rings.
 *   - Faction territory = soft tinted polygon under each namespace's
 *     agents (the WC3 "minor faction" feel).
 *   - Tasks = small colored sprites that travel along belts. Phase
 *     drives sprite color (Pending=blue, Dispatched=yellow, Completed=
 *     green, Failed=red).
 *   - Build queue stacks: ghost diamonds above each agent show count
 *     of in-flight tasks beyond the wobbling primary sprite.
 *   - FX layer: smoke pillars / shockwaves / cheer sparks for events.
 *   - Hit-test rectangles per agent + the gateway are tracked separately
 *     so click handlers can resolve a click to a structure. Hit map
 *     is in WORLD coordinates — caller must invert the camera transform
 *     before comparing.
 */

import type { CommandSnapshot } from './state.js';
import type { LayoutResult } from './layout.js';
import type { TaskSummary } from '../types.js';
import type { Camera } from './camera.js';
import { drawFx, drawFxScreen, type Fx } from './fx.js';
import {
  agentShapeForRole,
  drawHazardRing,
  drawVoxelShape,
  factionColor,
  gatewayShape,
  shapeScreenBounds,
} from './voxel.js';

/** Single-selection ref — used by the right-hand panel to pick what to detail. */
export interface SelectionRef {
  readonly kind: 'agent' | 'gateway' | 'task' | null;
  readonly key: string | null;
}

/**
 * Multi-selection state — the Set of selected agent keys (+ optional
 * `gateway`) drives canvas highlighting; the `focus` ref drives the
 * right-hand inspector panel.
 */
export interface SelectionState {
  readonly keys: ReadonlySet<string>;
  readonly focus: SelectionRef;
}

export interface HitMap {
  /** Per-agent screen-space bounds in WORLD coords (caller inverts camera). */
  readonly agentRects: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>;
  /** Gateway hit-circle in WORLD coords. */
  readonly gateway: { x: number; y: number; r: number };
  /** Task sprites currently visible in WORLD coords. */
  readonly taskSprites: ReadonlyMap<string, { x: number; y: number }>;
}

const COLOR_BG = '#070d18';
const COLOR_GRID = 'rgba(82, 200, 124, 0.07)';
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
const COLOR_QUEUE_GHOST = 'rgba(96, 165, 250, 0.55)';
const COLOR_MARQUEE_FILL = 'rgba(34, 211, 238, 0.07)';
const COLOR_MARQUEE_BORDER = 'rgba(34, 211, 238, 0.6)';

const GATEWAY_HIT_R = 70;
const TASK_R = 5;
const BUILD_MS = 1500;
const GATEWAY_BUILD_MS = 2200;

interface SceneInputs {
  readonly snapshot: CommandSnapshot;
  readonly layout: LayoutResult;
  readonly selection: SelectionState;
  readonly nowMs: number;
  readonly firstSeen: ReadonlyMap<string, number>;
  readonly camera: Camera;
  /** Canvas size in CSS pixels (NOT device pixels). */
  readonly viewport: { w: number; h: number };
  /** Active ephemeral effects. */
  readonly fx: readonly Fx[];
  /** Drag-marquee box (screen space) when active. */
  readonly marquee: { x0: number; y0: number; x1: number; y1: number } | null;
}

export function drawScene(ctx: CanvasRenderingContext2D, inputs: SceneInputs): HitMap {
  const { snapshot, layout, selection, nowMs, firstSeen, camera, viewport, fx, marquee } = inputs;

  // ── Background fill (screen space) ──
  ctx.save();
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, viewport.w, viewport.h);

  // ── Apply camera transform — everything below draws in world coords ──
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.zoom, camera.zoom);

  // Compute the visible world rect so the grid covers the full viewport
  // even when the user has panned/zoomed.
  const worldL = -camera.offsetX / camera.zoom;
  const worldT = -camera.offsetY / camera.zoom;
  const worldR = (viewport.w - camera.offsetX) / camera.zoom;
  const worldB = (viewport.h - camera.offsetY) / camera.zoom;

  drawGrid(ctx, worldL, worldT, worldR, worldB, camera.zoom);
  drawFactionTints(ctx, layout);

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
    const isSelected = selection.keys.has(pos.key);
    const rect = drawAgentBuilding(
      ctx,
      pos,
      a?.name ?? pos.key,
      a?.model ?? a?.modelClass ?? '—',
      inFlight,
      failed,
      isSelected,
      progress,
      nowMs,
      pos.faction,
      a?.tools,
    );
    agentRects.set(pos.key, rect);
  }

  // Gateway HQ.
  drawGateway(
    ctx,
    layout.gateway,
    snapshot.gatewayCapacity.length,
    nowMs,
    selection.keys.has('gateway'),
    gatewayProgress,
  );

  // Task sprites.
  const taskSprites = drawTaskUnits(ctx, snapshot, layout, nowMs);

  // Build-queue stacks: floats of ghost diamonds above busy structures.
  for (const pos of layout.agents.values()) {
    const queueDepth = countInFlightFor(snapshot, pos.key);
    if (queueDepth <= 1) continue;
    const a = snapshot.agents.get(pos.key);
    drawBuildQueueStack(
      ctx,
      pos,
      agentShapeForRole(factionColor(pos.faction), a?.tools),
      queueDepth - 1,
      nowMs,
    );
  }

  // Ephemeral world-space FX.
  drawFx(ctx, fx, nowMs, viewport, camera.zoom);

  ctx.restore();

  // ── Screen-space overlays ──
  // Edge flashes (ignore camera).
  drawFxScreen(ctx, fx, nowMs, viewport);

  // Drag-marquee selection box (always screen-space).
  if (marquee !== null) {
    const x = Math.min(marquee.x0, marquee.x1);
    const y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0);
    const h = Math.abs(marquee.y1 - marquee.y0);
    ctx.fillStyle = COLOR_MARQUEE_FILL;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLOR_MARQUEE_BORDER;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
  }

  return {
    agentRects,
    gateway: { x: layout.gateway.x, y: layout.gateway.y + 22, r: GATEWAY_HIT_R },
    taskSprites,
  };
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  l: number,
  t: number,
  r: number,
  b: number,
  zoom: number,
): void {
  // Snap range outward to nearest 100 so the grid lines look "anchored."
  const xMin = Math.floor(l / 20) * 20;
  const xMax = Math.ceil(r / 20) * 20;
  const yMin = Math.floor(t / 20) * 20;
  const yMax = Math.ceil(b / 20) * 20;

  ctx.strokeStyle = COLOR_GRID_FINE;
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  for (let x = xMin; x <= xMax; x += 20) {
    ctx.moveTo(x + 0.5, yMin);
    ctx.lineTo(x + 0.5, yMax);
  }
  for (let y = yMin; y <= yMax; y += 20) {
    ctx.moveTo(xMin, y + 0.5);
    ctx.lineTo(xMax, y + 0.5);
  }
  ctx.stroke();

  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  for (let x = xMin; x <= xMax; x += 100) {
    ctx.moveTo(x + 0.5, yMin);
    ctx.lineTo(x + 0.5, yMax);
  }
  for (let y = yMin; y <= yMax; y += 100) {
    ctx.moveTo(xMin, y + 0.5);
    ctx.lineTo(xMax, y + 0.5);
  }
  ctx.stroke();
}

function drawFactionTints(ctx: CanvasRenderingContext2D, layout: LayoutResult): void {
  const byFaction = new Map<string, { x: number; y: number }[]>();
  for (const pos of layout.agents.values()) {
    const list = byFaction.get(pos.faction);
    if (list === undefined) byFaction.set(pos.faction, [{ x: pos.x, y: pos.y }]);
    else list.push({ x: pos.x, y: pos.y });
  }
  for (const points of byFaction.values()) {
    if (points.length < 2) continue;
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

function drawBelt(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  inFlight: number,
  buildProg: number,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const horizontalFirst = Math.abs(dx) >= Math.abs(dy);
  const corner = horizontalFirst ? { x: to.x, y: from.y } : { x: from.x, y: to.y };

  if (buildProg < 1) {
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

  const traceColor = inFlight > 0 ? COLOR_BELT_HOT : COLOR_BELT;
  ctx.strokeStyle = traceColor;
  ctx.lineWidth = inFlight > 0 ? 1.75 : 1.25;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(corner.x, corner.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  drawVia(ctx, from.x, from.y, traceColor);
  drawVia(ctx, corner.x, corner.y, traceColor);
  drawVia(ctx, to.x, to.y, traceColor);
}

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
  const spireColor =
    failed > 0 ? COLOR_AGENT_BORDER_FAILED : inFlight > 0 ? COLOR_AGENT_BORDER_BUSY : '#22d3ee';
  const body = factionColor(namespace);
  const shape = agentShapeForRole(body, tools);
  const cx = pos.x;
  const cy = pos.y + 6;

  if (buildProg < 0.06) {
    drawPlacementMarker(ctx, cx, cy, shape.footprint.w, shape.footprint.d, nowMs);
    const bounds = shapeScreenBounds(shape, cx, cy);
    return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
  }

  if (buildProg >= 0.3) {
    drawHazardRing(ctx, cx, cy, shape.footprint.w, shape.footprint.d);
  }

  drawVoxelShape(ctx, shape, {
    cx,
    cy,
    buildProgress: buildProg,
    spireColor,
    selected,
    busyPulse: buildProg >= 1 ? inFlight : 0,
    nowMs,
  });

  const bounds = shapeScreenBounds(shape, cx, cy);
  if (buildProg < 1) {
    ctx.fillStyle = '#22d3ee';
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`▣ ${String(Math.round(buildProg * 100))}%`, cx, bounds.y + bounds.h + 14);
    return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR_AGENT_TEXT;
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(truncate(name, 18), cx, bounds.y + bounds.h + 4);
  ctx.fillStyle = COLOR_AGENT_SUB;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(truncate(shortenModel(modelLabel), 22), cx, bounds.y + bounds.h + 18);

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

/**
 * Render N stacked ghost diamonds above the agent's spire — visualizes
 * queue depth past the primary in-flight task. Capped at 5 visible
 * diamonds; overflow shows as "+N" text.
 */
function drawBuildQueueStack(
  ctx: CanvasRenderingContext2D,
  pos: { x: number; y: number },
  shape: ReturnType<typeof agentShapeForRole>,
  depth: number,
  nowMs: number,
): void {
  const bounds = shapeScreenBounds(shape, pos.x, pos.y + 6);
  const visible = Math.min(5, depth);
  const overflow = depth - visible;
  const baseY = bounds.y - 22;
  for (let i = 0; i < visible; i++) {
    const y = baseY - i * 9;
    const pulse = (Math.sin(nowMs / 220 + i * 0.4) + 1) / 2;
    ctx.fillStyle = `rgba(96, 165, 250, ${String((0.4 + pulse * 0.4).toFixed(2))})`;
    ctx.beginPath();
    ctx.moveTo(pos.x, y - 4);
    ctx.lineTo(pos.x + 5, y);
    ctx.lineTo(pos.x, y + 4);
    ctx.lineTo(pos.x - 5, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = COLOR_QUEUE_GHOST;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (overflow > 0) {
    const y = baseY - visible * 9 - 4;
    ctx.fillStyle = COLOR_QUEUE_GHOST;
    ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`+${String(overflow)}`, pos.x, y);
  }
}

function drawPlacementMarker(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  d: number,
  nowMs: number,
): void {
  const pulse = (Math.sin(nowMs / 140) + 1) / 2;
  ctx.strokeStyle = `rgba(34, 211, 238, ${String(0.5 + pulse * 0.4)})`;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
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
  const cy = center.y + 22;

  if (buildProg >= 1) {
    const pulse = (Math.sin(nowMs / 600) + 1) / 2;
    ctx.strokeStyle = `rgba(251, 191, 36, ${String(0.15 + pulse * 0.3)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy + 4, GATEWAY_HIT_R + pulse * 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawVoxelShape(ctx, shape, {
    cx,
    cy,
    buildProgress: buildProg,
    spireColor: '#fde68a',
    selected,
    busyPulse: buildProg >= 1 && modelCount > 0 ? modelCount : 0,
    nowMs,
  });

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
    const wobble = Math.sin(nowMs / 200) * 6;
    return { x: agent.x + wobble, y: agent.y - 18 };
  }
  if (phase === 'Completed') {
    const since = Number.isNaN(completed) ? 0 : Math.max(0, nowMs - completed);
    const RETURN_MS = 3_000;
    if (since > RETURN_MS + 2_000) return null;
    const t01 = Math.min(1, since / RETURN_MS);
    const eased = easeInOutCubic(t01);
    return {
      x: agent.x + (gateway.x - agent.x) * eased,
      y: agent.y + (gateway.y - agent.y) * eased,
    };
  }
  if (phase === 'Failed') {
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
