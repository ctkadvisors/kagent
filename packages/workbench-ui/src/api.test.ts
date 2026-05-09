/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-04 — tests for `fetchDispositions`.
 *
 * Covers:
 *   - Test 1: happy path — items array round-trips through the DTO guard
 *   - Test 2: non-2xx → throws an Error containing the status code
 *   - Test 3: schema drift — a row missing a required field is rejected
 *            by `assertIsDispositionOverlayRow` before reaching the UI
 *
 * The runtime guard lives in `@kagent/dto` and is the substrate-API-UI
 * tier-boundary defense per plan 03 D-DISP-03-A. These tests prove the
 * UI side bites when the API drifts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispositionOverlayRow } from '@kagent/dto/disposition';

import { fetchDispositions } from './api.js';

function makeRow(overrides: Partial<DispositionOverlayRow> = {}): DispositionOverlayRow {
  return {
    agentRef: 'kagent-system/researcher-01',
    namespace: 'kagent-system',
    agentName: 'researcher-01',
    configMapName: 'researcher-01-disposition',
    idleBehavior: {
      readChannels: [],
      attentionBudget: { tokensPerDay: 50_000, pollIntervalSeconds: 300 },
      proposalScope: { mayProposeAgainst: ['templates'], maxProposalsPerDay: 3 },
    },
    spentTokensToday: 12_345,
    postsToday: 0,
    proposalsToday: 1,
    overBudget: false,
    overBudgetEventCountToday: 0,
    dailyBoundaryUtc: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

function mockFetchOk(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(body),
        }) as unknown as Promise<Response>,
    ),
  );
}

function mockFetchNotOk(status: number, statusText: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        Promise.resolve({
          ok: false,
          status,
          statusText,
          json: () => Promise.resolve({}),
        }) as unknown as Promise<Response>,
    ),
  );
}

describe('fetchDispositions (DISP-04)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Test 1 — calls /api/dispositions and returns the items array', async () => {
    const row1 = makeRow();
    const row2 = makeRow({
      agentRef: 'kagent-system/curator-02',
      agentName: 'curator-02',
      configMapName: 'curator-02-disposition',
    });
    mockFetchOk({ items: [row1, row2] });

    const rows = await fetchDispositions();

    expect(rows).toEqual([row1, row2]);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/dispositions', {});
  });

  it('Test 2 — throws on non-2xx response with status in the message', async () => {
    mockFetchNotOk(500, 'Internal Server Error');

    await expect(fetchDispositions()).rejects.toThrow(/500/);
  });

  it('Test 3 — runtime-validates each row via assertIsDispositionOverlayRow; rejects on shape drift', async () => {
    const valid = makeRow();
    // Synthesize a row that survives JSON serialization but is missing
    // a required field — exactly the schema-drift case the guard exists
    // for.
    const invalid: Partial<DispositionOverlayRow> = {
      agentRef: 'kagent-system/broken',
      namespace: 'kagent-system',
      agentName: 'broken',
      configMapName: 'broken-disposition',
      idleBehavior: valid.idleBehavior,
      // spentTokensToday intentionally omitted
      postsToday: 0,
      proposalsToday: 0,
      overBudget: false,
      overBudgetEventCountToday: 0,
      dailyBoundaryUtc: '2026-05-09T00:00:00.000Z',
    };
    mockFetchOk({ items: [valid, invalid] });

    await expect(fetchDispositions()).rejects.toThrow(/spentTokensToday/);
  });

  it('Test 3b — empty items array is a valid response (defensive default)', async () => {
    mockFetchOk({ items: [] });

    const rows = await fetchDispositions();

    expect(rows).toEqual([]);
  });

  it('Test 3c — missing items field defaults to empty array', async () => {
    mockFetchOk({});

    const rows = await fetchDispositions();

    expect(rows).toEqual([]);
  });
});
