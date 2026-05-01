/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * NewTaskModal — WS-J UI surface for POST /api/tasks.
 *
 * Form fields:
 *   - Target Agent (select if /api/agents returned ≥1; falls back to
 *     a free-text input if the catalog is empty)
 *   - Original User Message (textarea, ≤32KB enforced server-side)
 *   - Timeout (optional integer, seconds)
 *
 * Intentionally minimal — power users hit the CLI / API directly.
 * `runConfig.maxIterations`, custom labels, and namespace override are
 * deferred to a follow-up "Advanced" expander once a real workload
 * needs them.
 */

import { useEffect, useRef, useState } from 'react';

import { createTask, fetchAgents } from './api.js';
import type { AgentSummaryRow, CreateTaskError } from './types.js';
import styles from './NewTaskModal.module.css';

export interface NewTaskModalProps {
  /** Called when the user dismisses the modal (Esc, backdrop click, X button). */
  readonly onClose: () => void;
  /** Called with the created task's identity on success. The TaskList
   *  uses this to optimistically navigate to the new row's detail
   *  page (or to refresh the list). */
  readonly onSuccess: (created: { readonly namespace: string; readonly name: string }) => void;
}

export function NewTaskModal({ onClose, onSuccess }: NewTaskModalProps): React.JSX.Element {
  const [agents, setAgents] = useState<readonly AgentSummaryRow[]>([]);
  const [targetAgent, setTargetAgent] = useState<string>('');
  const [originalUserMessage, setOriginalUserMessage] = useState<string>('');
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  // Fetch the agent catalog once on mount.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchAgents(ctrl.signal)
      .then((items) => {
        setAgents(items);
        // Pre-select the first agent so the form is one-click-from-submit
        // when there's only one or a clear default.
        if (items.length > 0 && targetAgent === '') {
          setTargetAgent(items[0]?.name ?? '');
        }
      })
      .catch(() => {
        // Catalog fetch failures are non-fatal; the form falls back to
        // a free-text Target Agent input.
      });
    return () => ctrl.abort();
    // Effect intentionally runs once on mount — the prefill check uses
    // the `targetAgent === ''` guard internally.
  }, []);

  // Esc-to-close + initial focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    promptRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setFieldErrors(new Map());
    if (targetAgent.trim().length === 0) {
      setError('Target Agent is required.');
      return;
    }
    if (originalUserMessage.trim().length === 0) {
      setError('Prompt is required.');
      return;
    }
    setSubmitting(true);
    try {
      const timeoutNum = timeoutSeconds.trim().length > 0 ? Number(timeoutSeconds) : undefined;
      const created = await createTask({
        targetAgent: targetAgent.trim(),
        originalUserMessage,
        ...(timeoutNum !== undefined &&
          Number.isFinite(timeoutNum) && {
            runConfig: { timeoutSeconds: Math.floor(timeoutNum) },
          }),
      });
      onSuccess({ namespace: created.namespace, name: created.name });
    } catch (err: unknown) {
      const apiErr = err as CreateTaskError | undefined;
      if (apiErr?.fields !== undefined && apiErr.fields.length > 0) {
        const m = new Map<string, string>();
        for (const f of apiErr.fields) {
          m.set(f.field, f.detail !== undefined ? `${f.code}: ${f.detail}` : f.code);
        }
        setFieldErrors(m);
        setError(apiErr.error);
      } else {
        setError(apiErr?.error ?? (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={styles.backdrop}
      onClick={(e) => {
        // Clicking the backdrop (but not the dialog itself) closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="ntm-title">
        <div className={styles.header}>
          <h2 id="ntm-title" className={styles.title}>
            New Task
          </h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
          <label className={styles.label}>
            <span>Target Agent</span>
            {agents.length > 0 ? (
              <select
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

          <label className={styles.label}>
            <span>Prompt</span>
            <textarea
              ref={promptRef}
              className={styles.textarea}
              value={originalUserMessage}
              onChange={(e) => setOriginalUserMessage(e.target.value)}
              placeholder="What do you want the agent to do?"
              rows={6}
              disabled={submitting}
            />
            {fieldErrors.has('originalUserMessage') ? (
              <span className={styles.fieldError}>
                {fieldErrors.get('originalUserMessage')}
              </span>
            ) : null}
          </label>

          <label className={styles.label}>
            <span>Timeout (seconds, optional)</span>
            <input
              className={styles.input}
              type="number"
              min={1}
              max={86400}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              placeholder="e.g. 300"
              disabled={submitting}
            />
            {fieldErrors.has('runConfig.timeoutSeconds') ? (
              <span className={styles.fieldError}>
                {fieldErrors.get('runConfig.timeoutSeconds')}
              </span>
            ) : null}
          </label>

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
              {submitting ? 'Submitting…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
