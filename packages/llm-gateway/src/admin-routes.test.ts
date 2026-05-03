/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import {
  adminAuth,
  buildCapacityResponse,
  buildUsageResponse,
  parseUsageQuery,
} from './admin-routes.js';
import { AimdController } from './aimd.js';
import { InFlightCounter } from './inflight-counter.js';
import { ModelIndex } from './model-index.js';
import type { ModelEndpoint } from './types.js';
import type { UsageRepo, UsageQueryFilter, UsageQueryRow } from './db/usage.js';

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('adminAuth', () => {
  it('rejects when authorization header is absent', () => {
    expect(adminAuth(fakeReq({}), 'tok')).toMatchObject({ ok: false, statusCode: 401 });
  });

  it('rejects when supplied token differs in length', () => {
    expect(adminAuth(fakeReq({ authorization: 'Bearer short' }), 'longertoken')).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });

  it('rejects when supplied token differs in value', () => {
    expect(adminAuth(fakeReq({ authorization: 'Bearer aaaa' }), 'bbbb')).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });

  it('accepts a matching Bearer token', () => {
    expect(adminAuth(fakeReq({ authorization: 'Bearer tok' }), 'tok')).toMatchObject({ ok: true });
  });

  it('accepts a raw token without the Bearer prefix', () => {
    expect(adminAuth(fakeReq({ authorization: 'tok' }), 'tok')).toMatchObject({ ok: true });
  });
});

function ep(model: string, max = 4, seed = 2, url = 'http://x'): ModelEndpoint {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ModelEndpoint',
    metadata: { name: 'm' },
    spec: {
      model,
      backendKind: 'mock',
      backendUrl: url,
      inFlight: { seed, max },
    },
  };
}

describe('buildCapacityResponse', () => {
  it('returns empty rows when the index is empty', () => {
    const r = buildCapacityResponse(
      new ModelIndex(),
      new InFlightCounter(),
      new AimdController({ seed: 1, max: 4, minSafe: 1 }),
    );
    expect(r.rows).toEqual([]);
  });

  it('returns one row per (model, endpoint) with current cap + in-flight', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('a', 8, 4, 'http://aa'));
    idx.upsert(ep('b', 4, 2, 'http://bb'));
    const cnt = new InFlightCounter();
    cnt.acquire('a', 'http://aa');
    cnt.acquire('a', 'http://aa');
    const aimd = new AimdController({ seed: 4, max: 8, minSafe: 1 });
    aimd.updateBounds('a', 'http://aa', { seed: 4, max: 8, minSafe: 1 });
    aimd.updateBounds('b', 'http://bb', { seed: 2, max: 4, minSafe: 1 });
    const r = buildCapacityResponse(idx, cnt, aimd);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.model).toBe('a');
    expect(r.rows[0]?.inFlight).toBe(2);
    expect(r.rows[0]?.currentCap).toBe(4);
    expect(r.rows[1]?.model).toBe('b');
    expect(r.rows[1]?.currentCap).toBe(2);
  });
});

describe('parseUsageQuery', () => {
  it('returns empty filter on bare path', () => {
    expect(parseUsageQuery('/admin/usage')).toEqual({});
  });

  it('parses every supported field', () => {
    const f = parseUsageQuery(
      '/admin/usage?taskUid=u&agentName=a&model=m&since=2026-01-01&until=2026-02-01&limit=50',
    );
    expect(f).toEqual<UsageQueryFilter>({
      taskUid: 'u',
      agentName: 'a',
      model: 'm',
      since: '2026-01-01',
      until: '2026-02-01',
      limit: 50,
    });
  });

  it('drops a non-numeric or non-positive limit', () => {
    expect(parseUsageQuery('/admin/usage?limit=oops').limit).toBeUndefined();
    expect(parseUsageQuery('/admin/usage?limit=-1').limit).toBeUndefined();
  });

  it('drops empty-string params', () => {
    expect(parseUsageQuery('/admin/usage?taskUid=&model=')).toEqual({});
  });
});

describe('buildUsageResponse', () => {
  class FakeUsageRepo implements UsageRepo {
    captured: UsageQueryFilter | null = null;
    rowsToReturn: UsageQueryRow[] = [];

    async record(): Promise<void> {
      /* not used */
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async query(filter: UsageQueryFilter): Promise<readonly UsageQueryRow[]> {
      this.captured = filter;
      return this.rowsToReturn;
    }
  }

  it('hands a parsed filter to the repo and wraps the rows', async () => {
    const repo = new FakeUsageRepo();
    repo.rowsToReturn = [
      {
        id: '1',
        occurredAt: '2026-05-03T01:02:03Z',
        apiKeyPrefix: 'sk-x',
        requestId: 'r-1',
        model: 'm',
        backend: 'mock',
        backendUrl: null,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        latencyMs: 1,
        statusCode: 200,
        costUsd: 0,
        streaming: false,
        taskUid: 'task-1',
        agentName: 'a',
        errorMessage: null,
      },
    ];
    const r = await buildUsageResponse('/admin/usage?taskUid=task-1&limit=10', repo);
    expect(repo.captured).toEqual({ taskUid: 'task-1', limit: 10 });
    expect(r.rows).toHaveLength(1);
  });
});
