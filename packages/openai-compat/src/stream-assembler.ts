/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Turn a streamed chat completion back into the non-streamed response, so
 * `chat()` can ask every backend to stream and still hand
 * `mapOpenAIResponseToChatResult` exactly what it has always mapped.
 *
 * Why `chat()` streams at all: Node's fetch drops a request after 300 s
 * without response headers and again after 300 s between body bytes. A
 * thinking turn is longer than that (2026-09-20: an agent turn died at
 * 5m0.55s as "LLM backend returned HTTP 502"). A streamed reply has its
 * headers at once and bytes throughout: tokens from a plain backend, `: ping`
 * comments from the kagent llm-gateway. The 300 s limit then only ever fires
 * on a peer that has really gone quiet, which is what it is for.
 *
 * Assembly rules (mirrored in @kagent/llm-gateway `stream-assembler.ts`; the
 * packages share no dependency, so keep them in step):
 *
 *   - `delta.content` concatenates.
 *   - Thinking arrives as `delta.reasoning` (vLLM, the gateway) or
 *     `delta.reasoning_content` (llama.cpp, DeepSeek); both land in
 *     `message.reasoning`, which the mapper reads as its fallback.
 *   - Tool calls arrive as fragments keyed by `index`; `arguments` is JSON cut
 *     at arbitrary boundaries and only parses once joined.
 *   - Usage rides a chunk with empty `choices`.
 *   - `{"error": {...}}` is the gateway reporting an outcome in-band, its 200
 *     already spent on keeping the connection alive. It becomes the
 *     `LLMClientHttpError` a plain HTTP error would have been, status and
 *     Retry-After included, so the caller's retry policy is unchanged.
 *   - A stream that ends without a `finish_reason` was cut short: an error,
 *     never a short answer.
 */

import { LLMClientHttpError, LLMClientProtocolError } from '@kagent/agent-loop';
import type { OpenAIChatCompletion } from './response-mapper.js';
import type { OpenAIToolCallWire } from './tool-mapper.js';

interface RawChunk {
  id?: string;
  created?: number;
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIChatCompletion['usage'] | null;
  error?: { message?: string; status?: number; retry_after_sec?: number };
}

/** The JSON `data:` payloads of an SSE body. Comments (`: ping`) and `[DONE]` are skipped. */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, void> {
  const reader = body.pipeThrough(new TextDecoderStream('utf-8')).getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (done) return;
      buffer += value;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload) as unknown;
        } catch (err) {
          throw new LLMClientProtocolError(
            `SSE event is not valid JSON: ${(err as Error).message}`,
            payload,
          );
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      await reader.cancel();
    } catch {
      // cancel after the stream ended is normal
    }
  }
}

export async function assembleChatCompletion(
  chunks: AsyncIterable<unknown>,
): Promise<OpenAIChatCompletion> {
  let id: string | undefined;
  let model: string | undefined;
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: OpenAIChatCompletion['usage'];
  const calls: { id: string; name: string; args: string }[] = [];

  for await (const raw of chunks) {
    const chunk = raw as RawChunk;
    if (chunk.error !== undefined) {
      throw new LLMClientHttpError(
        typeof chunk.error.status === 'number' ? chunk.error.status : 502,
        chunk.error.message ?? 'backend reported an error mid-stream',
        id,
        chunk.error.retry_after_sec,
      );
    }
    id ??= chunk.id;
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d = choice.delta;
    if (typeof d?.content === 'string') content += d.content;
    if (typeof d?.reasoning === 'string') reasoning += d.reasoning;
    if (typeof d?.reasoning_content === 'string') reasoning += d.reasoning_content;
    for (const tc of d?.tool_calls ?? []) {
      const slot = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
      if (typeof tc.id === 'string' && tc.id !== '') slot.id = tc.id;
      if (typeof tc.function?.name === 'string') slot.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  }

  if (finishReason === null) {
    throw new LLMClientProtocolError('stream ended without a finish_reason (cut short)', null);
  }
  const toolCalls: OpenAIToolCallWire[] = calls
    .filter((c): c is NonNullable<typeof c> => c !== undefined)
    .map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }));
  return {
    ...(id !== undefined && { id }),
    ...(model !== undefined && { model }),
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoning !== '' && { reasoning }),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usage !== undefined && { usage }),
  };
}
