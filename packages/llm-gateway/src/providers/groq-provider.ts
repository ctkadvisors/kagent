/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { OpenAICompatProvider } from './openai-compat-provider.js';

/** Groq's OpenAI-compatible chat completions endpoint. */
export class GroqProvider extends OpenAICompatProvider {
  readonly name = 'groq' as const;

  constructor(baseUrl: string = 'https://api.groq.com/openai/v1', fetchImpl: typeof fetch = fetch) {
    super({ defaultBaseUrl: baseUrl, requiresApiKey: true }, fetchImpl);
  }
}
