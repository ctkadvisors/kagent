/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * INT-01 — OpenAICompatibleLLMClient class behavioral tests
 * (VALIDATION rows 14-18, 20).
 * Coverage target: ≥90% line + ≥85% branch on client.ts.
 */

import { describe, it, expect } from 'vitest';
import { OpenAICompatibleLLMClient } from './client.js';
import {
  LLMClientAbortError,
  LLMClientHttpError,
  LLMClientProtocolError,
  InvalidConfigError,
} from '@kagent/agent-loop';
import type { ClientContext } from '@kagent/agent-loop';
import { makeMockFetch } from './__fixtures__/mock-fetch.js';
import {
  COMPLETED_RESPONSE,
  TOOL_CALL_RESPONSE,
  RATE_LIMITED_RESPONSE,
} from './__fixtures__/responses.js';
import { EXO_CONTENT_STREAM, MALFORMED_JSON_STREAM } from './__fixtures__/sse-streams.js';

const ctx = (): ClientContext => ({
  runId: 'test-run',
  abortSignal: new AbortController().signal,
});

describe('OpenAICompatibleLLMClient.chat() (VALIDATION row 14)', () => {
  it('VALIDATION.14: chat(req) round-trips with mock fetch; returns canonical ChatResult', async () => {
    const fetch = makeMockFetch({ body: COMPLETED_RESPONSE });
    const client = new OpenAICompatibleLLMClient({
      baseUrl: 'http://test/v1',
      model: 'm',
      fetch,
    });
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] }, ctx());
    expect(result.content).toBe('Paris.');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 1 });
  });

  it('chat() with apiKey set sends Authorization: Bearer header', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const fetch = makeMockFetch({ body: COMPLETED_RESPONSE, recordedCalls });
    const client = new OpenAICompatibleLLMClient({
      baseUrl: 'http://test/v1',
      model: 'm',
      apiKey: 'sk-test-123',
      fetch,
    });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] }, ctx());
    expect(recordedCalls).toHaveLength(1);
    const headers = recordedCalls[0]?.headers;
    expect(headers).toBeDefined();
    // Headers come back in whatever shape RequestInit serialized them; convert.
    const headersAsObject = headers as Record<string, string>;
    const auth = Object.entries(headersAsObject).find(
      ([k]) => k.toLowerCase() === 'authorization',
    )?.[1];
    expect(auth).toBe('Bearer sk-test-123');
  });

  it('chat() with defaultHeaders merges them into the request', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const fetch = makeMockFetch({ body: COMPLETED_RESPONSE, recordedCalls });
    const client = new OpenAICompatibleLLMClient({
      baseUrl: 'http://test/v1',
      model: 'm',
      defaultHeaders: { 'api-version': '2024-10-21' },
      fetch,
    });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] }, ctx());
    const headers = recordedCalls[0]?.headers as Record<string, string>;
    const apiVersion = Object.entries(headers).find(
      ([k]) => k.toLowerCase() === 'api-version',
    )?.[1];
    expect(apiVersion).toBe('2024-10-21');
  });

  it('chat() POSTs to baseUrl/chat/completions', async () => {
    const recordedCalls: Array<{ url: string; method: string }> = [];
    const fetch = makeMockFetch({ body: COMPLETED_RESPONSE, recordedCalls });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    await client.chat({ messages: [] }, ctx());
    expect(recordedCalls[0]?.url).toContain('/chat/completions');
    expect(recordedCalls[0]?.method).toBe('POST');
  });

  it('chat() returns tool_calls when backend responds with them', async () => {
    const fetch = makeMockFetch({ body: TOOL_CALL_RESPONSE });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    const result = await client.chat({ messages: [] }, ctx());
    expect(result.tool_calls).toEqual([{ id: 'call_x', name: 'get_time', args: { tz: 'UTC' } }]);
    expect(result.stopReason).toBe('tool_use');
  });

  it('chat() works without ctx (no abort signal)', async () => {
    // Exercise the `ctx?` optional path — no pre-abort check, no signal
    // propagation to fetch. Covers the conditional `init.signal` attach branch.
    const fetch = makeMockFetch({ body: COMPLETED_RESPONSE });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('Paris.');
  });
});

