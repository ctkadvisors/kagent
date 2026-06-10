/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-04 — tests for `fetchDispositions`.
 * Phase 4 / REV-01 — tests for review-queue API helpers + useReviewQueue hook.
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
import type { ReviewQueueRow } from '@kagent/dto/review-queue';

import {
  fetchDispositions,
  fetchSessionProfiles,
  fetchReviewQueue,
  fetchGatewayProviderDispatch,
  acceptReviewQueueRow,
  architectTry,
  rejectReviewQueueRow,
  requestReview,
  ReviewActionApiError,
  setGatewayProviderDispatchDisabled,
  terminateTask,
} from './api.js';

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

// ────────────────────────────────────────────────────────────────────
// Phase 4 / REV-01 — review-queue API helpers
// ────────────────────────────────────────────────────────────────────

function makeReviewQueueRow(overrides: Partial<ReviewQueueRow> = {}): ReviewQueueRow {
  return {
    taskRef: { namespace: 'kagent-system', name: 'researcher-fail-01', uid: 'uid-001' },
    reason: 'verifier-failed',
    reasonDetail: 'verifier returned non-JSON',
    enqueuedAt: '2026-05-10T10:00:00.000Z',
    stalenessSeconds: 3600,
    phase: 'Failed',
    targetAgent: 'researcher-01',
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    ...overrides,
  };
}

function mockFetchWithStatus(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: status === 200 ? 'OK' : status === 422 ? 'Unprocessable Entity' : 'Error',
          json: () => Promise.resolve(body),
        }) as unknown as Promise<Response>,
    ),
  );
}

describe('fetchReviewQueue (REV-01)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Test RQ-1 — happy path: returns validated ReviewQueueRow items', async () => {
    const row = makeReviewQueueRow();
    mockFetchWithStatus(200, { items: [row] });

    const rows = await fetchReviewQueue();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskRef: { namespace: 'kagent-system', name: 'researcher-fail-01' },
      reason: 'verifier-failed',
    });
  });

  it('Test RQ-2 — non-2xx throws Error containing fetchReviewQueue and status code', async () => {
    mockFetchWithStatus(500, { message: 'internal error' });

    await expect(fetchReviewQueue()).rejects.toThrow(/fetchReviewQueue/);
    await expect(fetchReviewQueue()).rejects.toThrow(/500/);
  });

  it('Test RQ-3 — missing items field defaults to empty array', async () => {
    mockFetchWithStatus(200, {});

    const rows = await fetchReviewQueue();

    expect(rows).toEqual([]);
  });
});

describe('terminateTask', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('issues DELETE to the encoded task endpoint', async () => {
    mockFetchWithStatus(202, { deleted: true });

    await terminateTask('kagent-draft', 'draft/run 1');

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/kagent-draft/draft%2Frun%201', {
      method: 'DELETE',
    });
  });

  it('throws the API error body on non-2xx', async () => {
    mockFetchWithStatus(403, { error: 'RBAC denied' });

    await expect(terminateTask('kagent-draft', 'running')).rejects.toThrow(/RBAC denied/);
  });
});

describe('fetchSessionProfiles', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls /api/session-profiles and returns the items array', async () => {
    const profile = {
      id: 'agent:kagent-draft/profile-agentcore-research-agent',
      profileName: 'research-browser-code',
      source: 'Agent',
      targetAgent: 'profile-agentcore-research-agent',
      namespace: 'kagent-draft',
      modelClass: 'tool-caller-default',
      toolProfileRef: 'browser-code-researcher',
      tools: ['browser.goto'],
      capabilities: ['research'],
      defaults: { runConfig: { timeoutSeconds: 300, maxIterations: 8 } },
      launchability: { state: 'ready', reasons: [] },
    };
    mockFetchOk({ items: [profile] });

    const rows = await fetchSessionProfiles();

    expect(rows).toEqual([profile]);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith('/api/session-profiles', {});
  });

  it('returns an empty list on non-2xx so the composer can fall back', async () => {
    mockFetchNotOk(503, 'Service Unavailable');

    await expect(fetchSessionProfiles()).resolves.toEqual([]);
  });
});

