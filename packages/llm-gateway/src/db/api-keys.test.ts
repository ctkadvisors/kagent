/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { createApiKeyRepo } from './api-keys.js';
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

describe('createApiKeyRepo', () => {
  it('getByHash returns null when no rows', async () => {
    const db = new FakeDb();
    const repo = createApiKeyRepo(db);
    const r = await repo.getByHash('hash-x');
    expect(r).toBeNull();
    expect(db.calls[0]?.sql).toMatch(/SELECT/);
    expect(db.calls[0]?.values[0]).toBe('hash-x');
  });

  it('getByHash maps a row to an ApiKeyInfo (Date expires_at)', async () => {
    const db = new FakeDb();
    db.rowsToReturn = [
      {
        id: '1',
        key_hash: 'h',
        key_prefix: 'sk-pfx',
        name: 'kagent',
        status: 'active',
        expires_at: new Date('2030-01-01T00:00:00Z'),
      },
    ];
    const repo = createApiKeyRepo(db);
    const r = await repo.getByHash('h');
    expect(r?.keyHash).toBe('h');
    expect(r?.status).toBe('active');
    expect(r?.expiresAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('getByHash maps a string expires_at unchanged', async () => {
    const db = new FakeDb();
    db.rowsToReturn = [
      {
        id: '1',
        key_hash: 'h',
        key_prefix: 'sk',
        name: 'kagent',
        status: 'revoked',
        expires_at: '2030-02-02T00:00:00Z',
      },
    ];
    const repo = createApiKeyRepo(db);
    const r = await repo.getByHash('h');
    expect(r?.status).toBe('revoked');
    expect(r?.expiresAt).toBe('2030-02-02T00:00:00Z');
  });

  it('touchLastUsed runs an UPDATE bound to keyHash', async () => {
    const db = new FakeDb();
    await createApiKeyRepo(db).touchLastUsed('h');
    expect(db.calls[0]?.sql).toMatch(/UPDATE api_keys SET last_used_at/);
    expect(db.calls[0]?.values[0]).toBe('h');
  });

  it('insert binds the args (no expiresAt → null)', async () => {
    const db = new FakeDb();
    await createApiKeyRepo(db).insert({ keyHash: 'h', keyPrefix: 'sk-pfx', name: 'kagent' });
    expect(db.calls[0]?.sql).toMatch(/INSERT INTO api_keys/);
    expect(db.calls[0]?.values).toEqual(['h', 'sk-pfx', 'kagent', null]);
  });
});
