/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Skeleton tests for hotkeys.ts (WB-01).
 *
 * Plan 02 fills in the actual test logic after the chord state machine
 * is wired in useGlobalHotkeys. The it.todo() entries here document
 * every behavior from VALIDATION.md WB-01 unit rows.
 */

import { describe, it } from 'vitest';

describe('isTextTarget', () => {
  it.todo('returns true for INPUT');
  it.todo('returns true for TEXTAREA');
  it.todo('returns true for SELECT');
  it.todo('returns true for contenteditable element');
  it.todo('returns false for DIV');
  it.todo('returns false for null target');
  it.todo('returns false for non-HTMLElement target (e.g. SVGElement)');
});

describe('HOTKEY_CHEAT_SHEET', () => {
  it.todo('has at least 9 entries');
  it.todo('has entries for all 4 scopes (global, command-view, task-detail, review-page)');
  it.todo('all chord entries have a 2-element chord tuple');
  it.todo('is frozen (Object.isFrozen returns true)');
});

describe('useGlobalHotkeys chord state (Plan 02 wires)', () => {
  it.todo('g+t navigates to #/tasks');
  it.todo('g+g navigates to #/gateway');
  it.todo('g+c navigates to #/command');
  it.todo('g+k navigates to #/cluster');
  it.todo('g+r navigates to #/review');
  it.todo('? calls onOpenCheatSheet callback');
  it.todo('1500ms timeout silently expires mid-chord without navigation');
  it.todo('Esc cancels a pending mid-chord');
  it.todo('Ctrl+g does NOT trigger the g-chord');
  it.todo('hotkey is ignored when target is a text element (isTextTarget guard)');
});
