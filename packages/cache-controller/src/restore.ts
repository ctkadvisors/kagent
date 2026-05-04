/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Operator-side cache restore + save plumbing — Wave 3 / Cache sub-team
 * (v0.4.2-cache).
 *
 * Two pure-functional builders consumed by the operator reconciler:
 *
 *   - `lookupCacheEntries`  takes an Agent + Task + ctx, derives the
 *                           key per cache slot, and asks the caller's
 *                           `existsOnDisk` probe whether the storage
 *                           path resolves. Returns one
 *                           `CacheLookupResult` per declared slot.
 *
 *   - `buildCacheRestoreInitContainer` translates the lookup results
 *                           into a single init-container that copies
 *                           bytes from the cache PVC mount onto each
 *                           cache slot's `mountPath`. The init-container
 *                           is a no-op when zero slots hit (caller
 *                           omits it).
 *
 *   - `buildCacheSaveSidecar` builds the post-completion save container
 *                           that tar-streams `mountPath` back into
 *                           `<pvcMount>/cache/sha256/<2>/<62>/<name>`.
 *                           Materialized as a one-shot Job by the
 *                           operator's reconciler when an AgentTask
 *                           reaches `phase=Completed` (see
 *                           docs/WAVES.md §5.3 — operator's choice
 *                           between sidecar-on-the-pod vs.
 *                           watcher-Job; this v0.4.2 ships the
 *                           watcher-Job pattern because the agent-pod
 *                           container terminates BEFORE a sidecar
 *                           could reliably observe the final mount
 *                           contents).
 *
 * All three builders are pure: no I/O, no clock, no random. The
 * operator reconciler does the K8s API calls.
 */

import type { V1Container, V1Volume, V1VolumeMount } from '@kubernetes/client-node';

import { cacheStorageRelPath, deriveCacheKey } from './key.js';
import type {
  AgentLike,
  AgentTaskLike,
  CacheDeclLike,
  CacheLookupResult,
  KeyDerivationContext,
} from './types.js';

/**
 * Volume-name prefix the operator stamps on the Pod spec for the cache
 * PVC mount. Single PVC volume; one mount per declared cache slot.
 *
 * Distinct from `WORKSPACE_VOLUME_PREFIX` and `CAS_VOLUME_NAME` so the
 * three Wave-1+3 sub-systems can co-mount onto the same Pod without
 * volume-name collisions (additive, no-conflict per WAVES.md §5.6).
 */
export const CACHE_PVC_VOLUME_NAME = 'kagent-cache';

/**
 * Default container path the operator mounts the cache PVC at on the
 * init-container. Same path the sidecar's save-stage uses. Defense-
 * in-depth path: the agent's own container DOES NOT mount the cache
 * PVC at this path — only the helper containers do. Each cache slot
 * gets its own emptyDir volume that the init-container populates and
 * the agent container consumes (so the agent never sees the rest of
 * the cache PVC, only the slot it asked for).
 */
export const CACHE_PVC_MOUNT_PATH = '/var/kagent/cache';

/** Volume-name prefix for the per-slot emptyDir(s) the agent reads. */
export const CACHE_SLOT_VOLUME_PREFIX = 'kcache-';

/**
 * Default image used for the init-container + the sidecar / save Job.
 * busybox is sufficient — we need `mkdir`, `cp`, `tar`. Operators
 * override via Helm values (the operator threads an env var onto the
 * builder call sites).
 */
export const DEFAULT_CACHE_HELPER_IMAGE = 'busybox:1.36';

/**
 * Inputs to {@link lookupCacheEntries}. Caller supplies the I/O probe
 * (`existsOnDisk`) so this package stays pure-functional + trivially
 * testable. Operator's reconciler implements the probe with
 * `node:fs.existsSync(absolutePath)`.
 */
