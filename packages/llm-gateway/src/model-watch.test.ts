/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { createModelEndpointWatchHealth, isModelEndpoint, normalizeBounds } from './model-watch.js';
import type { ModelEndpoint } from './types.js';

describe('isModelEndpoint', () => {
  it('accepts a well-formed ModelEndpoint object', () => {
    expect(
      isModelEndpoint({
        apiVersion: 'kagent.knuteson.io/v1alpha1',
        kind: 'ModelEndpoint',
        metadata: { name: 'm' },
        spec: {
          model: 'm',
          backendKind: 'mock',
          backendUrl: 'http://x',
          inFlight: { seed: 1, max: 4 },
        },
      }),
    ).toBe(true);
  });

  it('rejects null / non-object', () => {
    expect(isModelEndpoint(null)).toBe(false);
    expect(isModelEndpoint(undefined)).toBe(false);
    expect(isModelEndpoint('string')).toBe(false);
  });

  it('rejects when kind is wrong', () => {
    expect(
      isModelEndpoint({
        kind: 'Agent',
        spec: { model: 'm', backendKind: 'mock', backendUrl: 'x', inFlight: { seed: 1, max: 1 } },
      }),
    ).toBe(false);
  });

  it('rejects when spec missing required fields', () => {
    expect(isModelEndpoint({ kind: 'ModelEndpoint', spec: {} })).toBe(false);
    expect(
      isModelEndpoint({
        kind: 'ModelEndpoint',
        spec: { model: 'm', backendKind: 'mock', backendUrl: 'x' },
      }),
    ).toBe(false);
  });

  it('rejects when inFlight bounds wrong type', () => {
    expect(
      isModelEndpoint({
        kind: 'ModelEndpoint',
        spec: {
          model: 'm',
          backendKind: 'mock',
          backendUrl: 'x',
          inFlight: { seed: 'a', max: 1 },
        },
      }),
    ).toBe(false);
  });
});

describe('normalizeBounds (B5)', () => {
  function makeEp(minSafe: number | undefined): ModelEndpoint {
    const ep: ModelEndpoint = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'ModelEndpoint',
      metadata: { name: 'm' },
      spec: {
        model: 'm',
        backendKind: 'mock',
        backendUrl: 'http://x',
        inFlight: { seed: 2, max: 8 },
        ...(minSafe !== undefined ? { minSafe } : {}),
      },
    };
    return ep;
  }

  it('passes through a CR with minSafe >= 1 unchanged', () => {
    expect(normalizeBounds(makeEp(2))).toEqual({ seed: 2, max: 8, minSafe: 2 });
  });

  it('defaults minSafe to 1 when the CR omits the field', () => {
    expect(normalizeBounds(makeEp(undefined))).toEqual({ seed: 2, max: 8, minSafe: 1 });
  });

  // Regression — B5: a CR carrying `spec.minSafe: 0` is the watch-path
  // bypass for the workbench-api PATCH validator. Nullish-coalescing
  // alone (`?? 1`) does NOT filter `0`, so without `Math.max(1, ...)`
  // the gateway would honor the zero floor and the AIMD cap could
  // collapse to 0 permanently. This MUST clamp to 1.
  it('clamps minSafe=0 to 1 (B5 watch-path regression)', () => {
    expect(normalizeBounds(makeEp(0))).toEqual({ seed: 2, max: 8, minSafe: 1 });
  });

  it('clamps a negative minSafe to 1', () => {
    expect(normalizeBounds(makeEp(-5))).toEqual({ seed: 2, max: 8, minSafe: 1 });
  });
});

describe('ModelEndpoint watch health', () => {
  it('starts stale until the informer has successfully started', () => {
    const health = createModelEndpointWatchHealth(() => 1000);

    expect(health.isReady()).toBe(false);
    expect(health.snapshot()).toEqual({
      ready: false,
      status: 'starting',
      lastStartedAtMs: null,
      lastErrorAtMs: null,
      lastStoppedAtMs: null,
    });
  });

  it('marks the watch stale on informer error so readiness can fail closed', () => {
    const health = createModelEndpointWatchHealth(() => 1000);

    health.markStarted();
    expect(health.isReady()).toBe(true);

    health.markError(new Error('watch 403'));

    expect(health.isReady()).toBe(false);
    expect(health.snapshot()).toEqual({
      ready: false,
      status: 'stale',
      lastStartedAtMs: 1000,
      lastErrorAtMs: 1000,
      lastStoppedAtMs: null,
    });
  });

  it('returns to ready only after a successful restart', () => {
    let now = 1000;
    const health = createModelEndpointWatchHealth(() => now);

    health.markStarted();
    now = 2000;
    health.markError(new Error('watch closed'));
    now = 3000;
    health.markStarted();

    expect(health.snapshot()).toEqual({
      ready: true,
      status: 'ready',
      lastStartedAtMs: 3000,
      lastErrorAtMs: 2000,
      lastStoppedAtMs: null,
    });
  });

  it('marks the watch not ready after stop', () => {
    const health = createModelEndpointWatchHealth(() => 1000);

    health.markStarted();
    health.markStopped();

    expect(health.isReady()).toBe(false);
    expect(health.snapshot()).toEqual({
      ready: false,
      status: 'stopped',
      lastStartedAtMs: 1000,
      lastErrorAtMs: null,
      lastStoppedAtMs: 1000,
    });
  });
});
