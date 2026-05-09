/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-03 — /api/dispositions route tests.
 *
 * Covers:
 *   - DTO shape (assertIsDispositionOverlayRow on each item)
 *   - spentTokensToday sum logic via gateway-usage-rows.json fixture
 *   - postsToday=0 forward-compat
 *   - proposalsToday from operator-written annotation (same-day, day-mismatch reset, missing)
 *   - overBudget (tokens, proposals, both) + over_budget event emission
 *   - Exactly-once-per-(agentRef,reason)-per-day dedup
 *   - Re-emission after UTC midnight rollover
 *   - Empty list for no overlays / malformed overlays filtered
 *   - Daily boundary computation
 *   - gateway since/agentName filter
 *   - Orphan-overlay filter (Agent existence check)
 *   - overBudgetEventCountToday derived from dedup
 *   - UTC-midnight boundary boundary case (millisecond apart, different UTC days)
 */

import { Hono } from 'hono';
import type { V1ConfigMap } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertIsDispositionOverlayRow, type DispositionOverlayRow } from '@kagent/dto';
import type { AuditEvent } from '@kagent/audit-events';

import gatewayUsageRows from '../../../../tests/fixtures/disposition/gateway-usage-rows.json' with { type: 'json' };
import type { GatewayClient, GatewayUsageQuery, GatewayUsageRow } from '../gateway-client.js';

import {
  dispositionsRoute,
  readProposalsTodayAnnotation,
  type DispositionsCoreApi,
  type DispositionsCustomApi,
  type DispositionsRouteDeps,
} from './dispositions.js';

// ---------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------

interface OverlayCmOpts {
  readonly name?: string;
  readonly namespace?: string;
  readonly agentNamespace?: string;
  readonly agentName?: string;
  readonly tokensPerDay?: number;
  readonly maxProposalsPerDay?: number;
  readonly mayProposeAgainst?: readonly string[];
  readonly proposalsTodayAnnotation?: string;
  readonly proposalsTodayDayAnnotation?: string;
  /**
   * When true, return a malformed `disposition.yaml` (missing
   * `tokensPerDay`) so the parser rejects it. Used by Test 12.
   */
  readonly malformed?: boolean;
}

function makeOverlayCm(opts: OverlayCmOpts = {}): V1ConfigMap {
  const ns = opts.namespace ?? 'kagent-system';
  const aname = opts.agentName ?? 'researcher-01';
  const ans = opts.agentNamespace ?? ns;
  const annotations: Record<string, string> = {
    'kagent.knuteson.io/agent-ref': `${ans}/${aname}`,
  };
  if (opts.proposalsTodayAnnotation !== undefined) {
    annotations['kagent.knuteson.io/proposals-today'] = opts.proposalsTodayAnnotation;
  }
  if (opts.proposalsTodayDayAnnotation !== undefined) {
    annotations['kagent.knuteson.io/proposals-today-day'] = opts.proposalsTodayDayAnnotation;
  }
  const tokensPerDay = opts.tokensPerDay ?? 50000;
  const maxProposalsPerDay = opts.maxProposalsPerDay ?? 3;
  const mayProposeAgainst = opts.mayProposeAgainst ?? ['templates'];
  const yaml = opts.malformed
    ? `idleBehavior:\n  readChannels: []\n  attentionBudget: { pollIntervalSeconds: 300 }\n  proposalScope: { mayProposeAgainst: ['templates'], maxProposalsPerDay: 3 }\n`
    : `idleBehavior:\n  readChannels: []\n  attentionBudget: { tokensPerDay: ${tokensPerDay}, pollIntervalSeconds: 300 }\n  proposalScope: { mayProposeAgainst: [${mayProposeAgainst
        .map((k) => `'${k}'`)
        .join(',')}], maxProposalsPerDay: ${maxProposalsPerDay} }\n`;
  return {
    metadata: {
      name: opts.name ?? `${aname}-disposition`,
      namespace: ns,
      labels: { 'kagent.knuteson.io/agent-disposition': 'true' },
      annotations,
    },
    data: { 'disposition.yaml': yaml },
  };
}

