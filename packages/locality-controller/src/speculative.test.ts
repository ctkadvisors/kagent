/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  buildTwinManifest,
  evaluateSpeculative,
  LatencyHistogram,
  LatencyHistogramRegistry,
  SPECULATIVE_PRIMARY_UID_LABEL,
  SPECULATIVE_TWIN_LABEL,
} from './speculative.js';
import type { AffinityTask } from './types.js';

function makeTask(
  opts: {
    uid?: string;
    name?: string;
    namespace?: string;
    idempotencyKey?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    extraSpec?: Record<string, unknown>;
  } = {},
): AffinityTask {
  const spec: Record<string, unknown> = { ...(opts.extraSpec ?? {}) };
  if (opts.idempotencyKey !== undefined) {
    spec.idempotencyKey = opts.idempotencyKey;
  }
  return {
    metadata: {
      name: opts.name ?? 'task-1',
      namespace: opts.namespace ?? 'default',
      uid: opts.uid ?? 'uid-task-1-aaaaaaaaaaaaaaaaaaaaaaaaa',
      ...(opts.labels !== undefined && { labels: opts.labels }),
      ...(opts.annotations !== undefined && { annotations: opts.annotations }),
    },
    spec,
  };
}

describe('LatencyHistogram', () => {
  it('rejects non-positive capacity', () => {
    expect(() => new LatencyHistogram(0)).toThrow();
    expect(() => new LatencyHistogram(-1)).toThrow();
    expect(() => new LatencyHistogram(1.5)).toThrow();
  });

  it('reports 0 median when empty', () => {
    const h = new LatencyHistogram(10);
    expect(h.median()).toBe(0);
    expect(h.count()).toBe(0);
  });

  it('records samples and computes median for odd count', () => {
    const h = new LatencyHistogram(10);
    h.record(100);
    h.record(50);
    h.record(200);
    expect(h.count()).toBe(3);
    expect(h.median()).toBe(100);
  });

  it('computes mean of two middle values for even count', () => {
    const h = new LatencyHistogram(10);
    h.record(10);
    h.record(20);
    h.record(30);
    h.record(40);
    expect(h.median()).toBe(25);
  });

  it('overwrites oldest sample when full (ring semantics)', () => {
    const h = new LatencyHistogram(3);
    h.record(1);
    h.record(2);
    h.record(3);
    h.record(4); // overwrites the 1
    h.record(5); // overwrites the 2
    expect(h.count()).toBe(3);
    expect([...h.samples()].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(h.median()).toBe(4);
  });

  it('rejects NaN, Infinity, and negative samples silently', () => {
    const h = new LatencyHistogram(10);
    h.record(Number.NaN);
    h.record(Number.POSITIVE_INFINITY);
    h.record(-5);
    expect(h.count()).toBe(0);
  });
});

describe('LatencyHistogramRegistry', () => {
  it('returns null median until minSamples reached', () => {
    const reg = new LatencyHistogramRegistry(100, 5);
    reg.record('agent-a', 100);
    reg.record('agent-a', 200);
    reg.record('agent-a', 150);
    expect(reg.median('agent-a')).toBeNull();
    reg.record('agent-a', 175);
    reg.record('agent-a', 125);
    expect(reg.median('agent-a')).not.toBeNull();
    expect(reg.count('agent-a')).toBe(5);
  });

  it('isolates per-Agent samples', () => {
    const reg = new LatencyHistogramRegistry(100, 1);
    reg.record('agent-a', 1000);
    reg.record('agent-b', 10);
    expect(reg.median('agent-a')).toBe(1000);
    expect(reg.median('agent-b')).toBe(10);
  });

  it('returns null median for unknown agent', () => {
    const reg = new LatencyHistogramRegistry();
    expect(reg.median('never-seen')).toBeNull();
  });

  it('ignores empty agent name', () => {
    const reg = new LatencyHistogramRegistry();
    reg.record('', 100);
    expect(reg.count('')).toBe(0);
  });
});

describe('evaluateSpeculative', () => {
  function regWithMedian(agent: string, median: number, samples = 10): LatencyHistogramRegistry {
    const reg = new LatencyHistogramRegistry(100, 5);
    for (let i = 0; i < samples; i++) {
      reg.record(agent, median);
    }
    return reg;
  }

  it('skips when disabled (default)', () => {
    const reg = regWithMedian('a', 100);
    const decision = evaluateSpeculative(
      {
        task: makeTask({ idempotencyKey: 'k1' }),
        elapsedMs: 5000,
        agentName: 'a',
        isTerminal: false,
      },
      reg,
    );
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('disabled');
  });

  it('skips terminal tasks', () => {
    const reg = regWithMedian('a', 100);
    const decision = evaluateSpeculative(
      {
        task: makeTask({ idempotencyKey: 'k1' }),
        elapsedMs: 1000,
        agentName: 'a',
        isTerminal: true,
      },
      reg,
      { enabled: true },
    );
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('terminal');
  });

  it('skips when no idempotency key set (fail-closed against double-effect)', () => {
    const reg = regWithMedian('a', 100);
    const decision = evaluateSpeculative(
      {
        task: makeTask(/* no idempotencyKey */),
        elapsedMs: 1000,
        agentName: 'a',
        isTerminal: false,
      },
      reg,
      { enabled: true },
    );
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('no-idempotency-key');
  });

  it('skips when task is itself a twin', () => {
    const reg = regWithMedian('a', 100);
    const decision = evaluateSpeculative(
      {
        task: makeTask({
          idempotencyKey: 'k1',
          labels: { [SPECULATIVE_TWIN_LABEL]: 'true' },
        }),
        elapsedMs: 1000,
        agentName: 'a',
        isTerminal: false,
      },
      reg,
      { enabled: true },
    );
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('already-twin');
  });

  it('skips when fewer than minSamples have been recorded', () => {
    const reg = new LatencyHistogramRegistry(100, 5);
    reg.record('a', 100); // only 1 sample
    const decision = evaluateSpeculative(
      {
        task: makeTask({ idempotencyKey: 'k1' }),
        elapsedMs: 5000,
        agentName: 'a',
        isTerminal: false,
      },
      reg,
      { enabled: true },
    );
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('insufficient-samples');
  });

  it('skips when elapsed is under threshold', () => {
    const reg = regWithMedian('a', 100);
    const decision = evaluateSpeculative(
      {
        task: makeTask({ idempotencyKey: 'k1' }),
        elapsedMs: 200, // 2× median, below 3× default
        agentName: 'a',
        isTerminal: false,
      },
      reg,
      { enabled: true },
    );
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('under-threshold');
  });

  it('skips when median is 0 (degenerate)', () => {
    const reg = new LatencyHistogramRegistry(100, 1);
    for (let i = 0; i < 5; i++) reg.record('a', 0);
    const decision = evaluateSpeculative(
      {
        task: makeTask({ idempotencyKey: 'k1' }),
        elapsedMs: 5000,
        agentName: 'a',
        isTerminal: false,
      },
      reg,
      { enabled: true },
    );
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('under-threshold');
  });

  it('spawns when elapsed > threshold × median', () => {
    const reg = regWithMedian('a', 100);
    const decision = evaluateSpeculative(
      {
        task: makeTask({ idempotencyKey: 'k1' }),
        elapsedMs: 350, // 3.5× median > 3.0× default threshold
        agentName: 'a',
        isTerminal: false,
      },
      reg,
      { enabled: true },
    );
    expect(decision.kind).toBe('spawn');
    if (decision.kind === 'spawn') {
      expect(decision.agentName).toBe('a');
      expect(decision.elapsedMs).toBe(350);
      expect(decision.medianMs).toBe(100);
      expect(decision.thresholdMs).toBe(300);
    }
  });

  it('respects custom threshold', () => {
    const reg = regWithMedian('a', 100);
    // Threshold = 1.5; elapsed 200ms > 150ms.
    const decision = evaluateSpeculative(
      {
        task: makeTask({ idempotencyKey: 'k1' }),
        elapsedMs: 200,
        agentName: 'a',
        isTerminal: false,
      },
      reg,
      { enabled: true, threshold: 1.5 },
    );
    expect(decision.kind).toBe('spawn');
    if (decision.kind === 'spawn') {
      expect(decision.thresholdMs).toBe(150);
    }
  });

  it('skips when elapsedMs is NaN or negative', () => {
    const reg = regWithMedian('a', 100);
    const taskFixture = makeTask({ idempotencyKey: 'k1' });
    expect(
      evaluateSpeculative(
        { task: taskFixture, elapsedMs: Number.NaN, agentName: 'a', isTerminal: false },
        reg,
        { enabled: true },
      ).kind,
    ).toBe('skip');
    expect(
      evaluateSpeculative(
        { task: taskFixture, elapsedMs: -1, agentName: 'a', isTerminal: false },
        reg,
        { enabled: true },
      ).kind,
    ).toBe('skip');
  });

  it('skips when task is missing UID', () => {
    const reg = regWithMedian('a', 100);
    const task: AffinityTask = {
      metadata: { name: 'task-1', namespace: 'default' },
      spec: { idempotencyKey: 'k1' } as AffinityTask['spec'],
    };
    const decision = evaluateSpeculative(
      { task, elapsedMs: 5000, agentName: 'a', isTerminal: false },
      reg,
      { enabled: true },
    );
    expect(decision.kind).toBe('skip');
    if (decision.kind === 'skip') expect(decision.reason).toBe('no-task-uid');
  });
});

describe('buildTwinManifest', () => {
  it('emits a deterministic name + twin labels', () => {
    const primary = makeTask({
      uid: 'abcdefghij1234567890aaaaaaaaaaaa',
      name: 'task-primary',
      namespace: 'work',
      idempotencyKey: 'k1',
      labels: { 'kagent.knuteson.io/agent': 'researcher' },
      extraSpec: { targetAgent: 'researcher', payload: { hello: 'world' } },
    });
    const m = buildTwinManifest(primary, 'kagent.knuteson.io/v1alpha1');
    expect(m.metadata.name).toMatch(/^kts-/);
    expect(m.metadata.namespace).toBe('work');
    expect(m.metadata.labels[SPECULATIVE_TWIN_LABEL]).toBe('true');
    expect(m.metadata.labels[SPECULATIVE_PRIMARY_UID_LABEL]).toBe(
      'abcdefghij1234567890aaaaaaaaaaaa',
    );
    expect(m.metadata.labels['kagent.knuteson.io/agent']).toBe('researcher');
    expect(m.kind).toBe('AgentTask');
    expect(m.apiVersion).toBe('kagent.knuteson.io/v1alpha1');
    expect(m.spec).toEqual(primary.spec);
  });

  it('throws when primary lacks UID', () => {
    const noUid: AffinityTask = {
      metadata: { name: 'task-1', namespace: 'default' },
      spec: {},
    };
    expect(() => buildTwinManifest(noUid, 'kagent.knuteson.io/v1alpha1')).toThrow();
  });

  it('caps name length to a deterministic 60 chars', () => {
    const primary = makeTask({
      uid: 'a'.repeat(80),
      name: 'task-primary',
      idempotencyKey: 'k1',
    });
    const m = buildTwinManifest(primary, 'kagent.knuteson.io/v1alpha1');
    // 'kts-' (4) + 56 chars
    expect(m.metadata.name.length).toBe(60);
    expect(m.metadata.name.startsWith('kts-')).toBe(true);
  });

  it('runs the spawn callable when invoked from a higher-level driver', async () => {
    // Driver pattern: caller composes evaluateSpeculative + buildTwinManifest +
    // injected SpawnTwinFn. We exercise the full chain with a mocked spawn.
    const reg = (() => {
      const r = new LatencyHistogramRegistry(100, 5);
      for (let i = 0; i < 10; i++) r.record('a', 100);
      return r;
    })();
    const task = makeTask({
      uid: 'uid-primary-1234567890',
      idempotencyKey: 'k1',
      extraSpec: { targetAgent: 'a', payload: {} },
    });
    const decision = evaluateSpeculative(
      { task, elapsedMs: 1000, agentName: 'a', isTerminal: false },
      reg,
      { enabled: true },
    );
    expect(decision.kind).toBe('spawn');
    const calls: { name: string }[] = [];
    const spawnTwin = (manifest: { metadata: { name: string } }): Promise<void> => {
      calls.push({ name: manifest.metadata.name });
      return Promise.resolve();
    };
    if (decision.kind === 'spawn') {
      const m = buildTwinManifest(task, 'kagent.knuteson.io/v1alpha1');
      await spawnTwin(m);
    }
    expect(calls.length).toBe(1);
    expect(calls[0]?.name).toMatch(/^kts-uid-primary/);
  });
});
