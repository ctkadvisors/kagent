/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchChannelDetail,
  fetchChannels,
  setChannelPaused,
  subscribeCacheEvents,
} from './api.js';
import type {
  ExternalChannelBindingSummary,
  ExternalChannelDetail,
  ExternalChannelSessionSummary,
  ExternalChannelSummary,
} from './types.js';
import styles from './ChannelsPage.module.css';

const STALE_MS = 60_000;

export function ChannelsPage(): React.JSX.Element {
  const [channels, setChannels] = useState<readonly ExternalChannelSummary[]>([]);
  const [detail, setDetail] = useState<ExternalChannelDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastEventAt, setLastEventAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const channelsRef = useRef<readonly ExternalChannelSummary[]>([]);
  const detailRef = useRef<ExternalChannelDetail | null>(null);

  const selected = useMemo(
    () => channels.find((channel) => channel.id === selectedId) ?? null,
    [channels, selectedId],
  );

  const refreshChannels = (): void => {
    listAbortRef.current?.abort();
    const ctrl = new AbortController();
    listAbortRef.current = ctrl;
    fetchChannels(ctrl.signal)
      .then((items) => {
        channelsRef.current = items;
        setChannels(items);
        setSelectedId((current) => current ?? items[0]?.id ?? null);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const refreshDetail = (channel: ExternalChannelSummary): void => {
    detailAbortRef.current?.abort();
    const ctrl = new AbortController();
    detailAbortRef.current = ctrl;
    fetchChannelDetail(channel.namespace, channel.name, ctrl.signal)
      .then((next) => {
        detailRef.current = next;
        setDetail(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        detailRef.current = null;
        setDetail(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    refreshChannels();
    const unsubscribe = subscribeCacheEvents(
      (ev) => {
        setLastEventAt(Date.now());
        if (isChannelEvent(ev.kind)) {
          refreshChannels();
          const currentId = selectedIdRef.current;
          const current =
            currentId === null
              ? null
              : channelsRef.current.find((channel) => channel.id === currentId) ??
                detailRef.current;
          if (current !== null) refreshDetail(current);
        }
      },
      () => {
        setLastEventAt(Date.now());
      },
    );
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      unsubscribe();
      clearInterval(tick);
      listAbortRef.current?.abort();
      detailAbortRef.current?.abort();
    };
    // Mount-time stream. Refresh helpers intentionally close over setters.
  }, []);

  useEffect(() => {
    const next = selected;
    if (next !== null) {
      refreshDetail(next);
    }
  }, [selected]);

  const onSelect = (channel: ExternalChannelSummary): void => {
    setSelectedId(channel.id);
  };

  const onTogglePaused = (): void => {
    const current = detail ?? selected;
    if (current === null) return;
    const nextPaused = !current.paused;
    setSaving(true);
    setError(null);
    setChannelPaused(current.namespace, current.name, nextPaused)
      .then(() => {
        setChannels((items) =>
          items.map((item) => (item.id === current.id ? { ...item, paused: nextPaused } : item)),
        );
        setDetail((prev) => {
          const next = prev === null ? prev : { ...prev, paused: nextPaused };
          detailRef.current = next;
          return next;
        });
        refreshChannels();
        refreshDetail(current);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const stale = now - lastEventAt > STALE_MS;
  const activeDetail = detail;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Channels</h1>
          <div className={styles.subtitle}>External accounts, routing bindings, and sessions</div>
        </div>
        <span className={styles.connection}>
          {stale
            ? `stream stale ${Math.floor((now - lastEventAt) / 1000).toString()}s`
            : 'stream live'}
        </span>
      </div>

      {error !== null ? <div className={styles.error}>error: {error}</div> : null}

      <div className={styles.layout}>
        <aside className={styles.channelsPane} aria-label="Channels">
          {channels.length === 0 ? (
            <div className={styles.empty}>No channels observed.</div>
          ) : (
            channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className={`${styles.channelButton} ${
                  channel.id === selectedId ? styles.channelButtonActive : ''
                }`}
                onClick={() => onSelect(channel)}
              >
                <span className={styles.channelTop}>
                  <span className={styles.channelName}>{channel.name}</span>
                  <span className={phaseClass(channel.phase, channel.paused, styles)}>
                    {channel.paused ? 'Paused' : channel.phase ?? 'Pending'}
                  </span>
                </span>
                <span className={styles.channelMeta}>
                  {channel.provider} · {channel.accountId}
                </span>
                <span className={styles.channelPreview}>
                  {pairingLabel(channel)} · {channel.bindingCount.toString()} bindings ·{' '}
                  {channel.sessionCount.toString()} sessions
                </span>
              </button>
            ))
          )}
        </aside>

        <section className={styles.detailPane} aria-label="Channel detail">
          {activeDetail === null ? (
            <div className={styles.empty}>Select a channel.</div>
          ) : (
            <>
              <div className={styles.summaryBand}>
                <div>
                  <div className={styles.eyebrow}>{activeDetail.namespace}</div>
                  <h2 className={styles.detailTitle}>
                    {activeDetail.displayName ?? activeDetail.name}
                  </h2>
                  <div className={styles.detailMeta}>
                    {activeDetail.provider} · account {activeDetail.accountId}
                  </div>
                </div>
                <div className={styles.statusGrid}>
                  <Metric label="Pairing" value={pairingLabel(activeDetail)} />
                  <Metric label="DM policy" value={dmPolicyLabel(activeDetail.policy.dmPolicy)} />
                  <Metric
                    label="Group policy"
                    value={groupPolicyLabel(activeDetail.policy.groupPolicy)}
                  />
                  <Metric label="Active sessions" value={activeDetail.activeSessionCount.toString()} />
                </div>
                <button
                  type="button"
                  className={activeDetail.paused ? styles.resumeButton : styles.pauseButton}
                  disabled={saving}
                  onClick={onTogglePaused}
                >
                  {activeDetail.paused ? 'Resume channel' : 'Pause channel'}
                </button>
              </div>

              <div className={styles.infoGrid}>
                <section className={styles.panel}>
                  <h3 className={styles.panelTitle}>Policy</h3>
                  <div className={styles.policyRows}>
                    <PolicyRow label="DM" value={dmPolicyLabel(activeDetail.policy.dmPolicy)} />
                    <PolicyRow
                      label="Allowed senders"
                      value={listValue(activeDetail.policy.allowFrom)}
                    />
                    <PolicyRow
                      label="Groups"
                      value={`${groupPolicyLabel(activeDetail.policy.groupPolicy)} · ${listValue(
                        activeDetail.policy.groups,
                      )}`}
                    />
                    {activeDetail.lastDeniedInbound !== undefined ? (
                      <>
                        <PolicyRow
                          label="Last denied inbound"
                          value={activeDetail.lastDeniedInbound.reason}
                        />
                        <PolicyRow
                          label="Denied peer"
                          value={peerLabel(activeDetail.lastDeniedInbound.peer)}
                        />
                        <PolicyRow
                          label="Denied sender"
                          value={senderLabel(activeDetail.lastDeniedInbound.sender)}
                        />
                        <PolicyRow
                          label="Denied at"
                          value={formatTime(activeDetail.lastDeniedInbound.at)}
                        />
                      </>
                    ) : null}
                  </div>
                </section>

                <section className={styles.panel}>
                  <h3 className={styles.panelTitle}>Pairing</h3>
                  <div className={styles.policyRows}>
                    <PolicyRow label="State" value={pairingLabel(activeDetail)} />
                    <PolicyRow
                      label="QR material"
                      value={activeDetail.pairing?.qrAvailable === true ? 'available' : 'not present'}
                    />
                    <PolicyRow
                      label="Expires"
                      value={formatTime(activeDetail.pairing?.expiresAt)}
                    />
                    <PolicyRow label="Heartbeat" value={formatTime(activeDetail.lastHeartbeatAt)} />
                  </div>
                  {activeDetail.pairing?.qrAvailable === true ? (
                    <div className={styles.qrFrame}>
                      <img
                        className={styles.qrImage}
                        src={pairingQrSrc(activeDetail)}
                        alt={pairingQrAlt(activeDetail)}
                      />
                    </div>
                  ) : null}
                </section>
              </div>

              <section className={styles.panel}>
                <h3 className={styles.panelTitle}>Bindings</h3>
                <BindingTable bindings={activeDetail.bindings} />
              </section>

              <section className={styles.panel}>
                <h3 className={styles.panelTitle}>Sessions</h3>
                <SessionTable sessions={activeDetail.sessions} />
              </section>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Metric(props: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{props.label}</span>
      <span className={styles.metricValue}>{props.value}</span>
    </div>
  );
}

function PolicyRow(props: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className={styles.policyRow}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function BindingTable(props: {
  readonly bindings: readonly ExternalChannelBindingSummary[];
}): React.JSX.Element {
  if (props.bindings.length === 0) return <div className={styles.emptyInline}>No bindings.</div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Match</th>
            <th>Target</th>
            <th>Run</th>
            <th>Approval</th>
          </tr>
        </thead>
        <tbody>
          {props.bindings.map((binding) => (
            <tr key={`${binding.namespace}/${binding.name}`}>
              <td>
                <span className={styles.mono}>{binding.name}</span>
                {binding.default ? <span className={styles.tag}>default</span> : null}
                {binding.paused ? <span className={styles.tagDanger}>paused</span> : null}
              </td>
              <td>{bindingMatch(binding)}</td>
              <td>{targetLabel(binding.target)}</td>
              <td>{runConfigLabel(binding.target.runConfig)}</td>
              <td>{binding.approval?.required === true ? binding.approval.mode ?? 'required' : 'none'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionTable(props: {
  readonly sessions: readonly ExternalChannelSessionSummary[];
}): React.JSX.Element {
  if (props.sessions.length === 0) return <div className={styles.emptyInline}>No sessions.</div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Session</th>
            <th>Peer</th>
            <th>Binding</th>
            <th>Activity</th>
            <th>Last task</th>
          </tr>
        </thead>
        <tbody>
          {props.sessions.map((session) => (
            <tr key={`${session.namespace}/${session.name}`}>
              <td>
                <span className={styles.mono}>{session.name}</span>
                {session.phase !== undefined ? <span className={styles.tag}>{session.phase}</span> : null}
                {session.backoffUntil !== undefined ? (
                  <span className={styles.tagDanger}>backoff</span>
                ) : null}
              </td>
              <td>
                {session.peer.kind}:{session.peer.id}
              </td>
              <td>{session.bindingRef ?? 'none'}</td>
              <td>{formatTime(session.lastInboundAt ?? session.lastOutboundAt)}</td>
              <td>
                {session.lastTask !== undefined ? (
                  <a className={styles.taskLink} href={session.lastTask.ui.replace(/^\/#/, '#')}>
                    open task {session.lastTask.name}
                  </a>
                ) : (
                  'none'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isChannelEvent(kind: string): boolean {
  return (
    kind === 'channel' ||
    kind === 'channelBinding' ||
    kind === 'channelSession' ||
    kind === 'task'
  );
}

function pairingLabel(channel: ExternalChannelSummary): string {
  const pairing = channel.pairing;
  if (pairing?.state === 'qr' && pairing.qrAvailable) return 'QR ready';
  if (pairing?.state === 'paired') return 'Paired';
  if (pairing?.state === 'failed') return 'Pairing failed';
  if (pairing?.state === 'unpaired') return 'Unpaired';
  return pairing?.state ?? channel.phase ?? 'Pending';
}

function dmPolicyLabel(value: string): string {
  if (value === 'pairing') return 'DM pairing';
  if (value === 'allowlist') return 'DM allowlist';
  if (value === 'open') return 'DM open';
  if (value === 'disabled') return 'DM disabled';
  return value;
}

function groupPolicyLabel(value: string): string {
  if (value === 'allowlist') return 'Groups allowlist';
  if (value === 'open') return 'Groups open';
  if (value === 'disabled') return 'Groups disabled';
  return value;
}

function targetLabel(target: ExternalChannelBindingSummary['target']): string {
  return target.agentRef ?? target.capability ?? target.profileRef ?? target.modelClass ?? 'default';
}

function bindingMatch(binding: ExternalChannelBindingSummary): string {
  const match = binding.match;
  if (match === undefined) return binding.default ? 'fallback' : 'any';
  const parts = [
    match.accountId !== undefined ? `account:${match.accountId}` : undefined,
    match.peer !== undefined ? `${match.peer.kind}:${match.peer.id}` : undefined,
    match.threadId !== undefined ? `thread:${match.threadId}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : 'any';
}

function peerLabel(peer: { readonly kind: string; readonly id: string }): string {
  return `${peer.kind}:${peer.id}`;
}

function senderLabel(
  sender: { readonly id: string; readonly displayName?: string } | undefined,
): string {
  if (sender === undefined) return 'none';
  return sender.displayName ?? sender.id;
}

function runConfigLabel(
  runConfig: Readonly<Record<string, number | string | boolean>> | undefined,
): string {
  if (runConfig === undefined) return 'defaults';
  const parts = Object.entries(runConfig).map(([key, value]) => `${key}:${String(value)}`);
  return parts.length > 0 ? parts.join(' · ') : 'defaults';
}

function listValue(values: readonly string[]): string {
  if (values.length === 0) return 'none';
  if (values.length <= 3) return values.join(', ');
  return `${values.slice(0, 3).join(', ')} +${String(values.length - 3)}`;
}

function formatTime(value: string | undefined): string {
  if (value === undefined || value.length === 0) return 'none';
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function pairingQrSrc(channel: ExternalChannelSummary): string {
  return `/api/channels/${encodeURIComponent(channel.namespace)}/${encodeURIComponent(
    channel.name,
  )}/pairing-qr.svg`;
}

function pairingQrAlt(channel: ExternalChannelSummary): string {
  const label = channel.displayName ?? channel.name;
  const provider = channel.provider === 'whatsapp' ? 'WhatsApp' : channel.provider;
  return `${provider} pairing QR for ${label}`;
}

function phaseClass(
  phase: string | undefined,
  paused: boolean,
  css: typeof styles,
): string {
  const base = css.phase ?? '';
  if (paused) return `${base} ${css.phasePaused ?? ''}`;
  if (phase === 'Ready') return `${base} ${css.phaseReady ?? ''}`;
  if (phase === 'Failed') return `${base} ${css.phaseFailed ?? ''}`;
  return base;
}
