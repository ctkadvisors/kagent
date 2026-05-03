/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { OpenAICompatProvider } from './openai-compat-provider.js';

/** OpenAI public API. Requires a `sk-...` style key wired via ProviderConfig.apiKey. */
export class OpenAIProvider extends OpenAICompatProvider {
  readonly name = 'openai' as const;

  constructor(baseUrl: string = 'https://api.openai.com/v1', fetchImpl: typeof fetch = fetch) {
    super({ defaultBaseUrl: baseUrl, requiresApiKey: true }, fetchImpl);
  }
}
