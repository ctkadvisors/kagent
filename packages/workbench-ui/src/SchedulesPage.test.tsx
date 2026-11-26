/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ScheduleSummary } from './types.js';

vi.mock('./api.js', () => ({
  fetchSchedules: vi.fn(),
  runScheduleNow: vi.fn(),
  subscribeCacheEvents: vi.fn(),
}));

import { fetchSchedules, runScheduleNow, subscribeCacheEvents } from './api.js';
import { nextTick, SchedulesPage } from './SchedulesPage.js';

const mockRunScheduleNow = runScheduleNow as ReturnType<typeof vi.fn>;

const mockFetchSchedules = fetchSchedules as ReturnType<typeof vi.fn>;
const mockSubscribeCacheEvents = subscribeCacheEvents as ReturnType<typeof vi.fn>;

function makeSchedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    namespace: 'kagent-system',
    name: 'brain-invalidation-audit',
    schedule: '*/15 * * * *',
    suspended: false,
    targetAgent: 'brain-auditor',
    lastTickAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    nextTickAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeSuspendedSchedule(): ScheduleSummary {
  const { targetAgent: _targetAgent, ...rest } = makeSchedule({
    name: 'paused-one',
    suspended: true,
    targetCapability: 'summarize',
  });
  return rest;
}

describe('SchedulesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSchedules.mockResolvedValue([makeSchedule()]);
    mockSubscribeCacheEvents.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders schedule rows with cron, status, and target', async () => {
    render(<SchedulesPage />);

    expect(await screen.findByRole('heading', { name: 'Schedules' })).toBeTruthy();
    expect(await screen.findByText('brain-invalidation-audit')).toBeTruthy();
    expect(screen.getByText('*/15 * * * *')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('brain-auditor')).toBeTruthy();
  });

  it('renders a suspended tag for suspended schedules', async () => {
    mockFetchSchedules.mockResolvedValue([makeSuspendedSchedule()]);
    render(<SchedulesPage />);

    expect(await screen.findByText('suspended')).toBeTruthy();
    expect(screen.getByText('summarize')).toBeTruthy();
  });

  it('shows an empty state when no schedules are observed', async () => {
    mockFetchSchedules.mockResolvedValue([]);
    render(<SchedulesPage />);

    expect(await screen.findByText(/no schedules observed/i)).toBeTruthy();
  });

  it('refreshes when a schedule stream event arrives', async () => {
    const stream: { onEvent: ((event: { readonly kind: string }) => void) | null } = {
      onEvent: null,
    };
    mockSubscribeCacheEvents.mockImplementation(
      (next: (event: { readonly kind: string }) => void) => {
        stream.onEvent = next;
        return vi.fn();
      },
    );

    render(<SchedulesPage />);
    await screen.findByText('brain-invalidation-audit');

    const emit = stream.onEvent;
    if (emit === null) throw new Error('stream subscription was not installed');
    emit({ kind: 'schedule' });

    await waitFor(() => {
      expect(mockFetchSchedules).toHaveBeenCalledTimes(2);
    });
  });

  it('does not refresh on unrelated stream events', async () => {
    const stream: { onEvent: ((event: { readonly kind: string }) => void) | null } = {
      onEvent: null,
    };
    mockSubscribeCacheEvents.mockImplementation(
      (next: (event: { readonly kind: string }) => void) => {
        stream.onEvent = next;
        return vi.fn();
      },
    );

    render(<SchedulesPage />);
    await screen.findByText('brain-invalidation-audit');
    mockFetchSchedules.mockClear();

    const emit = stream.onEvent;
    if (emit === null) throw new Error('stream subscription was not installed');
    emit({ kind: 'task' });

    expect(mockFetchSchedules).not.toHaveBeenCalled();
  });

  it('says "in" for a coming tick and "overdue" for one that has passed', () => {
    const now = Date.parse('2026-11-26T14:22:00Z');
    const at = (iso: string, suspended = false) =>
      nextTick(makeSchedule({ nextTickAt: iso, suspended }), now);
    expect(at('2026-11-26T14:30:00Z')).toEqual({ text: 'in 8m', overdue: false });
    // The three daily ticks the 2026-11-26 pause swallowed read "in 7h/10h/11h" before this.
    expect(at('2026-11-26T03:10:00Z')).toEqual({ text: 'overdue 11h', overdue: true });
    expect(at('2026-11-26T14:21:30Z')).toEqual({ text: 'in 0s', overdue: false });
    expect(at('2026-10-01T19:30:00Z', true)).toEqual({ text: '—', overdue: false });
    expect(
      nextTick(makeSchedule({ nextTickAt: '2026-11-26T14:05:00Z', whenIdle: true }), now),
    ).toEqual({ text: 'waiting for idle 17m', overdue: false });
  });

  it('Run now posts the request and reports it; a suspended row cannot be run', async () => {
    mockFetchSchedules.mockResolvedValue([makeSchedule(), makeSuspendedSchedule()]);
    mockRunScheduleNow.mockResolvedValue(undefined);
    render(<SchedulesPage />);

    const buttons = await screen.findAllByRole('button', { name: 'Run now' });
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[0] as HTMLButtonElement);
    expect(mockRunScheduleNow).toHaveBeenCalledWith('kagent-system', 'brain-invalidation-audit');
    expect(await screen.findByText(/requested, starts within a minute/)).toBeTruthy();
  });
});
