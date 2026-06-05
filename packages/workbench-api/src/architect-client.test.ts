/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';
import { ArchitectClient } from './architect-client.js';

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

describe('ArchitectClient.complete', () => {
  it('POSTs to the gateway /v1/chat/completions with bearer auth and returns the message', async () => {
    const fetchMock = fakeFetch({ choices: [{ message: { content: 'agentSpec: {}' } }] });
    const client = new ArchitectClient(
      { baseUrl: 'http://gw:4000/v1', token: 'sk-x', model: 'm1' },
      fetchMock,
    );
    const out = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('agentSpec: {}');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://gw:4000/v1/chat/completions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-x');
    const sent = JSON.parse(init!.body as string) as { model: string; messages: unknown[] };
    expect(sent.model).toBe('m1');
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('throws a scrubbed error on a 5xx (no gateway internals leak)', async () => {
    const fetchMock = fakeFetch({ error: 'pod kagent-llm-gateway-xyz crashed' }, 502);
    const client = new ArchitectClient(
      { baseUrl: 'http://gw:4000/v1', token: 'sk-x', model: 'm1' },
      fetchMock,
    );
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /architect upstream error \(status 502\)/i,
    );
  });

  it('throws when the upstream returns no message content', async () => {
    const fetchMock = fakeFetch({ choices: [] });
    const client = new ArchitectClient(
      { baseUrl: 'http://gw:4000/v1', token: 'sk-x', model: 'm1' },
      fetchMock,
    );
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /no message content/i,
    );
  });
});
