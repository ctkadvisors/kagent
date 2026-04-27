/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `HttpToolProvider` — `ToolProvider` impl that calls arbitrary HTTP
 * endpoints with configurable auth header + parameter templating.
 *
 * Constructor (D-05):
 *   id?            — defaults to 'http'; overridable for multi-HTTP scenarios
 *   baseUrl?       — joined with per-tool path; per-tool path may be absolute
 *   defaultHeaders? — applied to every request; tool-level headers win on conflict
 *   fetch?         — injectable; defaults to globalThis.fetch.bind(globalThis)
 *   tools          — required HttpToolDefinition[] (D-06)
 *
 * HttpToolDefinition (D-06):
 *   { name, description, inputSchema, method, path, headers?, body?, transform?, tags? }
 *   - body: 'json' (default) | 'none' | (args, ctx) => HttpRequestBody
 *   - transform: optional override; receives (Response, raw text) → ToolResult
 *
 * Default response → ToolResult mapping (D-08):
 *   - 2xx        → { content: <body string>, isError: false, metadata: { status, headers } }
 *   - non-2xx    → { content: 'HTTP {status}: {truncated 2KB body}', isError: true, metadata }
 *   - net throw  → HttpToolProviderNetworkError thrown (programmer-error path)
 *
 * Path templating (D-07): `{argName}` → encodeURIComponent(String(args[argName])).
 * Missing key → HttpToolProviderConfigError. Pure function in `path-template.ts`.
 *
 * Pre-fetch abort guard (Phase 4 client.ts WR-03 lesson): if `ctx.abortSignal.aborted`
 * is true at entry, throw immediately — don't even initiate the request.
 *
 * **T-HTTP-02 mitigation:** Authorization headers flow OUT on every request
 * (intentional — that's the auth flow), but `metadata.headers` returned in
 * ToolResult is gated to a 2-entry allowlist (`content-type`, `x-request-id`).
 * `Authorization` is NOT in the allowlist; even on non-2xx the error envelope
 * does NOT echo back the bearer token.
 */

import type {
  JSONSchema,
  ToolCall,
  ToolDescriptor,
  ToolInvocationContext,
  ToolProvider,
  ToolResult,
} from '@kagent/agent-loop';
import { HttpToolProviderNetworkError, InvalidConfigError } from '@kagent/agent-loop';

import { substitutePath } from './path-template.js';

/**
 * Body type for fetch — derived from RequestInit so we don't depend on a
 * DOM lib (the kernel's tsconfig.base.json uses `lib: ["ES2022"]` only;
 * Node 22 globals come from @types/node which exposes `RequestInit` but
 * not a top-level `BodyInit` alias). NonNullable strips `null` so callers
 * always return a value — for "no body" they use `body: 'none'` instead.
 */
export type HttpRequestBody = NonNullable<RequestInit['body']>;

/**
 * Per-tool HTTP definition — D-06.
 *
 * `body` union determines how `args` flow to the request body:
 *   - `'json'` (default) → `JSON.stringify(args)` + auto Content-Type
 *   - `'none'` → no body sent (typical for GET)
 *   - function → caller takes full control; no auto Content-Type
 */
export interface HttpToolDefinition {
  /** Stable tool name; surfaces to the model + the registry's tool→provider map. */
  name: string;
  /** Human-readable purpose; surfaces to the model. */
  description: string;
  /** JSON Schema describing args; kernel does not validate (Phase 3 D-07). */
  inputSchema: JSONSchema;
  /** HTTP method. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path joined to baseUrl; supports `{placeholder}` substitution from args. Absolute http(s) bypasses baseUrl. */
  path: string;
  /** Per-tool headers; merged over defaultHeaders (per-tool wins on conflict). */
  headers?: Record<string, string>;
  /** Body strategy — see interface jsdoc. Defaults to 'json'. */
  body?:
    | 'json'
    | 'none'
    | ((args: Record<string, unknown>, ctx: ToolInvocationContext) => HttpRequestBody);
  /** Optional override for the default response → ToolResult mapping. */
  transform?: (resp: Response, raw: string) => ToolResult | Promise<ToolResult>;
  /** Optional A2A-style free-form tags (e.g., 'destructive', 'read-only'). */
  tags?: readonly string[];
}

/** Constructor options — D-05. */
export interface HttpToolProviderOptions {
  /** Stable provider id; defaults to 'http'. Override to disambiguate multiple instances. */
  id?: string;
  /** Endpoint base; joined with per-tool path. Per-tool path may be absolute http(s). */
  baseUrl?: string;
  /** Headers applied to every request; per-tool headers win on conflict. */
  defaultHeaders?: Record<string, string>;
  /** Optional fetch override; defaults to `globalThis.fetch.bind(globalThis)`. Phase 4 lesson. */
  fetch?: typeof globalThis.fetch;
  /** Tool definitions registered up-front; immutable after construction. */
  tools: HttpToolDefinition[];
}

const HEADER_ALLOWLIST_FOR_METADATA = ['content-type', 'x-request-id'];
const NON_2XX_BODY_TRUNCATION_BYTES = 2048;

export class HttpToolProvider implements ToolProvider {
  public readonly id: string;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly tools: Map<string, HttpToolDefinition>;
  private readonly descriptors: ToolDescriptor[];

  constructor(opts: HttpToolProviderOptions) {
    if (!opts.tools || !Array.isArray(opts.tools)) {
      throw new InvalidConfigError('tools', 'must be an array');
    }
    this.id = opts.id ?? 'http';
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
    this.defaultHeaders = opts.defaultHeaders ?? {};
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.tools = new Map(opts.tools.map((t) => [t.name, t]));
    this.descriptors = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.tags !== undefined && { tags: t.tags }),
    }));
  }

  describeTools(): ToolDescriptor[] {
    return this.descriptors;
  }

  async executeTool(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult> {
    // Phase 4 client.ts WR-03 lesson: pre-fetch abort guard. Optional-chain
    // both ctx and abortSignal even though ToolInvocationContext types
    // abortSignal as required, in case JS callers pass a partial ctx.
    if (ctx?.abortSignal?.aborted) {
      throw new HttpToolProviderNetworkError('aborted before fetch');
    }

    const def = this.tools.get(call.name);
    if (!def) {
      throw new InvalidConfigError('tool', `unknown tool "${call.name}"`);
    }

    const args = (call.args ?? {}) as Record<string, unknown>;

    // D-07: path templating. Throws HttpToolProviderConfigError on missing key.
    const path = substitutePath(def.path, args);
    const url =
      path.startsWith('http://') || path.startsWith('https://') ? path : this.baseUrl + path;

    // D-06: body union.
    const { body, contentType } = buildBody(def, args, ctx);

    // Header merge: defaults → tool headers → content-type (last write wins).
    // Per-tool headers win on conflict with defaults.
    const headers: Record<string, string> = { ...this.defaultHeaders, ...(def.headers ?? {}) };
    if (contentType !== undefined && !hasHeaderCaseInsensitive(headers, 'content-type')) {
      headers['Content-Type'] = contentType;
    }

    let response: Response;
    try {
      const init: RequestInit = { method: def.method, headers };
      if (body !== undefined) init.body = body;
      if (ctx?.abortSignal) init.signal = ctx.abortSignal;
      response = await this.fetchImpl(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HttpToolProviderNetworkError('aborted mid-fetch');
      }
      throw new HttpToolProviderNetworkError(err instanceof Error ? err.message : String(err));
    }

    // D-08: default mapping OR transform override.
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      raw = '<failed to read body>';
    }
    if (def.transform !== undefined) {
      return await def.transform(response, raw);
    }
    return defaultTransform(response, raw);
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────

function buildBody(
  def: HttpToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolInvocationContext,
): { body?: HttpRequestBody; contentType?: string } {
  if (def.body === undefined || def.body === 'json') {
    return { body: JSON.stringify(args), contentType: 'application/json' };
  }
  if (def.body === 'none') {
    return {};
  }
  // Function form — caller takes control; no auto Content-Type.
  return { body: def.body(args, ctx) };
}

function defaultTransform(response: Response, raw: string): ToolResult {
  const status = response.status;
  const headers = pickHeaders(response.headers, HEADER_ALLOWLIST_FOR_METADATA);
  if (status >= 200 && status < 300) {
    return { content: raw, isError: false, metadata: { status, headers } };
  }
  const truncated =
    raw.length > NON_2XX_BODY_TRUNCATION_BYTES
      ? raw.slice(0, NON_2XX_BODY_TRUNCATION_BYTES) + '... [truncated]'
      : raw;
  return {
    content: `HTTP ${status}: ${truncated}`,
    isError: true,
    metadata: { status, headers },
  };
}

function pickHeaders(headers: Headers, allowlist: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowlist) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}
