/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Smoke test for the triggers wiring. The actual schedule controller +
 * webhook receiver are exercised in `@kagent/triggers/*.test.ts`; this
 * file just verifies that:
 *   - `buildTriggersBootstrap` returns a handle with the expected shape
 *   - the handle's `scheduleController` is wired (not undefined)
 * It does NOT call `.start()` because that opens a real K8s informer
 * (which needs a working KubeConfig). Boot-with-real-K8s coverage lives
 * in the homelab smoke test (a kubectl-driven Job).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RenderedAgentTask } from '@kagent/triggers';

import { buildTriggersBootstrap } from './triggers-bootstrap.js';

describe('buildTriggersBootstrap', () => {
  it('returns a handle with start, stop, and scheduleController', () => {
    const handle = buildTriggersBootstrap({
      kc: {} as never,
      customApi: {} as never,
    });
    expect(typeof handle.start).toBe('function');
    expect(typeof handle.stop).toBe('function');
    expect(handle.scheduleController).toBeDefined();
    expect(typeof handle.scheduleController.tickOnce).toBe('function');
    expect(handle.scheduleController.size()).toBe(0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('binds authority work through schedule dispatch and retries unavailable context without creating a task', async () => {
  vi.stubEnv('FLEET_WORK_REPORT_URL', 'http://report.fleet-authority.svc:8080/missions');
  const work = {
    schema: 'fleet-capability-work/v1',
    id: 'a'.repeat(32),
    stage: 'use',
    target_agent: 'fleet-auditor',
    goal: 'Resolve current failed delivery',
    instructions: 'Use the accepted pinned tool on the real work',
    sources: [],
    previous_outcomes: [],
    capabilities: [],
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ capability_work: work })));
  vi.stubGlobal('fetch', fetch);
  const create = vi
    .fn<(input: { body: RenderedAgentTask }) => Promise<Record<string, never>>>()
    .mockResolvedValue({});
  const patch = vi.fn().mockResolvedValue({});
  const handle = buildTriggersBootstrap({
    kc: {} as never,
    customApi: {
      createNamespacedCustomObject: create,
      patchNamespacedCustomObjectStatus: patch,
    } as never,
  });
  const runConfig = { maxIterations: 300, timeoutSeconds: 14400 };
  handle.scheduleController.upsert({
    metadata: { name: 'fleet-nightly-invention', namespace: 'kagent-system' },
    spec: {
      schedule: '* * * * *',
      taskTemplate: { targetAgent: 'fleet-inventor', payload: { text: 'original' }, runConfig },
    },
  });
  expect(await handle.scheduleController.tickOnce(new Date('2026-10-25T12:00:00Z'))).toBe(0);
  expect(create).not.toHaveBeenCalled();
  expect(patch).not.toHaveBeenCalled();
  expect(await handle.scheduleController.tickOnce(new Date('2026-10-25T12:01:00Z'))).toBe(1);
  const task = create.mock.calls[0]?.[0].body;
  expect(task?.spec.targetAgent).toBe('fleet-auditor');
  expect(task?.spec.runConfig).toEqual(runConfig);
  expect(task?.spec.payload).toMatchObject({ capability_work: work });
  expect(task?.metadata.labels['fleet.knuteson.io/work-id']).toBe(work.id);
  expect(patch).toHaveBeenCalledOnce();
});
