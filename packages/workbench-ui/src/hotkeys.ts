/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Shared hotkey registry + the `useGlobalHotkeys` chord-stub hook.
 *
 * Phase 5 (WB-01). See .planning/phases/05-workbench-usability-primitives/05-CONTEXT.md D-01.
 *
 * Plan 02 wires the full chord state machine into `useGlobalHotkeys`.
 * This file ships the stable surface that Plan 02 imports without
 * codebase spelunking:
 *
 *   - `isTextTarget`         — guard used by keyboard handlers
 *   - `HotkeyEntry`          — type for a single cheat-sheet entry
 *   - `HOTKEY_CHEAT_SHEET`   — frozen, exhaustive entry array
 *   - `useGlobalHotkeys`     — stub hook (Plan 02 fills in the body)
 */

import { useEffect } from 'react';

/**
 * A single cheat-sheet entry describing one hotkey binding.
 */
export type HotkeyEntry = {
  /**
   * Primary key (displayed in <kbd>). For chord sequences this is the
   * FIRST key (e.g. 'g' for the 'g t' → tasks list chord).
   */
  readonly key: string;
  /** Keyboard modifier required, if any. */
  readonly modifier?: 'Ctrl' | 'Shift' | 'Alt' | 'Meta';
  /**
   * Two-part chord: [firstKey, secondKey]. When present, `key` is
   * rendered as part of the chord; `chord[1]` is the second key.
   */
  readonly chord?: readonly [string, string];
  /** Which view this hotkey applies to. */
  readonly scope: 'global' | 'command-view' | 'task-detail' | 'review-page';
  /** Human-readable description shown in the cheat sheet. */
  readonly description: string;
};

/**
 * Frozen, exhaustive cheat-sheet array covering all Phase 5 hotkeys.
 *
 * Lifted from 05-CONTEXT.md D-01 (hotkey scheme — 5 navigation chords
 * + 4 per-route hotkeys). Plan 02 wires the actual chord state machine
 * in `useGlobalHotkeys`; this const is the source of truth for the UI.
 */
export const HOTKEY_CHEAT_SHEET: readonly HotkeyEntry[] = Object.freeze([
  // ── Global navigation chords (g + letter) ────────────────────────
  {
    key: 'g',
    chord: ['g', 't'] as const,
    scope: 'global',
    description: 'Open tasks list',
  },
  {
    key: 'g',
    chord: ['g', 'g'] as const,
    scope: 'global',
    description: 'Open gateway',
  },
  {
    key: 'g',
    chord: ['g', 'c'] as const,
    scope: 'global',
    description: 'Open Command Center',
  },
  {
    key: 'g',
    chord: ['g', 'k'] as const,
    scope: 'global',
    description: 'Open cluster',
  },
  {
    key: 'g',
    chord: ['g', 'r'] as const,
    scope: 'global',
    description: 'Open review queue',
  },
  // ── Global meta ────────────────────────────────────────────────────
  {
    key: '?',
    scope: 'global',
    description:
      'Show this cheat sheet (except in Command Center, where ? toggles the in-canvas hint overlay)',
  },
  // ── Task Detail hotkeys ────────────────────────────────────────────
  {
    key: 't',
    scope: 'task-detail',
    description: 'Open trace link (when present)',
  },
  // ── Review Page hotkeys ───────────────────────────────────────────
  {
    key: 'j',
    scope: 'review-page',
    description: 'Next queue row',
  },
  {
    key: 'k',
    scope: 'review-page',
    description: 'Previous queue row',
  },
  {
    key: 'a',
    scope: 'review-page',
    description: 'Accept focused row',
  },
  {
    key: 'r',
    scope: 'review-page',
    description: 'Reject focused row',
  },
  // ── Command View hotkeys ──────────────────────────────────────────
  {
    key: 'o',
    scope: 'command-view',
    description: 'Open detail for current focus (no Agent detail page in v0.2 — toast)',
  },
]);

/**
 * Returns true when the event target is an interactive text element
 * (INPUT, TEXTAREA, SELECT, or a contenteditable) where keyboard
 * events should NOT be intercepted by global hotkey handlers.
 *
 * Lifted verbatim from CommandView.tsx L662-671 in Phase 5 (WB-01);
 * see .planning/phases/05-workbench-usability-primitives/05-CONTEXT.md D-01.
 */
export function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/**
 * STUB hook — Plan 02 replaces the body with the full chord state
 * machine from RESEARCH §9.3.
 *
 * The signature is STABLE: Plan 02 only changes the implementation
 * body; callers in App.tsx import this exact signature today so
 * no import changes are needed in Plan 02.
 *
 * @param opts.onOpenCheatSheet  Called when the user triggers the '?'
 *   global hotkey (except inside Command Center, where '?' opens the
 *   in-canvas hint overlay instead). Plan 02 wires this.
 */
export function useGlobalHotkeys(opts?: { onOpenCheatSheet?: () => void }): void {
  // STUB: Plan 02 replaces this body with the full chord state machine.
  // The `opts` reference is consumed so strict-mode TS doesn't complain.
  useEffect(() => {
    void opts;
  }, [opts]);
}
