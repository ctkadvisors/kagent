/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { isModelEndpoint, normalizeBounds } from './model-watch.js';
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
