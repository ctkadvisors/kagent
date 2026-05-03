/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Generic OpenAI-compatible REST backend. Used as the implementation
 * for OpenAI itself, Groq, LocalAI, Cloudflare AI Gateway (workers-ai
 * route), and Exo — they all expose `/v1/chat/completions` with the
 * OpenAI request/response shape.
 *
 * Subclasses override:
 *   - `name`              the BackendKind discriminator
 *   - `defaultBaseUrl`    fallback when ProviderConfig.baseUrl absent
 *   - `requiresApiKey`    when true, throws if config.apiKey missing
 *   - `chatPath`          chat completions sub-path (most are
 *                          `/chat/completions`; raw OpenAI is the same;
 *                          Cloudflare uses the same in their AI-Gateway
 *                          mode)
 *
 * Request body is forwarded unchanged except `model` is overridden to
 * `providerModelId`. Response is also forwarded unchanged; we only
 * re-stamp `id` to `requestId` and `model` to the original requested
 * id so downstream consumers see the kagent-side model name, not the
 * backend-mangled one.
 */

import { BaseProvider } from './base-provider.js';
import type {
  BackendKind,
  ChatCompletionChunk,
  ChatCompletionResponse,
  ProviderRequest,
  ProviderResponse,
  StreamingProviderResponse,
} from '../types.js';

export interface OpenAICompatConfig {
  readonly defaultBaseUrl: string;
  readonly chatPath?: string;
  readonly requiresApiKey?: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export abstract class OpenAICompatProvider extends BaseProvider {
  protected readonly supportedModels: ReadonlySet<string> = new Set();

  constructor(
    protected readonly conf: OpenAICompatConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  /** Permissive — provider is dispatched by ModelEndpoint not by the static set. */
  override supportsModel(_modelId: string): boolean {
    return true;
  }

  async chatCompletion(request: ProviderRequest): Promise<ProviderResponse> {
    const startTime = Date.now();
    const headers = this.buildHeaders(request);
    const body = JSON.stringify({
      ...request.request,
      model: request.config.providerModelId,
      stream: false,
    });
    const response = await this.fetchImpl(`${this.baseUrl(request)}${this.chatPath()}`, {
      method: 'POST',
      headers,
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '<no body>');
      throw new Error(`${this.name} error ${String(response.status)}: ${text}`);
    }
    const data = (await response.json()) as ChatCompletionResponse;
    const stamped: ChatCompletionResponse = {
      ...data,
      id: request.requestId.length > 0 ? request.requestId : data.id,
      model: request.request.model,
    };
    return {
      response: stamped,
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      latencyMs: this.calculateLatency(startTime),
    };
  }

  async chatCompletionStream(request: ProviderRequest): Promise<StreamingProviderResponse> {
    const startTime = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    const headers = this.buildHeaders(request);
    const body = JSON.stringify({
      ...request.request,
      model: request.config.providerModelId,
      stream: true,
      stream_options: { include_usage: true },
    });
    const response = await this.fetchImpl(`${this.baseUrl(request)}${this.chatPath()}`, {
      method: 'POST',
      headers,
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '<no body>');
      throw new Error(`${this.name} error ${String(response.status)}: ${text}`);
    }
    if (response.body === null) {
      throw new Error(`${this.name} response body is null`);
    }
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    const modelId = request.request.model;
    const requestId = request.requestId;

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
            const trimmed = line.trim();
            if (trimmed.length === 0 || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') continue;
            let chunk: ChatCompletionChunk;
            try {
              chunk = JSON.parse(payload) as ChatCompletionChunk;
            } catch {
              continue;
            }
            if (chunk.usage !== undefined) {
              inputTokens = chunk.usage.prompt_tokens;
              outputTokens = chunk.usage.completion_tokens;
            }
            yield {
              ...chunk,
              id: requestId.length > 0 ? requestId : chunk.id,
              model: modelId,
            };
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    return {
      stream: gen(),
      inputTokens,
      getOutputTokens: (): number => outputTokens,
      getLatencyMs: (): number => this.calculateLatency(startTime),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const headers: Record<string, string> = { ...(this.conf.extraHeaders ?? {}) };
      const response = await this.fetchImpl(`${this.conf.defaultBaseUrl}/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  abstract override readonly name: BackendKind;

  protected baseUrl(request: ProviderRequest): string {
    return request.config.baseUrl ?? this.conf.defaultBaseUrl;
  }

  protected chatPath(): string {
    return this.conf.chatPath ?? '/chat/completions';
  }

  protected buildHeaders(request: ProviderRequest): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.conf.extraHeaders ?? {}),
    };
    const apiKey = request.config.apiKey;
    if (this.conf.requiresApiKey === true) {
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error(`${this.name} backend requires an apiKey`);
      }
      headers.Authorization = `Bearer ${apiKey}`;
    } else if (apiKey !== undefined && apiKey.length > 0) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }
}
