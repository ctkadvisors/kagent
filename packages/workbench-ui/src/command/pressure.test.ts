/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 2 / CC-04 — pressure classification tests.
 *
 * 9 pairs (18 tests total): each pressure kind has a "fires" test
 * and a complementary "does NOT fire" test, replacing the 18 it.todo
 * placeholders from Wave 0. Each test builds the minimal snapshot
 * satisfying or violating the trigger and asserts the marker count
 * for the relevant kind. Telemetry uses vi.useFakeTimers() so
 * Date.now() is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRESSURE_TYPES } from './pressure.js';
import type { CommandSnapshot } from './state.js';
import type {
  AgentSummaryRow,
  GatewayCapacityRow,
  GatewayUsageRow,
  TaskSummary,
} from '../types.js';
import type { DispositionOverlayRow } from '@kagent/dto/disposition';

function makeSnapshot(overrides: Partial<CommandSnapshot> = {}): CommandSnapshot {
  return {
    agents: new Map<string, AgentSummaryRow>(),
    tasks: new Map<string, TaskSummary>(),
    gatewayCapacity: [] as readonly GatewayCapacityRow[],
    gatewayUsage: [] as readonly GatewayUsageRow[],
    dispositions: new Map<string, DispositionOverlayRow>(),
    events: [],
    lastEventAt: Date.now(),
    error: null,
    ...overrides,
  };
}

function classifyAll(snapshot: CommandSnapshot): {
  readonly kind: string;
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly affectedKey?: string;
  readonly detailLink: string;
  readonly label: string;
}[] {
  return PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot));
}

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    name: 't',
    namespace: 'kagent-system',
    uid: 'u',
    targetAgent: 'researcher-01',
    ...overrides,
  };
}

