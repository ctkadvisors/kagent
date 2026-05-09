/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-04 — tests for `useCommandSnapshot`'s dispositions
 * extension.
 *
 * Covers:
 *   - Test 4: snapshot.dispositions is a ReadonlyMap keyed by agentRef
 *   - Test 5: SSE 'agent' event triggers refetchDispositions
 *   - Test 6: initial mount triggers refetchDispositions exactly once
 *   - Test 7: 30s periodic refetch fires; unmount clears the interval
 *
 * SSE testing strategy: the existing `subscribeCacheEvents` is mocked
 * to capture the `onCache` callback the hook installs. The test then
 * dispatches a synthetic 'agent' event by invoking the captured
 * callback directly — this is the same shim pattern the agents-side
 * refetch already uses (the Command Center has no fixture-based
 * EventSource test infrastructure today; the seam is the captured
 * callback). Documented in the SUMMARY's "Test seams" section.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { CacheChangeEvent } from '../types.js';

// Capture the SSE callback so tests can dispatch synthetic events.
let onCacheCallback: ((ev: CacheChangeEvent) => void) | null = null;

vi.mock('../api.js', () => {
  return {
    fetchAgents: vi.fn(() => Promise.resolve([])),
    fetchTasks: vi.fn(() => Promise.resolve([])),
    fetchGatewayCapacity: vi.fn(() =>
      Promise.resolve({ rows: [], fetchedAt: '2026-05-09T00:00:00Z' }),
    ),
    fetchGatewayUsage: vi.fn(() =>
      Promise.resolve({ rows: [], fetchedAt: '2026-05-09T00:00:00Z' }),
    ),
    fetchDispositions: vi.fn(() => Promise.resolve([])),
    subscribeCacheEvents: vi.fn(
      (onCache: (ev: CacheChangeEvent) => void, _onHeartbeat?: () => void) => {
        onCacheCallback = onCache;
        return () => {
          onCacheCallback = null;
        };
      },
    ),
  };
});

import { fetchDispositions } from '../api.js';
import { useCommandSnapshot } from './state.js';

const mockedFetchDispositions = fetchDispositions as unknown as ReturnType<typeof vi.fn>;

function makeRow(agentRef: string, agentName: string): unknown {
  return {
    agentRef,
    namespace: agentRef.split('/')[0] ?? 'kagent-system',
    agentName,
    configMapName: `${agentName}-disposition`,
    idleBehavior: {
      readChannels: [],
      attentionBudget: { tokensPerDay: 50_000, pollIntervalSeconds: 300 },
      proposalScope: { mayProposeAgainst: ['templates'], maxProposalsPerDay: 3 },
    },
    spentTokensToday: 0,
    postsToday: 0,
    proposalsToday: 0,
    overBudget: false,
    overBudgetEventCountToday: 0,
    dailyBoundaryUtc: '2026-05-09T00:00:00.000Z',
  };
}

describe('useCommandSnapshot — DISP-04 dispositions extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onCacheCallback = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Test 4 — snapshot.dispositions is a ReadonlyMap keyed by agentRef', async () => {
    const rowA = makeRow('kagent-system/agent-a', 'agent-a');
    const rowB = makeRow('kagent-system/agent-b', 'agent-b');
    mockedFetchDispositions.mockReturnValueOnce(Promise.resolve([rowA, rowB]));

    const { result } = renderHook(() => useCommandSnapshot());

    await waitFor(() => {
      expect(result.current.dispositions.size).toBe(2);
    });
    expect(result.current.dispositions.get('kagent-system/agent-a')).toEqual(rowA);
    expect(result.current.dispositions.get('kagent-system/agent-b')).toEqual(rowB);
  });

  it('Test 5 — SSE agent event triggers refetchDispositions', async () => {
    mockedFetchDispositions.mockReturnValue(Promise.resolve([]));
    const { result } = renderHook(() => useCommandSnapshot());

    // Wait for mount-time fetch to complete.
    await waitFor(() => {
      expect(mockedFetchDispositions).toHaveBeenCalledTimes(1);
    });
    // Sanity: the SSE shim captured the callback.
    expect(onCacheCallback).not.toBeNull();
    expect(result.current.dispositions.size).toBe(0);

    // Dispatch a synthetic 'agent' cache event — the disposition
    // refetcher must be invoked because rows are keyed by agentRef.
    const before = mockedFetchDispositions.mock.calls.length;
    act(() => {
      onCacheCallback?.({ kind: 'agent', op: 'upsert', key: 'kagent-system/agent-a' });
    });
    await waitFor(() => {
      expect(mockedFetchDispositions.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('Test 5b — SSE task event does NOT trigger refetchDispositions', async () => {
    mockedFetchDispositions.mockReturnValue(Promise.resolve([]));
    renderHook(() => useCommandSnapshot());
    await waitFor(() => {
      expect(mockedFetchDispositions).toHaveBeenCalledTimes(1);
    });

    const before = mockedFetchDispositions.mock.calls.length;
    act(() => {
      onCacheCallback?.({ kind: 'task', op: 'upsert', key: 'kagent-system/t1' });
    });
    // Give the next microtask a chance — refetch is fire-and-forget.
    await Promise.resolve();
    expect(mockedFetchDispositions.mock.calls.length).toBe(before);
  });

  it('Test 6 — initial mount triggers refetchDispositions exactly once', async () => {
    mockedFetchDispositions.mockReturnValue(Promise.resolve([]));
    renderHook(() => useCommandSnapshot());

    await waitFor(() => {
      expect(mockedFetchDispositions).toHaveBeenCalledTimes(1);
    });
  });

  it('Test 7 — periodic 30s interval triggers refetchDispositions; unmount clears it', async () => {
    vi.useFakeTimers({
      // Vitest ≥1: list the timer kinds to fake. Default includes
      // setTimeout / setInterval — ESM resolution of these in the
      // hook needs setInterval to be intercepted.
      toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout'],
    });
    mockedFetchDispositions.mockReturnValue(Promise.resolve([]));
    const { unmount } = renderHook(() => useCommandSnapshot());

    // Mount-time fetch should already have fired (microtask, not a
    // timer) — flush it before measuring.
    await vi.runOnlyPendingTimersAsync();
    const afterMount = mockedFetchDispositions.mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    // Advance 30s — the disposition poll fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockedFetchDispositions.mock.calls.length).toBeGreaterThan(afterMount);

    // Advance another 30s and capture the count.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const afterTwoTicks = mockedFetchDispositions.mock.calls.length;
    expect(afterTwoTicks).toBeGreaterThan(afterMount + 1);

    // Unmount — the interval must be cleared so further ticks don't fire.
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockedFetchDispositions.mock.calls.length).toBe(afterTwoTicks);
  });
});
