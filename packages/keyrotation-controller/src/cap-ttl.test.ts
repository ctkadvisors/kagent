/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  CapTtlPolicyError,
  DEFAULT_LONG_TTL_GRACE_SECONDS,
  DEFAULT_SHORT_RUNNING_TTL_SECONDS,
  LONG_RUNNING_THRESHOLD_SECONDS,
  MAX_CAP_TTL_SECONDS,
  decideCapTtl,
  resolveCapTtlPolicy,
} from './cap-ttl.js';

describe('resolveCapTtlPolicy', () => {
  it('returns 1h short-TTL + 300s grace defaults when input is undefined', () => {
    const policy = resolveCapTtlPolicy({});
    expect(policy.shortTtlSeconds).toBe(DEFAULT_SHORT_RUNNING_TTL_SECONDS);
    expect(policy.shortTtlSeconds).toBe(3600);
    expect(policy.longTtlGraceSeconds).toBe(DEFAULT_LONG_TTL_GRACE_SECONDS);
    expect(policy.longTtlGraceSeconds).toBe(300);
    expect(policy.maxTtlSeconds).toBe(MAX_CAP_TTL_SECONDS);
    expect(policy.longRunningThresholdSeconds).toBe(LONG_RUNNING_THRESHOLD_SECONDS);
  });

  it('honors operator-configured short-TTL minutes', () => {
    const policy = resolveCapTtlPolicy({ shortTtlMinutes: 30 });
    expect(policy.shortTtlSeconds).toBe(30 * 60);
  });

  it('honors operator-configured long-TTL grace seconds', () => {
    const policy = resolveCapTtlPolicy({ longTtlGraceSeconds: 600 });
    expect(policy.longTtlGraceSeconds).toBe(600);
  });

  it('falls back to defaults on non-positive / non-finite input', () => {
    expect(resolveCapTtlPolicy({ shortTtlMinutes: 0 }).shortTtlSeconds).toBe(
      DEFAULT_SHORT_RUNNING_TTL_SECONDS,
    );
    expect(resolveCapTtlPolicy({ shortTtlMinutes: -10 }).shortTtlSeconds).toBe(
      DEFAULT_SHORT_RUNNING_TTL_SECONDS,
    );
    expect(resolveCapTtlPolicy({ shortTtlMinutes: NaN }).shortTtlSeconds).toBe(
      DEFAULT_SHORT_RUNNING_TTL_SECONDS,
    );
    expect(resolveCapTtlPolicy({ longTtlGraceSeconds: -1 }).longTtlGraceSeconds).toBe(
      DEFAULT_LONG_TTL_GRACE_SECONDS,
    );
  });

  it('rejects shortTtlMinutes that exceeds the 24h ceiling', () => {
    // 25h * 60 = 1500min
    expect(() => resolveCapTtlPolicy({ shortTtlMinutes: 1500 })).toThrow(CapTtlPolicyError);
  });

  it('rejects longTtlGraceSeconds that exceeds the 24h ceiling', () => {
    expect(() => resolveCapTtlPolicy({ longTtlGraceSeconds: 25 * 60 * 60 })).toThrow(
      CapTtlPolicyError,
    );
  });
});

describe('decideCapTtl', () => {
  const policy = resolveCapTtlPolicy({});

  it('returns short-running tier for undefined timeoutSeconds', () => {
    const decision = decideCapTtl({ timeoutSeconds: undefined, policy });
    expect(decision.tier).toBe('short-running');
    expect(decision.ttlSeconds).toBe(3600);
  });

  it('returns short-running tier for timeoutSeconds <= 1h', () => {
    expect(decideCapTtl({ timeoutSeconds: 600, policy }).tier).toBe('short-running');
    expect(decideCapTtl({ timeoutSeconds: 3600, policy }).tier).toBe('short-running');
  });

  it('returns long-running-grace tier for timeoutSeconds > 1h, candidate within 24h ceiling', () => {
    // 2h timeout + 300s grace = 7500s, well within 24h
    const decision = decideCapTtl({ timeoutSeconds: 2 * 60 * 60, policy });
    expect(decision.tier).toBe('long-running-grace');
    expect(decision.ttlSeconds).toBe(2 * 60 * 60 + 300);
  });

  it('clamps to 24h ceiling when timeoutSeconds + grace exceeds it', () => {
    const decision = decideCapTtl({ timeoutSeconds: 25 * 60 * 60, policy });
    expect(decision.tier).toBe('long-running-clamped');
    expect(decision.ttlSeconds).toBe(MAX_CAP_TTL_SECONDS);
  });

  it('clamps when grace pushes a sub-24h timeout over the ceiling', () => {
    // 24h timeout + 300s grace = 24h + 300s > 24h
    const decision = decideCapTtl({ timeoutSeconds: 24 * 60 * 60, policy });
    expect(decision.tier).toBe('long-running-clamped');
    expect(decision.ttlSeconds).toBe(MAX_CAP_TTL_SECONDS);
  });

  it('handles non-finite timeoutSeconds as short-running', () => {
    const decision = decideCapTtl({ timeoutSeconds: NaN, policy });
    expect(decision.tier).toBe('short-running');
    expect(decision.ttlSeconds).toBe(3600);
  });

  it('honors a custom long-TTL grace value', () => {
    const customPolicy = resolveCapTtlPolicy({ longTtlGraceSeconds: 60 });
    const decision = decideCapTtl({ timeoutSeconds: 2 * 60 * 60, policy: customPolicy });
    expect(decision.tier).toBe('long-running-grace');
    expect(decision.ttlSeconds).toBe(2 * 60 * 60 + 60);
  });
});
