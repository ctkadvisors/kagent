/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * useAlert — shared transient-alert hook. Phase 5 (WB-01).
 *
 * Lifted from CommandView.tsx L737-738 alertText + setTimeout pattern
 * and generalized into a shared hook. At least 5 callers identified
 * in Plan 02 (CommandView, TaskDetail, SelectionActions, ReplayModal,
 * ReviewPage).
 *
 * Returns a stable `setAlertText` callback that:
 *   - Sets the alert message and starts a TTL timer.
 *   - Cancels any prior pending timer when called again (replaces,
 *     never appends).
 *   - Clears the message after `ttlMs` (default 2500ms).
 *   - `setAlertText(null)` clears immediately (cancels timer).
 *   - Cleans up the pending timer on unmount to avoid
 *     "setState on unmounted component" warnings.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_TTL_MS = 2_500;

export interface UseAlertResult {
  readonly alertText: string | null;
  readonly setAlertText: (msg: string | null, ttlMs?: number) => void;
}

export function useAlert(): UseAlertResult {
  const [alertText, setAlertTextState] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  // Cleanup on unmount — clear any pending timeout so we never call
  // setState after the component is gone.
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const setAlertText = useCallback((msg: string | null, ttlMs: number = DEFAULT_TTL_MS): void => {
    // Cancel any prior pending timer.
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (msg === null) {
      // Clear immediately; no timer needed.
      setAlertTextState(null);
      return;
    }

    setAlertTextState(msg);
    timeoutRef.current = window.setTimeout(() => {
      setAlertTextState(null);
      timeoutRef.current = null;
    }, ttlMs);
  }, []);

  return { alertText, setAlertText };
}
