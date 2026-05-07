/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * /admin/* handlers — pure data shaping over the AIMD controller, the
 * in-flight counter, and the usage repo. Returns JSON-serialisable
 * objects; the server layer does the wire-format work.
 *
 * Auth: bearer token comparison against `ADMIN_API_TOKEN` env, parsed
 * once at boot. Constant-time compare to avoid sub-µs leak (overkill
 * for v1 single-tenant, but the right reflex).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { AimdController } from './aimd.js';
import { hashApiKey } from './auth.js';
import type { InFlightCounter } from './inflight-counter.js';
import type { ModelIndex } from './model-index.js';
import type { ApiKeyAdminRow, ApiKeyRepo, RevokeResult } from './db/api-keys.js';
import type { UsageRepo, UsageQueryFilter } from './db/usage.js';

export interface AdminAuthResult {
  readonly ok: boolean;
  readonly statusCode?: 401 | 403;
  readonly message?: string;
}

/**
 * H14 — domain-separation HMAC key for the admin-token compare path.
 *
 * The previous implementation early-returned `403` whenever
 * `supplied.length !== expectedToken.length`, which leaked the
 * expected token's exact byte length via response timing. The fix
 * swaps the raw-byte compare for a fixed-width HMAC-SHA256 digest of
 * each side: both inputs collapse to 32 bytes, so `timingSafeEqual`
 * never has a length-mismatch fast path to leak information through.
 *
 * The HMAC key itself does not need to be secret — its only role is
 * to prevent length-extension and to bind the digest to this code
 * path so a digest captured here can't be replayed elsewhere. It is
 * a constant string for code-search clarity.
 */
const ADMIN_TOKEN_HMAC_KEY = 'kagent-llm-gateway/admin-token/v1';

function hmacToken(value: string): Buffer {
  return createHmac('sha256', ADMIN_TOKEN_HMAC_KEY).update(value).digest();
}

export function adminAuth(req: IncomingMessage, expectedToken: string): AdminAuthResult {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || auth.length === 0) {
    return { ok: false, statusCode: 401, message: 'missing authorization header' };
  }
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  // H14 — compare digests of equal length (32 bytes) to remove the
  // length-mismatch early-return. We DO NOT short-circuit on
  // `supplied.length === 0`; the hmac compare below handles that
  // uniformly with all other mismatched inputs.
  const suppliedDigest = hmacToken(supplied);
  const expectedDigest = hmacToken(expectedToken);
  if (!timingSafeEqual(suppliedDigest, expectedDigest)) {
    return { ok: false, statusCode: 403, message: 'admin token mismatch' };
  }
  return { ok: true };
}

export interface CapacityRow {
  readonly model: string;
  readonly endpoint: string;
  readonly backendKind: string | null;
  readonly inFlight: number;
  readonly currentCap: number;
  readonly seed: number;
  readonly max: number;
  readonly minSafe: number;
  readonly recentP50Ms: number | null;
}

export interface CapacityResponse {
  readonly rows: readonly CapacityRow[];
}

/**
 * /admin/capacity — joins AIMD snapshot, in-flight counter, and the
 * model-index by `(model, endpoint)`. Returns one row per known
 * (model, backendUrl). When the model-index has a row but no traffic
 * has happened yet, AIMD seeds on first read so the row still
 * surfaces with a sensible cap.
 */
export function buildCapacityResponse(
  modelIndex: ModelIndex,
  inFlight: InFlightCounter,
  aimd: AimdController,
): CapacityResponse {
  const rows: CapacityRow[] = [];
  for (const ep of modelIndex.list()) {
    const model = ep.spec.model;
    const url = ep.spec.backendUrl;
    const cap = aimd.currentCap(model, url);
    const inflight = inFlight.current(model, url);
    const snap = aimd.snapshot().find((s) => s.model === model && s.endpoint === url);
    rows.push({
      model,
      endpoint: url,
      backendKind: ep.spec.backendKind,
      inFlight: inflight,
      currentCap: cap,
      seed: ep.spec.inFlight.seed,
      max: ep.spec.inFlight.max,
      minSafe: ep.spec.minSafe ?? 1,
      recentP50Ms: snap?.recentP50Ms ?? null,
    });
  }
  rows.sort((a, b) => {
    if (a.model !== b.model) return a.model < b.model ? -1 : 1;
    return a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0;
  });
  return { rows };
}

