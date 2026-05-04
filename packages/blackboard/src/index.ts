/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/blackboard` — Wave 3 / Blackboard sub-team
 * (v0.4.1-blackboard).
 *
 * Per-task-tree scratch KV on NATS JetStream. One bucket per root
 * AgentTask (`kagent-kv-<root-uid>`); GC'd on root completion + ttl.
 * Cap-gated reads + writes via `CapabilityClaims.blackboard`.
 *
 * Surface:
 *   - Bucket helpers: `bucketNameForRootUid`, `buildBucketConfig`
 *   - Operator-side manager: `BlackboardBucketManager`
 *   - Agent-pod-side client: `BlackboardClient` interface +
 *     `NatsBlackboardClient` implementation
 *   - Cap-gate predicates: `checkReadAllowed`/`checkWriteAllowed`/
 *     `checkListAllowed`/`checkAppendAllowed`
 *
 * Subject namespace: `kagent.kv.*` (per docs/WAVES.md §5.6 — Events
 * owns `kagent.events.*`; we own `kagent.kv.*`). Bucket names are
 * `kagent-kv-<root-uid>`; NATS auto-binds them to subject
 * `KV_<bucket>.>` under JetStream's KV materialized view.
 */

export {
  BLACKBOARD_BUCKET_PREFIX,
  DEFAULT_BUCKET_TTL_MS,
  DEFAULT_MAX_VALUE_BYTES,
  DEFAULT_MAX_BUCKET_BYTES,
  bucketNameForRootUid,
  rootUidFromBucketName,
  buildBucketConfig,
} from './bucket.js';
export type { BlackboardBucketConfig } from './bucket.js';

export type { BlackboardClient, BlackboardEntry } from './client.js';
export { RevisionMismatchError } from './client.js';

export { NatsBlackboardClient } from './nats-client.js';
export type { KvLike } from './nats-client.js';

export { BlackboardBucketManager } from './manager.js';
export type {
  BlackboardBucketManagerOptions,
  BlackboardLogger,
  JetStreamManagerLike,
  KvCreateOpts,
  KvHandleLike,
  KvViewsLike,
} from './manager.js';

export {
  checkReadAllowed,
  checkWriteAllowed,
  checkListAllowed,
  checkAppendAllowed,
  denyReasonToMessage,
} from './acl.js';
export type { BlackboardClaim, BlackboardDenyReason } from './acl.js';
