/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { isModelEndpoint } from './model-watch.js';

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