/**
 * /admin/usage?taskUid=...&agentName=...&model=...&since=...&until=...&limit=...
 * Parses the query string off the IncomingMessage URL into a typed
 * `UsageQueryFilter`, runs it, returns the rows.
 */
export function parseUsageQuery(url: string): UsageQueryFilter {
  // url comes in as a path+query (e.g. "/admin/usage?taskUid=x"); a
  // base is required for the URL ctor — we pick a throwaway one.
  const u = new URL(url, 'http://_local');
  const out: { -readonly [K in keyof UsageQueryFilter]: UsageQueryFilter[K] } = {};
  const pull = (k: string): string | undefined => {
    const v = u.searchParams.get(k);
    return v !== null && v.length > 0 ? v : undefined;
  };
  const taskUid = pull('taskUid');
  if (taskUid !== undefined) out.taskUid = taskUid;
  const agentName = pull('agentName');
  if (agentName !== undefined) out.agentName = agentName;
  const model = pull('model');
  if (model !== undefined) out.model = model;
  const since = pull('since');
  if (since !== undefined) out.since = since;
  const until = pull('until');
  if (until !== undefined) out.until = until;
  const limitRaw = pull('limit');
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n > 0) out.limit = n;
  }
  return out;
}

export async function buildUsageResponse(
  url: string,
  usage: UsageRepo,
): Promise<{ readonly rows: unknown[] }> {
  const filter = parseUsageQuery(url);
  const rows = await usage.query(filter);
  return { rows: [...rows] };
}

/* =====================================================================
 * v0.1.12-keys-rest — POST/GET/DELETE /admin/keys handlers.
 *
 * The plaintext key shape is `sk-<base64url>` so it sorts visually
 * with the existing `sk-...` convention. Random body is 32 bytes →
 * ~43 base64url chars, which gives 256 bits of entropy. The first 8
 * chars (incl. the `sk-` prefix) are stored as `key_prefix` for
 * admin-list display + log correlation. The plaintext is returned
 * exactly once on POST; subsequent reads only ever see the prefix.
 * ===================================================================== */

export interface CreateApiKeyBody {
  readonly label: string;
  readonly modelAllowlist?: readonly string[];
  /** ISO 8601 timestamp; absent = no expiration. */
  readonly expiresAt?: string;
}

export interface CreatedApiKey {
  readonly id: string;
  readonly label: string;
  /** Plaintext API key. Returned exactly once; never persisted. */
  readonly key: string;
  /** SHA-256 hex digest of `key`. Persisted; OK to surface for audit. */
  readonly hash: string;
  /** First 8 chars of `key` (including `sk-` prefix). */
  readonly hashPrefix: string;
  readonly modelAllowlist?: readonly string[];
  readonly expiresAt?: string;
}

const KEY_PREFIX_LEN = 8;

/**
 * Validate + normalize the JSON body for POST /admin/keys. Throws on
 * malformed input — the server.ts layer turns the throw into 400.
 *
 * Pure function — exported for tests.
 */
export function parseCreateApiKeyBody(raw: unknown): CreateApiKeyBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const label = obj.label;
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('label is required (non-empty string)');
  }
  const out: { -readonly [K in keyof CreateApiKeyBody]: CreateApiKeyBody[K] } = { label };
  if (obj.modelAllowlist !== undefined && obj.modelAllowlist !== null) {
    if (!Array.isArray(obj.modelAllowlist)) {
      throw new Error('modelAllowlist must be an array of strings');
    }
    for (const v of obj.modelAllowlist) {
      if (typeof v !== 'string') {
        throw new Error('modelAllowlist must be an array of strings');
      }
    }
    out.modelAllowlist = [...(obj.modelAllowlist as string[])];
  }
  if (obj.expiresAt !== undefined && obj.expiresAt !== null) {
    if (typeof obj.expiresAt !== 'string') {
      throw new Error('expiresAt must be an ISO 8601 string');
    }
    out.expiresAt = obj.expiresAt;
  }
  return out;
}

