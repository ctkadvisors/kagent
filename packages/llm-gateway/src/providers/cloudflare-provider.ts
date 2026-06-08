/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { OpenAICompatProvider } from './openai-compat-provider.js';
import type { ProviderRequest } from '../types.js';

/**
 * Cloudflare AI Gateway — `/{accountId}/{gatewayId}/workers-ai/v1/chat/completions`
 * with OpenAI request/response shape. Caller wires the full per-account base
 * URL through ProviderConfig.baseUrl; default placeholder is just for tests.
 *
 * Auth uses a Cloudflare API token via Authorization Bearer (same shape as
 * OpenAI) — supplied via ProviderConfig.apiKey.
 */
export class CloudflareProvider extends OpenAICompatProvider {
  readonly name = 'cloudflare' as const;

  constructor(
    baseUrl: string = 'https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/workers-ai/v1',
    fetchImpl: typeof fetch = fetch,
  ) {
    super({ defaultBaseUrl: baseUrl, requiresApiKey: true }, fetchImpl);
  }

  protected override buildHeaders(request: ProviderRequest): Record<string, string> {
    const apiKey = request.config.apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(`${this.name} backend requires an apiKey`);
    }
    return {
      'Content-Type': 'application/json',
      'cf-aig-authorization': `Bearer ${apiKey}`,
    };
  }
}
