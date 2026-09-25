/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from './registry.js';
import { AgentExecutor, capToolResult, loopTurnNote } from './executor.js';
import { MALFORMED_TOOL_ARGS } from './llm-client.js';
import type { MyType, MyPhase } from './__fixtures__/agents.js';
import { chatAgent } from './__fixtures__/agents.js';
import { makeStubLLM } from './__fixtures__/stub-llm.js';
import type { ToolProvider, ToolResult } from './tool-provider.js';

function echoProvider(reply: string): ToolProvider & { calls: number } {
  const p = {
    id: 'echo',
    calls: 0,
    describeTools: () =>
      Promise.resolve([
        { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } },
      ]),
    executeTool: (): Promise<ToolResult> => {
      p.calls += 1;
      return Promise.resolve({ content: reply, isError: false });
    },
  };
  return p;
}

const call = (id: string, q: string) => ({
  content: '',
  tool_calls: [{ id, name: 'echo', args: { q } }],
});

describe('capToolResult', () => {
  it('leaves short text alone and middle-elides long text keeping head and tail', () => {
    expect(capToolResult('abc', 10)).toBe('abc');
    const long = 'H'.repeat(900) + 'T'.repeat(300);
    const capped = capToolResult(long, 400);
    expect(capped.startsWith('H'.repeat(300))).toBe(true);
    expect(capped.endsWith('T'.repeat(100))).toBe(true);
    expect(capped).toContain('[tool result truncated: 800 of 1200 chars elided]');
  });
});

