/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { computeLayout, STATIC_STRUCTURES } from './layout.js';

const BOUNDS = { width: 2000, height: 1400 };

describe('computeLayout — static structures', () => {
  it('places every STATIC_STRUCTURES entry, distinct from the gateway and each other', () => {
    const layout = computeLayout([], BOUNDS);
    for (const def of STATIC_STRUCTURES) {
      const pos = layout.structures.get(def.id);
      expect(pos).toBeDefined();
    }
    const positions = STATIC_STRUCTURES.map((d) => layout.structures.get(d.id));
    const [brain, bytebot] = positions;
    expect(brain).toBeDefined();
    expect(bytebot).toBeDefined();
    expect(brain).not.toEqual(bytebot);
    expect(brain).not.toEqual(layout.gateway);
  });

  it('is deterministic across calls with the same bounds', () => {
    const a = computeLayout([], BOUNDS);
    const b = computeLayout([], BOUNDS);
    for (const def of STATIC_STRUCTURES) {
      expect(a.structures.get(def.id)).toEqual(b.structures.get(def.id));
    }
  });

  it('is unaffected by the agent set (fixed relative to the gateway, not hash-placed)', () => {
    const withAgents = computeLayout([{ key: 'ns/a', namespace: 'ns', name: 'a' }], BOUNDS);
    const noAgents = computeLayout([], BOUNDS);
    for (const def of STATIC_STRUCTURES) {
      expect(withAgents.structures.get(def.id)).toEqual(noAgents.structures.get(def.id));
    }
  });
});
