/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  type GatewayFetchFn,
  type GatewayFetchResponse,
  type GatewayRotationOutcome,
  rotateGatewayOnce,
  scheduleGatewayRotation,
} from './gateway-rotation.js';

function fakeResponse(opts: {
  status: number;
  ok?: boolean;
  jsonBody?: unknown;
  jsonThrows?: boolean;
}): GatewayFetchResponse {
  return {
    status: opts.status,
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    json: () => {
      if (opts.jsonThrows === true) return Promise.reject(new Error('not json'));
      return Promise.resolve(opts.jsonBody);
    },
  };
}

describe('rotateGatewayOnce', () => {
  it('emits rotated outcome on 2xx with rotationId', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: { method?: string; headers?: Readonly<Record<string, string>> } | undefined;
    const fetchFn: GatewayFetchFn = (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(fakeResponse({ status: 200, jsonBody: { rotationId: 'rot-abc' } }));
    };
    const fixedNow = new Date('2026-05-04T12:00:00Z');
    const outcome = await rotateGatewayOnce({
      gatewayUrl: 'https://litellm.kagent-system.svc.cluster.local',
      adminToken: 'admin-token-xxx',
      fetch: fetchFn,
      now: () => fixedNow,
    });
    expect(outcome.kind).toBe('rotated');
    if (outcome.kind === 'rotated') {
      expect(outcome.rotationId).toBe('rot-abc');
      expect(outcome.observedAt).toBe(fixedNow);
    }
    expect(capturedUrl).toBe(
      'https://litellm.kagent-system.svc.cluster.local/v1/admin/keys/rotate',
    );
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers?.['Authorization']).toBe('Bearer admin-token-xxx');
    expect(capturedInit?.headers?.['Content-Type']).toBe('application/json');
  });

  it('emits rotated outcome on 2xx with no rotationId when body is empty/non-JSON', async () => {
    const fetchFn: GatewayFetchFn = () =>
      Promise.resolve(fakeResponse({ status: 200, jsonThrows: true }));
    const outcome = await rotateGatewayOnce({
      gatewayUrl: 'https://gw.example',
      adminToken: 'tk',
      fetch: fetchFn,
    });
    expect(outcome.kind).toBe('rotated');
    if (outcome.kind === 'rotated') {
      expect(outcome.rotationId).toBeUndefined();
    }
  });

  it('emits unsupported outcome on 404 (graceful no-op)', async () => {
    const fetchFn: GatewayFetchFn = () => Promise.resolve(fakeResponse({ status: 404, ok: false }));
    const outcome = await rotateGatewayOnce({
      gatewayUrl: 'https://gw.example',
      adminToken: 'tk',
      fetch: fetchFn,
    });
    expect(outcome.kind).toBe('unsupported');
    if (outcome.kind === 'unsupported') {
      expect(outcome.status).toBe(404);
    }
  });

  it('emits transient_error on non-2xx, non-404 status', async () => {
    const fetchFn: GatewayFetchFn = () => Promise.resolve(fakeResponse({ status: 503, ok: false }));
    const outcome = await rotateGatewayOnce({
      gatewayUrl: 'https://gw.example',
      adminToken: 'tk',
      fetch: fetchFn,
    });
    expect(outcome.kind).toBe('transient_error');
    if (outcome.kind === 'transient_error') {
      expect(outcome.reason).toBe('gateway_status_503');
    }
  });

  it('emits transient_error on network failure (never throws)', async () => {
    const fetchFn: GatewayFetchFn = () => Promise.reject(new Error('ECONNREFUSED'));
    const outcome = await rotateGatewayOnce({
      gatewayUrl: 'https://gw.example',
      adminToken: 'tk',
      fetch: fetchFn,
    });
    expect(outcome.kind).toBe('transient_error');
    if (outcome.kind === 'transient_error') {
      expect(outcome.reason).toBe('ECONNREFUSED');
    }
  });

  it('strips trailing slash from gatewayUrl before appending the rotation path', async () => {
    let capturedUrl: string | undefined;
    const fetchFn: GatewayFetchFn = (url) => {
      capturedUrl = url;
      return Promise.resolve(fakeResponse({ status: 200, jsonBody: {} }));
    };
    await rotateGatewayOnce({
      gatewayUrl: 'https://gw.example/',
      adminToken: 'tk',
      fetch: fetchFn,
    });
    expect(capturedUrl).toBe('https://gw.example/v1/admin/keys/rotate');
  });
});

describe('scheduleGatewayRotation', () => {
  it('runs an initial tick on boot then stops cleanly', async () => {
    const outcomes: GatewayRotationOutcome[] = [];
    const fetchFn: GatewayFetchFn = () =>
      Promise.resolve(fakeResponse({ status: 200, jsonBody: { rotationId: 'r1' } }));
    const handle = scheduleGatewayRotation({
      gatewayUrl: 'https://gw.example',
      adminToken: 'tk',
      intervalMs: 60_000,
      fetch: fetchFn,
      onOutcome: (o) => {
        outcomes.push(o);
      },
    });
    // Allow the initial tick + onOutcome microtasks to drain.
    await new Promise((resolve) => setTimeout(resolve, 10));
    handle.stop();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('rotated');
  });

  it('skipInitialTick=true defers the first call to interval-elapsed', async () => {
    const outcomes: GatewayRotationOutcome[] = [];
    const fetchFn: GatewayFetchFn = () =>
      Promise.resolve(fakeResponse({ status: 200, jsonBody: {} }));
    const handle = scheduleGatewayRotation({
      gatewayUrl: 'https://gw.example',
      adminToken: 'tk',
      intervalMs: 60_000,
      fetch: fetchFn,
      skipInitialTick: true,
      onOutcome: (o) => {
        outcomes.push(o);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    handle.stop();
    expect(outcomes).toHaveLength(0);
  });

  it('still cleanly stops when onOutcome throws', async () => {
    const fetchFn: GatewayFetchFn = () =>
      Promise.resolve(fakeResponse({ status: 200, jsonBody: {} }));
    const handle = scheduleGatewayRotation({
      gatewayUrl: 'https://gw.example',
      adminToken: 'tk',
      intervalMs: 60_000,
      fetch: fetchFn,
      onOutcome: () => {
        throw new Error('downstream-broken');
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    handle.stop();
    // No assertion needed beyond "didn't crash"; presence of the test
    // confirms graceful-fail-open contract.
    expect(true).toBe(true);
  });
});
