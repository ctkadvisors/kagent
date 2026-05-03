/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * ProviderFactory — single source of truth that maps a
 * `BackendKind` discriminator (off the ModelEndpoint CR) to the
 * concrete provider implementation.
 *
 * Unlike the archived AWS factory, this version:
 *   - is a plain function, not a singleton with an `initialize()` step
 *     (the gateway has no global secret-bag — keys travel on
 *     ProviderConfig.apiKey per-request)
 *   - never reads process.env directly (testability)
 *   - is exhaustive on BackendKind so a new backend addition
 *     immediately surfaces as a typecheck error here.
 */

import type { AIProvider, BackendKind } from '../types.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { BedrockProvider } from './bedrock-provider.js';
import { CloudflareProvider } from './cloudflare-provider.js';
import { ExoProvider } from './exo-provider.js';
import { GroqProvider } from './groq-provider.js';
import { LocalAIProvider } from './localai-provider.js';
import { MockProvider } from './mock-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAIProvider } from './openai-provider.js';

export interface ProviderFactoryOptions {
  /** Optional fetch impl injection — tests pass a stub here. */
  readonly fetchImpl?: typeof fetch;
}

export function buildProvider(
  backendKind: BackendKind,
  baseUrl: string,
  opts: ProviderFactoryOptions = {},
): AIProvider {
  const f = opts.fetchImpl ?? fetch;
  switch (backendKind) {
    case 'mock':
      return new MockProvider();
    case 'ollama':
      return new OllamaProvider(baseUrl, f);
    case 'localai':
      return new LocalAIProvider(baseUrl, f);
    case 'openai':
      return new OpenAIProvider(baseUrl, f);
    case 'anthropic':
      return new AnthropicProvider(baseUrl, f);
    case 'groq':
      return new GroqProvider(baseUrl, f);
    case 'exo':
      return new ExoProvider(baseUrl, f);
    case 'cloudflare':
      return new CloudflareProvider(baseUrl, f);
    case 'bedrock':
      return new BedrockProvider();
    default: {
      // Exhaustiveness check — adding a new BackendKind without
      // updating this switch will become a compile error here.
      const _exhaustive: never = backendKind;
      throw new Error(`unknown backendKind: ${String(_exhaustive)}`);
    }
  }
}
