/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Thin fetch + EventSource wrappers for the Workbench API. Same-origin
 * by convention (the UI is served behind the same Ingress as the API),
 * so paths are relative.
 */

import { useEffect, useRef, useState } from 'react';

import { assertIsDispositionOverlayRow } from '@kagent/dto/disposition';
import { assertIsReviewQueueRow } from '@kagent/dto/review-queue';

import type {
  AgentSummaryRow,
  CacheChangeEvent,
  ClusterSnapshot,
  CreateTaskError,
  CreateTaskRequest,
  CreateTaskResponse,
  DispositionOverlayRow,
  GatewayCapacityResponse,
  GatewayProviderDispatchState,
  GatewayUsageResponse,
  PatchInFlightRequest,
  ReviewQueueRow,
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
 * Phase 1 / DISP-04 — fetch the per-Agent disposition projection from
 * `GET /api/dispositions`. Each row passes `assertIsDispositionOverlayRow`
 * as a defense against schema drift between the workbench-api and
 * workbench-ui — if the API's emitted shape ever diverges from the
 * shared DTO in `@kagent/dto`, the rejected row throws here rather
 * than corrupting the Command Center overlay state silently.
 *
 * Unlike `fetchAgents`, this throws on non-2xx (matching `fetchTasks`)
 * because the disposition overlay is an explicit Command Center
 * surface — a 500 must surface to the operator, not be hidden behind
 * an empty list.
 */
export async function fetchDispositions(signal?: AbortSignal): Promise<DispositionOverlayRow[]> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch('/api/dispositions', init);
  if (!res.ok) {
    throw new Error(`fetchDispositions: ${String(res.status)} ${res.statusText}`);
  }
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  for (const it of items) assertIsDispositionOverlayRow(it);
  return items as DispositionOverlayRow[];
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

/**
 * DELETE /api/tasks/:namespace/:name. Deleting the AgentTask is the
 * substrate kill path: the operator-owned Job and ConfigMap carry
 * ownerReferences back to the AgentTask, so Kubernetes GC tears down
 * the runtime Pod instead of merely changing Workbench-visible status.
 */
export async function terminateTask(namespace: string, name: string): Promise<void> {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CreateTaskApiError(
      res.status,
      body.error ?? `terminate task: ${String(res.status)} ${res.statusText}`,
    );
  }
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

export async function fetchGatewayProviderDispatch(
  signal?: AbortSignal,
): Promise<GatewayProviderDispatchState> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch('/api/gateway/provider-dispatch', init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new GatewayApiError(
      res.status,
      body.message ?? body.error ?? `gateway dispatch: ${String(res.status)} ${res.statusText}`,
    );
  }
  return (await res.json()) as GatewayProviderDispatchState;
}

