/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/* eslint-disable @typescript-eslint/require-await -- async stubs intentionally
 * have no await; they exist to match the production interface shape.
 */

import { describe, expect, it, vi } from 'vitest';

import { BlackboardBucketManager } from './manager.js';
import type { JetStreamManagerLike, KvCreateOpts, KvHandleLike, KvViewsLike } from './manager.js';

const SILENT_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('BlackboardBucketManager.ensureBucket', () => {
  it('passes the configured opts to views.kv', async () => {
    let observedName = '';
    let observedOpts: KvCreateOpts | undefined;
    const views: KvViewsLike = {
      kv: async (name, opts): Promise<KvHandleLike> => {
        observedName = name;
        observedOpts = opts;
        return { destroy: async () => true };
      },
    };
    const mgr = new BlackboardBucketManager({ views, logger: SILENT_LOGGER });
    const cfg = await mgr.ensureBucket('uid-abc', { ttlMs: 9000 });
    expect(observedName).toBe('kagent-kv-uid-abc');
    expect(cfg.ttlMs).toBe(9000);
    expect(observedOpts?.ttl).toBe(9000);
    expect(observedOpts?.history).toBe(1);
  });

  it('rethrows on failure', async () => {
    const views: KvViewsLike = {
      kv: async () => {
        throw new Error('boom');
      },
    };
    const mgr = new BlackboardBucketManager({ views, logger: SILENT_LOGGER });
    await expect(mgr.ensureBucket('uid-x')).rejects.toThrow(/boom/);
  });
});

describe('BlackboardBucketManager.destroyBucket', () => {
  it('destroys the bucket and fires the audit hook', async () => {
    const destroy = vi.fn().mockResolvedValue(true);
    const views: KvViewsLike = {
      kv: async () => ({ destroy }),
    };
    const onDestroyed = vi.fn();
    const mgr = new BlackboardBucketManager({
      views,
      logger: SILENT_LOGGER,
      onDestroyed,
    });
    const result = await mgr.destroyBucket('uid-zzz');
    expect(result.destroyed).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
    expect(onDestroyed).toHaveBeenCalledWith({
      rootUid: 'uid-zzz',
      bucketName: 'kagent-kv-uid-zzz',
    });
  });

  it('falls back to JSM stream delete when kv.destroy returns false', async () => {
    const destroy = vi.fn().mockResolvedValue(false);
    const views: KvViewsLike = {
      kv: async () => ({ destroy }),
    };
    const streamDelete = vi.fn().mockResolvedValue(true);
    const jsm: JetStreamManagerLike = {
      streams: { delete: streamDelete },
    };
    const mgr = new BlackboardBucketManager({ views, jsm, logger: SILENT_LOGGER });
    const result = await mgr.destroyBucket('uid-y');
    expect(result.destroyed).toBe(true);
    expect(streamDelete).toHaveBeenCalledWith('KV_kagent-kv-uid-y');
  });

  it('treats not-found errors as idempotent success', async () => {
    const views: KvViewsLike = {
      kv: async () => {
        throw new Error('stream not found');
      },
    };
    const onDestroyed = vi.fn();
    const mgr = new BlackboardBucketManager({ views, logger: SILENT_LOGGER, onDestroyed });
    const result = await mgr.destroyBucket('uid-q');
    expect(result.destroyed).toBe(true);
    expect(onDestroyed).toHaveBeenCalledOnce();
  });

  it('rethrows on non-not-found errors', async () => {
    const views: KvViewsLike = {
      kv: async () => {
        throw new Error('connection refused');
      },
    };
    const mgr = new BlackboardBucketManager({ views, logger: SILENT_LOGGER });
    await expect(mgr.destroyBucket('uid-q')).rejects.toThrow(/connection refused/);
  });

  it('does not crash when audit hook throws', async () => {
    const destroy = vi.fn().mockResolvedValue(true);
    const views: KvViewsLike = {
      kv: async () => ({ destroy }),
    };
    const onDestroyed = vi.fn().mockImplementation(() => {
      throw new Error('audit downstream broken');
    });
    const warnings: unknown[] = [];
    const mgr = new BlackboardBucketManager({
      views,
      logger: { ...SILENT_LOGGER, warn: (m) => warnings.push(m) },
      onDestroyed,
    });
    const result = await mgr.destroyBucket('uid-q');
    expect(result.destroyed).toBe(true);
    expect(warnings.length).toBe(1);
  });
});
