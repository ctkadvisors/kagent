/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import {
  channelTurnEpisode,
  stripPreviousTurn,
  withPreviousTurn,
  writeBrainEpisode,
} from './brain.js';

describe('previous-turn bridge', () => {
  it('prepends the previous exchange and strips it back to the raw message', () => {
    const bridged = withPreviousTurn({
      text: 'and the second one?',
      previousMessage: 'whats the biggest pod',
      previousReply: 'ornith-b12x-serve on spark',
      operatorName: 'Chris',
    });
    expect(bridged).toBe(
      '[previous turn]\nChris: whats the biggest pod\nYou: ornith-b12x-serve on spark\n[current message]\nand the second one?',
    );
    expect(stripPreviousTurn(bridged)).toBe('and the second one?');
    expect(stripPreviousTurn('plain')).toBe('plain');
  });

  it('never nests: bridging a bridged previous message keeps only the raw text', () => {
    const first = withPreviousTurn({
      text: 'b',
      previousMessage: 'a',
      previousReply: 'ra',
      operatorName: 'Chris',
    });
    const second = withPreviousTurn({
      text: 'c',
      previousMessage: first,
      previousReply: 'rb',
      operatorName: 'Chris',
    });
    expect(second).toBe('[previous turn]\nChris: b\nYou: rb\n[current message]\nc');
  });
});

describe('channelTurnEpisode', () => {
  it('records the raw message, the reply, and the real time of the exchange', () => {
    const episode = channelTurnEpisode({
      operatorName: 'Chris',
      agentName: 'concierge',
      message: '[previous turn]\nChris: a\nYou: b\n[current message]\nhow much vram is free',
      reply: 'About 20 GB.',
      error: undefined,
      at: '2026-09-02T03:00:00Z',
    });
    expect(episode).toEqual({
      name: 'telegram: how much vram is free (2026-09-02)',
      body: 'Chris (telegram): how much vram is free\nconcierge replied: About 20 GB.',
      referenceTime: '2026-09-02T03:00:00Z',
    });
  });

  it('records failures so the brain knows what it could not do', () => {
    const episode = channelTurnEpisode({
      operatorName: 'Chris',
      agentName: 'concierge',
      message: 'restart everything',
      reply: undefined,
      error: 'LLM backend returned HTTP 0',
      at: '2026-09-02T03:00:00Z',
    });
    expect(episode.body).toBe(
      'Chris (telegram): restart everything\nconcierge failed to answer: LLM backend returned HTTP 0',
    );
  });
});

describe('writeBrainEpisode', () => {
  it('does the MCP dance: initialize, initialized, tools/call add_memory with the session id', async () => {
    const calls: Array<{ body: unknown; session: string | undefined }> = [];
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ body: JSON.parse(init?.body as string), session: headers['mcp-session-id'] });
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'mcp-session-id': 'sess-1' } }),
      );
    }) as unknown as typeof fetch;

    await writeBrainEpisode(
      { mcpUrl: 'http://brain/mcp', token: 't', operatorName: 'Chris' },
      { name: 'n', body: 'b', referenceTime: '2026-09-02T03:00:00Z' },
      fetchImpl,
    );

    expect(calls.map((c) => (c.body as { method: string }).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(calls[1]?.session).toBe('sess-1');
    expect(calls[2]?.body).toMatchObject({
      params: {
        name: 'add_memory',
        arguments: { name: 'n', episode_body: 'b', reference_time: '2026-09-02T03:00:00Z' },
      },
    });
  });

  it('throws on a non-2xx so the caller can log it', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('nope', { status: 401 })),
    ) as unknown as typeof fetch;
    await expect(
      writeBrainEpisode(
        { mcpUrl: 'http://brain/mcp', token: 't', operatorName: 'Chris' },
        { name: 'n', body: 'b', referenceTime: '2026-09-02T03:00:00Z' },
        fetchImpl,
      ),
    ).rejects.toThrow('HTTP 401');
  });
});