export async function setGatewayProviderDispatchDisabled(
  disabled: boolean,
): Promise<GatewayProviderDispatchState> {
  const res = await fetch('/api/gateway/provider-dispatch', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new GatewayApiError(
      res.status,
      body.message ?? body.error ?? `gateway dispatch: ${String(res.status)} ${res.statusText}`,
    );
  }
  return (await res.json()) as GatewayProviderDispatchState;
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

/* =====================================================================
 * Review queue surface — Phase 4 / REV-01 / REV-02.
 *
 * GET  /api/review-queue             → fetchReviewQueue
 * POST /api/review-queue/:ns/:name/accept  → acceptReviewQueueRow
 * POST /api/review-queue/:ns/:name/reject  → rejectReviewQueueRow
 * POST /api/review-queue/:ns/:name/request → requestReview
 *
 * All POST helpers throw `ReviewActionApiError` (status: number) on
 * non-2xx responses. `fetchReviewQueue` throws a plain Error on non-2xx
 * (mirrors `fetchDispositions` / `fetchTasks` pattern).
 *
 * URL-injection defense: `encodeURIComponent` on namespace + name per
 * the createTask / patchModelEndpointInFlight pattern.
 *
 * Schema drift defense: `assertIsReviewQueueRow` from @kagent/dto runs
 * on every item in `fetchReviewQueue` — mirrors `assertIsDispositionOverlayRow`.
 *
 * §11 bounds-test slice: polling at 5s; AbortController per refresh;
 * cleanup on unmount; no new substrate state.
 * ===================================================================== */

/** Body sent to the accept endpoint. */
export interface AcceptReviewBody {
  readonly reviewerId?: string;
  readonly reasonText?: string;
}

/** Body sent to the reject endpoint. */
export interface RejectReviewBody {
  readonly reviewerId?: string;
  readonly reasonText?: string;
}

/** Body sent to the request-review endpoint. */
export interface RequestReviewBody {
  readonly reviewerId?: string;
  readonly reasonText?: string;
}

/** Response from the accept endpoint. */
export interface AcceptReviewResponse {
  readonly taskRef: { readonly namespace: string; readonly name: string; readonly uid: string };
  readonly decision: 'accepted';
  readonly auditedAt: string;
  readonly agentTemplateRef?: {
    readonly namespace: string;
    readonly name: string;
    readonly uid: string;
  };
}

/** Response from the reject endpoint. */
export interface RejectReviewResponse {
  readonly taskRef: { readonly namespace: string; readonly name: string; readonly uid: string };
  readonly decision: 'rejected';
  readonly auditedAt: string;
}

/** Response from the request-review endpoint. */
export interface RequestReviewResponse {
  readonly taskRef: { readonly namespace: string; readonly name: string; readonly uid: string };
  readonly requested: boolean;
  readonly requestedAt: string;
}

/**
 * Error subclass thrown by the review-queue POST helpers on non-2xx
 * responses. Carries `status: number` for typed 4xx/5xx handling at
 * the call site (mirror of CreateTaskApiError).
 */
export class ReviewActionApiError extends Error {
  readonly status: number;
  /**
   * WR-02 (Plan 04-06): structured detail surfaced from the server's
   * 422 response body (e.g., the `parseAgentTemplateSpec` parser error
   * tag). Undefined when the server response carried no `detail`
   * field or the body was not JSON.
   */
  readonly detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'ReviewActionApiError';
    this.status = status;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

/**
 * GET /api/review-queue — fetch the current review queue projection.
 * Each row passes `assertIsReviewQueueRow` as drift defense.
 * Throws on non-2xx (surfaces to the operator; mirrors fetchDispositions).
 */
export async function fetchReviewQueue(signal?: AbortSignal): Promise<ReviewQueueRow[]> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch('/api/review-queue', init);
  if (!res.ok) {
    throw new Error(`fetchReviewQueue: ${String(res.status)} ${res.statusText}`);
  }
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  for (const it of items) assertIsReviewQueueRow(it);
  return items as ReviewQueueRow[];
}

/**
 * POST /api/review-queue/:namespace/:name/accept
 * Throws `ReviewActionApiError` on non-200 (including 422 validation
 * failures and 503 write-surface-disabled errors).
 */
export async function acceptReviewQueueRow(
  namespace: string,
  name: string,
  body: AcceptReviewBody,
): Promise<AcceptReviewResponse> {
  const url = `/api/review-queue/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/accept`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    let errBody: { error?: string; detail?: string } = {};
    try {
      errBody = (await res.json()) as typeof errBody;
    } catch {
      /* non-JSON error — fall through */
    }
    throw new ReviewActionApiError(
      res.status,
      errBody.error ?? `accept failed: ${String(res.status)} ${res.statusText}`,
      errBody.detail,
    );
  }
  return (await res.json()) as AcceptReviewResponse;
}

/**
 * POST /api/review-queue/:namespace/:name/reject
 * Throws `ReviewActionApiError` on non-200.
 */
export async function rejectReviewQueueRow(
  namespace: string,
  name: string,
  body: RejectReviewBody,
): Promise<RejectReviewResponse> {
  const url = `/api/review-queue/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/reject`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    let errBody: { error?: string; detail?: string } = {};
    try {
      errBody = (await res.json()) as typeof errBody;
    } catch {
      /* non-JSON error — fall through */
    }
    throw new ReviewActionApiError(
      res.status,
      errBody.error ?? `reject failed: ${String(res.status)} ${res.statusText}`,
      errBody.detail,
    );
  }
  return (await res.json()) as RejectReviewResponse;
}

/**
 * POST /api/review-queue/:namespace/:name/request
 * Throws `ReviewActionApiError` on non-200.
 */
