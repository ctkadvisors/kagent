/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Cluster page — the substrate observability surface end-users have
 * been asking for. Three panels, all SSE-driven for liveness:
 *
 *   1. Headline counters (nodes / managed pods / active tasks /
 *      agents) — substrate-shaped numbers.
 *   2. Node grid — one card per K3s node showing role, kubelet
 *      version, ready condition, capacity, managed-pod count, last
 *      heartbeat. Color-coded by Ready status.
 *   3. Live activity feed — last 50 cache events from /api/stream
 *      (task/agent/job/pod upsert+delete), scrolling. The live
 *      proof that work is happening.
 *   4. Active tasks with parent→child fan-out tree — one tree per
 *      root task. Children render as nested rows under their parent
 *      so an orchestrator → 3-summarizer fan-out is visible at a
 *      glance. Each row links to its TaskDetail page.
 *   5. Recent tasks (terminal phase) — last 30 completed/failed,
 *      newest first.
 *
 * Polling cadence: 3s for the snapshot fetch (cheaper than the
 * Gateway page since the snapshot is bigger). The activity feed is
 * pure SSE — events appear instantly without polling.
 */

import { useEffect, useMemo, useState } from 'react';

import { fetchClusterSnapshot, subscribeCacheEvents } from './api.js';
import styles from './ClusterPage.module.css';
import type {
  CacheChangeEvent,
  ClusterNodeRow,
  ClusterSnapshot,
  ClusterTaskRow,
} from './types.js';

const POLL_INTERVAL_MS = 3_000;
const ACTIVITY_FEED_MAX = 50;

interface ActivityEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: CacheChangeEvent['kind'];
  readonly op: CacheChangeEvent['op'];
  readonly key: string;
}

