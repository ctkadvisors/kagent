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
  CreateTaskError,
  CreateTaskRequest,
  CreateTaskResponse,
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
