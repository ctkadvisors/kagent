/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `AgentExecutor` context-window safety-net tests (Piece 3 of the v0.1.9
 * context-awareness slate; see docs/CONTEXT-AWARENESS.md §4.5).
 *
 * The executor refuses the next LLM call when cumulative token usage
 * (input + output) reaches `contextSafetyThreshold * contextWindowTokens`
 * (default `0.95`). The refusal surfaces as
 * `LLMClientHttpError(0, 'context_window_substrate_refused: ...')` so the
 * existing 429-retry path (gated to `status === 429`) does not kick in —
 * refusal is terminal and the loop exits with `status='failed'` carrying
 * the structured reason. Last `finalContent` and last tool result are
 * preserved on the way out (existing terminal-state behavior).
 *
 * Strict scope: ONLY the safety-net here. Operator-side env projection
 * (Piece 1), in-pod plumbing + `get_my_context` extension (Piece 2), and
 * the `context_pressure_ignored` detector (Piece 4) live in their own
 * worktrees.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from './registry.js';
import { AgentExecutor } from './executor.js';
import { InvalidConfigError, LLMClientHttpError } from './errors.js';
import type { LLMClient } from './llm-client.js';
import type { MyType, MyPhase } from './__fixtures__/agents.js';
import { chatAgent } from './__fixtures__/agents.js';
import { makeStubLLM } from './__fixtures__/stub-llm.js';
import { makeStubToolProvider } from './__fixtures__/stub-tool-provider.js';

function buildRegistry(): AgentRegistry<MyType, MyPhase> {
  const reg = new AgentRegistry<MyType, MyPhase>();
  reg.register(chatAgent);
  return reg;
}

/** Counting LLM client — wraps a delegate so tests assert exact chat() invocation count. */
function countingLlm(delegate: LLMClient): { llm: LLMClient; calls: () => number } {
  let calls = 0;
  const wrapped: LLMClient = {
    chat: (req, ctx) => {
      calls++;
      return delegate.chat(req, ctx);
    },
    chatStream: (req, ctx) => delegate.chatStream(req, ctx),
  };
  if (delegate.countTokens !== undefined) {
    const ct = delegate.countTokens.bind(delegate);
    wrapped.countTokens = ct;
  }
  return { llm: wrapped, calls: () => calls };
}

