/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { OpenAIProvider } from './openai-provider.js';
import { CloudflareProvider } from './cloudflare-provider.js';
import { LocalAIProvider } from './localai-provider.js';
import type { ProviderRequest } from '../types.js';

function chatBody(model = 'gpt-4o', apiKey?: string): ProviderRequest {
  return {
    config: {
      backendKind: 'openai',
      modelId: model,
      providerModelId: model,
      ...(apiKey !== undefined && { apiKey }),
    },
    request: {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
    },
    requestId: 'req-1',
  };
}

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAICompatProvider via OpenAIProvider', () => {
  it('throws when apiKey missing on a backend that requires it', async () => {
    const provider = new OpenAIProvider('https://api.openai.com/v1');
    await expect(provider.chatCompletion(chatBody())).rejects.toThrow(/requires an apiKey/);
  });

  it('forwards request body with re-stamped model + Authorization header', async () => {
    let captured: CapturedCall | null = null;
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      captured = {
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        bodyText: typeof init?.body === 'string' ? init.body : '',
      };
      return Promise.resolve(
        jsonResponse({
          id: 'chatcmpl-x',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'pong' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
    });
    const provider = new OpenAIProvider(
      'https://api.openai.com/v1',
      fakeFetch as unknown as typeof fetch,
    );
    const result = await provider.chatCompletion(chatBody('gpt-4o', 'sk-x'));

    expect(captured).not.toBeNull();
    const cap = captured as unknown as CapturedCall;
    expect(cap.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(cap.headers.Authorization).toBe('Bearer sk-x');
    const body = JSON.parse(cap.bodyText) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o');
    expect(body.stream).toBe(false);
    expect(result.response.choices[0]?.message.content).toBe('pong');
    expect(result.response.id).toBe('req-1'); // re-stamped to caller's requestId
  });

  it('LocalAI does not require apiKey and skips Authorization header', async () => {
    let captured: CapturedCall | null = null;
    const fakeFetch = vi.fn((_url: string, init?: RequestInit) => {
      captured = {
        url: _url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        bodyText: typeof init?.body === 'string' ? init.body : '',
      };
      return Promise.resolve(
        jsonResponse({
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: 'tinyllama',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    const provider = new LocalAIProvider(
      'http://localai:8080/v1',
      fakeFetch as unknown as typeof fetch,
    );
    await provider.chatCompletion({
      config: { backendKind: 'localai', modelId: 'tinyllama', providerModelId: 'tinyllama' },
      request: { model: 'tinyllama', messages: [{ role: 'user', content: 'hi' }] },
      requestId: 'r',
    });
    const cap = captured as unknown as CapturedCall;
    expect(cap.headers.Authorization).toBeUndefined();
  });

  it('Cloudflare /compat forwards workers-ai model id and uses cf-aig-authorization', async () => {
    let captured: CapturedCall | null = null;
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      captured = {
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        bodyText: typeof init?.body === 'string' ? init.body : '',
      };
      return Promise.resolve(
        jsonResponse({
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    const provider = new CloudflareProvider(
      'https://gateway.ai.cloudflare.com/v1/acct/homelab/compat',
      fakeFetch as unknown as typeof fetch,
    );
    await provider.chatCompletion({
      config: {
        backendKind: 'cloudflare',
        modelId: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        providerModelId: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        apiKey: 'cf-token',
      },
      request: {
        model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        messages: [{ role: 'user', content: 'hi' }],
      },
      requestId: 'r',
    });
    const cap = captured as unknown as CapturedCall;
    expect(cap.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/homelab/compat/chat/completions',
    );
    expect(cap.headers.Authorization).toBeUndefined();
    expect(cap.headers['cf-aig-authorization']).toBe('Bearer cf-token');
    const body = JSON.parse(cap.bodyText) as Record<string, unknown>;
    expect(body.model).toBe('workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('throws on non-2xx with status code in message', async () => {
    const fakeFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 502 })),
    );
    const provider = new OpenAIProvider('https://api.openai.com/v1', fakeFetch);
    await expect(provider.chatCompletion(chatBody('gpt-4o', 'sk-x'))).rejects.toThrow(
      /openai error 502/,
    );
  });
});
