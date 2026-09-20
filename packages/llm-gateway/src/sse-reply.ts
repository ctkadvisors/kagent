/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * The `stream: true` answer of `/v1/chat/completions`.
 *
 * Why a caller asks for it: a thinking turn can run 30 min+, and a caller on
 * Node's fetch is cut off after 300 s without response headers, then again
 * after 300 s between body bytes. So the gateway commits `200
 * text/event-stream` at once and writes an SSE comment (`: ping`) every
 * `pingMs` until the turn is done. Bytes never stop while the gateway is
 * alive, which turns the caller's own idle timeout into what it should be: a
 * detector for a gateway that is gone.
 *
 * The status line is spent before the outcome is known, so the outcome
 * travels in-band:
 *
 *   - success: the whole completion as one `chat.completion.chunk` (role,
 *     content, reasoning, complete tool calls, finish_reason), a usage chunk,
 *     then `[DONE]`. Any OpenAI streaming client reads that as a short stream.
 *   - failure: `data: {"error": {..., "status": 429, "retry_after_sec": 7}}`
 *     then `[DONE]`. @kagent/openai-compat turns it back into the same
 *     `LLMClientHttpError` a plain 429 would have raised, so backpressure
 *     (H13) still reaches the agent's retry loop.
 *
 * ponytail: tokens are not relayed as they decode; the agent loop consumes
 * whole turns, and the ping already keeps the hop alive. Relay provider
 * chunks through here when something downstream renders text live.
 */

import type { ServerResponse } from 'node:http';
import type { ChatCompletionResponse } from './types.js';

export const DEFAULT_SSE_PING_MS = 15_000;

export interface SseReply {
  /** Send the outcome in-band and end the response. */
  finish(status: number, body: unknown, retryAfterSec?: number): void;
}

export function openSse(res: ServerResponse, pingMs: number = DEFAULT_SSE_PING_MS): SseReply {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // a buffering proxy would hold the pings back
  });
  res.write(': ping\n\n');
  const timer = setInterval(() => {
    res.write(': ping\n\n');
  }, pingMs);
  res.on('close', () => {
    clearInterval(timer);
  });

  const event = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  return {
    finish(status, body, retryAfterSec) {
      clearInterval(timer);
      if (res.writableEnded) return;
      if (status === 200) {
        for (const chunk of toChunks(body as ChatCompletionResponse)) event(chunk);
      } else {
        const error = (body as { error?: Record<string, unknown> }).error ?? {};
        event({
          error: {
            ...error,
            status,
            ...(retryAfterSec !== undefined && { retry_after_sec: retryAfterSec }),
          },
        });
      }
      res.end('data: [DONE]\n\n');
    },
  };
}

/** One completed response as the shortest valid stream: a full delta, then usage. */
function toChunks(r: ChatCompletionResponse): unknown[] {
  const head = { id: r.id, object: 'chat.completion.chunk', created: r.created, model: r.model };
  const choice = r.choices[0] as unknown as
    | { message?: Record<string, unknown>; finish_reason?: string | null }
    | undefined;
  const message = choice?.message ?? {};
  const toolCalls = Array.isArray(message['tool_calls'])
    ? (message['tool_calls'] as Record<string, unknown>[]).map((tc, index) => ({ index, ...tc }))
    : undefined;
  const delta = { ...message, ...(toolCalls !== undefined && { tool_calls: toolCalls }) };
  return [
    { ...head, choices: [{ index: 0, delta, finish_reason: choice?.finish_reason ?? 'stop' }] },
    { ...head, choices: [], usage: r.usage },
  ];
}
