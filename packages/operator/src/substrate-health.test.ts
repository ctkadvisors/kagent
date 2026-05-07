/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createInformerHealth,
  decideHealthz,
  DEFAULT_INFORMER_FRESHNESS_MAX_MS,
  INFORMER_ERRORS_METRIC,
  renderMetricsText,
  SUBSTRATE_INFORMER_ERROR_LOG_PREFIX,
} from './substrate-health.js';

describe('createInformerHealth', () => {
  it('starts with msSinceLastEvent = Infinity (never synced)', () => {
    const health = createInformerHealth({ now: () => 1000 });
    expect(health.msSinceLastEvent()).toBe(Infinity);
    expect(health.errorsTotal()).toBe(0);
  });

  it('recordEvent updates the freshness timestamp', () => {
    let now = 1000;
    const health = createInformerHealth({ now: () => now });
    health.recordEvent('agenttask');
    expect(health.msSinceLastEvent()).toBe(0);
    now = 5000;
    expect(health.msSinceLastEvent()).toBe(4000);
  });

  it('recordError emits structured substrate.informer_error to the logger and bumps the counter', () => {
    const errorSpy = vi.fn();
    const health = createInformerHealth({ logger: { error: errorSpy } });
    health.recordError('agenttask', new Error('apiserver 401'));
    expect(health.errorsTotal()).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line.startsWith(SUBSTRATE_INFORMER_ERROR_LOG_PREFIX)).toBe(true);
    expect(line).toContain('source=agenttask');
    expect(line).toContain('errors_total=1');
    expect(line).toContain('apiserver 401');
  });

  it('errorsTotal accumulates across calls', () => {
    const health = createInformerHealth({ logger: { error: vi.fn() } });
    health.recordError('a', 'x');
    health.recordError('b', 'y');
    health.recordError('a', 'z');
    expect(health.errorsTotal()).toBe(3);
  });
});

describe('decideHealthz', () => {
  it('returns 503 never-synced when no event has fired', () => {
    const health = createInformerHealth({ now: () => 0 });
    expect(decideHealthz(health)).toEqual({ status: 503, reason: 'never-synced' });
  });

  it('returns 200 ok when an event fired within the freshness window', () => {
    let now = 0;
    const health = createInformerHealth({ now: () => now });
    health.recordEvent('agenttask');
    now = DEFAULT_INFORMER_FRESHNESS_MAX_MS - 1;
    expect(decideHealthz(health)).toEqual({ status: 200, reason: 'ok' });
  });

  it('returns 503 stale when no event has fired in the freshness window', () => {
    let now = 0;
    const health = createInformerHealth({ now: () => now });
    health.recordEvent('agenttask');
    now = DEFAULT_INFORMER_FRESHNESS_MAX_MS + 1;
    const decision = decideHealthz(health);
    expect(decision.status).toBe(503);
    if (decision.status === 503) {
      expect(decision.reason).toBe('stale');
    }
  });
});

describe('renderMetricsText', () => {
  it('emits Prometheus text-format with HELP + TYPE + counter line', () => {
    const health = createInformerHealth({ logger: { error: vi.fn() } });
    health.recordError('a', 'boom');
    health.recordError('a', 'boom');
    const text = renderMetricsText(health);
    expect(text).toContain(`# TYPE ${INFORMER_ERRORS_METRIC} counter`);
    expect(text).toContain(`${INFORMER_ERRORS_METRIC} 2`);
  });
});
