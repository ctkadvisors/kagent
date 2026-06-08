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
import { ReviewActions } from './command/ReviewActions.js';

export interface TaskDetailProps {
  readonly namespace: string;
  readonly name: string;
  readonly onBack: () => void;
}

function isTerminalPhase(phase: TaskDetail['phase']): boolean {
  return phase === 'Completed' || phase === 'Failed';
}

export function TaskDetail(props: TaskDetailProps): React.JSX.Element {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number>(Date.now());
  const refetchAbortRef = useRef<AbortController | null>(null);
  const terminalDetailRef = useRef(false);

  const refetch = (opts: { readonly force?: boolean } = {}): void => {
    if (terminalDetailRef.current && opts.force !== true) return;
    refetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    refetchAbortRef.current = ctrl;
    fetchTaskDetail(props.namespace, props.name, ctrl.signal)
      .then((d) => {
        terminalDetailRef.current = isTerminalPhase(d.phase);
        setDetail(d);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (refetchAbortRef.current === ctrl) {
          refetchAbortRef.current = null;
        }
      });
  };

  useEffect(() => {
    terminalDetailRef.current = false;
    refetch({ force: true });
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
        <>
          {/* Phase 4 / REV-02 / D-03-A: inline review entry point (above DetailBody).
              ReviewActions returns null when the task does not meet any of the 4 trigger
              conditions (phase===Failed | suspicious.length>0 | review-requested | template-candidate). */}
          <ReviewActions task={detail} onDecision={() => refetch({ force: true })} />
          <DetailBody detail={detail} />
        </>
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

      <EvidencePanel detail={detail} />

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

      {hasRequestEvidence(detail) ? (
        <Section title="Request">
          {detail.originalUserMessage !== undefined ? (
            <KV k="Original user message" v={detail.originalUserMessage} />
          ) : null}
          {detail.expectedTools !== undefined && detail.expectedTools.length > 0 ? (
            <KV k="Expected tools" v={detail.expectedTools.join(', ')} />
          ) : null}
          {detail.parentTask !== undefined ? <KV k="Parent task" v={detail.parentTask} /> : null}
          {detail.parentDistillation !== undefined ? (
            <KV k="Parent distillation" v={detail.parentDistillation} />
          ) : null}
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

interface EvidenceRowModel {
  readonly label: string;
  readonly state: string;
  readonly tone: 'ok' | 'warn' | 'bad' | 'neutral';
  readonly detail: string;
}

function EvidencePanel({ detail }: { detail: TaskDetail }): React.JSX.Element {
  const rows = buildEvidenceRows(detail);
  return (
    <Section title="RC Evidence">
      <div className={detailStyles.evidenceGrid}>
        {rows.map((row) => (
          <div className={detailStyles.evidenceRow} key={row.label}>
            <span className={detailStyles.evidenceLabel}>{row.label}</span>
            <span className={`${detailStyles.evidenceBadge} ${evidenceToneClass(row.tone)}`}>
              {row.state}
            </span>
            <span className={detailStyles.evidenceDetail}>{row.detail}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function buildEvidenceRows(detail: TaskDetail): readonly EvidenceRowModel[] {
  const evidence = detail.pilotEvidence;
  const suspicious = evidence?.structuralVerdict?.suspicious ?? detail.suspicious;
  const artifactCount = evidence?.artifacts.count ?? detail.artifactCount;
  const childCount = evidence?.taskGraph.childCount ?? detail.childCount;
  const aggregatePhase = evidence?.taskGraph.aggregatePhase ?? detail.aggregatePhase;
  const successCount = evidence?.taskGraph.successCount ?? detail.successCount;
  const failureCount = evidence?.taskGraph.failureCount ?? detail.failureCount;
  const inFlightCount = evidence?.taskGraph.inFlightCount ?? detail.inFlightCount;
  const parentTask = evidence?.taskGraph.parentTask ?? detail.parentTask;

  return [
    verificationRow(evidence),
    structuralRow(suspicious),
    traceRow(detail),
    artifactRow(artifactCount),
    taskGraphRow({
      ...(childCount !== undefined && { childCount }),
      ...(aggregatePhase !== undefined && { aggregatePhase }),
      ...(successCount !== undefined && { successCount }),
      ...(failureCount !== undefined && { failureCount }),
      ...(inFlightCount !== undefined && { inFlightCount }),
      ...(parentTask !== undefined && { parentTask }),
    }),
    policyRow(evidence),
    auditRow(evidence),
  ];
}

function verificationRow(evidence: TaskDetail['pilotEvidence']): EvidenceRowModel {
  const verification = evidence?.verification;
  if (verification === undefined) {
    return {
      label: 'Verification',
      state: 'not set',
      tone: 'neutral',
      detail: 'no status.verification result observed',
    };
  }
  return {
    label: 'Verification',
    state: verification.passed ? 'passed' : 'failed',
    tone: verification.passed ? 'ok' : 'bad',
    detail: joinParts([verification.mode, verification.reason, verification.completedAt]),
  };
}

function structuralRow(suspicious: readonly string[] | undefined): EvidenceRowModel {
  if (suspicious === undefined) {
    return {
      label: 'Structural verdict',
      state: 'pending',
      tone: 'neutral',
      detail: 'no detector verdict observed',
    };
  }
  if (suspicious.length === 0) {
    return {
      label: 'Structural verdict',
      state: 'clean',
      tone: 'ok',
      detail: 'no suspicious detector tags',
    };
  }
  return {
    label: 'Structural verdict',
    state: `${suspicious.length.toString()} flag${suspicious.length === 1 ? '' : 's'}`,
    tone: 'warn',
    detail: suspicious.join(', '),
  };
}

function traceRow(detail: TaskDetail): EvidenceRowModel {
  if (detail.traceLink?.url !== undefined) {
    return {
      label: 'Trace',
      state: 'linked',
      tone: 'ok',
      detail: `${detail.traceLink.provider}: ${detail.traceLink.runId}`,
    };
  }
  if (detail.traceLink?.runId !== undefined) {
    return {
      label: 'Trace',
      state: 'run id',
      tone: 'neutral',
      detail: detail.traceLink.runId,
    };
  }
  return {
    label: 'Trace',
    state: 'not linked',
    tone: 'neutral',
    detail: 'LANGFUSE_BASE_URL not configured or task UID missing',
  };
}

function artifactRow(count: number | undefined): EvidenceRowModel {
  if (count === undefined) {
    return {
      label: 'Artifacts',
      state: 'pending',
      tone: 'neutral',
      detail: 'no status.artifacts projection observed',
    };
  }
  return {
    label: 'Artifacts',
    state: count > 0 ? `${count.toString()} ref${count === 1 ? '' : 's'}` : 'none',
    tone: count > 0 ? 'ok' : 'neutral',
    detail:
      count > 0 ? 'metadata references attached to task status' : 'explicit empty artifact set',
  };
}

function taskGraphRow(input: {
  readonly childCount?: number;
  readonly aggregatePhase?: TaskDetail['aggregatePhase'];
  readonly successCount?: number;
  readonly failureCount?: number;
  readonly inFlightCount?: number;
  readonly parentTask?: string;
}): EvidenceRowModel {
  if (input.childCount === undefined && input.parentTask === undefined) {
    return {
      label: 'Task graph',
      state: 'none',
      tone: 'neutral',
      detail: 'no parent or child projection observed',
    };
  }

  const parts = [
    input.parentTask !== undefined ? `parent ${input.parentTask}` : undefined,
    input.childCount !== undefined ? `${input.childCount.toString()} children` : undefined,
    input.successCount !== undefined ? `${input.successCount.toString()} completed` : undefined,
    input.failureCount !== undefined ? `${input.failureCount.toString()} failed` : undefined,
    input.inFlightCount !== undefined ? `${input.inFlightCount.toString()} in flight` : undefined,
  ];
  return {
    label: 'Task graph',
    state: input.aggregatePhase ?? 'linked',
    tone: aggregateTone(input.aggregatePhase),
    detail: joinParts(parts),
  };
}

function policyRow(evidence: TaskDetail['pilotEvidence']): EvidenceRowModel {
  const policy = evidence?.policy;
  if (policy === undefined) {
    return {
      label: 'Policy',
      state: 'unresolved',
      tone: 'neutral',
      detail: 'target agent not present in cache',
    };
  }
  if (!policy.agentResolved) {
    return {
      label: 'Policy',
      state: 'unresolved',
      tone: 'neutral',
      detail: 'target agent not present in cache',
    };
  }
  const parts = [
    policy.maxConcurrentChildren !== undefined
      ? `max children ${policy.maxConcurrentChildren.toString()}`
      : undefined,
    policy.maxInFlightTasks !== undefined
      ? `max in-flight ${policy.maxInFlightTasks.toString()}`
      : undefined,
    policy.allowedChildAgents !== undefined && policy.allowedChildAgents.length > 0
      ? `child agents ${policy.allowedChildAgents.join(', ')}`
      : undefined,
    policy.allowedChildTemplates !== undefined && policy.allowedChildTemplates.length > 0
      ? `child templates ${policy.allowedChildTemplates.join(', ')}`
      : undefined,
    policy.tools !== undefined && policy.tools.length > 0
      ? `tools ${policy.tools.join(', ')}`
      : undefined,
  ];
  return {
    label: 'Policy',
    state: parts.some((p) => p !== undefined) ? 'declared' : 'not declared',
    tone: 'neutral',
    detail: joinParts(parts),
  };
}

function auditRow(evidence: TaskDetail['pilotEvidence']): EvidenceRowModel {
  const audit = evidence?.audit;
  if (audit === undefined) {
    return {
      label: 'Audit stamps',
      state: 'missing',
      tone: 'neutral',
      detail: 'no evidence metadata returned by API',
    };
  }
  const labelCount = Object.keys(audit.labels).length;
  const annotationCount = Object.keys(audit.annotations).length;
  const parts = [
    audit.tenant !== undefined ? `tenant ${audit.tenant}` : undefined,
    audit.createdBy !== undefined ? `created by ${audit.createdBy}` : undefined,
    audit.managedBy !== undefined ? `managed by ${audit.managedBy}` : undefined,
    audit.parentTaskUid !== undefined ? `parent uid ${audit.parentTaskUid}` : undefined,
    evidence?.capabilityRef !== undefined ? `cap ${evidence.capabilityRef}` : undefined,
    `${labelCount.toString()} labels`,
    `${annotationCount.toString()} annotations`,
  ];
  return {
    label: 'Audit stamps',
    state: labelCount + annotationCount > 0 ? 'present' : 'none',
    tone: labelCount + annotationCount > 0 ? 'ok' : 'neutral',
    detail: joinParts(parts),
  };
}

function aggregateTone(phase: TaskDetail['aggregatePhase'] | undefined): EvidenceRowModel['tone'] {
  switch (phase) {
    case 'AllComplete':
      return 'ok';
    case 'AnyFailed':
      return 'bad';
    case 'PartiallyComplete':
    case 'Dispatched':
    case 'Pending':
      return 'warn';
    default:
      return 'neutral';
  }
}

function evidenceToneClass(tone: EvidenceRowModel['tone']): string {
  switch (tone) {
    case 'ok':
      return detailStyles.evidenceOk ?? '';
    case 'warn':
      return detailStyles.evidenceWarn ?? '';
    case 'bad':
      return detailStyles.evidenceBad ?? '';
    case 'neutral':
      return detailStyles.evidenceNeutral ?? '';
    default:
      return '';
  }
}

function joinParts(parts: ReadonlyArray<string | undefined>): string {
  const present = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return present.length > 0 ? present.join(' · ') : '—';
}

function hasRequestEvidence(detail: TaskDetail): boolean {
  return (
    detail.originalUserMessage !== undefined ||
    (detail.expectedTools !== undefined && detail.expectedTools.length > 0) ||
    detail.parentTask !== undefined ||
    detail.parentDistillation !== undefined
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
