/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * CommandView — RTS-style command center for the Workbench.
 *
 * Camera, sound, selection grammar, and threats-as-canvas-events make
 * the surface feel like a game instead of a dashboard. Wired against
 * the real workbench-api: agents come from /api/agents, tasks from
 * /api/tasks, gateway from /api/gateway/*, lifecycle from SSE.
 *
 * Hotkey grammar (held over from RTS muscle memory):
 *
 *   WASD / arrows   pan camera (edge-scroll also works)
 *   wheel           zoom around cursor
 *   Space           recenter on Gateway HQ
 *   F5–F8           save/load camera bookmark (Shift to save)
 *   click           select (Shift = add/remove from selection)
 *   drag            marquee multi-select
 *   right-click     dispatch task to selection (or quick-select target)
 *   Ctrl+1..9       bind selection as control group
 *   1..9            recall control group
 *   N               cycle next idle agent
 *   Tab             cycle through current selection
 *   Esc             clear selection / cancel popover
 *   M               toggle audio
 *   ?               toggle hotkey hint overlay
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createTask, CreateTaskApiError } from './api.js';
import { computeLayout } from './command/layout.js';
import type { AgentNode, LayoutResult } from './command/layout.js';
import {
  applyBookmark,
  centerOnWorld,
  easeCameraTo,
  makeCamera,
  panFromEdge,
  panFromKeys,
  resetCamera,
  screenToWorld,
  snapshotBookmark,
  tickTween,
  ZOOM_STEP,
  zoomAt,
  type Camera,
} from './command/camera.js';
import { FxLayer } from './command/fx.js';
import { Minimap } from './command/Minimap.js';
import { drawScene, type SelectionRef, type SelectionState } from './command/scene.js';
import type { HitMap } from './command/scene.js';
import { sound } from './command/sound.js';
import { DRAG_ACTIVATE_PX, makeInputState } from './command/input.js';
import type { InputState } from './command/input.js';
import { useCommandSnapshot } from './command/state.js';
import { factionColor } from './command/voxel.js';
import type { ActivityEvent } from './command/state.js';
import type { AgentSummaryRow, TaskSummary } from './types.js';
import styles from './CommandView.module.css';

interface CommandViewProps {
  readonly onBack: () => void;
}

interface DispatchPopover {
  readonly screenX: number;
  readonly screenY: number;
  readonly targetAgents: readonly string[]; // ns/name keys
  readonly defaultPrompt: string;
}

export function CommandView({ onBack }: CommandViewProps): React.JSX.Element {
  const snapshot = useCommandSnapshot();
  const [selection, setSelection] = useState<SelectionState>({
    keys: new Set<string>(),
    focus: { kind: null, key: null },
  });
  const [popover, setPopover] = useState<DispatchPopover | null>(null);
  const [alertText, setAlertText] = useState<string | null>(null);
  const [muted, setMuted] = useState<boolean>(false);
  const [hintsOpen, setHintsOpen] = useState<boolean>(false);
  // Wrapper size in CSS px — driven by fitCanvas() inside the RAF loop;
  // updated only on resize so we don't churn React every frame. The
  // Minimap consumes this to draw the camera-viewport rect at correct
  // proportions.
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 });
  // Bumped from any imperative camera/input mutation that needs the
  // top HUD (e.g. Selected count) to redraw immediately.
  const [, forceRender] = useState<number>(0);
  const bump = useCallback(() => forceRender((n) => n + 1), []);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hitMapRef = useRef<HitMap | null>(null);
  const layoutRef = useRef<LayoutResult | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameMsRef = useRef<number>(0);

  const cameraRef = useRef<Camera>(makeCamera());
  const inputRef = useRef<InputState>(makeInputState());
  const fxRef = useRef<FxLayer>(new FxLayer());
  const seenEventsRef = useRef<Set<string>>(new Set());
  const lastKlaxonAtRef = useRef<number>(0);
  const recentFailuresRef = useRef<number[]>([]); // wallclock ms of recent Failed events
  // Atmospheric particle scheduling — last-emit timestamps per source.
  const lastGatewaySteamMsRef = useRef<number>(0);
  const lastAgentSmokeMsRef = useRef<Map<string, number>>(new Map());
  // Recent in-flight count, refreshed each frame so the gateway-steam
  // emit rate scales with live cluster load.
  const liveInFlightRef = useRef<number>(0);

  // Per-key first-seen wallclock — drives the build-out animation.
  const firstSeenRef = useRef<Map<string, number>>(new Map());
  const mountAtRef = useRef<number>(Date.now());
  const initialStaggerDoneRef = useRef<boolean>(false);

  // Stable agent-node list for layout (agents + tasks-targeting-missing-agents).
  const agentNodes = useMemo<readonly AgentNode[]>(() => {
    const map = new Map<string, AgentNode>();
    for (const a of snapshot.agents.values()) {
      const key = `${a.namespace}/${a.name}`;
      map.set(key, {
        key,
        namespace: a.namespace,
        name: a.name,
        ...(a.model !== undefined && { model: a.model }),
        ...(a.modelClass !== undefined && { modelClass: a.modelClass }),
        ...(a.tools !== undefined && { tools: a.tools }),
      });
    }
    for (const t of snapshot.tasks.values()) {
      if (t.targetAgent === undefined) continue;
      const key = `${t.namespace}/${t.targetAgent}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          namespace: t.namespace,
          name: t.targetAgent,
          ...(t.model !== undefined && { model: t.model }),
        });
      }
    }
    return Array.from(map.values());
  }, [snapshot.agents, snapshot.tasks]);

  // ───────────────────────── RAF render loop ─────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (canvas === null || wrapper === null) return;

    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    let lastBoundsKey = '';
    let lastNodeKey = '';

    let lastViewportW = 0;
    let lastViewportH = 0;
    const fitCanvas = (): { w: number; h: number } => {
      const rect = wrapper.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(640, Math.floor(rect.width));
      const h = Math.max(360, Math.floor(rect.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${String(w)}px`;
        canvas.style.height = `${String(h)}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      // Push viewport size to React state ONLY when it changes — keeps
      // the Minimap re-rendering in sync with resizes without churning
      // a setState per frame.
      if (w !== lastViewportW || h !== lastViewportH) {
        lastViewportW = w;
        lastViewportH = h;
        setViewportSize({ w, h });
      }
      return { w, h };
    };

    const tick = (): void => {
      const now = Date.now();
      const dt = lastFrameMsRef.current === 0 ? 0 : (now - lastFrameMsRef.current) / 1000;
      lastFrameMsRef.current = now;

      const { w, h } = fitCanvas();

      // Tween advance first — user input below cancels the tween if
      // it's active, so direct pan/zoom always wins.
      tickTween(cameraRef.current, now);

      // Pan camera from held keys + edge-scroll.
      panFromKeys(cameraRef.current, inputRef.current.keys, dt);
      const m = inputRef.current.mouse;
      panFromEdge(
        cameraRef.current,
        { x: m.x, y: m.y, insideViewport: m.inside },
        { w, h },
        dt,
      );

      // Recompute layout when bounds or agent set changes.
      const boundsKey = `${String(w)}x${String(h)}`;
      const nodeKey = agentNodes
        .map((n) => n.key)
        .sort()
        .join(',');
      if (
        layoutRef.current === null ||
        boundsKey !== lastBoundsKey ||
        nodeKey !== lastNodeKey
      ) {
        layoutRef.current = computeLayout(agentNodes, { width: w, height: h });
        lastBoundsKey = boundsKey;
        lastNodeKey = nodeKey;
      }
      const layout = layoutRef.current;

      // Stamp build-out start times.
      const fs = firstSeenRef.current;
      if (!fs.has('gateway')) fs.set('gateway', now);
      if (!initialStaggerDoneRef.current && agentNodes.length > 0) {
        const FACTION_STEP_MS = 700;
        const NODE_STEP_MS = 140;
        const groupedByFaction = new Map<string, AgentNode[]>();
        for (const n of agentNodes) {
          const list = groupedByFaction.get(n.namespace);
          if (list === undefined) groupedByFaction.set(n.namespace, [n]);
          else list.push(n);
        }
        const factionOrder = Array.from(groupedByFaction.keys()).sort((a, b) =>
          a.localeCompare(b),
        );
        const base = mountAtRef.current + 250;
        for (let fi = 0; fi < factionOrder.length; fi++) {
          const ns = factionOrder[fi];
          if (ns === undefined) continue;
          const list = (groupedByFaction.get(ns) ?? [])
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name));
          for (let ni = 0; ni < list.length; ni++) {
            const node = list[ni];
            if (node === undefined) continue;
            if (!fs.has(node.key)) {
              fs.set(node.key, base + fi * FACTION_STEP_MS + ni * NODE_STEP_MS);
            }
          }
        }
        initialStaggerDoneRef.current = true;
      } else {
        for (const n of agentNodes) {
          if (!fs.has(n.key)) fs.set(n.key, now);
        }
      }

      // ── Live in-flight count, used by atmospherics emission rate ──
      let inFlightCount = 0;
      for (const t of snapshot.tasks.values()) {
        if (t.phase === 'Pending' || t.phase === 'Dispatched') inFlightCount++;
      }
      liveInFlightRef.current = inFlightCount;

      // ── Atmospherics ─────────────────────────────────────────────
      //
      // Gateway smokestack: emit one steam puff at an interval that
      // tightens with load. Idle = 1.4s between puffs; saturated
      // (8+ in-flight) = 280ms — feels like the gateway is "running
      // hot." Puff origin sits on top of the HQ spire.
      const stackPeriod = Math.max(280, 1400 - inFlightCount * 140);
      if (now - lastGatewaySteamMsRef.current >= stackPeriod) {
        const wobble = Math.sin(now / 600) * 4;
        fxRef.current.emit({
          kind: 'steam',
          x: layout.gateway.x + wobble,
          y: layout.gateway.y - 50, // above the HQ spire
          startedAt: now,
          durationMs: 2_400,
        });
        lastGatewaySteamMsRef.current = now;
      }

      // Persistent weak smoke on agents with active recent failures —
      // a subtle ongoing reminder long after the initial smoke pillar
      // expires. One puff per (1.5s + 0.4s × successive-failure-count)
      // until the agent settles.
      const smokeMap = lastAgentSmokeMsRef.current;
      for (const pos of layout.agents.values()) {
        let recentFailures = 0;
        for (const t of snapshot.tasks.values()) {
          const k = t.targetAgent ? `${t.namespace}/${t.targetAgent}` : '';
          if (k !== pos.key) continue;
          if (t.phase !== 'Failed') continue;
          const c = t.completedAt !== undefined ? Date.parse(t.completedAt) : NaN;
          if (!Number.isNaN(c) && now - c < 60_000) recentFailures++;
        }
        if (recentFailures === 0) continue;
        const period = Math.max(900, 1800 - recentFailures * 200);
        const last = smokeMap.get(pos.key) ?? 0;
        if (now - last >= period) {
          fxRef.current.emit({
            kind: 'steam',
            x: pos.x + (Math.random() - 0.5) * 6,
            y: pos.y - 8,
            startedAt: now,
            durationMs: 2_200,
          });
          smokeMap.set(pos.key, now);
        }
      }

      // Prune expired FX.
      fxRef.current.prune(now);

      // Marquee box (screen space).
      const drag = inputRef.current.drag;
      const marquee =
        drag !== null && drag.activated
          ? { x0: drag.startX, y0: drag.startY, x1: drag.curX, y1: drag.curY }
          : null;

      hitMapRef.current = drawScene(ctx, {
        snapshot,
        layout,
        selection,
        nowMs: now,
        firstSeen: fs,
        camera: cameraRef.current,
        viewport: { w, h },
        fx: fxRef.current.list(),
        marquee,
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const onResize = (): void => {
      lastBoundsKey = '';
    };
    window.addEventListener('resize', onResize);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
    };
  }, [agentNodes, snapshot, selection]);

  // ───────────────────────── Sound + FX from events ─────────────────────────
  useEffect(() => {
    const seen = seenEventsRef.current;
    const layout = layoutRef.current;
    const now = Date.now();

    for (let i = snapshot.events.length - 1; i >= 0; i--) {
      const ev = snapshot.events[i];
      if (ev === undefined) continue;
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);

      // Skip very-first sweep — initial backlog shouldn't shotgun-fire sounds.
      if (now - mountAtRef.current < 800) continue;

      const agentKey = ev.agent !== undefined ? deriveAgentKey(ev.taskKey, ev.agent) : null;
      const agentPos =
        agentKey !== null && layout !== null ? layout.agents.get(agentKey) : undefined;

      if (ev.phase === 'Completed') {
        sound.taskComplete();
        if (agentPos !== undefined) {
          fxRef.current.emit({
            kind: 'cheer',
            x: agentPos.x,
            y: agentPos.y - 18,
            startedAt: now,
            durationMs: 900,
          });
        }
        // Coin-sparks at the Gateway HQ — every Completed run rains
        // a few yellow particles over the spire so heavy-throughput
        // periods visibly "shower gold" at the centre of the map.
        if (layout !== null) {
          for (let i = 0; i < 4; i++) {
            fxRef.current.emit({
              kind: 'sparks',
              x: layout.gateway.x + (i - 1.5) * 6,
              y: layout.gateway.y - 30 - Math.random() * 6,
              color: '#fbbf24',
              startedAt: now + i * 60,
              durationMs: 700,
            });
          }
        }
      } else if (ev.phase === 'Failed') {
        sound.taskFailed();
        recentFailuresRef.current.push(now);
        // Keep window at 60s.
        recentFailuresRef.current = recentFailuresRef.current.filter((t) => now - t < 60_000);
        if (agentPos !== undefined) {
          fxRef.current.emit({
            kind: 'smoke',
            x: agentPos.x,
            y: agentPos.y + 8,
            startedAt: now,
            durationMs: 4_000,
          });
          fxRef.current.emit({
            kind: 'shockwave',
            x: agentPos.x,
            y: agentPos.y - 4,
            color: '#ef4444',
            startedAt: now,
            durationMs: 700,
            maxRadius: 80,
          });
        }
        // Failure cluster: 3+ failures within 30s → klaxon + edge flash
        // + auto-pan camera to the centroid of recently-failed agents
        // so the operator's eyes land on the hot zone immediately.
        const recent30s = recentFailuresRef.current.filter((t) => now - t < 30_000);
        if (recent30s.length >= 3 && now - lastKlaxonAtRef.current > 8_000) {
          sound.klaxon();
          lastKlaxonAtRef.current = now;
          fxRef.current.emit({
            kind: 'flash',
            color: '#7f1d1d',
            startedAt: now,
            durationMs: 1_400,
            intensity: 0.55,
          });
          setAlertText(`failure cluster: ${String(recent30s.length)} fails / 30s`);
          window.setTimeout(() => setAlertText(null), 4_000);
          // Compute centroid of recently-failed agent positions and
          // ease the camera there at zoom 1.4 for context-rich framing.
          if (layout !== null) {
            const wrapper = wrapperRef.current;
            const pts: { x: number; y: number }[] = [];
            for (const t of snapshot.tasks.values()) {
              if (t.phase !== 'Failed' || t.targetAgent === undefined) continue;
              const c = t.completedAt !== undefined ? Date.parse(t.completedAt) : NaN;
              if (Number.isNaN(c) || now - c >= 30_000) continue;
              const ap = layout.agents.get(`${t.namespace}/${t.targetAgent}`);
              if (ap !== undefined) pts.push({ x: ap.x, y: ap.y });
            }
            if (pts.length > 0 && wrapper !== null) {
              let cx = 0;
              let cy = 0;
              for (const p of pts) {
                cx += p.x;
                cy += p.y;
              }
              cx /= pts.length;
              cy /= pts.length;
              const rect = wrapper.getBoundingClientRect();
              const target = centerOnWorld(
                cameraRef.current,
                cx,
                cy,
                { w: rect.width, h: rect.height },
                1.4,
              );
              easeCameraTo(
                cameraRef.current,
                target.offsetX,
                target.offsetY,
                target.zoom,
                900,
                now,
              );
            }
          }
        }
      } else if (ev.phase === 'Dispatched') {
        sound.dispatch();
      }
    }
  }, [snapshot.events]);

  // ───────────────────────── Sound thrum (in-flight load) ─────────────────────────
  useEffect(() => {
    let inFlight = 0;
    for (const t of snapshot.tasks.values()) {
      if (t.phase === 'Pending' || t.phase === 'Dispatched') inFlight++;
    }
    sound.setThrum(Math.min(1, inFlight / 8));
  }, [snapshot.tasks]);

  // ───────────────────────── Agent-ready fanfare ─────────────────────────
  // Fires when an Agent CR is observed for the first time AFTER the
  // initial-stagger sweep, i.e. a real-world new admission.
  const prevAgentKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const cur = new Set<string>();
    for (const a of snapshot.agents.values()) {
      cur.add(`${a.namespace}/${a.name}`);
    }
    if (initialStaggerDoneRef.current) {
      for (const key of cur) {
        if (!prevAgentKeysRef.current.has(key)) {
          sound.agentReady();
          break; // single fanfare per tick even if multiple admit
        }
      }
    }
    prevAgentKeysRef.current = cur;
  }, [snapshot.agents]);

  // ───────────────────────── Window keyboard ─────────────────────────
  useEffect(() => {
    const isTextTarget = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        t.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTextTarget(e.target)) return;
      const k = e.key.toLowerCase();
      const keys = inputRef.current.keys;
      if (k === 'w') keys.w = true;
      else if (k === 'a') keys.a = true;
      else if (k === 's') keys.s = true;
      else if (k === 'd') keys.d = true;
      else if (e.key === 'ArrowUp') keys.up = true;
      else if (e.key === 'ArrowLeft') keys.left = true;
      else if (e.key === 'ArrowDown') keys.down = true;
      else if (e.key === 'ArrowRight') keys.right = true;
      else if (e.key === ' ') {
        sound.unlock();
        sound.click();
        resetCamera(cameraRef.current);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        if (popover !== null) {
          setPopover(null);
        } else {
          setSelection({ keys: new Set(), focus: { kind: null, key: null } });
        }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        cycleSelection();
      } else if (k === 'n') {
        e.preventDefault();
        cycleIdleAgent();
      } else if (k === 'm') {
        sound.unlock();
        const next = !muted;
        sound.setMuted(next);
        setMuted(next);
      } else if (e.key === '?') {
        setHintsOpen((v) => !v);
      } else if (e.key >= '1' && e.key <= '9') {
        const groupNum = parseInt(e.key, 10);
        sound.unlock();
        if (e.ctrlKey || e.metaKey) {
          // Bind current selection as control group.
          if (selection.keys.size > 0) {
            inputRef.current.controlGroups.set(groupNum, new Set(selection.keys));
            sound.click();
            setAlertText(`group ${e.key} bound (${String(selection.keys.size)})`);
            window.setTimeout(() => setAlertText(null), 1_400);
          }
        } else {
          // Recall control group.
          const grp = inputRef.current.controlGroups.get(groupNum);
          if (grp !== undefined) {
            sound.click();
            const next: SelectionState = {
              keys: new Set(grp),
              focus: pickFocus(grp),
            };
            setSelection(next);
          }
        }
      } else if (e.key === 'F5' || e.key === 'F6' || e.key === 'F7' || e.key === 'F8') {
        e.preventDefault();
        const slot = e.key === 'F5' ? 5 : e.key === 'F6' ? 6 : e.key === 'F7' ? 7 : 8;
        if (e.shiftKey) {
          // Save bookmark.
          inputRef.current.bookmarks.set(slot, snapshotBookmark(cameraRef.current));
          sound.click();
          setAlertText(`bookmark ${e.key} saved`);
          window.setTimeout(() => setAlertText(null), 1_400);
        } else {
          // Recall bookmark.
          const b = inputRef.current.bookmarks.get(slot);
          if (b !== undefined) {
            applyBookmark(cameraRef.current, b);
            sound.click();
          }
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (isTextTarget(e.target)) return;
      const k = e.key.toLowerCase();
      const keys = inputRef.current.keys;
      if (k === 'w') keys.w = false;
      else if (k === 'a') keys.a = false;
      else if (k === 's') keys.s = false;
      else if (k === 'd') keys.d = false;
      else if (e.key === 'ArrowUp') keys.up = false;
      else if (e.key === 'ArrowLeft') keys.left = false;
      else if (e.key === 'ArrowDown') keys.down = false;
      else if (e.key === 'ArrowRight') keys.right = false;
    };

    const onBlur = (): void => {
      // Drop all held keys when window loses focus so pan doesn't run away.
      const keys = inputRef.current.keys;
      keys.w = keys.a = keys.s = keys.d = false;
      keys.up = keys.left = keys.down = keys.right = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [popover, selection, muted]);

  // ───────────────────────── Selection helpers ─────────────────────────
  const cycleSelection = useCallback((): void => {
    const arr = Array.from(selection.keys);
    if (arr.length === 0) return;
    const focusKey = selection.focus.key;
    const idx = focusKey === null ? -1 : arr.indexOf(focusKey);
    const next = arr[(idx + 1) % arr.length];
    if (next === undefined) return;
    setSelection({
      keys: selection.keys,
      focus: { kind: next === 'gateway' ? 'gateway' : 'agent', key: next },
    });
  }, [selection]);

  const cycleIdleAgent = useCallback((): void => {
    const layout = layoutRef.current;
    if (layout === null) return;
    const idle: string[] = [];
    for (const pos of layout.agents.values()) {
      let inFlight = 0;
      for (const t of snapshot.tasks.values()) {
        const k = t.targetAgent ? `${t.namespace}/${t.targetAgent}` : '';
        if (k !== pos.key) continue;
        if (t.phase === 'Pending' || t.phase === 'Dispatched') inFlight++;
      }
      if (inFlight === 0) idle.push(pos.key);
    }
    idle.sort();
    if (idle.length === 0) {
      sound.click();
      setAlertText('no idle agents');
      window.setTimeout(() => setAlertText(null), 1_200);
      return;
    }
    const focusKey = selection.focus.key;
    const idx = focusKey === null ? -1 : idle.indexOf(focusKey);
    const next = idle[(idx + 1) % idle.length];
    if (next === undefined) return;
    sound.click();
    const pos = layout.agents.get(next);
    if (pos !== undefined) {
      // Ease camera so the agent lands near the screen centre — gives
      // the eye a satisfying glide instead of an abrupt teleport.
      const wrapper = wrapperRef.current;
      if (wrapper !== null) {
        const rect = wrapper.getBoundingClientRect();
        const target = centerOnWorld(
          cameraRef.current,
          pos.x,
          pos.y,
          { w: rect.width, h: rect.height },
        );
        easeCameraTo(
          cameraRef.current,
          target.offsetX,
          target.offsetY,
          target.zoom,
          400,
          Date.now(),
        );
      }
    }
    setSelection({
      keys: new Set([next]),
      focus: { kind: 'agent', key: next },
    });
  }, [selection, snapshot.tasks]);

  // ───────────────────────── Mouse handlers ─────────────────────────
  const canvasMouse = (e: React.MouseEvent<HTMLCanvasElement>): { sx: number; sy: number } => {
    const canvas = canvasRef.current;
    if (canvas === null) return { sx: 0, sy: 0 };
    const rect = canvas.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  const hitTestWorld = (
    wx: number,
    wy: number,
  ): { kind: 'agent' | 'gateway' | 'task'; key: string } | null => {
    const hits = hitMapRef.current;
    if (hits === null) return null;
    // Gateway first.
    const dxg = wx - hits.gateway.x;
    const dyg = wy - hits.gateway.y;
    if (Math.hypot(dxg, dyg) <= hits.gateway.r) {
      return { kind: 'gateway', key: 'gateway' };
    }
    // Tasks next (small radius — prioritize foreground sprites).
    let bestTask: { key: string; d2: number } | null = null;
    for (const [key, p] of hits.taskSprites) {
      const dx = wx - p.x;
      const dy = wy - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= 12 * 12 && (bestTask === null || d2 < bestTask.d2)) {
        bestTask = { key, d2 };
      }
    }
    if (bestTask !== null) return { kind: 'task', key: bestTask.key };
    // Agents.
    for (const [key, r] of hits.agentRects) {
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
        return { kind: 'agent', key };
      }
    }
    return null;
  };

  const onCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return; // left only
    sound.unlock();
    const { sx, sy } = canvasMouse(e);
    inputRef.current.drag = {
      startX: sx,
      startY: sy,
      curX: sx,
      curY: sy,
      activated: false,
    };
  };

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const { sx, sy } = canvasMouse(e);
    inputRef.current.mouse.x = sx;
    inputRef.current.mouse.y = sy;
    inputRef.current.mouse.inside = true;
    const drag = inputRef.current.drag;
    if (drag !== null) {
      drag.curX = sx;
      drag.curY = sy;
      if (
        !drag.activated &&
        Math.hypot(sx - drag.startX, sy - drag.startY) >= DRAG_ACTIVATE_PX
      ) {
        drag.activated = true;
      }
    }
  };

  const onCanvasMouseLeave = (): void => {
    inputRef.current.mouse.inside = false;
  };

  const onCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    const drag = inputRef.current.drag;
    inputRef.current.drag = null;
    if (drag === null) return;

    const { sx, sy } = canvasMouse(e);
    const cam = cameraRef.current;

    if (drag.activated) {
      // Marquee drag → multi-select.
      const x0 = Math.min(drag.startX, drag.curX);
      const x1 = Math.max(drag.startX, drag.curX);
      const y0 = Math.min(drag.startY, drag.curY);
      const y1 = Math.max(drag.startY, drag.curY);
      const w0 = screenToWorld(cam, x0, y0);
      const w1 = screenToWorld(cam, x1, y1);
      const hits = hitMapRef.current;
      const newKeys = new Set<string>();
      if (hits !== null) {
        for (const [key, r] of hits.agentRects) {
          // Rect-rect overlap (agentRects are in world coords).
          if (r.x + r.w >= w0.x && r.x <= w1.x && r.y + r.h >= w0.y && r.y <= w1.y) {
            newKeys.add(key);
          }
        }
      }
      const merged = e.shiftKey ? new Set([...selection.keys, ...newKeys]) : newKeys;
      sound.click();
      setSelection({
        keys: merged,
        focus: pickFocus(merged),
      });
      bump();
      return;
    }

    // Plain click → single-select (or shift-toggle).
    const wpt = screenToWorld(cam, sx, sy);
    const hit = hitTestWorld(wpt.x, wpt.y);
    sound.click();
    if (hit === null) {
      if (!e.shiftKey) {
        setSelection({ keys: new Set(), focus: { kind: null, key: null } });
      }
      return;
    }
    if (hit.kind === 'task') {
      // Task click stays single-select (no multi-task ops yet).
      setSelection({ keys: new Set(), focus: { kind: 'task', key: hit.key } });
      return;
    }
    const next = new Set(e.shiftKey ? selection.keys : new Set<string>());
    if (next.has(hit.key)) next.delete(hit.key);
    else next.add(hit.key);
    setSelection({
      keys: next,
      focus: { kind: hit.kind, key: hit.key },
    });
  };

  const onCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const { sx, sy } = canvasMouse(e);
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomAt(cameraRef.current, sx, sy, factor);
  };

  const onCanvasContextMenu = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    e.preventDefault();
    sound.unlock();
    const { sx, sy } = canvasMouse(e);
    const cam = cameraRef.current;
    const wpt = screenToWorld(cam, sx, sy);
    const hit = hitTestWorld(wpt.x, wpt.y);

    // Determine target agents: if the right-click landed on an agent,
    // include that one. Otherwise dispatch to current selection of agents.
    const sel = selection.keys;
    const targets: string[] = [];
    if (hit !== null && hit.kind === 'agent') {
      // Right-clicking an agent dispatches to it (plus any other selected).
      targets.push(hit.key);
      for (const k of sel) {
        if (k !== 'gateway' && k !== hit.key) targets.push(k);
      }
    } else if (hit !== null && hit.kind === 'gateway') {
      // Gateway click: dispatch to all selected agents.
      for (const k of sel) {
        if (k !== 'gateway') targets.push(k);
      }
    } else {
      // Empty click: dispatch to all selected agents.
      for (const k of sel) {
        if (k !== 'gateway') targets.push(k);
      }
    }
    if (targets.length === 0) {
      setAlertText('no target — select an agent first');
      window.setTimeout(() => setAlertText(null), 1_400);
      return;
    }

    sound.click();
    setPopover({
      screenX: sx,
      screenY: sy,
      targetAgents: targets,
      defaultPrompt: 'Status check.',
    });
  };

  // HUD numbers.
  const hud = useMemo(() => deriveHud(snapshot), [snapshot]);

  // Recently-failed agent keys (last 60s) for minimap red highlighting.
  const failedAgentKeys = useMemo<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    const now = Date.now();
    for (const t of snapshot.tasks.values()) {
      if (t.phase !== 'Failed' || t.targetAgent === undefined) continue;
      const c = t.completedAt !== undefined ? Date.parse(t.completedAt) : NaN;
      if (Number.isNaN(c) || now - c < 60_000) {
        out.add(`${t.namespace}/${t.targetAgent}`);
      }
    }
    return out;
  }, [snapshot.tasks]);

  // Minimap-jump handler: ease the camera so (worldX, worldY) lands
  // at the screen center.
  const jumpCameraTo = useCallback(
    (worldX: number, worldY: number): void => {
      const wrapper = wrapperRef.current;
      if (wrapper === null) return;
      const rect = wrapper.getBoundingClientRect();
      const target = centerOnWorld(
        cameraRef.current,
        worldX,
        worldY,
        { w: rect.width, h: rect.height },
      );
      easeCameraTo(
        cameraRef.current,
        target.offsetX,
        target.offsetY,
        target.zoom,
        300,
        Date.now(),
      );
    },
    [],
  );

  return (
    <div className={styles.wrapper}>
      <div className={styles.topbar}>
        <div className={styles.brand}>
          <button type="button" className={styles.backLink} onClick={onBack}>
            ← Tasks
          </button>
          <span className={styles.title}>Command Center</span>
        </div>
        <div className={styles.hud}>
          <HudTile label="In flight" value={String(hud.inFlight)} accent="busy" />
          <HudTile label="Completed (1h)" value={String(hud.completedRecent)} accent="ok" />
          <HudTile label="Failed (1h)" value={String(hud.failedRecent)} accent="bad" />
          <HudTile label="Models" value={String(hud.modelCount)} />
          <HudTile label="Tokens / min" value={hud.tokensPerMin} />
          <HudTile label="Selected" value={String(selection.keys.size)} />
        </div>
        <div className={styles.navLinks}>
          <button
            type="button"
            className={styles.navLink}
            onClick={() => {
              sound.unlock();
              const next = !muted;
              sound.setMuted(next);
              setMuted(next);
            }}
            title="M"
          >
            {muted ? '🔇 muted' : '🔊 audio'}
          </button>
          <a className={styles.navLink} href="#/gateway">
            Gateway →
          </a>
          <a className={styles.navLink} href="#/cluster">
            Cluster →
          </a>
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.sceneWrap} ref={wrapperRef}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
            onMouseLeave={onCanvasMouseLeave}
            onMouseUp={onCanvasMouseUp}
            onWheel={onCanvasWheel}
            onContextMenu={onCanvasContextMenu}
          />
          {agentNodes.length === 0 ? (
            <div className={styles.emptyOverlay}>No agents observed yet.</div>
          ) : null}

          {alertText !== null ? (
            <div className={styles.alertTicker}>
              <span className={styles.alertDot} /> {alertText}
            </div>
          ) : null}

          <div className={styles.hotkeyStrip}>
            <kbd>WASD</kbd>pan
            <kbd>wheel</kbd>zoom
            <kbd>space</kbd>recenter
            <kbd>drag</kbd>marquee
            <kbd>rclick</kbd>dispatch
            <kbd>N</kbd>idle
            <kbd>?</kbd>more
          </div>

          {hintsOpen ? <HotkeyOverlay onClose={() => setHintsOpen(false)} /> : null}

          {popover !== null ? (
            <DispatchPopoverView
              popover={popover}
              snapshot={snapshot}
              onClose={() => setPopover(null)}
              onDispatch={(prompt) => {
                void dispatchToTargets(popover.targetAgents, prompt, snapshot.agents).then(
                  (result) => {
                    setPopover(null);
                    if (result.failures.length === 0) {
                      sound.dispatch();
                      setAlertText(
                        `${String(result.successes)} ${
                          result.successes === 1 ? 'task' : 'tasks'
                        } dispatched`,
                      );
                    } else {
                      sound.taskFailed();
                      setAlertText(
                        `dispatch: ${String(result.successes)} ok / ${String(
                          result.failures.length,
                        )} failed — ${String(result.failures[0])}`,
                      );
                    }
                    window.setTimeout(() => setAlertText(null), 4_000);
                  },
                );
              }}
            />
          ) : null}

          <Minimap
            layout={layoutRef.current}
            camera={cameraRef.current}
            viewport={viewportSize}
            failedAgents={failedAgentKeys}
            onJumpTo={jumpCameraTo}
          />
        </div>

        <SelectionPanel
          snapshot={snapshot}
          selectionState={selection}
          onFocusKey={(key) => {
            setSelection({
              keys: selection.keys,
              focus: { kind: key === 'gateway' ? 'gateway' : 'agent', key },
            });
          }}
        />
      </div>

      <ActivityLog events={snapshot.events} error={snapshot.error} />
    </div>
  );
}

function pickFocus(keys: ReadonlySet<string>): SelectionRef {
  if (keys.size === 0) return { kind: null, key: null };
  const first = keys.values().next().value;
  if (first === undefined) return { kind: null, key: null };
  return {
    kind: first === 'gateway' ? 'gateway' : 'agent',
    key: first,
  };
}

function deriveAgentKey(taskKey: string, agentName: string): string {
  // taskKey is `${ns}/${name}`; agent lives in the same ns.
  const ns = taskKey.split('/')[0] ?? 'default';
  return `${ns}/${agentName}`;
}

interface DispatchResult {
  successes: number;
  failures: string[];
}

async function dispatchToTargets(
  targetKeys: readonly string[],
  prompt: string,
  agents: ReadonlyMap<string, AgentSummaryRow>,
): Promise<DispatchResult> {
  const out: DispatchResult = { successes: 0, failures: [] };
  await Promise.all(
    targetKeys.map(async (key) => {
      const a = agents.get(key);
      const [ns, name] = splitKey(key);
      const targetAgent = a?.name ?? name;
      const namespace = a?.namespace ?? ns;
      try {
        await createTask({
          targetAgent,
          namespace,
          originalUserMessage: prompt,
        });
        out.successes++;
      } catch (err) {
        const msg =
          err instanceof CreateTaskApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        out.failures.push(msg);
      }
    }),
  );
  return out;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('/');
  if (i < 0) return ['default', key];
  return [key.slice(0, i), key.slice(i + 1)];
}

interface HudTileProps {
  readonly label: string;
  readonly value: string;
  readonly accent?: 'ok' | 'bad' | 'busy';
}

function HudTile({ label, value, accent }: HudTileProps): React.JSX.Element {
  const cls =
    accent === 'ok'
      ? styles.hudTileOk
      : accent === 'bad'
        ? styles.hudTileBad
        : accent === 'busy'
          ? styles.hudTileBusy
          : styles.hudTile;
  return (
    <div className={cls}>
      <div className={styles.hudValue}>{value}</div>
      <div className={styles.hudLabel}>{label}</div>
    </div>
  );
}

interface DerivedHud {
  readonly inFlight: number;
  readonly completedRecent: number;
  readonly failedRecent: number;
  readonly modelCount: number;
  readonly tokensPerMin: string;
  readonly callsPerMin: string;
}

function deriveHud(snapshot: ReturnType<typeof useCommandSnapshot>): DerivedHud {
  const now = Date.now();
  const RECENT_MS = 60 * 60 * 1000;
  let inFlight = 0;
  let completedRecent = 0;
  let failedRecent = 0;
  for (const t of snapshot.tasks.values()) {
    if (t.phase === 'Pending' || t.phase === 'Dispatched') inFlight++;
    const c = t.completedAt !== undefined ? Date.parse(t.completedAt) : NaN;
    if (!Number.isNaN(c) && now - c <= RECENT_MS) {
      if (t.phase === 'Completed') completedRecent++;
      if (t.phase === 'Failed') failedRecent++;
    }
  }
  let calls = 0;
  let tokens = 0;
  const WINDOW_MS = 60_000;
  for (const u of snapshot.gatewayUsage) {
    const at = u.occurredAt !== undefined ? Date.parse(u.occurredAt) : NaN;
    if (Number.isNaN(at) || now - at > WINDOW_MS) continue;
    calls += 1;
    tokens += (u.inputTokens || 0) + (u.outputTokens || 0);
  }
  return {
    inFlight,
    completedRecent,
    failedRecent,
    modelCount: snapshot.gatewayCapacity.length,
    tokensPerMin: tokens > 0 ? compactNumber(tokens) : '0',
    callsPerMin: String(calls),
  };
}

function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

interface SelectionPanelProps {
  readonly snapshot: ReturnType<typeof useCommandSnapshot>;
  readonly selectionState: SelectionState;
  readonly onFocusKey: (key: string) => void;
}

function SelectionPanel({
  snapshot,
  selectionState,
  onFocusKey,
}: SelectionPanelProps): React.JSX.Element {
  const selection = selectionState.focus;
  const multi = selectionState.keys.size > 1;

  if (multi) {
    return (
      <MultiSelectPanel
        snapshot={snapshot}
        selectedKeys={selectionState.keys}
        focusKey={selection.key}
        onFocusKey={onFocusKey}
      />
    );
  }

  if (selection.kind === null) {
    return (
      <aside className={styles.panel}>
        <div className={styles.panelEmpty}>
          <strong>Select a structure</strong>
          <p>
            Click a building, drag a marquee for multi-select, right-click to dispatch a task.
            Press <kbd>?</kbd> for the full hotkey grammar.
          </p>
        </div>
      </aside>
    );
  }
  if (selection.kind === 'gateway') {
    return (
      <aside className={styles.panel}>
        <h2 className={styles.panelTitle}>Gateway HQ</h2>
        <div className={styles.panelSub}>{snapshot.gatewayCapacity.length} ModelEndpoints</div>
        <ul className={styles.panelList}>
          {snapshot.gatewayCapacity.map((row) => {
            const pct = row.currentCap > 0 ? row.inFlight / row.currentCap : 0;
            return (
              <li key={row.endpoint} className={styles.panelRow}>
                <div className={styles.panelRowLabel}>{row.model}</div>
                <div className={styles.panelRowMeta}>
                  {row.inFlight} / {row.currentCap} in flight
                </div>
                <div className={styles.gauge}>
                  <div
                    className={styles.gaugeFill}
                    style={{
                      width: `${String(Math.round(Math.min(1, pct) * 100))}%`,
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </aside>
    );
  }
  if (selection.kind === 'agent' && selection.key !== null) {
    return <AgentPanel snapshot={snapshot} agentKey={selection.key} />;
  }
  if (selection.kind === 'task' && selection.key !== null) {
    return <TaskPanel snapshot={snapshot} taskKey={selection.key} />;
  }
  return <aside className={styles.panel} />;
}

/**
 * Right-panel render when 2+ structures are selected. Shows a portrait
 * grid: one tile per agent, faction-colored, initial as glyph, with the
 * focused tile highlighted. Click a tile to refocus the inspector.
 * Per-tile mini stats: in-flight count + recent failure count from
 * snapshot.tasks (no extra fetches).
 */
