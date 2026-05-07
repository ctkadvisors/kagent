/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';
import type { CustomObjectsApi } from '@kubernetes/client-node';

import type { GatewayClient } from '../gateway-client.js';
import { buildModelEndpointMergePatch, gatewayRoute, parsePatchInFlightBody } from './gateway.js';

function makeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    capacity: vi.fn(() => Promise.resolve([])),
    usage: vi.fn(() => Promise.resolve([])),
    ...overrides,
  };
}

function makeRequest(method: string, url: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://test${url}`, init);
}

describe('parsePatchInFlightBody', () => {
  it('accepts seed-only', () => {
    expect(parsePatchInFlightBody({ seed: 4 })).toEqual({ seed: 4 });
  });

  it('accepts max-only', () => {
    expect(parsePatchInFlightBody({ max: 16 })).toEqual({ max: 16 });
  });

  it('accepts minSafe-only', () => {
    expect(parsePatchInFlightBody({ minSafe: 2 })).toEqual({ minSafe: 2 });
  });

  it('accepts all three', () => {
    expect(parsePatchInFlightBody({ seed: 4, max: 16, minSafe: 2 })).toEqual({
      seed: 4,
      max: 16,
      minSafe: 2,
    });
  });

  it('rejects empty body', () => {
    expect(() => parsePatchInFlightBody({})).toThrow(/at least one/);
  });

  it('rejects non-object body', () => {
    expect(() => parsePatchInFlightBody(null)).toThrow(/JSON object/);
    expect(() => parsePatchInFlightBody(42)).toThrow(/JSON object/);
    expect(() => parsePatchInFlightBody([])).toThrow(/JSON object/);
  });

  it('rejects out-of-range seed', () => {
    expect(() => parsePatchInFlightBody({ seed: 0 })).toThrow(/seed/);
    expect(() => parsePatchInFlightBody({ seed: 257 })).toThrow(/seed/);
    expect(() => parsePatchInFlightBody({ seed: -1 })).toThrow(/seed/);
  });

  it('rejects non-integer values', () => {
    expect(() => parsePatchInFlightBody({ seed: 1.5 })).toThrow(/seed/);
    expect(() => parsePatchInFlightBody({ max: 'eight' })).toThrow(/max/);
  });

  it('rejects out-of-range max', () => {
    expect(() => parsePatchInFlightBody({ max: 0 })).toThrow(/max/);
    expect(() => parsePatchInFlightBody({ max: 1025 })).toThrow(/max/);
  });

  it('rejects out-of-range minSafe', () => {
    expect(() => parsePatchInFlightBody({ minSafe: -1 })).toThrow(/minSafe/);
    expect(() => parsePatchInFlightBody({ minSafe: 257 })).toThrow(/minSafe/);
  });

  // Regression — B5: PATCH with `minSafe: 0` is a permanent-DoS one-shot
  // (AIMD halves cap, and `Math.max(0, floor(cap/2))` clamps at 0
  // indefinitely once the cap reaches 0). The PATCH route MUST reject
  // it; the watch-time clamp in model-watch.ts catches a CR-edited
  // bypass.
  it('rejects minSafe=0 (B5 regression)', () => {
    expect(() => parsePatchInFlightBody({ minSafe: 0 })).toThrow(/minSafe/);
  });

  it('accepts minSafe=1 as the lowest legal value', () => {
    expect(parsePatchInFlightBody({ minSafe: 1 })).toEqual({ minSafe: 1 });
  });

  it('rejects seed > max', () => {
    expect(() => parsePatchInFlightBody({ seed: 16, max: 8 })).toThrow(/must be ≤ max/);
  });

  it('accepts seed === max', () => {
    expect(parsePatchInFlightBody({ seed: 4, max: 4 })).toEqual({ seed: 4, max: 4 });
  });
});

describe('buildModelEndpointMergePatch', () => {
  it('builds inFlight-only patch when minSafe omitted', () => {
    expect(buildModelEndpointMergePatch({ seed: 4, max: 16 })).toEqual({
      spec: { inFlight: { seed: 4, max: 16 } },
    });
  });

  it('builds top-level minSafe + inFlight when all three set', () => {
    expect(buildModelEndpointMergePatch({ seed: 4, max: 16, minSafe: 2 })).toEqual({
      spec: { inFlight: { seed: 4, max: 16 }, minSafe: 2 },
    });
  });

  it('builds minSafe-only patch with empty inFlight', () => {
    expect(buildModelEndpointMergePatch({ minSafe: 2 })).toEqual({
      spec: { inFlight: {}, minSafe: 2 },
    });
  });

  it('builds seed-only patch (no max in inFlight)', () => {
    expect(buildModelEndpointMergePatch({ seed: 4 })).toEqual({
      spec: { inFlight: { seed: 4 } },
    });
  });
});

