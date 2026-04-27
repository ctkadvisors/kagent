/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * HTTP server boot — wraps `@hono/node-server` so `main.ts` doesn't
 * have to know about platform-specific server libraries.
 */

import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

export interface ServerHandle {
  /** Stop accepting new connections; resolves when in-flight requests drain. */
  close(): Promise<void>;
  /** Bound port — useful when the caller passed `port: 0`. */
  port: number;
}

export interface ServerOptions {
  readonly port: number;
  readonly hostname?: string;
}

export function startServer(app: Hono, opts: ServerOptions): ServerHandle {
  const server = serve(
    {
      fetch: app.fetch,
      port: opts.port,
      ...(opts.hostname !== undefined && { hostname: opts.hostname }),
    },
    (info) => {
      console.log(`[workbench-api] listening on http://${info.address}:${info.port.toString()}`);
    },
  );

  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : opts.port;

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined) reject(err);
          else resolve();
        });
      });
    },
  };
}
