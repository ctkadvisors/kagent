/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * ReviewActions — Phase 4 / REV-02 / D-03-A inline entry point.
 *
 * Inline component mounted ABOVE `<DetailBody>` in TaskDetail. Renders
 * Accept/Reject buttons ONLY when the task matches one of the 4 trigger
 * conditions (CONTEXT.md D-03):
 *
 *   1. task.phase === 'Failed'
 *   2. (task.suspicious?.length ?? 0) > 0
 *   3. pilotEvidence.audit.annotations['kagent.knuteson.io/review-requested'] === 'true'
 *   4. pilotEvidence.audit.annotations['kagent.knuteson.io/template-candidate'] === 'true'
 *
 * Returns null when none of the 4 trigger conditions are met (eligible=false).
 *
 * Confirm dialog pattern mirrors NewTaskModal.tsx:
 *   - Backdrop click closes
 *   - Escape key closes (document keydown listener, cleaned up on unmount)
 *   - role="dialog" aria-modal="true" aria-labelledby={titleId}
 *   - NO formal focus-trap (matches NewTaskModal.tsx precedent; T-04-W3-05)
 *
 * XSS defense (T-04-W3-06): all user-supplied text rendered via JSX text
 * nodes only. No innerHTML-bypassing API anywhere in this component.
 *
 * Annotation access path: task.pilotEvidence?.audit?.annotations.
 * The `TaskDetail` UI type carries `pilotEvidence.audit.annotations` as
 * `Readonly<Record<string, string>>` (types.ts lines 119-126), so the
 * access is direct with no plumbing needed.
 *
 * Modal duplication decision: the modal is self-contained here (not
 * shared with ReviewPage) for component isolation. Both follow the same
 * NewTaskModal pattern so the behavior is identical.
 */

import { useEffect, useRef, useState } from 'react';

import type { TaskDetail } from '../types.js';
import {
  acceptReviewQueueRow,
  rejectReviewQueueRow,
  ReviewActionApiError,
} from '../api.js';
import styles from './ReviewActions.module.css';

export interface ReviewActionsProps {
  readonly task: TaskDetail;
  readonly onDecision: () => void;
}

type ConfirmAction = 'accept' | 'reject';

const REVIEW_REQUESTED_KEY = 'kagent.knuteson.io/review-requested';
const TEMPLATE_CANDIDATE_KEY = 'kagent.knuteson.io/template-candidate';

export function ReviewActions({ task, onDecision }: ReviewActionsProps): React.JSX.Element | null {
  // D-03: 4 trigger conditions. Any one suffices.
  const annotations = task.pilotEvidence?.audit?.annotations ?? {};
  const eligible =
    task.phase === 'Failed' ||
    (task.suspicious?.length ?? 0) > 0 ||
    annotations[REVIEW_REQUESTED_KEY] === 'true' ||
    annotations[TEMPLATE_CANDIDATE_KEY] === 'true';

  if (!eligible) return null;

  return (
    <ReviewActionsPanel task={task} onDecision={onDecision} />
  );
}

/**
 * Rendered only when eligible=true. Separated to avoid calling hooks
 * conditionally (React rules of hooks).
 */
function ReviewActionsPanel({
  task,
  onDecision,
}: ReviewActionsProps): React.JSX.Element {
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const titleId = 'review-actions-confirm-title';
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  // Esc-to-close + initial focus on confirm button.
  useEffect(() => {
    if (confirmAction === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setConfirmAction(null);
        setDialogError(null);
      }
    };
    document.addEventListener('keydown', onKey);
    confirmButtonRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [confirmAction]);

  const openConfirm = (action: ConfirmAction): void => {
    setConfirmAction(action);
    setDialogError(null);
  };

  const closeConfirm = (): void => {
    setConfirmAction(null);
    setDialogError(null);
  };

  const handleConfirm = async (): Promise<void> => {
    if (confirmAction === null) return;
    setSubmitting(true);
    setDialogError(null);
    try {
      if (confirmAction === 'accept') {
        await acceptReviewQueueRow(task.namespace, task.name, {});
      } else {
        await rejectReviewQueueRow(task.namespace, task.name, {});
      }
      closeConfirm();
      onDecision();
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
    <>
      <div className={styles.container}>
        <div className={styles.header}>Review actions</div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.acceptButton}
            data-testid="review-accept-btn"
            onClick={() => openConfirm('accept')}
          >
            Accept
          </button>
          <button
            type="button"
            className={styles.rejectButton}
            data-testid="review-reject-btn"
            onClick={() => openConfirm('reject')}
          >
            Reject
          </button>
        </div>
      </div>

      {confirmAction !== null ? (
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
              {confirmAction === 'accept'
                ? 'Accept this task?'
                : 'Reject this task?'}
            </h2>
            <p className={styles.dialogBody}>
              {confirmAction === 'accept'
                ? `Accept ${task.namespace}/${task.name} and record the decision.`
                : `Reject ${task.namespace}/${task.name} and record the decision.`}
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
              {confirmAction === 'accept' ? (
                <button
                  ref={confirmButtonRef}
                  type="button"
                  className={styles.dialogConfirmAcceptButton}
                  data-testid="review-confirm-accept"
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
                  data-testid="review-confirm-reject"
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
    </>
  );
}
