/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Behavioral tests for HttpToolProvider — D-05/D-06/D-07/D-08/D-09/D-10
 * + ROADMAP SC1 + Phase 4 WR-02/WR-03 abort-discipline patterns.
 *
 * 15 tests cover the constructor + happy-path + body-union + header
 * merge + non-2xx envelope + truncation + network throw + pre-fetch
 * abort + mid-fetch abort + id default/override + missing placeholder +
 * missing tools + transform override + describeTools shape.
 */

import { describe, it, expect } from 'vitest';
import { HttpToolProvider } from './provider.js';
import {
  HttpToolProviderConfigError,
  HttpToolProviderNetworkError,
  InvalidConfigError,
} from '@kagent/agent-loop';
import type { ToolCall, ToolInvocationContext } from '@kagent/agent-loop';
import { makeMockFetch } from './__fixtures__/mock-fetch.js';

const ctx = (signal?: AbortSignal): ToolInvocationContext => ({
  runId: 'test-run',
  abortSignal: signal ?? new AbortController().signal,
});

const call = (name: string, args?: unknown): ToolCall => ({
  id: 'c1',
  name,
  args: args ?? {},
});

// Lower-cased lookup helper — tests assert headers without depending on case.
function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

describe('HttpToolProvider — happy path + path templating (D-05, D-07)', () => {
  it('Test 1 — GET with path templating: fetch called with substituted URL; result wraps text body', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({
        body: '{"name":"octocat"}',
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'r-1' },
        recordedCalls,
      }),
      tools: [
        {
          name: 'get_user',
          description: 'fetch user',
          inputSchema: {},
          method: 'GET',
          path: '/users/{id}',
          body: 'none',
        },
      ],
    });
    const result = await provider.executeTool(call('get_user', { id: 42 }), ctx());
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0]?.url).toBe('https://api.example.com/users/42');
    expect(recordedCalls[0]?.method).toBe('GET');
    expect(result.isError).toBe(false);
    expect(result.content).toBe('{"name":"octocat"}');
    const meta = result.metadata as { status: number; headers: Record<string, string> };
    expect(meta.status).toBe(200);
    expect(meta.headers['content-type']).toBe('application/json');
    expect(meta.headers['x-request-id']).toBe('r-1');
  });
});

describe('HttpToolProvider — body union (D-06)', () => {
  it("Test 2 — POST with body 'json' default: JSON.stringify(args) + Content-Type application/json", async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: 'ok', status: 200, recordedCalls }),
      tools: [
        {
          name: 'echo',
          description: '',
          inputSchema: {},
          method: 'POST',
          path: '/echo',
          // body omitted → defaults to 'json'
        },
      ],
    });
    await provider.executeTool(call('echo', { msg: 'hi' }), ctx());
    expect(recordedCalls[0]?.body).toEqual({ msg: 'hi' });
    expect(getHeader(recordedCalls[0]?.headers, 'content-type')).toBe('application/json');
  });

  it("Test 3 — POST with body 'none': no body sent", async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: 'ok', status: 200, recordedCalls }),
      tools: [
        {
          name: 'noop',
          description: '',
          inputSchema: {},
          method: 'POST',
          path: '/noop',
          body: 'none',
        },
      ],
    });
    await provider.executeTool(call('noop', { ignored: true }), ctx());
    expect(recordedCalls[0]?.body).toBeUndefined();
    // No auto Content-Type for 'none' body.
    expect(getHeader(recordedCalls[0]?.headers, 'content-type')).toBeUndefined();
  });

  it('Test 4 — POST with body callback: callback return is sent as-is', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: 'ok', status: 200, recordedCalls }),
      tools: [
        {
          name: 'custom',
          description: '',
          inputSchema: {},
          method: 'POST',
          path: '/c',
          body: () => 'custom-body-string',
        },
      ],
    });
    await provider.executeTool(call('custom'), ctx());
    expect(recordedCalls[0]?.body).toBe('custom-body-string');
    // No auto Content-Type for fn body.
    expect(getHeader(recordedCalls[0]?.headers, 'content-type')).toBeUndefined();
  });
});

