/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { OpenAICompatProvider } from './openai-compat-provider.js';
import type { ProviderRequest } from '../types.js';

/**
 * OpenCode Go (opencode.ai/docs/go): OpenAI-compatible, but it expects coding-agent traffic that
 * names its own client and carries a stable `x-opencode-session` per conversation. One AgentTask
 * is one conversation, so the session is the task UID the agent pod already sends.
 */
export class OpenCodeGoProvider extends OpenAICompatProvider {
  readonly name = 'opencode' as const;

  constructor(baseUrl: string = 'https://opencode.ai/zen/go/v1', fetchImpl: typeof fetch = fetch) {
    super(
      {
        defaultBaseUrl: baseUrl,
        requiresApiKey: true,
        extraHeaders: { 'User-Agent': 'kagent-llm-gateway' },
      },
      fetchImpl,
    );
  }

  protected override buildHeaders(request: ProviderRequest): Record<string, string> {
    return {
      ...super.buildHeaders(request),
      'x-opencode-session': request.sessionId ?? request.requestId,
    };
  }
}
