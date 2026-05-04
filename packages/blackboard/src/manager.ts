/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `BlackboardBucketManager` — operator-side surface for provisioning
 * and destroying NATS JetStream KV buckets per root AgentTask.
 *
 * The substrate's contract (per docs/SUBSTRATE-V1.md §3.7 + WAVES.md
 * §5.2 #1):
 *
 *   - On root AgentTask admission, the operator creates a bucket
 *     named `kagent-kv-<root-uid>` with `ttlMs` derived from the
 *     root task's runConfig (or DEFAULT_BUCKET_TTL_MS).
 *   - When the root task transitions to a terminal phase
 *     (`Completed` | `Failed` | `Cancelled`), the operator schedules
 *     bucket destruction. The bucket lives until ttl elapses so a
 *     sibling task that hasn't yet observed the terminal status can
 *     still flush its last writes; the destroy call only fires after
 *     the ttl window.
 *   - Audit emission: `blackboard.gc` event on every successful
 *     destroy. Wired in operator/main.ts; this package just emits a
 *     callback hook so the package stays loose-coupled.
 *
 * Best-effort posture: failures here log loudly but DO NOT crash the
 * operator's reconcile loop. The KV bucket is a coordination
 * primitive, not a correctness primitive — a NATS outage at create
 * time means siblings coordinate via `spawn_child_task`/`wait_for_*`
 * just like they would without the blackboard. The operator records
 * a `Status` condition (`BlackboardUnavailable`) so users see why
 * `read_blackboard` is failing, but otherwise stays running.
 */

import type { BlackboardBucketConfig } from './bucket.js';
import { bucketNameForRootUid, buildBucketConfig } from './bucket.js';

/**
 * Subset of `nats.js`'s `Views` we depend on for `kv(name, opts)`.
 * Identical to NatsBlackboardClient's narrow interface — kept as a
 * separate name here because the manager uses the SAME `views.kv`
 * call but with intent to CREATE (auto-create when bucket absent).
 *
 * In practice nats.js's `views.kv(name, opts)` is "get-or-create" by
 * design; the manager just passes a fully-populated opts object on
 * its first call so the create-on-miss path lands the right limits.
 */
export interface KvViewsLike {
  kv(name: string, opts: KvCreateOpts): Promise<KvHandleLike>;
}

/**
 * The bits of `KvOptions` we set explicitly on create. Mirror of
 * `BlackboardBucketConfig` mapped to the names the NATS server
 * expects. We avoid using `any` here so the package's public surface
 * stays type-safe; tests pass a stub that satisfies this interface.
 */
export interface KvCreateOpts {
  /** Per-key TTL in ms. NATS reaps keys older than this. */
  readonly ttl: number;
  /** Per-value byte cap; NATS rejects writes exceeding this. */
  readonly maxValueSize: number;
  /** Bucket-total byte cap. */
  readonly max_bytes: number;
  /** History depth. */
  readonly history: number;
}

/**
 * Subset of `nats.js`'s `KV` we use for `destroy()`. Kept narrow.
 */
export interface KvHandleLike {
  destroy(): Promise<boolean>;
}

/**
 * Subset of `nats.js`'s JetStream-manager-level stream API used for
 * the destroy fallback (some NATS server versions return false from
 * `kv.destroy()` instead of throwing; deleting the underlying stream
 * by name is the unconditional way to reclaim the bucket).
 */
export interface JetStreamManagerLike {
  streams: { delete(name: string): Promise<boolean> };
}

/**
 * Logger surface — same shape as `AuditPublisher`'s logger, kept
 * console-shaped so consumers don't pull in pino/winston.
 */
export interface BlackboardLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const consoleLogger: BlackboardLogger = {
  info: (m, ...a) => {
    console.log(m, ...a);
  },
  warn: (m, ...a) => {
    console.warn(m, ...a);
  },
  error: (m, ...a) => {
    console.error(m, ...a);
  },
};

export interface BlackboardBucketManagerOptions {
  /** NATS-views handle (`js.views`). */
  readonly views: KvViewsLike;
  /**
   * Optional JetStream-manager handle. When provided, `destroy()`
   * falls back to deleting the underlying stream when `kv.destroy()`
   * returns false (some server versions). Without it, we just trust
   * `kv.destroy()`.
   */
  readonly jsm?: JetStreamManagerLike;
  /** Logger override. */
  readonly logger?: BlackboardLogger;
  /**
   * Audit hook fired on every successful destroy. Wired by
   * operator/main.ts to emit `blackboard.gc`. Optional — tests omit.
   */
  readonly onDestroyed?: (info: { rootUid: string; bucketName: string }) => void;
}