describe('HttpToolProvider — header merge (D-09)', () => {
  it('Test 5 — defaultHeaders + per-tool headers merge with per-tool winning on conflict', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      defaultHeaders: { 'X-Foo': 'a', Authorization: 'Bearer A' },
      fetch: makeMockFetch({ body: 'ok', status: 200, recordedCalls }),
      tools: [
        {
          name: 'h',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/h',
          headers: { 'X-Foo': 'b' },
          body: 'none',
        },
      ],
    });
    await provider.executeTool(call('h'), ctx());
    expect(recordedCalls[0]?.headers).toMatchObject({
      'X-Foo': 'b',
      Authorization: 'Bearer A',
    });
  });
});

describe('HttpToolProvider — non-2xx → ToolResult{isError:true} (D-08, ROADMAP SC1)', () => {
  it('Test 6 — 404 returns ToolResult with isError:true; status + headers in metadata; NOT thrown', async () => {
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({
        body: 'not found',
        status: 404,
        headers: { 'content-type': 'text/plain', 'x-request-id': 'rq-x' },
      }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/missing',
          body: 'none',
        },
      ],
    });
    const result = await provider.executeTool(call('t'), ctx());
    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe('string');
    expect(result.content as string).toMatch(/^HTTP 404: /);
    expect(result.content as string).toContain('not found');
    const meta = result.metadata as { status: number; headers: Record<string, string> };
    expect(meta.status).toBe(404);
    expect(meta.headers['content-type']).toBe('text/plain');
    expect(meta.headers['x-request-id']).toBe('rq-x');
    // Authorization MUST NOT appear in metadata.headers — allowlist limits exposure.
    expect('authorization' in meta.headers).toBe(false);
  });

  it('Test 7 — non-2xx body truncated to ~2KB', async () => {
    const big = 'x'.repeat(5000);
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: big, status: 500 }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/big',
          body: 'none',
        },
      ],
    });
    const result = await provider.executeTool(call('t'), ctx());
    expect(result.isError).toBe(true);
    // 2048-byte truncation cap + 'HTTP 500: ' prefix + '... [truncated]' suffix.
    const content = result.content as string;
    expect(content.length).toBeLessThanOrEqual(2120);
    expect(content).toMatch(/\[truncated\]/);
  });
});

describe('HttpToolProvider — network errors throw HttpToolProviderNetworkError (D-08)', () => {
  it('Test 8 — fetch throws non-AbortError → HttpToolProviderNetworkError with message', async () => {
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ throws: new Error('connect ECONNREFUSED') }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/x',
          body: 'none',
        },
      ],
    });
    await expect(provider.executeTool(call('t'), ctx())).rejects.toBeInstanceOf(
      HttpToolProviderNetworkError,
    );
    try {
      await provider.executeTool(call('t'), ctx());
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('ECONNREFUSED');
    }
  });

  it('Test 9 — pre-fetch abort guard: pre-aborted signal throws BEFORE fetch is called', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: 'ok', recordedCalls }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/x',
          body: 'none',
        },
      ],
    });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.executeTool(call('t'), ctx(controller.signal))).rejects.toBeInstanceOf(
      HttpToolProviderNetworkError,
    );
    try {
      await provider.executeTool(call('t'), ctx(controller.signal));
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toBe('aborted before fetch');
    }
    // Critical: fetch was NOT invoked.
    expect(recordedCalls).toHaveLength(0);
  });

  it('Test 10 — mid-fetch DOMException AbortError → HttpToolProviderNetworkError("aborted mid-fetch")', async () => {
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({
        throws: new DOMException('aborted', 'AbortError'),
      }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/x',
          body: 'none',
        },
      ],
    });
    await expect(provider.executeTool(call('t'), ctx())).rejects.toBeInstanceOf(
      HttpToolProviderNetworkError,
    );
    try {
      await provider.executeTool(call('t'), ctx());
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toBe('aborted mid-fetch');
    }
  });
});

