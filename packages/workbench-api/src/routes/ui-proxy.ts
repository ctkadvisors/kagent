/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Catch-all reverse proxy that forwards non-API requests to the
 * workbench-ui sidecar. The chart deploys workbench-api + workbench-ui
 * as two containers in the same Pod, with the ui sidecar listening on
 * a separate port (default 8081). The chart's Ingress sends ALL traffic
 * to the api container; this route lets a browser load `/`, `/index.html`,
 * `/assets/*` etc. by proxying to the ui sidecar over loopback.
 *
 * The contract was already documented in the chart's deployment.yaml
 * comment block ("the api container proxies non-/api requests to this
 * sidecar over loopback") + via the `WORKBENCH_UI_UPSTREAM` env var.
 * Until this file landed the contract was aspirational — non-/api
 * routes 404'd, so the UI was unreachable through the Ingress.
 *
 * Scope: read-only GET proxy. The UI bundle is static (vite emits
 * an index.html + /assets/*); POST/PUT/DELETE on the UI surface are
 * never legitimate, so we explicitly refuse them with a 405.
 *
 * What we DON'T do:
 *   - Stream-rewrite HTML (no SSR; vite SPA fallback is nginx's job).
 *   - Forward cookies / auth headers — the UI sidecar doesn't read them.
 *   - Cache responses — the UI image already sets Cache-Control on
 *     /assets/* and no-cache on index.html.
 *   - Retry on connection error — let K8s probe-driven restart handle it.
 *
 * Test injection: `fetch` is overridable so unit tests can route
 * proxied requests to a stub Response builder without going to a
 * real upstream.
 */

import { Hono } from 'hono';

export interface UiProxyDeps {
  /**
   * Loopback URL of the workbench-ui sidecar (e.g.
   * `http://127.0.0.1:8081`). The chart's deployment.yaml sets this
   * via the `WORKBENCH_UI_UPSTREAM` env var.
   */
  readonly upstream: string;
  /**
   * Test-injectable fetch impl. Defaults to global `fetch`.
   */
  readonly fetch?: typeof fetch;
}

export function uiProxyRoute(deps: UiProxyDeps): Hono {
  const app = new Hono();
  const fetchImpl = deps.fetch ?? fetch;

  // Refuse mutating methods at the UI surface — the sidecar is
  // static-file-only, and no legitimate UI code path issues these
  // against `/`-prefixed URLs.
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '*', (c) => {
    return c.json({ error: 'method-not-allowed', method: c.req.method }, 405);
  });

  app.get('*', async (c) => {
    const path = c.req.path;
    const queryIdx = c.req.url.indexOf('?');
    const query = queryIdx >= 0 ? c.req.url.slice(queryIdx) : '';
    // URL constructor: rebuild on the upstream base. The trailing-slash
    // dance avoids `new URL('foo', 'http://x:8081/')` swallowing the
    // path component when `path` is absolute (it isn't, but be defensive).
    const target = `${deps.upstream.replace(/\/$/, '')}${path}${query}`;

    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        method: 'GET',
        headers: {
          // Forward the user-agent + accept so the UI sidecar can pick a
          // sensible default (nginx returns the same body regardless,
          // but this preserves logs).
          ...(c.req.header('user-agent') !== undefined && {
            'user-agent': c.req.header('user-agent') as string,
          }),
          ...(c.req.header('accept') !== undefined && {
            accept: c.req.header('accept') as string,
          }),
          // Forward If-None-Match so nginx-alpine's etag handling can
          // 304 unchanged static assets without re-streaming bytes.
          ...(c.req.header('if-none-match') !== undefined && {
            'if-none-match': c.req.header('if-none-match') as string,
          }),
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[workbench-api] ui-proxy upstream unreachable: ${reason}`);
      return c.json({ error: 'ui-upstream-unreachable', reason }, 502);
    }

    // Pass-through the body. Hono's `Response` constructor accepts a
    // ReadableStream so we don't have to buffer the whole asset.
    const body = upstream.body;
    const init: ResponseInit = { status: upstream.status, headers: upstream.headers };
    return new Response(body, init);
  });

  return app;
}
