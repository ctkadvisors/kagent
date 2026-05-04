/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * CAS backend abstraction — v0.2.2-cas (docs/SUBSTRATE-V1.md §3.5,
 * docs/WAVES.md §3.3).
 *
 * Two backends ship in v0.2.2:
 *
 *   - {@link PvcCasBackend} — writes blobs onto a shared RWX PVC under
 *     `<mountPath>/cas/sha256/<first-2-hex>/<remaining-62-hex>`. The
 *     two-character shard prefix matches Git's pack-loose-object layout
 *     and Nix's store-path scheme: it bounds directory fanout to 256
 *     entries even at scale.
 *
 *   - {@link S3CasBackend} — signature-only stub. Throws on every call.
 *     The contract is documented in JSDoc; v0.3 ships the real S3 /
 *     MinIO client (`@aws-sdk/client-s3` is the most likely
 *     implementation, but the surface is intentionally minimal so we can
 *     swap in a different SDK without touching consumers).
 *
 * Identity is `sha256(bytes)` for both backends. `read(uri)` MUST verify
 * the returned bytes hash to the URI's hash — corruption / tampering /
 * mid-write reads surface as an error rather than silently returning
 * the wrong payload.
 *
 * The interface is intentionally narrow (read/write/exists). GC,
 * retention, and reachability are operator-side concerns
 * (`packages/operator/src/cas-gc.ts`); this package is unconcerned with
 * lifecycle.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';

/* =====================================================================
 * Public types
 * ===================================================================== */

/**
 * Result of a successful CAS write. The URI is canonicalized
 * `cas://sha256:<hash>/<name>`; the `contentHash` is the bare
 * lowercase-hex sha256 of the bytes (no algorithm prefix; mirrors the
 * field on the operator's `ArtifactRef`).
 */
export interface CasWriteResult {
  readonly uri: string;
  readonly contentHash: string;
}

/**
 * Substrate-defined contract for a content-addressed-storage backend.
 *
 * - `read(uri)` returns the bytes whose sha256 matches the URI's hash.
 *   Implementations MUST verify the hash post-fetch and throw on
 *   mismatch — silent corruption defeats the entire point of CAS.
 * - `write(bytes, name)` computes the hash, persists the bytes once
 *   (de-dup is the implementation's job), and returns the canonical URI.
 * - `exists(hash)` is a fast existence check used by the operator's GC
 *   reachability walker; never reads the bytes.
 *
 * Implementations are expected to be safe under concurrent use; the PVC
 * backend uses atomic rename, which K8s RWX semantics handle on every
 * supported StorageClass.
 */
export interface CasBackend {
  /** Fetch + verify the bytes addressed by `uri`. Throws on mismatch. */
  read(uri: string): Promise<Uint8Array>;
  /** Hash, persist (de-dup if already present), return canonical URI. */
  write(bytes: Uint8Array, name: string): Promise<CasWriteResult>;
  /** Cheap existence check by hash. No verification, no body fetch. */
  exists(hash: string): Promise<boolean>;
}

/* =====================================================================
 * Hash + name validation helpers (shared between backends).
 * ===================================================================== */

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Compute the lowercase-hex sha256 of a byte buffer. Sync; the hash is
 * computed in-memory before write (the substrate's CAS bytes are sized
 * for inline trace storage anyway — multi-GB payloads are out-of-scope
 * for v0.2.2).
 */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Validate a caller-supplied artifact `name`. Mirrors the operator's
 * `casUri` validation so the in-pod tool refuses path-traversal /
 * absolute paths / empty inputs the same way the URI builder does.
 */
function validateName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('cas-backend: name required');
  }
  if (name.startsWith('/')) {
    throw new Error('cas-backend: name must not begin with "/"');
  }
  if (name.includes('\\')) {
    throw new Error('cas-backend: name must not contain backslashes');
  }
  for (const segment of name.split('/')) {
    if (segment === '..' || segment === '.' || segment === '') {
      throw new Error('cas-backend: name must not contain ".", "..", or empty segments');
    }
  }
}

/**
 * Parse `cas://sha256:<hex>/<name>` into its parts. Distinct from the
 * operator's `parseUri` (which lives in `@kagent/operator/crds`); we
 * deliberately do NOT take a dependency on the operator from the
 * agent-pod package, to avoid pulling in `@kubernetes/client-node` etc.
 */
