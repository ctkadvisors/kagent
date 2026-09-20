/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * chat() streams every turn and assembles it (2026-09-20: a thinking turn died
 * at 5m0.55s under Node fetch's 300 s limits). These drive the real client
 * against real SSE bodies, pings included.
 */

import { describe, expect, it } from 'vitest';
import { LLMClientHttpError, LLMClientProtocolError } from '@kagent/agent-loop';
import { OpenAICompatibleLLMClient } from './client.js';

const sse =
  (frames: string[]): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(frames.map((f) => `${f}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

const client = (fetchImpl: typeof fetch): OpenAICompatibleLLMClient =>
  new OpenAICompatibleLLMClient({ baseUrl: 'http://gw/v1', model: 'flashnext', fetch: fetchImpl });

const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('chat() over a streamed reply', () => {
  it('asks the backend to stream', async () => {
    let sent: Record<string, unknown> = {};
    const f = ((_u: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string) as Record<string, unknown>;
      return sse([
        'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}',
      ])(_u, init);
    }) as unknown as typeof fetch;
    await client(f).chat(ask);
    expect(sent['stream']).toBe(true);
  });

  it('assembles tokens, split tool-call arguments and usage through pings', async () => {
    const result = await client(
      sse([
        ': ping',
        'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
        ': ping',
        'data: {"choices":[{"index":0,"delta":{"reasoning":"thinking for half an hour"}}]}',
        'data: {"choices":[{"index":0,"delta":{"content":"on it","tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"look","arguments":"{\\"q\\":"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}',
        'data: [DONE]',
      ]),
    ).chat(ask);
    expect(result.content).toBe('on it');
    expect(result.tool_calls).toEqual([{ id: 't1', name: 'look', args: { q: 'x' } }]);
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 4 });
    expect(result.stopReason).toBe('tool_use');
  });

  it("reads the gateway's one-chunk reply, and falls back to reasoning exactly as the JSON path does", async () => {
    const result = await client(
      sse([
        ': ping',
        'data: {"id":"req-1","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"ran out mid-thought"},"finish_reason":"length"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":9,"total_tokens":14}}',
        'data: [DONE]',
      ]),
    ).chat(ask);
    expect(result.content).toBe('ran out mid-thought');
    expect(result.stopReason).toBe('max_tokens');
  });

  it('an in-band error is the HTTP error it would have been, Retry-After included', async () => {
    const err = await client(
      sse([
        ': ping',
        'data: {"error":{"message":"model m at capacity","type":"rate_limit_error","status":429,"retry_after_sec":7}}',
        'data: [DONE]',
      ]),
    )
      .chat(ask)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMClientHttpError);
    expect(err).toMatchObject({ status: 429, retryAfterSec: 7 });
  });

  it('a stream cut before its finish_reason is a protocol error, never a short answer', async () => {
    await expect(
      client(sse(['data: {"choices":[{"index":0,"delta":{"content":"half an ans"}}]}'])).chat(ask),
    ).rejects.toBeInstanceOf(LLMClientProtocolError);
  });

  it('a connection that dies mid-turn is a status-0 HTTP error, so the retry gate sees it', async () => {
    const dying = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(': ping\n\n'));
              c.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )) as unknown as typeof fetch;
    const err = await client(dying)
      .chat(ask)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMClientHttpError);
    expect(err).toMatchObject({ status: 0 });
  });
});
