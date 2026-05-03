/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { OllamaProvider } from './ollama-provider.js';
import type { ProviderRequest } from '../types.js';

function buildReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    config: {
      backendKind: 'ollama',
      modelId: 'llama3.2:1b',
      providerModelId: 'llama3.2:1b',
    },
    request: {
      model: 'llama3.2:1b',
      messages: [{ role: 'user', content: 'hello world' }],
      temperature: 0.5,
    },
    requestId: 'req-test-1',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OllamaProvider.chatCompletion', () => {
  it('builds the right /api/chat body and parses the response', async () => {
    const calls: { url: string; bodyText: string }[] = [];
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, bodyText: typeof init?.body === 'string' ? init.body : '' });
      return Promise.resolve(
        jsonResponse({
          message: { role: 'assistant', content: 'hi back' },
          done: true,
          prompt_eval_count: 12,
          eval_count: 7,
        }),
      );
    });
    const provider = new OllamaProvider(
      'http://ollama:11434',
      fakeFetch as unknown as typeof fetch,
    );
    const result = await provider.chatCompletion(buildReq());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://ollama:11434/api/chat');
    const sent = JSON.parse(calls[0]?.bodyText ?? '{}') as Record<string, unknown>;
    expect(sent.model).toBe('llama3.2:1b');
    expect(sent.stream).toBe(false);

    expect(result.response.choices[0]?.message.content).toBe('hi back');
    expect(result.response.choices[0]?.finish_reason).toBe('stop');
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(7);
    expect(result.response.usage.total_tokens).toBe(19);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('throws on non-2xx response', async () => {
    const fakeFetch = vi.fn(() => Promise.resolve(jsonResponse({ error: 'no model' }, 500)));
    const provider = new OllamaProvider('http://ollama:11434', fakeFetch);
    await expect(provider.chatCompletion(buildReq())).rejects.toThrow(/ollama error 500/);
  });

  it('estimates tokens when ollama omits eval counts', async () => {
    const fakeFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: { content: 'x' }, done: true })),
    );
    const provider = new OllamaProvider('http://ollama:11434', fakeFetch);
    const r = await provider.chatCompletion(buildReq());
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.outputTokens).toBe(0);
  });
});

describe('OllamaProvider.healthCheck', () => {
  it('returns true on 200 from /api/tags', async () => {
    const fakeFetch = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));
    const provider = new OllamaProvider('http://ollama:11434', fakeFetch);
    await expect(provider.healthCheck()).resolves.toBe(true);
  });

  it('returns false on fetch throw', async () => {
    const fakeFetch = vi.fn(() => Promise.reject(new Error('network down')));
    const provider = new OllamaProvider('http://ollama:11434', fakeFetch);
    await expect(provider.healthCheck()).resolves.toBe(false);
  });
});
