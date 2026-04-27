/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Artifact writer — Phase 5 / Platform-Priorities P3.
 *
 * Persists agent-pod tool outputs to a shared PVC mount and emits an
 * `ArtifactRef` (substrate-defined; see `docs/ARTIFACTS.md`). The bytes
 * land at `<KAGENT_ARTIFACTS_DIR>/<task-uid>/<name>`; the URI returned
 * to callers is `pvc://<KAGENT_ARTIFACT_PVC_NAME>/<task-uid>/<name>`.
 *
 * Design constraints (locked down on purpose):
 *
 *   1. Names MUST be relative; leading `/` and `..` segments are
 *      refused. The writer joins under the task-uid directory and
 *      verifies the resolved path is still beneath it (defense in depth
 *      against future name-handling drift).
 *   2. Non-printable characters in `name` are refused (newlines, NUL,
 *      control chars) — these crash log pipelines and trick consumers
 *      that assume single-line names.
 *   3. The write is atomic: bytes go to `<name>.tmp` first, then
 *      `renameSync` flips it into place. A crash mid-write leaves a
 *      `.tmp` file the operator's GC will sweep (or the next pod with
 *      the same task-uid will overwrite). The visible `<name>` is
 *      either fully written or absent.
 *   4. SHA-256 is computed in-memory before the write so the returned
 *      `ArtifactRef.checksum` matches what landed on disk.
 *   5. Only string content (UTF-8) is supported in v0.1; binary bodies
 *      and streaming writes are a v0.2 follow-up (see ARTIFACTS.md §8).
 *
 * Type duplication note: `ArtifactRef` is structurally identical to the
 * canonical `@kagent/operator/crds/artifact-ref` shape — redeclared
 * here to avoid pulling the operator (and its `nats` /
 * `@kubernetes/client-node` transitive surface) into the agent-pod
 * package tree. The operator's status patcher consumes this via
 * structural typing.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';

/* =====================================================================
 * Public types — kept in lockstep with the canonical ArtifactRef shape.
 * ===================================================================== */

/**
 * Reference to an opaque byte payload produced by an agent run.
 * Structurally compatible with the operator's canonical type.
 */
export interface ArtifactRef {
  readonly uri: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly checksum?: string;
  readonly name?: string;
  readonly producedAt?: string;
}

/* =====================================================================
 * Env / convention constants.
 * ===================================================================== */

/** Env var: where the PVC is mounted inside the agent-pod. */
export const ENV_ARTIFACTS_DIR = 'KAGENT_ARTIFACTS_DIR';

/** Env var: PVC name (used to build the `pvc://` URI). */
export const ENV_ARTIFACTS_PVC_NAME = 'KAGENT_ARTIFACT_PVC_NAME';

/** Env var: per-task UID; the operator already injects this. */
export const ENV_TASK_ID = 'KAGENT_TASK_ID';

/** Default mount path when `KAGENT_ARTIFACTS_DIR` is unset. */
export const DEFAULT_ARTIFACTS_DIR = '/var/kagent/artifacts';

/** Default PVC name (mirrors `DEFAULT_ARTIFACT_PVC` in the operator). */
export const DEFAULT_PVC_NAME = 'kagent-artifacts';

/**
 * Default soft cap on inline content. Mirrors `INLINE_DEFAULT_MAX_BYTES`
 * in the operator's `artifact-ref.ts` so the substrate has one number.
 */
export const INLINE_DEFAULT_MAX_BYTES = 8 * 1024;

/** Media types the substrate is willing to inline byte-for-byte. */
const INLINE_SAFE_MEDIA_TYPES: ReadonlySet<string> = new Set<string>([
  'text/plain',
  'text/markdown',
  'text/x-diff',
  'text/x-patch',
  'application/json',
]);

/* =====================================================================
 * Pure helpers — no I/O.
 * ===================================================================== */

/**
 * Validate a caller-supplied `name`. Refuses path traversal, absolute
 * paths, empty strings, and non-printable characters. Returns the
 * normalized name on success; throws Error on any rejection so the
 * tool wrapper can convert to `ToolResult{isError:true}`.
 *
 * Allowed: any printable ASCII / UTF-8 sequence, optionally containing
 * forward slashes for nested layout (e.g. `screenshots/01.png`). The
 * canonical PVC-URI helper accepts the same shape.
 */
