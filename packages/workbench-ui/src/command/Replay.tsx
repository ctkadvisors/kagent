/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Per-agent task replay system — re-plays a completed/failed task's
 * lifecycle on the canvas at 4× compressed speed, decoupled from live
 * SSE traffic.
 *
 * The replay sprite is *intentionally* not a real task: it never enters
 * `snapshot.tasks`, never affects in-flight counts, never fires real
 * dispatch / completion side effects. It's pure client-side animation
 * over the existing FxLayer + a dashed-outline DOM ghost sprite that
 * traces the same gateway → agent → return arc a real task would.
 *
 * Lifecycle (compressed timeline, 4× faster than real lifecycle):
 *
 *   t=0 ms       spawn at gateway, phase=Pending (blue, dashed)
 *   t=0–400 ms   travel gateway → agent (eased)
 *   t=400 ms     phase=Dispatched (yellow, dashed) + dispatch chime
 *   t=400–600 ms wobble at agent
 *   t=600 ms     outcome FX:
 *                  Completed → cheer + sparks at gateway + complete chime,
 *                              sprite turns green and travels agent → gateway
 *                  Failed    → smoke + shockwave + damage flash + zap,
 *                              sprite turns red and lingers at agent
 *   t=600–1600ms completed: return to gateway, then despawn
 *   t=600–1600ms failed: linger w/ jitter, then despawn
 *   t=≥1600 ms   removed from `replays`
 *
 * State lives in a `useReplay` hook (this file). The CommandView calls:
 *
 *   - `start(detail, agentPos, gatewayPos)` from the AgentPanel ↻ replay button
 *   - `tick(nowMs, fxLayer)` once per RAF frame to fire FX at boundaries
 *
 * `<ReplayOverlay/>` renders the DOM ghost sprites + the per-replay
 * banner. Sprites are positioned via the same camera-projection math
 * `HoverPreview` uses, so they pan/zoom with the world. We deliberately
 * use DOM (not canvas) for ghost sprites so:
 *
 *   - the dashed outline that distinguishes ghosts from real sprites is
 *     trivial CSS, no extra canvas paths,
 *   - the per-replay banner stacks on top with HTML/flex,
 *   - we don't have to patch scene.ts to thread a new `ghostSprites`
 *     array through the SceneInputs.
 *
 * Multiple replays can run concurrently against any agent (including
 * the same agent twice), each with its own `id` and independent timer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Camera } from './camera.js';
import type { FxLayer } from './fx.js';
import { sound } from './sound.js';
import type { TaskDetail, TaskSummary } from '../types.js';
import styles from './Replay.module.css';

/* ====================================================================
 * Types
 * ================================================================== */

/** Compressed lifecycle slot durations — single source of truth. */
export const REPLAY_DURATIONS = {
  /** Pending sprite travels gateway → agent. */
  travelMs: 400,
  /** Dispatched sprite wobbles at the agent before outcome. */
  wobbleMs: 200,
  /** Time after outcome when sprite is removed. */
  postOutcomeMs: 1_000,
} as const;

/** Total wall-clock duration of a single replay, fixed. */
export const REPLAY_TOTAL_MS =
  REPLAY_DURATIONS.travelMs + REPLAY_DURATIONS.wobbleMs + REPLAY_DURATIONS.postOutcomeMs;

/** Outcome we replay — derived from the real task's terminal phase. */
export type ReplayOutcome = 'Completed' | 'Failed';

/** A single live replay instance — tracked per `id`. */
export interface ReplayInstance {
  readonly id: string;
  /** The agent display name shown in the banner. */
  readonly agentLabel: string;
  /** Gateway anchor in WORLD coordinates. */
  readonly gateway: { readonly x: number; readonly y: number };
  /** Agent anchor in WORLD coordinates. */
  readonly agent: { readonly x: number; readonly y: number };
  /** Wallclock ms when this replay began (Date.now()). */
  readonly startedAt: number;
  /** Outcome to replay. */
  readonly outcome: ReplayOutcome;
}

/** Internal mutable bookkeeping — fired-FX flags so we don't double-emit. */
interface ReplayProgress {
  dispatchFired: boolean;
  outcomeFired: boolean;
}

