/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Anthropic Messages API backend. Adapts the OpenAI chat-completion
 * shape to Anthropic's `/v1/messages` (system separated, alternating
 * user/assistant turns required, `x-api-key` header instead of
 * Bearer). Compact port of
 * `archived/ai-gateway/lambda/providers/anthropic-provider.ts` with
 * embeddings dropped (Anthropic doesn't support them) and image
 * handling reduced to plain text turns for v1 (kagent agent-pod doesn't
 * send vision parts today; image plumbing returns in v0.2).
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

interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

interface AnthropicResponse {
  readonly id: string;
  readonly content: { type: string; text?: string }[];
  readonly stop_reason: string;
  readonly usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicStreamEvent {
  readonly type: string;
  readonly delta?: { type: string; text?: string; stop_reason?: string };
  readonly usage?: { input_tokens?: number; output_tokens?: number };
  readonly message?: { usage?: { input_tokens?: number; output_tokens?: number } };
}

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic' as const;
  protected readonly supportedModels: ReadonlySet<string> = new Set();

  constructor(
    private readonly baseUrl: string = 'https://api.anthropic.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  override supportsModel(_modelId: string): boolean {
    return true;
  }

  async chatCompletion(request: ProviderRequest): Promise<ProviderResponse> {
    const startTime = Date.now();
    const apiKey = this.requireApiKey(request);
    const body = this.buildAnthropicBody(request, false);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // H13/H15 — see ollama provider above.
      throw await BackendError.fromUpstreamResponse({
        backend: 'anthropic',
        response,
      });
    }
    const data = (await response.json()) as AnthropicResponse;
    const out: ChatCompletionResponse = this.toOpenAi(
      data,
      request.request.model,
      request.requestId,
    );
    return {
      response: out,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      latencyMs: this.calculateLatency(startTime),
    };
  }

  async chatCompletionStream(request: ProviderRequest): Promise<StreamingProviderResponse> {
    const startTime = Date.now();
    const apiKey = this.requireApiKey(request);
    const body = this.buildAnthropicBody(request, true);
    let inputTokens = 0;
    let outputTokens = 0;

    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // H13/H15 — see ollama provider above.
      throw await BackendError.fromUpstreamResponse({
        backend: 'anthropic',
        response,
      });
    }
    if (response.body === null) {
      throw new Error('anthropic response body is null');
    }
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    const requestId = request.requestId;
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
            const trimmed = line.trim();
            if (trimmed.length === 0 || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            let evt: AnthropicStreamEvent;
            try {
              evt = JSON.parse(payload) as AnthropicStreamEvent;
            } catch {
              continue;
            }
            if (evt.message?.usage?.input_tokens !== undefined) {
              inputTokens = evt.message.usage.input_tokens;
            }
            if (evt.usage?.output_tokens !== undefined) {
              outputTokens = evt.usage.output_tokens;
            }
            const deltaText = evt.delta?.type === 'text_delta' ? evt.delta.text : undefined;
            const stopReason = evt.delta?.stop_reason;
            if (deltaText !== undefined && deltaText.length > 0) {
              yield {
                id: requestId.length > 0 ? requestId : 'anthropic-stream',
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }],
              };
            }
            if (evt.type === 'message_stop' || stopReason !== undefined) {
              yield {
                id: requestId.length > 0 ? requestId : 'anthropic-stream',
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              };
            }
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
      const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'OPTIONS',
        signal: AbortSignal.timeout(5000),
      });
      // Anthropic returns 405 on OPTIONS — that still proves reachability.
      return response.status > 0 && response.status < 500;
    } catch {
      return false;
    }
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  private requireApiKey(request: ProviderRequest): string {
    const k = request.config.apiKey;
    if (k === undefined || k.length === 0) {
      throw new Error('anthropic backend requires an apiKey');
    }
    return k;
  }

  private buildAnthropicBody(request: ProviderRequest, stream: boolean): Record<string, unknown> {
    const messages: AnthropicMessage[] = [];
    let system: string | undefined;
    for (const m of request.request.messages) {
      const text = typeof m.content === 'string' ? m.content : stringifyContent(m);
      if (m.role === 'system') {
        system = system === undefined ? text : `${system}\n\n${text}`;
      } else if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: text });
      }
    }
    const collapsed = ensureAlternating(messages);
    const body: Record<string, unknown> = {
      model: request.config.providerModelId,
      max_tokens: request.request.max_tokens ?? 4096,
      messages: collapsed,
      stream,
    };
    if (system !== undefined) body.system = system;
    if (request.request.temperature !== undefined) body.temperature = request.request.temperature;
    if (request.request.top_p !== undefined) body.top_p = request.request.top_p;
    if (request.request.stop !== undefined) {
      body.stop_sequences = Array.isArray(request.request.stop)
        ? request.request.stop
        : [request.request.stop];
    }
    return body;
  }

  private toOpenAi(
    data: AnthropicResponse,
    requestedModel: string,
    requestId: string,
  ): ChatCompletionResponse {
    const text = data.content
      .filter(
        (c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string',
      )
      .map((c) => c.text)
      .join('');
    return {
      id: requestId.length > 0 ? requestId : data.id,
      object: 'chat.completion',
      created: this.getCurrentTimestamp(),
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: mapStopReason(data.stop_reason),
        },
      ],
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      },
    };
  }
}

function stringifyContent(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .join('');
}

function ensureAlternating(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return [{ role: 'user', content: 'Hello' }];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === m.role) {
      out[out.length - 1] = { role: last.role, content: `${last.content}\n\n${m.content}` };
    } else {
      out.push(m);
    }
  }
  if (out[0]?.role !== 'user') {
    return [{ role: 'user', content: 'Continue.' }, ...out];
  }
  return out;
}

function mapStopReason(
  reason: string,
): 'stop' | 'length' | 'function_call' | 'tool_calls' | 'content_filter' | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}
