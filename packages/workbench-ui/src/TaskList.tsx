/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * TaskList — primary read-only Workbench view.
 *
 * Lifecycle:
 *
 *   1. On mount: fetch /api/tasks once.
 *   2. Subscribe to /api/stream (SSE).
 *   3. On every `cache` event with kind=task, refetch the list (cheap;
 *      the API serves from in-memory cache and lists are small in v0.1).
 *      A v0.2 optimization is to patch the row in-place using the event's
 *      `key`, but the dumb refetch is correct and easy to reason about.
 *   4. Heartbeats keep `lastEventAt` fresh — the connection chip turns
 *      "stale" if no event arrives for 60s.
 *
 * No router yet; the design doc defers Task Detail / Agent Catalog
 * views to follow-up commits. The TaskList is the milestone-1 deliverable
 * that proves the SSE refresh path works end-to-end.
 */

import { useEffect, useRef, useState } from 'react';

import { fetchTasks, subscribeCacheEvents } from './api.js';
import { NewTaskModal } from './NewTaskModal.js';
import type { TaskSummary } from './types.js';
import styles from './TaskList.module.css';

const STALE_THRESHOLD_MS = 60_000;

export function TaskList(): React.JSX.Element {
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number>(Date.now());
  const [now, setNow] = useState<number>(Date.now());
  const [showNewTask, setShowNewTask] = useState<boolean>(false);
  const refetchAbortRef = useRef<AbortController | null>(null);

  const refetch = (): void => {
    refetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    refetchAbortRef.current = ctrl;
    fetchTasks(ctrl.signal)
      .then((items) => {
        setTasks(items);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  useEffect(() => {
    refetch();
    const unsubscribe = subscribeCacheEvents(
      (ev) => {
        setLastEventAt(Date.now());
        if (ev.kind === 'task') {
          refetch();
        }
      },
      () => {
        setLastEventAt(Date.now());
      },
    );
    const tick = setInterval(() => {
      setNow(Date.now());
    }, 5_000);
    return () => {
      unsubscribe();
      clearInterval(tick);
      refetchAbortRef.current?.abort();
    };
    // Effect intentionally runs once on mount — refetch is captured by
    // ref-based identity above, so adding it to deps would just churn.
  }, []);

  const isStale = now - lastEventAt > STALE_THRESHOLD_MS;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h1 className={styles.title}>Tasks</h1>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.newTaskButton}
            onClick={() => setShowNewTask(true)}
          >
            + New Task
          </button>
          <span
            className={`${styles.connection} ${isStale ? styles.connectionStale : styles.connectionLive}`}
          >
            {isStale ? `stream stale (${formatAgo(now - lastEventAt)})` : 'stream live'}
          </span>
        </div>
      </div>

      {showNewTask ? (
        <NewTaskModal
          onClose={() => setShowNewTask(false)}
          onSuccess={(created) => {
            setShowNewTask(false);
            // Navigate to the new task's detail page so the user lands
            // on the live progress view immediately. The SSE stream
            // will surface the task in the list when they navigate back.
            window.location.hash = `#/tasks/${encodeURIComponent(created.namespace)}/${encodeURIComponent(created.name)}`;
            // Optimistic refresh — the SSE event usually arrives first
            // anyway, but this guarantees the row is present even if
            // the cache is briefly behind.
            refetch();
          }}
        />
      ) : null}

      {error !== null ? <div className={styles.error}>error: {error}</div> : null}

      {tasks.length === 0 && error === null ? (
        <div className={styles.empty}>No tasks observed yet.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Namespace</th>
              <th>Phase</th>
              <th>Trace</th>
              <th>Children / Artifacts</th>
              <th>Target</th>
              <th>Created</th>
              <th>Pod</th>
              <th>Failure</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.uid !== '' ? t.uid : `${t.namespace}/${t.name}`}>
                <td>
                  <a
                    href={`#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`}
                    className={styles.linkCell}
                  >
                    {t.name}
                  </a>
                </td>
                <td>{t.namespace}</td>
                <td>
                  {t.phase !== undefined ? (
                    <span className={`${styles.phasePill} ${phaseClass(t.phase)}`}>{t.phase}</span>
                  ) : (
                    <span className={styles.phasePill}>—</span>
                  )}
                  {t.suspicious !== undefined && t.suspicious.length > 0
                    ? t.suspicious.map((tag) => (
                        <span key={tag} className={styles.suspicious}>
                          {tag}
                        </span>
                      ))
                    : null}
                </td>
                <td>
                  {t.traceLink?.url !== undefined ? (
                    <a
                      href={t.traceLink.url}
                      target="_blank"
                      rel="noreferrer"
                      className={styles.traceLink}
                    >
                      open trace
                    </a>
                  ) : (
                    <span className={styles.countChipMuted}>—</span>
                  )}
                </td>
                <td>{renderGraphCell(t)}</td>
                <td>
                  {t.targetAgent ??
                    (t.targetCapability !== undefined ? `cap:${t.targetCapability}` : '—')}
                </td>
                <td>{t.createdAt ?? '—'}</td>
                <td>{t.podName ?? '—'}</td>
                <td>{t.error ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Render the children + artifacts cell. Reads `childCount` /
 * `artifactCount` / `aggregatePhase` off the row. Each piece is shown
 * only when the API surfaces it — `undefined` (no projection yet)
 * collapses to an em-dash, while `0` is rendered as a muted "0"
 * (operator observed but found none).
 */
function renderGraphCell(t: TaskSummary): React.JSX.Element {
  const hasChildren = typeof t.childCount === 'number';
  const hasArtifacts = typeof t.artifactCount === 'number';
  const hasAggregate = typeof t.aggregatePhase === 'string';

  if (!hasChildren && !hasArtifacts && !hasAggregate) {
    return <span className={styles.countChipMuted}>—</span>;
  }

  return (
    <span>
      {hasChildren ? (
        <span
          className={`${styles.countChip} ${(t.childCount ?? 0) === 0 ? styles.countChipMuted : ''}`}
          title="Child tasks delegated by this task"
        >
          {(t.childCount ?? 0).toString()} child
        </span>
      ) : null}
      {hasArtifacts ? (
        <span
          className={`${styles.countChip} ${(t.artifactCount ?? 0) === 0 ? styles.countChipMuted : ''}`}
          title="Artifacts attached to status.artifacts"
        >
          {(t.artifactCount ?? 0).toString()} art
        </span>
      ) : null}
      {hasAggregate && t.aggregatePhase !== undefined ? (
        <span
          className={`${styles.aggregatePill} ${aggregateClass(t.aggregatePhase)}`}
          title="Aggregate phase across child tasks"
        >
          {t.aggregatePhase}
        </span>
      ) : null}
    </span>
  );
}

function aggregateClass(phase: NonNullable<TaskSummary['aggregatePhase']>): string {
  switch (phase) {
    case 'AllComplete':
      return styles.aggregateAllComplete ?? '';
    case 'AnyFailed':
      return styles.aggregateAnyFailed ?? '';
    case 'PartiallyComplete':
      return styles.aggregatePartiallyComplete ?? '';
    case 'Pending':
    case 'Dispatched':
    default:
      return '';
  }
}

function phaseClass(phase: TaskSummary['phase']): string {
  switch (phase) {
    case 'Pending':
      return styles.phasePending ?? '';
    case 'Dispatched':
      return styles.phaseDispatched ?? '';
    case 'Completed':
      return styles.phaseCompleted ?? '';
    case 'Failed':
      return styles.phaseFailed ?? '';
    default:
      return '';
  }
}

function formatAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds.toString()}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes.toString()}m ago`;
}
