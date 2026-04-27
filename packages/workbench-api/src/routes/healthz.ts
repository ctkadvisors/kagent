/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `/healthz` and `/readyz` — Kubernetes liveness/readiness probes.
 *
 * Liveness is "the process is up and responsive" — always 200 once
 * the server has bound. Readiness is "the cache has been populated by
 * at least one informer relist" — until the relist completes a request
 * to `/api/tasks` returns an empty array, which would mislead clients
 * about the cluster being empty.
 */

import { Hono } from 'hono';

import type { SnapshotCache } from '../cache.js';

export interface HealthzDeps {
  readonly cache: SnapshotCache;
  /**
   * Returns true once at least one informer has finished its initial
   * relist. Wired from `informer.ts` in v0.2; v0.1 just returns true
   * after a short grace period via `markReady()` on app boot.
   */
  readonly ready: () => boolean;
}

export function healthzRoute(deps: HealthzDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => {
    return c.json({ status: 'ok' });
  });

  app.get('/readyz', (c) => {
    if (deps.ready()) {
      return c.json({
        status: 'ok',
        cachedTasks: deps.cache.listTasks().length,
        cachedAgents: deps.cache.listAgents().length,
      });
    }
    return c.json({ status: 'not-ready' }, 503);
  });

  return app;
}
