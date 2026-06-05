/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AppShell — persistent navigational spine for the Workbench.
 *
 * Wraps every "boardroom" route (Architect, Tasks, Cluster, Gateway,
 * Review) in a left rail grouped by the agent lifecycle
 * (Create → Operate → Observe → Govern) plus a top bar carrying global
 * KPIs that were previously trapped inside the Command Center. The
 * Command Center itself renders full-bleed (outside the shell) to keep
 * its immersive RTS canvas — see App.tsx.
 *
 * KPIs + the Review badge are derived from the same SSE-backed data the
 * pages use (fetchTasks / fetchReviewQueue / subscribeCacheEvents), so
 * the chrome stays live without bespoke endpoints. All fetches are
 * best-effort: a failure degrades to a dash, never an error screen.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { fetchReviewQueue, fetchTasks, subscribeCacheEvents } from './api.js';
import type { AgentTaskPhase, TaskSummary } from './types.js';
import styles from './AppShell.module.css';

const STALE_MS = 60_000;

type IconKey = 'architect' | 'command' | 'tasks' | 'cluster' | 'gateway' | 'review';

interface NavItem {
  readonly hash: string;
  readonly label: string;
  readonly icon: IconKey;
  readonly badge?: 'review';
}
interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

const NAV: readonly NavGroup[] = [
  { label: 'Create', items: [{ hash: '#/architect', label: 'Architect', icon: 'architect' }] },
  {
    label: 'Operate',
    items: [
      { hash: '#/command', label: 'Command Center', icon: 'command' },
      { hash: '#/', label: 'Tasks', icon: 'tasks' },
    ],
  },
  {
    label: 'Observe',
    items: [
      { hash: '#/cluster', label: 'Cluster', icon: 'cluster' },
      { hash: '#/gateway', label: 'Gateway', icon: 'gateway' },
    ],
  },
  {
    label: 'Govern',
    items: [{ hash: '#/review', label: 'Review', icon: 'review', badge: 'review' }],
  },
];

const TITLES: Record<string, string> = {
  '#/architect': 'Architect — chat to create',
  '#/': 'Tasks',
  '#/cluster': 'Cluster',
  '#/gateway': 'Gateway',
  '#/review': 'Review Queue',
};

function Icon({ name }: { name: IconKey }): React.JSX.Element {
  const p = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const paths: Record<IconKey, ReactNode> = {
    architect: (
      <>
        <path {...p} d="M5 3v4M3 5h4M6 17v4M4 19h4" />
        <path {...p} d="M13 4l2.5 6L22 12l-6.5 2L13 20l-2.5-6L4 12l6.5-2L13 4z" />
      </>
    ),
    command: (
      <>
        <rect {...p} x="3" y="3" width="7" height="7" rx="1.5" />
        <rect {...p} x="14" y="3" width="7" height="7" rx="1.5" />
        <rect {...p} x="3" y="14" width="7" height="7" rx="1.5" />
        <rect {...p} x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    tasks: (
      <>
        <path {...p} d="M8 6h13M8 12h13M8 18h13" />
        <path {...p} d="M3 6h.01M3 12h.01M3 18h.01" />
      </>
    ),
    cluster: (
      <>
        <rect {...p} x="3" y="4" width="18" height="6" rx="1.5" />
        <rect {...p} x="3" y="14" width="18" height="6" rx="1.5" />
        <path {...p} d="M7 7h.01M7 17h.01" />
      </>
    ),
    gateway: (
      <>
        <path {...p} d="M4 8l4 4-4 4M20 8l-4 4 4 4" />
        <path {...p} d="M14 4l-4 16" />
      </>
    ),
    review: (
      <>
        <path {...p} d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
        <path {...p} d="M9 12l2 2 4-4" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function normalizeHash(raw: string): string {
  const clean = raw.replace(/^#\/?/, '').replace(/\/$/, '');
  if (clean === '') return '#/';
  return `#/${clean}`;
}

export interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps): React.JSX.Element {
  const [hash, setHash] = useState<string>(() => normalizeHash(window.location.hash));
  const [counts, setCounts] = useState<Record<AgentTaskPhase, number>>({
    Pending: 0,
    Dispatched: 0,
    Completed: 0,
    Failed: 0,
  });
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number>(Date.now());
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    const onHash = (): void => {
      setHash(normalizeHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const tally = (tasks: readonly TaskSummary[]): void => {
      const next: Record<AgentTaskPhase, number> = {
        Pending: 0,
        Dispatched: 0,
        Completed: 0,
        Failed: 0,
      };
      for (const t of tasks) {
        if (t.phase !== undefined) next[t.phase] += 1;
      }
      if (alive) setCounts(next);
    };
    const refresh = (): void => {
      fetchTasks()
        .then(tally)
        .catch(() => {
          /* best-effort chrome */
        });
      fetchReviewQueue()
        .then((rows) => {
          if (alive) setReviewCount(rows.length);
        })
        .catch(() => {
          /* best-effort chrome */
        });
    };
    refresh();
    const unsubscribe = subscribeCacheEvents(
      () => {
        setLastEventAt(Date.now());
        refresh();
      },
      () => {
        setLastEventAt(Date.now());
      },
    );
    const tick = setInterval(() => {
      setNow(Date.now());
    }, 5_000);
    return () => {
      alive = false;
      unsubscribe();
      clearInterval(tick);
    };
  }, []);

  const stale = now - lastEventAt > STALE_MS;
  const title = TITLES[hash] ?? 'Workbench';

  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="Primary">
        <div className={styles.brand}>
          <div className={styles.brandMark}>k</div>
          <div className={styles.brandText}>
            <span className={styles.brandName}>kagent</span>
            <span className={styles.brandSub}>Mission Control</span>
          </div>
        </div>

        {NAV.map((group) => (
          <div className={styles.group} key={group.label}>
            <div className={styles.groupLabel}>{group.label}</div>
            {group.items.map((item) => {
              const active = hash === normalizeHash(item.hash);
              const showBadge = item.badge === 'review' && reviewCount !== null && reviewCount > 0;
              return (
                <a
                  key={item.hash}
                  href={item.hash}
                  className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className={styles.icon}>
                    <Icon name={item.icon} />
                  </span>
                  {item.label}
                  {showBadge ? <span className={styles.badge}>{reviewCount}</span> : null}
                </a>
              );
            })}
          </div>
        ))}

        <div className={styles.railFooter}>kagent · k3s homelab</div>
      </nav>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <span className={styles.sectionTitle}>{title}</span>
          <div className={styles.kpis}>
            <span className={`${styles.kpi} ${styles.kpiActive}`}>
              <span className={styles.kpiNum}>{counts.Dispatched}</span>
              <span className={styles.kpiLabel}>Active</span>
            </span>
            <span className={`${styles.kpi} ${styles.kpiWarn}`}>
              <span className={styles.kpiNum}>{counts.Pending}</span>
              <span className={styles.kpiLabel}>Pending</span>
            </span>
            <span className={`${styles.kpi} ${styles.kpiOk}`}>
              <span className={styles.kpiNum}>{counts.Completed}</span>
              <span className={styles.kpiLabel}>Done</span>
            </span>
            <span className={`${styles.kpi} ${styles.kpiDanger}`}>
              <span className={styles.kpiNum}>{counts.Failed}</span>
              <span className={styles.kpiLabel}>Failed</span>
            </span>
          </div>
          <div className={styles.live}>
            <span className={`${styles.dot} ${stale ? styles.dotStale : ''}`} />
            {stale ? 'stream stale' : 'stream live'}
          </div>
        </header>

        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