export async function requestReview(
  namespace: string,
  name: string,
  body: RequestReviewBody,
): Promise<RequestReviewResponse> {
  const url = `/api/review-queue/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/request`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    let errBody: { error?: string; detail?: string } = {};
    try {
      errBody = (await res.json()) as typeof errBody;
    } catch {
      /* non-JSON error — fall through */
    }
    throw new ReviewActionApiError(
      res.status,
      errBody.error ?? `request failed: ${String(res.status)} ${res.statusText}`,
      errBody.detail,
    );
  }
  return (await res.json()) as RequestReviewResponse;
}

/**
 * Hook: polls GET /api/review-queue every 5s (CONTEXT.md D-01-A default).
 * AbortController per refresh for cancelation on unmount.
 * Returns `{ rows, loading, error, refresh }`.
 *
 * Phase 4 / REV-01. Polling cadence: 5 000 ms per CONTEXT.md
 * "Claude's Discretion" note. SSE-driven invalidation deferred (v0.2).
 *
 * WR-08 (Plan 04-06): NO exponential backoff on error. Rationale:
 * `/api/review-queue` is a GET projection over `SnapshotCache.listTasks()`
 * served by the same workbench-api process that serves
 * `/api/dispositions` and `/api/tasks`. It is pure-read; it is NOT
 * gated by the `actions.create=true` Helm flag that fails-closed the
 * POST endpoints with 503. A 503 from this GET endpoint is
 * structurally impossible in the current substrate — the same
 * process serving `useReviewQueue` would have already failed to
 * serve the surrounding TaskList/CommandView reads and the
 * operator dashboard would be globally degraded. The 5-Hz hammer
 * pattern WR-08 describes is therefore a theoretical concern
 * rather than a realized failure mode in v0.2.
 *
 * TODO (Phase 5+): when a fleet of operator dashboards becomes a
 * real concern, lift the polling logic into a shared helper
 * (`createPollingHook(url, intervalMs, options)`) with optional
 * exponential backoff on persistent error. Mirror the existing
 * `fetchDispositions` 30 s polling pattern (state.ts
 * DISPOSITION_POLL_MS) and the SSE invalidation seam.
 */
export function useReviewQueue(): {
  readonly rows: readonly ReviewQueueRow[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const [rows, setRows] = useState<readonly ReviewQueueRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = (): void => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    fetchReviewQueue(ctrl.signal)
      .then((items) => {
        setRows(items);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      refresh();
    }, 5_000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
    // refresh is captured by ref-based identity inside the closure;
    // adding it to deps would restart the interval on every call.
    // Empty dep array is intentional: run once on mount, clean up on unmount.
  }, []);

  return { rows, loading, error, refresh };
}

// ── kagent Studio — Architect (chat to create) ──────────────────────

/** Result of POST /api/architect/draft. */
export interface ArchitectDraftResult {
  readonly ok: boolean;
  readonly candidateYaml: string;
  readonly preview: unknown;
}

/** Result of POST /api/architect/try. */
export interface ArchitectTryResult {
  readonly namespace: string;
  readonly name: string;
  readonly uid?: string;
  readonly templateName: string;
  readonly templateUid?: string;
  readonly agentName: string;
  readonly agentUid?: string;
  readonly taskName: string;
  readonly taskUid?: string;
  readonly _links?: {
    readonly detail?: string;
    readonly ui?: string;
    readonly langfuse?: string;
  };
}

/**
 * POST /api/architect/draft — turn a natural-language goal into a
 * validated AgentTemplate candidate (generation + self-correct happens
 * server-side). 422 means the Architect could not produce a valid
 * candidate; surface the error to the user.
 */
export async function architectDraft(goal: string): Promise<ArchitectDraftResult> {
  const res = await fetch('/api/architect/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok) {
    let detail = `${String(res.status)} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`architectDraft: ${detail}`);
  }
  return (await res.json()) as ArchitectDraftResult;
}

/**
 * POST /api/architect/try — persist the candidate, launch a draft
 * AgentTask in kagent-draft, and return task/trace links. 503 = write
 * surface disabled on the chart; 422 = candidate failed validation.
 */
export async function architectTry(
  candidateYaml: string,
  goal?: string,
): Promise<ArchitectTryResult> {
  const res = await fetch('/api/architect/try', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      candidateYaml,
      ...(goal !== undefined && goal.trim() !== '' && { goal: goal.trim() }),
    }),
  });
  if (res.status !== 201) {
    let detail = `${String(res.status)} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`architectTry: ${detail}`);
  }
  return (await res.json()) as ArchitectTryResult;
}
