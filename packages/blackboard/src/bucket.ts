/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Per-task-tree blackboard bucket — name derivation + lifecycle.
 *
 * Each AgentTask root gets ONE NATS JetStream KV bucket. The substrate
 * provisions the bucket on root-task admission and destroys it on root-
 * task completion + ttl. Children spawned under the same root share the
 * same bucket, so sibling agents can coordinate via task-tree-scoped
 * KV without re-discovering each other.
 *
 * Bucket name convention: `kagent-kv-<root-task-uid>`.
 *
 * The UID is K8s-assigned (RFC 4122 lower-case hex with hyphens), which
 * is already a legal NATS KV bucket name (the underlying stream is
 * `KV_<bucket-name>` and JetStream stream names accept `[A-Za-z0-9_-]`).
 * Truncation isn't required: K8s UIDs are 36 chars; with the
 * `kagent-kv-` prefix the bucket name lands at 46 chars, well under the
 * 255-char NATS limit.
 *
 * Subject namespace: NATS auto-binds the bucket to subject `KV_<bucket>.>`.
 * This sub-namespace lives under the broader `kagent.kv.*` umbrella
 * agreed in docs/WAVES.md §5.6 (Events owns `kagent.events.*`; we own
 * `kagent.kv.*`). Production deploys configure JetStream so the audit
 * stream does NOT bind to `kagent.kv.>` — bucket churn would otherwise
 * pollute the audit log.
 */

/**
 * Bucket-name prefix for every blackboard. Stable so kubectl users +
 * `nats kv ls` operators can grep for substrate-managed buckets.
 */
export const BLACKBOARD_BUCKET_PREFIX = 'kagent-kv-';

/**
 * Default TTL when a root AgentTask doesn't specify one. 24h matches
 * the Workspace primitive's default (per docs/SUBSTRATE-V1.md §3.4)
 * so a typical pipeline has the same scratch-FS + scratch-KV horizon.
 */
export const DEFAULT_BUCKET_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on a single value's size in bytes. Keeps a runaway agent
 * from filling the bucket with multi-megabyte JSON. Aligns with NATS
 * server defaults (1 MiB default `max_payload`); per-bucket
 * `maxValueSize` is set to this on create.
 */
export const DEFAULT_MAX_VALUE_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * Hard cap on the total bucket bytes. 64 MiB lands in the same bracket
 * as Workspace defaults — large enough for sibling-coordinated state,
 * small enough that GC isn't a forensic event.
 */
export const DEFAULT_MAX_BUCKET_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Derive the bucket name from a root AgentTask UID. Throws on empty
 * input rather than producing the degenerate `kagent-kv-` prefix —
 * an empty UID is always a substrate bug (K8s assigns the UID before
 * any reconciler sees the object).
 */
export function bucketNameForRootUid(rootUid: string): string {
  if (typeof rootUid !== 'string' || rootUid.length === 0) {
    throw new Error('bucketNameForRootUid: rootUid must be a non-empty string');
  }
  return `${BLACKBOARD_BUCKET_PREFIX}${rootUid}`;
}

/**
 * Inverse of `bucketNameForRootUid`. Returns the UID when the input
 * matches the prefix; returns null for any non-blackboard bucket name.
 * Used by the GC sweeper to filter buckets it manages from third-party
 * KV buckets sharing the same NATS server.
 */
export function rootUidFromBucketName(bucketName: string): string | null {
  if (!bucketName.startsWith(BLACKBOARD_BUCKET_PREFIX)) return null;
  const rest = bucketName.slice(BLACKBOARD_BUCKET_PREFIX.length);
  return rest.length > 0 ? rest : null;
}

/**
 * Configuration the bucket factory passes to NATS' `views.kv(name, opts)`.
 * Fields are the subset of `KvOptions` we set explicitly; everything
 * else defaults per the NATS server config. Exported so tests can
 * assert exact creation parameters.
 */
export interface BlackboardBucketConfig {
  readonly name: string;
  readonly ttlMs: number;
  readonly maxValueBytes: number;
  readonly maxBucketBytes: number;
  /**
   * History depth — how many revisions to keep per key. Set to 1 (no
   * history) since the blackboard is task-tree-scoped scratch state;
   * the audit log is the durable record, not the bucket. Reduces
   * disk footprint linearly.
   */
  readonly history: number;
}

/**
 * Build a default bucket config for a given root AgentTask UID +
 * optional TTL. The TTL is the root task's `runConfig.timeoutSeconds`
 * coerced to ms with a default fallback. Caller (operator) consults
 * the AgentTask spec; this helper just normalizes.
 */
export function buildBucketConfig(
  rootUid: string,
  opts: {
    readonly ttlMs?: number;
    readonly maxValueBytes?: number;
    readonly maxBucketBytes?: number;
  } = {},
): BlackboardBucketConfig {
  return {
    name: bucketNameForRootUid(rootUid),
    ttlMs: opts.ttlMs !== undefined && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_BUCKET_TTL_MS,
    maxValueBytes:
      opts.maxValueBytes !== undefined && opts.maxValueBytes > 0
        ? opts.maxValueBytes
        : DEFAULT_MAX_VALUE_BYTES,
    maxBucketBytes:
      opts.maxBucketBytes !== undefined && opts.maxBucketBytes > 0
        ? opts.maxBucketBytes
        : DEFAULT_MAX_BUCKET_BYTES,
    history: 1,
  };
}
