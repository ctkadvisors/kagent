/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `#/architect` — kagent Studio "chat to create".
 *
 * Describe an agent in natural language → the Architect (gateway-backed)
 * returns a validated AgentTemplate candidate → "Try it live" persists
 * it, materializes a draft Agent, and creates an AgentTask in the
 * kagent-draft namespace.
 *
 * Conversational surface: a scrolling thread of goals + drafted
 * candidates with a sticky composer. All dynamic text renders via JSX
 * text nodes (React auto-escaping is the XSS defense), consistent with
 * the rest of the Workbench.
 */
import { useEffect, useRef, useState } from 'react';

import { architectDraft, architectTry, type ArchitectDraftResult } from './api.js';
import styles from './ArchitectPage.module.css';

export interface ArchitectPageProps {
  readonly onBack: () => void;
}

interface DraftMsg {
  readonly kind: 'draft';
  readonly id: number;
  readonly goal: string;
  readonly draft: ArchitectDraftResult;
}
interface UserMsg {
  readonly kind: 'user';
  readonly id: number;
  readonly text: string;
}
interface ErrorMsg {
  readonly kind: 'error';
  readonly id: number;
  readonly text: string;
}
type Message = DraftMsg | UserMsg | ErrorMsg;

interface TriedState {
  readonly taskLabel: string;
  readonly taskHref?: string;
  readonly traceHref?: string;
}

const EXAMPLES = [
  'A summarizer that condenses long docs into 5 bullet points',
  'A triage agent that labels incoming GitHub issues by severity',
  'A code reviewer that flags missing tests on a diff',
  'A research agent that synthesizes a topic from three sources',
];

/** Best-effort extraction of headline fields from the parsed preview. */
function summarize(preview: unknown): { label: string; value: string }[] {
  if (typeof preview !== 'object' || preview === null) return [];
  const p = preview as Record<string, unknown>;
  const agentSpec = (p.agentSpec ?? {}) as Record<string, unknown>;
  const budget = (p.budget ?? {}) as Record<string, unknown>;
  const out: { label: string; value: string }[] = [];
  if (typeof agentSpec.model === 'string') out.push({ label: 'Model', value: agentSpec.model });
  if (typeof budget.maxIterations === 'number')
    out.push({ label: 'Max iterations', value: String(budget.maxIterations) });
  const tools = agentSpec.toolAllowlist;
  if (Array.isArray(tools) && tools.length > 0)
    out.push({ label: 'Tools', value: String(tools.length) });
  return out;
}

