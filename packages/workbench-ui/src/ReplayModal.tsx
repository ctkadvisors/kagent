/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * ReplayModal — Phase 5 (WB-03). Allows replaying an existing task as
 * a new task, optionally targeting a different agent and providing a
 * reason for the replay.
 *
 * Shape mirrors NewTaskModal.tsx: Esc-to-close, fetchAgents on mount,
 * backdrop-click-to-close, role="dialog" aria-modal. The form pre-fills
 * the original task's targetAgent and originalUserMessage (read-only
 * preview via JSX text node — relying on React's automatic HTML-entity
 * escaping per RESEARCH §11 Pitfall 5 XSS defense).
 *
 * Submit calls `createTask` with a `replayOf` body field shape that
 * carries the original task's reference. Plan 02 mounts this in
 * TaskDetail.tsx and wires the close/open state to a "Replay" button.
 */

import { useEffect, useRef, useState } from 'react';

import { CreateTaskApiError, createTask, fetchAgents } from './api.js';
import { sound } from './command/sound.js';
import type {
  AgentSummaryRow,
  CreateTaskResponse,
  TaskDetail,
} from './types.js';
import styles from './ReplayModal.module.css';

export interface ReplayModalProps {
  /** The task being replayed. */
  readonly task: TaskDetail;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  /** Called with the newly created task on a successful 201. */
  readonly onSubmitted?: (created: CreateTaskResponse) => void;
}

export function ReplayModal({
  task,
  isOpen,
  onClose,
  onSubmitted,
}: ReplayModalProps): React.JSX.Element | null {
  const [agents, setAgents] = useState<readonly AgentSummaryRow[]>([]);
  const [targetAgent, setTargetAgent] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const selectRef = useRef<HTMLSelectElement | null>(null);

  // Fetch agent catalog on mount, then pre-select the original agent.
  // Mirror NewTaskModal.tsx L47-66.
  useEffect(() => {
    if (!isOpen) return;
    const ctrl = new AbortController();
    fetchAgents(ctrl.signal)
      .then((items) => {
        setAgents(items);
        // Pre-select the original task's targetAgent if available.
        const originalAgent = task.targetAgent ?? '';
        setTargetAgent(originalAgent !== '' ? originalAgent : (items[0]?.name ?? ''));
      })
      .catch(() => {
        // Non-fatal — fall back to whatever targetAgent is currently set.
        if (targetAgent === '' && task.targetAgent !== undefined) {
          setTargetAgent(task.targetAgent);
        }
      });
    return () => ctrl.abort();
  }, [isOpen, task.targetAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc-to-close + initial focus. Mirror NewTaskModal.tsx L68-76.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    selectRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setFieldErrors(new Map());

    if (targetAgent.trim().length === 0) {
      setError('Target Agent is required.');
      return;
    }

    setSubmitting(true);
    try {
      const trimmedReason = reason.trim();
      const created = await createTask({
        targetAgent: targetAgent.trim(),
        originalUserMessage: task.originalUserMessage ?? '',
        namespace: task.namespace,
        replayOf: {
          taskRef: {
            namespace: task.namespace,
            name: task.name,
            uid: task.uid,
          },
          ...(trimmedReason.length > 0 && { reason: trimmedReason }),
        },
      });
      sound.taskComplete();
      onSubmitted?.(created);
      onClose();
    } catch (err: unknown) {
      sound.taskFailed();
      const apiErr = err instanceof CreateTaskApiError ? err : undefined;
      if (apiErr !== undefined && apiErr.fields !== undefined && apiErr.fields.length > 0) {
        const m = new Map<string, string>();
        for (const f of apiErr.fields) {
          m.set(f.field, f.detail !== undefined ? `${f.code}: ${f.detail}` : f.code);
        }
        setFieldErrors(m);
        setError(apiErr.error);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : String(err),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className={styles.backdrop}
      onClick={(e) => {
        // Backdrop-click-to-close. Mirror NewTaskModal.tsx L119-126.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-modal-title"
      >
        <div className={styles.header}>
          <h2 id="replay-modal-title" className={styles.title}>
            Replay this task
          </h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close replay modal"
          >
            ×
          </button>
        </div>

        <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
          {/* Target Agent selector */}
          <label className={styles.label}>
            <span>Target Agent</span>
            {agents.length > 0 ? (
              <select
                ref={selectRef}
                className={styles.input}
                value={targetAgent}
                onChange={(e) => setTargetAgent(e.target.value)}
                disabled={submitting}
              >
                {agents.map((a) => (
                  <option key={`${a.namespace}/${a.name}`} value={a.name}>
                    {a.name}
                    {a.namespace !== 'kagent-system' ? ` (${a.namespace})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                ref={selectRef as unknown as React.RefObject<HTMLInputElement>}
                className={styles.input}
                type="text"
                value={targetAgent}
                onChange={(e) => setTargetAgent(e.target.value)}
                placeholder="agent-name"
                disabled={submitting}
              />
            )}
            {fieldErrors.has('targetAgent') ? (
              <span className={styles.fieldError}>{fieldErrors.get('targetAgent')}</span>
            ) : null}
          </label>

          {/* Reason (optional, ≤256 chars) */}
          <label className={styles.label}>
            <span>Reason (optional)</span>
            <textarea
              className={styles.textarea}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you replaying this task?"
              rows={3}
              maxLength={256}
              disabled={submitting}
            />
            <span className={styles.hint}>256 char limit</span>
            {fieldErrors.has('replayOf.reason') ? (
              <span className={styles.fieldError}>{fieldErrors.get('replayOf.reason')}</span>
            ) : null}
          </label>

          {/* Original message preview: rendered as a JSX text node inside <pre>,
              so React applies automatic HTML-entity escaping. This is the
              XSS defense per RESEARCH §11 Pitfall 5. */}
          <details className={styles.originalMessage}>
            <summary>Original message (read-only)</summary>
            <pre>{task.originalUserMessage}</pre>
          </details>

          {error !== null ? <div className={styles.error}>{error}</div> : null}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className={styles.primaryButton} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Replay Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
