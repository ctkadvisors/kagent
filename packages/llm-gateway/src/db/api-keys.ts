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

/**
 * v0.1.12 — admin-list projection. The SELECT in `list()` is locked
 * to these columns ONLY (never `key_hash`, never plaintext) so a row
 * mapped through this interface is safe to ship over `/admin/keys`.
 */
interface AdminListRow {
  readonly id: string | number;
  readonly key_prefix: string;
  readonly name: string;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly model_allowlist: readonly string[] | null;
  readonly expires_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly created_at: Date | string | null;
}

export interface ApiKeyAdminRow {
  readonly id: string;
  readonly label: string;
  readonly hashPrefix: string;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly modelAllowlist: readonly string[] | null;
  /** ISO 8601 timestamp; null = no expiration set. */
  readonly expiresAt: string | null;
  /** ISO 8601 timestamp; null = key is not revoked. */
  readonly revokedAt: string | null;
  /** ISO 8601 timestamp; null preserved on legacy rows missing the column. */
  readonly createdAt: string | null;
}

export interface RevokeResult {
  /** False when no row matched the id (caller surfaces a 404). */
  readonly revoked: boolean;
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
  /**
   * v0.1.12 — same as `insert`, but returns the assigned BIGSERIAL id
   * (as a string) so the REST handler can echo it in the
   * `POST /admin/keys` response.
   */
  insertAndReturn(input: InsertApiKeyInput): Promise<{ readonly id: string }>;
  /**
   * v0.1.12 — list every API key in admin-projection shape. Plaintext
   * + key_hash are NEVER projected; only the public-safe fields land
   * on the wire.
   */
  list(): Promise<readonly ApiKeyAdminRow[]>;
  /**
   * v0.1.12 — soft-delete by id. Sets `status='revoked'` and
   * `revoked_at=NOW()`. Idempotent on already-revoked rows
   * (timestamp not overwritten if non-NULL).
   */
  revoke(id: string): Promise<RevokeResult>;
}

export interface InsertApiKeyInput {
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly name: string;
  /** ISO 8601 timestamp; absent = no expiration. */
  readonly expiresAt?: string;
  /**
   * v0.1.12 — optional per-key model scoping. Stored as a Postgres
   * TEXT[] in the `model_allowlist` column. v0.1.12 only persists;
   * enforcement defers to v0.3 capability bundles.
   */
  readonly modelAllowlist?: readonly string[];
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
        `INSERT INTO api_keys (key_hash, key_prefix, name, status, expires_at, model_allowlist)
         VALUES ($1, $2, $3, 'active', $4, $5)
         ON CONFLICT (key_hash) DO NOTHING`,
        [
          input.keyHash,
          input.keyPrefix,
          input.name,
          input.expiresAt ?? null,
          input.modelAllowlist === undefined ? null : [...input.modelAllowlist],
        ],
      );
    },
    async insertAndReturn(input) {
      const r = await db.query<{ id: string | number }>(
        `INSERT INTO api_keys (key_hash, key_prefix, name, status, expires_at, model_allowlist)
         VALUES ($1, $2, $3, 'active', $4, $5)
         RETURNING id`,
        [
          input.keyHash,
          input.keyPrefix,
          input.name,
          input.expiresAt ?? null,
          input.modelAllowlist === undefined ? null : [...input.modelAllowlist],
        ],
      );
      const row = r.rows[0];
      if (row === undefined) {
        throw new Error('insertAndReturn: INSERT did not return an id row');
      }
      return { id: String(row.id) };
    },
    async list() {
      // Locked column projection — `key_hash` MUST NEVER appear here;
      // see ApiKeyAdminRow doc.
      const r = await db.query<AdminListRow>(
        `SELECT id, key_prefix, name, status, model_allowlist, expires_at, revoked_at, created_at
         FROM api_keys
         ORDER BY id ASC`,
      );
      return r.rows.map((row) => mapAdminRow(row));
    },
    async revoke(id) {
      // COALESCE on revoked_at means re-revoke is a no-op on the
      // timestamp (preserves the original revocation moment for audit).
      const r = await db.query<{ id: string | number }>(
        `UPDATE api_keys
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
         WHERE id = $1
         RETURNING id`,
        [id],
      );
      return { revoked: r.rows.length > 0 };
    },
  };
}

function mapAdminRow(row: AdminListRow): ApiKeyAdminRow {
  return {
    id: String(row.id),
    label: row.name,
    hashPrefix: row.key_prefix,
    status: row.status,
    modelAllowlist: row.model_allowlist ?? null,
    expiresAt: toIsoOrNull(row.expires_at),
    revokedAt: toIsoOrNull(row.revoked_at),
    createdAt: toIsoOrNull(row.created_at),
  };
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
