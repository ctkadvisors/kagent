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
   * Backend-addressable URI. Substrate-defined schemes per
   * `docs/ARTIFACTS.md` §4:
   *   - `pvc://kagent-artifacts/<task-uid>/<name>`  (v0.1, shared PVC, persisted)
   *   - `inline://sha256:<hex>`                      (v0.1, NOT persisted; bytes
   *                                                  live in `status.result.content`)
   *   - `s3://<bucket>/<task-uid>/<name>`           (v0.2, MinIO/S3)
   *   - `minio://<bucket>/<task-uid>/<name>`        (v0.2, MinIO alias)
   *   - `http(s)://...`                              (v0.2, presigned)
   * Treat as opaque at the call site; use `parseArtifactUri` to inspect.
   * Persistence contract: any scheme EXCEPT `inline://` is followable to
   * durable bytes; `inline://` is content-addressed only, never durable.
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
 * Single point of truth for the path layout the future writer will
 * honor. `name` may include forward slashes for nesting (e.g.
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
