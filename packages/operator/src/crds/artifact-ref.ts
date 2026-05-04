/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `ArtifactRef` — substrate-defined handle for outputs that don't fit
 * inside `AgentTask.status.result.content`. See `docs/ARTIFACTS.md` for
 * the full design rationale; this file is the v0.1 status-reference-only
 * surface (no writer, no PVC mount, no MinIO client — those land in the
 * next slice). Lives in its own file (rather than `crds/types.ts`) to
 * keep the merge-conflict surface minimal with parallel workstreams.
 *
 * Refs are written by the agent loop end-of-run and read by downstream
 * consumers (operator, Workbench, sibling AgentTasks). The byte payload
 * lives in a backend addressed by `uri`; etcd carries only the metadata.
 *
 * v0.1 backend is a shared RWX PVC (`pvc://`); v0.2+ may swap to MinIO
 * (`s3://`/`minio://`) or HTTP-presigned (`http://`/`https://`) with no
 * change to this type. Agents MUST treat `uri` as opaque and round-trip
 * through `@kagent/agent-loop` artifact helpers (added in the next slice).
 */

/**
 * Reference to an opaque byte payload produced by an agent run. Field
 * set is intentionally minimal — the only required field is `uri`;
 * everything else is metadata the writer is encouraged but not forced
 * to populate (forward-compat for backends that don't compute checksum
 * server-side, etc.).
 */
export interface ArtifactRef {
  /**
   * Backend-addressable URI. Substrate-defined schemes:
   *   - `cas://sha256:<hex>/<name>`                  (v0.2.2+, content-addressed; identity = hash(bytes))
   *   - `pvc://kagent-artifacts/<task-uid>/<name>`  (v0.1, shared PVC, deprecated; back-compat for in-flight artifacts)
   *   - `inline://sha256:<hex>`                      (v0.1, NOT persisted; bytes live in `status.result.content`)
   *   - `s3://<bucket>/<task-uid>/<name>`           (v0.3, MinIO/S3)
   *   - `minio://<bucket>/<task-uid>/<name>`        (v0.3, MinIO alias)
   *   - `http(s)://...`                              (v0.3, presigned)
   * Treat as opaque at the call site; use `parseArtifactUri` (legacy)
   * or `parseUri` (CAS-aware) to inspect.
   *
   * Persistence contract: any scheme EXCEPT `inline://` is followable
   * to durable bytes; `inline://` is content-addressed only, never
   * durable.
   *
   * Identity contract (v0.2.2-cas): for `cas://sha256:<hex>/...` URIs,
   * `<hex>` = sha256(bytes). Two AgentTasks producing identical bytes
   * produce ONE stored object — re-running the task replays the cached
   * trace without an LLM call. Pattern: Bazel remote cache + Nix store
   * + Git pack files.
   */
  readonly uri: string;

  /** RFC 6838 media type. e.g. `text/markdown`, `image/png`, `text/x-diff`, `application/json`. */
  readonly mediaType?: string;

  /** Byte count at write time. Sanity check; re-read may differ if backend mutated. */
  readonly sizeBytes?: number;

  /** Lowercase-hex digest, prefixed with the algorithm. Always `sha256:` in v0.1. */
  readonly checksum?: string;

  /** Human-readable label / stable name within the producing task. */
  readonly name?: string;

  /** RFC 3339 timestamp set by the writer. */
  readonly producedAt?: string;

  /**
   * v0.2.2-cas — bare lowercase-hex sha256 of the bytes (NO algorithm
   * prefix; that's `checksum`). Required for `pvc://` and `cas://`
   * URIs; absent for `inline://` (which embeds the hash in the URI
   * path itself).
   *
   * The `read_artifact` built-in tool uses this to verify integrity:
   * any byte returned for a CAS URI must hash to its `contentHash`.
   * Mismatch = corruption or tampering = error returned to the agent
   * loop, never silent.
   */
  readonly contentHash?: string;
}

/**
 * Narrow type guard for `ArtifactRef`. Accepts any object with a
 * non-empty string `uri`; optional fields are validated only when present
 * so that future backends can attach extra metadata without tripping the
 * guard. Use at trust boundaries (e.g. when status is read back from the
 * API server as `unknown`).
 */