export function validateArtifactName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error('write_artifact: "name" must be a string');
  }
  if (name.length === 0) {
    throw new Error('write_artifact: "name" must not be empty');
  }
  if (name.startsWith('/')) {
    throw new Error('write_artifact: "name" must not begin with "/"');
  }
  // Reject backslashes outright — Windows-style separators have no place
  // in a Linux PVC layout and are an obvious traversal bypass.
  if (name.includes('\\')) {
    throw new Error('write_artifact: "name" must not contain backslashes');
  }
  // Reject `..` / `.` / empty segments (segment-aware so `foo..bar.txt` is fine).
  for (const segment of name.split('/')) {
    if (segment === '..') {
      throw new Error('write_artifact: "name" must not contain ".." segments');
    }
    if (segment === '') {
      throw new Error('write_artifact: "name" must not contain empty segments');
    }
    if (segment === '.') {
      throw new Error('write_artifact: "name" must not contain "." segments');
    }
  }
  // Refuse non-printable characters: C0 control chars (0x00-0x1F includes
  // NUL / newline / tab), DEL (0x7F), and the C1 control range
  // (0x80-0x9F). Any other Unicode code point is allowed.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      throw new Error('write_artifact: "name" must not contain non-printable characters');
    }
  }
  return name;
}

/**
 * Build the canonical `pvc://` URI for an artifact. Single point of
 * truth so the agent-pod and the operator agree on layout.
 */
export function buildPvcUri(pvcName: string, taskUid: string, name: string): string {
  if (!pvcName || pvcName.length === 0) {
    throw new Error('buildPvcUri: pvcName required');
  }
  if (!taskUid || taskUid.length === 0) {
    throw new Error('buildPvcUri: taskUid required');
  }
  // `name` is assumed pre-validated by `validateArtifactName`.
  return `pvc://${pvcName}/${taskUid}/${name}`;
}

/**
 * Decide whether a payload is small + textual enough to inline rather
 * than referencing through an artifact write. Mirrors the operator's
 * `inlineSafe`; redeclared here to keep the agent-pod self-contained.
 */
export function inlineSafeForArtifact(
  content: string,
  mediaType: string,
  maxBytes: number = INLINE_DEFAULT_MAX_BYTES,
): boolean {
  if (typeof content !== 'string') return false;
  if (typeof mediaType !== 'string') return false;
  if (!INLINE_SAFE_MEDIA_TYPES.has(mediaType.toLowerCase())) return false;
  return Buffer.byteLength(content, 'utf8') <= maxBytes;
}

/* =====================================================================
 * Writer — the only function in this module that touches the FS.
 * ===================================================================== */

/** Resolved configuration for the writer; injectable for tests. */
export interface ArtifactWriterEnv {
  /** Filesystem root (absolute) — typically `/var/kagent/artifacts`. */
  readonly artifactsDir: string;
  /** PVC name for the URI scheme — typically `kagent-artifacts`. */
  readonly pvcName: string;
  /** Task UID — the per-pod scope. */
  readonly taskUid: string;
}

/** Result of a successful write. */
export interface WriteArtifactResult {
  readonly ref: ArtifactRef;
  /** Absolute filesystem path the bytes landed at; useful for tests. */
  readonly path: string;
}

/**
 * Resolve the writer environment from process env. Throws when the
 * task UID is missing — the agent-pod cannot scope writes safely
 * without it.
 */
export function resolveWriterEnv(
  env: Readonly<Record<string, string | undefined>>,
): ArtifactWriterEnv {
  const taskUid = env[ENV_TASK_ID];
  if (typeof taskUid !== 'string' || taskUid.length === 0) {
    throw new Error(`write_artifact: required env var ${ENV_TASK_ID} is missing or empty`);
  }
  const dirRaw = env[ENV_ARTIFACTS_DIR];
  const artifactsDir =
    typeof dirRaw === 'string' && dirRaw.length > 0 ? dirRaw : DEFAULT_ARTIFACTS_DIR;
  const pvcRaw = env[ENV_ARTIFACTS_PVC_NAME];
  const pvcName = typeof pvcRaw === 'string' && pvcRaw.length > 0 ? pvcRaw : DEFAULT_PVC_NAME;
  return { artifactsDir, pvcName, taskUid };
}

/**
 * Persist `content` (UTF-8) to the per-task directory and return a
 * substrate-canonical `ArtifactRef`. Atomic: writes to `<name>.tmp`,
 * fsyncs, renames to `<name>`. The returned `path` is the visible
 * file (post-rename).
 *
 * Throws on FS errors so the caller can surface a clean tool error.
 */
