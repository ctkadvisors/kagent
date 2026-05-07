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

const COLOR_BG = '#08111f';
const COLOR_GRID = 'rgba(82, 124, 188, 0.08)';
const COLOR_GATEWAY = '#fbbf24';
const COLOR_GATEWAY_FILL = '#1e293b';
const COLOR_BELT = 'rgba(148, 163, 184, 0.18)';
const COLOR_BELT_HOT = 'rgba(251, 191, 36, 0.45)';
const COLOR_AGENT_FILL = '#0f1f3a';
const COLOR_AGENT_BORDER = '#3b82f6';
const COLOR_AGENT_BORDER_BUSY = '#fbbf24';
const COLOR_AGENT_BORDER_FAILED = '#ef4444';
const COLOR_AGENT_TEXT = '#e2e8f0';
const COLOR_AGENT_SUB = '#94a3b8';
const COLOR_FACTION_TINT = 'rgba(59, 130, 246, 0.04)';
const COLOR_TASK_PENDING = '#60a5fa';
const COLOR_TASK_DISPATCHED = '#fbbf24';
const COLOR_TASK_COMPLETED = '#34d399';
const COLOR_TASK_FAILED = '#f87171';
const COLOR_SELECT_RING = '#22d3ee';

const AGENT_W = 140;
const AGENT_H = 56;
const GATEWAY_R = 48;
const TASK_R = 5;

interface SceneInputs {
  readonly snapshot: CommandSnapshot;
  readonly layout: LayoutResult;
  readonly selection: SelectionRef;
  readonly nowMs: number;
}

export function drawScene(ctx: CanvasRenderingContext2D, inputs: SceneInputs): HitMap {
  const { width, height } = ctx.canvas;
  const { snapshot, layout, selection, nowMs } = inputs;

  // Background + grid.
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height);

  // Faction tint — a soft polygon hugging each namespace's agents.
  drawFactionTints(ctx, layout);

  // Belts (gateway → each agent), drawn first so structures sit on top.
  for (const pos of layout.agents.values()) {
    const inFlight = countInFlightFor(snapshot, pos.key);
    drawBelt(ctx, layout.gateway, pos, inFlight);
  }

  // Agent structures.
  const agentRects = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const pos of layout.agents.values()) {
    const a = snapshot.agents.get(pos.key);
    const inFlight = countInFlightFor(snapshot, pos.key);
    const failed = countFailedRecentFor(snapshot, pos.key, nowMs);
    const rect = drawAgentBuilding(
      ctx,
      pos,
      a?.name ?? pos.key,
      a?.model ?? a?.modelClass ?? '—',
      inFlight,
      failed,
      selection.kind === 'agent' && selection.key === pos.key,
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
  );

  // Task units travel on belts.
  const taskSprites = drawTaskUnits(ctx, snapshot, layout, nowMs);

  return {
    agentRects,
    gateway: { x: layout.gateway.x, y: layout.gateway.y, r: GATEWAY_R },
    taskSprites,
  };
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 40;
  for (let x = 0; x <= w; x += step) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += step) {
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

function drawBelt(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  inFlight: number,
): void {
  ctx.strokeStyle = inFlight > 0 ? COLOR_BELT_HOT : COLOR_BELT;
  ctx.lineWidth = inFlight > 0 ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
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
): AgentRect {
  const rx = pos.x - AGENT_W / 2;
  const ry = pos.y - AGENT_H / 2;

  // Drop shadow plate.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  roundRect(ctx, rx + 3, ry + 3, AGENT_W, AGENT_H, 6);
  ctx.fill();

  // Body.
  ctx.fillStyle = COLOR_AGENT_FILL;
  roundRect(ctx, rx, ry, AGENT_W, AGENT_H, 6);
  ctx.fill();

  // Border — color tracks load.
  let borderColor = COLOR_AGENT_BORDER;
  if (failed > 0) borderColor = COLOR_AGENT_BORDER_FAILED;
  else if (inFlight > 0) borderColor = COLOR_AGENT_BORDER_BUSY;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = selected ? 3 : 2;
  roundRect(ctx, rx, ry, AGENT_W, AGENT_H, 6);
  ctx.stroke();

  // Selection ring.
  if (selected) {
    ctx.strokeStyle = COLOR_SELECT_RING;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    roundRect(ctx, rx - 4, ry - 4, AGENT_W + 8, AGENT_H + 8, 8);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Name (top line).
  ctx.fillStyle = COLOR_AGENT_TEXT;
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(truncate(name, 18), rx + 10, ry + 8);

  // Model badge (bottom line).
  ctx.fillStyle = COLOR_AGENT_SUB;
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(truncate(shortenModel(modelLabel), 22), rx + 10, ry + 26);

  // In-flight badge top-right.
  if (inFlight > 0) {
    ctx.fillStyle = COLOR_AGENT_BORDER_BUSY;
    ctx.beginPath();
    ctx.arc(rx + AGENT_W - 12, ry + 12, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b1220';
    ctx.font = '700 9px ui-sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(inFlight), rx + AGENT_W - 12, ry + 9);
  }

  return { x: rx, y: ry, w: AGENT_W, h: AGENT_H };
}

function drawGateway(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  modelCount: number,
  nowMs: number,
  selected: boolean,
): void {
  const r = GATEWAY_R;
  // Pulsing accent ring.
  const pulse = (Math.sin(nowMs / 600) + 1) / 2;
  ctx.strokeStyle = `rgba(251, 191, 36, ${String(0.15 + pulse * 0.25)})`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(center.x, center.y, r + 12 + pulse * 4, 0, Math.PI * 2);
  ctx.stroke();

  // Hexagon body.
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = center.x + Math.cos(a) * r;
    const py = center.y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = COLOR_GATEWAY_FILL;
  ctx.fill();
  ctx.strokeStyle = selected ? COLOR_SELECT_RING : COLOR_GATEWAY;
  ctx.lineWidth = selected ? 3 : 2;
  ctx.stroke();

  // Label.
  ctx.fillStyle = COLOR_GATEWAY;
  ctx.font = '700 12px ui-sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('GATEWAY', center.x, center.y - 6);
  ctx.fillStyle = COLOR_AGENT_SUB;
  ctx.font = '10px ui-monospace';
  ctx.fillText(
    modelCount > 0 ? `${String(modelCount)} models` : 'no models',
    center.x,
    center.y + 10,
  );
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

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
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
