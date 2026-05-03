/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { OpenAICompatProvider } from './openai-compat-provider.js';

/** Exo (P2P inference) — exposes OpenAI-compatible /v1/chat/completions. */
export class ExoProvider extends OpenAICompatProvider {
  readonly name = 'exo' as const;

  constructor(baseUrl: string = 'http://localhost:52415/v1', fetchImpl: typeof fetch = fetch) {
    super({ defaultBaseUrl: baseUrl, requiresApiKey: false }, fetchImpl);
  }
}
