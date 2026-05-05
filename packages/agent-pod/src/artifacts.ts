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
 *
 * `contentHash` was added in v0.2.2-cas as the bare-hex (no algorithm
 * prefix) sibling of `checksum` — the v0.1 PVC writer populates it
 * verbatim so the URI scheme is forward-compatible with CAS-backed
 * dedupe (which reads the same field name + same hash space).
 */
export interface ArtifactRef {
  readonly uri: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly checksum?: string;
  readonly name?: string;
  readonly producedAt?: string;
  /**
   * Bare lowercase-hex sha256 of the bytes. Mirrors the canonical CRD
   * field at `packages/operator/src/crds/artifact-ref.ts`. Identical
   * hash-space to `checksum`'s suffix; populated by the PVC writer so
   * an in-flight migration to a CAS backend can `cas://sha256:<hash>`
   * with zero schema change.
   */
  readonly contentHash?: string;
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

/**
 * Env var: per-write byte cap. The writer refuses any single artifact
 * whose UTF-8 / decoded-base64 byte length exceeds this value, returning
 * a `tool_error: artifact too large (...)` error to the caller. Defaults
 * to {@link DEFAULT_ARTIFACT_MAX_BYTES} when unset / malformed.
 *
 * Helm value: `agentPod.artifactStorage.maxBytes`. The operator forwards
 * it onto every spawned Job's env via `BuildJobSpecOptions.artifactPvc.maxBytes`.
 */
export const ENV_ARTIFACT_MAX_BYTES = 'KAGENT_ARTIFACT_MAX_BYTES';

/** Default mount path when `KAGENT_ARTIFACTS_DIR` is unset. */
export const DEFAULT_ARTIFACTS_DIR = '/var/kagent/artifacts';

/** Default PVC name (mirrors `DEFAULT_ARTIFACT_PVC` in the operator). */
export const DEFAULT_PVC_NAME = 'kagent-artifacts';

/**
 * Default per-write byte cap. 25 MiB is well above the largest expected
 * v0.1 payload (HAR files top out around 5 MiB per docs/ARTIFACTS.md
 * §7c) and well below the SMB-fronted PVC's per-write practical ceiling.
 * Operators tune via `agentPod.artifactStorage.maxBytes` in Helm values.
 */
export const DEFAULT_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

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
  /** Hard per-write byte cap. Defaults to {@link DEFAULT_ARTIFACT_MAX_BYTES}. */
  readonly maxBytes: number;
}

/**
 * Sentinel value returned by {@link resolveWriterEnvOrDisabled} when the
 * substrate has not been wired with an artifact PVC. The `write_artifact`
 * tool surfaces this as `tool_error: write_artifact: artifact storage is
 * disabled (...)` so the LLM gets a clear error and the trace shows the
 * policy denial. Mirrors the gateway's `policy_denied:` taxonomy.
 */
export interface DisabledWriterEnv {
  readonly disabled: true;
  readonly reason: string;
}

/**
 * Discriminated union for the writer's resolved env. Either a
 * fully-populated `ArtifactWriterEnv` (PVC plumbing live) or a
 * `DisabledWriterEnv` carrying a human-readable reason (PVC plumbing
 * absent — typically because the operator's Helm chart hasn't enabled
 * `agentPod.artifactStorage`, so no `KAGENT_ARTIFACT_PVC_NAME` was
 * injected onto the spawned Job).
 */
export type ResolvedWriterEnv = ArtifactWriterEnv | DisabledWriterEnv;

/** Result of a successful write. */
export interface WriteArtifactResult {
  readonly ref: ArtifactRef;
  /** Absolute filesystem path the bytes landed at; useful for tests. */
  readonly path: string;
}

/**
 * Parse the per-write byte cap from env. Returns
 * {@link DEFAULT_ARTIFACT_MAX_BYTES} when unset / malformed / non-positive
 * so a fat-fingered Helm value can't silently disable the cap.
 */
function parseMaxBytes(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_ARTIFACT_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_ARTIFACT_MAX_BYTES;
  }
  return n;
}

/**
 * Resolve the writer environment from process env. Throws when the
 * task UID is missing — the agent-pod cannot scope writes safely
 * without it.
 *
 * NOTE: this LEGACY entry-point keeps the v0.1 contract — the PVC name
 * and dir fall back to defaults rather than reporting "disabled". For
 * the explicit gating contract the user-facing tool consults, prefer
 * {@link resolveWriterEnvOrDisabled}.
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
  const maxBytes = parseMaxBytes(env[ENV_ARTIFACT_MAX_BYTES]);
  return { artifactsDir, pvcName, taskUid, maxBytes };
}

/**
 * Resolve the writer environment with explicit "disabled" semantics.
 * Differs from {@link resolveWriterEnv} in that it returns a tagged
 * `DisabledWriterEnv` when EITHER the PVC name OR the mount path is
 * absent — i.e. when the operator did NOT inject the artifact-PVC env
 * vars. Default OFF: the operator's Helm chart only stamps these vars
 * when `agentPod.artifactStorage.enabled=true`, so an operator that
 * runs without the chart values gets a clean `disabled` error rather
 * than a write to an unmounted path.
 *
 * Reasons surfaced via `DisabledWriterEnv.reason`:
 *   - `KAGENT_ARTIFACT_PVC_NAME unset (operator did not enable agentPod.artifactStorage)`
 *   - `KAGENT_ARTIFACTS_DIR unset (operator did not enable agentPod.artifactStorage)`
 *   - `KAGENT_TASK_ID missing` (the strict task-uid invariant)
 *
 * The substrate contract: the operator decides whether the artifact
 * primitive is available by writing the env vars, not by the agent-pod
 * inferring it. This keeps the failure mode crisp + cluster-uniform.
 */