function parseCasUri(uri: string): { hash: string; name: string } {
  if (typeof uri !== 'string' || !uri.startsWith('cas://')) {
    throw new Error(`cas-backend: not a cas:// URI: "${String(uri).slice(0, 80)}"`);
  }
  const rest = uri.slice('cas://'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) {
    throw new Error(`cas-backend: malformed cas:// URI (missing name): "${uri}"`);
  }
  const head = rest.slice(0, slashIdx);
  const name = rest.slice(slashIdx + 1);
  if (name.length === 0) {
    throw new Error(`cas-backend: malformed cas:// URI (empty name): "${uri}"`);
  }
  const colonIdx = head.indexOf(':');
  if (colonIdx <= 0) {
    throw new Error(`cas-backend: malformed cas:// URI (missing algo): "${uri}"`);
  }
  const algo = head.slice(0, colonIdx).toLowerCase();
  const hash = head.slice(colonIdx + 1).toLowerCase();
  if (algo !== 'sha256') {
    throw new Error(`cas-backend: unsupported algo "${algo}" (only sha256 is supported in v0.2.2)`);
  }
  if (!SHA256_HEX_RE.test(hash)) {
    throw new Error(`cas-backend: malformed sha256 hex in cas:// URI: "${uri}"`);
  }
  return { hash, name };
}

/**
 * Build the canonical `cas://sha256:<hash>/<name>` URI. Internal helper —
 * the operator's `casUri` is the public-facing builder; this is the
 * agent-pod's local copy to avoid the cross-package import.
 */
function buildCasUri(hash: string, name: string): string {
  return `cas://sha256:${hash}/${name}`;
}

/**
 * Compute the sharded blob path for a sha256 hash. Layout:
 *
 *   <root>/cas/sha256/<first-2-hex>/<remaining-62-hex>
 *
 * The same sharding convention used by Git's loose-object directory
 * (objects/aa/bbcc...) and Nix's `/nix/store/...`. Two-char prefix
 * keeps fanout at 256 entries — well below ext4's per-directory cap
 * even with millions of artifacts.
 */
export function casShardPath(root: string, hash: string): string {
  if (!SHA256_HEX_RE.test(hash)) {
    throw new Error(`casShardPath: malformed sha256 hex "${hash}"`);
  }
  return resolve(root, 'cas', 'sha256', hash.slice(0, 2), hash.slice(2));
}

/* =====================================================================
 * PVC-backed implementation.
 * ===================================================================== */

/**
 * PVC-backed CAS implementation. Bytes land at
 * `<mountPath>/cas/sha256/<first-2-hex>/<remaining-62-hex>`. Writes are
 * atomic (`<path>.tmp` + `renameSync`); reads verify
 * `sha256(bytes) === hash` post-load and throw on mismatch.
 *
 * Concurrency: the rename is the atomicity boundary. Two pods writing
 * the same blob race the rename; the loser's tmp file is removed on
 * success (rename overwrites; `unlinkSync` cleanup is best-effort). The
 * winning bytes are correct because identity = hash, so both writers
 * agree on the final content.
 *
 * The constructor only stores the mount path; nothing is created on
 * disk until the first `write()`. Tests can point this at any directory
 * (a tmpdir suffices) without booting a real PVC.
 */
export class PvcCasBackend implements CasBackend {
  private readonly mountPath: string;

  constructor(mountPath: string) {
    if (typeof mountPath !== 'string' || mountPath.length === 0) {
      throw new Error('PvcCasBackend: mountPath required');
    }
    this.mountPath = mountPath;
  }

  /** Resolve the on-disk path for a hash; exposed for the GC controller's tests. */
  pathForHash(hash: string): string {
    return casShardPath(this.mountPath, hash);
  }

  // The PVC backend uses synchronous Node FS calls (the writes are
  // small enough that the loop-blocking cost is negligible vs. the
  // simplicity gain). Methods are declared `async` so the interface
  // stays uniform with the future S3 backend AND so sync throws
  // surface as Promise rejections without manual wrapping. The
  // /* eslint-disable */ directives below silence
  // `@typescript-eslint/require-await` — sync FS-only async is the
  // intentional pattern here.