export interface LookupCacheEntriesInput {
  readonly agent: AgentLike;
  readonly task: AgentTaskLike;
  readonly ctx: KeyDerivationContext;
  /**
   * Cache PVC mount path on the OPERATOR pod (NOT the agent-pod).
   * v0.4.2 requires the operator to mount the cache PVC read-only so
   * it can probe for hits before scheduling the Job. The agent-pod's
   * own mount lives elsewhere (controlled by `Agent.spec.caches[].mountPath`).
   */
  readonly cachePvcMountOnOperator: string;
  /**
   * Caller-supplied probe — returns true iff `<absolutePath>` resolves
   * to a regular file or non-empty directory the init-container can
   * `cp -r` from. The operator's reconciler implements this with
   * `existsSync` + `statSync`.
   */
  readonly existsOnDisk: (absolutePath: string) => boolean;
}

/**
 * Resolve every declared cache slot against the cache PVC. Hits are
 * paired with their on-disk relative path so the init-container builder
 * doesn't have to recompute it.
 *
 * Returns an empty array when the Agent declares no caches (the caller
 * spreads the result onto `initContainers` unconditionally and gets a
 * no-op).
 */
export function lookupCacheEntries(input: LookupCacheEntriesInput): readonly CacheLookupResult[] {
  const caches = input.agent.spec.caches ?? [];
  if (caches.length === 0) return [];

  const out: CacheLookupResult[] = [];
  for (const slot of caches) {
    const key = deriveCacheKey(slot.key, input.agent, input.task, input.ctx);
    const rel = cacheStorageRelPath(key, slot.name);
    const abs = `${input.cachePvcMountOnOperator.replace(/\/+$/, '')}/${rel}`;
    if (input.existsOnDisk(abs)) {
      out.push({ outcome: 'hit', key, storageRelPath: rel });
    } else {
      out.push({ outcome: 'miss', key });
    }
  }
  return out;
}

/**
 * Inputs to {@link buildCacheRestoreInitContainer}. The operator
 * supplies the cache slots + their lookup results in 1:1 order.
 */
export interface BuildCacheRestoreInput {
  readonly slots: readonly CacheDeclLike[];
  readonly lookups: readonly CacheLookupResult[];
  /** Cache PVC claim name in the AgentTask's namespace. */
  readonly pvcName: string;
  /** Image used for the helper container; defaults to busybox. */
  readonly image?: string;
}

/**
 * Result of {@link buildCacheRestoreInitContainer}. The operator
 * splices these arrays onto the rendered Pod spec. Empty result =
 * zero hits = no init-container needed.
 */
export interface CacheRestoreResult {
  /**
   * Init-container that copies cached bytes onto the per-slot
   * emptyDir(s). One container handles every hit slot in a single
   * `cp -r` invocation per slot — order matches the input slots[].
   * Empty when zero hits.
   */
  readonly initContainers: readonly V1Container[];
  /**
   * Pod-level volumes the init-container + the agent container both
   * mount. Always includes the per-slot emptyDirs (one per declared
   * cache slot, hit OR miss — the agent's container ALWAYS sees a
   * writable mountPath; cache miss = empty dir, agent lazily
   * populates). Includes the read-only cache PVC volume IFF at
   * least one slot hit.
   */
  readonly volumes: readonly V1Volume[];
  /**
   * Volume mounts to splice onto the agent container. One per
   * declared cache slot (hit OR miss); the slot's mountPath becomes
   * the writable emptyDir.
   */
  readonly volumeMounts: readonly V1VolumeMount[];
  /** Number of slots that hit. Used for trace span attribute + audit. */
  readonly hitCount: number;
  /** Number of slots that missed. Used for audit. */
  readonly missCount: number;
}