export function writeArtifactToDisk(
  name: string,
  content: string,
  mediaType: string,
  env: ArtifactWriterEnv,
  now: Date = new Date(),
): WriteArtifactResult {
  const safeName = validateArtifactName(name);
  if (typeof content !== 'string') {
    throw new Error('write_artifact: "content" must be a UTF-8 string');
  }
  if (typeof mediaType !== 'string' || mediaType.length === 0) {
    throw new Error('write_artifact: "mediaType" must be a non-empty string');
  }

  // Build target paths and verify they cannot escape the task-uid dir
  // even after path resolution (defense in depth — `validateArtifactName`
  // already rejected `..`, but we double-check the final path).
  const taskRoot = resolve(env.artifactsDir, env.taskUid);
  const targetPath = resolve(taskRoot, safeName);
  if (!targetPath.startsWith(taskRoot + sep) && targetPath !== taskRoot) {
    throw new Error(
      'write_artifact: resolved path escapes the task-uid directory (defense-in-depth check)',
    );
  }

  const tmpPath = `${targetPath}.tmp`;
  const targetDir = targetPath.slice(0, targetPath.lastIndexOf(sep));
  mkdirSync(targetDir, { recursive: true });

  // Encode once; this is also what we hash + size.
  const bytes = Buffer.from(content, 'utf8');
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

  // Atomic write: open with O_WRONLY|O_CREAT|O_TRUNC, write, fsync,
  // close, rename. If anything throws between mkdir and rename, the
  // tmp file is removed so a partial file is never left behind.
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'w');
    if (bytes.byteLength > 0) {
      writeSync(fd, bytes, 0, bytes.byteLength, 0);
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
    // Best-effort cleanup so a partial `.tmp` does not linger.
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — tmp file may not exist if openSync threw
    }
    throw err;
  }

  const ref: ArtifactRef = {
    uri: buildPvcUri(env.pvcName, env.taskUid, safeName),
    name: safeName,
    mediaType,
    sizeBytes: bytes.byteLength,
    checksum,
    producedAt: now.toISOString(),
  };
  return { ref, path: targetPath };
}

/* =====================================================================
 * Trace collation — runner-side helper for harvesting refs.
 * ===================================================================== */

/**
 * Best-effort: parse an `ArtifactRef` out of a `tool_call` trace's
 * `tool_output` field. The output is a JSON-stringified
 * `ToolResult.content` array (one text block whose `text` is itself a
 * JSON-stringified ArtifactRef). Returns `null` for any shape mismatch
 * so callers can ignore null entries.
 *
 * Lives here (not in `runner.ts`) so the parsing surface stays next to
 * the producer (`write_artifact`'s tool result); they share the same
 * shape contract.
 */
export function tryParseArtifactRefFromToolOutput(toolOutput: unknown): ArtifactRef | null {
  if (typeof toolOutput !== 'string' || toolOutput.length === 0) return null;
  // Trace pipeline truncates strings via `truncateForStorage`. A truncated
  // payload is unusable for parsing — refuse rather than risk a partial
  // ArtifactRef.
  if (toolOutput.includes('...[truncated ')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolOutput);
  } catch {
    return null;
  }
  // The InProcessToolProvider wraps `ContentBlock[]` returns; we emit
  // exactly one text block with a JSON-stringified ArtifactRef.
  if (Array.isArray(parsed)) {
    const first = parsed[0] as { type?: unknown; text?: unknown } | undefined;
    if (
      first !== undefined &&
      first.type === 'text' &&
      typeof first.text === 'string' &&
      first.text.length > 0
    ) {
      try {
        const inner = JSON.parse(first.text) as unknown;
        return isArtifactRefShape(inner) ? (inner as ArtifactRef) : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  // Fallback — accept a bare-object output too.
  return isArtifactRefShape(parsed) ? (parsed as ArtifactRef) : null;
}

/**
 * Narrow type guard — accepts any object with a non-empty `uri` string
 * and (when present) optional metadata fields of the right type.
 * Mirrors the canonical `isArtifactRef` in the operator surface.
 */
export function isArtifactRefShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.uri !== 'string' || v.uri.length === 0) return false;
  if (v.name !== undefined && typeof v.name !== 'string') return false;
  if (v.mediaType !== undefined && typeof v.mediaType !== 'string') return false;
  if (v.checksum !== undefined && typeof v.checksum !== 'string') return false;
  if (v.producedAt !== undefined && typeof v.producedAt !== 'string') return false;
  if (v.sizeBytes !== undefined) {
    if (typeof v.sizeBytes !== 'number' || !Number.isFinite(v.sizeBytes) || v.sizeBytes < 0) {
      return false;
    }
  }
  return true;
}
