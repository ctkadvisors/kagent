/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * TaskActionMenu — right-click context menu for task sprites.
 *
 * Floating absolute-positioned card that appears at the cursor when a
 * user right-clicks a task unit on the Command Center canvas. ESC and
 * click-outside close it. Position is clamped to the viewport so the
 * menu never spills off-screen even when invoked at the corners.
 *
 * The menu resolves the bare task key (`<ns>/<name>`) into a full
 * `TaskDetail` on mount via `fetchTaskDetail` — the SSE-cache shape
 * (`TaskSummary`) deliberately omits `originalUserMessage` and
 * `traceLink`, so we re-pull the detail here for the Re-dispatch and
 * Open-trace actions to be honest. While that's in flight we render a
 * "loading…" placeholder so the user gets visual feedback.
 *
 * The four exposed actions are:
 *
 *   1. Inspect       — navigate to the existing TaskDetail page.
 *   2. Re-dispatch   — POST a new Task with the same originalUserMessage
 *                      against the same agent (fallback prompt: "Re-run.").
 *   3. Open trace    — open the Langfuse / OTel trace deep-link in a
 *                      new tab, if one is present on the detail.
 *   4. Cancel        — stub. Wired to the alert pipeline only; no
 *                      backend call yet.
 *
 * All four call `sound.click()` at start so the menu feels acoustically
 * consistent with the rest of the RTS HUD.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createTask, CreateTaskApiError, fetchTaskDetail } from '../api.js';
import type { TaskDetail } from '../types.js';
import { sound } from './sound.js';
import styles from './TaskActionMenu.module.css';

export interface TaskActionMenuProps {
  readonly taskKey: string; // `${ns}/${name}`
  readonly screenX: number;
  readonly screenY: number;
  readonly onClose: () => void;
  readonly onAlert: (msg: string) => void;
}

interface ParsedKey {
  readonly namespace: string;
  readonly name: string;
}

function splitTaskKey(key: string): ParsedKey | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  return {
    namespace: key.slice(0, slash),
    name: key.slice(slash + 1),
  };
}

const MENU_W = 220;
const MENU_H = 220;
const PAD = 12;

export function TaskActionMenu({
  taskKey,
  screenX,
  screenY,
  onClose,
  onAlert,
}: TaskActionMenuProps): React.JSX.Element | null {
  const parsed = splitTaskKey(taskKey);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // ───────────── Detail fetch (single-shot on mount) ─────────────
  useEffect(() => {
    if (parsed === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    fetchTaskDetail(parsed.namespace, parsed.name, controller.signal)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setLoading(false);
      })
      .catch(() => {
        // Detail fetch failures are non-fatal: Re-dispatch falls back to
        // a generic prompt and Open-trace shows a friendly alert.
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [parsed]);

  // ───────────── ESC + click-outside dismissal ─────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onMouseDown = (e: MouseEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      const target = e.target;
      if (target instanceof Node && root.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [onClose]);

  // ───────────── Action handlers ─────────────

  const handleInspect = useCallback((): void => {
    sound.click();
    if (parsed === null) {
      onAlert('inspect: bad task key');
      onClose();
      return;
    }
    window.location.hash = `#/tasks/${encodeURIComponent(parsed.namespace)}/${encodeURIComponent(
      parsed.name,
    )}`;
    onClose();
  }, [parsed, onAlert, onClose]);

  const handleRedispatch = useCallback((): void => {
    sound.click();
    if (parsed === null) {
      onAlert('re-dispatch: bad task key');
      onClose();
      return;
    }
    const prompt = detail?.originalUserMessage ?? 'Re-run.';
    const targetAgent = detail?.targetAgent ?? parsed.name;
    void createTask({
      targetAgent,
      namespace: parsed.namespace,
      originalUserMessage: prompt,
    })
      .then((res) => {
        onAlert(`re-dispatched: ${res.namespace}/${res.name}`);
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof CreateTaskApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'unknown error';
        onAlert(`re-dispatched: failed — ${msg}`);
      });
    onClose();
  }, [detail, parsed, onAlert, onClose]);

  const handleOpenTrace = useCallback((): void => {
    sound.click();
    const url = detail?.traceLink?.url;
    if (url === undefined || url.length === 0) {
      onAlert('no trace available');
      onClose();
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    onClose();
  }, [detail, onAlert, onClose]);

  const handleCancel = useCallback((): void => {
    sound.click();
    // TODO: wire to a real `DELETE /api/tasks/:ns/:name` (or PATCH
    // phase=Cancelled) once the workbench-api exposes a cancel surface.
    onAlert('cancel: not wired yet');
    onClose();
  }, [onAlert, onClose]);

  if (parsed === null) {
    // Bad key — surface the error once via alert, then bail. We render
    // nothing so the menu doesn't flash an empty card.
    return null;
  }

  // ───────────── Position clamp ─────────────
  const x = Math.max(
    PAD,
    Math.min(screenX + PAD, window.innerWidth - MENU_W - PAD),
  );
  const y = Math.max(
    PAD,
    Math.min(screenY + PAD, window.innerHeight - MENU_H - PAD),
  );

  const traceDisabled = !loading && (detail?.traceLink?.url === undefined || detail.traceLink.url.length === 0);

  return (
    <div
      ref={rootRef}
      className={styles.menu}
      style={{
        left: `${String(x)}px`,
        top: `${String(y)}px`,
        width: `${String(MENU_W)}px`,
      }}
      onContextMenu={(e) => {
        // Prevent re-opening the browser menu on top of our own.
        e.preventDefault();
      }}
    >
      <div className={styles.header}>
        <span>Task actions</span>
        <button
          type="button"
          className={styles.headerClose}
          onClick={() => {
            sound.click();
            onClose();
          }}
          aria-label="close"
        >
          ✕
        </button>
      </div>
      <div className={styles.taskKey}>{taskKey}</div>
      {loading ? (
        <div className={styles.loading}>loading…</div>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={handleInspect}>
          <span className={styles.actionLabel}>Inspect</span>
          <span className={styles.actionHint}>open detail</span>
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={handleRedispatch}
          disabled={loading}
        >
          <span className={styles.actionLabel}>Re-dispatch</span>
          <span className={styles.actionHint}>same prompt</span>
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={handleOpenTrace}
          disabled={loading || traceDisabled}
        >
          <span className={styles.actionLabel}>Open trace</span>
          <span className={styles.actionHint}>
            {traceDisabled && !loading ? 'unavailable' : 'new tab'}
          </span>
        </button>
        <button type="button" className={styles.action} onClick={handleCancel}>
          <span className={styles.actionLabel}>Cancel</span>
          <span className={styles.actionHint}>stub</span>
        </button>
      </div>
    </div>
  );
}
