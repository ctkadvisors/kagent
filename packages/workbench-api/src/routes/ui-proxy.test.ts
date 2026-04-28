/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { SnapshotCache } from '../cache.js';
import { buildRouter } from '../router.js';
import { SseBroker } from '../sse.js';
import { uiProxyRoute } from './ui-proxy.js';

function deps(extra: { uiUpstream?: string; proxyFetch?: typeof fetch } = {}) {
  const cache = new SnapshotCache();
  const broker = new SseBroker(cache);
  return {
    cache,
    broker,
    ready: () => true,
    // These tests target the proxy's path resolution + upstream stub
    // wiring; auth is exercised in `auth.test.ts`. Disable enforcement
    // here so requests without `X-Forwarded-User` aren't 401'd before
    // they reach the route under test.
    authRequired: false,
    ...extra,
  };
}

/* =====================================================================
 * uiProxyRoute — direct route tests (no router composition)
 * ===================================================================== */

describe('uiProxyRoute', () => {
  it('forwards GET / to the upstream and passes the body through', async () => {
    let captured: { url: string; headers: Headers } | undefined;
    const stub: typeof fetch = (input, init) => {
      captured = {
        url:
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        headers: new Headers(init?.headers ?? {}),
      };
      return Promise.resolve(
        new Response('<!doctype html><title>Workbench</title>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );
    };

    const app = uiProxyRoute({ upstream: 'http://127.0.0.1:8081', fetch: stub });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/Workbench/);
    expect(captured?.url).toBe('http://127.0.0.1:8081/');
  });

  it('forwards /assets/<hash>.js with the path + query string preserved', async () => {
    let capturedUrl = '';
    const stub: typeof fetch = (input) => {
      capturedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return Promise.resolve(new Response('console.log(1);', { status: 200 }));
    };
    const app = uiProxyRoute({ upstream: 'http://127.0.0.1:8081/', fetch: stub });
    const res = await app.request('/assets/index-abc123.js?v=1');
    expect(res.status).toBe(200);
    expect(capturedUrl).toBe('http://127.0.0.1:8081/assets/index-abc123.js?v=1');
  });

  it('forwards if-none-match so nginx can 304 unchanged assets', async () => {
    let capturedHeaders: Headers | undefined;
    const stub: typeof fetch = (_input, init) => {
      capturedHeaders = new Headers(init?.headers ?? {});
      return Promise.resolve(new Response(null, { status: 304 }));
    };
    const app = uiProxyRoute({ upstream: 'http://127.0.0.1:8081', fetch: stub });
    const res = await app.request('/assets/index-abc123.js', {
      headers: { 'if-none-match': '"abc123"' },
    });
    expect(res.status).toBe(304);
    expect(capturedHeaders?.get('if-none-match')).toBe('"abc123"');
  });

  it('refuses POST/PUT/PATCH/DELETE with 405 (UI surface is static)', async () => {
    const stub: typeof fetch = () =>
      Promise.reject(new Error('stub: should never be called for non-GET'));
    const app = uiProxyRoute({ upstream: 'http://127.0.0.1:8081', fetch: stub });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.request('/', { method });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { error: string; method: string };
      expect(body.error).toBe('method-not-allowed');
      expect(body.method).toBe(method);
    }
  });

  it('strips hop-by-hop and re-encoded framing headers from the upstream response', async () => {
    // Node fetch (undici) auto-decompresses, so a `content-encoding: gzip`
    // + `content-length` from upstream describes bytes the body no longer
    // carries. Forwarding them verbatim corrupts the response. Plus
    // `transfer-encoding`, `connection`, `keep-alive` are RFC 9110
    // hop-by-hop and must not survive the proxy.
    const stub: typeof fetch = () =>
      Promise.resolve(
        new Response('<html>ok</html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'content-encoding': 'gzip',
            'content-length': '999',
            'transfer-encoding': 'chunked',
            connection: 'keep-alive',
            'keep-alive': 'timeout=5',
            etag: '"abc"',
          },
        }),
      );
    const app = uiProxyRoute({ upstream: 'http://127.0.0.1:8081', fetch: stub });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('transfer-encoding')).toBeNull();
    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('keep-alive')).toBeNull();
    // Non-stripped headers survive.
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('etag')).toBe('"abc"');
  });

  it('returns 502 with reason when the upstream is unreachable', async () => {
    const stub: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:8081'));
    const app = uiProxyRoute({ upstream: 'http://127.0.0.1:8081', fetch: stub });
    const res = await app.request('/');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('ui-upstream-unreachable');
    expect(body.reason).toMatch(/ECONNREFUSED/);
  });
});

/* =====================================================================
 * buildRouter integration — proxy only catches non-API routes
 * ===================================================================== */

describe('buildRouter — UI proxy precedence', () => {
  it('API routes still win over the proxy when uiUpstream is set', async () => {
    const stub: typeof fetch = () =>
      Promise.reject(new Error('stub: API routes should not hit the proxy'));
    const app = buildRouter(deps({ uiUpstream: 'http://127.0.0.1:8081', proxyFetch: stub }));

    // /healthz is a real route on the api container — must not proxy.
    const health = await app.request('/healthz');
    expect(health.status).toBe(200);

    // /api/tasks is a real route — must not proxy.
    const tasks = await app.request('/api/tasks');
    expect(tasks.status).toBe(200);
  });

  it('unknown /api paths return JSON 404 instead of proxying to the SPA', async () => {
    const stub: typeof fetch = () =>
      Promise.resolve(new Response('<!doctype html>SPA', { status: 200 }));
    const app = buildRouter(deps({ uiUpstream: 'http://127.0.0.1:8081', proxyFetch: stub }));

    const res = await app.request('/api/not-real');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string; path: string };
    expect(body).toEqual({ error: 'not-found', path: '/api/not-real' });
  });

  it('bare /api returns JSON 404 instead of proxying to the SPA', async () => {
    const stub: typeof fetch = () =>
      Promise.resolve(new Response('<!doctype html>SPA', { status: 200 }));
    const app = buildRouter(deps({ uiUpstream: 'http://127.0.0.1:8081', proxyFetch: stub }));

    const res = await app.request('/api');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string; path: string };
    expect(body).toEqual({ error: 'not-found', path: '/api' });
  });

  it('non-API paths proxy to the UI upstream when configured', async () => {
    const stub: typeof fetch = () =>
      Promise.resolve(new Response('<!doctype html>OK', { status: 200 }));
    const app = buildRouter(deps({ uiUpstream: 'http://127.0.0.1:8081', proxyFetch: stub }));
    const res = await app.request('/some/spa/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/OK/);
  });

  it('falls back to JSON 404 for non-API paths when uiUpstream is unset', async () => {
    const app = buildRouter(deps());
    const res = await app.request('/index.html');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; path: string };
    expect(body.error).toBe('not-found');
    expect(body.path).toBe('/index.html');
  });
});
