/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tiny forward-only migration runner. Reads `*.sql` files from a
 * directory in lexical order, applies any whose `version` (the
 * filename minus extension) hasn't been recorded in
 * `schema_migrations`, then records it.
 *
 * Idempotent: running twice no-ops on the second pass. Safe against
 * either bundled or external Postgres per spec §3.7. The Helm chart
 * runs this as a post-install / post-upgrade Job (Wave 1C scope —
 * out of this package) — but the runner itself can be invoked
 * directly via `pnpm --filter @kagent/llm-gateway start --migrate`.
 *
 * NOT covered here: rollbacks. Forward-only, gated by review.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Queryable } from './api-keys.js';

export interface MigrationFile {
  readonly version: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/** Read a directory's *.sql files into version+sql pairs, sorted by name. */
export async function loadMigrationsFromDir(dir: string): Promise<readonly MigrationFile[]> {
  const entries = await readdir(dir);
  const sqlFiles = entries.filter((e) => e.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const f of sqlFiles) {
    const sql = await readFile(join(dir, f), 'utf8');
    out.push({ version: f.replace(/\.sql$/, ''), sql });
  }
  return out;
}

/**
 * Apply all unapplied migrations. The `schema_migrations` bootstrap
 * table is created here when missing — it's the same shape as
 * 001_initial.sql defines, but redefined idempotently so a fresh DB
 * doesn't fail on the first SELECT.
 */
export async function applyMigrations(
  db: Queryable,
  migrations: readonly MigrationFile[],
): Promise<MigrationResult> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version VARCHAR(64) PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );
  const existing = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const seen = new Set(existing.rows.map((r) => r.version));

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const m of migrations) {
    if (seen.has(m.version)) {
      skipped.push(m.version);
      continue;
    }
    await db.query(m.sql);
    await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
    applied.push(m.version);
  }
  return { applied, skipped };
}
