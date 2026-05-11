/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Skeleton tests for SelectionActions (WB-02).
 *
 * Plan 02 fills in the actual test logic after SelectionActions is
 * mounted in CommandView.tsx and wired to real selection/snapshot state.
 */

import { describe, it } from 'vitest';

describe('SelectionActions', () => {
  it.todo('returns null when selection.keys.size < 2 (size=0)');
  it.todo('returns null when selection.keys.size < 2 (size=1)');
  it.todo('renders 3 buttons when selection.keys.size === 2');
  it.todo('renders 3 buttons when selection.keys.size > 2');
  it.todo('"Open N in tabs" button label reflects min(size, 10)');
  it.todo('"Open N in tabs" is capped at 10 even when size > 10');
  it.todo('"Copy N IDs" button label reflects selection.keys.size');
  it.todo('"Scroll to first failure" button has correct data-testid');
  it.todo('all 3 buttons have stable data-testid attributes');
  it.todo('tab cap at 10 + overflow: toast via setAlertText when size > 10 (Plan 02 wires)');
  it.todo('clipboard fallback shows textarea on permission denial (Plan 02 wires)');
  it.todo('scroll-to-failure pans camera to first failing agent (Plan 02 wires)');
  it.todo('scroll-to-failure no-match: shows toast via setAlertText (Plan 02 wires)');
});
