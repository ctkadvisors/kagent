/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { TaskSummary } from './types.js';

vi.mock('./api.js', () => ({
  fetchTasks: vi.fn(),
  subscribeCacheEvents: vi.fn(),
  terminateTask: vi.fn(),
}));

vi.mock('./NewTaskModal.js', () => ({
  NewTaskModal: () => null,
}));

import { fetchTasks, subscribeCacheEvents, terminateTask } from './api.js';
import { TaskList } from './TaskList.js';

const mockFetchTasks = fetchTasks as ReturnType<typeof vi.fn>;
const mockSubscribeCacheEvents = subscribeCacheEvents as ReturnType<typeof vi.fn>;
const mockTerminateTask = terminateTask as ReturnType<typeof vi.fn>;

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  const name = overrides.name ?? 'traced-run';
  return {
    name,
    namespace: 'kagent-draft',
    uid: `uid-${name}`,
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
    mockTerminateTask.mockReset();
    mockSubscribeCacheEvents.mockReturnValue(vi.fn());
    mockTerminateTask.mockResolvedValue(undefined);
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

  it('renders a terminate action for in-flight tasks and calls DELETE after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockFetchTasks.mockResolvedValue([
      makeTask({ name: 'queued', phase: 'Pending' }),
      makeTask({ name: 'running', phase: 'Dispatched' }),
      makeTask({ name: 'done', phase: 'Completed' }),
    ]);

    render(<TaskList />);

    const terminateButtons = await screen.findAllByRole('button', { name: /^terminate /i });
    expect(terminateButtons.map((btn) => btn.textContent)).toEqual([
      'terminate queued',
      'terminate running',
    ]);

    fireEvent.click(terminateButtons[1] as HTMLButtonElement);

    await waitFor(() => {
      expect(mockTerminateTask).toHaveBeenCalledWith('kagent-draft', 'running');
    });
    expect(confirmSpy).toHaveBeenCalled();
  });
});
