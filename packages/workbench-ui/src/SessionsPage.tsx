/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchAgents,
  fetchSessionDetail,
  fetchSessionProfiles,
  fetchSessions,
  sendSessionMessage,
  subscribeCacheEvents,
  terminateTask,
} from './api.js';
import type {
  AgentSummaryRow,
  ChannelSessionDetail,
  ChannelSessionSummary,
  SendSessionMessageResponse,
  SessionProfile,
} from './types.js';
import styles from './SessionsPage.module.css';

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_ITERATIONS = 8;
const STALE_MS = 60_000;

export interface SessionsPageProps {
  readonly initialSessionId?: string;
}

export function SessionsPage({ initialSessionId }: SessionsPageProps): React.JSX.Element {
  const [sessions, setSessions] = useState<readonly ChannelSessionSummary[]>([]);
  const [detail, setDetail] = useState<ChannelSessionDetail | null>(null);
  const [agents, setAgents] = useState<readonly AgentSummaryRow[]>([]);
  const [profiles, setProfiles] = useState<readonly SessionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId ?? null);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [targetAgent, setTargetAgent] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [createdTask, setCreatedTask] = useState<SendSessionMessageResponse['task'] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stoppingTask, setStoppingTask] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const agentsAbortRef = useRef<AbortController | null>(null);
  const profilesAbortRef = useRef<AbortController | null>(null);
  const sessionsRef = useRef<readonly ChannelSessionSummary[]>([]);
  const detailRef = useRef<ChannelSessionDetail | null>(null);
  const selectedIdRef = useRef<string | null>(initialSessionId ?? null);
  const targetSeedSessionRef = useRef<string | null>(null);
  const profilesRef = useRef<readonly SessionProfile[]>([]);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [selectedId, sessions],
  );
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.name === targetAgent) ?? null,
    [agents, targetAgent],
  );
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );
  const displayTarget =
    selectedProfile?.profileName ??
    detail?.targetAgent ??
    selectedSession?.targetAgent ??
    targetAgent;

  const refreshSessions = (): void => {
    listAbortRef.current?.abort();
    const ctrl = new AbortController();
    listAbortRef.current = ctrl;
    fetchSessions(ctrl.signal)
      .then((items) => {
        sessionsRef.current = items;
        setSessions(items);
        setError(null);
        setSelectedId((current) => current ?? initialSessionId ?? items[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const refreshDetail = (sessionId: string): void => {
    detailAbortRef.current?.abort();
    const ctrl = new AbortController();
    detailAbortRef.current = ctrl;
    fetchSessionDetail(sessionId, ctrl.signal)
      .then((next) => {
        detailRef.current = next;
        setDetail(next);
        setSelectedProfileId((current) => {
          const match = profileIdForTarget(profilesRef.current, next.namespace, next.targetAgent);
          if (targetSeedSessionRef.current !== next.id) {
            return match ?? current;
          }
          return current || match || chooseDefaultProfile(profilesRef.current);
        });
        setTargetAgent((current) => {
          if (targetSeedSessionRef.current !== next.id) {
            targetSeedSessionRef.current = next.id;
            return next.targetAgent ?? (current || chooseDefaultAgent(agents));
          }
          return current || next.targetAgent || chooseDefaultAgent(agents);
        });
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
    refreshSessions();
    agentsAbortRef.current?.abort();
    const agentsCtrl = new AbortController();
    agentsAbortRef.current = agentsCtrl;
    fetchAgents(agentsCtrl.signal)
      .then((items) => {
        setAgents(items);
        setTargetAgent((current) => {
          if (current.length > 0) return current;
          if (selectedIdRef.current !== null) return '';
          return chooseDefaultAgent(items);
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        /* agent picker degrades to free text */
      });
    profilesAbortRef.current?.abort();
    const profilesCtrl = new AbortController();
    profilesAbortRef.current = profilesCtrl;
    fetchSessionProfiles(profilesCtrl.signal)
      .then((items) => {
        profilesRef.current = items;
        setProfiles(items);
        setSelectedProfileId((current) => {
          if (current.length > 0 && items.some((profile) => profile.id === current)) return current;
          const sessionId = selectedIdRef.current;
          const currentDetail = detailRef.current;
          const currentSession =
            sessionId === null
              ? null
              : (sessionsRef.current.find((session) => session.id === sessionId) ?? null);
          return (
            profileIdForTarget(
              items,
              currentDetail?.namespace ?? currentSession?.namespace,
              currentDetail?.targetAgent ?? currentSession?.targetAgent,
            ) ?? chooseDefaultProfile(items)
          );
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        profilesRef.current = [];
        setProfiles([]);
      });
    const unsubscribe = subscribeCacheEvents(
      (ev) => {
        setLastEventAt(Date.now());
        if (ev.kind === 'task') {
          refreshSessions();
          const currentSession = selectedIdRef.current;
          if (currentSession !== null) refreshDetail(currentSession);
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
      agentsAbortRef.current?.abort();
      profilesAbortRef.current?.abort();
    };
    // One mount-time subscription. Refresh helpers intentionally close
    // over current state setters only.
  }, []);

  useEffect(() => {
    if (selectedId !== null) refreshDetail(selectedId);
  }, [selectedId]);

  const onSelect = (sessionId: string): void => {
    setSelectedId(sessionId);
    window.location.hash = `#/sessions/${encodeURIComponent(sessionId)}`;
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const sessionId = selectedId ?? normalizeSessionId(message);
    if (sessionId.length === 0) {
      setError('No session selected.');
      return;
    }
    const trimmed = message.trim();
    const launch = selectedProfile ?? null;
    const target = launch?.targetAgent ?? targetAgent.trim();
    if (trimmed.length === 0 || target.length === 0) return;
    setSubmitting(true);
    setError(null);
    sendSessionMessage(sessionId, {
      targetAgent: target,
      message: trimmed,
      namespace:
        launch?.namespace ??
        selectedAgent?.namespace ??
        selectedSession?.namespace ??
        detail?.namespace ??
        'kagent-system',
      runConfig: launch?.defaults.runConfig ?? {
        timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        maxIterations: DEFAULT_MAX_ITERATIONS,
      },
    })
      .then((created) => {
        setCreatedTask(created.task);
        setMessage('');
        setSelectedId(created.sessionId);
        refreshSessions();
        refreshDetail(created.sessionId);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const stopTask = (namespace: string, name: string): void => {
    const key = `${namespace}/${name}`;
    setStoppingTask(key);
    setError(null);
    terminateTask(namespace, name)
      .then(() => {
        refreshSessions();
        if (selectedIdRef.current !== null) refreshDetail(selectedIdRef.current);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setStoppingTask(null);
      });
  };

  const stale = now - lastEventAt > STALE_MS;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h1 className={styles.title}>Sessions</h1>
        <span className={styles.connection}>
          {stale
            ? `stream stale ${Math.floor((now - lastEventAt) / 1000).toString()}s`
            : 'stream live'}
        </span>
      </div>

      {error !== null ? <div className={styles.error}>error: {error}</div> : null}

      <div className={styles.layout}>
        <aside className={styles.sessionsPane} aria-label="Sessions">
          {sessions.length === 0 ? (
            <div className={styles.empty}>No sessions yet.</div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className={`${styles.sessionButton} ${
                  session.id === selectedId ? styles.sessionButtonActive : ''
                }`}
                onClick={() => onSelect(session.id)}
              >
                <span className={styles.sessionTop}>
                  <span className={styles.sessionName}>{session.id}</span>
                  {session.lastPhase !== undefined ? (
                    <span className={styles.phase}>{session.lastPhase}</span>
                  ) : null}
                </span>
                <span className={styles.sessionMeta}>
                  {session.targetAgent ?? 'controller'} · {session.turnCount.toString()} turns
                </span>
                <span className={styles.sessionPreview}>{session.lastMessagePreview ?? '—'}</span>
              </button>
            ))
          )}
        </aside>

        <section className={styles.chatPane} aria-label="Session timeline">
          <div className={styles.chatHeader}>
            <h2 className={styles.chatTitle}>{selectedId ?? 'Select a session'}</h2>
            <div className={styles.chatSub}>
              {displayTarget.length > 0 ? displayTarget : 'controller'} ·{' '}
              {detail?.messages.length.toString() ?? '0'} messages
            </div>
          </div>

          <div className={styles.timeline}>
            {detail === null ? (
              <div className={styles.empty}>Select a session or send the first message.</div>
            ) : (
              detail.messages.map((item) => (
                <article
                  key={item.id}
                  className={`${styles.message} ${
                    item.role === 'user' ? styles.messageUser : styles.messageAssistant
                  }`}
                >
                  <div className={styles.messageMeta}>
                    <span>{item.role === 'user' ? 'You' : 'Controller'}</span>
                    {item.task !== undefined ? (
                      <span className={styles.messageActions}>
                        {item.role === 'assistant' ? (
                          <a className={styles.taskLink} href={item.task.ui.replace(/^\/#/, '#')}>
                            open task {item.task.name}
                          </a>
                        ) : null}
                        {isActivePhase(item.task.phase) ? (
                          <button
                            type="button"
                            className={styles.stopTaskButton}
                            aria-label={`stop task ${item.task.name}`}
                            disabled={stoppingTask === `${item.task.namespace}/${item.task.name}`}
                            onClick={() => stopTask(item.task!.namespace, item.task!.name)}
                          >
                            stop
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  {item.content}
                </article>
              ))
            )}
          </div>

          <form className={styles.composer} onSubmit={onSubmit}>
            <div className={styles.composerRow}>
              <label className={styles.field}>
                {profiles.length > 0 ? 'Profile' : 'Target'}
                {profiles.length > 0 ? (
                  <select
                    className={styles.input}
                    aria-label="Profile"
                    value={selectedProfileId}
                    onChange={(e) => setSelectedProfileId(e.target.value)}
                    disabled={submitting}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.profileName}
                      </option>
                    ))}
                  </select>
                ) : agents.length > 0 ? (
                  <select
                    className={styles.input}
                    aria-label="Target"
                    value={targetAgent}
                    onChange={(e) => setTargetAgent(e.target.value)}
                    disabled={submitting}
                  >
                    {agents.map((agent) => (
                      <option key={`${agent.namespace}/${agent.name}`} value={agent.name}>
                        {agent.name}
                        {agent.namespace !== 'kagent-system' ? ` (${agent.namespace})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={styles.input}
                    aria-label="Target"
                    value={targetAgent}
                    onChange={(e) => setTargetAgent(e.target.value)}
                    placeholder="controller"
                    disabled={submitting}
                  />
                )}
                {profiles.length > 0 && selectedProfile !== null ? (
                  <span className={styles.profileMeta}>{profileMeta(selectedProfile)}</span>
                ) : null}
              </label>
              <label className={styles.field}>
                Message
                <textarea
                  className={styles.textarea}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Ask the controller what needs attention"
                  disabled={submitting}
                />
              </label>
              <button
                type="submit"
                className={styles.sendButton}
                disabled={
                  submitting ||
                  message.trim().length === 0 ||
                  (selectedProfile === null && targetAgent.trim().length === 0)
                }
              >
                Send
              </button>
            </div>
            {createdTask !== null ? (
              <a className={styles.createdTask} href={createdTask.ui.replace(/^\/#/, '#')}>
                open created task {createdTask.name}
              </a>
            ) : null}
          </form>
        </section>
      </div>
    </div>
  );
}

function normalizeSessionId(seed: string): string {
  return seed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function chooseDefaultAgent(agents: readonly AgentSummaryRow[]): string {
  const preferred =
    agents.find((agent) => agent.name === 'orchestrator' && agent.namespace === 'kagent-system') ??
    agents.find((agent) => agent.name === 'controller') ??
    agents.find((agent) => agent.name === 'orchestrator') ??
    agents[0];
  return preferred?.name ?? '';
}

function chooseDefaultProfile(profiles: readonly SessionProfile[]): string {
  const preferred =
    profiles.find(
      (profile) => profile.targetAgent === 'orchestrator' && profile.namespace === 'kagent-system',
    ) ??
    profiles.find((profile) => profile.targetAgent === 'controller') ??
    profiles.find((profile) => profile.targetAgent === 'orchestrator') ??
    profiles[0];
  return preferred?.id ?? '';
}

function profileIdForTarget(
  profiles: readonly SessionProfile[],
  namespace: string | undefined,
  targetAgent: string | undefined,
): string | undefined {
  if (targetAgent === undefined) return undefined;
  return profiles.find((profile) => {
    if (profile.targetAgent !== targetAgent) return false;
    return namespace === undefined || profile.namespace === namespace;
  })?.id;
}

function profileMeta(profile: SessionProfile): string {
  const model = profile.modelClass ?? profile.model ?? 'model unset';
  const toolProfile = profile.toolProfileRef ?? `${profile.tools.length.toString()} tools`;
  return `${model} · ${toolProfile}`;
}

function isActivePhase(phase: string | undefined): boolean {
  return phase === 'Pending' || phase === 'Dispatched';
}