describe('AgentExecutor — context-window safety-net (Piece 3)', () => {
  let registry: AgentRegistry<MyType, MyPhase>;
  beforeEach(() => {
    registry = buildRegistry();
  });

  it('refuses the next LLM call at the default 95% threshold (cumulative=950, window=1000)', async () => {
    // First call consumes 950 tokens (input=600, output=350) → 95% of
    // a 1000-token window. The SECOND call must be refused before it
    // reaches the LLM client.
    const inner = makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [{ id: 'c1', name: 'noop', args: {} }],
          usage: { inputTokens: 600, outputTokens: 350 },
        },
        // Should never be reached: the executor's pre-call check fires
        // before the 2nd chat() and aborts the loop.
        { content: 'should-not-be-reached' },
      ],
    });
    const counting = countingLlm(inner);
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'tool-ok', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm: counting.llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      contextWindowTokens: 1000,
    });

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('context_window_substrate_refused');
    expect(result.error?.message).toContain('cumulative=950');
    expect(result.error?.message).toContain('window=1000');
    expect(result.error?.cause).toBeInstanceOf(LLMClientHttpError);
    expect((result.error?.cause as LLMClientHttpError).status).toBe(0);
    // Only one chat() — the second was refused before reaching the client.
    expect(counting.calls()).toBe(1);
  });

  it('does NOT refuse when cumulative is just under threshold (940/1000 at default 0.95)', async () => {
    // First call uses 940 tokens; threshold = 950. Second call proceeds
    // and exits the loop naturally (no tool_call → finalContent set).
    const inner = makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [{ id: 'c1', name: 'noop', args: {} }],
          usage: { inputTokens: 600, outputTokens: 340 },
        },
        {
          content: 'all good',
          usage: { inputTokens: 5, outputTokens: 5 },
        },
      ],
    });
    const counting = countingLlm(inner);
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'tool-ok', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm: counting.llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      contextWindowTokens: 1000,
    });

    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('all good');
    expect(counting.calls()).toBe(2);
  });

  it('honors a custom contextSafetyThreshold (0.5 → refuses at 510/1000)', async () => {
    const inner = makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [{ id: 'c1', name: 'noop', args: {} }],
          usage: { inputTokens: 300, outputTokens: 210 },
        },
        { content: 'should-not-be-reached' },
      ],
    });
    const counting = countingLlm(inner);
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'tool-ok', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm: counting.llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      contextWindowTokens: 1000,
      contextSafetyThreshold: 0.5,
    });

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('context_window_substrate_refused');
    expect(result.error?.message).toContain('threshold=0.5');
    expect(counting.calls()).toBe(1);
  });

  it('threshold validation: contextSafetyThreshold=0 throws InvalidConfigError', async () => {
    const llm = makeStubLLM({ scriptedResponses: [{ content: 'unreached' }] });
    const exec = new AgentExecutor({ registry, llm });
    await expect(
      exec.run({
        agentType: 'chat',
        messages: [{ role: 'user', content: 'hi' }],
        contextWindowTokens: 1000,
        contextSafetyThreshold: 0,
      }),
    ).rejects.toBeInstanceOf(InvalidConfigError);
  });

  it('threshold validation: contextSafetyThreshold>1 throws InvalidConfigError', async () => {
    const llm = makeStubLLM({ scriptedResponses: [{ content: 'unreached' }] });
    const exec = new AgentExecutor({ registry, llm });
    await expect(
      exec.run({
        agentType: 'chat',
        messages: [{ role: 'user', content: 'hi' }],
        contextWindowTokens: 1000,
        contextSafetyThreshold: 1.5,
      }),
    ).rejects.toBeInstanceOf(InvalidConfigError);
  });

  it('threshold validation: negative contextSafetyThreshold throws InvalidConfigError', async () => {
    const llm = makeStubLLM({ scriptedResponses: [{ content: 'unreached' }] });
    const exec = new AgentExecutor({ registry, llm });
    await expect(
      exec.run({
        agentType: 'chat',
        messages: [{ role: 'user', content: 'hi' }],
        contextWindowTokens: 1000,
        contextSafetyThreshold: -0.1,
      }),
    ).rejects.toBeInstanceOf(InvalidConfigError);
  });

  it('threshold validation: contextSafetyThreshold=1 is accepted (boundary, exactly hits at 100%)', async () => {
    // Threshold=1 means refusal fires only when cumulative >= window.
    // With usage that lands well under the window, the loop completes normally.
    const llm = makeStubLLM({
      scriptedResponses: [{ content: 'ok', usage: { inputTokens: 5, outputTokens: 5 } }],
    });
    const exec = new AgentExecutor({ registry, llm });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      contextWindowTokens: 1000,
      contextSafetyThreshold: 1,
    });
    expect(result.status).toBe('completed');
  });

  it('back-compat: when contextWindowTokens unset, no refusal regardless of cumulative', async () => {
    // Cumulative tokens are large but no contextWindowTokens → safety-net is no-op.
    const llm = makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [{ id: 'c1', name: 'noop', args: {} }],
          usage: { inputTokens: 5_000, outputTokens: 5_000 },
        },
        { content: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    });
    const counting = countingLlm(llm);
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'tool-ok', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm: counting.llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      // contextWindowTokens intentionally OMITTED.
    });
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('done');
    expect(counting.calls()).toBe(2);
  });

  it('refusal is NOT a 429 retry: the LLM client is NOT called a second time on refusal', async () => {
    // Even with retryPolicy enabled, the substrate-refused throw uses
    // status=0 and the run loop's catch arm fails terminally without
    // retry. A counting LLM proves the second chat() never happens.
    const recordedSleeps: number[] = [];
    const inner = makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [{ id: 'c1', name: 'noop', args: {} }],
          usage: { inputTokens: 700, outputTokens: 300 },
        },
        { content: 'should-not-be-reached' },
      ],
    });
    const counting = countingLlm(inner);
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'noop', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'tool-ok', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({
      registry,
      llm: counting.llm,
      toolProviders: tools,
      retryPolicy: {
        maxRetries: 3,
        backoffSchedule: [10, 20, 40],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      contextWindowTokens: 1000, // 1000 cumulative >= 0.95 * 1000
    });
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('context_window_substrate_refused');
    expect(counting.calls()).toBe(1);
    // The retry path (which would sleep before retrying) MUST NOT run.
    expect(recordedSleeps).toEqual([]);
  });

  it('terminal state preservation: last successful finalContent + tool result preserved on refusal', async () => {
    // Sequence:
    //   iter 0: LLM returns content='step1' AND a tool_call (pushes 950 tokens cumulative).
    //   iter 1: pre-call check fires; refusal terminates the loop.
    // Verify:
    //   - final tool result trace is in result.traces (last tool_call entry's content).
    //   - The most recent assistant message went into chat history (visible
    //     via the trace stream) and the executor preserved the iteration-0
    //     llm_call output.
    const inner = makeStubLLM({
      scriptedResponses: [
        {
          content: 'partial-progress',
          tool_calls: [{ id: 'c1', name: 'lookup', args: { q: 'x' } }],
          usage: { inputTokens: 500, outputTokens: 450 },
        },
        { content: 'should-not-be-reached' },
      ],
    });
    const counting = countingLlm(inner);
    const tools = [
      makeStubToolProvider({
        id: 'p1',
        tools: [{ name: 'lookup', description: '', inputSchema: {} }],
        onCall: () => ({ content: 'lookup-result-payload', isError: false }),
      }),
    ];
    const exec = new AgentExecutor({ registry, llm: counting.llm, toolProviders: tools });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      contextWindowTokens: 1000,
    });
    expect(result.status).toBe('failed');
    expect(counting.calls()).toBe(1);

    // Last successful llm_call trace carries the partial content.
    const llmCalls = result.traces.filter((t) => t.trace_type === 'llm_call');
    // First entry is the iter-0 success; the second is the failure trace
    // emitted by the run-loop catch arm.
    expect(llmCalls.length).toBeGreaterThanOrEqual(2);
    expect(llmCalls[0]?.output_content).toContain('partial-progress');

    // Tool call trace from iter-0 is preserved.
    const toolCalls = result.traces.filter((t) => t.trace_type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.tool_output).toBe('lookup-result-payload');
  });

  it('budget.contextWindowTokens is plumbed onto the returned RunBudget', async () => {
    const llm = makeStubLLM({
      scriptedResponses: [{ content: 'ok', usage: { inputTokens: 5, outputTokens: 5 } }],
    });
    const exec = new AgentExecutor({ registry, llm });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      contextWindowTokens: 1234,
    });
    expect(result.budget.contextWindowTokens).toBe(1234);
  });
});
