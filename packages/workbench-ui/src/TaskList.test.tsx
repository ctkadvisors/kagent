/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import type { TaskSummary } from './types.js';

vi.mock('./api.js', () => ({
  fetchTasks: vi.fn(),
  subscribeCacheEvents: vi.fn(),
}));

vi.mock('./NewTaskModal.js', () => ({
  NewTaskModal: () => null,
}));

import { fetchTasks, subscribeCacheEvents } from './api.js';
import { TaskList } from './TaskList.js';

const mockFetchTasks = fetchTasks as ReturnType<typeof vi.fn>;
const mockSubscribeCacheEvents = subscribeCacheEvents as ReturnType<typeof vi.fn>;

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    name: 'traced-run',
    namespace: 'kagent-draft',
    uid: 'uid-traced-run',
    phase: 'Completed',
    targetAgent: 'draft-agent',
    createdAt: '2026-06-08T17:00:00Z',
    ...overrides,
  };
}

describe('TaskList trace links', () => {
  beforeEach(() => {
    mockFetchTasks.mockReset();
    mockSubscribeCacheEvents.mockReset();
    mockSubscribeCacheEvents.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders a direct trace link when the task summary includes one', async () => {
    mockFetchTasks.mockResolvedValue([
      makeTask({
        traceLink: {
          provider: 'langfuse',
          runId: 'uid-traced-run',
          url: 'https://langfuse.example.com/trace/abc123',
        },
      }),
    ]);

    render(<TaskList />);

    const link = await screen.findByRole('link', { name: 'open trace' });
    expect(link.getAttribute('href')).toBe('https://langfuse.example.com/trace/abc123');
    expect(link.getAttribute('target')).toBe('_blank');
    await waitFor(() => {
      expect(mockFetchTasks).toHaveBeenCalledTimes(1);
    });
  });
});
