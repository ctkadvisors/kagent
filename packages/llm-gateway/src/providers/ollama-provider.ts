/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Ollama backend — adapted from
 * `archived/ai-gateway/lambda/providers/ollama-provider.ts`. Same
 * request/response transforms (Ollama's `/api/chat` returns NDJSON
 * for streaming and a single JSON for non-streaming), but config now
 * comes off `ProviderConfig.baseUrl` instead of process.env so the
 * factory can wire one OllamaProvider per ModelEndpoint backend URL.
 */

import { BaseProvider } from './base-provider.js';
import { BackendError } from '../backend-error.js';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ProviderRequest,
  ProviderResponse,
  StreamingProviderResponse,
} from '../types.js';

interface OllamaChatChunk {
  readonly model?: string;
  readonly message?: { readonly role?: string; readonly content?: string };
  readonly done?: boolean;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

export class OllamaProvider extends BaseProvider {
  readonly name = 'ollama' as const;
  protected readonly supportedModels: ReadonlySet<string> = new Set();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  /** Ollama supports any pulled model — caller decides via providerModelId. */
  override supportsModel(_modelId: string): boolean {
    return true;
  }

  async chatCompletion(request: ProviderRequest): Promise<ProviderResponse> {
    const startTime = Date.now();
    const ollamaRequest = {
      model: request.config.providerModelId,
      messages: this.transformMessages(request.request.messages),
      stream: false,
      options: {
        temperature: request.request.temperature,
        top_p: request.request.top_p,
        max_tokens: request.request.max_tokens,
      },
    };
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaRequest),
    });
    if (!response.ok) {
      // H13/H15 — BackendError carries status + Retry-After (when
      // present) and applies the secret-scrubber + 256-char truncation
      // before the message reaches usage_records.error_message.
      throw await BackendError.fromUpstreamResponse({
        backend: 'ollama',
        response,
      });
    }
    const data = (await response.json()) as OllamaChatChunk;
    const promptTokens =
      data.prompt_eval_count ?? this.estimateTokens(JSON.stringify(request.request.messages));
    const completionTokens = data.eval_count ?? 0;
    const out: ChatCompletionResponse = {
      id: request.requestId.length > 0 ? request.requestId : this.generateCompletionId(),
      object: 'chat.completion',
      created: this.getCurrentTimestamp(),
      model: request.request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: data.message?.content ?? '' },
          finish_reason: data.done === true ? 'stop' : null,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
    return {
      response: out,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      latencyMs: this.calculateLatency(startTime),
    };
  }

  async chatCompletionStream(request: ProviderRequest): Promise<StreamingProviderResponse> {
    const startTime = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    const ollamaRequest = {
      model: request.config.providerModelId,
      messages: this.transformMessages(request.request.messages),
      stream: true,
      options: {
        temperature: request.request.temperature,
        top_p: request.request.top_p,
        max_tokens: request.request.max_tokens,
      },
    };
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaRequest),
    });
    if (!response.ok) {
      // H13/H15 — BackendError carries status + Retry-After (when
      // present) and applies the secret-scrubber + 256-char truncation
      // before the message reaches usage_records.error_message.
      throw await BackendError.fromUpstreamResponse({
        backend: 'ollama',
        response,
      });
    }
    if (response.body === null) {
      throw new Error('ollama response body is null');
    }
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    const completionId =
      request.requestId.length > 0 ? request.requestId : this.generateCompletionId();
    const modelId = request.request.model;

    async function* gen(): AsyncIterable<ChatCompletionChunk> {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim().length === 0) continue;
            let parsed: OllamaChatChunk;
            try {
              parsed = JSON.parse(line) as OllamaChatChunk;
            } catch {
              continue;
            }
            if (parsed.done === true) {
              inputTokens = parsed.prompt_eval_count ?? 0;
              outputTokens = parsed.eval_count ?? 0;
            }
            const isAssistant = parsed.message?.role === 'assistant';
            yield {
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(isAssistant && { role: 'assistant' as const }),
                    content: parsed.message?.content ?? '',
                  },
                  finish_reason: parsed.done === true ? 'stop' : null,
                },
              ],
            };
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    return {
      stream: gen(),
      inputTokens:
        inputTokens > 0
          ? inputTokens
          : this.estimateTokens(JSON.stringify(request.request.messages)),
      getOutputTokens: (): number => outputTokens,
      getLatencyMs: (): number => this.calculateLatency(startTime),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private transformMessages(messages: readonly ChatMessage[]): { role: string; content: string }[] {
    return messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
  }
}
