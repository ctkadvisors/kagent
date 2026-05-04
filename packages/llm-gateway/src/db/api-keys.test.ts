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
    expect(db.calls[0]?.values).toEqual(['h', 'sk-pfx', 'kagent', null, null]);
  });

  it('insert binds modelAllowlist when supplied (Postgres TEXT[] array)', async () => {
    const db = new FakeDb();
    await createApiKeyRepo(db).insert({
      keyHash: 'h',
      keyPrefix: 'sk',
      name: 'researcher',
      modelAllowlist: ['gpt-4o', 'claude-3.5'],
    });
    expect(db.calls[0]?.values).toEqual(['h', 'sk', 'researcher', null, ['gpt-4o', 'claude-3.5']]);
  });

  it('insertAndReturn returns the row id assigned by Postgres BIGSERIAL', async () => {
    const db = new FakeDb();
    db.rowsToReturn = [{ id: '42' }];
    const out = await createApiKeyRepo(db).insertAndReturn({
      keyHash: 'h',
      keyPrefix: 'sk-x',
      name: 'cli',
    });
    expect(out).toEqual({ id: '42' });
    expect(db.calls[0]?.sql).toMatch(/RETURNING id/);
  });

  it('insertAndReturn coerces a numeric id to string', async () => {
    const db = new FakeDb();
    db.rowsToReturn = [{ id: 99 }];
    const out = await createApiKeyRepo(db).insertAndReturn({
      keyHash: 'h',
      keyPrefix: 'sk-x',
      name: 'cli',
    });
    expect(out).toEqual({ id: '99' });
  });

  it('list returns admin-shape rows excluding plaintext / hash', async () => {
    const db = new FakeDb();
    db.rowsToReturn = [
      {
        id: 1,
        key_prefix: 'sk-abc12',
        name: 'orchestrator',
        status: 'active',
        model_allowlist: ['gpt-4o'],
        expires_at: new Date('2030-01-01T00:00:00Z'),
        revoked_at: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 2,
        key_prefix: 'sk-xyz98',
        name: 'old',
        status: 'revoked',
        model_allowlist: null,
        expires_at: null,
        revoked_at: new Date('2026-04-01T00:00:00Z'),
        created_at: new Date('2025-01-01T00:00:00Z'),
      },
    ];
    const rows = await createApiKeyRepo(db).list();
    expect(db.calls[0]?.sql).toMatch(/SELECT[\s\S]+FROM api_keys/);
    // No row may carry plaintext or key_hash (only the prefix is OK).
    expect(rows[0]).toEqual({
      id: '1',
      label: 'orchestrator',
      hashPrefix: 'sk-abc12',
      status: 'active',
      modelAllowlist: ['gpt-4o'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      revokedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(rows[1]?.modelAllowlist).toBeNull();
    expect(rows[1]?.revokedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(rows[1]?.expiresAt).toBeNull();
    expect(rows).toHaveLength(2);
    // Belt + suspenders — the SELECT projects out hash + plaintext.
    expect(db.calls[0]?.sql).not.toMatch(/key_hash/);
  });

  it('revoke updates status + revoked_at by id and returns the row count', async () => {
    const db = new FakeDb();
    db.rowsToReturn = [{ id: '7' }];
    const r = await createApiKeyRepo(db).revoke('7');
    expect(db.calls[0]?.sql).toMatch(/UPDATE api_keys/);
    expect(db.calls[0]?.sql).toMatch(/revoked_at/);
    expect(db.calls[0]?.sql).toMatch(/status/);
    expect(db.calls[0]?.values[0]).toBe('7');
    expect(r.revoked).toBe(true);
  });

  it('revoke returns {revoked:false} when no row matches the id (404 surface)', async () => {
    const db = new FakeDb();
    db.rowsToReturn = [];
    const r = await createApiKeyRepo(db).revoke('nope');
    expect(r.revoked).toBe(false);
  });
});
