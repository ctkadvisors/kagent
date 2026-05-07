/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * CommandView — Tier-0 RTS-style command center for the Workbench.
 *
 * Layout:
 *
 *   ┌─ HUD bar ────────────────────────────────────────────────┐
 *   │ in-flight | completed-24h | tokens/min | model utilisation │
 *   ├──────────────────────────────────┬───────────────────────┤
 *   │                                  │  Selection panel       │
 *   │       Canvas (RTS topology)      │  (agent / task / gw    │
 *   │                                  │   detail, WC3 portrait │
 *   │                                  │   feel)                │
 *   ├──────────────────────────────────┴───────────────────────┤
 *   │ Activity log (bottom-left WC3 event feed)                 │
 *   └───────────────────────────────────────────────────────────┘
 *
 * No new deps — vanilla HTML5 canvas + a `requestAnimationFrame` loop.
 * The scene size is dozens of structures; canvas-2D handles it at
 * 60fps trivially. PixiJS / WebGL is a Tier-1 follow-up if particle
 * effects + sprite art land.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { computeLayout } from './command/layout.js';
import type { AgentNode, LayoutResult } from './command/layout.js';
import { drawScene } from './command/scene.js';
import type { HitMap, SelectionRef } from './command/scene.js';
import { useCommandSnapshot } from './command/state.js';
import type { ActivityEvent } from './command/state.js';
import type { AgentSummaryRow, TaskSummary } from './types.js';
import styles from './CommandView.module.css';

interface CommandViewProps {
  readonly onBack: () => void;
}

export function CommandView({ onBack }: CommandViewProps): React.JSX.Element {
  const snapshot = useCommandSnapshot();
  const [selection, setSelection] = useState<SelectionRef>({ kind: null, key: null });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hitMapRef = useRef<HitMap | null>(null);
  const layoutRef = useRef<LayoutResult | null>(null);
  const rafRef = useRef<number | null>(null);

  // Build a stable list of AgentNodes from agents + tasks (so ad-hoc
  // tasks targeting agents we don't have a CR for still render their
  // "structure"). Task fallback is targetAgent + namespace.
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

  // RAF render loop — recompute layout off canvas size + node set, then
  // paint the scene. Layout is memoized inside the loop using the last
  // bounds so we don't churn on every frame; only resizes / agent-set
  // changes invalidate it.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (canvas === null || wrapper === null) return;

    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    let lastBoundsKey = '';
    let lastNodeKey = '';

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
      }
      return { w, h };
    };

    const tick = (nowMs: number): void => {
      const { w, h } = fitCanvas();
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

      hitMapRef.current = drawScene(ctx, {
        snapshot,
        layout,
        selection,
        nowMs,
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const onResize = (): void => {
      // Force a re-layout on the next frame.
      lastBoundsKey = '';
    };
    window.addEventListener('resize', onResize);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
    };
  }, [agentNodes, snapshot, selection]);

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    const hits = hitMapRef.current;
    if (canvas === null || hits === null) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // Gateway hit-test first.
    const dxg = cx - hits.gateway.x;
    const dyg = cy - hits.gateway.y;
    if (Math.hypot(dxg, dyg) <= hits.gateway.r) {
      setSelection({ kind: 'gateway', key: 'gateway' });
      return;
    }

    // Task sprites — small radius, hit-test any sprite within 12px.
    let bestTask: { key: string; d2: number } | null = null;
    for (const [key, p] of hits.taskSprites) {
      const dx = cx - p.x;
      const dy = cy - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= 12 * 12 && (bestTask === null || d2 < bestTask.d2)) {
        bestTask = { key, d2 };
      }
    }
    if (bestTask !== null) {
      setSelection({ kind: 'task', key: bestTask.key });
      return;
    }

    // Agent rect hit-test.
    for (const [key, r] of hits.agentRects) {
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
        setSelection({ kind: 'agent', key });
        return;
      }
    }

    setSelection({ kind: null, key: null });
  };

  // HUD ticker numbers.
  const hud = useMemo(() => deriveHud(snapshot), [snapshot]);

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
          <HudTile label="Calls / min" value={hud.callsPerMin} />
        </div>
        <div className={styles.navLinks}>
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
          <canvas ref={canvasRef} className={styles.canvas} onClick={onCanvasClick} />
          {agentNodes.length === 0 ? (
            <div className={styles.emptyOverlay}>No agents observed yet.</div>
          ) : null}
        </div>

        <SelectionPanel snapshot={snapshot} selection={selection} />
      </div>

      <ActivityLog events={snapshot.events} error={snapshot.error} />
    </div>
  );
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
  // Tokens + calls / min from gateway usage rows in the last 60s.
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
  readonly selection: SelectionRef;
}

function SelectionPanel({ snapshot, selection }: SelectionPanelProps): React.JSX.Element {
  if (selection.kind === null) {
    return (
      <aside className={styles.panel}>
        <div className={styles.panelEmpty}>
          <strong>Select a structure</strong>
          <p>
            Click a building to inspect its agent. Click the gateway to inspect
            ModelEndpoint capacity. Click a moving unit to drill into the live task.
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