export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.uri !== 'string' || v.uri.length === 0) return false;
  if (v.mediaType !== undefined && typeof v.mediaType !== 'string') return false;
  if (v.sizeBytes !== undefined) {
    if (typeof v.sizeBytes !== 'number' || !Number.isFinite(v.sizeBytes) || v.sizeBytes < 0) {
      return false;
    }
  }
  if (v.checksum !== undefined && typeof v.checksum !== 'string') return false;
  if (v.name !== undefined && typeof v.name !== 'string') return false;
  if (v.producedAt !== undefined && typeof v.producedAt !== 'string') return false;
  if (v.contentHash !== undefined && typeof v.contentHash !== 'string') return false;
  return true;
}

/* =====================================================================
 * URI helpers — pure functions over the substrate-defined scheme set.
 * ===================================================================== */

/** Default PVC name configured at operator deploy-time. */
export const DEFAULT_ARTIFACT_PVC = 'kagent-artifacts';

/**
 * Build the canonical v0.1 PVC URI for an artifact.
 *
 *   pvcUri('9b1a8c4e-research', 'digest.md')
 *     → 'pvc://kagent-artifacts/9b1a8c4e-research/digest.md'
 *
 * @deprecated v0.2.2-cas. Use `casUri(contentHash, name)` for new
 * writes. `pvcUri` is kept for one release of back-compat so any
 * artifact written under the v0.1 path stays readable; new writes go
 * to CAS-keyed paths via `casUri` and the file layout
 * `<mountPath>/cas/sha256/<first-2-hex>/<remaining-62-hex>`.
 *
 * `name` may include forward slashes for nesting (e.g.
 * `screenshots/01.png`) but never a leading slash and never `..`.
 */
export function pvcUri(taskUid: string, name: string, pvc: string = DEFAULT_ARTIFACT_PVC): string {
  if (!taskUid || taskUid.length === 0) {
    throw new Error('pvcUri: taskUid required');
  }
  if (!name || name.length === 0) {
    throw new Error('pvcUri: name required');
  }
  if (name.startsWith('/')) {
    throw new Error('pvcUri: name must not begin with "/"');
  }
  if (name.split('/').includes('..')) {
    throw new Error('pvcUri: name must not contain ".." segment');
  }
  return `pvc://${pvc}/${taskUid}/${name}`;
}

/**
 * Sha256 hex regex: lowercase 64-char hex string. CAS hashes are
 * always normalized lowercase so two URIs over the same bytes are
 * lexically identical (cache lookups must not collide on case).
 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Build the canonical v0.2.2-cas URI for an artifact.
 *
 *   casUri('a'.repeat(64), 'digest.md')
 *     → 'cas://sha256:aaaa...aaaa/digest.md'
 *
 * Identity = hash(bytes). Two AgentTasks producing identical bytes
 * produce identical URIs and one stored object. Re-running an
 * identical task (same input hash) replays the cached trace from the
 * idempotency layer instead of calling the LLM again.
 *
 * Pattern: Bazel remote cache + Nix store + Git pack files. The hash
 * is the substrate-stable identity; the trailing `<name>` is a
 * human-friendly label (e.g. `digest.md`, `screenshots/01.png`) that
 * downstream consumers can use as a stable handle in their own JSON.
 *
 * `name` may include forward slashes for nesting but never a leading
 * slash and never `..`. Hash MUST be a 64-char lowercase hex string;
 * uppercase input is auto-lowercased to canonical form. Anything else
 * throws.
 */
export function casUri(contentHash: string, name: string): string {
  if (typeof contentHash !== 'string' || contentHash.length === 0) {
    throw new Error('casUri: contentHash required');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('casUri: name required');
  }
  const hash = contentHash.toLowerCase();
  if (!SHA256_HEX_RE.test(hash)) {
    throw new Error(
      `casUri: contentHash must be a 64-char lowercase sha256 hex string (got ${contentHash.length} chars)`,
    );
  }
  if (name.startsWith('/')) {
    throw new Error('casUri: name must not begin with "/"');
  }
  if (name.split('/').includes('..')) {
    throw new Error('casUri: name must not contain ".." segment');
  }
  return `cas://sha256:${hash}/${name}`;
}

export type ArtifactScheme = 'pvc' | 'minio' | 'http' | 'https' | 's3' | 'inline';

export interface ParsedArtifactUri {
  readonly scheme: ArtifactScheme;
  /** Bucket / PVC name. `undefined` for `http(s)` and `inline` (no bucket concept). */
  readonly bucket?: string;
  /** Path component after the bucket (no leading slash). For `inline://sha256:<hex>` this is `sha256:<hex>`. */
  readonly path: string;
}

