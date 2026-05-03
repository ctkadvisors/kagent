/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { OpenAICompatProvider } from './openai-compat-provider.js';

/** LocalAI exposes the OpenAI HTTP shape verbatim — no auth in default install. */
export class LocalAIProvider extends OpenAICompatProvider {
  readonly name = 'localai' as const;

  constructor(
    baseUrl: string = 'http://localai.ai-services.svc.cluster.local:8080/v1',
    fetchImpl: typeof fetch = fetch,
  ) {
    super({ defaultBaseUrl: baseUrl, requiresApiKey: false }, fetchImpl);
  }
}
