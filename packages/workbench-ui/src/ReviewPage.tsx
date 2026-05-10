/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * ReviewPage — Phase 4 / REV-02 / D-03-A dedicated review entry point.
 *
 * Dedicated `#/review` hash route table page. Mirrors TaskList.tsx layout:
 * per-row Accept/Reject/Open Detail actions + confirm dialog per
 * NewTaskModal.tsx pattern.
 *
 * D7 / Prime Directive (COMMAND-CENTER-CONTRACT.md §2): every rendered
 * ReviewQueueRow field carries `data-source-field={useSourceField(<key>)}`
 * so source binding is visible in the DOM. assertSourceField fires in dev
 * when a field has no backing on the DTO instance.
 *
 * Confirm dialog pattern mirrors NewTaskModal.tsx:
 *   - Backdrop click closes
 *   - Escape key closes (via document keydown listener)
 *   - role="dialog" aria-modal="true" aria-labelledby={titleId}
 *   - NO formal focus-trap (matches NewTaskModal precedent)
 *
 * §11 bounds-test slice: 5s polling via useReviewQueue; AbortController
 * lifecycle; no new substrate primitives.
 */

import { useEffect, useRef, useState } from 'react';

import {
  useReviewQueue,
  acceptReviewQueueRow,
  rejectReviewQueueRow,
  ReviewActionApiError,
} from './api.js';
import type { ReviewQueueRow, ReviewReason } from './types.js';
import { assertSourceField, useSourceField } from './command/source-binding.js';
import styles from './ReviewPage.module.css';

export interface ReviewPageProps {
  readonly onBack: () => void;
}

/** Confirm dialog state: which row + which action is pending. */
interface ConfirmState {
  readonly row: ReviewQueueRow;
  readonly action: 'accept' | 'reject';
}

/**
 * Maps ReviewReason to a CSS pill class.
 * All user-supplied text is rendered via JSX text nodes only — React's
 * automatic HTML-entity escaping is the XSS defense (T-04-W3-06).
 */
function reasonClass(reason: ReviewReason): string {
  switch (reason) {
    case 'verifier-failed':
      return styles.reasonVerifier ?? '';
    case 'suspicious-detector':
      return styles.reasonSuspicious ?? '';
    case 'human-review-requested':
      return styles.reasonHumanReq ?? '';
    case 'candidate-template':
      return styles.reasonCandidate ?? '';
    case 'replay-divergence':
      return styles.reasonReplay ?? '';
    case 'eval-failed':
      return styles.reasonEval ?? '';
    default:
      return '';
  }
}

/**
 * Format staleness seconds into a human-readable string.
 * Examples: "12s", "5h 23m", "1d 2h".
 */