function makeStubCoreApi(items: V1ConfigMap[]): DispositionsCoreApi & {
  readonly listConfigMapForAllNamespaces: ReturnType<typeof vi.fn>;
  readonly listNamespacedConfigMap: ReturnType<typeof vi.fn>;
} {
  const listAll = vi.fn().mockResolvedValue({ items });
  const listNs = vi.fn().mockResolvedValue({ items });
  return {
    listConfigMapForAllNamespaces: listAll,
    listNamespacedConfigMap: listNs,
  };
}

/**
 * Stub `getNamespacedCustomObject` that resolves for every Agent —
 * orphan filter is exercised by the dedicated orphan test.
 */
function makeStubCustomApi(): DispositionsCustomApi & {
  readonly getNamespacedCustomObject: ReturnType<typeof vi.fn>;
} {
  return {
    getNamespacedCustomObject: vi.fn().mockResolvedValue({
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'Agent',
      metadata: { name: 'researcher-01', namespace: 'kagent-system' },
    }),
  };
}

function makeStubGateway(rows: readonly GatewayUsageRow[] = []): GatewayClient & {
  readonly usage: ReturnType<typeof vi.fn>;
} {
  const usage = vi
    .fn<(query: GatewayUsageQuery) => Promise<readonly GatewayUsageRow[]>>()
    .mockImplementation((query: GatewayUsageQuery) =>
      Promise.resolve(rows.filter((r) => r.agentName === query.agentName)),
    );
  return {
    capacity: vi.fn().mockResolvedValue([]),
    usage,
  };
}