function formatAge(iso?: string): string {
  if (iso === undefined) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1500) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000).toString()}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000).toString()}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000).toString()}h ago`;
  return `${Math.floor(ms / 86_400_000).toString()}d ago`;
}

function readyClass(ready: ClusterNodeRow['ready']): string {
  if (ready === 'True') return styles.nodeReady ?? '';
  if (ready === 'False') return styles.nodeUnready ?? '';
  return styles.nodeUnknown ?? '';
}

function phaseClass(phase: string): string {
  if (phase === 'Completed') return styles.phaseCompleted ?? '';
  if (phase === 'Failed') return styles.phaseFailed ?? '';
  if (phase === 'Dispatched' || phase === 'Running') return styles.phaseRunning ?? '';
  return styles.phasePending ?? '';
}

function NodeCard({ node }: { node: ClusterNodeRow }): React.JSX.Element {
  const cpu = node.capacity.cpu ?? '—';
  const mem = node.capacity.memory ?? '—';
  return (
    <div className={`${styles.nodeCard} ${readyClass(node.ready)}`}>
      <div className={styles.nodeHeader}>
        <div>
          <div className={styles.nodeName}>{node.name}</div>
          <div className={styles.nodeMeta}>
            {node.role} · {node.kubeletVersion}
          </div>
        </div>
        <div className={styles.nodeStatus}>{node.ready === 'True' ? 'Ready' : node.ready}</div>
      </div>
      <div className={styles.nodeStats}>
        <div className={styles.nodeStat}>
          <span className={styles.nodeStatVal}>{node.managedPodCount}</span>
          <span className={styles.nodeStatLbl}>pods</span>
        </div>
        <div className={styles.nodeStat}>
          <span className={styles.nodeStatVal}>{cpu}</span>
          <span className={styles.nodeStatLbl}>cpu</span>
        </div>
        <div className={styles.nodeStat}>
          <span className={styles.nodeStatVal}>{mem}</span>
          <span className={styles.nodeStatLbl}>mem</span>
        </div>
      </div>
      <div className={styles.nodeFooter}>
        <span className={styles.nodeOs}>{node.osImage.slice(0, 32)}</span>
        <span className={styles.nodeHb}>hb {formatAge(node.lastHeartbeatAt)}</span>
      </div>
    </div>
  );
}

function ActivityRow({ ev }: { ev: ActivityEvent }): React.JSX.Element {
  const kindClass: Record<CacheChangeEvent['kind'], string | undefined> = {
    task: styles.evTask,
    agent: styles.evAgent,
    job: styles.evJob,
    pod: styles.evPod,
  };
  const dot = kindClass[ev.kind] ?? '';
  return (
    <div className={styles.activityRow}>
      <span className={styles.activityTime}>{ev.at}</span>
      <span className={`${styles.activityDot} ${dot}`} />
      <span className={styles.activityKind}>{ev.kind}</span>
      <span className={styles.activityOp}>{ev.op}</span>
      <span className={styles.activityKey}>{ev.key}</span>
    </div>
  );
}

/**
 * Render a task row + its children recursively. Children rows are
 * inset by depth × 1rem so the parent → child fan-out is visible.
 */
function TaskTreeRow({
  task,
  childrenByParent,
  depth,
}: {
  task: ClusterTaskRow;
  childrenByParent: ReadonlyMap<string, readonly ClusterTaskRow[]>;
  depth: number;
}): React.JSX.Element {
  const children = childrenByParent.get(task.uid) ?? [];
  return (
    <>
      <a
        className={styles.treeRow}
        href={`#/tasks/${encodeURIComponent(task.namespace)}/${encodeURIComponent(task.name)}`}
        style={{ paddingLeft: `${(depth * 1.25 + 0.5).toString()}rem` }}
      >
        {depth > 0 && <span className={styles.treeBranch}>↳</span>}
        <span className={styles.treeName}>{task.name}</span>
        <span className={`${styles.treePhase} ${phaseClass(task.phase)}`}>{task.phase}</span>
        <span className={styles.treeAgent}>{task.targetAgent ?? '—'}</span>
        <span className={styles.treeNode}>{task.nodeName ?? '—'}</span>
        <span className={styles.treeAge}>{formatAge(task.createdAt)}</span>
        {task.errorMessage !== undefined && task.errorMessage.length > 0 ? (
          <span className={styles.treeErr} title={task.errorMessage}>
            {task.errorMessage.slice(0, 60)}
          </span>
        ) : task.lastResultPreview !== undefined && task.lastResultPreview.length > 0 ? (
          <span className={styles.treeResult} title={task.lastResultPreview}>
            {task.lastResultPreview.slice(0, 80)}
          </span>
        ) : null}
      </a>
      {children.map((c) => (
        <TaskTreeRow
          key={c.uid}
          task={c}
          childrenByParent={childrenByParent}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

export interface ClusterPageProps {
  readonly onBack: () => void;
}

export function ClusterPage(props: ClusterPageProps): React.JSX.Element {
  const [snap, setSnap] = useState<ClusterSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [activity, setActivity] = useState<readonly ActivityEvent[]>([]);
  const [streamLive, setStreamLive] = useState<boolean>(false);
  // Tick state forces a re-render every second so the "X seconds
  // ago" timestamps update without re-fetching.
  const [, setNowTick] = useState<number>(Date.now());

  // Snapshot polling.
  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const data = await fetchClusterSnapshot(ac.signal);
        if (cancelled) return;
        setSnap(data);
        setError(null);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      ac.abort();
      window.clearInterval(id);
    };
  }, []);

  // Live SSE feed.
  useEffect(() => {
    const cleanup = subscribeCacheEvents(
      (ev: CacheChangeEvent) => {
        setStreamLive(true);
        setActivity((prev) => {
          const next: ActivityEvent[] = [
            {
              id: `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
              at: new Date().toISOString().slice(11, 19),
              kind: ev.kind,
              op: ev.op,
              key: ev.key,
            },
            ...prev,
          ];
          return next.slice(0, ACTIVITY_FEED_MAX);
        });
      },
      () => {
        setStreamLive(true);
      },
    );
    return cleanup;
  }, []);

  // Re-render every 1s for "X ago" labels.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // Group active+recent tasks by parent for the fan-out tree.
  const { roots, childrenByParent } = useMemo(() => {
    const all: ClusterTaskRow[] = [
      ...(snap?.activeTasks ?? []),
      ...(snap?.recentTasks ?? []),
    ];
    const byUid = new Map<string, ClusterTaskRow>();
    for (const t of all) byUid.set(t.uid, t);
    const map = new Map<string, ClusterTaskRow[]>();
    const tops: ClusterTaskRow[] = [];
    for (const t of all) {
      const parent = t.parentTaskUid;
      if (parent !== undefined && byUid.has(parent)) {
        const arr = map.get(parent) ?? [];
        arr.push(t);
        map.set(parent, arr);
      } else {
        tops.push(t);
      }
    }
    return { roots: tops, childrenByParent: map };
  }, [snap]);

  const counts = snap?.counts ?? { nodes: 0, managedPods: 0, active: 0, recent: 0, agents: 0 };

  return (
    <div className={styles.wrapper}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button type="button" className={styles.backButton} onClick={props.onBack}>
            ← tasks
          </button>
          <h1 className={styles.title}>Cluster</h1>
        </div>
        <div className={styles.headerRight}>
          <span className={`${styles.streamPill} ${streamLive ? styles.streamLive : styles.streamOff}`}>
            {streamLive ? 'stream live' : 'stream offline'}
          </span>
          {snap !== null && (
            <span className={styles.fetchedAt}>
              snapshot {formatAge(snap.fetchedAt)}
            </span>
          )}
        </div>
      </header>

      {error !== null && (
        <div className={styles.errorBanner}>
          <strong>could not load cluster snapshot:</strong> {error}
        </div>
      )}

      <section className={styles.countsRow}>
        <div className={styles.count}>
          <span className={styles.countVal}>{counts.nodes}</span>
          <span className={styles.countLbl}>k3s nodes</span>
        </div>
        <div className={styles.count}>
          <span className={styles.countVal}>{counts.managedPods}</span>
          <span className={styles.countLbl}>managed pods</span>
        </div>
        <div className={styles.count}>
          <span className={styles.countVal}>{counts.active}</span>
          <span className={styles.countLbl}>active tasks</span>
        </div>
        <div className={styles.count}>
          <span className={styles.countVal}>{counts.recent}</span>
          <span className={styles.countLbl}>recent (terminal)</span>
        </div>
        <div className={styles.count}>
          <span className={styles.countVal}>{counts.agents}</span>
          <span className={styles.countLbl}>registered agents</span>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Nodes</h2>
        {snap === null && loading ? (
          <div className={styles.empty}>loading…</div>
        ) : counts.nodes === 0 ? (
          <div className={styles.empty}>
            no nodes visible — workbench-api may lack node:list permission, or the
            cluster has no schedulable nodes
          </div>
        ) : (
          <div className={styles.nodeGrid}>
            {snap?.nodes.map((n) => <NodeCard key={n.name} node={n} />)}
          </div>
        )}
      </section>

      <section className={`${styles.section} ${styles.twoColumns}`}>
        <div>
          <h2 className={styles.sectionTitle}>Live activity</h2>
          {activity.length === 0 ? (
            <div className={styles.empty}>waiting for events…</div>
          ) : (
            <div className={styles.activityList}>
              {activity.map((ev) => <ActivityRow key={ev.id} ev={ev} />)}
            </div>
          )}
        </div>
        <div>
          <h2 className={styles.sectionTitle}>Tasks (parent → children)</h2>
          {roots.length === 0 ? (
            <div className={styles.empty}>no tasks observed</div>
          ) : (
            <div className={styles.taskTree}>
              {roots.map((t) => (
                <TaskTreeRow
                  key={t.uid}
                  task={t}
                  childrenByParent={childrenByParent}
                  depth={0}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
