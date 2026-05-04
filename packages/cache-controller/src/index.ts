/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/cache-controller` — sha256-keyed per-Agent persistent caches.
 *
 * Wave 3 / Cache sub-team (v0.4.2-cache). See docs/WAVES.md §5.3 +
 * docs/SUBSTRATE-V1.md §3.5 (CAS — same sharded sha256 layout, distinct
 * reachability semantics).
 *
 * The package is pure-functional: key derivation (`deriveCacheKey`),
 * lookup (`lookupCacheEntries`), and restore/save plumbing
 * (`buildCacheRestoreInitContainer`, `buildCacheSaveCommand`) take all
 * I/O via injected callbacks. The operator's reconciler does the K8s
 * API + filesystem calls.
 */

export {
  cacheStorageRelPath,
  cacheUri,
  DEFAULT_KEY_SUGAR,
  DEFAULT_KEY_TEMPLATE,
  deriveCacheKey,
  renderKeyTemplate,
} from './key.js';

export {
  buildCacheRestoreInitContainer,
  buildCacheSaveCommand,
  CACHE_PVC_MOUNT_PATH,
  CACHE_PVC_VOLUME_NAME,
  CACHE_SLOT_VOLUME_PREFIX,
  DEFAULT_CACHE_HELPER_IMAGE,
  lookupCacheEntries,
} from './restore.js';
export type {
  BuildCacheRestoreInput,
  BuildCacheSaveInput,
  CacheRestoreResult,
  LookupCacheEntriesInput,
} from './restore.js';

export type {
  AgentLike,
  AgentTaskLike,
  CacheDeclLike,
  CacheLookupResult,
  KeyDerivationContext,
} from './types.js';
