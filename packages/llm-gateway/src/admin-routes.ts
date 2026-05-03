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

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { AimdController } from './aimd.js';
import type { InFlightCounter } from './inflight-counter.js';
import type { ModelIndex } from './model-index.js';
import type { UsageRepo, UsageQueryFilter } from './db/usage.js';

export interface AdminAuthResult {
  readonly ok: boolean;
  readonly statusCode?: 401 | 403;
  readonly message?: string;
}

export function adminAuth(req: IncomingMessage, expectedToken: string): AdminAuthResult {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || auth.length === 0) {
    return { ok: false, statusCode: 401, message: 'missing authorization header' };
  }
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (supplied.length !== expectedToken.length) {
    return { ok: false, statusCode: 403, message: 'admin token mismatch' };
  }
  const a = Buffer.from(supplied);
  const b = Buffer.from(expectedToken);
  if (!timingSafeEqual(a, b)) {
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