describe('OpenAICompatibleLLMClient.chat() — error classification (VALIDATION rows 16-18)', () => {
  it('VALIDATION.16: HTTP 429 throws LLMClientHttpError with status + body', async () => {
    const fetch = makeMockFetch({ body: RATE_LIMITED_RESPONSE, status: 429 });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    let thrown: unknown;
    try {
      await client.chat({ messages: [] }, ctx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientHttpError);
    const httpErr = thrown as LLMClientHttpError;
    expect(httpErr.status).toBe(429);
    expect(httpErr.body).toContain('rate_limit');
  });

  it('VALIDATION.16: x-request-id captured into LLMClientHttpError.requestId', async () => {
    const fetch = makeMockFetch({
      body: RATE_LIMITED_RESPONSE,
      status: 429,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-abc-123',
      },
    });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    try {
      await client.chat({ messages: [] }, ctx());
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as LLMClientHttpError).requestId).toBe('req-abc-123');
    }
  });

  it('Retry-After header (delta-seconds) parsed into LLMClientHttpError.retryAfterSec on 429', async () => {
    const fetch = makeMockFetch({
      body: RATE_LIMITED_RESPONSE,
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '2',
      },
    });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    try {
      await client.chat({ messages: [] }, ctx());
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as LLMClientHttpError).retryAfterSec).toBe(2);
    }
  });

  it('Retry-After absent → retryAfterSec is undefined (no default invented)', async () => {
    const fetch = makeMockFetch({
      body: RATE_LIMITED_RESPONSE,
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    try {
      await client.chat({ messages: [] }, ctx());
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as LLMClientHttpError).retryAfterSec).toBeUndefined();
    }
  });

  it('Retry-After unparseable (HTTP-date form) → retryAfterSec undefined; consumer falls back to default backoff', async () => {
    const fetch = makeMockFetch({
      body: RATE_LIMITED_RESPONSE,
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT',
      },
    });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    try {
      await client.chat({ messages: [] }, ctx());
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as LLMClientHttpError).retryAfterSec).toBeUndefined();
    }
  });

  it('VALIDATION.17: protocol error — malformed JSON response throws LLMClientProtocolError', async () => {
    const fetch = makeMockFetch({ body: 'this is not json', status: 200 });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    let thrown: unknown;
    try {
      await client.chat({ messages: [] }, ctx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientProtocolError);
  });

  it('VALIDATION.18: abort pre-fetch — pre-aborted AbortSignal throws LLMClientAbortError before fetch', async () => {
    const recordedCalls: Array<{ url: string; method: string }> = [];
    const fetch = makeMockFetch({ body: COMPLETED_RESPONSE, recordedCalls });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      await client.chat({ messages: [] }, { runId: 'r', abortSignal: controller.signal });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientAbortError);
    expect(recordedCalls).toHaveLength(0); // fetch never called
  });

  it('WR-02: chat() with ctx missing abortSignal does not TypeError', async () => {
    // ClientContext types abortSignal as required, but JS callers / `as any`
    // consumers may widen the shape. The guard must optional-chain the
    // signal field, not just ctx, to avoid `Cannot read properties of
    // undefined (reading "aborted")`.
    const fetch = makeMockFetch({ body: COMPLETED_RESPONSE });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    // Cast-through-unknown to simulate a JS caller passing a ctx without the
    // required abortSignal field (what the type system would otherwise block).
    const ctxNoSignal = { runId: 'r' } as unknown as ClientContext;
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] }, ctxNoSignal);
    expect(result.content).toBe('Paris.');
  });

  it('fetch network error → LLMClientHttpError with status 0', async () => {
    const fetch = makeMockFetch({ throws: new Error('ECONNREFUSED') });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    let thrown: unknown;
    try {
      await client.chat({ messages: [] }, ctx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientHttpError);
    expect((thrown as LLMClientHttpError).status).toBe(0);
  });

  it('fetch throws DOMException AbortError → LLMClientAbortError', async () => {
    const fetch = makeMockFetch({ throws: new DOMException('Aborted', 'AbortError') });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    let thrown: unknown;
    try {
      await client.chat({ messages: [] }, ctx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientAbortError);
  });
});

