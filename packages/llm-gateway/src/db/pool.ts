/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * pg Pool factory. The gateway accepts EITHER a libpq DSN (back-compat
 * BYO-Postgres path) OR a split-credential struct (audit B7 — bundled
 * Postgres path). Split wins when both are configured; the entrypoint
 * (`main.ts`) selects which one based on `parseEnv` output.
 *
 * Why split is the audit-B7 win: the bundled chart used to render a
 * `stringData.dsn` Secret with the cleartext password embedded right
 * next to the DSN string with `sslmode=disable`. ANY entity with
 * `secrets:get` on the namespace would trivially read the Postgres
 * password. The split-credential path mounts user/password/host/port/
 * database as INDEPENDENT Secret keys via `secretKeyRef` and lets the
 * gateway construct `pg.Pool` config locally — no plaintext DSN
 * stringification anywhere.
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';

import type { DatabaseConnConfig } from '../env.js';

export interface PoolOptions {
  /** Legacy DSN path. Mutually exclusive with `connConfig`. */
  readonly connectionString?: string;
  /** Audit-B7 split-credential path. Mutually exclusive with `connectionString`. */
  readonly connConfig?: DatabaseConnConfig;
  /** Default 10 (single replica × ≤10 — see spec §3.7). */
  readonly max?: number;
  /** Idle timeout before the pool reclaims the conn. Default 30s. */
  readonly idleTimeoutMillis?: number;
  /** Connection timeout before fail-fast. Default 5s. */
  readonly connectionTimeoutMillis?: number;
}

export function createPool(opts: PoolOptions): pg.Pool {
  const baseConfig: pg.PoolConfig = {
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
  };
  if (opts.connConfig !== undefined) {
    return new pg.Pool({
      ...baseConfig,
      host: opts.connConfig.host,
      port: opts.connConfig.port,
      user: opts.connConfig.user,
      password: opts.connConfig.password,
      database: opts.connConfig.database,
      ssl: buildSslOption(opts.connConfig),
    });
  }
  if (opts.connectionString === undefined || opts.connectionString.length === 0) {
    throw new Error('createPool: one of connectionString OR connConfig is required');
  }
  return new pg.Pool({
    ...baseConfig,
    connectionString: opts.connectionString,
  });
}

/**
 * Project the split-credential `sslMode` into pg's `ssl` Pool option.
 *
 * Mapping mirrors libpq:
 *   disable      → ssl: false (plaintext)
 *   allow|prefer → ssl: { rejectUnauthorized: false } (opportunistic)
 *   require      → ssl: { rejectUnauthorized: false } (TLS without
 *                  CA verification — second-best vs verify-*)
 *   verify-ca    → ssl: { rejectUnauthorized: true, ca: <bundle> }
 *                  (TLS with CA-chain validation, hostname not checked)
 *   verify-full  → ssl: { rejectUnauthorized: true, ca: <bundle> }
 *                  (TLS with CA-chain AND hostname validation)
 *
 * pg's Node TLS layer doesn't expose libpq's `verify-ca` vs
 * `verify-full` distinction directly — both map to
 * `rejectUnauthorized: true` with hostname validation enabled by
 * default. To get the libpq `verify-ca` semantics (skip hostname
 * check) we'd need `checkServerIdentity: () => undefined`; we
 * deliberately do NOT enable that without an explicit env opt-in,
 * since accidentally disabling hostname validation is a footgun.
 */
function buildSslOption(cfg: DatabaseConnConfig): pg.PoolConfig['ssl'] {
  if (cfg.sslMode === 'disable') return false;
  const ca = cfg.sslRootCertPath !== undefined ? readFileSync(cfg.sslRootCertPath) : undefined;
  if (cfg.sslMode === 'verify-full' || cfg.sslMode === 'verify-ca') {
    return ca !== undefined ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  }
  // require / prefer / allow — TLS-on but without CA-chain enforcement.
  // Documented as second-best in the chart README.
  return { rejectUnauthorized: false };
}

/**
 * Run a one-shot SELECT 1 against the pool. Used by /readyz to
 * surface DB unreachability as a 503 rather than letting the next
 * /v1/chat/completions surface a less-actionable 500.
 */
export async function pingPool(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
