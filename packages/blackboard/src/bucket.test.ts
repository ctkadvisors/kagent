/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  BLACKBOARD_BUCKET_PREFIX,
  DEFAULT_BUCKET_TTL_MS,
  DEFAULT_MAX_BUCKET_BYTES,
  DEFAULT_MAX_VALUE_BYTES,
  bucketNameForRootUid,
  buildBucketConfig,
  rootUidFromBucketName,
} from './bucket.js';

describe('bucketNameForRootUid', () => {
  it('prefixes the UID with kagent-kv-', () => {
    expect(bucketNameForRootUid('abc-123')).toBe(`${BLACKBOARD_BUCKET_PREFIX}abc-123`);
  });

  it('throws on empty UID', () => {
    expect(() => bucketNameForRootUid('')).toThrow(/non-empty/);
  });

  it('round-trips a real K8s UID-shaped string', () => {
    const uid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const name = bucketNameForRootUid(uid);
    expect(name.length).toBeLessThan(64);
    expect(rootUidFromBucketName(name)).toBe(uid);
  });
});

describe('rootUidFromBucketName', () => {
  it('returns the UID portion when prefixed', () => {
    expect(rootUidFromBucketName('kagent-kv-xyz')).toBe('xyz');
  });

  it('returns null for non-blackboard bucket names', () => {
    expect(rootUidFromBucketName('kagent-other-xyz')).toBeNull();
    expect(rootUidFromBucketName('xyz')).toBeNull();
  });

  it('returns null for the bare prefix (no UID)', () => {
    expect(rootUidFromBucketName('kagent-kv-')).toBeNull();
  });
});

describe('buildBucketConfig', () => {
  it('uses defaults when opts omitted', () => {
    const cfg = buildBucketConfig('uid-1');
    expect(cfg).toEqual({
      name: 'kagent-kv-uid-1',
      ttlMs: DEFAULT_BUCKET_TTL_MS,
      maxValueBytes: DEFAULT_MAX_VALUE_BYTES,
      maxBucketBytes: DEFAULT_MAX_BUCKET_BYTES,
      history: 1,
    });
  });

  it('honors caller overrides when positive', () => {
    const cfg = buildBucketConfig('uid-1', {
      ttlMs: 5000,
      maxValueBytes: 1024,
      maxBucketBytes: 2048,
    });
    expect(cfg.ttlMs).toBe(5000);
    expect(cfg.maxValueBytes).toBe(1024);
    expect(cfg.maxBucketBytes).toBe(2048);
  });

  it('falls back to defaults on zero / negative overrides', () => {
    const cfg = buildBucketConfig('uid-1', {
      ttlMs: 0,
      maxValueBytes: -1,
      maxBucketBytes: 0,
    });
    expect(cfg.ttlMs).toBe(DEFAULT_BUCKET_TTL_MS);
    expect(cfg.maxValueBytes).toBe(DEFAULT_MAX_VALUE_BYTES);
    expect(cfg.maxBucketBytes).toBe(DEFAULT_MAX_BUCKET_BYTES);
  });
});
