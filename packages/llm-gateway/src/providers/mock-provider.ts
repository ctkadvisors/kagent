/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Mock provider — returns canned responses without touching any
 * backend. Used in tests and as the default `model: "mock"` route
 * for end-to-end smoke flows. Adapted from the archived project,
 * embeddings dropped, types narrowed to our shared shapes.
 */

import { BaseProvider } from './base-provider.js';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ProviderRequest,
  ProviderResponse,
  StreamingProviderResponse,
} from '../types.js';

export class MockProvider extends BaseProvider {
  readonly name = 'mock' as const;
  protected readonly supportedModels = new Set(['mock', 'mock-v1']);

  override supportsModel(modelId: string): boolean {
    return modelId === 'mock' || modelId.startsWith('mock-');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async chatCompletion(request: ProviderRequest): Promise<ProviderResponse> {
    const startTime = Date.now();
    const lastUser = request.request.messages.filter((m) => m.role === 'user').pop();
    const userContent = typeof lastUser?.content === 'string' ? lastUser.content : 'Hello';
    const mockContent = `mock-response: "${userContent.slice(0, 100)}"`;
    const promptTokens = this.estimateTokens(userContent);
    const completionTokens = this.estimateTokens(mockContent);
    const response: ChatCompletionResponse = {
      id: `mock-${request.requestId}`,
      object: 'chat.completion',
      created: this.getCurrentTimestamp(),
      model: request.config.modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: mockContent },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
    return {
      response,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      latencyMs: this.calculateLatency(startTime),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async chatCompletionStream(request: ProviderRequest): Promise<StreamingProviderResponse> {
    const startTime = Date.now();
    const lastUser = request.request.messages.filter((m) => m.role === 'user').pop();
    const userContent = typeof lastUser?.content === 'string' ? lastUser.content : 'Hello';
    const mockContent = `mock-stream: "${userContent.slice(0, 50)}"`;
    const words = mockContent.split(' ');
    const inputTokens = this.estimateTokens(userContent);
    let outputTokens = 0;

    const completionId = `mock-${request.requestId}`;
    const modelId = request.config.modelId;
    const ts = this.getCurrentTimestamp();

    async function* gen(): AsyncIterable<ChatCompletionChunk> {
      for (const word of words) {
        await Promise.resolve();
        outputTokens += Math.ceil((word.length + 1) / 4);
        yield {
          id: completionId,
          object: 'chat.completion.chunk',
          created: ts,
          model: modelId,
          choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
        };
      }
      yield {
        id: completionId,
        object: 'chat.completion.chunk',
        created: ts,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
    }

    return {
      stream: gen(),
      inputTokens,
      getOutputTokens: (): number => outputTokens,
      getLatencyMs: (): number => this.calculateLatency(startTime),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async healthCheck(): Promise<boolean> {
    return true;
  }
}
