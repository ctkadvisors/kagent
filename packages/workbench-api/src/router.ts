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
import { uiProxyRoute } from './routes/ui-proxy.js';

export interface RouterDeps {
  readonly cache: SnapshotCache;
  readonly broker: SseBroker;
  readonly ready: () => boolean;
  /**
   * Loopback URL of the workbench-ui sidecar. When set, non-API
   * routes proxy to it; when omitted, non-API routes 404 (which is
   * the right behavior out-of-cluster + in tests). The chart's
   * deployment.yaml sets `WORKBENCH_UI_UPSTREAM=http://127.0.0.1:8081`.
   */
  readonly uiUpstream?: string;
  /**
   * Test-injectable fetch for the UI proxy. Defaults to global fetch.
   */
  readonly proxyFetch?: typeof fetch;
}

export function buildRouter(deps: RouterDeps): Hono {
  const app = new Hono();

  // Liveness/readiness — mounted at the root. Probes hit the pod
  // port directly (not via Ingress).
  app.route('/', healthzRoute({ cache: deps.cache, ready: deps.ready }));

  // API surface — read-only GETs only in v0.1. Each route owns its
  // own /api/* prefix internally; mounting at '/' here keeps the
  // surface flat for a future SemVer-aware mount move.
  app.route('/', tasksRoute({ cache: deps.cache }));
  app.route('/', agentsRoute({ cache: deps.cache }));
  app.route('/', streamRoute({ broker: deps.broker }));

  // Reserve the API namespace before the SPA proxy catches unmatched
  // GETs. Without this, `/api/typo` can return the UI's index.html
  // with 200 because nginx's SPA fallback handles every unknown path.
  const apiNotFound = (c: import('hono').Context) =>
    c.json({ error: 'not-found', path: c.req.path }, 404);
  app.all('/api', apiNotFound);
  app.all('/api/*', apiNotFound);

  // Sidecar UI proxy — catches every non-API path the routes above
  // didn't claim. Hono's first-match-wins routing means the API
  // routes always take precedence; this proxy fields `/`,
  // `/index.html`, `/assets/*`, etc. In test mode (no upstream
  // configured), keep the JSON 404 so harnesses can still assert
  // miss behavior.
  if (deps.uiUpstream !== undefined && deps.uiUpstream.length > 0) {
    app.route(
      '/',
      uiProxyRoute({
        upstream: deps.uiUpstream,
        ...(deps.proxyFetch !== undefined && { fetch: deps.proxyFetch }),
      }),
    );
  } else {
    // No upstream — keep the JSON 404 so test harnesses can still
    // assert miss behavior, and out-of-cluster CLI tests don't try
    // to fetch a sidecar that doesn't exist.
    app.notFound((c) => c.json({ error: 'not-found', path: c.req.path }, 404));
  }

  return app;
}
