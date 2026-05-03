/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { AnthropicProvider } from './anthropic-provider.js';
import { BedrockProvider } from './bedrock-provider.js';
import { CloudflareProvider } from './cloudflare-provider.js';
import { ExoProvider } from './exo-provider.js';
import { GroqProvider } from './groq-provider.js';
import { LocalAIProvider } from './localai-provider.js';
import { MockProvider } from './mock-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { buildProvider } from './provider-factory.js';
import type { BackendKind } from '../types.js';

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
});
