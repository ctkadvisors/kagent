/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Composes the per-route Hono apps into a single mountable Hono
 * application. Kept separate from `server.ts` so test harnesses can
 * exercise the route surface against an in-memory cache without
 * booting a Node HTTP server.
 *
 * Auth note: this slice is unauthenticated. Header-trust integration
 * (X-Forwarded-User from the homelab Traefik+OAuth pattern) is
 * documented in `IMPLEMENTATION-NOTES.md` for the next phase.
 */

import { Hono } from 'hono';

import type { SnapshotCache } from './cache.js';
import type { SseBroker } from './sse.js';
import { agentsRoute } from './routes/agents.js';
import { healthzRoute } from './routes/healthz.js';
import { streamRoute } from './routes/stream.js';
import { tasksRoute } from './routes/tasks.js';

export interface RouterDeps {
  readonly cache: SnapshotCache;
  readonly broker: SseBroker;
  readonly ready: () => boolean;
}

export function buildRouter(deps: RouterDeps): Hono {
  const app = new Hono();

  // Liveness/readiness — mounted at the root.
  app.route('/', healthzRoute({ cache: deps.cache, ready: deps.ready }));

  // API surface — read-only GETs only in v0.1.
  app.route('/', tasksRoute({ cache: deps.cache }));
  app.route('/', agentsRoute({ cache: deps.cache }));
  app.route('/', streamRoute({ broker: deps.broker }));

  // Catch-all 404 with a JSON body so the UI doesn't have to parse HTML.
  app.notFound((c) => c.json({ error: 'not-found', path: c.req.path }, 404));

  return app;
}