export function resolveWriterEnvOrDisabled(
  env: Readonly<Record<string, string | undefined>>,
): ResolvedWriterEnv {
  const taskUid = env[ENV_TASK_ID];
  if (typeof taskUid !== 'string' || taskUid.length === 0) {
    return {
      disabled: true,
      reason: `${ENV_TASK_ID} missing — the operator must inject the per-task UID`,
    };
  }
  // Strict gating: BOTH dir and PVC name must be set by the operator.
  // Default-deny is the substrate posture; an operator that hasn't
  // wired the PVC must NOT see writes happen by accident.
  const dirRaw = env[ENV_ARTIFACTS_DIR];
  if (typeof dirRaw !== 'string' || dirRaw.length === 0) {
    return {
      disabled: true,
      reason:
        `${ENV_ARTIFACTS_DIR} unset — artifact storage is disabled. ` +
        `Set agentPod.artifactStorage.enabled=true in the operator chart.`,
    };
  }
  const pvcRaw = env[ENV_ARTIFACTS_PVC_NAME];
  if (typeof pvcRaw !== 'string' || pvcRaw.length === 0) {
    return {
      disabled: true,
      reason:
        `${ENV_ARTIFACTS_PVC_NAME} unset — artifact storage is disabled. ` +
        `Set agentPod.artifactStorage.enabled=true in the operator chart.`,
    };
  }
  const maxBytes = parseMaxBytes(env[ENV_ARTIFACT_MAX_BYTES]);
  return { artifactsDir: dirRaw, pvcName: pvcRaw, taskUid, maxBytes };
}

/**
 * Default media type assigned when the caller does not declare one.
 * `application/octet-stream` is the RFC 6838 fallback for "opaque
 * bytes" — appropriate for the v0.1 writer because the substrate has
 * no business inferring a content type from the bytes themselves.
 */
export const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/**
 * Persist `content` (UTF-8 string or raw bytes) to the per-task
 * directory and return a substrate-canonical `ArtifactRef`. Atomic:
 * writes to `<name>.tmp`, fsyncs, renames to `<name>`. The returned
 * `path` is the visible file (post-rename).
 *
 * Throws on FS errors so the caller can surface a clean tool error.
 *
 * Size cap: `env.maxBytes` is enforced BEFORE the FS write so a hostile
 * / runaway agent never lands oversized bytes on the PVC. The error
 * shape is `tool_error: write_artifact: artifact too large (...)` —
 * machine-greppable for trace analytics.
 *
 * INVARIANT: this function ALWAYS persists to disk before returning;
 * the returned `pvc://...` URI is always followable to a real file at
 * `path`. Callers MUST treat any `pvc://` URI as "bytes are durable on
 * disk." The inline counterpart that intentionally skips the FS write
 * is `inlineArtifactRef()`, which returns an `inline://sha256:...`
 * URI under a different scheme — that contract is the only way to
 * tell durable artifacts apart from inline-only ones at the URI level.
 */
export function writeArtifactToDisk(
  name: string,
  content: string | Buffer | Uint8Array,
  mediaType: string,
  env: ArtifactWriterEnv,
  now: Date = new Date(),
): WriteArtifactResult {
  const safeName = validateArtifactName(name);
  // Accept either a UTF-8 string OR pre-decoded bytes (Buffer / Uint8Array).
  // The tool layer handles base64 → Buffer conversion BEFORE handing off
  // here; the writer stays codec-agnostic from this point on.
  const bytes: Buffer = ((): Buffer => {
    if (typeof content === 'string') {
      return Buffer.from(content, 'utf8');
    }
    if (content instanceof Buffer) return content;
    if (content instanceof Uint8Array)
      return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    throw new Error('write_artifact: "content" must be a UTF-8 string or Buffer/Uint8Array');
  })();
  if (typeof mediaType !== 'string' || mediaType.length === 0) {
    throw new Error('write_artifact: "mediaType" must be a non-empty string');
  }
  // Refuse oversize writes BEFORE touching the FS. Catches a runaway
  // agent (or LLM-fabricated body) before any bytes hit disk.
  if (bytes.byteLength > env.maxBytes) {
    throw new Error(
      `write_artifact: artifact too large (${String(bytes.byteLength)} > ${String(env.maxBytes)} bytes); ` +
        `tune via KAGENT_ARTIFACT_MAX_BYTES (Helm: agentPod.artifactStorage.maxBytes)`,
    );
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

  // Encode once; this is also what we hash + size. `contentHash` is the
  // bare hex digest (no algo prefix) — matches the v0.2.2-cas
  // ArtifactRef field shape so a future CAS migration is metadata-only.
  // `checksum` is the algo-prefixed form for back-compat with v0.1
  // consumers that already grep for `sha256:`.
  const hex = createHash('sha256').update(bytes).digest('hex');
  const checksum = `sha256:${hex}`;
  const contentHash = hex;

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
    contentHash,
    producedAt: now.toISOString(),
  };
  return { ref, path: targetPath };
}