describe('GET /api/gateway/capacity', () => {
  it('503s when gatewayClient unconfigured', async () => {
    const app = gatewayRoute({});
    const res = await app.request(makeRequest('GET', '/api/gateway/capacity'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('gateway-client-not-configured');
  });

  it('returns rows + fetchedAt timestamp', async () => {
    const client = makeClient({
      capacity: vi.fn(() =>
        Promise.resolve([
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
        ]),
      ),
    });
    const app = gatewayRoute({ gatewayClient: client });
    const res = await app.request(makeRequest('GET', '/api/gateway/capacity'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; fetchedAt: string };
    expect(body.rows).toHaveLength(1);
    expect(body.fetchedAt).toMatch(/T.*Z$/);
  });

  it('502s when gateway client throws', async () => {
    const client = makeClient({
      capacity: vi.fn(() => Promise.reject(new Error('gateway down'))),
    });
    const app = gatewayRoute({ gatewayClient: client });
    const res = await app.request(makeRequest('GET', '/api/gateway/capacity'));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('gateway-unreachable');
    expect(body.message).toMatch(/gateway down/);
  });

  it('enriches rows with CR name+namespace via the K8s join', async () => {
    const client = makeClient({
      capacity: vi.fn(() =>
        Promise.resolve([
          {
            model: 'nemotron-3-nano:4b',
            endpoint: 'http://192.168.68.73:11434',
            backendKind: 'ollama',
            inFlight: 0,
            currentCap: 4,
            seed: 1,
            max: 4,
            minSafe: 1,
            recentP50Ms: null,
          },
          {
            model: 'workers-ai/@cf/meta/scout',
            endpoint: 'https://gw.cf/v1/abc/homelab/compat',
            backendKind: 'cloudflare',
            inFlight: 1,
            currentCap: 8,
            seed: 2,
            max: 8,
            minSafe: 1,
            recentP50Ms: 230,
          },
        ]),
      ),
    });
    const customApi = {
      listClusterCustomObject: vi.fn(() =>
        Promise.resolve({
          items: [
            {
              metadata: { name: 'nemotron-jetson', namespace: 'kagent-system' },
              spec: {
                model: 'nemotron-3-nano:4b',
                backendUrl: 'http://192.168.68.73:11434',
              },
            },
            {
              metadata: { name: 'workers-ai-llama-4-scout', namespace: 'kagent-system' },
              spec: {
                model: 'workers-ai/@cf/meta/scout',
                backendUrl: 'https://gw.cf/v1/abc/homelab/compat',
              },
            },
          ],
        }),
      ),
    } as unknown as CustomObjectsApi;
    const app = gatewayRoute({ gatewayClient: client, customApi });
    const res = await app.request(makeRequest('GET', '/api/gateway/capacity'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ model: string; crName?: string; crNamespace?: string }>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]?.crName).toBe('nemotron-jetson');
    expect(body.rows[0]?.crNamespace).toBe('kagent-system');
    expect(body.rows[1]?.crName).toBe('workers-ai-llama-4-scout');
  });

  it('falls back to gateway-only rows when K8s list fails', async () => {
    const client = makeClient({
      capacity: vi.fn(() =>
        Promise.resolve([
          {
            model: 'm',
            endpoint: 'u',
            backendKind: 'ollama',
            inFlight: 0,
            currentCap: 1,
            seed: 1,
            max: 1,
            minSafe: 1,
            recentP50Ms: null,
          },
        ]),
      ),
    });
    const customApi = {
      listClusterCustomObject: vi.fn(() => Promise.reject(new Error('rbac denied'))),
    } as unknown as CustomObjectsApi;
    const app = gatewayRoute({ gatewayClient: client, customApi });
    const res = await app.request(makeRequest('GET', '/api/gateway/capacity'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ model: string; crName?: string }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.crName).toBeUndefined();
  });
});

describe('GET /api/gateway/usage', () => {
  it('503s when gatewayClient unconfigured', async () => {
    const app = gatewayRoute({});
    const res = await app.request(makeRequest('GET', '/api/gateway/usage'));
    expect(res.status).toBe(503);
  });

  it('threads query params into the client call', async () => {
    const usage = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ usage });
    const app = gatewayRoute({ gatewayClient: client });
    await app.request(
      makeRequest(
        'GET',
        '/api/gateway/usage?limit=25&since=2026-05-06T00%3A00%3A00Z&model=%40cf%2Fscout',
      ),
    );
    expect(usage).toHaveBeenCalledWith({
      limit: 25,
      since: '2026-05-06T00:00:00Z',
      model: '@cf/scout',
    });
  });

  it('omits limit when invalid (negative or non-numeric)', async () => {
    const usage = vi.fn(() => Promise.resolve([]));
    const client = makeClient({ usage });
    const app = gatewayRoute({ gatewayClient: client });
    await app.request(makeRequest('GET', '/api/gateway/usage?limit=oops'));
    expect(usage).toHaveBeenCalledWith({});
  });
});