/**
 * Parse a substrate-defined artifact URI into its components without
 * resolving or fetching anything. Returns `null` for malformed input or
 * unknown schemes — call sites decide whether to log/throw.
 *
 * v0.1 only emits `pvc://` URIs; the other schemes are recognized so
 * v0.2 backends slot in without rewriting consumers.
 */
export function parseArtifactUri(uri: string): ParsedArtifactUri | null {
  if (typeof uri !== 'string' || uri.length === 0) return null;
  const sepIdx = uri.indexOf('://');
  if (sepIdx <= 0) return null;
  const scheme = uri.slice(0, sepIdx).toLowerCase();
  const remainder = uri.slice(sepIdx + 3);
  if (remainder.length === 0) return null;

  switch (scheme) {
    case 'pvc':
    case 's3':
    case 'minio': {
      const slashIdx = remainder.indexOf('/');
      if (slashIdx <= 0) return null;
      const bucket = remainder.slice(0, slashIdx);
      const path = remainder.slice(slashIdx + 1);
      if (path.length === 0) return null;
      return { scheme, bucket, path };
    }
    case 'http':
    case 'https': {
      // For HTTP we keep host-as-bucket-equivalent; consumers normally
      // treat the whole URI as opaque and hand it to a fetch client.
      const slashIdx = remainder.indexOf('/');
      if (slashIdx === -1) {
        return { scheme, path: '' };
      }
      const path = remainder.slice(slashIdx + 1);
      return { scheme, path };
    }
    case 'inline': {
      // `inline://sha256:<hex>` — the entire remainder is the
      // content-addressed identifier; no bucket. The bytes are NOT
      // durable on disk (this is the contract that distinguishes the
      // scheme from `pvc://`); consumers MUST source the bytes from
      // `status.result.content` rather than trying to follow the URI.
      return { scheme, path: remainder };
    }
    default:
      return null;
  }
}

/* =====================================================================
 * v0.2.2-cas — `parseUri` over the CAS-aware scheme set.
 *
 * Distinct from `parseArtifactUri` (above) which exposes the legacy
 * scheme/bucket/path projection useful for backend dispatch. `parseUri`
 * is the consumer-facing helper called by `read_artifact` and the GC
 * controller — it returns a discriminated union keyed by the
 * substrate-meaningful fields:
 *
 *   - `cas`    → algo + hash + name (identity = hash(bytes))
 *   - `pvc`    → pvc + taskUid + name (legacy back-compat; kept readable)
 *   - `inline` → algo + hash (NOT durable; bytes live in status.result)
 *
 * Returns `null` on any malformed input — non-string, empty, missing
 * scheme, unknown scheme, malformed hash, missing name. Call sites
 * decide whether to log/throw.
 * ===================================================================== */

export type ParsedUri =
  | { readonly scheme: 'cas'; readonly hash: string; readonly name: string }
  | {
      readonly scheme: 'pvc';
      readonly pvc: string;
      readonly taskUid: string;
      readonly name: string;
    }
  | { readonly scheme: 'inline'; readonly hash: string };

/**
 * Parse a substrate-defined artifact URI into a discriminated union.
 * Pure function: does not resolve, fetch, or hash anything.
 *
 *   parseUri('cas://sha256:<64hex>/digest.md')
 *     → { scheme: 'cas', algo: 'sha256', hash: '<64hex>', name: 'digest.md' }
 *
 *   parseUri('pvc://kagent-artifacts/uid-1/digest.md')
 *     → { scheme: 'pvc', pvc: 'kagent-artifacts', taskUid: 'uid-1', name: 'digest.md' }
 *
 *   parseUri('inline://sha256:<64hex>')
 *     → { scheme: 'inline', algo: 'sha256', hash: '<64hex>' }
 *
 * Returns `null` on:
 *   - non-string / empty input
 *   - missing or unknown scheme (anything outside `cas | pvc | inline`)
 *   - `cas://` with non-`sha256:` algo, malformed/absent hash, or missing
 *     trailing `/<name>` (an empty name segment fails too)
 *   - `pvc://` missing PVC name, task UID, or trailing path segment
 *   - `inline://` missing the `sha256:<hex>` body or with malformed hash
 */
