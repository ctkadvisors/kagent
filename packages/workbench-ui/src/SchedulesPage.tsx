/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Schedules page — `KagentSchedule` CRs (cron triggers that materialize a
 * fresh AgentTask per tick). Single table, SSE-driven refresh. One action:
 * "Run now" asks the operator to run the schedule at its next minute tick.
 * Suspend and resume are not here: the fleet's pause switch is on the
 * forum (fleet.knuteson.io, the Fleet tab links to it), and a single
 * schedule's `suspend` is set in git.
 */

import { useEffect, useState } from 'react';

import { fetchSchedules, runScheduleNow, subscribeCacheEvents } from './api.js';
import styles from './SchedulesPage.module.css';
import type { CacheChangeEvent, ScheduleSummary } from './types.js';

const POLL_INTERVAL_MS = 5_000;

/** A span of time, whichever side of now it is on. */
function formatSpan(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000).toString()}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000).toString()}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000).toString()}h`;
  return `${Math.floor(ms / 86_400_000).toString()}d`;
}

function lastTick(iso: string | undefined): string {
  const at = iso === undefined ? NaN : new Date(iso).getTime();
  return Number.isNaN(at) ? '—' : `${formatSpan(Math.max(0, Date.now() - at))} ago`;
}

/** `overdue`: the recorded next tick has passed and the schedule is not suspended. */
export function nextTick(s: ScheduleSummary, now: number): { text: string; overdue: boolean } {
  const at = s.nextTickAt === undefined ? NaN : new Date(s.nextTickAt).getTime();
  if (Number.isNaN(at) || s.suspended) return { text: '—', overdue: false };
  // The controller ticks on the minute; a next tick inside this minute is not late yet.
  if (now - at < 60_000) return { text: `in ${formatSpan(Math.max(0, at - now))}`, overdue: false };
  return { text: `overdue ${formatSpan(now - at)}`, overdue: true };
}

function isScheduleEvent(kind: CacheChangeEvent['kind']): boolean {
  return kind === 'schedule';
}

export function SchedulesPage(): React.JSX.Element {
  const [schedules, setSchedules] = useState<readonly ScheduleSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [, setNowTick] = useState<number>(Date.now());
  // schedule key → what happened to its last "Run now" press
  const [runs, setRuns] = useState<Readonly<Record<string, string>>>({});
  const runNow = (s: ScheduleSummary): void => {
    const key = `${s.namespace}/${s.name}`;
    setRuns((r) => ({ ...r, [key]: 'requesting…' }));
    runScheduleNow(s.namespace, s.name)
      .then(() => setRuns((r) => ({ ...r, [key]: 'requested, starts within a minute' })))
      .catch((err: unknown) =>
        setRuns((r) => ({ ...r, [key]: err instanceof Error ? err.message : String(err) })),
      );
  };

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    const refresh = (): void => {
      fetchSchedules(ac.signal)
        .then((items) => {
          if (cancelled) return;
          setSchedules(items);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    refresh();
    const poll = window.setInterval(refresh, POLL_INTERVAL_MS);
    const unsubscribe = subscribeCacheEvents((ev) => {
      if (isScheduleEvent(ev.kind)) refresh();
    });
    return () => {
      cancelled = true;
      ac.abort();
      window.clearInterval(poll);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Schedules</h1>
          <div className={styles.subtitle}>Cron triggers that dispatch a task per tick</div>
        </div>
      </div>

      {error !== null ? <div className={styles.error}>error: {error}</div> : null}

      {loading && schedules.length === 0 ? (
        <div className={styles.empty}>loading…</div>
      ) : schedules.length === 0 ? (
        <div className={styles.empty}>
          No schedules observed. Apply a <code>KagentSchedule</code> CR to the cluster.
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Namespace</th>
                <th>Cron</th>
                <th>Status</th>
                <th>Target</th>
                <th>Last tick</th>
                <th>Next tick</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => {
                const key = `${s.namespace}/${s.name}`;
                const next = nextTick(s, Date.now());
                return (
                  <tr key={key}>
                    <td className={styles.mono}>{s.name}</td>
                    <td>{s.namespace}</td>
                    <td className={styles.mono}>{s.schedule}</td>
                    <td>
                      <span className={s.suspended ? styles.tagSuspended : styles.tagActive}>
                        {s.suspended ? 'suspended' : 'active'}
                      </span>
                    </td>
                    <td>{s.targetAgent ?? s.targetCapability ?? '—'}</td>
                    <td>{lastTick(s.lastTickAt)}</td>
                    <td className={next.overdue ? styles.overdue : undefined}>{next.text}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.run}
                        disabled={s.suspended}
                        title={s.suspended ? 'A suspended schedule starts nothing' : undefined}
                        onClick={() => runNow(s)}
                      >
                        Run now
                      </button>
                      {runs[key] !== undefined ? (
                        <span className={styles.runNote} role="status">
                          {runs[key]}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
