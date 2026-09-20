/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * A `fetch` for calls that are allowed to take a long time.
 *
 * Node's built-in fetch (undici) aborts a request after 300 s without
 * response headers, and again after 300 s between body chunks, and offers
 * no way to change that without the undici package. A thinking model's turn
 * is legitimately longer: on 2026-09-20 a fleet-auditor turn died at
 * 5m0.55s with "LLM backend returned HTTP 502" while the spark was still
 * decoding it.
 *
 * So the gateway's backend calls go over node:http(s), which has no such
 * timers, and carry two of our own, both explicit and both configurable:
 *
 *   - maxMs (BACKEND_TIMEOUT_MS): hard cap on the whole call.
 *   - idleMs (BACKEND_IDLE_TIMEOUT_MS): longest silence on the wire. Only
 *     meaningful when the caller streams, so the caller opts in per request
 *     with `streaming: true`; a non-streamed call is silent its whole life.
 *
 * "A slow provider must be visibly slow, never indistinguishable from a dead
 * one": streamed calls with an idle timer are how the gateway tells them
 * apart.
 *
 * Returns a real `Response`, so providers and their fetch stubs are unchanged.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

export interface LongFetchOptions {
  /** Hard cap on one call, connect to last byte. */
  readonly maxMs: number;
  /** Longest silence (headers or body) tolerated on a call that opted in with `streaming`. */
  readonly idleMs: number;
}

/** `RequestInit` plus the per-call idle timer a streaming caller asks for. */
export interface LongFetchInit extends RequestInit {
  /** The call streams, so silence longer than `idleMs` means the backend is gone. */
  readonly streaming?: boolean;
}

export class BackendTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendTimeoutError';
  }
}

export function createLongFetch(opts: LongFetchOptions): typeof fetch {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const i = (init ?? {}) as LongFetchInit;
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(url, {
        method: i.method ?? 'GET',
        headers: Object.fromEntries(new Headers(i.headers).entries()),
      });

      let res: IncomingMessage | undefined;
      let idle: NodeJS.Timeout | undefined;
      const fail = (err: Error): void => {
        clearTimeout(idle);
        clearTimeout(cap);
        req.destroy(err);
        res?.destroy(err);
        reject(err); // a no-op once resolved; the body stream then errors instead
      };
      const cap = setTimeout(() => {
        fail(new BackendTimeoutError(`backend call exceeded ${String(opts.maxMs)} ms`));
      }, opts.maxMs);
      const touch = (): void => {
        if (i.streaming !== true) return;
        clearTimeout(idle);
        idle = setTimeout(() => {
          fail(new BackendTimeoutError(`backend silent for ${String(opts.idleMs)} ms`));
        }, opts.idleMs);
      };
      touch();

      if (i.signal) {
        const signal = i.signal;
        const onAbort = (): void => {
          fail(new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      req.on('error', fail);
      req.on('response', (r) => {
        res = r;
        touch();
        r.on('data', touch);
        r.on('close', () => {
          clearTimeout(idle);
          clearTimeout(cap);
        });
        const headers = new Headers();
        for (const [k, v] of Object.entries(r.headers)) {
          if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        }
        const status = r.statusCode ?? 502;
        // 204/304 responses may not carry a body in the Response constructor.
        const body =
          status === 204 || status === 304 ? null : (Readable.toWeb(r) as ReadableStream);
        resolve(new Response(body, { status, headers }));
      });
      if (i.body != null && typeof i.body !== 'string') {
        fail(new TypeError('long-fetch sends string bodies only'));
        return;
      }
      req.end(i.body ?? undefined);
    });
}