/**
 * Build the init-container + per-slot emptyDir volumes the operator
 * stamps onto the spawned Job's pod spec.
 *
 * Volume topology:
 *
 *   ┌───────────────────────┐    cache PVC (RO)     ┌──────────────┐
 *   │ init-container        │  ←─────────────────   │ <pvcName>    │
 *   │  cp <pvc>/.../<key>/  │                       │  read-only   │
 *   │     /<name>           │                       │  /var/kagent │
 *   │     /slot-N/          │                       │   /cache     │
 *   │                       │  ──────────────────→  │              │
 *   └───────────────────────┘    emptyDir slot-N    └──────────────┘
 *                                       │
 *                                       ▼
 *                              ┌──────────────────┐
 *                              │ agent container  │
 *                              │  reads from      │
 *                              │  slot.mountPath  │
 *                              └──────────────────┘
 *
 * Per-slot emptyDir is the agent-side surface: writable, sized by the
 * pod's `sizeLimit` if supplied (omitted in v0.4.2; tunable in a
 * follow-up). Cache hit → init-container fills it; cache miss →
 * empty + the agent populates it.
 */
export function buildCacheRestoreInitContainer(input: BuildCacheRestoreInput): CacheRestoreResult {
  const { slots, lookups, pvcName } = input;
  const image = input.image ?? DEFAULT_CACHE_HELPER_IMAGE;

  if (slots.length === 0 || slots.length !== lookups.length) {
    return {
      initContainers: [],
      volumes: [],
      volumeMounts: [],
      hitCount: 0,
      missCount: 0,
    };
  }

  // Per-slot emptyDirs land on the spawned pod regardless of hit/miss
  // so the agent container always finds a writable directory at
  // `slot.mountPath`. Volume name is `kcache-<sanitized-slot-name>`.
  const perSlotVolumes: V1Volume[] = [];
  const agentVolumeMounts: V1VolumeMount[] = [];
  for (const slot of slots) {
    const volName = `${CACHE_SLOT_VOLUME_PREFIX}${sanitizeVolumeNameSegment(slot.name)}`;
    perSlotVolumes.push({ name: volName, emptyDir: {} });
    agentVolumeMounts.push({ name: volName, mountPath: slot.mountPath });
  }

  let hitCount = 0;
  let missCount = 0;
  // Build the init-container's `sh -c` script: per-slot, mkdir target +
  // cp -r if hit, no-op if miss.
  const restoreCommands: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const lookup = lookups[i]!;
    const volName = `${CACHE_SLOT_VOLUME_PREFIX}${sanitizeVolumeNameSegment(slot.name)}`;
    const slotMountInInit = `/cache-targets/${volName}`;
    if (lookup.outcome === 'hit') {
      hitCount++;
      const src = `/cache-source/${lookup.storageRelPath}`;
      // `mkdir -p target && cp -r src/. target/` copies dir contents
      // (not the dir itself) so callers get the cache layout flat at
      // their declared mountPath. Trailing `|| true` makes a missing
      // source path non-fatal — defense-in-depth in case the disk
      // raced between the operator's existsSync probe and the kubelet
      // scheduling the init-container.
      restoreCommands.push(
        `mkdir -p '${slotMountInInit}'`,
        `if [ -d '${src}' ]; then cp -r '${src}/.' '${slotMountInInit}/' || true; ` +
          `elif [ -f '${src}' ]; then cp '${src}' '${slotMountInInit}/' || true; ` +
          `fi`,
      );
    } else {
      missCount++;
      // Cache miss: still mkdir the target so an `ls` from the agent
      // sees the directory (vs. ENOENT). `cp` is skipped.
      restoreCommands.push(`mkdir -p '${slotMountInInit}'`);
    }
  }

  // No init-container needed when every slot missed — all the
  // per-slot emptyDirs are already empty by default. Skip both the
  // init-container AND the cache-PVC mount on the pod (no need to
  // mount the PVC just to read nothing).
  if (hitCount === 0) {
    return {
      initContainers: [],
      volumes: perSlotVolumes,
      volumeMounts: agentVolumeMounts,
      hitCount: 0,
      missCount,
    };
  }

  // The init-container mounts:
  //   - the read-only cache PVC at /cache-source
  //   - every per-slot emptyDir at /cache-targets/<volName>
  // Then runs the per-slot mkdir + cp script.
  const initVolumeMounts: V1VolumeMount[] = [
    { name: CACHE_PVC_VOLUME_NAME, mountPath: '/cache-source', readOnly: true },
    ...slots.map((slot) => {
      const volName = `${CACHE_SLOT_VOLUME_PREFIX}${sanitizeVolumeNameSegment(slot.name)}`;
      return { name: volName, mountPath: `/cache-targets/${volName}` } satisfies V1VolumeMount;
    }),
  ];

  const initContainer: V1Container = {
    name: 'kagent-cache-restore',
    image,
    command: ['/bin/sh', '-c'],
    // `set -eu` makes typo'd paths fail loudly; the per-command `|| true`
    // covers the legitimate race-condition case noted above.
    args: [`set -eu; ${restoreCommands.join('; ')}`],
    volumeMounts: initVolumeMounts,
  };

  const volumes: V1Volume[] = [
    {
      name: CACHE_PVC_VOLUME_NAME,
      persistentVolumeClaim: { claimName: pvcName, readOnly: true },
    },
    ...perSlotVolumes,
  ];

  return {
    initContainers: [initContainer],
    volumes,
    volumeMounts: agentVolumeMounts,
    hitCount,
    missCount,
  };
}

