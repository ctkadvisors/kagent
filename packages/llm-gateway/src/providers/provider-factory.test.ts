/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { AnthropicProvider } from './anthropic-provider.js';
import { BedrockProvider, BEDROCK_NOT_IMPLEMENTED_ERROR_NAME } from './bedrock-provider.js';
import { CloudflareProvider } from './cloudflare-provider.js';
import { ExoProvider } from './exo-provider.js';
import { GroqProvider } from './groq-provider.js';
import { LocalAIProvider } from './localai-provider.js';
import { MockProvider } from './mock-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { buildProvider } from './provider-factory.js';
import type { BackendKind, ProviderRequest } from '../types.js';

describe('buildProvider', () => {
  const cases: { kind: BackendKind; ctor: unknown }[] = [
    { kind: 'mock', ctor: MockProvider },
    { kind: 'ollama', ctor: OllamaProvider },
    { kind: 'localai', ctor: LocalAIProvider },
    { kind: 'openai', ctor: OpenAIProvider },
    { kind: 'anthropic', ctor: AnthropicProvider },
    { kind: 'groq', ctor: GroqProvider },
    { kind: 'exo', ctor: ExoProvider },
    { kind: 'cloudflare', ctor: CloudflareProvider },
    { kind: 'bedrock', ctor: BedrockProvider },
  ];

  for (const { kind, ctor } of cases) {
    it(`maps ${kind} to its concrete provider class`, () => {
      const p = buildProvider(kind, 'http://x');
      expect(p).toBeInstanceOf(ctor as new () => unknown);
      expect(p.name).toBe(kind);
    });
  }

  it('mock provider does not throw on healthCheck', async () => {
    await expect(buildProvider('mock', 'http://x').healthCheck()).resolves.toBe(true);
  });

  it('bedrock stub returns false on healthCheck', async () => {
    await expect(buildProvider('bedrock', 'http://x').healthCheck()).resolves.toBe(false);
  });

  // Audit-rev2 L12 — chat methods on the bedrock stub throw a
  // discriminator-named error so callers can branch without
  // string-matching the message.
  function dummyBedrockRequest(requestId: string): ProviderRequest {
    return {
      config: {
        backendKind: 'bedrock',
        modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
        providerModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      },
      request: { model: 'anthropic.claude-3-haiku-20240307-v1:0', messages: [] },
      requestId,
    };
  }

  it('bedrock chatCompletion throws BedrockNotImplementedError naming the missing adapter', async () => {
    const provider = buildProvider('bedrock', 'http://x');
    let caught: Error | null = null;
    try {
      await provider.chatCompletion(dummyBedrockRequest('r1'));
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    expect(caught?.name).toBe(BEDROCK_NOT_IMPLEMENTED_ERROR_NAME);
    expect(caught?.message).toContain('SigV4 adapter is not implemented');
    expect(caught?.message).toContain('bedrock-provider.ts');
  });

  it('bedrock chatCompletionStream throws the same discriminator-named error', async () => {
    const provider = buildProvider('bedrock', 'http://x');
    await expect(provider.chatCompletionStream(dummyBedrockRequest('r2'))).rejects.toMatchObject({
      name: BEDROCK_NOT_IMPLEMENTED_ERROR_NAME,
    });
  });
});
