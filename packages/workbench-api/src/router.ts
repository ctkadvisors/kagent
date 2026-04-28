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
 * Auth: header-trust (X-Forwarded-User from Traefik forward-auth). See
 * `auth.ts` — fail-closed by default; only `WORKBENCH_AUTH_REQUIRED=false`
 * disables enforcement. `/healthz` and `/readyz` always bypass the
 * middleware so kubelet probes work regardless of upstream shim health.
 */

import { Hono } from 'hono';

import { buildAuthMiddleware } from './auth.js';
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
  /**
   * When true (default), all routes other than `/healthz` and
   * `/readyz` require an `X-Forwarded-User` header. Setting this to
   * false disables enforcement (header still threaded through to
   * handlers when present). Resolve from `WORKBENCH_AUTH_REQUIRED`
   * via `resolveAuthRequired()` in `auth.ts`.
   */
  readonly authRequired?: boolean;
}

export function buildRouter(deps: RouterDeps): Hono {
  const app = new Hono();

  // Auth middleware — runs FIRST so unauthenticated requests never
  // reach the route handlers. The middleware itself short-circuits on
  // /healthz and /readyz, so probes always pass.
  const authRequired = deps.authRequired ?? true;
  app.use('*', buildAuthMiddleware({ required: authRequired }));

  // Liveness/readiness — mounted at the root. Probes hit the pod
  // port directly (not via Ingress).
  app.route('/', healthzRoute({ cache: deps.cache, ready: deps.ready }));

  // API surface — read-only GETs only in v0.1. Each route owns its
  // own /api/* prefix internally; mounting at '/' here keeps the
  // surface flat for a future SemVer-aware mount move.
  app.route('/', tasksRoute({ cache: deps.cache }));
  app.route('/', agentsRoute({ cache: deps.cache }));
  app.route('/', streamRoute({ broker: deps.broker }));

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
