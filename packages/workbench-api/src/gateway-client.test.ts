/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { createGatewayClient } from './gateway-client.js';

function fakeFetch(impl: (url: string, init: RequestInit) => Response): typeof fetch {
  return vi.fn((url: string, init: RequestInit) =>
    Promise.resolve(impl(url, init)),
  ) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createGatewayClient', () => {
  describe('capacity()', () => {
    it('GETs /admin/capacity with bearer auth + parses rows', async () => {
      const fetchSpy = fakeFetch((url, init) => {
        expect(url).toBe('http://gw:4000/admin/capacity');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer admin-token');
        expect((init.headers as Record<string, string>).accept).toBe('application/json');
        return jsonResponse(200, {
          rows: [
            {
              model: '@cf/scout',
              endpoint: 'https://gw.cf/v1',
              backendKind: 'cloudflare',
              inFlight: 1,
              currentCap: 4,
              seed: 2,
              max: 8,
              minSafe: 1,
              recentP50Ms: 230,
            },
          ],
        });
      });
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 'admin-token',
        fetch: fetchSpy,
      });
      const rows = await client.capacity();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.model).toBe('@cf/scout');
      expect(rows[0]?.currentCap).toBe(4);
    });

    it('strips trailing slashes from baseUrl', async () => {
      const fetchSpy = fakeFetch((url) => {
        expect(url).toBe('http://gw:4000/admin/capacity');
        return jsonResponse(200, { rows: [] });
      });
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000///',
        adminToken: 't',
        fetch: fetchSpy,
      });
      await client.capacity();
    });

    it('returns empty array when gateway responds with no rows', async () => {
      const fetchSpy = fakeFetch(() => jsonResponse(200, {}));
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 't',
        fetch: fetchSpy,
      });
      expect(await client.capacity()).toEqual([]);
    });

    it('throws when gateway returns non-2xx', async () => {
      const fetchSpy = fakeFetch(
        () => new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
      );
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 't',
        fetch: fetchSpy,
      });
      await expect(client.capacity()).rejects.toThrow(/HTTP 500/);
    });
  });

  describe('usage()', () => {
    it('encodes query params + parses rows', async () => {
      const fetchSpy = fakeFetch((url) => {
        expect(url).toBe(
          'http://gw:4000/admin/usage?limit=10&since=2026-05-06T00%3A00%3A00Z&model=%40cf%2Fscout',
        );
        return jsonResponse(200, {
          rows: [
            {
              requestId: 'req-1',
              model: '@cf/scout',
              backend: 'cloudflare',
              backendUrl: 'https://gw.cf/v1',
              inputTokens: 100,
              outputTokens: 20,
              latencyMs: 230,
              statusCode: 200,
              streaming: false,
            },
          ],
        });
      });
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 't',
        fetch: fetchSpy,
      });
      const rows = await client.usage({
        limit: 10,
        since: '2026-05-06T00:00:00Z',
        model: '@cf/scout',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.statusCode).toBe(200);
    });

    it('omits query string when no params given', async () => {
      const fetchSpy = fakeFetch((url) => {
        expect(url).toBe('http://gw:4000/admin/usage');
        return jsonResponse(200, { rows: [] });
      });
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 't',
        fetch: fetchSpy,
      });
      await client.usage({});
    });

    it('returns empty array when rows missing or non-array', async () => {
      const fetchSpy = fakeFetch(() => jsonResponse(200, { rows: 'not-an-array' }));
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 't',
        fetch: fetchSpy,
      });
      expect(await client.usage({})).toEqual([]);
    });

    /* =====================================================================
     * M15 — workbench projection scrubs secrets from `errorMessage` before
     * the row leaves workbench-api on the wire. Defense-in-depth: H15
     * already scrubs at the gateway recorder; this catches legacy rows
     * persisted before H15 landed and any reader path that bypasses the
     * gateway recorder.
     * ===================================================================== */

    it('scrubs sk- API keys from errorMessage in usage rows (M15)', async () => {
      const fetchSpy = fakeFetch(() =>
        jsonResponse(200, {
          rows: [
            {
              requestId: 'r-1',
              model: 'm',
              backend: 'openai',
              backendUrl: 'https://api.openai.com',
              inputTokens: 0,
              outputTokens: 0,
              latencyMs: 10,
              statusCode: 401,
              streaming: false,
              errorMessage: 'Incorrect API key provided: sk-abcdefghijklmnop1234',
            },
          ],
        }),
      );
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 't',
        fetch: fetchSpy,
      });
      const rows = await client.usage({});
      expect(rows[0]?.errorMessage).toBeDefined();
      expect(rows[0]?.errorMessage).toContain('[REDACTED]');
      expect(rows[0]?.errorMessage).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    });

    it('preserves null errorMessage unchanged (M15)', async () => {
      const fetchSpy = fakeFetch(() =>
        jsonResponse(200, {
          rows: [
            {
              requestId: 'r-1',
              model: 'm',
              backend: 'mock',
              backendUrl: 'http://x',
              inputTokens: 0,
              outputTokens: 0,
              latencyMs: 1,
              statusCode: 200,
              streaming: false,
              errorMessage: null,
            },
          ],
        }),
      );
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 't',
        fetch: fetchSpy,
      });
      const rows = await client.usage({});
      expect(rows[0]?.errorMessage).toBe(null);
    });

    it('does not allocate a new row when errorMessage is unchanged (M15 fast-path)', async () => {
      const original = {
        requestId: 'r-1',
        model: 'm',
        backend: 'mock',
        backendUrl: 'http://x',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 1,
        statusCode: 200,
        streaming: false,
        errorMessage: 'just a timeout, no secret here',
      };
      const fetchSpy = fakeFetch(() => jsonResponse(200, { rows: [original] }));
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 't',
        fetch: fetchSpy,
      });
      const rows = await client.usage({});
      expect(rows[0]?.errorMessage).toBe('just a timeout, no secret here');
    });
  });

  describe('providerDispatch()', () => {
    it('GETs /admin/provider-dispatch with bearer auth', async () => {
      const fetchSpy = fakeFetch((url, init) => {
        expect(url).toBe('http://gw:4000/admin/provider-dispatch');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer admin-token');
        return jsonResponse(200, { providerDispatchDisabled: true });
      });
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 'admin-token',
        fetch: fetchSpy,
      });

      await expect(client.providerDispatch()).resolves.toEqual({
        providerDispatchDisabled: true,
      });
    });

    it('PATCHes /admin/provider-dispatch with the desired disabled state', async () => {
      const fetchSpy = fakeFetch((url, init) => {
        expect(url).toBe('http://gw:4000/admin/provider-dispatch');
        expect(init.method).toBe('PATCH');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer admin-token');
        expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
        expect(JSON.parse(init.body as string)).toEqual({ disabled: true });
        return jsonResponse(200, { providerDispatchDisabled: true });
      });
      const client = createGatewayClient({
        baseUrl: 'http://gw:4000',
        adminToken: 'admin-token',
        fetch: fetchSpy,
      });

      await expect(client.setProviderDispatchDisabled(true)).resolves.toEqual({
        providerDispatchDisabled: true,
      });
    });
  });
});
