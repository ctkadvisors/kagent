/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MissionOverlay } from './Mission.js';

vi.mock('./sound.js', () => ({ sound: { taskComplete: vi.fn(), agentReady: vi.fn() } }));
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });
it('teaches drag pan and accepts a completed drag, then teaches Shift-drag marquee', () => {
  vi.useFakeTimers();
  const signals = { selectionCount: 1, anyPanKeyHeld: false, dragPanned: false, lastDragSelectCount: 0, dispatchOpen: false, bookmarkSavedSlot5: false, bookmarkRecalledSlot5: false };
  const { container, rerender } = render(<MissionOverlay signals={signals} onComplete={() => {}} />);
  act(() => { vi.advanceTimersByTime(700); });
  expect(container.textContent).toContain('Drag empty canvas to pan');
  rerender(<MissionOverlay signals={{ ...signals, dragPanned: true }} onComplete={() => {}} />);
  expect(container.textContent).toContain('mission complete');
  act(() => { vi.advanceTimersByTime(700); });
  expect(container.textContent).toContain('Shift-drag');
});
