/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Typed error envelope thrown by providers when an upstream returns a
 * non-2xx response (or any other operational failure that needs to be
 * carried as structured data through the router).
 *
 * Two motivations:
 *
 *   1. **H13 — 429 propagation.** A plain `Error("openai error 429:
 *      ...")` collapses upstream backpressure into a generic 502 at the
 *      router layer. agent-pod then retries immediately and stampedes
 *      the upstream. By preserving `status` + `retryAfter` on the
 *      thrown error, the router can emit a discriminated
 *      `backend_throttled` result that the server layer translates
 *      into a real HTTP 429 + `Retry-After` header (matching the
 *      audit's H13 baseline; see GATEWAY-CONTRACT.md §7).
 *
 *   2. **H15 — error-body hygiene.** The same envelope carries an
 *      already-truncated, secret-scrubbed message. Providers MUST go
 *      through the `BackendError.fromUpstreamResponse()` factory which
 *      runs the scrubber + truncation; the router records the
 *      sanitised message verbatim into `usage_records.error_message`.
 *
 * The class is deliberately small. The provider layer constructs it,
 * the router catches it, the server layer maps the discriminated
 * result to an HTTP response. No intermediate layer should be
 * introspecting `status` / `retryAfter` directly off a thrown Error —
 * use `instanceof BackendError` and read the typed fields.
 */

import { sanitizeUpstreamErrorBody } from './error-scrub.js';

export class BackendError extends Error {
  /** HTTP status from the upstream response, or 0 when unavailable. */
  readonly status: number;
  /**
   * Retry-After hint in **seconds** when the upstream supplied one.
   * Always a non-negative integer; HTTP-date forms parse to a delta.
   */
  readonly retryAfter?: number;
  /** Provider/back-end label, e.g. `openai`, `anthropic`. */
  readonly backend: string;

  constructor(input: { backend: string; status: number; message: string; retryAfter?: number }) {
    super(input.message);
    this.name = 'BackendError';
    this.backend = input.backend;
    this.status = input.status;
    if (input.retryAfter !== undefined) {
      this.retryAfter = input.retryAfter;
    }
  }

  /**
   * Build a BackendError from a raw upstream Response. Reads the body
   * as text, runs it through `sanitizeUpstreamErrorBody` (truncate +
   * scrub keys), and parses `Retry-After` when present.
   *
   * Used by every OpenAI-compatible provider on the non-2xx path.
   */
  static async fromUpstreamResponse(input: {
    backend: string;
    response: {
      status: number;
      text(): Promise<string>;
      headers: { get(name: string): string | null };
    };
  }): Promise<BackendError> {
    const rawBody = await input.response.text().catch(() => '<no body>');
    const cleaned = sanitizeUpstreamErrorBody(rawBody);
    const message = `${input.backend} error ${String(input.response.status)}: ${cleaned}`;
    const retryAfter = parseRetryAfter(input.response.headers.get('Retry-After'));
    return new BackendError({
      backend: input.backend,
      status: input.response.status,
      message,
      ...(retryAfter !== undefined && { retryAfter }),
    });
  }
}

/**
 * Parse a `Retry-After` header per RFC 7231 §7.1.3.
 *
 * Two valid forms:
 *  - `delta-seconds` — non-negative integer count of seconds.
 *  - `HTTP-date` — an RFC 1123 / RFC 850 absolute date.
 *
 * Returns `undefined` when the header is missing or unparseable. The
 * delta-seconds path is the common case (every major LLM provider
 * uses it); the HTTP-date path is supported defensively.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // delta-seconds first — fast path.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    return undefined;
  }
  // HTTP-date — return seconds-from-now (clamped to >= 0).
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const deltaMs = date - Date.now();
    if (deltaMs <= 0) return 0;
    return Math.floor(deltaMs / 1000);
  }
  return undefined;
}
