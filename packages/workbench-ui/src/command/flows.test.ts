/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 3 / FLOW-01 — flow computation tests.
 *
 * 8 pairs (16 tests total) + 1 FLOW-01 fixture-assertion test = 17 tests min.
 * Each flow kind has a "fires" test and a complementary "does NOT fire" test.
 * Each test builds the minimal snapshot satisfying or violating the trigger.
 * None of the 8 flows reads Date.now() so no fake-timers setup is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FLOW_TYPES } from './flows.js';
import type { FlowGauge } from './flows.js';
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

function computeAll(snapshot: CommandSnapshot): readonly FlowGauge[] {
  return FLOW_TYPES.flatMap((ft) => ft.compute(snapshot));
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

function makeAgent(overrides: Partial<AgentSummaryRow> = {}): AgentSummaryRow {
  return {
    name: 'researcher-01',
    namespace: 'kagent-system',
    capabilities: ['research'],
    ...overrides,
  };
}

describe('flows (FLOW-01 — computation)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // ───────────────────────────── FLOW-01 fixture-assertion ─────────────────────────────

  it('FLOW-01 — every flow has a non-null source field reference', () => {
    for (const ft of FLOW_TYPES) {
      expect(ft.sourceField ?? ft.sourceFields).toBeDefined();
    }
  });

  // ───────────────────────────── modelPower ─────────────────────────────

  it('modelPower — fires with one gauge per gateway endpoint', () => {
    const snap = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'm',
          endpoint: 'e',
          backendKind: 'cf',
          inFlight: 5,
          currentCap: 10,
          seed: 0,
          max: 10,
          minSafe: 0,
          recentP50Ms: null,
        },
      ],
    });
    const gauges = computeAll(snap).filter((g) => g.kind === 'modelPower');
    expect(gauges.length).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.sourceFields).toEqual(['inFlight', 'currentCap']);
    expect(gauges[0]?.value).toBe(5);
    expect(gauges[0]?.capacity).toBe(10);
    expect(gauges[0]?.unit).toBe('in flight');
    expect(gauges[0]?.detailLink).toBe('#/gateway');
    expect(gauges[0]?.affectedKey).toBe('e');
  });

  it('modelPower — returns empty array when gatewayCapacity is empty', () => {
    const snap = makeSnapshot({ gatewayCapacity: [] });
    const gauges = computeAll(snap).filter((g) => g.kind === 'modelPower');
    expect(gauges.length).toBe(0);
  });

  // ───────────────────────────── tokenFlow ─────────────────────────────

  it('tokenFlow — fires when there are Dispatched tasks with a model field', () => {
    const t = makeTask({
      name: 't1',
      phase: 'Dispatched',
      model: 'workers-ai/@cf/meta/llama-4-scout',
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const gauges = computeAll(snap).filter((g) => g.kind === 'tokenFlow');
    expect(gauges.length).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.value).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.capacity).toBeUndefined();
    expect(gauges[0]?.unit).toBe('tasks');
    expect(gauges[0]?.label).toMatch(/tasks dispatched per model/);
    expect(gauges[0]?.detailLink).toBe('#/gateway');
    expect(gauges[0]?.sourceFields).toBeDefined();
  });

  it('tokenFlow — returns empty array when no Dispatched tasks with model', () => {
    const snap = makeSnapshot({ tasks: new Map<string, TaskSummary>() });
    const gauges = computeAll(snap).filter((g) => g.kind === 'tokenFlow');
    expect(gauges.length).toBe(0);
  });

  // ───────────────────────────── buildPower ─────────────────────────────

  it('buildPower — fires for each agent with Dispatched tasks', () => {
    const agent = makeAgent({ name: 'executor-01', namespace: 'ns' });
    const t = makeTask({
      name: 'tsk',
      namespace: 'ns',
      phase: 'Dispatched',
      targetAgent: 'executor-01',
    });
    const snap = makeSnapshot({
      agents: new Map<string, AgentSummaryRow>([['ns/executor-01', agent]]),
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const gauges = computeAll(snap).filter((g) => g.kind === 'buildPower');
    expect(gauges.length).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.value).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.capacity).toBeUndefined();
    expect(gauges[0]?.affectedKey).toBe('ns/executor-01');
    expect(gauges[0]?.sourceFields).toEqual(['targetAgent', 'phase']);
  });

  it('buildPower — returns empty array when no Dispatched tasks targeting any agent', () => {
    const agent = makeAgent({ name: 'executor-01', namespace: 'ns' });
    const snap = makeSnapshot({
      agents: new Map<string, AgentSummaryRow>([['ns/executor-01', agent]]),
      tasks: new Map<string, TaskSummary>(),
    });
    const gauges = computeAll(snap).filter((g) => g.kind === 'buildPower');
    expect(gauges.length).toBe(0);
  });

  // ───────────────────────────── podCapacity ─────────────────────────────

  it('podCapacity — fires with substrate-wide active pod count', () => {
    const t = makeTask({ name: 'tp', namespace: 'ns', phase: 'Dispatched', podName: 'p1' });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const gauges = computeAll(snap).filter((g) => g.kind === 'podCapacity');
    expect(gauges.length).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.value).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.capacity).toBeUndefined();
    expect(gauges[0]?.unit).toBe('pods');
    expect(gauges[0]?.detailLink).toBe('#/cluster');
    expect(gauges[0]?.sourceFields).toEqual(['podName', 'phase']);
  });

  it('podCapacity — returns empty array when no active pods', () => {
    const snap = makeSnapshot({ tasks: new Map<string, TaskSummary>() });
    const gauges = computeAll(snap).filter((g) => g.kind === 'podCapacity');
    expect(gauges.length).toBe(0);
  });

  // ───────────────────────────── artifactBandwidth ─────────────────────────────

  it('artifactBandwidth — fires with total artifact count from Completed tasks', () => {
    const t = makeTask({ name: 'ta', namespace: 'ns', phase: 'Completed', artifactCount: 3 });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const gauges = computeAll(snap).filter((g) => g.kind === 'artifactBandwidth');
    expect(gauges.length).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.value).toBe(3);
    expect(gauges[0]?.capacity).toBeUndefined();
    expect(gauges[0]?.unit).toBe('artifacts');
    expect(gauges[0]?.detailLink).toBe('#/cluster');
    expect(gauges[0]?.sourceFields).toEqual(['artifactCount', 'phase']);
  });

  it('artifactBandwidth — returns empty array when no Completed tasks with artifacts', () => {
    const snap = makeSnapshot({ tasks: new Map<string, TaskSummary>() });
    const gauges = computeAll(snap).filter((g) => g.kind === 'artifactBandwidth');
    expect(gauges.length).toBe(0);
  });

  // ───────────────────────────── authority ─────────────────────────────

  it('authority — fires when a Failed task error contains "policy"', () => {
    const t = makeTask({
      name: 'tp2',
      namespace: 'ns',
      phase: 'Failed',
      error: 'policy denied: scope mismatch',
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const gauges = computeAll(snap).filter((g) => g.kind === 'authority');
    expect(gauges.length).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.value).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.capacity).toBeUndefined();
    expect(gauges[0]?.unit).toBe('denials');
    expect(gauges[0]?.detailLink).toBe('#/tasks');
    expect(gauges[0]?.sourceFields).toEqual(['error', 'phase']);
  });

  it('authority — returns empty array when no Failed tasks with policy error', () => {
    const snap = makeSnapshot({ tasks: new Map<string, TaskSummary>() });
    const gauges = computeAll(snap).filter((g) => g.kind === 'authority');
    expect(gauges.length).toBe(0);
  });

  // ───────────────────────────── trust ─────────────────────────────

  it('trust — fires when a task has non-empty suspicious array', () => {
    const t = makeTask({
      name: 'ts',
      namespace: 'ns',
      phase: 'Dispatched',
      suspicious: ['high-fanout'],
    });
    const snap = makeSnapshot({
      tasks: new Map<string, TaskSummary>([[`${t.namespace}/${t.name}`, t]]),
    });
    const gauges = computeAll(snap).filter((g) => g.kind === 'trust');
    expect(gauges.length).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.value).toBeGreaterThanOrEqual(1);
    expect(gauges[0]?.capacity).toBeUndefined();
    expect(gauges[0]?.unit).toBe('events');
    expect(gauges[0]?.detailLink).toBe('#/tasks');
    expect(gauges[0]?.sourceFields).toEqual(['suspicious', 'error', 'phase']);
  });

  it('trust — returns empty array when no suspicious or verifier-error tasks', () => {
    const snap = makeSnapshot({ tasks: new Map<string, TaskSummary>() });
    const gauges = computeAll(snap).filter((g) => g.kind === 'trust');
    expect(gauges.length).toBe(0);
  });

  // ───────────────────────────── attention ─────────────────────────────

  it('attention — fires when reviewQueueRowCount >= 1', () => {
    const snap = makeSnapshot({ reviewQueueRowCount: 3 });
    const gauges = computeAll(snap).filter((g) => g.kind === 'attention');
    expect(gauges.length).toBe(1);
    expect(gauges[0]?.kind).toBe('attention');
    expect(gauges[0]?.value).toBe(3);
    expect(gauges[0]?.unit).toBe('items');
    expect(gauges[0]?.label).toBe('review queue');
    expect(gauges[0]?.detailLink).toBe('#/review');
    expect(gauges[0]?.sourceFields).toEqual(['reviewQueueRowCount']);
    expect(gauges[0]?.capacity).toBeUndefined();
  });

  it('attention — returns empty array when reviewQueueRowCount is 0 or undefined', () => {
    const snap0 = makeSnapshot({ reviewQueueRowCount: 0 });
    expect(computeAll(snap0).filter((g) => g.kind === 'attention').length).toBe(0);

    const snapUndef = makeSnapshot({});
    expect(computeAll(snapUndef).filter((g) => g.kind === 'attention').length).toBe(0);
  });

  it('attention — sourceFields shape is ["reviewQueueRowCount"] (single source, post-Phase-4 flip)', () => {
    const attentionEntry = FLOW_TYPES.find((ft) => ft.kind === 'attention');
    expect(attentionEntry).toBeDefined();
    expect(attentionEntry?.sourceFields).toEqual(['reviewQueueRowCount']);
  });
});
