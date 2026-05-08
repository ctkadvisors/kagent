/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Mission tutorial overlay — first-load tour of the Command view's
 * RTS-style hotkey grammar. Five sequential missions, each with a goal
 * card pinned to the bottom-left of the canvas and a simple completion
 * predicate. On completion, a brief flash, then the next mission.
 *
 * The parent (CommandView) computes `MissionSignals` from its existing
 * state — selection size, held keys, dispatch popover open, bookmark
 * slots — and passes it as a prop on every render. This component
 * advances internally when `signals` matches the active mission's
 * predicate. Keeping the data flow one-way means we don't have to add
 * any extra refs or context to the parent.
 *
 * Persistence: a single localStorage key (`kagent.command.tour.completed`)
 * gates the entire experience. Once set to `'true'` — by completion,
 * Skip, or Esc — the overlay never re-renders for that browser profile.
 *
 * Style: matches the existing `.hotkeyOverlay`/`.hotkeyCard` aesthetic
 * (dark navy + amber accent + monospace) but anchored to the lower-left
 * instead of centred, so it doesn't fight the canvas for attention while
 * the user is actively trying out the gestures it describes.
 */

import { useCallback, useEffect, useState } from 'react';

import { sound } from './sound.js';
import styles from './Mission.module.css';

/** localStorage gate — single key, persisted across reloads. */
const TOUR_COMPLETED_KEY = 'kagent.command.tour.completed';

/**
 * Signals derived by the parent every render. Each field is a simple
 * scalar/boolean snapshot of state the parent already tracks; the
 * Mission component reads them to detect completion.
 */
export interface MissionSignals {
  /** Number of currently-selected agent keys (excludes the gateway). */
  readonly selectionCount: number;
  /** True when ANY of WASD / arrow keys is currently held. */
  readonly anyPanKeyHeld: boolean;
  /** Number of agents selected via the most recent marquee drag. */
  readonly lastDragSelectCount: number;
  /** True when the right-click dispatch popover is open. */
  readonly dispatchOpen: boolean;
  /** True when bookmark slot 5 is currently saved. */
  readonly bookmarkSavedSlot5: boolean;
  /** True when the operator has recalled bookmark slot 5 since saving. */
  readonly bookmarkRecalledSlot5: boolean;
}

interface MissionDef {
  readonly id: number;
  readonly title: string;
  readonly goal: string;
  readonly hint: string;
  /** Predicate evaluated against `signals` each render. */
  readonly isComplete: (signals: MissionSignals) => boolean;
}

const MISSIONS: readonly MissionDef[] = [
  {
    id: 1,
    title: 'mission 1 of 5',
    goal: 'Click any agent structure to select it.',
    hint: 'left click',
    isComplete: (s) => s.selectionCount >= 1,
  },
  {
    id: 2,
    title: 'mission 2 of 5',
    goal: 'Press WASD or arrow keys to pan the camera.',
    hint: 'WASD / arrows',
    isComplete: (s) => s.anyPanKeyHeld,
  },
  {
    id: 3,
    title: 'mission 3 of 5',
    goal: 'Drag a marquee around two or more agents.',
    hint: 'left-drag',
    isComplete: (s) => s.lastDragSelectCount >= 2,
  },
  {
    id: 4,
    title: 'mission 4 of 5',
    goal: 'Right-click an agent to dispatch a task. (Esc cancels.)',
    hint: 'right click',
    isComplete: (s) => s.dispatchOpen,
  },
  {
    id: 5,
    title: 'mission 5 of 5',
    goal: 'Press Shift+F5 to save a camera bookmark, then F5 to recall it.',
    hint: 'Shift+F5 then F5',
    isComplete: (s) => s.bookmarkSavedSlot5 && s.bookmarkRecalledSlot5,
  },
];

/** Internal phase of the tour. */
type Phase =
  | { kind: 'mission'; index: number }
  | { kind: 'flash'; index: number }
  | { kind: 'final-flash' }
  | { kind: 'done' };

interface MissionOverlayProps {
  /**
   * Live signals from the parent. The component is a pure function of
   * `signals` + its own internal phase — pass the same object reference
   * every render; the component only reads scalar fields.
   */
  readonly signals: MissionSignals;
  /**
   * Called once when the tour transitions to its done state — either
   * by completing all 5 missions, by Skip, or by Esc. The parent does
   * NOT need to do anything to dismiss the overlay; this hook is only
   * useful for analytics / diagnostics.
   */
  readonly onComplete: () => void;
}

/**
 * Read the localStorage gate. Wrapped in try/catch because some browser
 * profiles disable storage entirely; in that case we just always show
 * the tour, which is the safest default.
 */