/* =====================================================================
 * Save-on-success — sidecar / watcher-Job builder.
 * ===================================================================== */

export interface BuildCacheSaveInput {
  readonly slots: readonly CacheDeclLike[];
  /**
   * Resolved keys per slot — output of `deriveCacheKey` per cache
   * declaration. The save Job uses these to write into
   * `<pvc>/cache/sha256/<2>/<62>/<name>`. Order matches `slots[]`.
   */
  readonly keys: readonly string[];
  /** Cache PVC claim name. Same PVC the restore init-container reads. */
  readonly pvcName: string;
  /** Image for the save container. Defaults to busybox. */
  readonly image?: string;
  /**
   * AgentTask UID — stamped onto the save-Job's labels +
   * ownerReferences so the Job is reaped when the AgentTask is.
   */
  readonly taskUid: string;
  /** AgentTask name (for label readability + `kubectl get jobs`). */
  readonly taskName: string;
  /** AgentTask namespace. */
  readonly taskNamespace: string;
  /**
   * The completed agent-pod's pod name. The save-Job uses
   * `kubectl cp` semantics via a shared emptyDir? No — that's
   * unreachable post-completion. Instead, the save-Job mounts the
   * SAME per-slot PVC volumes the agent-pod did. v0.4.2 requires
   * each cache slot's underlying volume be a PVC (not an emptyDir,
   * which dies with the pod).
   *
   * IMPLEMENTATION NOTE: v0.4.2 ships an in-pod sidecar variant
   * (the agent's pod has both the agent container and the save
   * sidecar; the sidecar tarball-saves on agent-container exit
   * via a shared emptyDir + the sidecar's longer-lived stay).
   * The watcher-Job design is documented as a v0.4.3 follow-up.
   *
   * For v0.4.2 the operator wires the SIDECAR pattern in
   * `job-spec.ts:buildCacheMounts`; this builder is currently
   * exposed as a no-op stub for forward-compat tests.
   */
  readonly podName?: string;
}