describe('pressure (CC-04 — classification)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // ───────────────────────────── gateway saturation ─────────────────────────────

  it('gateway saturation — fires when inFlight/currentCap >= 0.8', () => {
    const snap = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'm',
          endpoint: 'e',
          backendKind: 'cf',
          inFlight: 8,
          currentCap: 10,
          seed: 0,
          max: 10,
          minSafe: 0,
          recentP50Ms: null,
        },
      ],
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'gateway');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0]?.sourceFields).toEqual(['inFlight', 'currentCap']);
    expect(markers[0]?.detailLink).toBe('#/gateway');
  });

  it('gateway saturation — does NOT fire when inFlight/currentCap < 0.8', () => {
    const snap = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'm',
          endpoint: 'e',
          backendKind: 'cf',
          inFlight: 1,
          currentCap: 10,
          seed: 0,
          max: 10,
          minSafe: 0,
          recentP50Ms: null,
        },
      ],
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'gateway');
    expect(markers.length).toBe(0);
  });

  // ───────────────────────────── artifact debt ─────────────────────────────

  it('artifact debt — fires when phase=Completed and artifactCount=0', () => {
    const t = makeTask({
      name: 'x',
      phase: 'Completed',
      artifactCount: 0,
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'artifact');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0]?.sourceFields).toEqual(['artifactCount', 'phase']);
    expect(markers[0]?.detailLink).toBe('#/tasks/kagent-system/x');
  });

  it('artifact debt — does NOT fire when phase=Completed and artifactCount>0', () => {
    const t = makeTask({
      name: 'x',
      phase: 'Completed',
      artifactCount: 3,
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'artifact');
    expect(markers.length).toBe(0);
  });

  // ───────────────────────────── pod failure ─────────────────────────────

  it('pod failure — fires when phase=Failed and podName is defined', () => {
    const t = makeTask({
      name: 'y',
      phase: 'Failed',
      podName: 'p',
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'pod');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0]?.sourceFields).toEqual(['phase', 'podName']);
    expect(markers[0]?.detailLink).toBe('#/tasks/kagent-system/y');
  });

  it('pod failure — does NOT fire when phase is not Failed', () => {
    const t = makeTask({
      name: 'y',
      phase: 'Completed',
      podName: 'p',
      artifactCount: 1, // suppress artifact-debt marker
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'pod');
    expect(markers.length).toBe(0);
  });

  // ───────────────────────────── quota wall ─────────────────────────────

  it('quota wall — fires when a disposition row has overBudget=true', () => {
    const row: DispositionOverlayRow = {
      agentRef: 'kagent-system/researcher-01',
      namespace: 'kagent-system',
      agentName: 'researcher-01',
      configMapName: 'researcher-01-disposition',
      idleBehavior: {
        readChannels: [],
        attentionBudget: { tokensPerDay: 50_000, pollIntervalSeconds: 300 },
        proposalScope: { mayProposeAgainst: ['templates'], maxProposalsPerDay: 3 },
      },
      spentTokensToday: 60_000,
      postsToday: 0,
      proposalsToday: 0,
      overBudget: true,
      overBudgetReason: 'tokens_exceeded',
      overBudgetEventCountToday: 1,
      dailyBoundaryUtc: '2026-05-10T00:00:00.000Z',
    };
    const snap = makeSnapshot({
      dispositions: new Map<string, DispositionOverlayRow>([[row.agentRef, row]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'quota');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0]?.sourceField).toBe('overBudget');
    expect(markers[0]?.affectedKey).toBe('kagent-system/researcher-01');
  });

  it('quota wall — does NOT fire when no disposition row has overBudget=true', () => {
    const row: DispositionOverlayRow = {
      agentRef: 'kagent-system/researcher-01',
      namespace: 'kagent-system',
      agentName: 'researcher-01',
      configMapName: 'researcher-01-disposition',
      idleBehavior: {
        readChannels: [],
        attentionBudget: { tokensPerDay: 50_000, pollIntervalSeconds: 300 },
        proposalScope: { mayProposeAgainst: ['templates'], maxProposalsPerDay: 3 },
      },
      spentTokensToday: 100,
      postsToday: 0,
      proposalsToday: 0,
      overBudget: false,
      overBudgetEventCountToday: 0,
      dailyBoundaryUtc: '2026-05-10T00:00:00.000Z',
    };
    const snap = makeSnapshot({
      dispositions: new Map<string, DispositionOverlayRow>([[row.agentRef, row]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'quota');
    expect(markers.length).toBe(0);
  });

  // ───────────────────────────── stale telemetry ─────────────────────────────

  it('stale telemetry — fires when now − lastEventAt > 30s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
    const snap = makeSnapshot({ lastEventAt: Date.now() - 60_000 });
    const markers = classifyAll(snap).filter((m) => m.kind === 'telemetry');
    expect(markers.length).toBe(1);
    expect(markers[0]?.sourceField).toBe('lastEventAt');
    expect(markers[0]?.detailLink).toBe('#/cluster');
  });

  it('stale telemetry — does NOT fire when now − lastEventAt <= 30s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
    const snap = makeSnapshot({ lastEventAt: Date.now() - 1_000 });
    const markers = classifyAll(snap).filter((m) => m.kind === 'telemetry');
    expect(markers.length).toBe(0);
  });

  // ───────────────────────────── context pressure ─────────────────────────────

  it('context pressure — fires (TaskSummary heuristic) when childCount>=2 and phase=Dispatched', () => {
    const t = makeTask({
      name: 'z',
      phase: 'Dispatched',
      childCount: 3,
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'context');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0]?.sourceFields).toEqual(['childCount', 'phase']);
  });

  it('context pressure — does NOT fire when childCount<2 or phase!=Dispatched', () => {
    const t = makeTask({
      name: 'z',
      phase: 'Dispatched',
      childCount: 0,
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'context');
    expect(markers.length).toBe(0);
  });

  // ───────────────────────────── verifier failure ─────────────────────────────

  it('verifier failure — fires when phase=Failed and error contains "verifier"', () => {
    const t = makeTask({
      name: 'v',
      phase: 'Failed',
      error: 'verifier check failed: mismatch',
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'verifier');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0]?.sourceFields).toEqual(['phase', 'error']);
  });

  it('verifier failure — does NOT fire when error does not contain "verifier"', () => {
    const t = makeTask({
      name: 'v',
      phase: 'Failed',
      error: 'network timeout',
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'verifier');
    expect(markers.length).toBe(0);
  });

  // ───────────────────────────── trace gap ─────────────────────────────

  it('trace gap — fires when phase is terminal (Completed)', () => {
    const t = makeTask({
      name: 'tt',
      phase: 'Completed',
      artifactCount: 1, // suppress artifact-debt marker
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'trace');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0]?.sourceField).toBe('phase');
  });

  it('trace gap — does NOT fire when phase is non-terminal', () => {
    const t = makeTask({
      name: 'tt',
      phase: 'Pending',
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'trace');
    expect(markers.length).toBe(0);
  });

  // ───────────────────────────── policy denial ─────────────────────────────

  it('policy denial — fires when phase=Failed and error contains "policy"', () => {
    const t = makeTask({
      name: 'p',
      phase: 'Failed',
      error: 'policy denial: capability not allowed',
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'policy');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0]?.sourceFields).toEqual(['phase', 'error']);
  });

  it('policy denial — does NOT fire when error does not contain "policy"', () => {
    const t = makeTask({
      name: 'p',
      phase: 'Failed',
      error: 'verifier check failed',
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const markers = classifyAll(snap).filter((m) => m.kind === 'policy');
    expect(markers.length).toBe(0);
  });
});
