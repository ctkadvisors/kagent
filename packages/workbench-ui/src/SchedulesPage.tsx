/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Schedules page — read-only surface for `KagentSchedule` CRs (cron
 * triggers that materialize a fresh AgentTask per tick). Single table,
 * SSE-driven refresh, matching the Cluster/Gateway pages' "Observe"
 * posture. No write surface in v0.2 — suspend/resume is a `kubectl`
 * operation until a PATCH route lands.
 */

import { useEffect, useState } from 'react';

import { fetchSchedules, subscribeCacheEvents } from './api.js';
import styles from './SchedulesPage.module.css';
import type { CacheChangeEvent, ScheduleSummary } from './types.js';

const POLL_INTERVAL_MS = 5_000;

function formatAge(iso: string | undefined): string {
  if (iso === undefined) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  if (ms < 0) return 'due';
  if (ms < 60_000) return `${Math.floor(ms / 1000).toString()}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000).toString()}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000).toString()}h`;
  return `${Math.floor(ms / 86_400_000).toString()}d`;
}

function isScheduleEvent(kind: CacheChangeEvent['kind']): boolean {
  return kind === 'schedule';
}

export function SchedulesPage(): React.JSX.Element {
  const [schedules, setSchedules] = useState<readonly ScheduleSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [, setNowTick] = useState<number>(Date.now());

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
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={`${s.namespace}/${s.name}`}>
                  <td className={styles.mono}>{s.name}</td>
                  <td>{s.namespace}</td>
                  <td className={styles.mono}>{s.schedule}</td>
                  <td>
                    <span className={s.suspended ? styles.tagSuspended : styles.tagActive}>
                      {s.suspended ? 'suspended' : 'active'}
                    </span>
                  </td>
                  <td>{s.targetAgent ?? s.targetCapability ?? '—'}</td>
                  <td>{formatAge(s.lastTickAt)} ago</td>
                  <td>{s.nextTickAt !== undefined ? `in ${formatAge(s.nextTickAt)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
