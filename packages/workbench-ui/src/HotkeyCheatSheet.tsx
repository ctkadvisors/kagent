/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * HotkeyCheatSheet — Phase 5 (WB-01). Modal overlay listing all
 * keyboard shortcuts registered in HOTKEY_CHEAT_SHEET.
 *
 * Shape mirrors NewTaskModal.tsx: backdrop + card, Esc-to-close,
 * backdrop-click-to-close, role="dialog" aria-modal aria-labelledby.
 *
 * Plan 02 mounts this in App.tsx and wires the open/close state to
 * the `?` global hotkey via `useGlobalHotkeys({ onOpenCheatSheet })`.
 */

import { useEffect } from 'react';

import { HOTKEY_CHEAT_SHEET, type HotkeyEntry } from './hotkeys.js';
import styles from './HotkeyCheatSheet.module.css';

export interface HotkeyCheatSheetProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

/** Scope labels for section headings. */
const SCOPE_LABELS: Record<HotkeyEntry['scope'], string> = {
  global: 'Global navigation',
  'command-view': 'Inside Command Center',
  'task-detail': 'Inside Task Detail',
  'review-page': 'Inside Review Queue',
};

/** Canonical section order. */
const SCOPE_ORDER: readonly HotkeyEntry['scope'][] = [
  'global',
  'command-view',
  'task-detail',
  'review-page',
];

/** Group entries by scope, maintaining SCOPE_ORDER. */
function groupByScope(
  entries: readonly HotkeyEntry[],
): Array<{ scope: HotkeyEntry['scope']; items: readonly HotkeyEntry[] }> {
  const map = new Map<HotkeyEntry['scope'], HotkeyEntry[]>();
  for (const entry of entries) {
    const existing = map.get(entry.scope);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      map.set(entry.scope, [entry]);
    }
  }
  return SCOPE_ORDER.filter((s) => map.has(s)).map((scope) => ({
    scope,
    items: map.get(scope) ?? [],
  }));
}

/**
 * Render the keyboard label for a hotkey entry.
 * For chord entries: renders "g then t" style using two <kbd> spans.
 * For single-key entries: renders one <kbd> span.
 */
function KeyLabel({ entry }: { readonly entry: HotkeyEntry }): React.JSX.Element {
  if (entry.chord !== undefined) {
    const [first, second] = entry.chord;
    return (
      <span className={styles.kbd}>
        <kbd className={styles.key}>{first}</kbd>
        <span className={styles.chordSep}>then</span>
        <kbd className={styles.key}>{second}</kbd>
      </span>
    );
  }
  return (
    <span className={styles.kbd}>
      {entry.modifier !== undefined ? (
        <>
          <kbd className={styles.key}>{entry.modifier}</kbd>
          <span className={styles.chordSep}>+</span>
        </>
      ) : null}
      <kbd className={styles.key}>{entry.key}</kbd>
    </span>
  );
}

export function HotkeyCheatSheet({ isOpen, onClose }: HotkeyCheatSheetProps): React.JSX.Element | null {
  // Mirror NewTaskModal.tsx L68-76: Esc-to-close.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sections = groupByScope(HOTKEY_CHEAT_SHEET);

  return (
    <div
      className={styles.backdrop}
      onClick={(e) => {
        // Mirror NewTaskModal.tsx L119-126: backdrop-click-to-close.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hotkey-cheat-sheet-title"
      >
        <div className={styles.header}>
          <h2 id="hotkey-cheat-sheet-title" className={styles.title}>
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          {sections.map(({ scope, items }) => (
            <section key={scope} className={styles.section}>
              <h3 className={styles.sectionTitle}>{SCOPE_LABELS[scope]}</h3>
              <ul className={styles.entryList}>
                {items.map((entry, i) => (
                  // Chord entries share the same primary key, so we need an index.
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={`${scope}-${entry.key}-${i}`} className={styles.entry}>
                    <KeyLabel entry={entry} />
                    <span className={styles.description}>{entry.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