describe('HttpToolProvider — id default + override (D-05)', () => {
  it("Test 11a — id defaults to 'http'", () => {
    const provider = new HttpToolProvider({
      baseUrl: 'https://x',
      fetch: makeMockFetch(),
      tools: [],
    });
    expect(provider.id).toBe('http');
  });

  it('Test 11b — id is overridable', () => {
    const provider = new HttpToolProvider({
      id: 'github-api',
      baseUrl: 'https://x',
      fetch: makeMockFetch(),
      tools: [],
    });
    expect(provider.id).toBe('github-api');
  });
});

describe('HttpToolProvider — config errors (D-07)', () => {
  it('Test 12 — missing path placeholder throws HttpToolProviderConfigError at execute time', async () => {
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: 'never' }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/x/{missing}',
          body: 'none',
        },
      ],
    });
    await expect(provider.executeTool(call('t', {}), ctx())).rejects.toBeInstanceOf(
      HttpToolProviderConfigError,
    );
  });

  it('Test 13 — missing tools array throws InvalidConfigError at construction', () => {
    expect(() => new HttpToolProvider({ tools: undefined as never })).toThrow(InvalidConfigError);
    try {
      new HttpToolProvider({ tools: undefined as never });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidConfigError);
      expect((err as InvalidConfigError).field).toBe('tools');
    }
  });

  it('Test 13b — non-array tools (object) throws InvalidConfigError', () => {
    expect(() => new HttpToolProvider({ tools: { not: 'array' } as unknown as never })).toThrow(
      InvalidConfigError,
    );
  });

  it('Test 13c — executeTool with unknown tool name throws InvalidConfigError', async () => {
    const provider = new HttpToolProvider({
      baseUrl: 'https://x',
      fetch: makeMockFetch(),
      tools: [],
    });
    await expect(provider.executeTool(call('nonexistent'), ctx())).rejects.toBeInstanceOf(
      InvalidConfigError,
    );
  });
});

describe('HttpToolProvider — transform override (D-06)', () => {
  it('Test 14 — transform callback overrides default mapping', async () => {
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: 'raw-ignored', status: 500 }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/x',
          body: 'none',
          transform: () => ({ content: 'overridden', isError: false }),
        },
      ],
    });
    const result = await provider.executeTool(call('t'), ctx());
    // Transform receives 500 but chooses isError:false — proves override is honored.
    expect(result).toEqual({ content: 'overridden', isError: false });
  });

  it('Test 14b — transform receives Response + raw text', async () => {
    let capturedRaw: string | undefined;
    let capturedStatus: number | undefined;
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: 'hello world', status: 201 }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/x',
          body: 'none',
          transform: (resp, raw) => {
            capturedRaw = raw;
            capturedStatus = resp.status;
            return { content: raw.toUpperCase(), isError: false };
          },
        },
      ],
    });
    const result = await provider.executeTool(call('t'), ctx());
    expect(capturedRaw).toBe('hello world');
    expect(capturedStatus).toBe(201);
    expect(result.content).toBe('HELLO WORLD');
  });
});

describe('HttpToolProvider — describeTools (D-05)', () => {
  it('Test 15 — describeTools returns descriptors WITHOUT method/path/headers/body/transform', () => {
    const provider = new HttpToolProvider({
      baseUrl: 'https://x',
      fetch: makeMockFetch(),
      tools: [
        {
          name: 'a',
          description: 'd-a',
          inputSchema: { x: 1 },
          method: 'GET',
          path: '/a',
          body: 'none',
        },
        {
          name: 'b',
          description: 'd-b',
          inputSchema: { y: 2 },
          method: 'POST',
          path: '/b',
          body: 'json',
          tags: ['ro'],
          headers: { 'X-Foo': 'b' },
          transform: () => ({ content: '', isError: false }),
        },
      ],
    });
    const desc = provider.describeTools();
    expect(desc).toHaveLength(2);
    expect(desc[0]).toEqual({ name: 'a', description: 'd-a', inputSchema: { x: 1 } });
    expect(desc[1]).toEqual({
      name: 'b',
      description: 'd-b',
      inputSchema: { y: 2 },
      tags: ['ro'],
    });
    // Forbidden fields MUST NOT leak.
    for (const d of desc) {
      expect('method' in (d as object)).toBe(false);
      expect('path' in (d as object)).toBe(false);
      expect('headers' in (d as object)).toBe(false);
      expect('body' in (d as object)).toBe(false);
      expect('transform' in (d as object)).toBe(false);
    }
  });
});

