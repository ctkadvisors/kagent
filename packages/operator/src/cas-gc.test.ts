/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for the CAS GC controller — Wave 1 / CAS sub-team (v0.2.2-cas).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { API_GROUP_VERSION, type AgentTask } from './crds/index.js';
import {
  buildReachabilitySet,
  MIN_RETENTION_MS,
  parseRetention,
  runOnce,
  shouldDelete,
  startCasGc,
  walkCasBlobs,
  type CasBlob,
  type CasGcDeps,
} from './cas-gc.js';

function freshMount(): string {
  return mkdtempSync(join(tmpdir(), 'kagent-cas-gc-test-'));
}

function makeTask(
  uid: string,
  phase: AgentTask['status'] extends infer S ? (S extends { phase: infer P } ? P : never) : never,
  refs: { name: string; ref: string }[] = [],
): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: { name: `t-${uid}`, namespace: 'default', uid },
    spec: { targetAgent: 'a', payload: {} },
    status: { phase, outputs: refs },
  };
}

/* =====================================================================
 * parseRetention
 * ===================================================================== */

describe('parseRetention', () => {
  it('parses canonical units', () => {
    expect(parseRetention('30s')).toBe(30 * 1000);
    expect(parseRetention('5m')).toBe(5 * 60 * 1000);
    expect(parseRetention('24h')).toBe(24 * 60 * 60 * 1000);
    expect(parseRetention('7d')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('lowercases units (so 7D parses)', () => {
    expect(parseRetention('7D')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('returns null for malformed input', () => {
    expect(parseRetention('')).toBeNull();
    expect(parseRetention('7')).toBeNull();
    expect(parseRetention('7y')).toBeNull(); // unsupported unit
    expect(parseRetention('abc')).toBeNull();
    expect(parseRetention('1d6h')).toBeNull(); // composite rejected
    expect(parseRetention('-1d')).toBeNull();
    expect(parseRetention('1.5h')).toBeNull(); // non-integer rejected
  });

  it('returns null for non-string input', () => {
    expect(parseRetention(42 as unknown as string)).toBeNull();
    expect(parseRetention(undefined as unknown as string)).toBeNull();
  });
});

/* =====================================================================
 * buildReachabilitySet
 * ===================================================================== */

describe('buildReachabilitySet', () => {
  it('returns an empty set when no tasks have outputs', () => {
    const reachable = buildReachabilitySet([]);
    expect(reachable.size).toBe(0);
  });

  it('includes hashes from non-Completed task outputs (cas://)', () => {
    const hex = 'a'.repeat(64);
    const tasks = [
      makeTask('t1', 'Dispatched', [{ name: 'digest', ref: `cas://sha256:${hex}/digest.md` }]),
    ];
    const reachable = buildReachabilitySet(tasks);
    expect(reachable.has(hex)).toBe(true);
  });

  it('includes hashes from inline:// outputs', () => {
    const hex = 'b'.repeat(64);
    const tasks = [
      makeTask('t1', 'Dispatched', [{ name: 'short', ref: `inline://sha256:${hex}` }]),
    ];
    const reachable = buildReachabilitySet(tasks);
    expect(reachable.has(hex)).toBe(true);
  });

  it('SKIPS Completed tasks (consumers had their chance)', () => {
    const hex = 'c'.repeat(64);
    const tasks = [
      makeTask('t1', 'Completed', [{ name: 'digest', ref: `cas://sha256:${hex}/x.md` }]),
    ];
    const reachable = buildReachabilitySet(tasks);
    expect(reachable.has(hex)).toBe(false);
  });

  it('keeps Failed tasks reachable (post-mortem inspection window)', () => {
    const hex = 'd'.repeat(64);
    const tasks = [makeTask('t1', 'Failed', [{ name: 'digest', ref: `cas://sha256:${hex}/x.md` }])];
    const reachable = buildReachabilitySet(tasks);
    expect(reachable.has(hex)).toBe(true);
  });

  it('ignores malformed URIs', () => {
    const tasks = [
      makeTask('t1', 'Dispatched', [
        { name: 'bad', ref: 'not-a-uri' },
        { name: 'pvc-not-tracked', ref: 'pvc://x/y/z.md' },
      ]),
    ];
    // pvc:// outputs aren't sha256-keyed, so we don't add to reachable
    // (they live under per-task subdirectories which the GC doesn't sweep).
    const reachable = buildReachabilitySet(tasks);
    expect(reachable.size).toBe(0);
  });

  it('dedupes hashes across multiple tasks', () => {
    const hex = 'e'.repeat(64);
    const tasks = [
      makeTask('t1', 'Dispatched', [{ name: 'd', ref: `cas://sha256:${hex}/a.md` }]),
      makeTask('t2', 'Pending', [{ name: 'd', ref: `cas://sha256:${hex}/a.md` }]),
    ];
    const reachable = buildReachabilitySet(tasks);
    expect(reachable.size).toBe(1);
    expect(reachable.has(hex)).toBe(true);
  });
});

/* =====================================================================
 * walkCasBlobs
 * ===================================================================== */

describe('walkCasBlobs', () => {
  let mount: string;

  beforeEach(() => {
    mount = freshMount();
  });

  afterEach(() => {
    rmSync(mount, { recursive: true, force: true });
  });

  it('returns empty when the mount has no cas/ subtree yet', () => {
    expect(walkCasBlobs(mount)).toEqual([]);
  });

  it('discovers blobs under sha256/<2hex>/<62hex>', () => {
    const hex = 'f'.repeat(64);
    const dir = resolve(mount, 'cas', 'sha256', hex.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, hex.slice(2));
    writeFileSync(path, 'bytes');

    const blobs = walkCasBlobs(mount);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.hash).toBe(hex);
    expect(blobs[0]?.path).toBe(path);
    expect(blobs[0]?.mtimeMs).toBeGreaterThan(0);
  });

  it('skips .tmp files (mid-write)', () => {
    const hex = '1'.repeat(64);
    const dir = resolve(mount, 'cas', 'sha256', hex.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, hex.slice(2) + '.tmp'), 'partial');

    expect(walkCasBlobs(mount)).toEqual([]);
  });

  it('skips garbage shard names', () => {
    mkdirSync(resolve(mount, 'cas', 'sha256', 'zz'), { recursive: true });
    expect(walkCasBlobs(mount)).toEqual([]);
  });

  it('skips files whose reconstructed hash is malformed', () => {
    const dir = resolve(mount, 'cas', 'sha256', 'aa');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'short'), 'x'); // not 62 hex chars

    expect(walkCasBlobs(mount)).toEqual([]);
  });
});

/* =====================================================================
 * shouldDelete + runOnce
 * ===================================================================== */

describe('shouldDelete', () => {
  it('keeps reachable blobs regardless of age', () => {
    const hex = 'a'.repeat(64);
    const blob: CasBlob = { hash: hex, path: '/p', mtimeMs: 0 };
    expect(shouldDelete(blob, new Set([hex]), 1_000_000_000_000, 1000)).toBe(false);
  });

  it('keeps fresh blobs even when not reachable', () => {
    const hex = 'a'.repeat(64);
    const now = 1_000_000_000_000;
    const blob: CasBlob = { hash: hex, path: '/p', mtimeMs: now - 500 }; // 500ms old
    expect(shouldDelete(blob, new Set(), now, 1000)).toBe(false);
  });

  it('deletes old + unreachable blobs', () => {
    const hex = 'a'.repeat(64);
    const now = 1_000_000_000_000;
    const blob: CasBlob = { hash: hex, path: '/p', mtimeMs: now - 2000 };
    expect(shouldDelete(blob, new Set(), now, 1000)).toBe(true);
  });

  it('uses >= retention as the cut (boundary inclusive)', () => {
    const hex = 'a'.repeat(64);
    const now = 1_000_000_000_000;
    const blob: CasBlob = { hash: hex, path: '/p', mtimeMs: now - 1000 };
    expect(shouldDelete(blob, new Set(), now, 1000)).toBe(true);
  });
});

describe('runOnce', () => {
  let mount: string;
  let logs: string[];

  beforeEach(() => {
    mount = freshMount();
    logs = [];
  });

  afterEach(() => {
    rmSync(mount, { recursive: true, force: true });
  });

  function writeBlob(hash: string, ageMs: number): string {
    const dir = resolve(mount, 'cas', 'sha256', hash.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, hash.slice(2));
    writeFileSync(path, 'bytes');
    const targetSec = (Date.now() - ageMs) / 1000;
    utimesSync(path, targetSec, targetSec);
    return path;
  }

  function deps(tasks: readonly AgentTask[] = []): CasGcDeps {
    return {
      listAgentTasks: () => tasks,
      log: (m) => logs.push(m),
    };
  }

  it('refuses to run with retentionMs < MIN_RETENTION_MS', () => {
    expect(() =>
      runOnce({ mountPath: mount, retentionMs: 1000, intervalMs: 60000 }, deps()),
    ).toThrow(/refusing to sweep/);
  });

  it('deletes old + unreachable blobs and reports counts', () => {
    const oldHash = 'a'.repeat(64);
    const oldPath = writeBlob(oldHash, 10 * 60 * 1000); // 10 min old
    const result = runOnce(
      {
        mountPath: mount,
        retentionMs: 5 * 60 * 1000, // 5 min retention
        intervalMs: 60 * 1000,
      },
      deps(),
    );
    expect(result.scanned).toBe(1);
    expect(result.eligible).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
    expect(existsSync(oldPath)).toBe(false);
  });

  it('keeps reachable blobs even when old', () => {
    const hex = 'b'.repeat(64);
    const path = writeBlob(hex, 10 * 60 * 1000);
    const tasks = [makeTask('t1', 'Dispatched', [{ name: 'd', ref: `cas://sha256:${hex}/x.md` }])];
    const result = runOnce(
      { mountPath: mount, retentionMs: 5 * 60 * 1000, intervalMs: 60_000 },
      deps(tasks),
    );
    expect(result.reachableSkipped).toBe(1);
    expect(result.deleted).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('keeps fresh blobs even when unreachable', () => {
    const hex = 'c'.repeat(64);
    const path = writeBlob(hex, 1000); // 1s old
    const result = runOnce(
      { mountPath: mount, retentionMs: 5 * 60 * 1000, intervalMs: 60_000 },
      deps(),
    );
    expect(result.tooFreshSkipped).toBe(1);
    expect(result.deleted).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('dryRun: logs eligible but does not unlink', () => {
    const hex = 'd'.repeat(64);
    const path = writeBlob(hex, 10 * 60 * 1000);
    const result = runOnce(
      { mountPath: mount, retentionMs: 5 * 60 * 1000, intervalMs: 60_000, dryRun: true },
      deps(),
    );
    expect(result.eligible).toBe(1);
    expect(result.deleted).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(logs.some((l) => l.includes('DRY-RUN would delete'))).toBe(true);
  });

  it('produces the canonical sweep summary log', () => {
    runOnce({ mountPath: mount, retentionMs: 5 * 60 * 1000, intervalMs: 60_000 }, deps());
    expect(logs.some((l) => l.includes('sweep done'))).toBe(true);
  });
});

/* =====================================================================
 * startCasGc
 * ===================================================================== */

describe('startCasGc', () => {
  let mount: string;

  beforeEach(() => {
    mount = freshMount();
  });

  afterEach(() => {
    rmSync(mount, { recursive: true, force: true });
  });

  it('returns a handle whose stop() clears the timer', () => {
    const handle = startCasGc(
      {
        mountPath: mount,
        retentionMs: 60_000,
        intervalMs: 60_000,
      },
      { listAgentTasks: () => [], log: () => undefined },
    );
    expect(typeof handle.stop).toBe('function');
    handle.stop();
    handle.stop(); // safe to double-call
  });

  it('refuses an interval shorter than MIN_RETENTION_MS', () => {
    expect(() =>
      startCasGc(
        { mountPath: mount, retentionMs: 60_000, intervalMs: 100 },
        { listAgentTasks: () => [], log: () => undefined },
      ),
    ).toThrow(new RegExp(`>= ${String(MIN_RETENTION_MS)}`));
  });
});
