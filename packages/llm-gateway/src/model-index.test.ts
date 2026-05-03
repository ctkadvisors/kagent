/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { ModelIndex } from './model-index.js';
import type { ModelEndpoint } from './types.js';

function ep(model: string, overrides: Partial<ModelEndpoint['spec']> = {}): ModelEndpoint {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ModelEndpoint',
    metadata: { name: model.replace(/[^a-z0-9-]/g, '-') },
    spec: {
      model,
      backendKind: 'ollama',
      backendUrl: 'http://o:11434',
      inFlight: { seed: 2, max: 8 },
      ...overrides,
    },
  };
}

describe('ModelIndex', () => {
  it('lookup returns null for unknown model', () => {
    const idx = new ModelIndex();
    expect(idx.lookup('nope')).toBeNull();
  });

  it('upsert + lookup returns the registered endpoint and resolved bounds', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('llama3.2:1b'));
    const r = idx.lookup('llama3.2:1b');
    expect(r?.endpoint.spec.backendKind).toBe('ollama');
    expect(r?.seed).toBe(2);
    expect(r?.max).toBe(8);
    expect(r?.minSafe).toBe(1);
  });

  it('respects spec.minSafe override', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('m', { minSafe: 2 }));
    expect(idx.lookup('m')?.minSafe).toBe(2);
  });

  it('replaceAll wipes prior entries before writing new ones', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('a'));
    idx.upsert(ep('b'));
    idx.replaceAll([ep('c')]);
    expect(idx.lookup('a')).toBeNull();
    expect(idx.lookup('b')).toBeNull();
    expect(idx.lookup('c')?.seed).toBe(2);
    expect(idx.list()).toHaveLength(1);
  });

  it('delete removes a single entry', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('a'));
    idx.upsert(ep('b'));
    idx.delete('a');
    expect(idx.lookup('a')).toBeNull();
    expect(idx.lookup('b')).not.toBeNull();
  });
});
