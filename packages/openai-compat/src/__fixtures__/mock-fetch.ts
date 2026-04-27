/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Factory for a mock `globalThis.fetch` injected via `OpenAICompatibleLLMClientOptions.fetch`.
 *
 * Factory fn (NOT class) — matches Phase 3 stub-llm.ts pattern.
 * Consumed only by `*.test.ts` siblings — never re-exported from the
 * package barrel (Phase 2 D-21).
 *
 * SC3-safe: no provider SDK names, no domain identifiers.
 */

export interface MockFetchOptions {
  /** Pre-canned response body (JSON object or raw SSE transcript string). */
  body?: string | object;
  /** HTTP status; default 200. */
  status?: number;
  /** Response headers. Default: `{ 'content-type': 'text/event-stream' }` for SSE strings, `'application/json'` for objects. */
  headers?: Record<string, string>;
  /** If set, fetch throws this error instead of returning a response. */
  throws?: Error;
  /** Mutated by the mock: every fetch invocation appended for assertions. */
  recordedCalls?: Array<{
    url: string;
    method: string;
    body?: unknown;
    headers?: Record<string, string>;
  }>;
  /** Introduce a synthetic delay in ms before resolving. */
  delayMs?: number;
  /** Split SSE body across N byte-chunks to stress chunk-boundary parsing (Pitfall 3). */
  sseChunkBoundaries?: number[];
}

export function makeMockFetch(opts: MockFetchOptions = {}): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
    const method = init?.method ?? 'GET';
    let parsedBody: unknown;
    if (init?.body !== undefined && init.body !== null) {
      // init.body is typed as BodyInit (string | Blob | BufferSource | FormData | ...).
      // Tests pass JSON strings here; narrow to string before parse. Non-string
      // bodies pass through as-is (tests don't exercise them).
      if (typeof init.body === 'string') {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      } else {
        parsedBody = init.body;
      }
    }
    // `exactOptionalPropertyTypes: true` — conditionally attach optional fields.
    const recorded: {
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = { url, method };
    if (parsedBody !== undefined) recorded.body = parsedBody;
    if (init?.headers !== undefined) recorded.headers = init.headers as Record<string, string>;
    opts.recordedCalls?.push(recorded);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.throws) throw opts.throws;

    if (init?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const bodyString = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {});
    const isSSE = typeof opts.body === 'string' && bodyString.startsWith('data:');
    const encoder = new TextEncoder();
    const fullBytes = encoder.encode(bodyString);
    const boundaries = opts.sseChunkBoundaries ?? [fullBytes.length];

    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        let prev = 0;
        for (const b of boundaries) {
          ctrl.enqueue(fullBytes.slice(prev, b));
          prev = b;
        }
        if (prev < fullBytes.length) ctrl.enqueue(fullBytes.slice(prev));
        ctrl.close();
      },
    });

    init?.signal?.addEventListener('abort', () => {
      try {
        void stream.cancel();
      } catch {
        /* swallow */
      }
    });

    return new Response(stream, {
      status: opts.status ?? 200,
      headers: opts.headers ?? {
        'content-type': isSSE ? 'text/event-stream' : 'application/json',
      },
    });
  }) satisfies typeof globalThis.fetch;
}