describe('gateway provider dispatch controls', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchGatewayProviderDispatch calls the runtime kill-switch endpoint', async () => {
    mockFetchWithStatus(200, { providerDispatchDisabled: true });

    await expect(fetchGatewayProviderDispatch()).resolves.toEqual({
      providerDispatchDisabled: true,
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith('/api/gateway/provider-dispatch', {});
  });

  it('setGatewayProviderDispatchDisabled PATCHes the desired disabled state', async () => {
    mockFetchWithStatus(200, { providerDispatchDisabled: true });

    await expect(setGatewayProviderDispatchDisabled(true)).resolves.toEqual({
      providerDispatchDisabled: true,
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith('/api/gateway/provider-dispatch', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
  });

  it('setGatewayProviderDispatchDisabled throws GatewayApiError on non-2xx', async () => {
    mockFetchWithStatus(503, { message: 'write surface disabled' });

    await expect(setGatewayProviderDispatchDisabled(true)).rejects.toThrow(
      /write surface disabled/,
    );
  });
});

describe('acceptReviewQueueRow (REV-01)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Test ACC-1 — happy path: POST to correct URL + returns response body', async () => {
    const responseBody = {
      taskRef: { namespace: 'kagent-system', name: 'researcher-fail-01', uid: 'uid-001' },
      decision: 'accepted',
      auditedAt: '2026-05-10T11:00:00.000Z',
      agentTemplateRef: { namespace: 'kagent-system', name: 'new-template', uid: 'uid-tmpl' },
    };
    mockFetchWithStatus(200, responseBody);

    const result = await acceptReviewQueueRow('kagent-system', 'researcher-fail-01', {});

    expect(result).toMatchObject({ decision: 'accepted' });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/review-queue/kagent-system/researcher-fail-01/accept');
    expect(init.method).toBe('POST');
  });

  it('Test ACC-2 — 422 throws ReviewActionApiError with status 422, error message, and detail', async () => {
    mockFetchWithStatus(422, {
      error: 'candidate parse failed',
      detail: 'missing agentSpec.targetAgent',
    });

    await expect(acceptReviewQueueRow('kagent-system', 'researcher-fail-01', {})).rejects.toThrow(
      ReviewActionApiError,
    );

    let caught: ReviewActionApiError | null = null;
    try {
      await acceptReviewQueueRow('kagent-system', 'researcher-fail-01', {});
    } catch (e) {
      caught = e as ReviewActionApiError;
    }
    expect(caught).toBeInstanceOf(ReviewActionApiError);
    expect(caught?.status).toBe(422);
    expect(caught?.message).toContain('candidate parse failed');
    // WR-02 (Plan 04-06): detail is surfaced from the server's 422 body.
    expect(caught?.detail).toBe('missing agentSpec.targetAgent');
  });

  it('Test ACC-2b — 422 without detail field: ReviewActionApiError.detail is undefined', async () => {
    mockFetchWithStatus(422, { error: 'some other failure' });
    let caught: ReviewActionApiError | null = null;
    try {
      await acceptReviewQueueRow('kagent-system', 'researcher-fail-01', {});
    } catch (e) {
      caught = e as ReviewActionApiError;
    }
    expect(caught).toBeInstanceOf(ReviewActionApiError);
    expect(caught?.detail).toBeUndefined();
  });

  it('Test ACC-3 — 503 throws ReviewActionApiError with status 503', async () => {
    mockFetchWithStatus(503, { error: 'write surface disabled' });

    let caught: ReviewActionApiError | null = null;
    try {
      await acceptReviewQueueRow('kagent-system', 'researcher-fail-01', {});
    } catch (e) {
      caught = e as ReviewActionApiError;
    }
    expect(caught).toBeInstanceOf(ReviewActionApiError);
    expect(caught?.status).toBe(503);
  });
});

describe('rejectReviewQueueRow (REV-01)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Test REJ-1 — happy path: POST to reject URL + returns response body', async () => {
    const responseBody = {
      taskRef: { namespace: 'kagent-system', name: 'researcher-fail-01', uid: 'uid-001' },
      decision: 'rejected',
      auditedAt: '2026-05-10T11:00:00.000Z',
    };
    mockFetchWithStatus(200, responseBody);

    const result = await rejectReviewQueueRow('kagent-system', 'researcher-fail-01', {});

    expect(result).toMatchObject({ decision: 'rejected' });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/review-queue/kagent-system/researcher-fail-01/reject');
  });
});

describe('requestReview (REV-01)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Test REQ-1 — happy path: POST to request URL + returns response body', async () => {
    const responseBody = {
      taskRef: { namespace: 'kagent-system', name: 'researcher-ok-01', uid: 'uid-002' },
      requested: true,
      requestedAt: '2026-05-10T11:00:00.000Z',
    };
    mockFetchWithStatus(200, responseBody);

    const result = await requestReview('kagent-system', 'researcher-ok-01', {});

    expect(result).toMatchObject({ requested: true });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/review-queue/kagent-system/researcher-ok-01/request');
  });

  it('Test REQ-2 — POSTs body with reviewerId + reasonText (WR-06 server-contract alignment)', async () => {
    mockFetchWithStatus(200, {
      taskRef: { namespace: 'kagent-system', name: 'researcher-ok-01', uid: 'u' },
      requested: true,
      requestedAt: '2026-05-10T15:00:00.000Z',
    });
    await requestReview('kagent-system', 'researcher-ok-01', {
      reviewerId: 'operator@kagent',
      reasonText: 'spot audit',
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ reviewerId: 'operator@kagent', reasonText: 'spot audit' });
    expect(body['requestedBy']).toBeUndefined();
    expect(body['note']).toBeUndefined();
  });
});

describe('architectTry', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts candidate YAML plus goal and returns task-oriented links', async () => {
    mockFetchWithStatus(201, {
      namespace: 'kagent-draft',
      templateName: 'draft-abc123',
      agentName: 'draft-abc123-agent',
      taskName: 'draft-abc123-run',
      taskUid: 'task-u1',
      _links: {
        detail: '/api/tasks/kagent-draft/draft-abc123-run',
        ui: '/#/tasks/kagent-draft/draft-abc123-run',
        langfuse: 'https://langfuse.example/trace/abc123',
      },
    });

    const result = await architectTry('agentSpec:\n  model: m1\n', 'summarize this payload');

    expect(result.taskName).toBe('draft-abc123-run');
    expect(result._links?.ui).toBe('/#/tasks/kagent-draft/draft-abc123-run');
    expect(result._links?.langfuse).toBe('https://langfuse.example/trace/abc123');

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/architect/try');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      candidateYaml: 'agentSpec:\n  model: m1\n',
      goal: 'summarize this payload',
    });
  });
});
