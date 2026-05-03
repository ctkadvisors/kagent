/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { applyMigrations } from './migrations.js';
import type { Queryable, QueryResult } from './api-keys.js';

class FakeDb implements Queryable {
  readonly applied: string[] = [];
  readonly executedSql: string[] = [];
  private readonly versions = new Set<string>();
  private bootstrapped = false;

  // eslint-disable-next-line @typescript-eslint/require-await
  async query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    this.executedSql.push(text);
    const trimmed = text.trim();
    if (trimmed.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      this.bootstrapped = true;
      return { rows: [] as unknown as readonly R[], rowCount: 0 };
    }
    if (trimmed.startsWith('SELECT version FROM schema_migrations')) {
      if (!this.bootstrapped) throw new Error('schema_migrations not bootstrapped');
      const rows = [...this.versions].map((v) => ({ version: v }));
      return { rows: rows as unknown as readonly R[], rowCount: rows.length };
    }
    if (trimmed.startsWith('INSERT INTO schema_migrations')) {
      const raw = (values ?? [])[0];
      const v = typeof raw === 'string' ? raw : '';
      this.versions.add(v);
      this.applied.push(v);
      return { rows: [] as unknown as readonly R[], rowCount: 1 };
    }
    // body of a migration file — record but don't interpret
    return { rows: [] as unknown as readonly R[], rowCount: 0 };
  }
}

describe('applyMigrations', () => {
  it('applies all migrations in order on the first run', async () => {
    const db = new FakeDb();
    const result = await applyMigrations(db, [
      { version: '001_initial', sql: 'CREATE TABLE a();' },
      { version: '002_extra', sql: 'CREATE TABLE b();' },
    ]);
    expect(result.applied).toEqual(['001_initial', '002_extra']);
    expect(result.skipped).toEqual([]);
    expect(db.applied).toEqual(['001_initial', '002_extra']);
  });

  it('is idempotent — second run skips already-applied migrations', async () => {
    const db = new FakeDb();
    const migrations = [
      { version: '001_initial', sql: 'CREATE TABLE a();' },
      { version: '002_extra', sql: 'CREATE TABLE b();' },
    ];
    await applyMigrations(db, migrations);
    const second = await applyMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['001_initial', '002_extra']);
  });

  it('applies only the new migration when one is added later', async () => {
    const db = new FakeDb();
    await applyMigrations(db, [{ version: '001_initial', sql: 'CREATE TABLE a();' }]);
    const r2 = await applyMigrations(db, [
      { version: '001_initial', sql: 'CREATE TABLE a();' },
      { version: '002_added_later', sql: 'CREATE TABLE c();' },
    ]);
    expect(r2.applied).toEqual(['002_added_later']);
    expect(r2.skipped).toEqual(['001_initial']);
  });
});