describe('AgentExecutor — tool guards', () => {
  let registry: AgentRegistry<MyType, MyPhase>;
  beforeEach(() => {
    registry = new AgentRegistry<MyType, MyPhase>();
    registry.register(chatAgent);
  });

  it('refuses the third identical call and the model answers with what it has', async () => {
    const provider = echoProvider('nothing here');
    const llm = makeStubLLM({
      scriptedChat: [
        call('c1', 'same'),
        call('c2', 'same'),
        call('c3', 'same'),
        { content: 'ok, giving up' },
      ],
    });
    const exec = new AgentExecutor({ registry, llm, toolProviders: [provider] });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      maxIterations: 8,
    });
    expect(result.status).toBe('completed');
    expect(provider.calls).toBe(2);
    const guarded = result.traces.filter(
      (t) => t.trace_type === 'tool_call' && String(t.error ?? '').startsWith('guard:'),
    );
    expect(guarded).toHaveLength(1);
    expect(guarded[0]?.error).toContain('already called 2 times with these exact arguments');
  });

  it('refuses a tool past maxCallsPerTool even with varying arguments', async () => {
    const provider = echoProvider('meh');
    const llm = makeStubLLM({
      scriptedChat: [
        call('c1', 'a'),
        call('c2', 'b'),
        call('c3', 'c'),
        call('c4', 'd'),
        { content: 'done' },
      ],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      toolProviders: [provider],
      toolGuards: { maxCallsPerTool: 3 },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      maxIterations: 8,
    });
    expect(result.status).toBe('completed');
    expect(provider.calls).toBe(3);
    const last = result.traces.filter((t) => t.trace_type === 'tool_call').at(-1);
    expect(last?.error).toContain('has been called 3 times in this run');
  });

  it('has no per-tool cap unless one is set: a single-tool agent may use every turn it has', async () => {
    // 2026-09-19/20: the fleet-auditor does every read and every write through one tool and
    // was refused its 9th call under the old constant 8, twice, with its audit unposted.
    const provider = echoProvider('ok');
    const llm = makeStubLLM({
      scriptedChat: [
        ...Array.from({ length: 12 }, (_, i) => call(`c${String(i)}`, `q${String(i)}`)),
        { content: 'posted' },
      ],
    });
    const exec = new AgentExecutor({ registry, llm, toolProviders: [provider] });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      maxIterations: 30,
    });
    expect(result.status).toBe('completed');
    expect(provider.calls).toBe(12);
    expect(result.traces.filter((t) => String(t.error ?? '').startsWith('guard:'))).toHaveLength(0);
  });

  it('tells the model when the run is nearly out of turns, and not before', async () => {
    const provider = echoProvider('data');
    const recordedRequests: { messages: { role: string; content: unknown }[] }[] = [];
    const llm = makeStubLLM({
      scriptedChat: [call('c1', 'a'), call('c2', 'b'), call('c3', 'c'), { content: 'done' }],
      recordedRequests: recordedRequests as never,
    });
    const exec = new AgentExecutor({ registry, llm, toolProviders: [provider] });
    await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      maxIterations: 5,
    });
    const toolResults = (recordedRequests.at(-1)?.messages ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => String(m.content));
    // Every result carries the turn number; turn 1 of 5 leaves 4: no urgency.
    // Turn 2 leaves 3, turn 3 leaves 2: told to finish.
    expect(toolResults[0]).toBe('data\n\n[loop: turn 1 of 5.]');
    expect(toolResults[1]).toContain('[loop: turn 2 of 5, 3 turns left in this run.');
    expect(toolResults[2]).toContain('[loop: turn 3 of 5, 2 turns left in this run.');
    expect(toolResults[2]).toContain('before reading anything more');
  });

  it('on a long run, asks to save at halfway and to finish with 15% left', () => {
    expect(loopTurnNote(0, 100)).toBe('\n\n[loop: turn 1 of 100.]');
    expect(loopTurnNote(48, 100)).toBe('\n\n[loop: turn 49 of 100.]');
    expect(loopTurnNote(49, 100)).toContain('[loop: turn 50 of 100. Half the run is spent');
    expect(loopTurnNote(83, 100)).toContain('Half the run is spent');
    expect(loopTurnNote(84, 100)).toContain('[loop: turn 85 of 100, 15 turns left in this run.');
    expect(loopTurnNote(99, 100)).toContain('this was the last turn of the run');
    // A short run keeps the fixed three-turn note and no halfway note.
    expect(loopTurnNote(0, 5)).toBe('\n\n[loop: turn 1 of 5.]');
    expect(loopTurnNote(1, 5)).toContain('3 turns left');
    expect(loopTurnNote(9, 19)).toBe('\n\n[loop: turn 10 of 19.]');
  });

  it('answers a tool call with malformed arguments with a tool error and lets the run go on', async () => {
    const provider = echoProvider('data');
    const recordedRequests: { messages: { role: string; content: unknown }[] }[] = [];
    const llm = makeStubLLM({
      scriptedChat: [
        {
          content: '',
          tool_calls: [{ id: 'c1', name: 'echo', args: { [MALFORMED_TOOL_ARGS]: '{"q": ' } }],
        },
        call('c2', 'again'),
        { content: 'done' },
      ],
      recordedRequests: recordedRequests as never,
    });
    const exec = new AgentExecutor({ registry, llm, toolProviders: [provider] });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      maxIterations: 5,
    });
    expect(result.status).toBe('completed');
    expect(provider.calls).toBe(1);
    const toolResults = (recordedRequests.at(-1)?.messages ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => String(m.content));
    expect(toolResults[0]).toContain('were not valid JSON');
    expect(toolResults[0]).toContain('Send it again');
    expect(toolResults[1]).toContain('data');
  });

  it('caps an oversized tool result before it enters the conversation', async () => {
    const provider = echoProvider('x'.repeat(50_000));
    const recordedRequests: import('./llm-client.js').ChatRequest[] = [];
    const llm = makeStubLLM({
      scriptedChat: [call('c1', 'big'), { content: 'done' }],
      recordedRequests,
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      toolProviders: [provider],
      toolGuards: { maxToolResultChars: 1000 },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    const toolMsg = recordedRequests.at(-1)?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content.length).toBeLessThan(1200);
    expect(toolMsg?.content).toContain('tool result truncated');
  });
});
