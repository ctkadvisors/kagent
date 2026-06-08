/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { CacheChangeEvent, TaskDetail } from './types.js';

vi.mock('./command/ReviewActions.js', () => ({
  ReviewActions: () => null,
}));

vi.mock('./api.js', () => ({
  fetchTaskDetail: vi.fn(),
  subscribeCacheEvents: vi.fn(),
}));

import { fetchTaskDetail, subscribeCacheEvents } from './api.js';
import { TaskDetail as TaskDetailPage } from './TaskDetail.js';

const mockFetchTaskDetail = fetchTaskDetail as ReturnType<typeof vi.fn>;
const mockSubscribeCacheEvents = subscribeCacheEvents as ReturnType<typeof vi.fn>;

function makeDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    name: 'draft-run',
    namespace: 'kagent-draft',
    uid: 'uid-001',
    phase: 'Dispatched',
    targetAgent: 'draft-agent',
    containerStatuses: [],
    ...overrides,
  };
}

function renderDetail(): void {
  render(<TaskDetailPage namespace="kagent-draft" name="draft-run" onBack={vi.fn()} />);
}

describe('TaskDetail refresh behavior', () => {
  let onCache: ((ev: CacheChangeEvent) => void) | undefined;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetchTaskDetail.mockReset();
    mockSubscribeCacheEvents.mockReset();
    onCache = undefined;
    unsubscribe = vi.fn();
    mockSubscribeCacheEvents.mockImplementation((cacheHandler: (ev: CacheChangeEvent) => void) => {
      onCache = cacheHandler;
      return unsubscribe;
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not refetch terminal task detail on later job or pod cache events', async () => {
    mockFetchTaskDetail.mockResolvedValue(makeDetail({ phase: 'Completed', result: 'done' }));

    renderDetail();

    expect(await screen.findByText('Completed')).toBeTruthy();
    expect(mockFetchTaskDetail).toHaveBeenCalledTimes(1);

    act(() => {
      onCache?.({ kind: 'job', op: 'upsert', key: 'kagent-draft/draft-run-job' });
      onCache?.({ kind: 'pod', op: 'upsert', key: 'kagent-draft/draft-run-pod' });
    });

    expect(mockFetchTaskDetail).toHaveBeenCalledTimes(1);
  });

  it('still refetches terminal task detail on direct task cache events', async () => {
    mockFetchTaskDetail
      .mockResolvedValueOnce(makeDetail({ phase: 'Completed', result: 'old' }))
      .mockResolvedValueOnce(makeDetail({ phase: 'Completed', result: 'new' }));

    renderDetail();

    expect(await screen.findByText('Completed')).toBeTruthy();
    expect(mockFetchTaskDetail).toHaveBeenCalledTimes(1);

    act(() => {
      onCache?.({ kind: 'task', op: 'upsert', key: 'kagent-draft/draft-run' });
    });

    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledTimes(2);
    });
  });

  it('still refetches non-terminal task detail on related cache events', async () => {
    mockFetchTaskDetail.mockResolvedValue(makeDetail({ phase: 'Dispatched' }));

    renderDetail();

    expect(await screen.findByText('Dispatched')).toBeTruthy();
    expect(mockFetchTaskDetail).toHaveBeenCalledTimes(1);

    act(() => {
      onCache?.({ kind: 'job', op: 'upsert', key: 'kagent-draft/draft-run-job' });
    });

    expect(mockFetchTaskDetail).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes on unmount', async () => {
    mockFetchTaskDetail.mockResolvedValue(makeDetail());

    const { unmount } = render(
      <TaskDetailPage namespace="kagent-draft" name="draft-run" onBack={vi.fn()} />,
    );
    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledTimes(1);
    });

    unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
