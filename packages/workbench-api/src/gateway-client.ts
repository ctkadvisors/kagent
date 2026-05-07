/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * HTTP client for the kagent LLM gateway's `/admin/*` endpoints.
 *
 * The workbench-api is the privileged caller — it presents the gateway's
 * admin bearer token and gets back the AIMD snapshot (cap, in-flight,
 * recent-window stats) plus the per-request `usage` rows. We then expose
 * a flattened, UI-shaped projection on `/api/gateway/*` for the
 * workbench-ui's Gateway page.
 *
 * Why a thin client wrapper instead of inlining `fetch` calls in each
 * route handler:
 *   - Single place to thread the admin token + base URL.
 *   - Trivially mockable in tests (route tests inject a fake `GatewayClient`).
 *   - Centralises timeout + error-shape decisions so a 5xx from the gateway
 *     doesn't leak the gateway's pod name back to the workbench client.
 *
 * This client is read-only against the gateway. Mutations to AIMD bounds
 * happen via PATCH on the `ModelEndpoint` CR (Kubernetes API, not gateway
 * API) — the gateway's K8s informer picks up the new bounds within ~1s.
 * That keeps Argo's source-of-truth invariant intact: every config change
 * still passes through the K8s API.
 */

/**
 * One row per registered (model, backendUrl) pair. Mirrors
 * `packages/llm-gateway/src/admin-routes.ts:CapacityRow`. Re-declared
 * here to avoid a build-time dependency on the gateway package.
 */
export interface GatewayCapacityRow {
  readonly model: string;
  readonly endpoint: string;
  readonly backendKind: string;
  readonly inFlight: number;
  readonly currentCap: number;
  readonly seed: number;
  readonly max: number;
  readonly minSafe: number;
  readonly recentP50Ms: number | null;
}

import { scrubErrorMessage } from './error-scrub.js';

/**
 * One row per logged request. Mirrors the gateway's `usage` table shape
 * after the admin handler's projection. Field set is what the gateway's
 * `usage_recent` query returns; we keep it loose (`unknown`-typed
 * timestamps) because the gateway's UsageRow lives in a separate package
 * and we'd rather not import it for one column.
 */
export interface GatewayUsageRow {
  readonly id?: number | string;
  readonly requestId: string;
  readonly model: string;
  readonly backend: string;
  readonly backendUrl: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly statusCode: number;
  readonly streaming: boolean;
  // Nullable string fields: the gateway projects SQL NULLs through as JSON
  // null (NOT undefined / missing). UI must guard with `!= null`, not
  // `!== undefined`, or `null.slice` will throw at render time.
  readonly taskUid?: string | null;
  readonly agentName?: string | null;
  readonly errorMessage?: string | null;
  readonly occurredAt?: string;
}

export interface GatewayClient {
  readonly capacity: () => Promise<readonly GatewayCapacityRow[]>;
  readonly usage: (params: GatewayUsageQuery) => Promise<readonly GatewayUsageRow[]>;
}

export interface GatewayUsageQuery {
  readonly limit?: number;
  readonly since?: string;
  readonly until?: string;
  readonly model?: string;
  readonly taskUid?: string;
  readonly agentName?: string;
}

export interface GatewayClientConfig {
  /**
   * Base URL of the gateway's HTTP listener — e.g.
   * `http://kagent-llm-gateway.kagent-system.svc.cluster.local:4000`.
   * No trailing slash; client appends `/admin/<path>`.
   */
  readonly baseUrl: string;
  /**
   * Admin bearer token. Sourced by the chart from the gateway's own
   * `kagent-llm-gateway-token` Secret (workbench reads the SAME token
   * the gateway issues for /admin/*).
   */
  readonly adminToken: string;
  /**
   * Per-request timeout in ms. Default 5000 — the gateway's admin
   * endpoints are O(1) over in-memory state + a Postgres query for
   * usage. A 5s ceiling means a stuck gateway pod fails the workbench
   * route fast rather than hanging the user's browser.
   */
  readonly timeoutMs?: number;
  /** Test injection point. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function createGatewayClient(cfg: GatewayClientConfig): GatewayClient {
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');

  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${cfg.adminToken}`,
  };

  async function get(pathAndQuery: string): Promise<unknown> {
    const url = `${baseUrl}${pathAndQuery}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `gateway admin returned HTTP ${String(response.status)} for ${pathAndQuery}: ${body.slice(0, 200)}`,
      );
    }
    return await response.json();
  }

  return {
    async capacity(): Promise<readonly GatewayCapacityRow[]> {
      const body = (await get('/admin/capacity')) as { rows?: unknown };
      if (!Array.isArray(body.rows)) return [];
      return body.rows as readonly GatewayCapacityRow[];
    },

    async usage(params: GatewayUsageQuery): Promise<readonly GatewayUsageRow[]> {
      const qs = new URLSearchParams();
      if (params.limit !== undefined) qs.set('limit', String(params.limit));
      if (params.since !== undefined) qs.set('since', params.since);
      if (params.until !== undefined) qs.set('until', params.until);
      if (params.model !== undefined) qs.set('model', params.model);
      if (params.taskUid !== undefined) qs.set('taskUid', params.taskUid);
      if (params.agentName !== undefined) qs.set('agentName', params.agentName);
      const q = qs.toString();
      const path = q.length > 0 ? `/admin/usage?${q}` : '/admin/usage';
      const body = (await get(path)) as { rows?: unknown };
      if (!Array.isArray(body.rows)) return [];
      // M15 — second-line scrub on `errorMessage` before the projection
      // leaves the workbench-api. H15 covers the gateway's own write
      // path; this catches legacy rows persisted before H15 landed and
      // any future bypasses of the gateway recorder.
      return (body.rows as readonly GatewayUsageRow[]).map(scrubUsageRow);
    },
  };
}

/**
 * M15 — apply `scrubErrorMessage` to a usage row's nullable
 * `errorMessage`. Other columns pass through unchanged. Pure for tests.
 */
export function scrubUsageRow(row: GatewayUsageRow): GatewayUsageRow {
  if (row.errorMessage === undefined || row.errorMessage === null) return row;
  const scrubbed = scrubErrorMessage(row.errorMessage);
  if (scrubbed === row.errorMessage) return row;
  return { ...row, errorMessage: scrubbed };
}