describe('HttpToolProvider — absolute URL bypass (D-05)', () => {
  it('Test 16 — absolute http(s):// path bypasses baseUrl join', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: 'ok', recordedCalls }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: 'https://other.example.com/abs',
          body: 'none',
        },
      ],
    });
    await provider.executeTool(call('t'), ctx());
    expect(recordedCalls[0]?.url).toBe('https://other.example.com/abs');
  });
});

describe('HttpToolProvider — Content-Type override discipline (D-09)', () => {
  it("Test 5b — caller-supplied Content-Type WINS; auto Content-Type for body 'json' is NOT overridden", async () => {
    // Exercises hasHeaderCaseInsensitive's inner closure (case-insensitive
    // duplicate guard) by pre-setting `content-type` (lowercase) in
    // defaultHeaders alongside body: 'json' — proves auto Content-Type is
    // skipped when the caller already supplied one.
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      defaultHeaders: { 'content-type': 'application/x-ndjson' },
      fetch: makeMockFetch({ body: 'ok', recordedCalls }),
      tools: [
        {
          name: 'echo',
          description: '',
          inputSchema: {},
          method: 'POST',
          path: '/echo',
          // body 'json' (default) would normally inject Content-Type:
          // application/json, but the caller's lowercase 'content-type'
          // header pre-claims the slot so the auto-injection skips.
        },
      ],
    });
    await provider.executeTool(call('echo', { msg: 'hi' }), ctx());
    const headers = recordedCalls[0]?.headers;
    expect(headers).toBeDefined();
    // Lowercase content-type preserved verbatim; no second 'Content-Type' added.
    expect(headers?.['content-type']).toBe('application/x-ndjson');
    expect(headers?.['Content-Type']).toBeUndefined();
    // Body still serialized as JSON since body: 'json' is the default.
    expect(recordedCalls[0]?.body).toEqual({ msg: 'hi' });
  });
});

describe("HttpToolProvider — response.text() throws → '<failed to read body>' content (D-08 catch branch)", () => {
  it('Test 18 — response.text() throws → default mapping uses "<failed to read body>" placeholder', async () => {
    // Custom fetch that returns a Response-like whose `.text()` throws.
    // Cast through unknown to satisfy the `typeof globalThis.fetch` slot
    // without bringing in DOM types.
    const flakyFetch = (() =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: new Headers(),
        text: () => Promise.reject(new Error('body stream failed')),
      } as unknown as Response)) as unknown as typeof globalThis.fetch;
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: flakyFetch,
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'GET',
          path: '/x',
          body: 'none',
        },
      ],
    });
    const result = await provider.executeTool(call('t'), ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toBe('<failed to read body>');
  });
});

describe('HttpToolProvider — call.args defaults to {} when undefined', () => {
  it('Test 17 — undefined args coerces to empty object (no throw on path with no placeholders)', async () => {
    const recordedCalls: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const provider = new HttpToolProvider({
      baseUrl: 'https://api.example.com',
      fetch: makeMockFetch({ body: 'ok', recordedCalls }),
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          method: 'POST',
          path: '/x',
          // body defaults to 'json' → JSON.stringify({})
        },
      ],
    });
    await provider.executeTool({ id: 'c', name: 't', args: undefined }, ctx());
    expect(recordedCalls[0]?.body).toEqual({});
  });
});