export function parseUri(uri: string): ParsedUri | null {
  if (typeof uri !== 'string' || uri.length === 0) return null;
  const sepIdx = uri.indexOf('://');
  if (sepIdx <= 0) return null;
  const scheme = uri.slice(0, sepIdx).toLowerCase();
  const remainder = uri.slice(sepIdx + 3);
  if (remainder.length === 0) return null;

  switch (scheme) {
    case 'cas': {
      // Shape: <algo>:<hash>/<name>. Only `sha256` is recognized in v0.2.2;
      // the union narrows on `algo` so future additions are explicit
      // type-level changes, not silent acceptance.
      const slashIdx = remainder.indexOf('/');
      if (slashIdx <= 0) return null;
      const head = remainder.slice(0, slashIdx);
      const name = remainder.slice(slashIdx + 1);
      if (name.length === 0) return null;

      const colonIdx = head.indexOf(':');
      if (colonIdx <= 0) return null;
      const algo = head.slice(0, colonIdx).toLowerCase();
      const hash = head.slice(colonIdx + 1).toLowerCase();
      if (algo !== 'sha256') return null;
      if (!SHA256_HEX_RE.test(hash)) return null;
      return { scheme: 'cas', hash, name };
    }
    case 'pvc': {
      // Shape: <pvc>/<taskUid>/<...trailing...>/<name>. The `name` is the
      // final segment; intermediate segments form the per-task prefix.
      // Two slashes minimum (pvc, taskUid, name).
      const firstSlash = remainder.indexOf('/');
      if (firstSlash <= 0) return null;
      const pvc = remainder.slice(0, firstSlash);
      const rest = remainder.slice(firstSlash + 1);
      if (rest.length === 0) return null;

      const secondSlash = rest.indexOf('/');
      if (secondSlash <= 0) return null;
      const taskUid = rest.slice(0, secondSlash);
      const tail = rest.slice(secondSlash + 1);
      if (tail.length === 0) return null;

      // `name` is the last path segment; tail may include nested
      // directories (e.g. `screenshots/01.png`).
      const lastSlash = tail.lastIndexOf('/');
      const name = lastSlash === -1 ? tail : tail.slice(lastSlash + 1);
      if (name.length === 0) return null;
      return { scheme: 'pvc', pvc, taskUid, name };
    }
    case 'inline': {
      // Shape: <algo>:<hash>. No name segment — `inline://` is content-
      // addressed only; the bytes live inline in status.result.content.
      const colonIdx = remainder.indexOf(':');
      if (colonIdx <= 0) return null;
      const algo = remainder.slice(0, colonIdx).toLowerCase();
      const hash = remainder.slice(colonIdx + 1).toLowerCase();
      if (algo !== 'sha256') return null;
      if (!SHA256_HEX_RE.test(hash)) return null;
      return { scheme: 'inline', hash };
    }
    default:
      return null;
  }
}

/* =====================================================================
 * Inline-vs-reference decision helper.
 * ===================================================================== */

export type InlineDecision =
  | { readonly kind: 'inline'; readonly content: string }
  | { readonly kind: 'reference-needed' };

/**
 * Default soft cap on inline content. 8 KiB is well under K8s etcd's
 * per-object recommendation (~256 KiB) once the rest of the AgentTask
 * payload + status fields are accounted for. Tunable per-call via
 * `maxBytes`.
 */
export const INLINE_DEFAULT_MAX_BYTES = 8 * 1024;

/** Media types the substrate is willing to inline byte-for-byte. */
const INLINE_SAFE_MEDIA_TYPES = new Set<string>([
  'text/plain',
  'text/markdown',
  'text/x-diff',
  'text/x-patch',
  'application/json',
]);

/**
 * Decide whether a payload is small + textual enough to embed in
 * `status.result` directly, or needs a referenced artifact write.
 *
 * Heuristic, not policy:
 *   - Non-text/JSON media types always go reference (binary blobs
 *     don't survive YAML round-trips and bloat etcd).
 *   - Text payloads under `maxBytes` (UTF-8 byte length) inline.
 *   - Anything else → `reference-needed`.
 *
 * The actual write of a referenced artifact is out-of-scope here; this
 * helper only tells the agent loop which path to take.
 */
export function inlineSafe(
  content: string,
  mediaType: string,
  maxBytes: number = INLINE_DEFAULT_MAX_BYTES,
): InlineDecision {
  if (typeof content !== 'string') return { kind: 'reference-needed' };
  if (!INLINE_SAFE_MEDIA_TYPES.has(mediaType.toLowerCase())) {
    return { kind: 'reference-needed' };
  }
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > maxBytes) {
    return { kind: 'reference-needed' };
  }
  return { kind: 'inline', content };
}