function MultiSelectPanel({
  snapshot,
  selectedKeys,
  focusKey,
  onFocusKey,
}: {
  readonly snapshot: ReturnType<typeof useCommandSnapshot>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly focusKey: string | null;
  readonly onFocusKey: (key: string) => void;
}): React.JSX.Element {
  const now = Date.now();
  const sortedKeys = Array.from(selectedKeys).sort();
  const tiles = sortedKeys.map((key) => {
    const a = snapshot.agents.get(key);
    let inFlight = 0;
    let failedRecent = 0;
    for (const t of snapshot.tasks.values()) {
      const k = t.targetAgent ? `${t.namespace}/${t.targetAgent}` : '';
      if (k !== key) continue;
      if (t.phase === 'Pending' || t.phase === 'Dispatched') inFlight++;
      if (t.phase === 'Failed') {
        const c = t.completedAt !== undefined ? Date.parse(t.completedAt) : NaN;
        if (Number.isNaN(c) || now - c < 60_000) failedRecent++;
      }
    }
    const display = a?.name ?? key.split('/')[1] ?? key;
    const ns = a?.namespace ?? key.split('/')[0] ?? '';
    return { key, display, ns, inFlight, failedRecent };
  });
  const totalInFlight = tiles.reduce((n, t) => n + t.inFlight, 0);
  const totalFailed = tiles.reduce((n, t) => n + t.failedRecent, 0);

  return (
    <aside className={styles.panel}>
      <h2 className={styles.panelTitle}>Selected ({selectedKeys.size})</h2>
      <div className={styles.panelSub}>
        {totalInFlight} in flight · {totalFailed} failed (1m)
      </div>
      <div className={styles.portraitGrid}>
        {tiles.map((t) => {
          const focused = t.key === focusKey;
          const cls = focused ? styles.portraitFocused : styles.portrait;
          const initial = (t.display[0] ?? '?').toUpperCase();
          return (
            <button
              key={t.key}
              type="button"
              className={cls}
              onClick={() => onFocusKey(t.key)}
              title={`${t.display} · ${t.ns}`}
            >
              <span
                className={styles.portraitGlyph}
                style={{ backgroundColor: factionColor(t.ns) }}
              >
                {initial}
              </span>
              <span className={styles.portraitName}>{t.display}</span>
              <span className={styles.portraitMeta}>
                {t.inFlight > 0 ? <span className={styles.portraitBusy}>●{t.inFlight}</span> : null}
                {t.failedRecent > 0 ? (
                  <span className={styles.portraitFailed}>✕{t.failedRecent}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className={styles.panelHint}>
        Right-click anywhere on the canvas to dispatch the same prompt to all selected.
        Click a portrait above to focus a single agent.
      </div>
    </aside>
  );
}

function AgentPanel({
  snapshot,
  agentKey,
}: {
  readonly snapshot: ReturnType<typeof useCommandSnapshot>;
  readonly agentKey: string;
}): React.JSX.Element {
  const a: AgentSummaryRow | undefined = snapshot.agents.get(agentKey);
  const inFlight: TaskSummary[] = [];
  const recent: TaskSummary[] = [];
  for (const t of snapshot.tasks.values()) {
    const k = t.targetAgent ? `${t.namespace}/${t.targetAgent}` : '';
    if (k !== agentKey) continue;
    if (t.phase === 'Pending' || t.phase === 'Dispatched') inFlight.push(t);
    else recent.push(t);
  }
  recent.sort((x, y) => Date.parse(y.completedAt ?? '') - Date.parse(x.completedAt ?? ''));

  return (
    <aside className={styles.panel}>
      <h2 className={styles.panelTitle}>{a?.name ?? agentKey}</h2>
      <div className={styles.panelSub}>{a?.namespace ?? agentKey.split('/')[0]}</div>
      <div className={styles.panelKv}>
        <span>Model</span>
        <span>{a?.model ?? a?.modelClass ?? '—'}</span>
      </div>
      {a?.tools && a.tools.length > 0 ? (
        <div className={styles.panelKv}>
          <span>Tools</span>
          <span>{a.tools.join(', ')}</span>
        </div>
      ) : null}
      <h3 className={styles.panelHeading}>In flight ({inFlight.length})</h3>
      {inFlight.length === 0 ? (
        <div className={styles.panelEmpty2}>idle</div>
      ) : (
        <ul className={styles.panelList}>
          {inFlight.map((t) => (
            <li key={`${t.namespace}/${t.name}`} className={styles.panelRow}>
              <a
                className={styles.taskLink}
                href={`#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`}
              >
                {t.name}
              </a>
              <div className={styles.panelRowMeta}>{t.phase ?? '?'}</div>
            </li>
          ))}
        </ul>
      )}
      <h3 className={styles.panelHeading}>Recent ({Math.min(recent.length, 5)})</h3>
      <ul className={styles.panelList}>
        {recent.slice(0, 5).map((t) => (
          <li key={`${t.namespace}/${t.name}`} className={styles.panelRow}>
            <a
              className={styles.taskLink}
              href={`#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`}
            >
              {t.name}
            </a>
            <div className={styles.panelRowMeta}>
              <span className={phaseClass(t.phase)}>{t.phase ?? '?'}</span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function TaskPanel({
  snapshot,
  taskKey,
}: {
  readonly snapshot: ReturnType<typeof useCommandSnapshot>;
  readonly taskKey: string;
}): React.JSX.Element {
  const t = snapshot.tasks.get(taskKey);
  if (t === undefined) {
    return (
      <aside className={styles.panel}>
        <div className={styles.panelEmpty}>Task not in cache.</div>
      </aside>
    );
  }
  return (
    <aside className={styles.panel}>
      <h2 className={styles.panelTitle}>{t.name}</h2>
      <div className={styles.panelSub}>{t.namespace}</div>
      <div className={styles.panelKv}>
        <span>Phase</span>
        <span className={phaseClass(t.phase)}>{t.phase ?? '?'}</span>
      </div>
      <div className={styles.panelKv}>
        <span>Agent</span>
        <span>{t.targetAgent ?? '—'}</span>
      </div>
      <div className={styles.panelKv}>
        <span>Model</span>
        <span>{t.model ?? '—'}</span>
      </div>
      {t.error !== undefined ? (
        <div className={styles.panelError}>error: {t.error}</div>
      ) : null}
      <a
        className={styles.taskLinkBtn}
        href={`#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`}
      >
        Open detail →
      </a>
    </aside>
  );
}

function ActivityLog({
  events,
  error,
}: {
  readonly events: readonly ActivityEvent[];
  readonly error: string | null;
}): React.JSX.Element {
  return (
    <div className={styles.log}>
      <div className={styles.logHeader}>Activity</div>
      {error !== null ? <div className={styles.logError}>stream error: {error}</div> : null}
      <ul className={styles.logList}>
        {events.length === 0 ? (
          <li className={styles.logEmpty}>waiting for events…</li>
        ) : (
          events.slice(0, 12).map((ev) => (
            <li key={ev.id} className={styles.logRow}>
              <span className={styles.logAt}>{formatTime(ev.at)}</span>
              <span className={`${styles.logPhase} ${phaseClass(ev.phase)}`}>
                {ev.phase ?? '?'}
              </span>
              <span className={styles.logTask}>{ev.taskKey}</span>
              <span className={styles.logNote}>{ev.note}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function HotkeyOverlay({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className={styles.hotkeyOverlay} onClick={onClose}>
      <div className={styles.hotkeyCard} onClick={(e) => e.stopPropagation()}>
        <h3>Command grammar</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <kbd>WASD</kbd> / <kbd>arrows</kbd>
              </td>
              <td>pan camera</td>
            </tr>
            <tr>
              <td>edge mouse</td>
              <td>edge-scroll pan</td>
            </tr>
            <tr>
              <td>
                <kbd>wheel</kbd>
              </td>
              <td>zoom around cursor</td>
            </tr>
            <tr>
              <td>
                <kbd>space</kbd>
              </td>
              <td>recenter on Gateway HQ</td>
            </tr>
            <tr>
              <td>
                <kbd>F5</kbd>–<kbd>F8</kbd>
              </td>
              <td>recall camera bookmark (<kbd>shift</kbd>+ to save)</td>
            </tr>
            <tr>
              <td>click</td>
              <td>select (<kbd>shift</kbd> = toggle)</td>
            </tr>
            <tr>
              <td>drag</td>
              <td>marquee multi-select</td>
            </tr>
            <tr>
              <td>right-click</td>
              <td>dispatch task to selection</td>
            </tr>
            <tr>
              <td>
                <kbd>ctrl</kbd>+<kbd>1</kbd>..<kbd>9</kbd>
              </td>
              <td>bind selection as control group</td>
            </tr>
            <tr>
              <td>
                <kbd>1</kbd>..<kbd>9</kbd>
              </td>
              <td>recall control group</td>
            </tr>
            <tr>
              <td>
                <kbd>N</kbd>
              </td>
              <td>cycle next idle agent (camera follows)</td>
            </tr>
            <tr>
              <td>
                <kbd>Tab</kbd>
              </td>
              <td>cycle through current selection</td>
            </tr>
            <tr>
              <td>
                <kbd>M</kbd>
              </td>
              <td>toggle audio</td>
            </tr>
            <tr>
              <td>
                <kbd>Esc</kbd>
              </td>
              <td>clear selection / cancel popover</td>
            </tr>
            <tr>
              <td>
                <kbd>?</kbd>
              </td>
              <td>this overlay</td>
            </tr>
          </tbody>
        </table>
        <button type="button" onClick={onClose}>
          close
        </button>
      </div>
    </div>
  );
}

interface DispatchPopoverViewProps {
  readonly popover: DispatchPopover;
  readonly snapshot: ReturnType<typeof useCommandSnapshot>;
  readonly onClose: () => void;
  readonly onDispatch: (prompt: string) => void;
}

function DispatchPopoverView({
  popover,
  snapshot,
  onClose,
  onDispatch,
}: DispatchPopoverViewProps): React.JSX.Element {
  const [prompt, setPrompt] = useState<string>(popover.defaultPrompt);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Clamp position so the popover stays inside the viewport.
  const W = 320;
  const H = 220;
  const PAD = 12;
  const x = Math.min(popover.screenX + PAD, window.innerWidth - W - PAD);
  const y = Math.min(popover.screenY + PAD, window.innerHeight - H - PAD);

  const targetLabels = popover.targetAgents.map((k) => {
    const a = snapshot.agents.get(k);
    return a?.name ?? k.split('/')[1] ?? k;
  });

  return (
    <div
      className={styles.dispatchPopover}
      style={{ left: `${String(x)}px`, top: `${String(y)}px`, width: `${String(W)}px` }}
    >
      <div className={styles.dispatchHeader}>
        <span>Dispatch ({String(popover.targetAgents.length)})</span>
        <button type="button" onClick={onClose} aria-label="cancel">
          ✕
        </button>
      </div>
      <div className={styles.dispatchTargets}>{targetLabels.slice(0, 4).join(', ')}
        {targetLabels.length > 4 ? `, +${String(targetLabels.length - 4)}` : ''}
      </div>
      <textarea
        ref={inputRef}
        className={styles.dispatchInput}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onDispatch(prompt);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        rows={4}
        placeholder="prompt — ⌘↩ / Ctrl-↩ to dispatch, Esc to cancel"
      />
      <div className={styles.dispatchActions}>
        <button type="button" className={styles.dispatchCancel} onClick={onClose}>
          cancel
        </button>
        <button
          type="button"
          className={styles.dispatchSubmit}
          onClick={() => {
            onDispatch(prompt);
          }}
        >
          dispatch ▶
        </button>
      </div>
    </div>
  );
}

function phaseClass(phase: TaskSummary['phase']): string {
  switch (phase) {
    case 'Completed':
      return styles.phaseOk ?? '';
    case 'Failed':
      return styles.phaseBad ?? '';
    case 'Pending':
    case 'Dispatched':
      return styles.phaseBusy ?? '';
    default:
      return '';
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
