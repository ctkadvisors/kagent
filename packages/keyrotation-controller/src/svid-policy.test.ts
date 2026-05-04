/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SVID_ROTATION_INTERVAL_SECONDS,
  MAX_SVID_ROTATION_INTERVAL_SECONDS,
  MIN_SVID_ROTATION_INTERVAL_SECONDS,
  SvidRotationPolicyError,
  decideSvidRotation,
  resolveSvidRotationPolicy,
} from './svid-policy.js';

describe('resolveSvidRotationPolicy', () => {
  it('returns 24h default when input is undefined', () => {
    const policy = resolveSvidRotationPolicy({});
    expect(policy.intervalSeconds).toBe(DEFAULT_SVID_ROTATION_INTERVAL_SECONDS);
    expect(policy.intervalSeconds).toBe(86400);
  });

  it('returns 24h default when input is non-positive', () => {
    expect(resolveSvidRotationPolicy({ intervalHours: 0 }).intervalSeconds).toBe(
      DEFAULT_SVID_ROTATION_INTERVAL_SECONDS,
    );
    expect(resolveSvidRotationPolicy({ intervalHours: -5 }).intervalSeconds).toBe(
      DEFAULT_SVID_ROTATION_INTERVAL_SECONDS,
    );
  });

  it('returns 24h default when input is non-finite', () => {
    expect(resolveSvidRotationPolicy({ intervalHours: NaN }).intervalSeconds).toBe(
      DEFAULT_SVID_ROTATION_INTERVAL_SECONDS,
    );
    expect(resolveSvidRotationPolicy({ intervalHours: Infinity }).intervalSeconds).toBe(
      DEFAULT_SVID_ROTATION_INTERVAL_SECONDS,
    );
  });

  it('accepts 1h (the minimum)', () => {
    const policy = resolveSvidRotationPolicy({ intervalHours: 1 });
    expect(policy.intervalSeconds).toBe(MIN_SVID_ROTATION_INTERVAL_SECONDS);
  });

  it('accepts 168h (the maximum, 1 week)', () => {
    const policy = resolveSvidRotationPolicy({ intervalHours: 168 });
    expect(policy.intervalSeconds).toBe(MAX_SVID_ROTATION_INTERVAL_SECONDS);
  });

  it('accepts a typical 24h configuration', () => {
    const policy = resolveSvidRotationPolicy({ intervalHours: 24 });
    expect(policy.intervalSeconds).toBe(86400);
  });

  it('rejects sub-1h intervals (substrate refuses)', () => {
    expect(() => resolveSvidRotationPolicy({ intervalHours: 0.5 })).toThrow(
      SvidRotationPolicyError,
    );
    expect(() => resolveSvidRotationPolicy({ intervalHours: 0.99 })).toThrow(
      SvidRotationPolicyError,
    );
  });

  it('rejects intervals above 168h (substrate refuses)', () => {
    expect(() => resolveSvidRotationPolicy({ intervalHours: 169 })).toThrow(
      SvidRotationPolicyError,
    );
    expect(() => resolveSvidRotationPolicy({ intervalHours: 720 })).toThrow(
      SvidRotationPolicyError,
    );
  });

  it('SvidRotationPolicyError carries received + bound details', () => {
    try {
      resolveSvidRotationPolicy({ intervalHours: 0.5 });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SvidRotationPolicyError);
      const e = err as SvidRotationPolicyError;
      expect(e.receivedSeconds).toBe(1800);
      expect(e.minSeconds).toBe(MIN_SVID_ROTATION_INTERVAL_SECONDS);
      expect(e.maxSeconds).toBe(MAX_SVID_ROTATION_INTERVAL_SECONDS);
    }
  });
});

describe('decideSvidRotation', () => {
  const policy = resolveSvidRotationPolicy({ intervalHours: 24 });
  const spiffeId = 'spiffe://kagent.knuteson.io/ns/default/sa/agent-x/agent/researcher';

  it('returns keep when SVID is fresh (age < interval)', () => {
    const notBefore = new Date('2026-05-04T00:00:00Z');
    const now = new Date('2026-05-04T01:00:00Z'); // 1h old
    const decision = decideSvidRotation({ spiffeId, notBefore, now, policy });
    expect(decision.verdict).toBe('keep');
    expect(decision.ageSeconds).toBe(3600);
    expect(decision.intervalSeconds).toBe(86400);
  });

  it('returns rotate when SVID is at exactly interval (boundary inclusive)', () => {
    const notBefore = new Date('2026-05-04T00:00:00Z');
    const now = new Date('2026-05-05T00:00:00Z'); // 24h old, exact
    const decision = decideSvidRotation({ spiffeId, notBefore, now, policy });
    expect(decision.verdict).toBe('rotate');
    expect(decision.ageSeconds).toBe(86400);
  });

  it('returns rotate when SVID exceeds interval', () => {
    const notBefore = new Date('2026-05-04T00:00:00Z');
    const now = new Date('2026-05-05T01:00:00Z'); // 25h old
    const decision = decideSvidRotation({ spiffeId, notBefore, now, policy });
    expect(decision.verdict).toBe('rotate');
    expect(decision.ageSeconds).toBe(90000);
  });

  it('handles future-notBefore (clock skew) by clamping age to 0 + keep', () => {
    const notBefore = new Date('2026-05-05T00:00:00Z');
    const now = new Date('2026-05-04T00:00:00Z'); // notBefore is in the future
    const decision = decideSvidRotation({ spiffeId, notBefore, now, policy });
    expect(decision.verdict).toBe('keep');
    expect(decision.ageSeconds).toBe(0);
  });
});
