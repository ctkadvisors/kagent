/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * api_keys repository. Wraps the SQL surface as a small async
 * function set so the rest of the package never composes raw SQL.
 *
 * The `Queryable` interface is the minimum shape the repo needs —
 * `pg.Pool`, `pg.PoolClient`, and `pg.Client` all satisfy it. Tests
 * pass a stub.
 */

import type { ApiKeyInfo } from '../auth.js';

export interface QueryResult<R> {
  readonly rows: readonly R[];
  readonly rowCount: number | null;
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

interface ApiKeyRow {
  readonly id: string;
  readonly key_hash: string;
  readonly key_prefix: string;
  readonly name: string;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly expires_at: Date | string | null;
}

export interface ApiKeyRepo {
  /** Lookup by SHA-256 hex digest. Returns null if not found. */
  getByHash(keyHash: string): Promise<ApiKeyInfo | null>;
  /** Touch `last_used_at` after a successful auth (best-effort, fire-and-forget). */
  touchLastUsed(keyHash: string): Promise<void>;
  /**
   * Insert a new active API key. The caller controls the raw key + hash;
   * this method only persists.
   */
  insert(input: InsertApiKeyInput): Promise<void>;
}

export interface InsertApiKeyInput {
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly name: string;
  /** ISO 8601 timestamp; absent = no expiration. */
  readonly expiresAt?: string;
}

export function createApiKeyRepo(db: Queryable): ApiKeyRepo {
  return {
    async getByHash(keyHash) {
      const r = await db.query<ApiKeyRow>(
        'SELECT id, key_hash, key_prefix, name, status, expires_at FROM api_keys WHERE key_hash = $1 LIMIT 1',
        [keyHash],
      );
      const row = r.rows[0];
      if (row === undefined) return null;
      return {
        keyHash: row.key_hash,
        keyPrefix: row.key_prefix,
        status: row.status,
        expiresAt:
          row.expires_at === null
            ? null
            : row.expires_at instanceof Date
              ? row.expires_at.toISOString()
              : String(row.expires_at),
      };
    },
    async touchLastUsed(keyHash) {
      await db.query('UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1', [keyHash]);
    },
    async insert(input) {
      await db.query(
        `INSERT INTO api_keys (key_hash, key_prefix, name, status, expires_at)
         VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (key_hash) DO NOTHING`,
        [input.keyHash, input.keyPrefix, input.name, input.expiresAt ?? null],
      );
    },
  };
}
