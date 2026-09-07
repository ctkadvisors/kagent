/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

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
});
