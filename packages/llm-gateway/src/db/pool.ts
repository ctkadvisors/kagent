/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * pg Pool factory. The gateway gets the DSN at boot from
 * `DATABASE_URL` env (BYO via spec §3.7) and shares one Pool
 * across the rest of the package.
 *
 * `pg` lazily resolves env-based config when no `connectionString`
 * is given; we ALWAYS pass connectionString so the only knob is
 * `DATABASE_URL`. No PG* fallback — keeps deploys deterministic.
 */

import pg from 'pg';

export interface PoolOptions {
  readonly connectionString: string;
  /** Default 10 (single replica × ≤10 — see spec §3.7). */
  readonly max?: number;
  /** Idle timeout before the pool reclaims the conn. Default 30s. */
  readonly idleTimeoutMillis?: number;
  /** Connection timeout before fail-fast. Default 5s. */
  readonly connectionTimeoutMillis?: number;
}

export function createPool(opts: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
  });
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
