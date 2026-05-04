/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { GatewayInFlightCounter, checkGatewayInFlight } from './gateway.js';
import { GATEWAY_INFLIGHT_REFUSAL_REASON, type TaskShape } from './types.js';

describe('GatewayInFlightCounter.tryAcquire', () => {
  it('passes through when tenant is undefined (legacy install)', () => {
    const c = new GatewayInFlightCounter(() => 1);
    const r = c.tryAcquire(undefined);
    expect(r.ok).toBe(true);
  });

  it('passes through when tenant is empty string', () => {
    const c = new GatewayInFlightCounter(() => 1);
    const r = c.tryAcquire('');
    expect(r.ok).toBe(true);
  });

  it('passes when no cap configured', () => {
    const c = new GatewayInFlightCounter(() => undefined);
    expect(c.tryAcquire('alpha').ok).toBe(true);
    expect(c.tryAcquire('alpha').ok).toBe(true);
    expect(c.observed('alpha')).toBe(2);
  });

  it('refuses when cap reached', () => {
    const c = new GatewayInFlightCounter(() => 2);
    expect(c.tryAcquire('alpha').ok).toBe(true);
    expect(c.tryAcquire('alpha').ok).toBe(true);
    const r = c.tryAcquire('alpha');
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toBe(GATEWAY_INFLIGHT_REFUSAL_REASON);
      expect(r.tenant).toBe('alpha');
      expect(r.observed).toBe(2);
      expect(r.cap).toBe(2);
      expect(r.message).toContain('alpha');
      expect(r.message).toContain('observed=2');
      expect(r.message).toContain('cap=2');
    }
  });

  it('does NOT increment on refusal', () => {
    const c = new GatewayInFlightCounter(() => 1);
    expect(c.tryAcquire('alpha').ok).toBe(true);
    expect(c.tryAcquire('alpha').ok).toBe(false);
    expect(c.observed('alpha')).toBe(1);
  });

  it('release decrements cleanly', () => {
    const c = new GatewayInFlightCounter(() => 5);
    c.tryAcquire('alpha');
    c.tryAcquire('alpha');
    c.release('alpha');
    expect(c.observed('alpha')).toBe(1);
    c.release('alpha');
    expect(c.observed('alpha')).toBe(0);
  });

  it('release floors at zero (idempotent)', () => {
    const c = new GatewayInFlightCounter(() => 5);
    c.release('alpha');
    c.release('alpha');
    expect(c.observed('alpha')).toBe(0);
  });

  it('release(undefined) is a no-op', () => {
    const c = new GatewayInFlightCounter(() => 5);
    c.tryAcquire('alpha');
    c.release(undefined);
    expect(c.observed('alpha')).toBe(1);
  });

  it('isolates tenants', () => {
    const c = new GatewayInFlightCounter(() => 1);
    expect(c.tryAcquire('alpha').ok).toBe(true);
    expect(c.tryAcquire('beta').ok).toBe(true);
    expect(c.observed('alpha')).toBe(1);
    expect(c.observed('beta')).toBe(1);
    expect(c.tryAcquire('alpha').ok).toBe(false);
    expect(c.tryAcquire('beta').ok).toBe(false);
  });

  it('cap re-reads on every acquire (operator hot-reload semantics)', () => {
    let cap = 1;
    const c = new GatewayInFlightCounter(() => cap);
    expect(c.tryAcquire('alpha').ok).toBe(true);
    expect(c.tryAcquire('alpha').ok).toBe(false); // cap=1, observed=1
    cap = 5;
    expect(c.tryAcquire('alpha').ok).toBe(true); // bumped on the fly
  });

  it('reset() clears all counters', () => {
    const c = new GatewayInFlightCounter(() => 5);
    c.tryAcquire('alpha');
    c.tryAcquire('beta');
    c.reset();
    expect(c.observed('alpha')).toBe(0);
    expect(c.observed('beta')).toBe(0);
  });
});

describe('GatewayInFlightCounter.rebuildFromTasks', () => {
  it('rebuilds counters from informer cache (post-leader-election)', () => {
    const tasks: TaskShape[] = [
      {
        metadata: { labels: { 'kagent.knuteson.io/tenant': 'alpha' } },
        status: { phase: 'Pending' },
      },
      {
        metadata: { labels: { 'kagent.knuteson.io/tenant': 'alpha' } },
        status: { phase: 'Running' },
      },
      {
        metadata: { labels: { 'kagent.knuteson.io/tenant': 'beta' } },
        status: { phase: 'Pending' },
      },
      // Terminal — does NOT count.
      {
        metadata: { labels: { 'kagent.knuteson.io/tenant': 'alpha' } },
        status: { phase: 'Completed' },
      },
      {
        metadata: { labels: { 'kagent.knuteson.io/tenant': 'beta' } },
        status: { phase: 'Failed' },
      },
      // No tenant label — skipped.
      { metadata: {}, status: { phase: 'Pending' } },
    ];
    const c = new GatewayInFlightCounter(() => 999);
    c.rebuildFromTasks(tasks, 'kagent.knuteson.io/tenant');
    expect(c.observed('alpha')).toBe(2);
    expect(c.observed('beta')).toBe(1);
  });

  it('rebuild clears prior state', () => {
    const c = new GatewayInFlightCounter(() => 5);
    c.tryAcquire('gamma');
    c.tryAcquire('gamma');
    c.rebuildFromTasks([], 'kagent.knuteson.io/tenant');
    expect(c.observed('gamma')).toBe(0);
  });
});

describe('checkGatewayInFlight (pure helper)', () => {
  it('passes when no cap', () => {
    expect(checkGatewayInFlight('alpha', 100, undefined).ok).toBe(true);
  });

  it('refuses when observed >= cap', () => {
    const r = checkGatewayInFlight('alpha', 5, 5);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe(GATEWAY_INFLIGHT_REFUSAL_REASON);
  });

  it('passes when observed < cap', () => {
    expect(checkGatewayInFlight('alpha', 4, 5).ok).toBe(true);
  });

  it('treats negative cap as no cap', () => {
    expect(checkGatewayInFlight('alpha', 9999, -1).ok).toBe(true);
  });
});
