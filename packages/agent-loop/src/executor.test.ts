/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `AgentExecutor` loop-semantics tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from './registry.js';
import { AgentExecutor } from './executor.js';
import type { ChatResult } from './llm-client.js';
import type { MyType, MyPhase } from './__fixtures__/agents.js';
import { chatAgent } from './__fixtures__/agents.js';
import { makeStubLLM } from './__fixtures__/stub-llm.js';
import { makeStubToolProvider } from './__fixtures__/stub-tool-provider.js';
import { makeRecordingSink } from './__fixtures__/stub-trace-sink.js';

function buildRegistry(): AgentRegistry<MyType, MyPhase> {
  const reg = new AgentRegistry<MyType, MyPhase>();
  reg.register(chatAgent);
  return reg;
}

describe('AgentExecutor — loop semantics', () => {
  let registry: AgentRegistry<MyType, MyPhase>;
  beforeEach(() => {
    registry = buildRegistry();
  });

  it('SC3.1: one-shot — model returns content with no tool_calls; loop exits after iteration 0 with finalContent set', async () => {
    const llm = makeStubLLM({ scriptedResponses: [{ content: 'final answer' }] });
    const exec = new AgentExecutor({ registry, llm });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('final answer');
    expect(result.hitIterationCap).toBe(false);
    expect(result.traces.filter((t) => t.trace_type === 'llm_call')).toHaveLength(1);
  });

  it('SC3.2: two-iteration tool-use; trace order: iteration_boundary, llm_call, tool_call, iteration_boundary, llm_call', async () => {
    const llm = makeStubLLM({
      scriptedResponses: [
        { content: '', tool_calls: [{ id: 'c1', name: 'echo', args: { msg: 'x' } }] },
        { content: 'done' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'echo: x', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'use tool' }],
    });
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('done');
    const types = result.traces.map((t) => t.trace_type);
    expect(types).toEqual([
      'iteration_boundary',
      'llm_call',
      'tool_call',
      'iteration_boundary',
      'llm_call',
      'run_complete',
    ]);
  });

  it('SC3.3: iteration cap — 9 scripted tool-use responses, maxIterations=8; exits with hitIterationCap=true, status="completed", 8 llm_call entries', async () => {
    const responses: ChatResult[] = Array.from({ length: 9 }, () => ({
      content: '',
      tool_calls: [{ id: 'c', name: 'noop', args: {} }],
    }));
    const llm = makeStubLLM({ scriptedResponses: responses });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      maxIterations: 8,
    });
    expect(result.status).toBe('completed');
    expect(result.hitIterationCap).toBe(true);
    expect(result.traces.filter((t) => t.trace_type === 'llm_call')).toHaveLength(8);
  });

  it('SC3.4: token estimation fallback — ChatResult.usage undefined; budget.cumulativeInputTokens > 0 via estimateTokens', async () => {
    const llm = makeStubLLM({ scriptedResponses: [{ content: 'hello world' }] });
    const exec = new AgentExecutor({ registry, llm });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'a longer-ish input' }],
    });
    expect(result.budget.cumulativeInputTokens).toBeGreaterThan(0);
    expect(result.budget.cumulativeOutputTokens).toBeGreaterThan(0);
  });

  it('SC3.5: token estimation skip — ChatResult.usage.inputTokens=42; budget.cumulativeInputTokens=42 (NOT 42 plus estimate)', async () => {
    const llm = makeStubLLM({
      scriptedResponses: [{ content: 'short', usage: { inputTokens: 42, outputTokens: 7 } }],
    });
    const exec = new AgentExecutor({ registry, llm });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.budget.cumulativeInputTokens).toBe(42);
    expect(result.budget.cumulativeOutputTokens).toBe(7);
  });

  it('SC3.6: in-memory trace accumulator — 3 iterations; result.traces.length matches; sequence numbers monotonic', async () => {
    const llm = makeStubLLM({
      scriptedResponses: [
        { content: '', tool_calls: [{ id: 'c1', name: 'noop', args: {} }] },
        { content: '', tool_calls: [{ id: 'c2', name: 'noop', args: {} }] },
        { content: 'done' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.traces.length).toBeGreaterThanOrEqual(7); // 3 boundaries + 3 llm + 2 tool
    const seqs = result.traces.map((t) => t.sequence);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });
});

describe('AgentExecutor — budget surface', () => {
  let registry: AgentRegistry<MyType, MyPhase>;
  beforeEach(() => {
    registry = buildRegistry();
  });

  it('SC4.1: at iteration cap, budget.cumulativeInputTokens > 0 and cumulativeOutputTokens > 0', async () => {
    const responses: ChatResult[] = Array.from({ length: 9 }, () => ({
      content: 'x',
      tool_calls: [{ id: 'c', name: 'noop', args: {} }],
      usage: { inputTokens: 5, outputTokens: 3 },
    }));
    const llm = makeStubLLM({ scriptedResponses: responses });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      maxIterations: 8,
    });
    expect(result.hitIterationCap).toBe(true);
    expect(result.budget.cumulativeInputTokens).toBe(40);
    expect(result.budget.cumulativeOutputTokens).toBe(24);
  });

  it('SC4.2: at iteration cap with NO backend reporting costUsd, budget.cumulativeCostUsd === null', async () => {
    const responses: ChatResult[] = Array.from({ length: 9 }, () => ({
      content: '',
      tool_calls: [{ id: 'c', name: 'noop', args: {} }],
      usage: { inputTokens: 5, outputTokens: 3 }, // NO costUsd
    }));
    const llm = makeStubLLM({ scriptedResponses: responses });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      maxIterations: 8,
    });
    expect(result.budget.cumulativeCostUsd).toBeNull();
  });

  it('SC4.3: at iteration cap with one backend report of costUsd=0.01 across 5 iterations, cumulativeCostUsd === 0.01', async () => {
    const responses: ChatResult[] = [
      {
        content: '',
        tool_calls: [{ id: 'c', name: 'noop', args: {} }],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
      },
      {
        content: '',
        tool_calls: [{ id: 'c', name: 'noop', args: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: '',
        tool_calls: [{ id: 'c', name: 'noop', args: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: '',
        tool_calls: [{ id: 'c', name: 'noop', args: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: '',
        tool_calls: [{ id: 'c', name: 'noop', args: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { content: 'done' },
    ];
    const llm = makeStubLLM({ scriptedResponses: responses });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.budget.cumulativeCostUsd).toBeCloseTo(0.01);
  });

  it('SC4.4: budget cap — tokenLimit=100, response totals 150 tokens; status="budget_exceeded" after iter 0', async () => {
    const llm = makeStubLLM({
      scriptedResponses: [
        { content: 'x', usage: { inputTokens: 100, outputTokens: 50 } },
        { content: 'should not run' },
      ],
    });
    const exec = new AgentExecutor({ registry, llm });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      tokenLimit: 100,
    });
    expect(result.status).toBe('budget_exceeded');
  });

  it('SC4.5: budget cap — costLimitUsd=0.05, scripted cost accumulates past 0.05; status="budget_exceeded"', async () => {
    const llm = makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [{ id: 'c', name: 'noop', args: {} }],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.03 },
        },
        {
          content: '',
          tool_calls: [{ id: 'c', name: 'noop', args: {} }],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.03 },
        },
        { content: 'should not run' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      costLimitUsd: 0.05,
    });
    expect(result.status).toBe('budget_exceeded');
  });

  it('SC4.6: default maxIterations is 8 when not overridden — runs 8 iterations of a tool-loop stub before exiting with hitIterationCap === true', async () => {
    // 9 scripted responses; default maxIterations should cap at 8.
    const responses: ChatResult[] = Array.from({ length: 9 }, () => ({
      content: '',
      tool_calls: [{ id: 'c', name: 'noop', args: {} }],
    }));
    const llm = makeStubLLM({ scriptedResponses: responses });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
      }),
    ];
    // NO maxIterations override on either constructor or run() — exercises the D-12 default.
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.hitIterationCap).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.traces.filter((t) => t.trace_type === 'llm_call')).toHaveLength(8);
  });
});

