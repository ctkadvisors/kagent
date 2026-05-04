/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * CAS GC controller — Wave 1 / CAS sub-team (v0.2.2-cas).
 *
 * On a tunable interval, walks the CAS blob tree under
 * `<mountPath>/cas/sha256/<first-2-hex>/<remaining-62-hex>` and removes
 * blobs that are BOTH:
 *
 *   1. Older than the configured retention window (compared against the
 *      blob's mtime; FS atime would be ideal but most distros default
 *      to `relatime` and many to `noatime`, so atime is unreliable).
 *
 *   2. NOT reachable from any non-`Completed` AgentTask's
 *      `status.outputs[].uri`. A reachable blob — even a stale one —
 *      stays on disk until either the consuming task completes OR the
 *      retention window passes after its last reference is dropped.
 *
 * Both conditions must hold; either alone is insufficient. This is the
 * Bazel/Nix pattern: content-addressed identity + reachability sweep.
 *
 * The controller is OFF by default. Operators flip it on via
 * `cas.enabled: true` in the Helm chart. The reachability set is
 * computed by walking the AgentTask informer cache (already running in
 * `main.ts`); the disk walk uses Node's sync FS APIs on a once-per-tick
 * basis (the substrate operator is single-replica per WAVES.md so we
 * don't need leader election here).
 *
 * v0.2.2 hard-deletes via `unlinkSync`; v0.2.3 may add a quarantine /
 * trash bucket for "are you sure?" recovery on misconfigured policies.
 * Until then, this code refuses to run when retention parses to < 1
 * minute (defense-in-depth against a typo'd `0d`).
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AgentTask } from './crds/index.js';
import { parseUri } from './crds/index.js';

/* =====================================================================
 * Retention duration parser.
 * ===================================================================== */

/** Lower bound on a configured retention window. */
export const MIN_RETENTION_MS = 60 * 1000; // 1 minute

/**
 * Parse a duration string like `7d`, `24h`, `30m`, `90s` into
 * milliseconds. Returns `null` on malformed input — the caller refuses
 * to start the GC loop.
 *
 * Single-unit only; `1d6h` is intentionally rejected (composite formats
 * are confusion-prone and `7d` is what the chart documents).
 */
export function parseRetention(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  const unit = trimmed.slice(-1).toLowerCase();
  const numStr = trimmed.slice(0, -1);
  const n = Number(numStr);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  let multiplier: number;
  switch (unit) {
    case 's':
      multiplier = 1000;
      break;
    case 'm':
      multiplier = 60 * 1000;
      break;
    case 'h':
      multiplier = 60 * 60 * 1000;
      break;
    case 'd':
      multiplier = 24 * 60 * 60 * 1000;
      break;
    default:
      return null;
  }
  return n * multiplier;
}

/* =====================================================================
 * Reachability set construction.
 * ===================================================================== */

/**
 * Compute the set of sha256 hashes referenced by any non-`Completed`
 * AgentTask's `status.outputs[].uri`. Tasks in `Completed` phase are
 * intentionally excluded — once a task is Completed, downstream
 * consumers have either followed the URI (which kept the blob alive
 * via mtime touch) or accept that the blob is eligible for retention
 * sweep.
 *
 * `Failed` tasks ARE counted as reachable for one retention window, on
 * the assumption that an operator-side post-mortem may want to inspect
 * the blob. After retention passes the failed-task ref drops off naturally.
 *
 * Pure function: given the same task list it produces the same Set.
 */
export function buildReachabilitySet(tasks: readonly AgentTask[]): Set<string> {
  const reachable = new Set<string>();
  for (const task of tasks) {
    const phase = task.status?.phase;
    // Tasks already Completed are NOT reachable for GC purposes — see
    // the docstring; consumers had their chance.
    if (phase === 'Completed') continue;
    const outputs = task.status?.outputs ?? [];
    for (const o of outputs) {
      const parsed = parseUri(o.ref);
      if (parsed === null) continue;
      if (parsed.scheme === 'cas' || parsed.scheme === 'inline') {
        reachable.add(parsed.hash);
      }
    }
  }
  return reachable;
}

/* =====================================================================
 * Disk walk + sweep.
 * ===================================================================== */

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * One blob discovered on disk. The hash is recovered by concatenating
 * the shard prefix with the file name; mtime drives the retention
 * decision.
 */
export interface CasBlob {
  /** Reconstructed lowercase-hex sha256. */
  readonly hash: string;
  /** Absolute file path on disk. */
  readonly path: string;
  /** Last-modified time as ms since epoch. */
  readonly mtimeMs: number;
}

/**
 * Walk `<mountPath>/cas/sha256/**` and yield each well-formed CAS blob.
 * Tolerant of partial layouts (`.tmp` files, garbage subdirectories) —
 * anything that doesn't reconstruct to a valid sha256 hex is skipped.
 * The function is sync (per the v0.2.2 sweep pattern); we cap the walk
 * implicitly via the substrate's single-replica posture.
 *
 * Exposed for tests.
 */
export function walkCasBlobs(mountPath: string): CasBlob[] {
  const root = resolve(mountPath, 'cas', 'sha256');
  const out: CasBlob[] = [];
  let shards: string[];
  try {
    shards = readdirSync(root);
  } catch {
    // Root doesn't exist yet (no writes have happened) — empty walk.
    return out;
  }
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    let entries: string[];
    try {
      entries = readdirSync(resolve(root, shard));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.tmp')) continue;
      const hash = `${shard}${entry}`;
      if (!SHA256_HEX_RE.test(hash)) continue;
      const path = resolve(root, shard, entry);
      let mtimeMs: number;
      try {
        const s = statSync(path);
        if (!s.isFile()) continue;
        mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }
      out.push({ hash, path, mtimeMs });
    }
  }
  return out;
}

