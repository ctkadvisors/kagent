/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Thin fetch + EventSource wrappers for the Workbench API. Same-origin
 * by convention (the UI is served behind the same Ingress as the API),
 * so paths are relative.
 */

import type {
  AgentSummaryRow,
  CacheChangeEvent,
  ClusterSnapshot,
  CreateTaskError,
  CreateTaskRequest,
  CreateTaskResponse,
  GatewayCapacityResponse,
  GatewayUsageResponse,
  PatchInFlightRequest,
  TaskDetail,
  TaskSummary,
} from './types.js';

export async function fetchTasks(signal?: AbortSignal): Promise<TaskSummary[]> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch('/api/tasks', init);
  if (!res.ok) {
    throw new Error(`fetchTasks: ${String(res.status)} ${res.statusText}`);
  }
  const body = (await res.json()) as { items?: TaskSummary[] };
  return body.items ?? [];
}

/**
 * Fetch one task's detail projection. The API returns a 404 when the
 * task isn't in the cache; `fetchTaskDetail` translates that into a
 * thrown `Error` with the status text so the caller can surface a
 * user-visible "not found" state without leaking response shape.
 */
export async function fetchTaskDetail(
  namespace: string,
  name: string,
  signal?: AbortSignal,
): Promise<TaskDetail> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
    init,
  );
  if (!res.ok) {
    throw new Error(`fetchTaskDetail: ${String(res.status)} ${res.statusText}`);
  }
  return (await res.json()) as TaskDetail;
}

/**
 * Subscribe to the SSE event stream. Returns a cleanup function the
 * caller can invoke to close the connection (e.g. in a React effect's
 * teardown).
 */
export function subscribeCacheEvents(
  onCache: (ev: CacheChangeEvent) => void,
  onHeartbeat?: () => void,
): () => void {
  const source = new EventSource('/api/stream');

  source.addEventListener('cache', (ev: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(ev.data) as CacheChangeEvent;
      onCache(parsed);
    } catch {
      // Drop malformed payloads — stream is best-effort.
    }
  });

  if (onHeartbeat !== undefined) {
    source.addEventListener('heartbeat', () => {
      onHeartbeat();
    });
  }

  return () => source.close();
}

/**
 * Fetch the Agent catalog for the New-Task modal's agent picker.
 * Returns an empty list on non-2xx so the modal degrades to a manual
 * text input rather than blocking the user behind a fetch error.
 */
export async function fetchAgents(signal?: AbortSignal): Promise<AgentSummaryRow[]> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch('/api/agents', init);
  if (!res.ok) return [];
  const body = (await res.json()) as { items?: AgentSummaryRow[] };
  return body.items ?? [];
}

/**
 * POST /api/tasks. Returns the created task's identity on success;
 * throws a `CreateTaskError`-shaped object on any non-201 so the
 * caller can distinguish validation failures from RBAC denials from
 * transient API errors.
 */
export async function createTask(req: CreateTaskRequest): Promise<CreateTaskResponse> {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (res.status === 201) {
    return (await res.json()) as CreateTaskResponse;
  }
  let body: { error?: string; fields?: CreateTaskError['fields'] } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON 5xx — fall through with empty body */
  }
  // Throw an Error subclass so eslint's only-throw-error rule is happy
  // and the caller can `instanceof CreateTaskApiError` if they want.
  throw new CreateTaskApiError(
    res.status,
    body.error ?? `request failed: ${String(res.status)} ${res.statusText}`,
    body.fields,
  );
}

export class CreateTaskApiError extends Error {
  readonly status: number;
  readonly fields: CreateTaskError['fields'] | undefined;
  constructor(status: number, message: string, fields?: CreateTaskError['fields']) {
    super(message);
    this.name = 'CreateTaskApiError';
    this.status = status;
    this.fields = fields;
  }
  get error(): string {
    return this.message;
  }
}

/* =====================================================================
 * Gateway page surface — proxies the workbench-api's `/api/gateway/*`
 * endpoints (which themselves proxy the LLM gateway's /admin/*).
 *
 * Empty / unconfigured gateway → 503 from the API → here we throw an
 * Error with the body's message so the UI can render an explanatory
 * empty state. 502 (gateway-unreachable) → same path, distinct message.
 * ===================================================================== */

export async function fetchGatewayCapacity(signal?: AbortSignal): Promise<GatewayCapacityResponse> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch('/api/gateway/capacity', init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new GatewayApiError(
      res.status,
      body.message ?? body.error ?? `gateway capacity: ${String(res.status)} ${res.statusText}`,
    );
  }
  return (await res.json()) as GatewayCapacityResponse;
}

export async function fetchGatewayUsage(
  params: { readonly limit?: number; readonly model?: string; readonly taskUid?: string } = {},
  signal?: AbortSignal,
): Promise<GatewayUsageResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.model !== undefined) qs.set('model', params.model);
  if (params.taskUid !== undefined) qs.set('taskUid', params.taskUid);
  const url =
    qs.toString().length > 0 ? `/api/gateway/usage?${qs.toString()}` : '/api/gateway/usage';
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new GatewayApiError(
      res.status,
      body.message ?? body.error ?? `gateway usage: ${String(res.status)} ${res.statusText}`,
    );
  }
  return (await res.json()) as GatewayUsageResponse;
}

/**
 * PATCH a ModelEndpoint's inflight bounds. Returns a normalized result
 * shape; throws `GatewayApiError` on any non-2xx so the UI can show
 * "could not save" + the API's reason.
 */
export async function patchModelEndpointInFlight(
  namespace: string,
  name: string,
  body: PatchInFlightRequest,
): Promise<void> {
  const res = await fetch(
    `/api/modelendpoints/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new GatewayApiError(
      res.status,
      errBody.message ??
        errBody.error ??
        `patch modelendpoint: ${String(res.status)} ${res.statusText}`,
    );
  }
}

export class GatewayApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GatewayApiError';
    this.status = status;
  }
}

/* =====================================================================
 * Cluster page — substrate visibility surface.
 * ===================================================================== */

export async function fetchClusterSnapshot(signal?: AbortSignal): Promise<ClusterSnapshot> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch('/api/cluster/snapshot', init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(
      body.message ?? body.error ?? `cluster snapshot: ${String(res.status)} ${res.statusText}`,
    );
  }
  return (await res.json()) as ClusterSnapshot;
}
