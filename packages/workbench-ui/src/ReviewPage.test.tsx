/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 4 / REV-01 / REV-02 — ReviewPage component tests.
 *
 * Covers:
 *   - Table rendering with mocked rows + data-source-field attributes
 *   - Empty state
 *   - Loading state
 *   - Error state
 *   - Accept flow: click -> confirm dialog -> POST -> refresh
 *   - Reject flow: click -> confirm dialog -> POST -> refresh
 *   - Confirm dialog Escape key closes without POST
 *   - source-field attribute for 'reason' cell
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReviewQueueRow } from '@kagent/dto/review-queue';

// Mock the api module
vi.mock('./api.js', () => ({
  useReviewQueue: vi.fn(),
  acceptReviewQueueRow: vi.fn(),
  rejectReviewQueueRow: vi.fn(),
  requestReview: vi.fn(),
  ReviewActionApiError: class ReviewActionApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ReviewActionApiError';
      this.status = status;
    }
  },
}));

import {
  useReviewQueue,
  acceptReviewQueueRow,
  rejectReviewQueueRow,
} from './api.js';

import { ReviewPage } from './ReviewPage.js';

function makeRow(overrides: Partial<ReviewQueueRow> = {}): ReviewQueueRow {
  return {
    taskRef: {
      namespace: 'kagent-system',
      name: 'researcher-fail-01',
      uid: 'uid-001',
    },
    reason: 'verifier-failed',
    reasonDetail: 'verifier returned non-JSON output',
    enqueuedAt: '2026-05-10T10:00:00.000Z',
    stalenessSeconds: 3600,
    phase: 'Failed',
    targetAgent: 'researcher-01',
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    ...overrides,
  };
}

const mockUseReviewQueue = useReviewQueue as ReturnType<typeof vi.fn>;
const mockAccept = acceptReviewQueueRow as ReturnType<typeof vi.fn>;
const mockReject = rejectReviewQueueRow as ReturnType<typeof vi.fn>;

describe('ReviewPage (REV-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('Test 1 — renders rows from useReviewQueue mock with data-source-field attributes', () => {
    const row1 = makeRow();
    const row2 = makeRow({
      taskRef: { namespace: 'kagent-system', name: 'researcher-suspicious-01', uid: 'uid-002' },
      reason: 'suspicious-detector',
      reasonDetail: 'hallucination-pattern, unexpected-tool-use',
      phase: 'Completed',
    });
    const refresh = vi.fn();
    mockUseReviewQueue.mockReturnValue({
      rows: [row1, row2],
      loading: false,
      error: null,
      refresh,
    });

    render(<ReviewPage onBack={vi.fn()} />);

    // Verify 2 data rows rendered (not counting header row)
    const tbody = document.querySelector('tbody');
    expect(tbody).not.toBeNull();
    const rows = tbody!.querySelectorAll('tr');
    expect(rows.length).toBe(2);

    // Verify data-source-field attributes on cells
    const reasonCells = document.querySelectorAll('td[data-source-field="reason"]');
    expect(reasonCells.length).toBe(2);

    // Verify Open Detail link encodes namespace+name
    const detailLink = screen.getByRole('link', { name: /kagent-system\/researcher-fail-01/ });
    expect(detailLink.getAttribute('href')).toBe('#/tasks/kagent-system/researcher-fail-01');
  });

  it('Test 2 — empty state message when no rows', () => {
    mockUseReviewQueue.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<ReviewPage onBack={vi.fn()} />);

    expect(screen.getByText(/No items pending review/i)).toBeTruthy();
  });

  it('Test 3 — loading state shows loading indicator', () => {
    mockUseReviewQueue.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      refresh: vi.fn(),
    });

    render(<ReviewPage onBack={vi.fn()} />);

    expect(screen.getByText(/Loading/i)).toBeTruthy();
  });

  it('Test 4 — error state shows error message', () => {
    mockUseReviewQueue.mockReturnValue({
      rows: [],
      loading: false,
      error: 'fetch failed: 503 Service Unavailable',
      refresh: vi.fn(),
    });

    render(<ReviewPage onBack={vi.fn()} />);

    expect(screen.getByText(/fetch failed/i)).toBeTruthy();
  });

  it('Test 5 — Accept click opens confirm dialog, POST called, refresh called on confirm', async () => {
    const row = makeRow();
    const refresh = vi.fn();
    mockUseReviewQueue.mockReturnValue({
      rows: [row],
      loading: false,
      error: null,
      refresh,
    });
    mockAccept.mockResolvedValue({
      taskRef: row.taskRef,
      decision: 'accepted',
      auditedAt: '2026-05-10T11:00:00.000Z',
    });

    render(<ReviewPage onBack={vi.fn()} />);

    // Click Accept button for first row
    const acceptBtn = screen.getByTestId('accept-row-0');
    fireEvent.click(acceptBtn);

    // Confirm dialog should open
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Click Confirm in dialog
    const confirmBtn = screen.getByTestId('confirm-accept');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockAccept).toHaveBeenCalledWith('kagent-system', 'researcher-fail-01', {});
      expect(refresh).toHaveBeenCalled();
    });
  });

  it('Test 6 — Reject click opens confirm dialog, POST called, refresh called on confirm', async () => {
    const row = makeRow();
    const refresh = vi.fn();
    mockUseReviewQueue.mockReturnValue({
      rows: [row],
      loading: false,
      error: null,
      refresh,
    });
    mockReject.mockResolvedValue({
      taskRef: row.taskRef,
      decision: 'rejected',
      auditedAt: '2026-05-10T11:00:00.000Z',
    });

    render(<ReviewPage onBack={vi.fn()} />);

    // Click Reject button for first row
    const rejectBtn = screen.getByTestId('reject-row-0');
    fireEvent.click(rejectBtn);

    // Confirm dialog should open
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Click Confirm in dialog
    const confirmBtn = screen.getByTestId('confirm-reject');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockReject).toHaveBeenCalledWith('kagent-system', 'researcher-fail-01', {});
      expect(refresh).toHaveBeenCalled();
    });
  });

  it('Test 7 — Confirm dialog Escape closes without POST', () => {
    const row = makeRow();
    const refresh = vi.fn();
    mockUseReviewQueue.mockReturnValue({
      rows: [row],
      loading: false,
      error: null,
      refresh,
    });

    render(<ReviewPage onBack={vi.fn()} />);

    // Click Accept to open dialog
    const acceptBtn = screen.getByTestId('accept-row-0');
    fireEvent.click(acceptBtn);

    expect(screen.getByRole('dialog')).toBeTruthy();

    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    // Dialog should be gone
    expect(screen.queryByRole('dialog')).toBeNull();
    // No POST called
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('Test 8 — source-field attribute "reason" is present on reason cell', () => {
    const row = makeRow();
    mockUseReviewQueue.mockReturnValue({
      rows: [row],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<ReviewPage onBack={vi.fn()} />);

    const reasonCell = document.querySelector('td[data-source-field="reason"]');
    expect(reasonCell).not.toBeNull();
  });
});