/**
 * The manager. Stateless apart from the supplied `views` handle.
 * Operator wires one instance per NATS connection.
 */
export class BlackboardBucketManager {
  private readonly views: KvViewsLike;
  private readonly jsm: JetStreamManagerLike | undefined;
  private readonly logger: BlackboardLogger;
  private readonly onDestroyed:
    | ((info: { rootUid: string; bucketName: string }) => void)
    | undefined;

  constructor(opts: BlackboardBucketManagerOptions) {
    this.views = opts.views;
    this.jsm = opts.jsm;
    this.logger = opts.logger ?? consoleLogger;
    this.onDestroyed = opts.onDestroyed;
  }

  /**
   * Idempotently provision the bucket for a given root task UID.
   * `views.kv(name, opts)` is get-or-create on the NATS side; we
   * pass the desired opts unconditionally so a re-reconcile after
   * an operator restart re-applies the limits (NATS preserves
   * existing opts when the bucket exists; the second-call opts
   * are advisory).
   *
   * Returns the resolved BlackboardBucketConfig so the caller can
   * record the bucket name on AgentTask.status if desired.
   */
  async ensureBucket(
    rootUid: string,
    opts: {
      readonly ttlMs?: number;
      readonly maxValueBytes?: number;
      readonly maxBucketBytes?: number;
    } = {},
  ): Promise<BlackboardBucketConfig> {
    const config = buildBucketConfig(rootUid, opts);
    const createOpts: KvCreateOpts = {
      ttl: config.ttlMs,
      maxValueSize: config.maxValueBytes,
      max_bytes: config.maxBucketBytes,
      history: config.history,
    };
    try {
      await this.views.kv(config.name, createOpts);
      this.logger.info(
        `[kagent-blackboard] ensured bucket ${config.name} (ttlMs=${String(config.ttlMs)}, maxBytes=${String(config.maxBucketBytes)})`,
      );
      return config;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Best-effort: log loudly but DO NOT throw. Caller (reconciler)
      // can record a status condition; the agent loop continues
      // running without blackboard tools (cap-gate denies on absent
      // bucket env, so the loop sees a clean policy_denied).
      this.logger.error(`[kagent-blackboard] ensureBucket(${config.name}) failed: ${msg}`);
      throw err;
    }
  }

  /**
   * Destroy the bucket for a given root task UID. Idempotent: a
   * destroy of a non-existent bucket is treated as success (the
   * goal-state — bucket gone — is achieved either way).
   *
   * The audit hook fires AFTER the destroy succeeds; on failure the
   * hook does NOT fire (the operator's caller logs the error and
   * reschedules per its own backoff).
   */
  async destroyBucket(rootUid: string): Promise<{ destroyed: boolean }> {
    const bucketName = bucketNameForRootUid(rootUid);
    let destroyed = false;
    try {
      // We have to bind to the bucket before destroying it. nats.js'
      // views.kv(name) get-or-creates; we want the get-only path. The
      // safest portable path is: bind, attempt destroy, fall back to
      // jsm.streams.delete(`KV_<bucketName>`) when kv.destroy() returns
      // false.
      const handle = await this.views.kv(bucketName, {
        ttl: 0,
        maxValueSize: 0,
        max_bytes: 0,
        history: 1,
      });
      destroyed = await handle.destroy();
      if (!destroyed && this.jsm !== undefined) {
        // Fallback: delete the underlying stream.
        try {
          destroyed = await this.jsm.streams.delete(`KV_${bucketName}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(msg) || /no.*stream/i.test(msg)) {
            // Already gone — treat as success.
            destroyed = true;
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg) || /no.*stream/i.test(msg) || /not\s*exist/i.test(msg)) {
        // Bucket already gone (TTL reaped it, manual delete, etc.).
        // Idempotent success.
        destroyed = true;
      } else {
        this.logger.error(`[kagent-blackboard] destroyBucket(${bucketName}) failed: ${msg}`);
        throw err;
      }
    }
    if (destroyed) {
      this.logger.info(`[kagent-blackboard] destroyed bucket ${bucketName}`);
      if (this.onDestroyed !== undefined) {
        try {
          this.onDestroyed({ rootUid, bucketName });
        } catch (err) {
          // Audit hook is best-effort — never crash the destroy path.
          this.logger.warn(
            `[kagent-blackboard] onDestroyed hook threw for ${bucketName}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return { destroyed };
  }
}