describe('OpenAICompatibleLLMClient.chatStream() (VALIDATION row 15)', () => {
  it('VALIDATION.15: chatStream(req) yields expected delta sequence + terminal usage/stopReason', async () => {
    const fetch = makeMockFetch({ body: EXO_CONTENT_STREAM });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    const deltas = [];
    for await (const d of client.chatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      ctx(),
    )) {
      deltas.push(d);
    }
    expect(deltas.length).toBeGreaterThanOrEqual(4);
    expect(deltas[0]?.content).toBe('The');
    expect(deltas.some((d) => d.stopReason === 'end_turn')).toBe(true);
    expect(deltas.some((d) => d.usage?.inputTokens === 12)).toBe(true);
  });

  it('chatStream() works without ctx (defaults to never-aborted signal)', async () => {
    // Exercise the `ctx?` optional path — synthetic AbortController fallback.
    const fetch = makeMockFetch({ body: EXO_CONTENT_STREAM });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    const deltas = [];
    for await (const d of client.chatStream({ messages: [{ role: 'user', content: 'hi' }] })) {
      deltas.push(d);
    }
    expect(deltas.length).toBeGreaterThanOrEqual(4);
  });

  it('chatStream() pre-aborted signal throws LLMClientAbortError on first iteration', async () => {
    const fetch = makeMockFetch({ body: EXO_CONTENT_STREAM });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    const controller = new AbortController();
    controller.abort();
    const stream = client.chatStream(
      { messages: [] },
      {
        runId: 'r',
        abortSignal: controller.signal,
      },
    );
    let thrown: unknown;
    try {
      for await (const _ of stream) {
        // never reached
        void _;
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientAbortError);
  });

  it('WR-02: chatStream() with ctx missing abortSignal does not TypeError', async () => {
    // Same parity with `chat()` — the pre-iteration abort guard must
    // optional-chain abortSignal so a JS caller / `as any` consumer passing
    // a ctx without the field does not blow up with a TypeError.
    const fetch = makeMockFetch({ body: EXO_CONTENT_STREAM });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    const ctxNoSignal = { runId: 'r' } as unknown as ClientContext;
    const deltas = [];
    for await (const d of client.chatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      ctxNoSignal,
    )) {
      deltas.push(d);
    }
    expect(deltas.length).toBeGreaterThanOrEqual(4);
  });

  it('chatStream() HTTP 500 throws LLMClientHttpError on first iteration', async () => {
    const fetch = makeMockFetch({ body: 'Internal server error', status: 500 });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    let thrown: unknown;
    try {
      for await (const _ of client.chatStream({ messages: [] }, ctx())) {
        // never reached
        void _;
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientHttpError);
    expect((thrown as LLMClientHttpError).status).toBe(500);
  });

  it('chatStream() fetch network error → LLMClientHttpError with status 0', async () => {
    const fetch = makeMockFetch({ throws: new Error('ECONNREFUSED') });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    let thrown: unknown;
    try {
      for await (const _ of client.chatStream({ messages: [] }, ctx())) {
        // never reached
        void _;
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientHttpError);
    expect((thrown as LLMClientHttpError).status).toBe(0);
  });

  it('chatStream() fetch throws DOMException AbortError → LLMClientAbortError', async () => {
    const fetch = makeMockFetch({ throws: new DOMException('Aborted', 'AbortError') });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    let thrown: unknown;
    try {
      for await (const _ of client.chatStream({ messages: [] }, ctx())) {
        // never reached
        void _;
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientAbortError);
  });

  it('chatStream() captures x-request-id on HTTP error', async () => {
    const fetch = makeMockFetch({
      body: 'boom',
      status: 502,
      headers: {
        'content-type': 'text/plain',
        'x-request-id': 'req-stream-42',
      },
    });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    let thrown: unknown;
    try {
      for await (const _ of client.chatStream({ messages: [] }, ctx())) {
        void _;
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientHttpError);
    expect((thrown as LLMClientHttpError).requestId).toBe('req-stream-42');
  });

  it('chatStream() null response body throws LLMClientProtocolError', async () => {
    // Synthesize a fetch that returns a 200 Response whose body is null —
    // exercises the `if (!response.body)` guard.
    const nullBodyFetch: typeof globalThis.fetch = () =>
      Promise.resolve(new Response(null, { status: 200 }));
    const client = new OpenAICompatibleLLMClient({
      baseUrl: 'http://test/v1',
      model: 'm',
      fetch: nullBodyFetch,
    });
    let thrown: unknown;
    try {
      for await (const _ of client.chatStream({ messages: [] }, ctx())) {
        void _;
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientProtocolError);
  });

  it('chatStream() mid-stream protocol error rethrows (non-abort path)', async () => {
    // Exercises the `catch (err) { throw err }` non-abort rethrow branch in
    // chatStream() — parseSSEStream throws LLMClientProtocolError on malformed
    // JSON; client passes it through without translation.
    const fetch = makeMockFetch({ body: MALFORMED_JSON_STREAM });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    let thrown: unknown;
    try {
      for await (const _ of client.chatStream({ messages: [] }, ctx())) {
        void _;
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientProtocolError);
  });

  it('chatStream() with stream:true sets Accept: text/event-stream', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const fetch = makeMockFetch({ body: EXO_CONTENT_STREAM, recordedCalls });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    const stream = client.chatStream({ messages: [] }, ctx());
    for await (const _ of stream) {
      // consume
      void _;
    }
    const headers = recordedCalls[0]?.headers as Record<string, string>;
    const accept = Object.entries(headers).find(([k]) => k.toLowerCase() === 'accept')?.[1];
    expect(accept).toBe('text/event-stream');
  });

  it('chatStream() body sets stream: true + stream_options.include_usage: true', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const fetch = makeMockFetch({ body: EXO_CONTENT_STREAM, recordedCalls });
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm', fetch });
    for await (const _ of client.chatStream({ messages: [] }, ctx())) {
      // consume
      void _;
    }
    const body = recordedCalls[0]?.body as {
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    expect(body.stream).toBe(true);
    expect(body.stream_options?.include_usage).toBe(true);
  });
});

describe('OpenAICompatibleLLMClient.countTokens() (D-14)', () => {
  it('countTokens(string) returns Math.ceil(text.length / 4)', () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm' });
    expect(client.countTokens('hello world')).toBe(Math.ceil(11 / 4));
    expect(client.countTokens('')).toBe(0);
    expect(client.countTokens('a')).toBe(1);
  });

  it('countTokens(ChatMessage[]) joins content + estimates', () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm' });
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'world' },
    ];
    const joined = 'hello\nworld';
    expect(client.countTokens(messages)).toBe(Math.ceil(joined.length / 4));
  });

  it('countTokens() is synchronous (returns number, not Promise)', () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm' });
    const result = client.countTokens('test');
    expect(typeof result).toBe('number');
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe('OpenAICompatibleLLMClient constructor validation', () => {
  it('throws InvalidConfigError when baseUrl is empty', () => {
    expect(() => new OpenAICompatibleLLMClient({ baseUrl: '', model: 'm' })).toThrow(
      InvalidConfigError,
    );
  });

  it('throws InvalidConfigError when model is empty', () => {
    expect(() => new OpenAICompatibleLLMClient({ baseUrl: 'http://x/v1', model: '' })).toThrow(
      InvalidConfigError,
    );
  });

  it('strips trailing slash(es) from baseUrl', async () => {
    const recordedCalls: Array<{ url: string; method: string }> = [];
    const fetch = makeMockFetch({ body: COMPLETED_RESPONSE, recordedCalls });
    const client = new OpenAICompatibleLLMClient({
      baseUrl: 'http://test/v1////',
      model: 'm',
      fetch,
    });
    await client.chat({ messages: [] }, ctx());
    // URL should not have double-slash before /chat/completions.
    expect(recordedCalls[0]?.url).toBe('http://test/v1/chat/completions');
  });

  it('does NOT define an embed method (D-09 / Discretion)', () => {
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://test/v1', model: 'm' });
    expect('embed' in client).toBe(false);
  });
});
