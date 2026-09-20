/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Turn a streamed chat completion back into the non-streamed response.
 *
 * The gateway asks every OpenAI-compatible backend to stream, whether or not
 * its own caller did: tokens on the wire are what lets an idle timer tell a
 * slow backend from a dead one (long-fetch.ts). Callers that wanted one JSON
 * body get this assembly, which must equal what the backend would have sent
 * for `stream: false`:
 *
 *   - `delta.content` concatenates.
 *   - Thinking arrives as `delta.reasoning` (vLLM) or `delta.reasoning_content`
 *     (llama.cpp, DeepSeek); both land in `message.reasoning`, the field the
 *     agent-side mapper already reads.
 *   - Tool calls arrive as fragments keyed by `index`; `arguments` is JSON cut
 *     at arbitrary byte boundaries and is only valid once joined.
 *   - Usage rides a final chunk with empty `choices` (`include_usage`).
 *
 * A stream that ends without a `finish_reason` was cut short. That is an
 * error, never a short answer.
 *
 * Mirrored for the agent side in @kagent/openai-compat `stream-assembler.ts`;
 * the two packages share no dependency, so keep them in step.
 */

import type { ChatCompletionResponse, Usage } from './types.js';

interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface RawChunk {
  id?: string;
  created?: number;
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: RawToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Usage | null;
  error?: { message?: string };
}

export class IncompleteStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteStreamError';
  }
}

/** Parse an SSE body into its JSON `data:` payloads. Comments (`: ping`) and `[DONE]` are skipped. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.pipeThrough(new TextDecoderStream('utf-8')).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // Skipping a frame would silently drop tokens or tool-call arguments.
          throw new IncompleteStreamError(
            `backend sent a frame that is not JSON: ${payload.slice(0, 120)}`,
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function assembleChatCompletion(
  chunks: AsyncIterable<unknown>,
): Promise<ChatCompletionResponse> {
  let id = '';
  let created = Math.floor(Date.now() / 1000);
  let model = '';
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: Usage | undefined;
  const calls: { id: string; name: string; args: string }[] = [];

  for await (const raw of chunks) {
    const chunk = raw as RawChunk;
    if (chunk.error !== undefined) {
      throw new IncompleteStreamError(
        `backend reported mid-stream: ${chunk.error.message ?? 'error'}`,
      );
    }
    if (typeof chunk.id === 'string' && id === '') id = chunk.id;
    if (typeof chunk.created === 'number') created = chunk.created;
    if (typeof chunk.model === 'string' && model === '') model = chunk.model;
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
    throw new IncompleteStreamError('backend stream ended without a finish_reason');
  }
  const toolCalls = calls
    .filter((c): c is NonNullable<typeof c> => c !== undefined)
    .map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args },
    }));
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (reasoning !== '') message['reasoning'] = reasoning;
  if (toolCalls.length > 0) message['tool_calls'] = toolCalls;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  } as unknown as ChatCompletionResponse;
}