/**
 * Mint a fresh `sk-<base64url>` API key. Exported for tests so they can
 * assert shape without indirecting through the full handler.
 */
export function mintRawApiKey(): string {
  const bytes = randomBytes(32);
  // base64url, no padding — 43 chars for 32 bytes.
  const body = bytes.toString('base64url');
  return `sk-${body}`;
}

/**
 * POST /admin/keys handler — pure dependency-injected version. Mints a
 * fresh plaintext key, hashes it, persists via the repo, returns the
 * plaintext exactly once + the assigned id + hash for client storage
 * (e.g. workbench secret reveal flow).
 *
 * The handler intentionally does NOT validate `expiresAt` past the
 * type check — the DB column is TIMESTAMPTZ and Postgres rejects
 * malformed timestamps, which surfaces as a 500 the caller can debug.
 * Belt-and-suspenders parsing duplication lives at the API layer.
 */
export async function handleCreateApiKey(
  body: CreateApiKeyBody,
  repo: Pick<ApiKeyRepo, 'insertAndReturn'>,
): Promise<CreatedApiKey> {
  const key = mintRawApiKey();
  const hash = hashApiKey(key);
  const hashPrefix = key.slice(0, KEY_PREFIX_LEN);
  const inserted = await repo.insertAndReturn({
    keyHash: hash,
    keyPrefix: hashPrefix,
    name: body.label,
    ...(body.expiresAt !== undefined && { expiresAt: body.expiresAt }),
    ...(body.modelAllowlist !== undefined && { modelAllowlist: body.modelAllowlist }),
  });
  return {
    id: inserted.id,
    label: body.label,
    key,
    hash,
    hashPrefix,
    ...(body.modelAllowlist !== undefined && { modelAllowlist: body.modelAllowlist }),
    ...(body.expiresAt !== undefined && { expiresAt: body.expiresAt }),
  };
}

/**
 * GET /admin/keys handler — return every API key in admin-projection
 * shape. The repo's `list()` SELECT structurally excludes plaintext
 * + key_hash, so this passes through with no further sanitization.
 */
export async function handleListApiKeys(
  repo: Pick<ApiKeyRepo, 'list'>,
): Promise<{ readonly rows: readonly ApiKeyAdminRow[] }> {
  const rows = await repo.list();
  return { rows };
}

/**
 * DELETE /admin/keys/:id handler — soft-delete a key by id.
 * Returns the {revoked} flag verbatim from the repo; the server
 * layer turns `revoked: false` into a 404.
 */
export async function handleRevokeApiKey(
  id: string,
  repo: Pick<ApiKeyRepo, 'revoke'>,
): Promise<RevokeResult> {
  return repo.revoke(id);
}

/**
 * Extract the `:id` segment from `/admin/keys/:id`. Returns
 * `undefined` for shapes that aren't an exact one-segment match —
 * the bare collection path, a missing id, a multi-segment path. The
 * server layer interprets undefined as "not the revoke route" and
 * routes to the list handler instead (or 404).
 */
export function parseRevokeIdFromUrl(url: string): string | undefined {
  // Strip query string + leading slash so `/admin/keys/42?x=y` and
  // `/admin/keys/42` both resolve to the same id.
  const noQuery = url.split('?', 1)[0] ?? url;
  if (!noQuery.startsWith('/admin/keys/')) return undefined;
  const tail = noQuery.slice('/admin/keys/'.length);
  if (tail.length === 0) return undefined;
  if (tail.includes('/')) return undefined;
  return tail;
}