function formatStaleness(seconds: number): string {
  if (seconds < 60) return `${seconds.toString()}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m.toString()}m`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h.toString()}h ${m.toString()}m` : `${h.toString()}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d.toString()}d ${h.toString()}h` : `${d.toString()}d`;
}

export function ReviewPage({ onBack }: ReviewPageProps): React.JSX.Element {
  const { rows, loading, error, refresh } = useReviewQueue();
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const titleId = 'review-confirm-title';
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  // Esc-to-close confirm dialog + initial focus on confirm button.
  useEffect(() => {
    if (confirm === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setConfirm(null);
        setDialogError(null);
      }
    };
    document.addEventListener('keydown', onKey);
    confirmButtonRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [confirm]);

  const openConfirm = (row: ReviewQueueRow, action: 'accept' | 'reject'): void => {
    setConfirm({ row, action });
    setDialogError(null);
  };

  const closeConfirm = (): void => {
    setConfirm(null);
    setDialogError(null);
  };

  const handleConfirm = async (): Promise<void> => {
    if (confirm === null) return;
    setSubmitting(true);
    setDialogError(null);
    const { row, action } = confirm;
    try {
      if (action === 'accept') {
        await acceptReviewQueueRow(row.taskRef.namespace, row.taskRef.name, {});
      } else {
        await rejectReviewQueueRow(row.taskRef.namespace, row.taskRef.name, {});
      }
      closeConfirm();
      refresh();
    } catch (err: unknown) {
      if (err instanceof ReviewActionApiError) {
        // WR-02 (Plan 04-06): surface server-supplied `detail` (e.g.,
        // parseAgentTemplateSpec parser error tag) below the top-level
        // error message so reviewers see the actionable parse error.
        const base = `Error ${err.status.toString()}: ${err.message}`;
        setDialogError(err.detail !== undefined ? `${base} — ${err.detail}` : base);
      } else {
        setDialogError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h1 className={styles.title}>
          <button type="button" className={styles.backButton} onClick={onBack}>
            ← Tasks
          </button>
          Review Queue
        </h1>
      </div>

      {error !== null ? <div className={styles.error}>{error}</div> : null}

      {loading ? (
        <div className={styles.loading}>Loading review queue…</div>
      ) : rows.length === 0 && error === null ? (
        <div className={styles.empty}>No items pending review.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Reason</th>
              <th>Task</th>
              <th>Agent</th>
              <th>Reason Detail</th>
              <th>Staleness</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              // D7 / CC-01: source-field assertions in dev (no-op in prod).
              assertSourceField(row, 'reason');
              assertSourceField(row, 'taskRef');
              assertSourceField(row, 'reasonDetail');
              assertSourceField(row, 'stalenessSeconds');
              assertSourceField(row, 'targetAgent');

              const { namespace, name } = row.taskRef;
              const encodedHref = `#/tasks/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;

              return (
                <tr key={row.taskRef.uid}>
                  <td data-source-field={useSourceField('reason')}>
                    <span className={`${styles.reasonPill} ${reasonClass(row.reason)}`}>
                      {row.reason}
                    </span>
                  </td>
                  <td data-source-field={useSourceField('taskRef')}>
                    <a href={encodedHref} className={styles.linkCell}>
                      {namespace}/{name}
                    </a>
                  </td>
                  <td data-source-field={useSourceField('targetAgent')}>
                    {row.targetAgent ?? '—'}
                  </td>
                  <td data-source-field={useSourceField('reasonDetail')}>
                    {row.reasonDetail}
                  </td>
                  <td data-source-field={useSourceField('stalenessSeconds')}>
                    {formatStaleness(row.stalenessSeconds)}
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.acceptButton}
                        data-testid={`accept-row-${idx.toString()}`}
                        onClick={() => openConfirm(row, 'accept')}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className={styles.rejectButton}
                        data-testid={`reject-row-${idx.toString()}`}
                        onClick={() => openConfirm(row, 'reject')}
                      >
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {confirm !== null ? (
        <div
          className={styles.backdrop}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeConfirm();
          }}
        >
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <h2 id={titleId} className={styles.dialogTitle}>
              {confirm.action === 'accept' ? 'Accept this task?' : 'Reject this task?'}
            </h2>
            <p className={styles.dialogBody}>
              {confirm.action === 'accept'
                ? `Accept task ${confirm.row.taskRef.namespace}/${confirm.row.taskRef.name} and promote to agent template if applicable.`
                : `Reject task ${confirm.row.taskRef.namespace}/${confirm.row.taskRef.name} and record the decision.`}
            </p>
            {dialogError !== null ? (
              <div className={styles.dialogError}>{dialogError}</div>
            ) : null}
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.dialogCancelButton}
                onClick={closeConfirm}
                disabled={submitting}
              >
                Cancel
              </button>
              {confirm.action === 'accept' ? (
                <button
                  ref={confirmButtonRef}
                  type="button"
                  className={styles.dialogConfirmAcceptButton}
                  data-testid="confirm-accept"
                  onClick={() => void handleConfirm()}
                  disabled={submitting}
                >
                  {submitting ? 'Accepting…' : 'Accept'}
                </button>
              ) : (
                <button
                  ref={confirmButtonRef}
                  type="button"
                  className={styles.dialogConfirmRejectButton}
                  data-testid="confirm-reject"
                  onClick={() => void handleConfirm()}
                  disabled={submitting}
                >
                  {submitting ? 'Rejecting…' : 'Reject'}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