  // eslint-disable-next-line @typescript-eslint/require-await
  async read(uri: string): Promise<Uint8Array> {
    const { hash } = parseCasUri(uri);
    const path = casShardPath(this.mountPath, hash);
    const bytes = readFileSync(path);
    const computed = hashBytes(bytes);
    if (computed !== hash) {
      // Mid-write read, corruption, or tampering — surface clean error
      // rather than handing the agent loop the wrong bytes.
      throw new Error(
        `cas-backend: hash mismatch reading "${uri}" (expected ${hash}, got ${computed})`,
      );
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async write(bytes: Uint8Array, name: string): Promise<CasWriteResult> {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('PvcCasBackend.write: bytes must be a Uint8Array');
    }
    validateName(name);
    const buf =
      bytes instanceof Buffer
        ? bytes
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hash = hashBytes(buf);
    const targetPath = casShardPath(this.mountPath, hash);

    // Defense-in-depth path-escape check (validateName already rejected
    // path traversal; the on-disk path is computed from the hash so it
    // can't be influenced by the caller — but we still bound it to the
    // mount root in case `mountPath` is itself relative).
    const root = resolve(this.mountPath);
    if (!targetPath.startsWith(root + sep) && targetPath !== root) {
      throw new Error(
        'PvcCasBackend.write: resolved path escapes the mount root (defense-in-depth check)',
      );
    }

    if (existsSync(targetPath)) {
      // De-dup: identical bytes already on disk; skip the FS write
      // entirely. Saves the I/O AND prevents an unnecessary rename
      // racing the existing reader.
      return { uri: buildCasUri(hash, name), contentHash: hash };
    }

    const targetDir = targetPath.slice(0, targetPath.lastIndexOf(sep));
    mkdirSync(targetDir, { recursive: true });

    const tmpPath = `${targetPath}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmpPath, 'w');
      if (buf.byteLength > 0) {
        writeSync(fd, buf, 0, buf.byteLength, 0);
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmpPath, targetPath);
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore — already failing
        }
      }
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore — best-effort cleanup
      }
      throw err;
    }

    return { uri: buildCasUri(hash, name), contentHash: hash };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async exists(hash: string): Promise<boolean> {
    if (!SHA256_HEX_RE.test(hash)) return false;
    return existsSync(casShardPath(this.mountPath, hash));
  }
}

/* =====================================================================
 * S3 / MinIO stub — signature only; ships in v0.3.
 * ===================================================================== */

/**
 * Configuration for the future S3 / MinIO backend. Recorded here so the
 * v0.3 implementation slots in without touching the consumer surface.
 *
 * - `bucket` — target bucket name. Layout under the bucket mirrors PVC:
 *   `cas/sha256/<first-2-hex>/<remaining-62-hex>`.
 * - `endpoint` — MinIO / S3-compatible endpoint URL (e.g.
 *   `http://minio.kagent-system.svc.cluster.local:9000`); omit for
 *   AWS-hosted S3.
 * - `region` — AWS region; defaults to `us-east-1` for MinIO.
 * - `credentials` — optional explicit access/secret pair; falls back to
 *   the default chain (IRSA, env, instance profile, etc.).
 */
export interface S3CasBackendOptions {
  readonly bucket: string;
  readonly endpoint?: string;
  readonly region?: string;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

/**
 * S3 / MinIO CAS backend — signature-only in v0.2.2; throws on every
 * call. The v0.3 implementation will:
 *
 *   1. Use `@aws-sdk/client-s3` (or a pluggable signer) to issue
 *      `PutObject` / `GetObject` / `HeadObject` requests against the
 *      configured bucket.
 *   2. Verify `sha256(bytes) === hash` after `GetObject` (S3's
 *      `x-amz-checksum-sha256` header is set by the writer in v0.3+;
 *      the read path STILL recomputes locally for tamper-evidence).
 *   3. Use conditional `PutObject` (`If-None-Match: "*"`) to skip writes
 *      when the blob already exists — same de-dup semantics as
 *      `PvcCasBackend`.
 *   4. Surface S3 / MinIO errors with the same error shape as the PVC
 *      backend so consumers don't branch on backend identity.
 *
 * Until then, callers that wire this in get a loud, immediate failure
 * with the v0.3 release tag in the error message.
 */
export class S3CasBackend implements CasBackend {
  private readonly options: S3CasBackendOptions;

  constructor(options: S3CasBackendOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new Error('S3CasBackend: options object required');
    }
    if (typeof options.bucket !== 'string' || options.bucket.length === 0) {
      throw new Error('S3CasBackend: options.bucket required');
    }
    this.options = options;
  }

  // The methods are signature-only in v0.2.2 and throw on every call.
  // The `_`-prefixed parameter names are kept so the v0.3 implementation
  // (which uses the names) shows as a pure addition in `git blame`.
  // eslint-disable-next-line @typescript-eslint/require-await
  async read(_uri: string): Promise<Uint8Array> {
    throw new Error('S3 backend coming in v0.3');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async write(_bytes: Uint8Array, _name: string): Promise<CasWriteResult> {
    throw new Error('S3 backend coming in v0.3');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async exists(_hash: string): Promise<boolean> {
    throw new Error('S3 backend coming in v0.3');
  }

  /** Read-only accessor for tests / the v0.3 client wiring. */
  getOptions(): S3CasBackendOptions {
    return this.options;
  }
}
