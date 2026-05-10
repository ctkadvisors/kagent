/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 4 / REV-02 / D-03-A — ReviewActions component tests.
 *
 * Tests the inline TaskDetail panel component with the 4 trigger conditions
 * and the accept/reject confirm flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { TaskDetail } from '../types.js';

// Mock api module
vi.mock('../api.js', () => ({
  acceptReviewQueueRow: vi.fn(),
  rejectReviewQueueRow: vi.fn(),
  ReviewActionApiError: class ReviewActionApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ReviewActionApiError';
      this.status = status;
    }
  },
}));

import { acceptReviewQueueRow, rejectReviewQueueRow } from '../api.js';

import { ReviewActions } from './ReviewActions.js';

const mockAccept = acceptReviewQueueRow as ReturnType<typeof vi.fn>;
const mockReject = rejectReviewQueueRow as ReturnType<typeof vi.fn>;

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    name: 'researcher-ok-01',
    namespace: 'kagent-system',
    uid: 'uid-001',
    phase: 'Completed',
    containerStatuses: [],
    suspicious: [],
    ...overrides,
  };
}

function makePilotEvidence(
  annotations: Record<string, string> = {},
): NonNullable<TaskDetail['pilotEvidence']> {
  return {
    audit: {
      labels: {},
      annotations,
    },
    policy: { agentResolved: true },
    taskGraph: {},
    artifacts: {},
  };
}

describe('ReviewActions (REV-02 / D-03-A inline entry point)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('Test 1 — renders Accept/Reject buttons for phase === Failed', () => {
    const task = makeTask({ phase: 'Failed' });
    const { container } = render(<ReviewActions task={task} onDecision={vi.fn()} />);

    expect(container.firstChild).not.toBeNull();
    expect(screen.getByTestId('review-accept-btn')).toBeTruthy();
    expect(screen.getByTestId('review-reject-btn')).toBeTruthy();
  });

  it('Test 2 — renders for suspicious.length > 0', () => {
    const task = makeTask({ phase: 'Completed', suspicious: ['hallucination-pattern'] });
    const { container } = render(<ReviewActions task={task} onDecision={vi.fn()} />);

    expect(container.firstChild).not.toBeNull();
    expect(screen.getByTestId('review-accept-btn')).toBeTruthy();
  });

  it('Test 3 — renders for review-requested === true annotation', () => {
    const task = makeTask({
      phase: 'Completed',
      suspicious: [],
      pilotEvidence: makePilotEvidence({
        'kagent.knuteson.io/review-requested': 'true',
      }),
    });
    const { container } = render(<ReviewActions task={task} onDecision={vi.fn()} />);

    expect(container.firstChild).not.toBeNull();
    expect(screen.getByTestId('review-accept-btn')).toBeTruthy();
  });

  it('Test 4 — renders for template-candidate === true annotation', () => {
    const task = makeTask({
      phase: 'Completed',
      suspicious: [],
      pilotEvidence: makePilotEvidence({
        'kagent.knuteson.io/template-candidate': 'true',
      }),
    });
    const { container } = render(<ReviewActions task={task} onDecision={vi.fn()} />);

    expect(container.firstChild).not.toBeNull();
    expect(screen.getByTestId('review-accept-btn')).toBeTruthy();
  });

  it('Test 5 — returns null for clean task (no trigger conditions)', () => {
    const task = makeTask({
      phase: 'Completed',
      suspicious: [],
      // no annotations
    });
    const { container } = render(<ReviewActions task={task} onDecision={vi.fn()} />);

    // Component should render null
    expect(container.firstChild).toBeNull();
  });

  it('Test 6 — Accept click -> confirm dialog -> POST -> onDecision called', async () => {
    const task = makeTask({ phase: 'Failed' });
    const onDecision = vi.fn();
    mockAccept.mockResolvedValue({
      taskRef: { namespace: 'kagent-system', name: 'researcher-ok-01', uid: 'uid-001' },
      decision: 'accepted',
      auditedAt: '2026-05-10T11:00:00.000Z',
    });

    render(<ReviewActions task={task} onDecision={onDecision} />);

    // Click Accept
    fireEvent.click(screen.getByTestId('review-accept-btn'));

    // Dialog should appear
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Click Confirm
    fireEvent.click(screen.getByTestId('review-confirm-accept'));

    await waitFor(() => {
      expect(mockAccept).toHaveBeenCalledWith('kagent-system', 'researcher-ok-01', {});
      expect(onDecision).toHaveBeenCalled();
    });
  });

  it('Test 7 — Reject click -> confirm dialog -> POST -> onDecision called', async () => {
    const task = makeTask({ phase: 'Failed' });
    const onDecision = vi.fn();
    mockReject.mockResolvedValue({
      taskRef: { namespace: 'kagent-system', name: 'researcher-ok-01', uid: 'uid-001' },
      decision: 'rejected',
      auditedAt: '2026-05-10T11:00:00.000Z',
    });

    render(<ReviewActions task={task} onDecision={onDecision} />);

    // Click Reject
    fireEvent.click(screen.getByTestId('review-reject-btn'));

    // Dialog should appear
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Click Confirm Reject
    fireEvent.click(screen.getByTestId('review-confirm-reject'));

    await waitFor(() => {
      expect(mockReject).toHaveBeenCalledWith('kagent-system', 'researcher-ok-01', {});
      expect(onDecision).toHaveBeenCalled();
    });
  });
});
