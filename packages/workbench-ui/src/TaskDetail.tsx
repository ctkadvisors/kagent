/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * TaskDetail — single-task detail view.
 *
 * Lifecycle:
 *
 *   1. On mount: fetch /api/tasks/:namespace/:name once.
 *   2. Subscribe to /api/stream and refetch this task on relevant events
 *      (any cache event whose key matches this task's namespace/name).
 *      Cheap because the API serves from in-memory cache.
 *   3. Stale-stream chip mirrors TaskList for consistency.
 *
 * Routing: hash-based (`#/tasks/:namespace/:name`). No router lib —
 * the UI is small enough that hash + a `useHashRoute` hook is the
 * lowest-cost option that survives same-origin reload.
 */

import { useEffect, useRef, useState } from 'react';

import { fetchTaskDetail, subscribeCacheEvents } from './api.js';
import type { ContainerStatusSummary, TaskDetail } from './types.js';
import styles from './TaskList.module.css';
import detailStyles from './TaskDetail.module.css';

export interface TaskDetailProps {
  readonly namespace: string;
  readonly name: string;
  readonly onBack: () => void;
}

export function TaskDetail(props: TaskDetailProps): React.JSX.Element {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number>(Date.now());
  const refetchAbortRef = useRef<AbortController | null>(null);

  const refetch = (): void => {
    refetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    refetchAbortRef.current = ctrl;
    fetchTaskDetail(props.namespace, props.name, ctrl.signal)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  useEffect(() => {
    refetch();
    const targetKey = `${props.namespace}/${props.name}`;
    const unsubscribe = subscribeCacheEvents(
      (ev) => {
        setLastEventAt(Date.now());
        // Task events carry the task key. Job/Pod names are not stable
        // enough to reverse-map from the event alone, so refetch on any
        // Job/Pod event; detail views are few and the API serves from
        // memory.
        if (ev.key === targetKey || ev.kind === 'job' || ev.kind === 'pod') {
          refetch();
        }
      },
      () => {
        setLastEventAt(Date.now());
      },
    );
    return () => {
      unsubscribe();
      refetchAbortRef.current?.abort();
    };
    // Effect intentionally re-runs when the route changes.
  }, [props.namespace, props.name]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h1 className={styles.title}>
          <button type="button" onClick={props.onBack} className={detailStyles.backLink}>
            ← Tasks
          </button>{' '}
          <span className={detailStyles.titleNs}>{props.namespace}/</span>
          {props.name}
        </h1>
        <span className={styles.connection}>
          last event {Math.floor((Date.now() - lastEventAt) / 1000).toString()}s ago
        </span>
      </div>

      {error !== null ? <div className={styles.error}>error: {error}</div> : null}

      {detail === null && error === null ? (
        <div className={styles.empty}>Loading…</div>
      ) : detail !== null ? (
        <DetailBody detail={detail} />
      ) : null}
    </div>
  );
}

function DetailBody({ detail }: { detail: TaskDetail }): React.JSX.Element {
  return (
    <>
      <Section title="Identity">
        <KV k="UID" v={detail.uid} />
        <KV k="Phase" v={detail.phase ?? '—'} />
        {detail.aggregatePhase !== undefined ? (
          <KV k="Aggregate phase (children)" v={detail.aggregatePhase} />
        ) : null}
        <KV
          k="Target"
          v={
            detail.targetAgent ??
            (detail.targetCapability !== undefined ? `cap:${detail.targetCapability}` : '—')
          }
        />
        {detail.model !== undefined ? <KV k="Model" v={detail.model} /> : null}
        {detail.podName !== undefined ? <KV k="Pod" v={detail.podName} /> : null}
        {detail.createdAt !== undefined ? <KV k="Created" v={detail.createdAt} /> : null}
        {detail.startedAt !== undefined ? <KV k="Started" v={detail.startedAt} /> : null}
        {detail.completedAt !== undefined ? <KV k="Completed" v={detail.completedAt} /> : null}
        {detail.error !== undefined ? <KV k="Error" v={detail.error} /> : null}
        {detail.suspicious !== undefined && detail.suspicious.length > 0 ? (
          <KV k="Suspicious" v={detail.suspicious.join(', ')} />
        ) : null}
        {detail.traceLink !== undefined ? (
          <div className={detailStyles.kvRow}>
            <span className={detailStyles.kvKey}>Trace</span>
            <span className={detailStyles.kvVal}>
              {detail.traceLink.url !== undefined ? (
                <a
                  href={detail.traceLink.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={detailStyles.traceLink}
                >
                  open in {detail.traceLink.provider}
                </a>
              ) : (
                <code className={detailStyles.code}>runId: {detail.traceLink.runId}</code>
              )}
            </span>
          </div>
        ) : null}
      </Section>

      {detail.containerStatuses.length > 0 ? (
        <Section title="Containers">
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>State</th>
                <th>Ready</th>
                <th>Restarts</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {detail.containerStatuses.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>{containerStateLabel(c)}</td>
                  <td>{c.ready === undefined ? '—' : c.ready ? 'yes' : 'no'}</td>
                  <td>{c.restartCount?.toString() ?? '0'}</td>
                  <td className={detailStyles.containerDetailCell}>
                    {containerStateDetail(c) ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {detail.children !== undefined && detail.children.length > 0 ? (
        <Section title="Children">
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Namespace</th>
                <th>Phase</th>
              </tr>
            </thead>
            <tbody>
              {detail.children.map((child) => (
                <tr key={child.uid ?? `${child.namespace ?? ''}/${child.name}`}>
                  <td>
                    <a
                      href={`#/tasks/${encodeURIComponent(child.namespace ?? 'default')}/${encodeURIComponent(child.name)}`}
                      className={detailStyles.linkCell}
                    >
                      {child.name}
                    </a>
                  </td>
                  <td>{child.namespace ?? '—'}</td>
                  <td>
                    {child.phase !== undefined ? (
                      <span className={`${styles.phasePill} ${phaseClass(child.phase)}`}>
                        {child.phase}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {detail.artifacts !== undefined && detail.artifacts.length > 0 ? (
        <Section title="Artifacts">
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Media</th>
                <th>Size</th>
                <th>URI</th>
              </tr>
            </thead>
            <tbody>
              {detail.artifacts.map((a) => (
                <tr key={a.uri}>
                  <td>{a.name ?? '—'}</td>
                  <td>{a.mediaType ?? '—'}</td>
                  <td>{a.sizeBytes !== undefined ? `${a.sizeBytes.toString()} B` : '—'}</td>
                  <td>
                    <code className={detailStyles.code}>{a.uri}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {detail.payload !== undefined ? (
        <Section title="Payload">
          <Pre json={detail.payload} />
        </Section>
      ) : null}

      {detail.result !== undefined ? (
        <Section title="Result">
          <Pre json={detail.result} />
        </Section>
      ) : null}
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={detailStyles.section}>
      <h2 className={detailStyles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

function KV({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className={detailStyles.kvRow}>
      <span className={detailStyles.kvKey}>{k}</span>
      <span className={detailStyles.kvVal}>{v}</span>
    </div>
  );
}

function Pre({ json }: { json: unknown }): React.JSX.Element {
  let text: string;
  try {
    text = JSON.stringify(json, null, 2);
  } catch {
    text = String(json);
  }
  return <pre className={detailStyles.pre}>{text}</pre>;
}

function containerStateLabel(c: ContainerStatusSummary): string {
  if (c.state?.terminated !== undefined) return 'terminated';
  if (c.state?.running !== undefined) return 'running';
  if (c.state?.waiting !== undefined) return 'waiting';
  return '—';
}

function containerStateDetail(c: ContainerStatusSummary): string | null {
  if (c.state?.terminated !== undefined) {
    const t = c.state.terminated;
    const parts: string[] = [];
    if (t.reason !== undefined) parts.push(t.reason);
    if (typeof t.exitCode === 'number') parts.push(`exit ${t.exitCode.toString()}`);
    if (t.message !== undefined) parts.push(t.message);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (c.state?.waiting !== undefined) {
    const w = c.state.waiting;
    const parts: string[] = [];
    if (w.reason !== undefined) parts.push(w.reason);
    if (w.message !== undefined) parts.push(w.message);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  return null;
}

function phaseClass(phase: NonNullable<TaskDetail['phase']>): string {
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
