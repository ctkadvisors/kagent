/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { InFlightCounter } from './inflight-counter.js';

describe('InFlightCounter', () => {
  it('starts at zero for an unknown key', () => {
    const c = new InFlightCounter();
    expect(c.current('m', 'http://b')).toBe(0);
  });

  it('increments and decrements', () => {
    const c = new InFlightCounter();
    c.acquire('m', 'http://b');
    c.acquire('m', 'http://b');
    expect(c.current('m', 'http://b')).toBe(2);
    c.release('m', 'http://b');
    expect(c.current('m', 'http://b')).toBe(1);
  });

  it('release below zero clamps at zero (idempotent)', () => {
    const c = new InFlightCounter();
    c.release('m', 'http://b');
    expect(c.current('m', 'http://b')).toBe(0);
  });

  it('isolates counts per (model, endpoint) tuple', () => {
    const c = new InFlightCounter();
    c.acquire('m1', 'http://b1');
    c.acquire('m1', 'http://b2');
    c.acquire('m2', 'http://b1');
    expect(c.current('m1', 'http://b1')).toBe(1);
    expect(c.current('m1', 'http://b2')).toBe(1);
    expect(c.current('m2', 'http://b1')).toBe(1);
  });

  it('handles 100 parallel increments without losing any', async () => {
    const c = new InFlightCounter();
    await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve().then(() => c.acquire('m', 'http://b'))),
    );
    expect(c.current('m', 'http://b')).toBe(100);
  });

  it('handles interleaved acquire/release without drift', async () => {
    const c = new InFlightCounter();
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        Promise.resolve().then(() => {
          c.acquire('m', 'http://b');
          if (i % 2 === 0) c.release('m', 'http://b');
        }),
      ),
    );
    expect(c.current('m', 'http://b')).toBe(100);
  });

  it('snapshot returns a copy of all (key, count) entries', () => {
    const c = new InFlightCounter();
    c.acquire('m1', 'http://b1');
    c.acquire('m1', 'http://b1');
    c.acquire('m2', 'http://b2');
    const snap = c.snapshot();
    expect(snap).toEqual([
      { model: 'm1', endpoint: 'http://b1', inFlight: 2 },
      { model: 'm2', endpoint: 'http://b2', inFlight: 1 },
    ]);
  });
});
