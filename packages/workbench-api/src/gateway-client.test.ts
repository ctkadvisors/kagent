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
  });
});