/* =====================================================================
 * Inline-only ref builder — non-persisting counterpart to write_artifact.
 * ===================================================================== */

/**
 * Build a synthetic `ArtifactRef` for content that the caller does NOT
 * want to durably persist on disk. The returned URI uses the
 * `inline://sha256:<hex>` scheme to make the non-durable contract
 * explicit at the URI level — `pvc://` ⟹ persisted, `inline://` ⟹
 * not persisted.
 *
 * Use ONLY when the caller does NOT want the bytes durably stored
 * (e.g. a small text payload that is also embedded directly into
 * `AgentTask.status.result.content`). Refs with the `inline://` scheme
 * are intentionally dropped from `RunResult.artifacts` by the runner
 * collator (see `collectArtifactsFromTraces`) so durable consumers
 * never see a URI they can't follow.
 *
 * The synthetic URI is content-addressed via SHA-256 so two callers
 * producing the same bytes get the same URI — useful for debug
 * fingerprinting; not used for routing or storage in v0.1.
 */
export function inlineArtifactRef(
  content: string,
  mediaType: string,
  now: Date = new Date(),
): ArtifactRef {
  if (typeof content !== 'string') {
    throw new Error('inlineArtifactRef: "content" must be a UTF-8 string');
  }
  if (typeof mediaType !== 'string' || mediaType.length === 0) {
    throw new Error('inlineArtifactRef: "mediaType" must be a non-empty string');
  }
  const bytes = Buffer.from(content, 'utf8');
  const hex = createHash('sha256').update(bytes).digest('hex');
  return {
    uri: `inline://sha256:${hex}`,
    mediaType,
    sizeBytes: bytes.byteLength,
    checksum: `sha256:${hex}`,
    contentHash: hex,
    producedAt: now.toISOString(),
  };
}

/* =====================================================================
 * In-pod ArtifactRegistry — flushable list shared with status.ts.
 *
 * The runner threads ONE registry through the entire run; the
 * `write_artifact` tool pushes successful refs into it. The status
 * patcher reads `registry.snapshot()` to thread refs into
 * `AgentTask.status.artifacts` on EVERY status patch (not just the
 * terminal one) — so a partial run that crashed after a write still
 * surfaces the bytes that did land.
 *
 * Why a registry vs. trace harvesting alone:
 *   - The trace pipeline truncates oversize tool outputs
 *     (`...[truncated N chars]...`) — a long ArtifactRef would be
 *     unparseable at status-patch time.
 *   - Some non-completed terminal paths (cancellation, timeout) bypass
 *     the trace flush; the registry survives those paths because it
 *     was populated synchronously at write time.
 *   - The registry is the single source of truth tests can assert
 *     against; trace-parsing remains as a forward-compat fallback for
 *     pre-registry agent-pod images.
 *
 * Mutation is intentionally minimal — `add` + `snapshot` only. No
 * remove / clear / mutate operations exist; the substrate's contract
 * is "every successful write is permanent for the run's lifetime".
 * ===================================================================== */

/**
 * Append-only registry of ArtifactRefs the in-pod writer has produced
 * during this run. Thread-safety is not a concern (the agent loop is
 * single-threaded), but the snapshot is a defensive copy so a caller
 * that holds a reference can't mutate the internal state.
 */
export interface ArtifactRegistry {
  /** Push one ref into the registry. Idempotent on identical URI strings. */
  add(ref: ArtifactRef): void;
  /** Defensive copy of the current ref list. */
  snapshot(): readonly ArtifactRef[];
  /** True when at least one ref has been added. */
  isEmpty(): boolean;
}

/**
 * Build a fresh in-memory registry. Keyed by `ref.uri` (last-write-wins
 * on duplicate URIs — useful when an agent overwrites an artifact and
 * we only want the latest metadata in the status patch).
 */
export function createArtifactRegistry(): ArtifactRegistry {
  const byUri = new Map<string, ArtifactRef>();
  return {
    add(ref: ArtifactRef): void {
      if (typeof ref.uri !== 'string' || ref.uri.length === 0) return;
      byUri.set(ref.uri, ref);
    },
    snapshot(): readonly ArtifactRef[] {
      return [...byUri.values()];
    },
    isEmpty(): boolean {
      return byUri.size === 0;
    },
  };
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
  if (v.contentHash !== undefined && typeof v.contentHash !== 'string') return false;
  if (v.producedAt !== undefined && typeof v.producedAt !== 'string') return false;
  if (v.sizeBytes !== undefined) {
    if (typeof v.sizeBytes !== 'number' || !Number.isFinite(v.sizeBytes) || v.sizeBytes < 0) {
      return false;
    }
  }
  return true;
}
