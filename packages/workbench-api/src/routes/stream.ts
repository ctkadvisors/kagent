/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `GET /api/stream` — Server-Sent Events fan-out of cache mutations.
 *
 * Wire format:
 *
 *   event: cache
 *   data: {"kind":"task","op":"upsert","key":"default/alpha"}
 *
 *   event: heartbeat
 *   data: {"ts":"2026-04-26T12:00:00.000Z"}
 *
 * The UI listens for `cache` events and refetches the affected
 * `/api/tasks/...` or `/api/agents` endpoint to get the projection.
 * The heartbeat is sent every 25 seconds to keep proxies (Traefik,
 * nginx-ingress) from idle-killing the connection.
 *
 * M16 — Per-user + global connection caps. Each connected SSE
 * subscriber holds a long-lived TCP connection plus a SnapshotCache
 * subscription. Without a cap, an authenticated user (or one
 * misbehaving / spoofing client when auth is disabled) can open
 * thousands of /api/stream sockets and exhaust both the workbench-api
 * Pod's FD budget AND the SnapshotCache's listener fan-out (every
 * cache mutation walks every subscriber). The cap counts ACTIVE
 * subscribers in process-local maps; on disconnect (stream.onAbort)
 * the slot is released. Heuristic limits (5 per user, 1000 total) are
 * generous for the homelab posture but bounded.
 */

import { streamSSE } from 'hono/streaming';
import { Hono } from 'hono';

import type { SseBroker } from '../sse.js';
import { formatHeartbeat } from '../sse.js';

const HEARTBEAT_MS = 25_000;

/**
 * Defaults — keep in sync with the audit's M16 recommendation. The
 * homelab has at most 1-2 humans hitting the workbench at any given
 * time; a cap of 5 leaves headroom for tab duplication / reconnect
 * jitter without admitting a per-user DoS. The global cap of 1000
 * sits well below the workbench-api's default FD budget (Node's
 * default is ~1024) so we fail at the application layer with a
 * structured 503 instead of crashing on EMFILE.
 */
const DEFAULT_PER_USER_LIMIT = 5;
const DEFAULT_TOTAL_LIMIT = 1_000;

const FORWARDED_USER_HEADER = 'X-Forwarded-User';
const ANONYMOUS_USER = '<anonymous>';

export interface StreamRouteDeps {
  readonly broker: SseBroker;
  /** Override `setInterval` in tests. Defaults to global. */
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  /** Override `clearInterval` in tests. Defaults to global. */
  readonly clearInterval?: (handle: unknown) => void;
  /**
   * M16 — Maximum concurrent SSE connections per authenticated user.
   * Default 5. Set `0` to disable enforcement (tests / reader-only
   * sidecars where the cap is enforced at a higher layer).
   */
  readonly perUserLimit?: number;
  /**
   * M16 — Maximum concurrent SSE connections across all users on this
   * pod. Default 1000. Set `0` to disable enforcement.
   */
  readonly totalLimit?: number;
}

export function streamRoute(deps: StreamRouteDeps): Hono {
  const app = new Hono();
  const setInt = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearInt =
    deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const perUserLimit = deps.perUserLimit ?? DEFAULT_PER_USER_LIMIT;
  const totalLimit = deps.totalLimit ?? DEFAULT_TOTAL_LIMIT;

  // Process-local connection counters. Hono's auth middleware writes
  // the authenticated user to `c.var.user`; when auth is disabled and
  // no header is present, fall back to ANONYMOUS_USER so the per-user
  // cap still bounds anonymous traffic from a single source.
  let totalConnections = 0;
  const perUserConnections = new Map<string, number>();

  app.get('/api/stream', (c) => {
    // Resolve the user. When auth.ts has run, it sets `user` on the
    // context; when auth is disabled or the request bypassed the
    // middleware (test harnesses), we use the header directly.
    const userVar = c.var as Record<string, unknown> | undefined;
    const userFromVar =
      typeof userVar?.user === 'string' && userVar.user.length > 0 ? userVar.user : null;
    const userFromHeader = c.req.header(FORWARDED_USER_HEADER)?.trim();
    const user =
      userFromVar !== null
        ? userFromVar
        : userFromHeader !== undefined && userFromHeader.length > 0
          ? userFromHeader
          : ANONYMOUS_USER;

    if (totalLimit > 0 && totalConnections >= totalLimit) {
      return c.json(
        {
          error: 'sse-total-cap',
          message: `workbench-api SSE total connection cap reached (limit=${String(totalLimit)})`,
        },
        503,
      );
    }
    const userCount = perUserConnections.get(user) ?? 0;
    if (perUserLimit > 0 && userCount >= perUserLimit) {
      return c.json(
        {
          error: 'sse-per-user-cap',
          message: `workbench-api SSE per-user connection cap reached for user (limit=${String(perUserLimit)})`,
        },
        429,
      );
    }

    // Reserve the slot BEFORE entering the streamSSE handler. Hono's
    // streamSSE returns immediately after registering the handler, so
    // counting on first-write would race with simultaneous requests.
    totalConnections++;
    perUserConnections.set(user, userCount + 1);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      totalConnections = Math.max(0, totalConnections - 1);
      const next = (perUserConnections.get(user) ?? 1) - 1;
      if (next <= 0) perUserConnections.delete(user);
      else perUserConnections.set(user, next);
    };

    return streamSSE(c, async (stream) => {
      // Fire-and-forget writeSSE that swallows post-disconnect rejections.
      // Hono rejects pending writes when the request aborts; without this
      // catch, those rejections become unhandled-promise warnings (and on
      // newer Node may exit the worker via `--unhandled-rejections=strict`).
      // The SseBroker still counts drops on synchronous sink errors.
      const safeWrite = (wire: { event: string; data: string }): void => {
        stream.writeSSE({ event: wire.event, data: wire.data }).catch(() => {});
      };

      const sub = deps.broker.subscribe((wire) => {
        safeWrite(wire);
      });

      const heartbeatHandle = setInt(() => {
        safeWrite(formatHeartbeat());
      }, HEARTBEAT_MS);

      const aborted = new Promise<void>((resolve) => {
        stream.onAbort(() => {
          resolve();
        });
      });

      // Send an initial heartbeat so the client knows the connection
      // is live (some EventSource impls don't fire `open` until the
      // first event arrives). Use safeWrite instead of awaiting the
      // first write: test and slow-client harnesses may not pull the
      // body immediately, but abort cleanup must already be registered.
      safeWrite(formatHeartbeat());

      // Wait for client disconnect. Hono closes the stream when the
      // request aborts; we hook into that to clean up the subscription
      // and the heartbeat timer.
      try {
        await aborted;
      } finally {
        sub.unsubscribe();
        clearInt(heartbeatHandle);
        release();
      }
    });
  });

  return app;
}
