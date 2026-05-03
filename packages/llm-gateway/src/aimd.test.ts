/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AimdController } from './aimd.js';

describe('AimdController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds at the configured seed value', () => {
    const a = new AimdController({ seed: 2, max: 8, minSafe: 1 });
    expect(a.currentCap('m', 'http://b')).toBe(2);
  });

  it('does not increase before the cleanWindowMs has elapsed', () => {
    const a = new AimdController({ seed: 2, max: 8, minSafe: 1, cleanWindowMs: 60_000 });
    a.onSuccess('m', 'http://b', 100);
    expect(a.currentCap('m', 'http://b')).toBe(2);
  });

  it('additively increases by 1 after a clean window', () => {
    const a = new AimdController({ seed: 2, max: 8, minSafe: 1, cleanWindowMs: 60_000 });
    // First success records latency baseline
    a.onSuccess('m', 'http://b', 100);
    vi.advanceTimersByTime(61_000);
    a.onSuccess('m', 'http://b', 100);
    expect(a.currentCap('m', 'http://b')).toBe(3);
    vi.advanceTimersByTime(61_000);
    a.onSuccess('m', 'http://b', 100);
    expect(a.currentCap('m', 'http://b')).toBe(4);
  });

  it('does not increase past the max bound', () => {
    const a = new AimdController({ seed: 4, max: 5, minSafe: 1, cleanWindowMs: 1_000 });
    a.onSuccess('m', 'http://b', 100);
    vi.advanceTimersByTime(2_000);
    a.onSuccess('m', 'http://b', 100);
    expect(a.currentCap('m', 'http://b')).toBe(5);
    vi.advanceTimersByTime(2_000);
    a.onSuccess('m', 'http://b', 100);
    expect(a.currentCap('m', 'http://b')).toBe(5);
  });

  it('multiplicatively decreases on error (halves)', () => {
    const a = new AimdController({ seed: 8, max: 16, minSafe: 1 });
    a.onError('m', 'http://b');
    expect(a.currentCap('m', 'http://b')).toBe(4);
    a.onError('m', 'http://b');
    expect(a.currentCap('m', 'http://b')).toBe(2);
  });

  it('does not decrease below minSafe', () => {
    const a = new AimdController({ seed: 4, max: 8, minSafe: 2 });
    a.onError('m', 'http://b');
    expect(a.currentCap('m', 'http://b')).toBe(2);
    a.onError('m', 'http://b');
    expect(a.currentCap('m', 'http://b')).toBe(2);
  });

  it('resets clean window after an error so next increase requires another full window', () => {
    const a = new AimdController({ seed: 4, max: 8, minSafe: 1, cleanWindowMs: 60_000 });
    a.onSuccess('m', 'http://b', 100);
    vi.advanceTimersByTime(61_000);
    a.onError('m', 'http://b'); // halves to 2
    expect(a.currentCap('m', 'http://b')).toBe(2);
    // Immediately after error the window resets — first success doesn't increase
    a.onSuccess('m', 'http://b', 100);
    expect(a.currentCap('m', 'http://b')).toBe(2);
    vi.advanceTimersByTime(61_000);
    a.onSuccess('m', 'http://b', 100);
    expect(a.currentCap('m', 'http://b')).toBe(3);
  });

  it('a 2x latency-spike treated as an error (multiplicative decrease)', () => {
    const a = new AimdController({
      seed: 8,
      max: 16,
      minSafe: 1,
      cleanWindowMs: 60_000,
      latencySpikeMultiplier: 2,
    });
    // Build a baseline p50 around 100ms
    for (let i = 0; i < 10; i++) {
      a.onSuccess('m', 'http://b', 100);
    }
    expect(a.currentCap('m', 'http://b')).toBe(8);
    // 2x the p50
    a.onSuccess('m', 'http://b', 250);
    expect(a.currentCap('m', 'http://b')).toBe(4);
  });

  it('isolates per (model, endpoint) state', () => {
    const a = new AimdController({ seed: 4, max: 8, minSafe: 1 });
    a.onError('m1', 'http://b');
    expect(a.currentCap('m1', 'http://b')).toBe(2);
    expect(a.currentCap('m2', 'http://b')).toBe(4);
    expect(a.currentCap('m1', 'http://other')).toBe(4);
  });

  it('snapshot returns deterministic per-key state', () => {
    const a = new AimdController({ seed: 4, max: 8, minSafe: 1 });
    a.onError('m1', 'http://b1');
    a.onError('m2', 'http://b2');
    const snap = a.snapshot();
    expect(snap.length).toBe(2);
    expect(snap[0]).toMatchObject({ model: 'm1', endpoint: 'http://b1', cap: 2 });
    expect(snap[1]).toMatchObject({ model: 'm2', endpoint: 'http://b2', cap: 2 });
  });

  it('updateBounds re-clamps current cap to new max', () => {
    const a = new AimdController({ seed: 8, max: 16, minSafe: 1 });
    a.updateBounds('m', 'http://b', { seed: 8, max: 4, minSafe: 1 });
    expect(a.currentCap('m', 'http://b')).toBe(4);
  });
});