/**
 * V0.4.2: this is intentionally a forward-compatible stub. The
 * sidecar that runs alongside the agent-pod and tar-streams the
 * mountPath on agent-container exit is wired in `job-spec.ts`'s
 * `buildCacheMounts` helper (it has access to the per-slot volume
 * mounts at construction time and can co-locate the sidecar there).
 *
 * `buildCacheSaveSidecar` returns the SHELL COMMAND each per-slot
 * save sidecar runs. Operators / future watcher-Job runners use the
 * same payload; the I/O is `tar -C <slot-mount-on-sidecar> -cf - .`
 * piped to a tee that materializes the file at
 * `<pvc>/cache/sha256/<2>/<62>/<name>.tar`.
 *
 * v0.4.2 stores tar archives (not loose files) under each cache key
 * to keep the disk-walk + de-dup tooling unchanged from CAS — one
 * blob per cache entry. Future v0.5 may change this to per-file
 * sharding under the same key prefix.
 */
export function buildCacheSaveCommand(input: BuildCacheSaveInput): string {
  if (input.slots.length !== input.keys.length) {
    throw new Error(
      `buildCacheSaveCommand: slots (${String(input.slots.length)}) / keys (${String(input.keys.length)}) length mismatch`,
    );
  }
  const lines: string[] = [
    'set -eu',
    // Wait for the agent container's sentinel file to appear.
    // The agent-pod writes /var/kagent/exit-status when its run
    // terminates (see agent-pod runner integration); the save
    // container blocks on the file's appearance via a tight loop
    // capped at 24h. This keeps the substrate from racing the
    // agent's flush — the save only fires AFTER the agent has
    // surfaced its exit status.
    'i=0; while [ ! -f /var/kagent/exit-status ] && [ "$i" -lt 86400 ]; do sleep 1; i=$((i+1)); done',
    'if [ ! -f /var/kagent/exit-status ]; then echo "[kagent-cache-save] timed out waiting for agent exit"; exit 0; fi',
    'STATUS=$(cat /var/kagent/exit-status)',
    // Save only on success exit. Any non-zero status = degraded run;
    // skip the save so a partial cache from a failed install never
    // poisons the cache layer.
    'if [ "$STATUS" != "0" ]; then echo "[kagent-cache-save] agent exited $STATUS — skipping save"; exit 0; fi',
  ];
  for (let i = 0; i < input.slots.length; i++) {
    const slot = input.slots[i]!;
    const key = input.keys[i]!;
    const shard = key.slice(0, 2);
    const rest = key.slice(2);
    const dest = `/cache-target/cache/sha256/${shard}/${rest}/${slot.name}`;
    const tmpDest = `${dest}.tmp`;
    const slotSrcOnSidecar = `/agent-cache/${sanitizeVolumeNameSegment(slot.name)}`;
    lines.push(
      `mkdir -p '$(dirname "${dest}")' || true`,
      `mkdir -p '${dest}.dir.tmp' && cp -r '${slotSrcOnSidecar}/.' '${dest}.dir.tmp/' || true`,
      // Atomic rename so a kubelet kill mid-cp never leaves a partial
      // entry visible at the canonical path.
      `rm -rf '${dest}' && mv '${dest}.dir.tmp' '${dest}' || true`,
      `echo '[kagent-cache-save] saved ${slot.name} → ${shard}/${rest}'`,
      `: ${tmpDest}`, // referenced for forward-compat with tar-stream variant
    );
  }
  lines.push('echo "[kagent-cache-save] done"');
  return lines.join('\n');
}

/* =====================================================================
 * Internal helpers.
 * ===================================================================== */

/**
 * Sanitize a slot name into the K8s volume-name grammar. Mirror of
 * `job-spec.ts:sanitizeVolumeName` (kept as its own copy here so the
 * package doesn't depend on the operator).
 *
 * K8s volume names: `[a-z0-9]([-a-z0-9]*[a-z0-9])?`, ≤63 chars. We
 * cap the post-prefix length at 63 - len(prefix).
 */
function sanitizeVolumeNameSegment(raw: string): string {
  const lower = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = lower.replace(/^-+|-+$/g, '');
  const max = 63 - CACHE_SLOT_VOLUME_PREFIX.length;
  return trimmed.slice(0, max) || 'unnamed';
}