/* =====================================================================
 * Decision + executor.
 * ===================================================================== */

export interface CasGcConfig {
  /** Filesystem root the CAS PVC is mounted at; e.g. `/var/kagent/cas`. */
  readonly mountPath: string;
  /** Retention window in milliseconds. Output of `parseRetention`. */
  readonly retentionMs: number;
  /** Tick interval in milliseconds; `Math.max(60s, gc.intervalSeconds * 1000)`. */
  readonly intervalMs: number;
  /** When true, log eligible blobs but do NOT unlink. Useful for prod debugging. */
  readonly dryRun?: boolean;
}

export interface CasGcDeps {
  /** Source of truth for the reachability set. */
  readonly listAgentTasks: () => readonly AgentTask[];
  /** Wall clock — injectable so tests don't sleep. */
  readonly now?: () => number;
  /** Logger; defaults to `console.log` with the standard `[kagent-operator]` prefix. */
  readonly log?: (msg: string) => void;
}

/**
 * Per-tick result. Returned from `runOnce` so the main control loop +
 * tests can introspect what the sweep would do (or did).
 */
export interface CasGcSweepResult {
  /** Total CAS blobs discovered on disk. */
  readonly scanned: number;
  /** Blobs reachable from non-Completed AgentTasks (kept regardless of age). */
  readonly reachableSkipped: number;
  /** Blobs younger than retention (kept). */
  readonly tooFreshSkipped: number;
  /** Blobs eligible for delete (older than retention AND not reachable). */
  readonly eligible: number;
  /** Blobs actually unlinked (== eligible unless dryRun). */
  readonly deleted: number;
  /** Hashes that failed delete (unlink error logged to console). */
  readonly errors: number;
}

/**
 * Decide whether a blob should be deleted. Pure function — no I/O.
 * `now` and `retentionMs` are explicit so tests don't need a clock fake.
 */
export function shouldDelete(
  blob: CasBlob,
  reachable: ReadonlySet<string>,
  now: number,
  retentionMs: number,
): boolean {
  if (reachable.has(blob.hash)) return false;
  return now - blob.mtimeMs >= retentionMs;
}

