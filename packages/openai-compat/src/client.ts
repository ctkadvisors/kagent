/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `OpenAICompatibleLLMClient` — first concrete `LLMClient` impl for
 * `@kagent/agent-loop` (Phase 4 INT-01 amended).
 *
 * Speaks OpenAI Chat Completions v1 protocol against any compatible
 * `/v1/chat/completions` endpoint (Exo, Ollama, vLLM, LiteLLM proxy,
 * OpenAI direct, Workers AI compat, Azure OpenAI, etc. — see README
 * compatibility matrix).
 *
 * Composition:
 * - request-builder: kernel `ChatRequest` → OpenAI POST body + headers
 * - response-mapper: OpenAI JSON → kernel `ChatResult`
 * - sse-parser: `ReadableStream` → `AsyncIterable<ChatDelta>`
 *
 * **Constructor options (D-08):**
 * - `baseUrl` (required): e.g. `"http://localhost:52415/v1"`
 * - `model` (required): the model identifier the upstream expects
 * - `apiKey` (optional): sent as `Authorization: Bearer <apiKey>` when set
 * - `defaultHeaders` (optional): merged into request headers (Azure `api-version`, etc.)
 * - `fetch` (optional): default `globalThis.fetch`; supports test injection
 *
 * **Error classification (D-15 + D-16):**
 * - Pre-fetch abort → `LLMClientAbortError`
 * - Fetch throws `DOMException` with `name === 'AbortError'` → `LLMClientAbortError`
 * - Fetch throws other `Error` → `LLMClientHttpError` with `status === 0`
 * - Non-2xx response → `LLMClientHttpError(status, truncatedBody, requestId?)`
 * - Malformed JSON / missing `choices` → `LLMClientProtocolError`
 *
 * **embed is OMITTED** per CONTEXT D-09 + Claude's Discretion + Phase 3
 * RESEARCH §Q3 ("idiomatic capability check is `'embed' in client`").
 *
 * **Paperclip-resistance (RESEARCH §Paperclip Relevance):**
 * - Every `chat()` / `chatStream()` call is observable (executor emits `TraceEntry`)
 * - `AbortSignal` propagates cleanly (D-15)
 * - Errors are classified — executor can branch on type without string parsing
 * - Adapter does NOT rate-limit (D-17) — that's the band's job (M2)
 *
 * **T-LLM-01 (apiKey leakage):** apiKey stored as private readonly; never logged;
 * never interpolated into error messages. HTTP error body is always passed through
 * `truncateForStorage()` before reaching `LLMClientHttpError` so provider echoes of
 * request headers (some backends reflect Authorization in error bodies — don't)
 * get bounded to ~700 chars and the error stays debuggable without dumping the
 * full request.
 */

import type {
  LLMClient,
  ChatRequest,
  ChatResult,
  ChatDelta,
  ChatMessage,
  ClientContext,
} from '@kagent/agent-loop';
import {
  LLMClientHttpError,
  LLMClientProtocolError,
  LLMClientAbortError,
  InvalidConfigError,
  truncateForStorage,
} from '@kagent/agent-loop';
import { buildOpenAIRequestBody, buildOpenAIHeaders } from './request-builder.js';
import { mapOpenAIResponseToChatResult } from './response-mapper.js';
import { parseSSEStream } from './sse-parser.js';

/**
 * Parse `Retry-After` response header into delta-seconds.
 *
 * RFC 7231 §7.1.3 allows two forms:
 *   1. `Retry-After: 120` (delta-seconds, non-negative integer)
 *   2. `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` (HTTP-date)
 *
 * We only handle form (1) — the kagent llm-gateway emits `String(retryAfterSec)`
 * (an integer) at `server.ts:289`, and most upstream LLM backends (OpenAI,
 * vLLM, Anthropic) do the same. Form (2) returns `undefined` so the consumer
 * falls back to its default backoff schedule rather than us guessing.
 *
 * Returns `undefined` on absent / unparseable / non-finite / negative values.
 */
function parseRetryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  // Trim — some proxies pad the value.
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  // Strict integer parse — reject "2.5", "Wed, 21 Oct...", "" cleanly.
  // /^\d+$/ matches the delta-seconds form per RFC 7231.
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

/**
 * Constructor options for `OpenAICompatibleLLMClient` (D-08).
 *
 * `baseUrl` and `model` are required; everything else is optional. The
 * `fetch` slot is the portability hinge (D-21) — Workers AI, Deno, Bun,
 * CF Workers all swap their native fetch implementation here without
 * code changes.
 */
export interface OpenAICompatibleLLMClientOptions {
  /** Endpoint base, e.g. `"http://localhost:52415/v1"` or `"https://api.openai.com/v1"`. */
  baseUrl: string;
  /** Model identifier the upstream expects, e.g. `"gpt-4o"`. */
  model: string;
  /** Optional API key; sent as `Authorization: Bearer <apiKey>` when set. */
  apiKey?: string;
  /** Optional headers merged into the request (Azure `api-version`, custom routing). */
  defaultHeaders?: Record<string, string>;
  /** Optional fetch override; defaults to `globalThis.fetch.bind(globalThis)`. */
  fetch?: typeof globalThis.fetch;
}

export class OpenAICompatibleLLMClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OpenAICompatibleLLMClientOptions) {
    if (!opts.baseUrl || typeof opts.baseUrl !== 'string') {
      throw new InvalidConfigError('baseUrl', 'must be a non-empty string');
    }
    if (!opts.model || typeof opts.model !== 'string') {
      throw new InvalidConfigError('model', 'must be a non-empty string');
    }
    // Strip trailing slash(es) so URL composition is canonical.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Non-streaming chat completion.
   *
   * Throws:
   * - `LLMClientAbortError` if `ctx.abortSignal` is pre-aborted or aborts during fetch
   * - `LLMClientHttpError` on non-2xx response (with status + truncated body + requestId)
   * - `LLMClientHttpError(0, ...)` when fetch rejects with a non-abort error (DNS, TLS, ECONNREFUSED)
   * - `LLMClientProtocolError` on malformed JSON / missing choices array
   */
  async chat(request: ChatRequest, ctx?: ClientContext): Promise<ChatResult> {
    // Optional-chain both ctx AND abortSignal: ClientContext types abortSignal
    // as required, but JS callers or `as any` consumers may pass a ctx without
    // one. Mirrors the `ctx?.abortSignal` guard at the init.signal assignment
    // below so the two checks share the same "ctx might exist, signal might
    // not" discipline (WR-02).
    if (ctx?.abortSignal?.aborted) {
      throw new LLMClientAbortError();
    }

    // Snapshot instance fields into locals so `chat()` and `chatStream()` have
    // identical capture semantics (WR-01 symmetry: both read config ONCE at
    // call time). All fields are `private readonly`, so the snapshot matches
    // `this.*` for any caller going through the constructor; documenting the
    // shared pattern keeps future mutations-in-flight explicit.
    const { fetchImpl, baseUrl, model, apiKey, defaultHeaders } = this;
    const body = buildOpenAIRequestBody(request, model, { stream: false });
    const headers = buildOpenAIHeaders(apiKey, defaultHeaders, { stream: false });
    const url = `${baseUrl}/chat/completions`;

    let response: Response;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      };
      if (ctx?.abortSignal) {
        init.signal = ctx.abortSignal;
      }
      response = await fetchImpl(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMClientAbortError();
      }
      // Network error / DNS failure / TLS — surface as HTTP error with status 0.
      throw new LLMClientHttpError(0, err instanceof Error ? err.message : String(err));
    }

    if (!response.ok) {
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch {
        bodyText = '(body unreadable)';
      }
      const truncated = truncateForStorage(bodyText);
      const requestId = response.headers.get('x-request-id') ?? undefined;
      const retryAfterSec = parseRetryAfterSeconds(response.headers);
      throw new LLMClientHttpError(response.status, truncated, requestId, retryAfterSec);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new LLMClientProtocolError(
        `response body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    return mapOpenAIResponseToChatResult(json);
  }

  /**
   * SSE streaming chat completion.
   *
   * Returns an `AsyncIterable<ChatDelta>` per Phase 3 D-03. The fetch happens
   * inside an async-generator IIFE so HTTP errors throw at the FIRST `for await`
   * iteration (consumer sees the throw via `for await` per AsyncIterable convention).
   *
   * Throws (at first iteration):
   * - `LLMClientAbortError` on pre-aborted signal
   * - `LLMClientHttpError` on non-2xx response (BEFORE any SSE bytes consumed)
   * - `LLMClientHttpError(0, ...)` on fetch network rejection
   *
   * Throws (mid-iteration):
   * - `LLMClientAbortError` on `AbortSignal` abort during stream
   * - `LLMClientProtocolError` on malformed SSE JSON
   */
  chatStream(request: ChatRequest, ctx?: ClientContext): AsyncIterable<ChatDelta> {
    const fetchImpl = this.fetchImpl;
    const baseUrl = this.baseUrl;
    const model = this.model;
    const apiKey = this.apiKey;
    const defaultHeaders = this.defaultHeaders;

    return (async function* (): AsyncGenerator<ChatDelta, void, void> {
      // See WR-02 note on `chat()` — optional-chain both ctx AND abortSignal
      // so a ctx without a signal does not TypeError before we reach the
      // LLMClientAbortError branch.
      if (ctx?.abortSignal?.aborted) {
        throw new LLMClientAbortError();
      }

      const body = buildOpenAIRequestBody(request, model, { stream: true });
      const headers = buildOpenAIHeaders(apiKey, defaultHeaders, { stream: true });
      const url = `${baseUrl}/chat/completions`;

      let response: Response;
      try {
        const init: RequestInit = {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        };
        if (ctx?.abortSignal) {
          init.signal = ctx.abortSignal;
        }
        response = await fetchImpl(url, init);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new LLMClientAbortError();
        }
        throw new LLMClientHttpError(0, err instanceof Error ? err.message : String(err));
      }

      if (!response.ok) {
        let bodyText: string;
        try {
          bodyText = await response.text();
        } catch {
          bodyText = '(body unreadable)';
        }
        const truncated = truncateForStorage(bodyText);
        const requestId = response.headers.get('x-request-id') ?? undefined;
        const retryAfterSec = parseRetryAfterSeconds(response.headers);
        throw new LLMClientHttpError(response.status, truncated, requestId, retryAfterSec);
      }

      if (!response.body) {
        throw new LLMClientProtocolError('response body is null on streaming response', null);
      }

      // Translate AbortError thrown by parseSSEStream into LLMClientAbortError.
      // When ctx is omitted, synthesize a never-aborted signal so parseSSEStream's
      // required `AbortSignal` parameter stays satisfied.
      const signal = ctx?.abortSignal ?? new AbortController().signal;
      try {
        for await (const delta of parseSSEStream(response.body, signal)) {
          yield delta;
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new LLMClientAbortError();
        }
        throw err;
      }
    })();
  }

  /**
   * Token estimate per D-14 — `Math.ceil(text.length / 4)`. Synchronous.
   *
   * Inlined here (not re-exported from runtime) to keep the adapter
   * self-contained under the zero-dep stress test. Future swap to
   * `gpt-tokenizer` or `tiktoken-wasm` is internal to this package and
   * does not change the `LLMClient` interface (D-14).
   */
  countTokens(input: string | ChatMessage[]): number {
    const text = typeof input === 'string' ? input : input.map((m) => m.content).join('\n');
    return Math.ceil(text.length / 4);
  }

  // No embed method — D-09 + Claude's Discretion. Consumers check
  // `'embed' in client` per Phase 3 RESEARCH §Q3 idiom; falls back to a
  // separate embeddings adapter package when needed.
}
