/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Shared types for `@kagent/cache-controller`. Kept narrow + structural
 * so the package never imports `@kagent/operator` (avoids cycle: the
 * operator depends on this package, not the other way around).
 *
 * Callers (the operator reconciler) project their richer CRD shapes onto
 * these structural types when invoking `deriveCacheKey` /
 * `buildCacheRestoreInitContainer` / `buildCacheSaveSidecar`.
 */

/**
 * Structural shape of a single `Agent.spec.caches[]` entry. Mirrors
 * `CacheDecl` declared in the operator's CRD types.
 */
export interface CacheDeclLike {
  /** Per-Agent stable identifier; second segment of `cache://sha256:<key>/<name>`. */
  readonly name: string;
  /**
   * Template string. `{input_artifact_hashes}` / `{image_digest}` /
   * `{model_name}` interpolate; literal text passes through. The literal
   * `"default"` is sugar for the canonical recipe (see `key.ts`).
   */
  readonly key: string;
  /** Container path the cache contents land at on restore. */
  readonly mountPath: string;
}

/**
 * Structural shape of an Agent the cache-controller cares about.
 * Mirrors a subset of `Agent.spec` from the operator's CRD types.
 */
export interface AgentLike {
  readonly spec: {
    /** Model id (LiteLLM-style with provider prefix per CLAUDE.md). */
    readonly model: string;
    /** v0.4.2 cache slot declarations. */
    readonly caches?: readonly CacheDeclLike[];
  };
}

/**
 * Structural shape of the AgentTask fields the key-derivation cares
 * about. We need only the bound input refs; everything else (UID,
 * status) is irrelevant to the key.
 */
export interface AgentTaskLike {
  readonly spec: {
    /**
     * Bound inputs. Each entry's `from.taskUid+output` may eventually
     * resolve to a `cas://sha256:<hex>/...` ref (looked up in the
     * AgentTask informer cache); the cache-controller's caller passes
     * the resolved hashes through `KeyDerivationContext.inputArtifactHashes`.
     */
    readonly inputs?: readonly {
      readonly name: string;
      readonly from: unknown;
    }[];
  };
}

/**
 * Per-binding side info the caller hands the key-derivation. Splits
 * the `inputArtifactHashes` resolution out of the key derivation so
 * the package stays pure-functional + trivially testable: callers do
 * the I/O (ref-following / sha256 verify), then pass the hash list in.
 */
export interface KeyDerivationContext {
  /**
   * The Agent's container image digest. Substrate-stamped at admission
   * (the operator already resolves the image when it builds the Job
   * spec). The caller's responsibility to compute / look up; the cache
   * key derivation never reaches into K8s.
   *
   * MAY be empty string for v0.1 Agents that don't pin a digest — the
   * key derivation handles it deterministically (empty stays empty).
   */
  readonly imageDigest: string;
  /**
   * sha256 hex hashes of every `kind: 'artifact'` input bound on the
   * task. Order is irrelevant — the derivation sorts lexicographically
   * before joining (so the key is stable across reorders of an
   * AgentTask's inputs[]).
   *
   * Empty array when no artifact inputs exist; an empty `{input_artifact_hashes}`
   * substitution renders as the empty string.
   */
  readonly inputArtifactHashes: readonly string[];
}

/**
 * Output of the per-cache restore decision. Used by the operator to
 * decide whether to:
 *   - hit  → emit a `cache.hit` audit + add an init-container that
 *            copies bytes from `<pvcMount>/cache/sha256/<2>/<62>` onto
 *            the Agent's declared `mountPath`.
 *   - miss → emit a `cache.miss` audit + run the agent cold (no
 *            init-container; the agent's mountPath is empty on first
 *            invocation, populated lazily).
 */
export type CacheLookupResult =
  | { readonly outcome: 'hit'; readonly key: string; readonly storageRelPath: string }
  | { readonly outcome: 'miss'; readonly key: string };
