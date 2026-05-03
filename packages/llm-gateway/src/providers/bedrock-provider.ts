/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Bedrock backend stub. The archived implementation depends on
 * `@aws-sdk/client-bedrock-runtime` and the SigV4 signer (~6MB of
 * deps). v1 of @kagent/llm-gateway targets the homelab path
 * (Cloudflare AI Gateway / Ollama / mock) — Bedrock is structurally
 * present here so the BackendKind union and provider-factory
 * exhaustiveness check stays honest, but the chat methods throw a
 * clear, attributable error rather than silently 500ing.
 *
 * Re-enabling Bedrock for production cloud deployers is a single
 * commit: add the @aws-sdk/client-bedrock-runtime dep, replace the
 * three throw-bodies below with the SigV4-signed POSTs from the
 * archived `lambda/providers/bedrock-provider.ts`, and unblock in
 * `provider-factory.ts`. Tracked in the v0.2 deferred list.
 *
 * TODO: wire actual @aws-sdk/client-bedrock-runtime path when a
 * cloud-deployer needs Bedrock (out of homelab scope for v1).
 */

import { BaseProvider } from './base-provider.js';
import type { ProviderRequest, ProviderResponse, StreamingProviderResponse } from '../types.js';

const NOT_IMPL_MESSAGE =
  'bedrock backend is registered but not enabled in v1 — see packages/llm-gateway/src/providers/bedrock-provider.ts';

export class BedrockProvider extends BaseProvider {
  readonly name = 'bedrock' as const;
  protected readonly supportedModels: ReadonlySet<string> = new Set();

  override supportsModel(_modelId: string): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async chatCompletion(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error(NOT_IMPL_MESSAGE);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async chatCompletionStream(_request: ProviderRequest): Promise<StreamingProviderResponse> {
    throw new Error(NOT_IMPL_MESSAGE);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async healthCheck(): Promise<boolean> {
    return false;
  }
}
