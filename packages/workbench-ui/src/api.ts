/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Thin fetch + EventSource wrappers for the Workbench API. Same-origin
 * by convention (the UI is served behind the same Ingress as the API),
 * so paths are relative.
 */

import type { CacheChangeEvent, TaskDetail, TaskSummary } from './types.js';

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