export function ArchitectPage(_props: ArchitectPageProps): React.JSX.Element {
  const [goal, setGoal] = useState('');
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState<Record<number, TriedState>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  const nextId = (): number => {
    idRef.current += 1;
    return idRef.current;
  };

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '' || busy) return;
    setMessages((m) => [...m, { kind: 'user', id: nextId(), text: trimmed }]);
    setGoal('');
    setBusy(true);
    architectDraft(trimmed)
      .then((draft) => {
        setMessages((m) => [...m, { kind: 'draft', id: nextId(), goal: trimmed, draft }]);
      })
      .catch((e: unknown) => {
        setMessages((m) => [
          ...m,
          { kind: 'error', id: nextId(), text: e instanceof Error ? e.message : String(e) },
        ]);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const onTry = (msg: DraftMsg): void => {
    setBusy(true);
    architectTry(msg.draft.candidateYaml, msg.goal)
      .then((r) => {
        setTried((t) => ({
          ...t,
          [msg.id]: {
            taskLabel: `${r.namespace}/${r.taskName}`,
            ...(r._links?.ui !== undefined && { taskHref: r._links.ui }),
            ...(r._links?.langfuse !== undefined && { traceHref: r._links.langfuse }),
          },
        }));
      })
      .catch((e: unknown) => {
        setMessages((m) => [
          ...m,
          { kind: 'error', id: nextId(), text: e instanceof Error ? e.message : String(e) },
        ]);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const onCopy = (msg: DraftMsg): void => {
    void navigator.clipboard?.writeText(msg.draft.candidateYaml);
    setCopied(msg.id);
    setTimeout(() => {
      setCopied((c) => (c === msg.id ? null : c));
    }, 1500);
  };

  return (
    <div className={styles.page}>
      <div className={styles.thread} ref={threadRef}>
        {messages.length === 0 && !busy ? (
          <div className={styles.empty}>
            <div className={styles.emptyMark}>
              <svg
                viewBox="0 0 24 24"
                width="26"
                height="26"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M13 4l2.5 6L22 12l-6.5 2L13 20l-2.5-6L4 12l6.5-2L13 4z" />
              </svg>
            </div>
            <h2 className={styles.emptyTitle}>Describe the agent you want to build</h2>
            <p className={styles.emptyBody}>
              The Architect drafts a validated AgentTemplate, then launches a draft AgentTask in
              <code> kagent-draft </code> for traceable smoke testing.
            </p>
            <div className={styles.examples}>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className={styles.example}
                  onClick={() => submit(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((msg) => {
          if (msg.kind === 'user') {
            return (
              <div key={msg.id} className={styles.userMsg}>
                {msg.text}
              </div>
            );
          }
          if (msg.kind === 'error') {
            return (
              <div key={msg.id} className={styles.errorMsg}>
                <div className={styles.avatar}>k</div>
                <div className={styles.errorBody}>{msg.text}</div>
              </div>
            );
          }
          const fields = summarize(msg.draft.preview);
          const triedState = tried[msg.id];
          return (
            <div key={msg.id} className={styles.architectMsg}>
              <div className={styles.avatar}>k</div>
              <div className={styles.card}>
                <div className={styles.cardHead}>
                  <span className={styles.cardTitle}>AgentTemplate candidate</span>
                  <span className={styles.draftTag}>kagent-draft</span>
                </div>
                {fields.length > 0 ? (
                  <div className={styles.summary}>
                    {fields.map((f) => (
                      <div key={f.label} className={styles.field}>
                        <span className={styles.fieldLabel}>{f.label}</span>
                        <span className={styles.fieldValue}>{f.value}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <pre className={styles.yaml}>{msg.draft.candidateYaml}</pre>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={busy || triedState !== undefined}
                    onClick={() => onTry(msg)}
                  >
                    {triedState !== undefined ? 'Task created' : 'Try it live'}
                  </button>
                  <button type="button" className={styles.btn} onClick={() => onCopy(msg)}>
                    {copied === msg.id ? 'Copied ✓' : 'Copy YAML'}
                  </button>
                  {triedState !== undefined ? (
                    <span className={styles.tried}>
                      {triedState.taskHref !== undefined ? (
                        <a href={triedState.taskHref}>Open task</a>
                      ) : (
                        `Created ${triedState.taskLabel}`
                      )}
                      {triedState.traceHref !== undefined ? (
                        <>
                          {' · '}
                          <a href={triedState.traceHref} target="_blank" rel="noreferrer">
                            View trace in Langfuse →
                          </a>
                        </>
                      ) : null}
                      {triedState.taskHref !== undefined && triedState.traceHref === undefined ? (
                        <> · {triedState.taskLabel}</>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}

        {busy ? (
          <div className={styles.thinking}>
            <span className={styles.spinner} /> Architecting…
          </div>
        ) : null}
      </div>

      <div className={styles.composer}>
        <div className={styles.composerInner}>
          <textarea
            className={styles.input}
            value={goal}
            rows={1}
            placeholder="Describe an agent… e.g. a summarizer that condenses long docs into 5 bullet points"
            onChange={(e) => {
              setGoal(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit(goal);
              }
            }}
          />
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary} ${styles.send}`}
            disabled={busy || goal.trim() === ''}
            onClick={() => submit(goal)}
          >
            Draft
          </button>
        </div>
        <div className={styles.hint}>⌘↵ to draft · candidates are validated AgentTemplates</div>
      </div>
    </div>
  );
}
