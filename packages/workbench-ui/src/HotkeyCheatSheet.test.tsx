/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Skeleton tests for HotkeyCheatSheet (WB-01).
 *
 * Plan 02 fills in the actual test logic after the component is
 * mounted in App.tsx and wired to the global hotkey handler.
 */

import { describe, it } from 'vitest';

describe('HotkeyCheatSheet', () => {
  it.todo('renders 4 sections when isOpen=true');
  it.todo('returns null when isOpen=false');
  it.todo('renders every HOTKEY_CHEAT_SHEET entry as a <kbd> element');
  it.todo('section headings match SCOPE_LABELS for all 4 scopes');
  it.todo('Esc keydown calls onClose');
  it.todo('backdrop click (on the backdrop itself) calls onClose');
  it.todo('clicking inside the dialog does NOT call onClose');
  it.todo('close button click calls onClose');
  it.todo('has role="dialog" aria-modal="true" aria-labelledby');
  it.todo('chord entries render two <kbd> elements with "then" separator');
});
