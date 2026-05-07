/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { ModelIndex } from './model-index.js';
import type { ModelEndpoint } from './types.js';

function ep(
  model: string,
  overrides: Partial<ModelEndpoint['spec']> = {},
  metadataOverrides: Partial<ModelEndpoint['metadata']> = {},
): ModelEndpoint {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ModelEndpoint',
    metadata: {
      name: model.replace(/[^a-z0-9-]/g, '-'),
      namespace: 'kagent-system',
      ...metadataOverrides,
    },
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

  /* =====================================================================
   * C3-REV3-H1 (rev3) — `ModelIndex.lookup()` is the router-path read
   * site of `spec.minSafe`. The B5 fix originally clamped the value
   * only at watch time (`normalizeBounds` in `model-watch.ts`); the
   * router calls `aimd.updateBounds` with the lookup-returned value
   * on every request, which would overwrite the watch-time clamp
   * for any CR carrying `spec.minSafe: 0`. The lookup MUST itself
   * funnel through the same clamp.
   * ===================================================================== */

  it('clamps spec.minSafe=0 to 1 on lookup (C3-REV3-H1 router-path regression)', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('m', { minSafe: 0 }));
    expect(idx.lookup('m')?.minSafe).toBe(1);
  });

  it('clamps a negative spec.minSafe to 1 on lookup (C3-REV3-H1)', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('m', { minSafe: -3 }));
    expect(idx.lookup('m')?.minSafe).toBe(1);
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

  /* =====================================================================
   * M20 — collision detection. Two CRs claiming the same `spec.model`
   * must not silently replace each other; the second upsert returns
   * `kind: 'collision'` with both identities + backendUrls so the
   * informer can log a structured warning. The existing entry stays
   * authoritative.
   * ===================================================================== */

  it('upsert returns kind=applied on a fresh entry', () => {
    const idx = new ModelIndex();
    expect(idx.upsert(ep('m'))).toEqual({ kind: 'applied' });
  });

  it('upsert from the SAME CR (matching namespace/name) returns kind=applied', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('m'));
    // Same CR re-emits — informer add+update for the same metadata.
    expect(idx.upsert(ep('m'))).toEqual({ kind: 'applied' });
  });

  it('upsert from a DIFFERENT CR with the same model name returns kind=collision (M20)', () => {
    const idx = new ModelIndex();
    const first = ep('llama', { backendUrl: 'http://a:11434' }, { name: 'llama-jetson' });
    const second = ep('llama', { backendUrl: 'http://b:11434' }, { name: 'llama-mini' });
    idx.upsert(first);
    const result = idx.upsert(second);
    expect(result.kind).toBe('collision');
    if (result.kind === 'collision') {
      expect(result.reason).toBe('model-name-collision');
      expect(result.existing.name).toBe('llama-jetson');
      expect(result.existing.backendUrl).toBe('http://a:11434');
      expect(result.incoming.name).toBe('llama-mini');
      expect(result.incoming.backendUrl).toBe('http://b:11434');
    }
    // Existing entry stays authoritative — collisions don't flap routing.
    expect(idx.lookup('llama')?.endpoint.spec.backendUrl).toBe('http://a:11434');
  });

  it('upsert from a different CR in a different namespace also collides (M20)', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('llama', { backendUrl: 'http://a:11434' }, { namespace: 'ns1' }));
    const result = idx.upsert(ep('llama', { backendUrl: 'http://b:11434' }, { namespace: 'ns2' }));
    expect(result.kind).toBe('collision');
  });

  it('delete with crIdentityHint refuses to evict an entry owned by a different CR (M20)', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('llama', {}, { name: 'llama-jetson', namespace: 'kagent-system' }));
    // Now a different CR sends a delete for the same model name —
    // simulates: informer for collision-rejected CR fires its own
    // delete event after a moment. We MUST NOT tombstone the
    // surviving entry.
    idx.delete('llama', 'kagent-system/llama-mini');
    expect(idx.lookup('llama')).not.toBeNull();
    // The owning CR's delete event still works.
    idx.delete('llama', 'kagent-system/llama-jetson');
    expect(idx.lookup('llama')).toBeNull();
  });

  it('delete without crIdentityHint stays unconditional (back-compat)', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('m'));
    idx.delete('m');
    expect(idx.lookup('m')).toBeNull();
  });

  it('replaceAll silently drops collision-rejected duplicates (last-write-wins kept the first)', () => {
    const idx = new ModelIndex();
    const a = ep('llama', { backendUrl: 'http://a:11434' }, { name: 'llama-jetson' });
    const b = ep('llama', { backendUrl: 'http://b:11434' }, { name: 'llama-mini' });
    idx.replaceAll([a, b]);
    // First-seen wins (replaceAll iterates in order).
    expect(idx.lookup('llama')?.endpoint.spec.backendUrl).toBe('http://a:11434');
    expect(idx.list()).toHaveLength(1);
  });
});
