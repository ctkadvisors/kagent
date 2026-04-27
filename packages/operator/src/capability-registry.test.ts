/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { StaticCapabilityRegistry, StubCapabilityRegistry } from './capability-registry.js';

describe('StubCapabilityRegistry', () => {
  it('always returns null', async () => {
    const r = new StubCapabilityRegistry();
    expect(await r.resolveCapability('research')).toBeNull();
    expect(await r.resolveCapability('anything')).toBeNull();
  });
});

describe('StaticCapabilityRegistry', () => {
  it('resolves entries supplied at construction', async () => {
    const r = new StaticCapabilityRegistry({ research: 'researcher', summary: 'summarizer' });
    expect(await r.resolveCapability('research')).toBe('researcher');
    expect(await r.resolveCapability('summary')).toBe('summarizer');
  });

  it('returns null for unknown capabilities', async () => {
    const r = new StaticCapabilityRegistry({ research: 'researcher' });
    expect(await r.resolveCapability('unknown')).toBeNull();
  });

  it('set() adds entries dynamically', async () => {
    const r = new StaticCapabilityRegistry();
    expect(await r.resolveCapability('research')).toBeNull();
    r.set('research', 'researcher');
    expect(await r.resolveCapability('research')).toBe('researcher');
  });

  it('set() overwrites existing entries', async () => {
    const r = new StaticCapabilityRegistry({ research: 'researcher-v1' });
    r.set('research', 'researcher-v2');
    expect(await r.resolveCapability('research')).toBe('researcher-v2');
  });
});
