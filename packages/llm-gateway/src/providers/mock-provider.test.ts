/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { MockProvider } from './mock-provider.js';
import type { ProviderRequest } from '../types.js';

const baseReq: ProviderRequest = {
  config: { backendKind: 'mock', modelId: 'mock', providerModelId: 'mock-v1' },
  request: { model: 'mock', messages: [{ role: 'user', content: 'hello there' }] },
  requestId: 'r-1',
};

describe('MockProvider', () => {
  it('returns a deterministic-shaped response that includes the user content', async () => {
    const p = new MockProvider();
    const r = await p.chatCompletion(baseReq);
    expect(r.response.object).toBe('chat.completion');
    expect(r.response.choices[0]?.message.content).toContain('hello there');
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.outputTokens).toBeGreaterThan(0);
    expect(r.response.usage.total_tokens).toBe(r.inputTokens + r.outputTokens);
  });

  it('healthCheck always passes', async () => {
    await expect(new MockProvider().healthCheck()).resolves.toBe(true);
  });

  it('streams chunks ending with finish_reason=stop', async () => {
    const p = new MockProvider();
    const stream = await p.chatCompletionStream(baseReq);
    const chunks = [];
    for await (const c of stream.stream) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe('stop');
  });

  it('supportsModel matches mock and mock-* ids', () => {
    const p = new MockProvider();
    expect(p.supportsModel('mock')).toBe(true);
    expect(p.supportsModel('mock-v9')).toBe(true);
    expect(p.supportsModel('llama')).toBe(false);
  });
});