describe('PATCH /api/modelendpoints/:namespace/:name', () => {
  function fakeApi(): {
    api: CustomObjectsApi;
    patches: ReturnType<typeof vi.fn>;
    setError: (err: { code?: number; message?: string }) => void;
  } {
    let nextError: { code?: number; message?: string } | null = null;
    const patches = vi.fn(() => {
      if (nextError !== null) {
        const e = new Error(nextError.message ?? 'k8s error') as Error & { code?: number };
        if (nextError.code !== undefined) e.code = nextError.code;
        throw e;
      }
      return Promise.resolve(undefined);
    });
    const api = {
      patchNamespacedCustomObject: patches,
    } as unknown as CustomObjectsApi;
    return {
      api,
      patches,
      setError: (err) => {
        nextError = err;
      },
    };
  }

  it('503s when customApi unconfigured (write surface off)', async () => {
    const app = gatewayRoute({});
    const res = await app.request(
      makeRequest('PATCH', '/api/modelendpoints/kagent-system/foo', { seed: 4 }),
    );
    expect(res.status).toBe(503);
  });

  it('503s when customApi present but writesEnabled is false', async () => {
    const fixture = fakeApi();
    const app = gatewayRoute({ customApi: fixture.api, writesEnabled: false });
    const res = await app.request(
      makeRequest('PATCH', '/api/modelendpoints/kagent-system/foo', { seed: 4 }),
    );
    expect(res.status).toBe(503);
    expect(fixture.patches).not.toHaveBeenCalled();
  });

  it('400s on invalid body', async () => {
    const fixture = fakeApi();
    const app = gatewayRoute({ customApi: fixture.api, writesEnabled: true });
    const res = await app.request(
      makeRequest('PATCH', '/api/modelendpoints/kagent-system/foo', { seed: 0 }),
    );
    expect(res.status).toBe(400);
  });

  it('PATCHes the CR via merge-patch and returns ok', async () => {
    const fixture = fakeApi();
    const app = gatewayRoute({ customApi: fixture.api, writesEnabled: true });
    const res = await app.request(
      makeRequest('PATCH', '/api/modelendpoints/kagent-system/workers-ai-llama', {
        seed: 4,
        max: 16,
      }),
    );
    expect(res.status).toBe(200);
    expect(fixture.patches).toHaveBeenCalledTimes(1);
    const arg = fixture.patches.mock.calls[0]?.[0] as {
      group: string;
      version: string;
      namespace: string;
      plural: string;
      name: string;
      body: unknown;
    };
    expect(arg.group).toBe('kagent.knuteson.io');
    expect(arg.version).toBe('v1alpha1');
    expect(arg.namespace).toBe('kagent-system');
    expect(arg.plural).toBe('modelendpoints');
    expect(arg.name).toBe('workers-ai-llama');
    expect(arg.body).toEqual({ spec: { inFlight: { seed: 4, max: 16 } } });
  });

  it('404s when K8s reports CR not found', async () => {
    const fixture = fakeApi();
    fixture.setError({ code: 404, message: 'not found' });
    const app = gatewayRoute({ customApi: fixture.api, writesEnabled: true });
    const res = await app.request(
      makeRequest('PATCH', '/api/modelendpoints/kagent-system/missing', { seed: 4 }),
    );
    expect(res.status).toBe(404);
  });

  it('500s on other K8s errors', async () => {
    const fixture = fakeApi();
    fixture.setError({ code: 500, message: 'internal' });
    const app = gatewayRoute({ customApi: fixture.api, writesEnabled: true });
    const res = await app.request(
      makeRequest('PATCH', '/api/modelendpoints/kagent-system/foo', { seed: 4 }),
    );
    expect(res.status).toBe(500);
  });
});