function makeStubAuditPublisher(): {
  readonly publish: ReturnType<typeof vi.fn>;
} {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

/** Mount the route on a Hono app and return a fetch helper. */
function mountAndFetch(deps: DispositionsRouteDeps): {
  readonly fetch: () => Promise<Response>;
} {
  const app = new Hono();
  app.route('/', dispositionsRoute(deps));
  return {
    fetch: () => app.request('/'),
  };
}

// Construct GatewayUsageRow[] from the fixture JSON (which is a
// minimal subset of the wire shape — fill in the required fields
// for typing).
const fixtureUsageRows: readonly GatewayUsageRow[] = (
  gatewayUsageRows as ReadonlyArray<{
    readonly agentName: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly occurredAt: string;
    readonly taskUid: string;
  }>
).map((r) => ({
  ...r,
  requestId: r.taskUid,
  backend: 'workers-ai',
  backendUrl: 'https://api.cloudflare.com/client/v4/ai/run',
  latencyMs: 100,
  statusCode: 200,
  streaming: false,
}));

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe('readProposalsTodayAnnotation', () => {
  it('returns 0 when annotations are absent', () => {
    const cm: V1ConfigMap = { metadata: { name: 'x', namespace: 'y' } };
    expect(readProposalsTodayAnnotation(cm, '2026-05-09')).toBe(0);
  });

  it('returns parsed value when day matches and value is a positive integer', () => {
    const cm = makeOverlayCm({
      proposalsTodayAnnotation: '5',
      proposalsTodayDayAnnotation: '2026-05-09',
    });
    expect(readProposalsTodayAnnotation(cm, '2026-05-09')).toBe(5);
  });

  it('returns 0 on day mismatch (rollover semantics)', () => {
    const cm = makeOverlayCm({
      proposalsTodayAnnotation: '5',
      proposalsTodayDayAnnotation: '2026-05-08',
    });
    expect(readProposalsTodayAnnotation(cm, '2026-05-09')).toBe(0);
  });

  it('Test 15 — sanitizes non-numeric / negative annotation values to 0', () => {
    const garbage = makeOverlayCm({
      proposalsTodayAnnotation: 'not-a-number',
      proposalsTodayDayAnnotation: '2026-05-09',
    });
    expect(readProposalsTodayAnnotation(garbage, '2026-05-09')).toBe(0);

    const negative = makeOverlayCm({
      proposalsTodayAnnotation: '-3',
      proposalsTodayDayAnnotation: '2026-05-09',
    });
    expect(readProposalsTodayAnnotation(negative, '2026-05-09')).toBe(0);
  });
});

describe('GET /api/dispositions', () => {
  const fixedNow = new Date('2026-05-09T12:00:00.000Z');
  const dailyBoundaryUtc = '2026-05-09T00:00:00.000Z';

  let coreApi: ReturnType<typeof makeStubCoreApi>;
  let readCustomApi: ReturnType<typeof makeStubCustomApi>;
  let gatewayClient: ReturnType<typeof makeStubGateway>;
  let auditPublisher: ReturnType<typeof makeStubAuditPublisher>;
  let dedup: Set<string>;

  beforeEach(() => {
    coreApi = makeStubCoreApi([]);
    readCustomApi = makeStubCustomApi();
    gatewayClient = makeStubGateway();
    auditPublisher = makeStubAuditPublisher();
    dedup = new Set<string>();
  });

  it('Test 1 — returns 200 with `{ items: DispositionOverlayRow[] }`; each item passes the runtime guard', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01', tokensPerDay: 50000 });
    coreApi = makeStubCoreApi([cm]);
    gatewayClient = makeStubGateway(fixtureUsageRows);

    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      gatewayClient,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const response = await fetch();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    for (const item of body.items) {
      expect(() => assertIsDispositionOverlayRow(item)).not.toThrow();
    }
  });

  it('Test 2 — sums spentTokensToday from the gateway-usage-rows fixture (researcher-01 → 45000)', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01', tokensPerDay: 50000 });
    coreApi = makeStubCoreApi([cm]);
    gatewayClient = makeStubGateway(fixtureUsageRows);

    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      gatewayClient,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items[0]?.spentTokensToday).toBe(45000);
  });

  it('Test 3 — every row carries postsToday === 0', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01' });
    coreApi = makeStubCoreApi([cm]);
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items[0]?.postsToday).toBe(0);
  });

  it('Test 4 — proposalsToday read from annotation when day matches', async () => {
    const cm = makeOverlayCm({
      agentName: 'researcher-01',
      proposalsTodayAnnotation: '5',
      proposalsTodayDayAnnotation: '2026-05-09',
      maxProposalsPerDay: 10, // not over budget
    });
    coreApi = makeStubCoreApi([cm]);
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items[0]?.proposalsToday).toBe(5);
  });

  it('Test 5a — proposalsToday defaults to 0 when annotation is absent', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01' });
    coreApi = makeStubCoreApi([cm]);
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items[0]?.proposalsToday).toBe(0);
  });

  it('Test 5b — proposalsToday resets to 0 on day-window mismatch', async () => {
    const cm = makeOverlayCm({
      agentName: 'researcher-01',
      proposalsTodayAnnotation: '5',
      proposalsTodayDayAnnotation: '2026-05-08', // yesterday relative to fixedNow
    });
    coreApi = makeStubCoreApi([cm]);
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items[0]?.proposalsToday).toBe(0);
  });

  it('Test 6 — overBudget tokens emits one publish call with reason=tokens_exceeded', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01', tokensPerDay: 40000 });
    coreApi = makeStubCoreApi([cm]);
    gatewayClient = makeStubGateway(fixtureUsageRows); // researcher-01 sums to 45000 > 40000

    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      gatewayClient,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items[0]?.overBudget).toBe(true);
    expect(body.items[0]?.overBudgetReason).toBe('tokens_exceeded');
    expect(auditPublisher.publish).toHaveBeenCalledTimes(1);
    const event = auditPublisher.publish.mock.calls[0]?.[0] as AuditEvent;
    expect(event.type).toBe('disposition.over_budget');
    expect(event.data).toMatchObject({
      reason: 'tokens_exceeded',
      observed: 45000,
      budget: 40000,
      agentRef: 'kagent-system/researcher-01',
      dailyBoundaryUtc,
    });
  });

  it('Test 7 — overBudget proposals emits one publish call with reason=proposals_exceeded', async () => {
    const cm = makeOverlayCm({
      agentName: 'researcher-01',
      tokensPerDay: 50000,
      maxProposalsPerDay: 3,
      proposalsTodayAnnotation: '5',
      proposalsTodayDayAnnotation: '2026-05-09',
    });
    coreApi = makeStubCoreApi([cm]);
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items[0]?.overBudget).toBe(true);
    expect(body.items[0]?.overBudgetReason).toBe('proposals_exceeded');
    expect(auditPublisher.publish).toHaveBeenCalledTimes(1);
    const event = auditPublisher.publish.mock.calls[0]?.[0] as AuditEvent;
    expect(event.data).toMatchObject({ reason: 'proposals_exceeded', observed: 5, budget: 3 });
  });

  it('Test 8 — overBudget both: emits TWO events (one per reason)', async () => {
    const cm = makeOverlayCm({
      agentName: 'researcher-01',
      tokensPerDay: 40000,
      maxProposalsPerDay: 3,
      proposalsTodayAnnotation: '5',
      proposalsTodayDayAnnotation: '2026-05-09',
    });
    coreApi = makeStubCoreApi([cm]);
    gatewayClient = makeStubGateway(fixtureUsageRows);

    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      gatewayClient,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items[0]?.overBudgetReason).toBe('both');
    expect(auditPublisher.publish).toHaveBeenCalledTimes(2);
    const reasons = auditPublisher.publish.mock.calls.map(
      (call: unknown[]) => (call[0] as AuditEvent & { data: { reason: string } }).data.reason,
    );
    expect(new Set(reasons)).toEqual(new Set(['tokens_exceeded', 'proposals_exceeded']));
  });

  it('Test 9 — exactly once per (agentRef, reason) per day: TWO consecutive GETs do NOT double-publish', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01', tokensPerDay: 40000 });
    coreApi = makeStubCoreApi([cm]);
    gatewayClient = makeStubGateway(fixtureUsageRows);

    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      gatewayClient,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    await fetch();
    await fetch();
    expect(auditPublisher.publish).toHaveBeenCalledTimes(1);
  });

  it('Test 10 — re-emits after UTC midnight rollover', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01', tokensPerDay: 40000 });
    coreApi = makeStubCoreApi([cm]);
    gatewayClient = makeStubGateway(fixtureUsageRows);

    const day1 = new Date('2026-05-09T12:00:00.000Z');
    const day2 = new Date('2026-05-10T12:00:00.000Z');
    let nowVal = day1;
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      gatewayClient,
      auditPublisher,
      now: () => nowVal,
      overBudgetDedup: dedup,
    });
    await fetch();
    nowVal = day2;
    await fetch();
    expect(auditPublisher.publish).toHaveBeenCalledTimes(2);
  });

  it('Test 11 — empty items when no overlay ConfigMaps match', async () => {
    coreApi = makeStubCoreApi([]);
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items).toEqual([]);
  });

  it('Test 12 — malformed disposition.yaml is filtered out and warned', async () => {
    const goodCm = makeOverlayCm({ agentName: 'researcher-01' });
    const badCm = makeOverlayCm({ agentName: 'broken-agent', malformed: true });
    coreApi = makeStubCoreApi([goodCm, badCm]);
    const warnSpy = vi.fn();
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      now: () => fixedNow,
      overBudgetDedup: dedup,
      logger: { warn: warnSpy },
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.agentName).toBe('researcher-01');
    expect(warnSpy).toHaveBeenCalled();
    const warnings = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnings.some((m) => m.includes('skipping malformed ConfigMap'))).toBe(true);
  });

  it('Test 13 — dailyBoundaryUtc is the ISO 8601 of UTC midnight relative to now', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01' });
    coreApi = makeStubCoreApi([cm]);
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items[0]?.dailyBoundaryUtc).toBe('2026-05-09T00:00:00.000Z');
  });

  it('Test 14 — gatewayClient.usage is called with the correct since (UTC midnight) and agentName', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01' });
    coreApi = makeStubCoreApi([cm]);
    gatewayClient = makeStubGateway(fixtureUsageRows);
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      gatewayClient,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    await fetch();
    expect(gatewayClient.usage).toHaveBeenCalledTimes(1);
    const callArg = gatewayClient.usage.mock.calls[0]?.[0] as GatewayUsageQuery;
    expect(callArg.agentName).toBe('researcher-01');
    expect(callArg.since).toBe('2026-05-09T00:00:00.000Z');
  });

  it('Test 16 — orphan overlay (Agent missing) is filtered out', async () => {
    const cm = makeOverlayCm({ agentName: 'ghost-agent' });
    coreApi = makeStubCoreApi([cm]);
    const orphanCustom: DispositionsCustomApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
    };
    const warnSpy = vi.fn();
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi: orphanCustom,
      now: () => fixedNow,
      overBudgetDedup: dedup,
      logger: { warn: warnSpy },
    });
    const body = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body.items).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    const warnings = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnings.some((m) => m.includes('orphan overlay'))).toBe(true);
  });

  it('Test 17 — overBudgetEventCountToday = 1 with single-reason; same-day re-fetch keeps it 1; both reasons → 2', async () => {
    // First arrange: only tokens exceeded
    const cmTokens = makeOverlayCm({ agentName: 'researcher-01', tokensPerDay: 40000 });
    coreApi = makeStubCoreApi([cmTokens]);
    gatewayClient = makeStubGateway(fixtureUsageRows);
    const { fetch: fetch1 } = mountAndFetch({
      coreApi,
      readCustomApi,
      gatewayClient,
      auditPublisher,
      now: () => fixedNow,
      overBudgetDedup: dedup,
    });
    const body1 = (await (await fetch1()).json()) as { items: DispositionOverlayRow[] };
    expect(body1.items[0]?.overBudgetEventCountToday).toBe(1);

    // Second call: dedup is the same Set, so count stays 1.
    const body1b = (await (await fetch1()).json()) as { items: DispositionOverlayRow[] };
    expect(body1b.items[0]?.overBudgetEventCountToday).toBe(1);

    // Now flip to 'both' — proposals annotation pushes proposalsToday=5>3.
    const dedupBoth = new Set<string>();
    const cmBoth = makeOverlayCm({
      agentName: 'researcher-01',
      tokensPerDay: 40000,
      maxProposalsPerDay: 3,
      proposalsTodayAnnotation: '5',
      proposalsTodayDayAnnotation: '2026-05-09',
    });
    const coreApi2 = makeStubCoreApi([cmBoth]);
    const { fetch: fetch2 } = mountAndFetch({
      coreApi: coreApi2,
      readCustomApi,
      gatewayClient,
      auditPublisher: makeStubAuditPublisher(),
      now: () => fixedNow,
      overBudgetDedup: dedupBoth,
    });
    const body2 = (await (await fetch2()).json()) as { items: DispositionOverlayRow[] };
    expect(body2.items[0]?.overBudgetEventCountToday).toBe(2);
  });

  it('Test 18 — UTC-midnight boundary millisecond rollover: dedup key differs, fresh event fires', async () => {
    const cm = makeOverlayCm({ agentName: 'researcher-01', tokensPerDay: 40000 });
    coreApi = makeStubCoreApi([cm]);
    gatewayClient = makeStubGateway(fixtureUsageRows);

    const justBeforeMidnight = new Date('2026-05-09T23:59:59.999Z');
    const justAfterMidnight = new Date('2026-05-10T00:00:00.000Z');
    let t = justBeforeMidnight;
    const { fetch } = mountAndFetch({
      coreApi,
      readCustomApi,
      gatewayClient,
      auditPublisher,
      now: () => t,
      overBudgetDedup: dedup,
    });
    const body1 = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body1.items[0]?.dailyBoundaryUtc).toBe('2026-05-09T00:00:00.000Z');
    expect(body1.items[0]?.overBudgetEventCountToday).toBe(1);
    expect(auditPublisher.publish).toHaveBeenCalledTimes(1);

    t = justAfterMidnight;
    const body2 = (await (await fetch()).json()) as { items: DispositionOverlayRow[] };
    expect(body2.items[0]?.dailyBoundaryUtc).toBe('2026-05-10T00:00:00.000Z');
    // Today's count = 1 (yesterday's dedup entry filtered out by suffix)
    expect(body2.items[0]?.overBudgetEventCountToday).toBe(1);
    // Two publishes total — one per UTC day window.
    expect(auditPublisher.publish).toHaveBeenCalledTimes(2);
  });
});
