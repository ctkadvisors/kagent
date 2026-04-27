/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `LLMClient` interface tests.
 */

import { describe, it, expect } from 'vitest';
import type { LLMClient, ChatMessage, ChatDelta, ClientContext } from './llm-client.js';
import { makeStubLLM } from './__fixtures__/stub-llm.js';

describe('LLMClient — interface shape', () => {
  it('SC1.1: LLMClient shape compiles with chat/chatStream/countTokens; embed optional', () => {
    // Three valid impls compile (type-level test).
    const withEmbed: LLMClient = {
      chat: () => Promise.resolve({ content: '' }),
      chatStream: () => makeStubLLM().chatStream({ messages: [] }),
      countTokens: () => 0,
      embed: () => Promise.resolve([[1, 2, 3]]),
    };
    const withoutEmbed: LLMClient = {
      chat: () => Promise.resolve({ content: '' }),
      chatStream: () => makeStubLLM().chatStream({ messages: [] }),
      countTokens: () => 0,
    };
    const syncCount: LLMClient = {
      chat: () => Promise.resolve({ content: '' }),
      chatStream: () => makeStubLLM().chatStream({ messages: [] }),
      countTokens: () => 42,
    };
    expect(typeof withEmbed.chat).toBe('function');
    expect(typeof withoutEmbed.chat).toBe('function');
    expect(typeof syncCount.chat).toBe('function');
    expect('embed' in withEmbed).toBe(true);
    expect('embed' in withoutEmbed).toBe(false);
  });

  it('SC1.2: chat() returns ChatResult with usage.inputTokens/outputTokens/costUsd populated', async () => {
    const llm = makeStubLLM({
      scriptedResponses: [
        { content: 'hello', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } },
      ],
    });
    const ctx: ClientContext = { runId: 'r1', abortSignal: new AbortController().signal };
    const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] }, ctx);
    expect(result.content).toBe('hello');
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
    expect(result.usage?.costUsd).toBe(0.001);
  });

  it('SC1.3: chat() with usage undefined returns valid result; consumer treats as missing', async () => {
    const llm = makeStubLLM({ scriptedResponses: [{ content: 'hi' }] });
    const ctx: ClientContext = { runId: 'r1', abortSignal: new AbortController().signal };
    const result = await llm.chat({ messages: [] }, ctx);
    expect(result.content).toBe('hi');
    expect(result.usage).toBeUndefined();
  });

  it('SC1.4: chatStream() consumes all deltas via for await; concatenated content matches scripted total', async () => {
    const llm = makeStubLLM({
      scriptedDeltas: [
        [{ content: 'hel' }, { content: 'lo' }, { content: ' world', stopReason: 'end_turn' }],
      ],
    });
    const ctx: ClientContext = { runId: 'r1', abortSignal: new AbortController().signal };
    const collected: ChatDelta[] = [];
    for await (const delta of llm.chatStream({ messages: [] }, ctx)) {
      collected.push(delta);
    }
    expect(collected).toHaveLength(3);
    const concatenated = collected.map((d) => d.content ?? '').join('');
    expect(concatenated).toBe('hello world');
    expect(collected[2]?.stopReason).toBe('end_turn');
  });

  it('SC1.5: countTokens(string) and countTokens(messages[]) both compile and return number-or-promise', () => {
    const llm = makeStubLLM();
    const fromString = llm.countTokens('hello world');
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const fromMessages = llm.countTokens(messages);
    expect(typeof fromString === 'number' || fromString instanceof Promise).toBe(true);
    expect(typeof fromMessages === 'number' || fromMessages instanceof Promise).toBe(true);
  });

  it('SC1.6: NO Anthropic/OpenAI/LiteLLM type names appear in llm-client.ts (grep gate)', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, 'llm-client.ts'), 'utf8');
    const forbidden = [
      /import.*Anthropic/i,
      /import.*OpenAI/i,
      /import.*[Ll]iteLLM/,
      /@anthropic-ai/,
      /@openai/,
      /@modelcontextprotocol\/sdk/,
    ];
    for (const pattern of forbidden) {
      expect(src.match(pattern)).toBeNull();
    }
  });
});
