/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { createUsageRepo } from './usage.js';
import type { Queryable, QueryResult } from './api-keys.js';

class FakeDb implements Queryable {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  rowsToReturn: unknown[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    this.calls.push({ sql: text, values: values ?? [] });
    const rows = this.rowsToReturn as unknown as readonly R[];
    return { rows, rowCount: rows.length };
  }
}

describe('createUsageRepo.record', () => {
  it('inserts with the expected positional args', async () => {
    const db = new FakeDb();
    await createUsageRepo(db).record({
      apiKeyPrefix: 'sk-pfx',
      requestId: 'req-1',
      model: 'llama3.2:1b',
      backend: 'ollama',
      backendUrl: 'http://o:11434',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      latencyMs: 234,
      statusCode: 200,
      costUsd: 0.0,
      streaming: false,
      taskUid: 'task-uid-1',
      agentName: 'researcher',
      errorMessage: null,
    });
    expect(db.calls[0]?.sql).toMatch(/INSERT INTO usage_records/);
    expect(db.calls[0]?.values[0]).toBe('sk-pfx');
    expect(db.calls[0]?.values[1]).toBe('req-1');
    expect(db.calls[0]?.values[3]).toBe('llama3.2:1b');
    expect(db.calls[0]?.values[4]).toBe('ollama');
  });

  it('passes null for occurredAt when omitted (server defaults NOW)', async () => {
    const db = new FakeDb();
    await createUsageRepo(db).record({
      apiKeyPrefix: null,
      requestId: 'r',
      model: 'm',
      backend: 'mock',
      backendUrl: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      statusCode: 200,
      costUsd: 0,
      streaming: false,
      taskUid: null,
      agentName: null,
      errorMessage: null,
    });
    expect(db.calls[0]?.values[2]).toBeNull();
  });
});

describe('createUsageRepo.query', () => {
  it('returns empty array when no rows', async () => {
    const db = new FakeDb();
    const repo = createUsageRepo(db);
    const r = await repo.query({});
    expect(r).toEqual([]);
  });

  it('builds a parameterised WHERE clause for each filter', async () => {
    const db = new FakeDb();
    await createUsageRepo(db).query({
      taskUid: 'task-1',
      agentName: 'researcher',
      model: 'gpt-4o',
      since: '2026-05-01T00:00:00Z',
      until: '2026-05-03T00:00:00Z',
      limit: 50,
    });
    const sql = db.calls[0]?.sql ?? '';
    expect(sql).toContain('task_uid = $1');
    expect(sql).toContain('agent_name = $2');
    expect(sql).toContain('model = $3');
    expect(sql).toContain('occurred_at >= $4');
    expect(sql).toContain('occurred_at < $5');
    expect(sql).toContain('LIMIT $6');
    expect(db.calls[0]?.values).toEqual([
      'task-1',
      'researcher',
      'gpt-4o',
      '2026-05-01T00:00:00Z',
      '2026-05-03T00:00:00Z',
      50,
    ]);
  });

  it('clamps oversize limit to MAX', async () => {
    const db = new FakeDb();
    await createUsageRepo(db).query({ limit: 9999 });
    const lastVal = db.calls[0]?.values[db.calls[0].values.length - 1];
    expect(lastVal).toBe(1000);
  });

  it('falls back to default limit when missing', async () => {
    const db = new FakeDb();
    await createUsageRepo(db).query({});
    expect(db.calls[0]?.values[0]).toBe(100);
  });

  it('maps DB rows to UsageQueryRow shape', async () => {
    const db = new FakeDb();
    db.rowsToReturn = [
      {
        id: '7',
        occurred_at: new Date('2026-05-03T01:02:03Z'),
        api_key_prefix: 'sk-x',
        request_id: 'req-9',
        model: 'mock',
        backend: 'mock',
        backend_url: null,
        input_tokens: 11,
        output_tokens: 22,
        total_tokens: 33,
        latency_ms: 100,
        status_code: 200,
        cost_usd: '0.001230',
        streaming: false,
        task_uid: 'task-1',
        agent_name: 'researcher',
        error_message: null,
      },
    ];
    const r = await createUsageRepo(db).query({});
    expect(r[0]?.occurredAt).toBe('2026-05-03T01:02:03.000Z');
    expect(r[0]?.costUsd).toBeCloseTo(0.00123, 5);
    expect(r[0]?.taskUid).toBe('task-1');
  });
});
