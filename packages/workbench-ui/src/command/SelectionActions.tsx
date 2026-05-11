/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * SelectionActions — Phase 5 (WB-02). Multi-selection action panel for
 * the Command Center. Always-mounted-returns-null pattern (matches
 * ReviewActions and DispositionOverlay.tsx).
 *
 * Returns null when fewer than 2 agents are selected. When ≥2 are
 * selected, renders 3 action buttons anchored to the bottom-right of
 * the canvas overlay.
 *
 * Click handlers are STUBS in Plan 01 (fire sound.click() + noop).
 * Plan 02 wires the real action handlers:
 *   - Open in tabs: opens up to 10 task-detail pages in new browser tabs
 *   - Copy IDs: copies the selected agent task UIDs to clipboard
 *   - Scroll to first failure: pans the camera to the first failing agent
 *
 * See CONTEXT.md D-02 for the button-labels + action-handler decisions.
 */

import type { MutableRefObject, RefObject } from 'react';

import type { Camera } from './camera.js';
import type { LayoutResult } from './layout.js';
import type { SelectionState } from './scene.js';
import { sound } from './sound.js';
import type { CommandSnapshot } from './state.js';
import styles from './SelectionActions.module.css';

export interface SelectionActionsProps {
  readonly selection: SelectionState;
  readonly snapshot: CommandSnapshot;
  readonly layout: LayoutResult | null;
  readonly cameraRef: MutableRefObject<Camera>;
  readonly wrapperRef: RefObject<HTMLDivElement>;
  /** Shared alert hook — Plan 02 wires toast messages through this. */
  readonly setAlertText: (msg: string | null, ttlMs?: number) => void;
}

/**
 * SelectionActions. Renders null when fewer than 2 agents are in the
 * selection. Otherwise renders 3 action buttons with dynamic labels
 * derived from selection.keys.size.
 */
export function SelectionActions({
  selection,
  snapshot: _snapshot,
  layout: _layout,
  cameraRef: _cameraRef,
  wrapperRef: _wrapperRef,
  setAlertText: _setAlertText,
}: SelectionActionsProps): React.JSX.Element | null {
  // Always-mounted-returns-null pattern: guard before any render.
  if (selection.keys.size < 2) return null;

  const totalSelected = selection.keys.size;
  // "Open in tabs" is capped at 10 to avoid opening too many browser tabs.
  const openCount = Math.min(totalSelected, 10);

  return (
    <div className={styles.selectionActions}>
      <button
        type="button"
        className={styles.button}
        data-testid="selectionActions.openTabs"
        onClick={() => {
          sound.click();
          // Plan 02 wires: open up to 10 task-detail pages in new tabs.
        }}
      >
        Open {openCount} in tabs
      </button>

      <button
        type="button"
        className={styles.button}
        data-testid="selectionActions.copyIds"
        onClick={() => {
          sound.click();
          // Plan 02 wires: copy selected agent/task UIDs to clipboard.
        }}
      >
        Copy {totalSelected} IDs
      </button>

      <button
        type="button"
        className={styles.button}
        data-testid="selectionActions.scrollToFailure"
        onClick={() => {
          sound.click();
          // Plan 02 wires: pan camera to first failing agent in selection.
        }}
      >
        Scroll to first failure
      </button>
    </div>
  );
}