/** Hook public surface. */
export interface ReplayController {
  readonly replays: readonly ReplayInstance[];
  /**
   * Start a replay for a given completed/failed task. If `detail.phase`
   * is not terminal (`Completed` | `Failed`), nothing starts. Returns
   * the replay id, or `null` if the task is not replayable.
   */
  start(args: {
    readonly detail: TaskDetail | TaskSummary;
    readonly gateway: { readonly x: number; readonly y: number };
    readonly agent: { readonly x: number; readonly y: number };
    readonly agentLabel: string;
  }): string | null;
  /**
   * Per-frame tick — fires FX into `fx` at the right lifecycle slots
   * and prunes finished replays. Call once per RAF frame from the
   * canvas loop.
   */
  tick(nowMs: number, fx: FxLayer): void;
}

/* ====================================================================
 * Hook
 * ================================================================== */

/**
 * Replay manager hook. Owns the live replay list + the per-replay
 * progress flags. Returns a stable controller object whose methods
 * never change identity (so dependent effects don't churn).
 */
export function useReplay(): ReplayController {
  const [replays, setReplays] = useState<readonly ReplayInstance[]>([]);
  // Mutable side bookkeeping keyed by replay id — tracks which
  // FX/sound boundaries have fired so a subsequent tick doesn't
  // double-emit. Lives in a ref so React state churn stays minimal.
  const progressRef = useRef<Map<string, ReplayProgress>>(new Map());
  const replaysRef = useRef<readonly ReplayInstance[]>([]);
  replaysRef.current = replays;

  const start: ReplayController['start'] = useCallback((args) => {
    const phase = args.detail.phase;
    if (phase !== 'Completed' && phase !== 'Failed') return null;
    const id = `replay-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
    const instance: ReplayInstance = {
      id,
      agentLabel: args.agentLabel,
      gateway: { x: args.gateway.x, y: args.gateway.y },
      agent: { x: args.agent.x, y: args.agent.y },
      startedAt: Date.now(),
      outcome: phase,
    };
    progressRef.current.set(id, { dispatchFired: false, outcomeFired: false });
    setReplays((prev) => [...prev, instance]);
    return id;
  }, []);

  const tick: ReplayController['tick'] = useCallback((nowMs, fx) => {
    const live = replaysRef.current;
    if (live.length === 0) return;
    const progress = progressRef.current;
    let removedAny = false;
    const next: ReplayInstance[] = [];

    for (const r of live) {
      const age = nowMs - r.startedAt;
      const prog = progress.get(r.id);
      if (prog === undefined) {
        // Defensive: lost progress entry. Drop quietly.
        removedAny = true;
        continue;
      }

      // Slot A: dispatch chime + faint dispatch FX at agent, fired at travelMs.
      if (!prog.dispatchFired && age >= REPLAY_DURATIONS.travelMs) {
        prog.dispatchFired = true;
        sound.dispatch();
      }

      // Slot B: outcome FX, fired at travelMs + wobbleMs.
      const outcomeAt = REPLAY_DURATIONS.travelMs + REPLAY_DURATIONS.wobbleMs;
      if (!prog.outcomeFired && age >= outcomeAt) {
        prog.outcomeFired = true;
        if (r.outcome === 'Completed') {
          sound.taskComplete();
          fx.emit({
            kind: 'cheer',
            x: r.agent.x,
            y: r.agent.y - 18,
            startedAt: nowMs,
            durationMs: 900,
          });
          // Coin-sparks at gateway — same shape as live Completed
          // path so the replay reads the same as live traffic.
          for (let i = 0; i < 4; i++) {
            fx.emit({
              kind: 'sparks',
              x: r.gateway.x + (i - 1.5) * 6,
              y: r.gateway.y - 30 - Math.random() * 6,
              color: '#fbbf24',
              startedAt: nowMs + i * 60,
              durationMs: 700,
            });
          }
        } else {
          sound.taskFailed();
          fx.emit({
            kind: 'smoke',
            x: r.agent.x,
            y: r.agent.y + 8,
            startedAt: nowMs,
            durationMs: 4_000,
          });
          fx.emit({
            kind: 'shockwave',
            x: r.agent.x,
            y: r.agent.y - 4,
            color: '#ef4444',
            startedAt: nowMs,
            durationMs: 700,
            maxRadius: 80,
          });
          fx.emit({
            kind: 'damage',
            x: r.agent.x,
            y: r.agent.y + 6,
            w: 56,
            h: 70,
            startedAt: nowMs,
            durationMs: 320,
          });
        }
      }

      // Removal: total elapsed exceeds REPLAY_TOTAL_MS.
      if (age >= REPLAY_TOTAL_MS) {
        progress.delete(r.id);
        removedAny = true;
        continue;
      }

      next.push(r);
    }

    if (removedAny) {
      setReplays(next);
    }
  }, []);

  // Cleanup on unmount — drop any in-flight progress.
  useEffect(() => {
    const progress = progressRef.current;
    return () => {
      progress.clear();
    };
  }, []);

  return { replays, start, tick };
}

/* ====================================================================
 * Position math — mirrors scene.ts `positionForTask` but compressed.
 * ================================================================== */

/**
 * Compute the WORLD-space position of a replay sprite at wall-clock
 * time `nowMs`. Returns `null` if the replay should be invisible
 * (e.g., post-completion sprite has returned to gateway and despawned).
 *
 * Uses a hand-rolled compressed timeline rather than re-using
 * `positionForTask` because the live function reads task-record
 * `createdAt`/`completedAt` strings from the snapshot — replays don't
 * have those; they have a fixed 4×-compressed lifecycle.
 */
export function replaySpritePosition(
  r: ReplayInstance,
  nowMs: number,
): { x: number; y: number; phase: 'Pending' | 'Dispatched' | ReplayOutcome } | null {
  const age = nowMs - r.startedAt;
  if (age < 0) return null;
  const { travelMs, wobbleMs, postOutcomeMs } = REPLAY_DURATIONS;

  // Phase 1: Pending — travel gateway → agent.
  if (age < travelMs) {
    const t = age / travelMs;
    const eased = easeOutCubic(t);
    return {
      x: r.gateway.x + (r.agent.x - r.gateway.x) * eased,
      y: r.gateway.y + (r.agent.y - r.gateway.y) * eased,
      phase: 'Pending',
    };
  }

  // Phase 2: Dispatched — wobble at agent.
  if (age < travelMs + wobbleMs) {
    const wobble = Math.sin(nowMs / 90) * 5;
    return {
      x: r.agent.x + wobble,
      y: r.agent.y - 18,
      phase: 'Dispatched',
    };
  }

  // Phase 3: outcome animation.
  const outcomeAge = age - travelMs - wobbleMs;
  if (outcomeAge >= postOutcomeMs) return null;

  if (r.outcome === 'Completed') {
    // Return-to-gateway: agent → gateway, eased.
    const t = outcomeAge / postOutcomeMs;
    const eased = easeInOutCubic(t);
    return {
      x: r.agent.x + (r.gateway.x - r.agent.x) * eased,
      y: r.agent.y + (r.gateway.y - r.agent.y) * eased,
      phase: 'Completed',
    };
  }

  // Failed: jitter at agent, then despawn at postOutcomeMs.
  const j = Math.sin(nowMs / 100) * 4;
  return {
    x: r.agent.x + j,
    y: r.agent.y - 18 - j,
    phase: 'Failed',
  };
}

/* ====================================================================
 * Overlay component
 * ================================================================== */

interface ReplayOverlayProps {
  readonly replays: readonly ReplayInstance[];
  readonly camera: Camera;
}

/**
 * DOM overlay that renders one ghost sprite + banner per active
 * replay. Positioned absolutely inside the canvas wrapper so the
 * sprites pan/zoom with the camera by reading `camera.offsetX/zoom`
 * each render.
 *
 * The component re-renders on every `replays` update (start/end) but
 * not on every frame — sprite positions are recomputed inside the
 * render against a fresh `Date.now()` read. To get smooth motion,
 * this component is wrapped in a 30 Hz interval that bumps a render
 * counter so positions interpolate. We deliberately avoid hooking
 * into the canvas RAF loop so the overlay survives canvas pauses
 * (e.g., off-screen rerenders) without freezing.
 */
export function ReplayOverlay({ replays, camera }: ReplayOverlayProps): React.JSX.Element | null {
  const [, bump] = useState(0);
  useEffect(() => {
    if (replays.length === 0) return undefined;
    const id = window.setInterval(() => {
      bump((n) => (n + 1) | 0);
    }, 33); // ~30 Hz
    return () => {
      window.clearInterval(id);
    };
  }, [replays.length]);

  if (replays.length === 0) return null;
  const now = Date.now();

  return (
    <>
      {replays.map((r) => {
        const pos = replaySpritePosition(r, now);
        if (pos === null) return null;
        // Project world → screen using the same transform `drawScene`
        // applies to its world layer. CSS pixels.
        const screenX = pos.x * camera.zoom + camera.offsetX;
        const screenY = pos.y * camera.zoom + camera.offsetY;
        const elapsedMs = now - r.startedAt;
        const elapsedSec = (elapsedMs / 1000).toFixed(1);
        const phaseClass =
          pos.phase === 'Pending'
            ? styles.spritePending
            : pos.phase === 'Dispatched'
              ? styles.spriteDispatched
              : pos.phase === 'Completed'
                ? styles.spriteCompleted
                : styles.spriteFailed;
        return (
          <div key={r.id}>
            <div
              className={`${styles.sprite} ${phaseClass}`}
              style={{
                left: `${String(Math.round(screenX))}px`,
                top: `${String(Math.round(screenY))}px`,
              }}
              aria-hidden="true"
            />
            {/* Per-replay banner anchored to the agent. Stacks
                offset-down per N concurrent replays so two banners
                don't perfectly overlap. */}
            <ReplayBanner
              replay={r}
              elapsedSec={elapsedSec}
              camera={camera}
              stackIndex={replays.indexOf(r)}
            />
          </div>
        );
      })}
    </>
  );
}

interface ReplayBannerProps {
  readonly replay: ReplayInstance;
  readonly elapsedSec: string;
  readonly camera: Camera;
  readonly stackIndex: number;
}

function ReplayBanner({
  replay,
  elapsedSec,
  camera,
  stackIndex,
}: ReplayBannerProps): React.JSX.Element {
  // Anchor banner near the agent's screen position (above the
  // structure), offset down by stackIndex * 18 so concurrent replays
  // don't stack in the exact same pixels.
  const screenX = replay.agent.x * camera.zoom + camera.offsetX;
  const screenY = replay.agent.y * camera.zoom + camera.offsetY - 60 + stackIndex * 18;
  return (
    <div
      className={styles.banner}
      style={{
        left: `${String(Math.round(screenX))}px`,
        top: `${String(Math.round(screenY))}px`,
      }}
    >
      <span className={styles.bannerIcon}>↻</span>
      <span className={styles.bannerLabel}>replay</span>
      <span className={styles.bannerSep}>·</span>
      <span className={styles.bannerAgent}>{replay.agentLabel}</span>
      <span className={styles.bannerSep}>·</span>
      <span className={styles.bannerTime}>{elapsedSec}s</span>
    </div>
  );
}

/* ====================================================================
 * Replay button — drop-in for the AgentPanel.
 * ================================================================== */

export interface ReplayButtonProps {
  /** Disabled if true (no replayable task for this agent). */
  readonly disabled: boolean;
  /** Click handler — caller wires up `controller.start(...)`. */
  readonly onClick: () => void;
  /** Tooltip override — defaults to a sensible message. */
  readonly title?: string;
}

/**
 * Small "↻ replay" button styled to match the topbar replay control
 * but sized down for the right-side panel context. Visual idiom: same
 * cyan accent as the existing replay button so the operator's mental
 * model stays consistent.
 */
export function ReplayButton(props: ReplayButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={props.disabled ? styles.replayBtnDisabled : styles.replayBtn}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.title ?? 'Re-play this agent’s most recent completed/failed task.'}
    >
      <span className={styles.replayBtnIcon}>↻</span> replay
    </button>
  );
}

/* ====================================================================
 * Helpers
 * ================================================================== */

/**
 * Find the most-recent terminal task for an agent in the snapshot.
 * Returns undefined if the agent has no Completed/Failed task on
 * record — the caller should disable the replay button.
 */
export function findMostRecentTerminalTask(
  tasks: ReadonlyMap<string, TaskSummary>,
  agentKey: string,
): TaskSummary | undefined {
  let best: TaskSummary | undefined;
  let bestAt = -Infinity;
  for (const t of tasks.values()) {
    if (t.targetAgent === undefined) continue;
    const k = `${t.namespace}/${t.targetAgent}`;
    if (k !== agentKey) continue;
    if (t.phase !== 'Completed' && t.phase !== 'Failed') continue;
    const at = t.completedAt !== undefined ? Date.parse(t.completedAt) : NaN;
    const safeAt = Number.isNaN(at) ? 0 : at;
    if (safeAt > bestAt) {
      best = t;
      bestAt = safeAt;
    }
  }
  return best;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