describe('AgentExecutor — dispatch and cancellation', () => {
  let registry: AgentRegistry<MyType, MyPhase>;
  beforeEach(() => {
    registry = buildRegistry();
  });

  it('SC5.2: tool-call dispatch — one provider, one tool; provider.executeTool called with correct args', async () => {
    const recorded: Array<{ id: string; name: string; args: unknown }> = [];
    const llm = makeStubLLM({
      scriptedResponses: [
        { content: '', tool_calls: [{ id: 'c1', name: 'echo', args: { msg: 'hello' } }] },
        { content: 'done' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
        onCall: (call) => {
          recorded.push(call);
          return { content: 'ok', isError: false };
        },
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.name).toBe('echo');
    expect(recorded[0]?.args).toEqual({ msg: 'hello' });
  });

  it('SC5.3: multi-provider dispatch — 3 providers, 3 distinct tools; trace.tool_provider_id correctly attributes each', async () => {
    const llm = makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [
            { id: 'c1', name: 'a', args: {} },
            { id: 'c2', name: 'b', args: {} },
            { id: 'c3', name: 'c', args: {} },
          ],
        },
        { content: 'done' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p-a',
        tools: [{ name: 'a', description: '', inputSchema: {} }],
      }),
      makeStubToolProvider({
        id: 'p-b',
        tools: [{ name: 'b', description: '', inputSchema: {} }],
      }),
      makeStubToolProvider({
        id: 'p-c',
        tools: [{ name: 'c', description: '', inputSchema: {} }],
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    const toolTraces = result.traces.filter((t) => t.trace_type === 'tool_call');
    expect(toolTraces).toHaveLength(3);
    const provIds = toolTraces.map((t) => t.tool_provider_id);
    expect(provIds).toEqual(['p-a', 'p-b', 'p-c']);
  });

  it('SC5.4: AbortSignal cancellation pre-loop — signal already aborted; status="cancelled", traces.length === 0', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = makeStubLLM({ scriptedResponses: [{ content: 'should not run' }] });
    const exec = new AgentExecutor({ registry, llm });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(result.traces).toHaveLength(0);
  });

  it('SC5.5: AbortSignal cancellation mid-LLM-call; status="cancelled", partial trace populated', async () => {
    const controller = new AbortController();
    const llm = makeStubLLM({
      scriptedResponses: [
        { content: '', tool_calls: [{ id: 'c1', name: 'noop', args: {} }] },
        { content: 'unreachable' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
        onCall: () => {
          controller.abort();
          return { content: 'ok', isError: false };
        },
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(result.traces.length).toBeGreaterThan(0);
  });

  it('SC5.6: AbortSignal cancellation between tool calls in same iteration; second call NOT made; status="cancelled"', async () => {
    const controller = new AbortController();
    const recordedCalls: string[] = [];
    const llm = makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [
            { id: 'c1', name: 'a', args: {} },
            { id: 'c2', name: 'b', args: {} },
          ],
        },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p-a',
        tools: [{ name: 'a', description: '', inputSchema: {} }],
        onCall: (call) => {
          recordedCalls.push(call.name);
          controller.abort();
          return { content: 'ok', isError: false };
        },
      }),
      makeStubToolProvider({
        id: 'p-b',
        tools: [{ name: 'b', description: '', inputSchema: {} }],
        onCall: (call) => {
          recordedCalls.push(call.name);
          return { content: 'ok', isError: false };
        },
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(recordedCalls).toEqual(['a']); // 'b' never called
  });

  it('SC5.7: trace sequence ordering — strictly monotonic across the entire run', async () => {
    const llm = makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [
            { id: 'c1', name: 'noop', args: {} },
            { id: 'c2', name: 'noop', args: {} },
          ],
        },
        {
          content: '',
          tool_calls: [
            { id: 'c3', name: 'noop', args: {} },
            { id: 'c4', name: 'noop', args: {} },
          ],
        },
        { content: 'done' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    const seqs = result.traces.map((t) => t.sequence);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('SC5.8: TraceSink fan-out — 2 sinks each receive every entry in order; flush() called once at end', async () => {
    const sink1 = makeRecordingSink();
    const sink2 = makeRecordingSink();
    const llm = makeStubLLM({ scriptedResponses: [{ content: 'done' }] });
    const exec = new AgentExecutor({ registry, llm, sinks: [sink1, sink2] });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(sink1.entries).toHaveLength(result.traces.length);
    expect(sink2.entries).toHaveLength(result.traces.length);
    expect(sink1.flushCount).toBe(1);
    expect(sink2.flushCount).toBe(1);
  });
});

describe('AgentExecutor — provider-trace-unaware (D-09 / SC2.6)', () => {
  it('SC2.6: provider stays trace-unaware — stub provider that does NOT touch sinks; assert traces still emit', async () => {
    const sink = makeRecordingSink();
    const llm = makeStubLLM({
      scriptedResponses: [
        { content: '', tool_calls: [{ id: 'c1', name: 'noop', args: {} }] },
        { content: 'done' },
      ],
    });
    // Provider does NOT touch sinks (matches D-09: provider trace-unaware).
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
      }),
    ];
    const reg = new AgentRegistry<MyType, MyPhase>();
    reg.register(chatAgent);
    const exec = new AgentExecutor({
      registry: reg,
      llm,
      toolProviders: tools,
      sinks: [sink],
    });
    await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    // Executor wrapped tool call with timing; sink received tool_call entry.
    const toolEntries = sink.entries.filter((e) => e.trace_type === 'tool_call');
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.tool_provider_id).toBe('p1');
  });
});

describe('AgentExecutor — tool-call ID synthesis (WS-D fix #3)', () => {
  let registry: AgentRegistry<MyType, MyPhase>;
  beforeEach(() => {
    registry = buildRegistry();
  });

  it('writes synthesized tool-call ID back into the assistant message and reuses it for tool_call_id', async () => {
    // Stub returns a tool_call with id: undefined (matches some Llama 4
    // / Workers AI variants). The fix must:
    //   (a) synthesize a non-empty id
    //   (b) place it on the assistant message in chat history
    //   (c) reuse the SAME synthesized id for the tool-result tool_call_id
    //
    // We assert by inspecting the SECOND ChatRequest the executor
    // sends to the LLM — that request's messages array IS the chat
    // history the model would re-read on a multi-turn flow.
    const recordedRequests: import('./llm-client.js').ChatRequest[] = [];
    const llm = makeStubLLM({
      recordedRequests,
      scriptedResponses: [
        { content: '', tool_calls: [{ name: 'echo', args: { msg: 'x' } } as never] },
        { content: 'done' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'ok', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(result.status).toBe('completed');
    expect(recordedRequests).toHaveLength(2);

    // Iteration-1 request: should now contain assistant + tool messages
    // from iteration 0, both carrying the SAME synthesized id.
    const secondReqMessages = recordedRequests[1]!.messages;
    const assistantMsg = secondReqMessages.find((m) => m.role === 'assistant');
    const toolMsg = secondReqMessages.find((m) => m.role === 'tool' && m.name === 'echo');
    expect(assistantMsg).toBeDefined();
    expect(toolMsg).toBeDefined();
    // (a) the assistant message has a defined, non-empty id
    expect(assistantMsg!.tool_calls).toHaveLength(1);
    const assistantId = assistantMsg!.tool_calls![0]!.id;
    expect(typeof assistantId).toBe('string');
    expect(assistantId.length).toBeGreaterThan(0);
    // (b)+(c) the tool-result message uses THE SAME id
    expect(toolMsg!.tool_call_id).toBe(assistantId);
  });

  it('synthesized id is stable per-call within an iteration (no double-synthesis drift)', async () => {
    // Two tool calls in the same iteration, both with empty IDs. Each
    // must get its OWN synthesized id and the corresponding tool-result
    // message must reference that exact id (NOT a freshly minted one).
    const recordedRequests: import('./llm-client.js').ChatRequest[] = [];
    const llm = makeStubLLM({
      recordedRequests,
      scriptedResponses: [
        {
          content: '',
          tool_calls: [{ name: 'a', args: {} } as never, { name: 'b', args: {} } as never],
        },
        { content: 'done' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p-a',
        tools: [{ name: 'a', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'ok-a', isError: false }),
      }),
      makeStubToolProvider({
        id: 'p-b',
        tools: [{ name: 'b', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'ok-b', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });

    const secondReqMessages = recordedRequests[1]!.messages;
    const assistantMsg = secondReqMessages.find((m) => m.role === 'assistant')!;
    const toolMsgs = secondReqMessages.filter((m) => m.role === 'tool');
    expect(assistantMsg.tool_calls).toHaveLength(2);
    expect(toolMsgs).toHaveLength(2);
    const idA = assistantMsg.tool_calls![0]!.id;
    const idB = assistantMsg.tool_calls![1]!.id;
    expect(idA).not.toBe(idB);
    expect(toolMsgs[0]!.tool_call_id).toBe(idA);
    expect(toolMsgs[1]!.tool_call_id).toBe(idB);
  });

  it('preserves caller-supplied IDs verbatim (does not over-synthesize)', async () => {
    const recordedRequests: import('./llm-client.js').ChatRequest[] = [];
    const llm = makeStubLLM({
      recordedRequests,
      scriptedResponses: [
        { content: '', tool_calls: [{ id: 'caller-supplied-c1', name: 'echo', args: {} }] },
        { content: 'done' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'ok', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    const secondReqMessages = recordedRequests[1]!.messages;
    const assistantMsg = secondReqMessages.find((m) => m.role === 'assistant')!;
    const toolMsg = secondReqMessages.find((m) => m.role === 'tool')!;
    expect(assistantMsg.tool_calls![0]!.id).toBe('caller-supplied-c1');
    expect(toolMsg.tool_call_id).toBe('caller-supplied-c1');
  });

  it('does not mutate the LLMClient response object (synthesizes a new array)', async () => {
    // Reach into the stub's scripted response and assert its `id`
    // remains undefined after the run — proving we mutated a copy
    // rather than the original (other consumers of llmResult may rely
    // on reading the unmutated payload).
    const original: { id?: string; name: string; args: unknown } = { name: 'echo', args: {} };
    const llm = makeStubLLM({
      scriptedResponses: [{ content: '', tool_calls: [original as never] }, { content: 'done' }],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'ok', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(original.id).toBeUndefined();
  });

  it('serializes the SYNTHESIZED tool_calls into output_tool_calls (not the unsynthesized originals)', async () => {
    // The trace's output_tool_calls field is the structured slot
    // downstream consumers (Langfuse, Workbench) rely on. After
    // synthesis it must reflect the IDs we actually wrote into chat
    // history — not the original undefined ids that would mismatch
    // the tool-result tool_call_id.
    const llm = makeStubLLM({
      scriptedResponses: [
        { content: '', tool_calls: [{ name: 'echo', args: {} } as never] },
        { content: 'done' },
      ],
    });
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'echo', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'ok', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
    });
    const firstLlmTrace = result.traces.find((t) => t.trace_type === 'llm_call');
    expect(firstLlmTrace?.output_tool_calls).toBeDefined();
    const parsed = JSON.parse(firstLlmTrace!.output_tool_calls!) as { id?: string }[];
    expect(parsed[0]?.id).toBeDefined();
    expect((parsed[0]!.id as string).length).toBeGreaterThan(0);
  });
});

describe('AgentExecutor — programmer-error throws', () => {
  it('throws AgentNotFoundError when agent type unknown', async () => {
    const reg = new AgentRegistry<MyType, MyPhase>();
    const llm = makeStubLLM();
    const exec = new AgentExecutor({ registry: reg, llm });
    await expect(
      exec.run({ agentType: 'chat', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/not registered/);
  });

  it('throws NoLLMClientError from constructor when llm absent', () => {
    // @ts-expect-error — deliberately omitting required field to test runtime guard
    expect(() => new AgentExecutor({ registry: buildRegistry() })).toThrow(/LLMClient/);
  });

  it('throws InvalidConfigError when maxIterations is 0', async () => {
    const llm = makeStubLLM();
    const exec = new AgentExecutor({ registry: buildRegistry(), llm });
    await expect(
      exec.run({
        agentType: 'chat',
        messages: [{ role: 'user', content: 'x' }],
        maxIterations: 0,
      }),
    ).rejects.toThrow(/maxIterations/);
  });
});
