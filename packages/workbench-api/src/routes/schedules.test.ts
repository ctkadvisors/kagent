/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { CustomObjectsApi } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION, type KagentSchedule } from '@kagent/dto';

import { SnapshotCache } from '../cache.js';
import { schedulesRoute } from './schedules.js';

function makeSchedule(overrides: Partial<KagentSchedule> = {}): KagentSchedule {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'KagentSchedule',
    metadata: {
      name: 'brain-invalidation-audit',
      namespace: 'kagent-system',
      ...overrides.metadata,
    },
    spec: {
      schedule: '*/15 * * * *',
      taskTemplate: { targetAgent: 'brain-auditor', payload: {} },
      ...overrides.spec,
    },
    ...(overrides.status !== undefined && { status: overrides.status }),
  };
}

function makeReq(url: string): Request {
  return new Request(`http://test${url}`, { method: 'GET' });
}

describe('schedulesRoute', () => {
  it('GET /api/schedules lists cached KagentSchedule CRs', async () => {
    const cache = new SnapshotCache();
    cache.upsertSchedule(
      makeSchedule({
        status: { lastTickAt: '2026-08-01T00:15:00Z', nextTickAt: '2026-08-01T00:30:00Z' },
      }),
    );
    const app = schedulesRoute({ cache });
    const res = await app.request(makeReq('/api/schedules'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([
      {
        namespace: 'kagent-system',
        name: 'brain-invalidation-audit',
        schedule: '*/15 * * * *',
        suspended: false,
        whenIdle: false,
        targetAgent: 'brain-auditor',
        lastTickAt: '2026-08-01T00:15:00Z',
        nextTickAt: '2026-08-01T00:30:00Z',
      },
    ]);
  });

  it('reflects spec.suspend and targetCapability', async () => {
    const cache = new SnapshotCache();
    cache.upsertSchedule(
      makeSchedule({
        metadata: { name: 'suspended-one', namespace: 'kagent-system' },
        spec: {
          schedule: '0 * * * *',
          suspend: true,
          taskTemplate: { targetCapability: 'summarize', payload: {} },
        },
      }),
    );
    const app = schedulesRoute({ cache });
    const res = await app.request(makeReq('/api/schedules'));
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      suspended: true,
      targetCapability: 'summarize',
    });
    expect(body.items[0]?.targetAgent).toBeUndefined();
  });

  it('filters by namespace query param', async () => {
    const cache = new SnapshotCache();
    cache.upsertSchedule(makeSchedule({ metadata: { name: 'a', namespace: 'ns-a' } }));
    cache.upsertSchedule(makeSchedule({ metadata: { name: 'b', namespace: 'ns-b' } }));
    const app = schedulesRoute({ cache });
    const res = await app.request(makeReq('/api/schedules?namespace=ns-a'));
    const body = (await res.json()) as { items: Array<{ namespace: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.namespace).toBe('ns-a');
  });

  it('returns an empty list when no schedules are cached', async () => {
    const app = schedulesRoute({ cache: new SnapshotCache() });
    const res = await app.request(makeReq('/api/schedules'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('sorts by namespace then name', async () => {
    const cache = new SnapshotCache();
    cache.upsertSchedule(makeSchedule({ metadata: { name: 'zebra', namespace: 'kagent-system' } }));
    cache.upsertSchedule(makeSchedule({ metadata: { name: 'apple', namespace: 'kagent-system' } }));
    const app = schedulesRoute({ cache });
    const res = await app.request(makeReq('/api/schedules'));
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(['apple', 'zebra']);
  });

  describe('POST /api/schedules/:namespace/:name/run', () => {
    const run = (headers: Record<string, string> = { 'content-type': 'application/json' }) =>
      new Request('http://test/api/schedules/kagent-system/brain-invalidation-audit/run', {
        method: 'POST',
        headers,
        body: '{}',
      });
    const build = (schedule = makeSchedule(), patch = vi.fn(() => Promise.resolve({}))) => {
      const cache = new SnapshotCache();
      cache.upsertSchedule(schedule);
      const app = schedulesRoute({
        cache,
        customApi: { patchNamespacedCustomObject: patch } as unknown as CustomObjectsApi,
        writesEnabled: true,
        defaultNamespace: 'kagent-system',
        now: () => new Date('2026-11-26T15:00:20.000Z'),
      });
      return { app, patch };
    };

    it('stamps the run-request annotation and answers 202', async () => {
      const { app, patch } = build();
      const res = await app.request(run());
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        ok: true,
        namespace: 'kagent-system',
        name: 'brain-invalidation-audit',
        requestedAt: '2026-11-26T15:00:20.000Z',
      });
      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch.mock.calls[0]?.[0]).toMatchObject({
        plural: 'kagentschedules',
        namespace: 'kagent-system',
        name: 'brain-invalidation-audit',
        body: {
          metadata: {
            annotations: { 'kagent.knuteson.io/run-requested-at': '2026-11-26T15:00:20.000Z' },
          },
        },
      });
    });

    it('refuses a suspended schedule, an unknown one, another namespace and a non-JSON post', async () => {
      const suspended = build(
        makeSchedule({
          spec: { schedule: '* * * * *', suspend: true, taskTemplate: { payload: {} } },
        }),
      );
      expect((await suspended.app.request(run())).status).toBe(409);
      expect(suspended.patch).not.toHaveBeenCalled();

      const { app, patch } = build();
      const post = (path: string) =>
        app.request(
          new Request(`http://test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
        );
      expect((await post('/api/schedules/kagent-system/nope/run')).status).toBe(404);
      expect((await post('/api/schedules/other/brain-invalidation-audit/run')).status).toBe(403);
      expect((await app.request(run({ 'content-type': 'text/plain' }))).status).toBe(415);
      expect(patch).not.toHaveBeenCalled();
    });

    it('answers 503 when the write surface is off', async () => {
      const cache = new SnapshotCache();
      cache.upsertSchedule(makeSchedule());
      expect((await schedulesRoute({ cache }).request(run())).status).toBe(503);
    });
  });
});
