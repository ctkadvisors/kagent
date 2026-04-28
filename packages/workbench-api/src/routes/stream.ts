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
 */

import { streamSSE } from 'hono/streaming';
import { Hono } from 'hono';

import type { SseBroker } from '../sse.js';
import { formatHeartbeat } from '../sse.js';

const HEARTBEAT_MS = 25_000;

export interface StreamRouteDeps {
  readonly broker: SseBroker;
  /** Override `setInterval` in tests. Defaults to global. */
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  /** Override `clearInterval` in tests. Defaults to global. */
  readonly clearInterval?: (handle: unknown) => void;
}

export function streamRoute(deps: StreamRouteDeps): Hono {
  const app = new Hono();
  const setInt = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearInt =
    deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  app.get('/api/stream', (c) => {
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

      // Send an initial heartbeat so the client knows the connection
      // is live (some EventSource impls don't fire `open` until the
      // first event arrives).
      const initial = formatHeartbeat();
      await stream.writeSSE({ event: initial.event, data: initial.data });

      // Wait for client disconnect. Hono closes the stream when the
      // request aborts; we hook into that to clean up the subscription
      // and the heartbeat timer.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          sub.unsubscribe();
          clearInt(heartbeatHandle);
          resolve();
        });
      });
    });
  });

  return app;
}
