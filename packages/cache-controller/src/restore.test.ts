/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { deriveCacheKey } from './key.js';
import {
  buildCacheRestoreInitContainer,
  buildCacheSaveCommand,
  CACHE_PVC_VOLUME_NAME,
  CACHE_SLOT_VOLUME_PREFIX,
  lookupCacheEntries,
} from './restore.js';
import type {
  AgentLike,
  AgentTaskLike,
  CacheDeclLike,
  CacheLookupResult,
  KeyDerivationContext,
} from './types.js';

const sampleAgent = (caches: readonly CacheDeclLike[] = []): AgentLike => ({
  spec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    caches,
  },
});
const sampleTask: AgentTaskLike = { spec: {} };
const baseCtx: KeyDerivationContext = {
  imageDigest: 'sha256:abc',
  inputArtifactHashes: [],
};

describe('lookupCacheEntries', () => {
  it('returns empty when no caches declared', () => {
    const out = lookupCacheEntries({
      agent: sampleAgent([]),
      task: sampleTask,
      ctx: baseCtx,
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => false,
    });
    expect(out).toEqual([]);
  });

  it('returns hit when probe succeeds', () => {
    const slot: CacheDeclLike = { name: 'npm', key: 'default', mountPath: '/cache/npm' };
    const seen: string[] = [];
    const out = lookupCacheEntries({
      agent: sampleAgent([slot]),
      task: sampleTask,
      ctx: baseCtx,
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: (p) => {
        seen.push(p);
        return true;
      },
    });
    expect(out).toHaveLength(1);
    const result = out[0]!;
    expect(result.outcome).toBe('hit');
    if (result.outcome === 'hit') {
      expect(/^[0-9a-f]{64}$/.test(result.key)).toBe(true);
      expect(result.storageRelPath).toContain('cache/sha256/');
      expect(result.storageRelPath.endsWith('/npm')).toBe(true);
    }
    expect(seen[0]).toMatch(/^\/mnt\/cache\/cache\/sha256\//);
  });

  it('returns miss when probe fails', () => {
    const slot: CacheDeclLike = { name: 'pip', key: 'default', mountPath: '/cache/pip' };
    const out = lookupCacheEntries({
      agent: sampleAgent([slot]),
      task: sampleTask,
      ctx: baseCtx,
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe('miss');
  });

  it('handles trailing slash on mount path', () => {
    const slot: CacheDeclLike = { name: 'pip', key: 'default', mountPath: '/cache/pip' };
    const seen: string[] = [];
    lookupCacheEntries({
      agent: sampleAgent([slot]),
      task: sampleTask,
      ctx: baseCtx,
      cachePvcMountOnOperator: '/mnt/cache///',
      existsOnDisk: (p) => {
        seen.push(p);
        return false;
      },
    });
    expect(seen[0]!.startsWith('/mnt/cache/cache/sha256/')).toBe(true);
  });

  it('preserves slot order in results', () => {
    const slots: CacheDeclLike[] = [
      { name: 'one', key: 'default', mountPath: '/c/1' },
      { name: 'two', key: 'default', mountPath: '/c/2' },
      { name: 'three', key: 'default', mountPath: '/c/3' },
    ];
    let i = 0;
    const out = lookupCacheEntries({
      agent: sampleAgent(slots),
      task: sampleTask,
      ctx: baseCtx,
      cachePvcMountOnOperator: '/mnt',
      // Hit second only.
      existsOnDisk: () => i++ === 1,
    });
    expect(out.map((r) => r.outcome)).toEqual(['miss', 'hit', 'miss']);
  });
});

describe('buildCacheRestoreInitContainer', () => {
  const slots: CacheDeclLike[] = [
    { name: 'npm-cache', key: 'default', mountPath: '/var/cache/npm' },
    { name: 'pip-cache', key: 'default', mountPath: '/var/cache/pip' },
  ];

  it('returns no init-container + no PVC volume when zero hits', () => {
    const lookups: CacheLookupResult[] = [
      { outcome: 'miss', key: 'a' },
      { outcome: 'miss', key: 'b' },
    ];
    const out = buildCacheRestoreInitContainer({
      slots,
      lookups,
      pvcName: 'kagent-cache',
    });
    expect(out.initContainers).toHaveLength(0);
    // Per-slot emptyDirs ARE still emitted so the agent's mountPath is writable.
    expect(out.volumes).toHaveLength(2);
    for (const v of out.volumes) {
      expect(v.emptyDir).toBeDefined();
    }
    expect(out.volumeMounts).toHaveLength(2);
    expect(out.hitCount).toBe(0);
    expect(out.missCount).toBe(2);
  });

  it('emits init-container + PVC volume when at least one hit', () => {
    const lookups: CacheLookupResult[] = [
      {
        outcome: 'hit',
        key: 'a'.repeat(64),
        storageRelPath: `cache/sha256/aa/${'a'.repeat(62)}/npm-cache`,
      },
      { outcome: 'miss', key: 'b' },
    ];
    const out = buildCacheRestoreInitContainer({
      slots,
      lookups,
      pvcName: 'kagent-cache',
    });
    expect(out.initContainers).toHaveLength(1);
    expect(out.hitCount).toBe(1);
    expect(out.missCount).toBe(1);

    const init = out.initContainers[0]!;
    expect(init.name).toBe('kagent-cache-restore');
    expect(init.command).toEqual(['/bin/sh', '-c']);
    const args = init.args!;
    expect(args).toHaveLength(1);
    expect(args[0]).toContain('cache/sha256/aa/'); // hit slot copied
    expect(args[0]).toContain('cp -r');

    // Volumes: cache PVC RO + 2 per-slot emptyDirs.
    expect(out.volumes).toHaveLength(3);
    const pvcVolume = out.volumes.find((v) => v.name === CACHE_PVC_VOLUME_NAME);
    expect(pvcVolume).toBeDefined();
    expect(pvcVolume!.persistentVolumeClaim?.claimName).toBe('kagent-cache');
    expect(pvcVolume!.persistentVolumeClaim?.readOnly).toBe(true);

    // Agent-side mounts: one per slot at the slot's mountPath.
    expect(out.volumeMounts).toHaveLength(2);
    expect(out.volumeMounts.map((m) => m.mountPath).sort()).toEqual([
      '/var/cache/npm',
      '/var/cache/pip',
    ]);
  });

  it('returns empty everything when slots length mismatches lookups', () => {
    const out = buildCacheRestoreInitContainer({
      slots,
      lookups: [{ outcome: 'miss', key: 'a' }],
      pvcName: 'kagent-cache',
    });
    expect(out.initContainers).toHaveLength(0);
    expect(out.volumes).toHaveLength(0);
    expect(out.volumeMounts).toHaveLength(0);
  });

  it('sanitizes slot names with uppercase or invalid chars into volume names', () => {
    const weirdSlots: CacheDeclLike[] = [{ name: 'NPM_Cache!!', key: 'default', mountPath: '/c' }];
    const out = buildCacheRestoreInitContainer({
      slots: weirdSlots,
      lookups: [{ outcome: 'miss', key: 'k' }],
      pvcName: 'kagent-cache',
    });
    const volName = out.volumes[0]!.name;
    expect(volName.startsWith(CACHE_SLOT_VOLUME_PREFIX)).toBe(true);
    expect(/^[a-z0-9-]+$/.test(volName)).toBe(true);
  });

  it('handles unicode slot names without crashing (sanitized to "unnamed" or trimmed)', () => {
    const slot: CacheDeclLike = { name: 'クラッシュ', key: 'default', mountPath: '/c' };
    const out = buildCacheRestoreInitContainer({
      slots: [slot],
      lookups: [{ outcome: 'miss', key: 'k' }],
      pvcName: 'kagent-cache',
    });
    const volName = out.volumes[0]!.name;
    // Sanitize replaces all non-[a-z0-9-] runs with '-' then trims; result should be valid.
    expect(volName.startsWith(CACHE_SLOT_VOLUME_PREFIX)).toBe(true);
  });
});

describe('buildCacheSaveCommand', () => {
  it('throws on slot/key length mismatch', () => {
    expect(() =>
      buildCacheSaveCommand({
        slots: [{ name: 'a', key: 'default', mountPath: '/c' }],
        keys: [],
        pvcName: 'p',
        taskUid: 'u',
        taskName: 'n',
        taskNamespace: 'ns',
      }),
    ).toThrow(/length mismatch/);
  });

  it('emits a sentinel-wait + per-slot save block', () => {
    const key = deriveCacheKey('default', sampleAgent(), sampleTask, baseCtx);
    const cmd = buildCacheSaveCommand({
      slots: [{ name: 'mySlot', key: 'default', mountPath: '/c/my' }],
      keys: [key],
      pvcName: 'kagent-cache',
      taskUid: 'uid',
      taskName: 'task',
      taskNamespace: 'ns',
    });
    expect(cmd).toContain('exit-status');
    expect(cmd).toContain(`cache/sha256/${key.slice(0, 2)}/${key.slice(2)}/mySlot`);
    // Atomic-rename pattern is present.
    expect(cmd).toContain('mv');
  });
});
