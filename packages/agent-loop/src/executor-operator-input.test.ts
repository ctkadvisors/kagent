/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/** `RunInput.pollOperatorInput`: operator input reaches a running loop once. */

import { describe, it, expect } from 'vitest';
import { AgentRegistry } from './registry.js';
import { AgentExecutor } from './executor.js';
import type { ChatResult, LLMClient } from './llm-client.js';
import type { MyType, MyPhase } from './__fixtures__/agents.js';
import { chatAgent } from './__fixtures__/agents.js';
import { makeStubLLM } from './__fixtures__/stub-llm.js';
import { makeStubToolProvider } from './__fixtures__/stub-tool-provider.js';

type Msg = { role: string; content: string };
const toolTurn = (n: number): ChatResult => ({
  content: '',
  tool_calls: [{ id: `c${String(n)}`, name: 'echo', args: { n } }],
});

function setup(toolTurns: number) {
  const registry = new AgentRegistry<MyType, MyPhase>();
  registry.register(chatAgent);
  const turns = Array.from({ length: toolTurns }, (_, i) => toolTurn(i));
  const base = makeStubLLM({ scriptedResponses: [...turns, { content: 'done' }] });
  // Snapshot each request: the executor keeps mutating the same array.
  const seen: Msg[][] = [];
  const llm: LLMClient = {
    ...base,
    chat: (req, ctx) => {
      seen.push(req.messages.map((m) => ({ role: m.role, content: m.content })));
      return base.chat(req, ctx);
    },
  };
  const tools = [
    makeStubToolProvider({ id: 'p', tools: [{ name: 'echo', description: '', inputSchema: {} }] }),
  ];
  return { exec: new AgentExecutor({ registry, llm, toolProviders: tools }), seen };
}

// Yields `batch` on the first poll after the first model call, then nothing.
function sendOnce(seen: unknown[], batch: string[]) {
  let sent = false;
  return () => {
    if (seen.length === 0 || sent) return Promise.resolve([]);
    sent = true;
    return Promise.resolve(batch);
  };
}

const ops = (call: Msg[]) =>
  call.filter((m) => m.role === 'user' && m.content.includes('opmsg-')).map((m) => m.content);
const go = [{ role: 'user' as const, content: 'go' }];

describe('AgentExecutor — operator input mid-run', () => {
  it('appends a drained message as a user message before the next call, once', async () => {
    const { exec, seen } = setup(2);
    const result = await exec.run({
      agentType: 'chat',
      messages: go,
      pollOperatorInput: sendOnce(seen, ['opmsg-stop and report']),
    });
    expect(result.finalContent).toBe('done');
    expect(seen.map((c) => ops(c).length)).toEqual([0, 1, 1]);
    expect(seen[1]?.at(-1)?.content).toContain('opmsg-stop and report');
  });

  it('bounds each drain and carries the rest over without duplicates', async () => {
    const { exec, seen } = setup(3);
    const flood = Array.from({ length: 40 }, (_, i) => `opmsg-${String(i)}`);
    await exec.run({ agentType: 'chat', messages: go, pollOperatorInput: sendOnce(seen, flood) });
    const counts = seen.map((c) => ops(c).length);
    expect(counts[1]).toBeGreaterThan(0);
    expect(counts[1]).toBeLessThan(40);
    expect(counts[2]).toBeGreaterThan(counts[1] ?? 0);
    const last = ops(seen.at(-1) ?? []);
    expect(new Set(last).size).toBe(last.length);
  });

  it('a failing source does not fail the run', async () => {
    const { exec } = setup(1);
    const result = await exec.run({
      agentType: 'chat',
      messages: go,
      pollOperatorInput: () => Promise.reject(new Error('nats down')),
    });
    expect(result.finalContent).toBe('done');
  });
});
