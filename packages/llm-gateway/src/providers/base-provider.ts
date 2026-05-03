/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Base class for backend providers. Adapted from
 * `archived/ai-gateway/lambda/providers/base-provider.ts` with the
 * AWS Lambda Context references removed and the `embeddings` method
 * dropped (not in v1 scope per spec §10).
 */

import type {
  AIProvider,
  BackendKind,
  ProviderRequest,
  ProviderResponse,
  StreamingProviderResponse,
} from '../types.js';

export abstract class BaseProvider implements AIProvider {
  abstract readonly name: BackendKind;
  protected abstract readonly supportedModels: ReadonlySet<string>;

  /** True when the static `supportedModels` set lists this id. */
  supportsModel(modelId: string): boolean {
    return this.supportedModels.has(modelId);
  }

  abstract chatCompletion(request: ProviderRequest): Promise<ProviderResponse>;
  abstract chatCompletionStream(request: ProviderRequest): Promise<StreamingProviderResponse>;
  abstract healthCheck(): Promise<boolean>;

  /** Generate an OpenAI-shaped completion id. */
  protected generateCompletionId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `chatcmpl-${timestamp}${random}`;
  }

  protected getCurrentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** Rough token estimate; ~4 chars/token for English. */
  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  protected calculateLatency(startTime: number): number {
    return Date.now() - startTime;
  }
}
