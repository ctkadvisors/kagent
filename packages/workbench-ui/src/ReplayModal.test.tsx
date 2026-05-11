/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Skeleton tests for ReplayModal (WB-03).
 *
 * Plan 02 fills in the actual test logic after ReplayModal is mounted
 * in TaskDetail.tsx and wired to the real task data.
 */

import { describe, it } from 'vitest';

describe('ReplayModal', () => {
  it.todo('returns null when isOpen=false');
  it.todo('renders with role="dialog" aria-modal="true" aria-labelledby when isOpen=true');
  it.todo('pre-fills Target Agent dropdown with the original task.targetAgent');
  it.todo('populates Target Agent dropdown from /api/agents');
  it.todo('reason textarea enforces maxLength=256 (client-side rejection)');
  it.todo('submit button is disabled while submitting');
  it.todo('onSubmit calls createTask with replayOf.taskRef containing namespace, name, uid');
  it.todo('onSubmit calls createTask with replayOf.reason when reason is non-empty');
  it.todo('onSubmit omits replayOf.reason when reason textarea is empty');
  it.todo('on 201 response: calls onSubmitted with created task, calls onClose, plays taskComplete sound');
  it.todo('on 422 response: shows error banner from err.message, plays taskFailed sound');
  it.todo('on 422 response with fields: maps per-field errors');
  it.todo('Esc keydown calls onClose');
  it.todo('backdrop click (on the backdrop itself) calls onClose');
  it.todo('clicking inside the dialog does NOT call onClose');
  it.todo('original message rendered as text node inside <pre> (XSS safety: no raw HTML injection)');
});