/**
 * Run a single sweep pass. The returned `CasGcSweepResult` lets callers
 * (tests + the main loop) confirm the per-tick decisions without
 * scraping logs.
 *
 * Refuses to run when `retentionMs < MIN_RETENTION_MS` — defense in
 * depth against a typo'd `0d` in the Helm values.
 */
export function runOnce(config: CasGcConfig, deps: CasGcDeps): CasGcSweepResult {
  if (config.retentionMs < MIN_RETENTION_MS) {
    throw new Error(
      `cas-gc: refusing to sweep with retentionMs=${String(config.retentionMs)} ` +
        `(minimum ${String(MIN_RETENTION_MS)}ms; check cas.retention.default in Helm values)`,
    );
  }
  const log = deps.log ?? ((m) => console.log(m));
  const now = deps.now?.() ?? Date.now();
  const tasks = deps.listAgentTasks();
  const reachable = buildReachabilitySet(tasks);
  const blobs = walkCasBlobs(config.mountPath);

  let reachableSkipped = 0;
  let tooFreshSkipped = 0;
  let eligible = 0;
  let deleted = 0;
  let errors = 0;

  for (const blob of blobs) {
    if (reachable.has(blob.hash)) {
      reachableSkipped++;
      continue;
    }
    const age = now - blob.mtimeMs;
    if (age < config.retentionMs) {
      tooFreshSkipped++;
      continue;
    }
    eligible++;
    if (config.dryRun === true) {
      log(`[kagent-operator/cas-gc] DRY-RUN would delete ${blob.path} (age=${String(age)}ms)`);
      continue;
    }
    try {
      unlinkSync(blob.path);
      deleted++;
    } catch (err) {
      errors++;
      const reason = err instanceof Error ? err.message : String(err);
      log(`[kagent-operator/cas-gc] unlink failed: ${blob.path}: ${reason}`);
    }
  }

  log(
    `[kagent-operator/cas-gc] sweep done — scanned=${String(blobs.length)} ` +
      `reachable=${String(reachableSkipped)} fresh=${String(tooFreshSkipped)} ` +
      `eligible=${String(eligible)} deleted=${String(deleted)} errors=${String(errors)}` +
      (config.dryRun === true ? ' (dry-run)' : ''),
  );

  return {
    scanned: blobs.length,
    reachableSkipped,
    tooFreshSkipped,
    eligible,
    deleted,
    errors,
  };
}

/* =====================================================================
 * Long-running controller wrapper.
 * ===================================================================== */

export interface CasGcControllerHandle {
  /** Stop the timer; safe to call more than once. */
  stop(): void;
}

/**
 * Boot the controller: kicks off a `setInterval` calling `runOnce` every
 * `config.intervalMs`. Errors from `runOnce` are caught + logged; a
 * failed sweep does NOT crash the operator.
 *
 * Returns a handle with a `stop()` method the caller wires into the
 * operator's `onShutdown` chain in `main.ts`.
 */
export function startCasGc(config: CasGcConfig, deps: CasGcDeps): CasGcControllerHandle {
  if (config.intervalMs < MIN_RETENTION_MS) {
    throw new Error(
      `cas-gc: intervalMs (${String(config.intervalMs)}) must be >= ${String(MIN_RETENTION_MS)}`,
    );
  }
  const log = deps.log ?? ((m) => console.log(m));
  log(
    `[kagent-operator/cas-gc] started — mountPath=${config.mountPath} ` +
      `retentionMs=${String(config.retentionMs)} intervalMs=${String(config.intervalMs)}` +
      (config.dryRun === true ? ' (dry-run)' : ''),
  );

  const tick = (): void => {
    try {
      runOnce(config, deps);
    } catch (err) {
      log(
        `[kagent-operator/cas-gc] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const timer = setInterval(tick, config.intervalMs);
  // Don't keep the event loop alive on the GC timer alone — the
  // main loop's K8s watches are the substrate's liveness anchor.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
