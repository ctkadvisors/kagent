/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openSse, type SseReply } from './sse-reply.js';
import type { ChatCompletionResponse } from './types.js';

let server: Server | undefined;

/** Boot a server whose handler opens an SSE reply and finishes it after `afterMs`. */
function serve(afterMs: number, finish: (r: SseReply) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      const reply = openSse(res, 20);
      setTimeout(() => {
        finish(reply);
      }, afterMs);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${String((server?.address() as AddressInfo).port)}/`);
    });
  });
}

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

const completion = {
  id: 'req-1',
  object: 'chat.completion',
  created: 7,
  model: 'flashnext',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'done',
        reasoning: 'a long think',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'look', arguments: '{"q":"x"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
} as unknown as ChatCompletionResponse;

const events = (text: string): unknown[] =>
  text
    .split('\n\n')
    .filter((e) => e.startsWith('data: ') && e !== 'data: [DONE]')
    .map((e) => JSON.parse(e.slice(6)) as unknown);

describe('openSse', () => {
  it('commits 200 at once and pings while the turn runs, then sends the whole turn in-band', async () => {
    // Ordering, not wall-clock: the headers must be in the caller's hands before the turn
    // finishes. That is what defeats a caller-side headers timeout (300 s in Node's fetch).
    let finishedAt = 0;
    const url = await serve(500, (r) => {
      finishedAt = performance.now();
      r.finish(200, completion);
    });
    const res = await fetch(url);
    const headersAt = performance.now();
    expect(finishedAt).toBe(0); // the turn is still running
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(finishedAt).toBeGreaterThan(headersAt);
    expect(text.match(/^: ping$/gm)?.length ?? 0).toBeGreaterThanOrEqual(3); // 20 ms pings over a 500 ms turn
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    const [first, last] = events(text) as [
      { choices: { delta: Record<string, unknown>; finish_reason: string }[] },
      { choices: unknown[]; usage: unknown },
    ];
    expect(first.choices[0]?.delta['content']).toBe('done');
    expect(first.choices[0]?.delta['reasoning']).toBe('a long think');
    expect(first.choices[0]?.delta['tool_calls']).toEqual([
      { index: 0, id: 't1', type: 'function', function: { name: 'look', arguments: '{"q":"x"}' } },
    ]);
    expect(first.choices[0]?.finish_reason).toBe('tool_calls');
    expect(last).toMatchObject({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } });
  });

  it('an outcome that would have been a 429 keeps its status and Retry-After in-band', async () => {
    const url = await serve(10, (r) => {
      r.finish(429, { error: { message: 'model m at capacity', type: 'rate_limit_error' } }, 7);
    });
    const text = await (await fetch(url)).text();
    expect(events(text)).toEqual([
      {
        error: {
          message: 'model m at capacity',
          type: 'rate_limit_error',
          status: 429,
          retry_after_sec: 7,
        },
      },
    ]);
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});
