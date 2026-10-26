/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';
import { renderAgentTaskFromTemplate } from '@kagent/triggers';
import { enrichFleetWork } from './fleet-work.js';

function task(triggerName = 'fleet-nightly-invention') {
  return renderAgentTaskFromTemplate({
    triggerName,
    triggerKind: 'schedule',
    namespace: 'kagent-system',
    now: new Date('2026-10-25T12:00:00Z'),
    taskTemplate: {
      targetAgent: 'fleet-inventor',
      payload: { text: 'Continue real work' },
      runConfig: { maxIterations: 300, timeoutSeconds: 14400 },
    },
  });
}
function work(stage = 'build', targetAgent = 'fleet-inventor') {
  return {
    schema: 'fleet-capability-work/v1',
    id: 'a'.repeat(32),
    stage,
    target_agent: targetAgent,
    goal: 'Resolve actual unfinished fleet work',
    instructions: 'Verify sources and use previous outcomes',
    sources: [],
    previous_outcomes: [],
    capabilities: [],
  };
}
function respond(value: unknown) {
  return vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ capability_work: value }), { status: 200 })),
  );
}

describe('existing idle task real-work binding', () => {
  it('binds current work and provenance without changing task bounds', async () => {
    const original = task();
    const fetch = respond(work());
    const enriched = await enrichFleetWork(original, { url: 'http://authority/missions', fetch });
    expect(enriched.metadata.labels['fleet.knuteson.io/work-id']).toBe('a'.repeat(32));
    expect(enriched.metadata.labels['fleet.knuteson.io/work-stage']).toBe('build');
    expect(enriched.spec.runConfig).toEqual(original.spec.runConfig);
    expect(enriched.spec.payload).toMatchObject({ capability_work: work() });
    expect(JSON.stringify(enriched.spec.payload)).toContain('actual unfinished fleet work');
    expect(original.metadata.labels).not.toHaveProperty('fleet.knuteson.io/work-id');
  });
  it('uses the same slot for a named existing consumer after promotion', async () => {
    const value = { ...work('use', 'fleet-auditor'), capability: { template: 'capability-tool' } };
    const enriched = await enrichFleetWork(task(), {
      url: 'http://authority/missions',
      fetch: respond(value),
    });
    expect(enriched.spec.targetAgent).toBe('fleet-auditor');
    expect(enriched.spec.runConfig).toEqual(task().spec.runConfig);
  });
  it('never widens grants or bounds from the report', async () => {
    const value = { ...work(), runConfig: { maxIterations: 99999 }, toolProfileRef: 'admin' };
    const enriched = await enrichFleetWork(task(), {
      url: 'http://authority/missions',
      fetch: respond(value),
    });
    expect(enriched.spec.runConfig).toEqual(task().spec.runConfig);
    expect(enriched.spec).not.toHaveProperty('toolProfileRef');
    expect(enriched.spec).not.toHaveProperty('egress');
  });
  it('rejects arbitrary targets and unavailable work instead of launching unrelated work', async () => {
    await expect(
      enrichFleetWork(task(), {
        url: 'http://authority/missions',
        fetch: respond(work('use', 'homelab-builder')),
      }),
    ).rejects.toThrow(/work/u);
    await expect(
      enrichFleetWork(task(), { url: 'http://authority/missions', fetch: respond(undefined) }),
    ).rejects.toThrow(/work/u);
    await expect(
      enrichFleetWork(task(), {
        url: 'http://authority/missions',
        fetch: vi.fn(() => Promise.reject(new Error('unavailable'))),
      }),
    ).rejects.toThrow(/unavailable/u);
  });
  it('does not touch unrelated schedules or disabled installations', async () => {
    const fetch = respond(work());
    const original = task('some-user-schedule');
    expect(await enrichFleetWork(original, { url: 'http://authority/missions', fetch })).toBe(
      original,
    );
    expect(await enrichFleetWork(task(), { fetch })).toEqual(task());
    expect(fetch).not.toHaveBeenCalled();
  });
});