function readTourCompleted(): boolean {
  try {
    return localStorage.getItem(TOUR_COMPLETED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Persist the completion flag. Failures are silent (private browsing). */
function writeTourCompleted(): void {
  try {
    localStorage.setItem(TOUR_COMPLETED_KEY, 'true');
  } catch {
    /* private mode — degrade silently */
  }
}

/**
 * Brief "✓ mission complete" flash duration before advancing to the
 * next mission. Tuned to be readable but not slow down a power user.
 */
const FLASH_MS = 700;

/** Final "✓ Tour complete." card auto-dismiss. */
const FINAL_DISMISS_MS = 2_000;

export function MissionOverlay({
  signals,
  onComplete,
}: MissionOverlayProps): React.JSX.Element | null {
  // Read localStorage exactly once at mount. If already completed, the
  // initial state is `done` and the component returns null forever.
  const [phase, setPhase] = useState<Phase>(() =>
    readTourCompleted() ? { kind: 'done' } : { kind: 'mission', index: 0 },
  );

  /**
   * Mark the tour as complete (for any reason) and notify the parent.
   * Idempotent — safe to call multiple times.
   */
  const finish = useCallback((): void => {
    writeTourCompleted();
    setPhase({ kind: 'done' });
    onComplete();
  }, [onComplete]);

  /**
   * Skip handler — same as Esc. Bound to the Skip button on every card
   * AND to the global Escape key while the overlay is mounted.
   */
  const skip = useCallback((): void => {
    finish();
  }, [finish]);

  // Esc-to-skip. We attach a window listener (capture phase) so it wins
  // over the canvas's existing Escape handler when the tour is active —
  // otherwise the canvas would just clear selection and our overlay
  // would stay up.
  useEffect(() => {
    if (phase.kind === 'done') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        skip();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [phase.kind, skip]);

  // Watch signals against the active mission's predicate. When it
  // matches, transition to the flash phase, then to the next mission
  // (or to the final-flash if this was mission 5).
  useEffect(() => {
    if (phase.kind !== 'mission') return;
    const def = MISSIONS[phase.index];
    if (def === undefined) return;
    if (!def.isComplete(signals)) return;

    // Last mission: play the agentReady fanfare, show final flash, then dismiss.
    const isLast = phase.index === MISSIONS.length - 1;
    if (isLast) {
      sound.taskComplete();
      sound.agentReady();
      setPhase({ kind: 'final-flash' });
      return;
    }

    // Otherwise: brief tick + flash, then advance.
    sound.taskComplete();
    setPhase({ kind: 'flash', index: phase.index });
  }, [phase, signals]);

  // Flash → next mission (intermediate transition).
  useEffect(() => {
    if (phase.kind !== 'flash') return;
    const t = window.setTimeout(() => {
      setPhase({ kind: 'mission', index: phase.index + 1 });
    }, FLASH_MS);
    return () => {
      window.clearTimeout(t);
    };
  }, [phase]);

  // Final flash → done. Same fade-out window as the intermediate flash
  // but with a longer hold so the operator reads "Tour complete."
  useEffect(() => {
    if (phase.kind !== 'final-flash') return;
    const t = window.setTimeout(() => {
      finish();
    }, FINAL_DISMISS_MS);
    return () => {
      window.clearTimeout(t);
    };
  }, [phase, finish]);

  if (phase.kind === 'done') return null;

  if (phase.kind === 'final-flash') {
    return (
      <div className={styles.card} role="status" aria-live="polite">
        <div className={styles.completeBanner}>
          <span className={styles.checkmark}>✓</span> Tour complete.
        </div>
      </div>
    );
  }

  if (phase.kind === 'flash') {
    return (
      <div className={styles.card} role="status" aria-live="polite">
        <div className={styles.completeBanner}>
          <span className={styles.checkmark}>✓</span> mission complete
        </div>
      </div>
    );
  }

  const def = MISSIONS[phase.index];
  if (def === undefined) return null;

  return (
    <div className={styles.card} role="dialog" aria-label="tutorial mission">
      <div className={styles.header}>
        <span className={styles.title}>{def.title}</span>
        <button
          type="button"
          className={styles.skipButton}
          onClick={skip}
          title="Skip the tour. You can re-enable from local storage."
        >
          skip tour
        </button>
      </div>
      <div className={styles.goal}>{def.goal}</div>
      <div className={styles.hintRow}>
        <kbd className={styles.kbd}>{def.hint}</kbd>
      </div>
      <div className={styles.progressRow}>
        {MISSIONS.map((m, i) => (
          <span
            key={m.id}
            className={
              i < phase.index
                ? styles.dotDone
                : i === phase.index
                  ? styles.dotActive
                  : styles.dotPending
            }
          />
        ))}
      </div>
    </div>
  );
}
