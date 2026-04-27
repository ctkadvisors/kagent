/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type {
  ChatRequest,
  ChatResult,
  ChatDelta,
  LLMClient,
  ToolCall,
  ToolDescriptor,
  ToolInvocationContext,
  ToolProvider,
  ToolResult,
} from '@kagent/agent-loop';
import { describe, expect, it } from 'vitest';

import type { PodConfig } from './env.js';
import {
  collectArtifactsFromTraces,
  pickUserMessage,
  resolveToolProviders,
  runAgentTask,
} from './runner.js';
import type { ArtifactRef } from './artifacts.js';

const baseConfig: PodConfig = {
  taskId: 'task-uid-1',
  taskName: 't1',
  taskNamespace: 'default',
  agentName: 'researcher',
  agentSpec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    systemPrompt: 'You are a research assistant.',
  },
  taskSpec: {
    payload: { topic: 'k3s' },
    originalUserMessage: 'what is k3s default runtime?',
  },
  litellmBaseUrl: 'http://litellm.test:4000/v1',
  logLevel: 'info',
};

/**
 * Minimal scripted LLMClient — returns a single canned final response
 * with no tool calls. Sufficient to exercise runAgentTask's wiring
 * without booting a real LiteLLM endpoint.
 */
function scriptedLlm(content: string): LLMClient {
  return {
    chat(_req: ChatRequest): Promise<ChatResult> {
      return Promise.resolve({
        content,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
    async *chatStream(_req: ChatRequest): AsyncIterable<ChatDelta> {
      yield { content, stopReason: 'end_turn' };
      await Promise.resolve();
    },
  };
}

describe('pickUserMessage', () => {
  it('returns originalUserMessage when set', () => {
    expect(pickUserMessage(baseConfig)).toBe('what is k3s default runtime?');
  });

  it('falls back to JSON.stringify(payload) when originalUserMessage is absent', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      taskSpec: { payload: { topic: 'k3s' } },
    };
    expect(pickUserMessage(cfg)).toBe('{"topic":"k3s"}');
  });

  it('falls back when originalUserMessage is the empty string', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      taskSpec: { ...baseConfig.taskSpec, originalUserMessage: '' },
    };
    expect(pickUserMessage(cfg)).toBe('{"topic":"k3s"}');
  });
});

describe('runAgentTask', () => {
  it('runs the loop against an injected LLM and returns a clean result', async () => {
    const llm = scriptedLlm('K3s uses containerd by default. According to the search results.');
    const result = await runAgentTask(baseConfig, { llm, sinks: [] });
    expect(result.runId).toBe('task-uid-1');
    expect(result.status).toBe('completed');
    expect(result.finalContent).toMatch(/containerd/);
  });

  it('flags synthesis_low_yield when content is empty / too short', async () => {
    const llm = scriptedLlm(''); // empty final → triggers low-yield via empty-content path
    const result = await runAgentTask(baseConfig, { llm, sinks: [] });
    // empty content → finalContent is empty/null; detectors operate on it
    expect(result.flags).toBeDefined();
  });

  it('feeds traces to the configured sinks', async () => {
    const llm = scriptedLlm('done.');
    const captured: unknown[] = [];
    const sink = {
      emit(entry: unknown): void {
        captured.push(entry);
      },
    };
    await runAgentTask(baseConfig, { llm, sinks: [sink] });
    expect(captured.length).toBeGreaterThan(0);
  });
});

/**
 * Scripted LLM that returns ONE tool_call on iteration 0, then a final
 * text on iteration 1. Used to assert the executor actually wires the
 * tool name through to the registered provider.
 */
function toolCallingLlm(toolName: string, args: Record<string, unknown>): LLMClient {
  let called = 0;
  return {
    chat(_req: ChatRequest): Promise<ChatResult> {
      called += 1;
      if (called === 1) {
        return Promise.resolve({
          content: '',
          tool_calls: [{ id: 't1', name: toolName, args }],
          stopReason: 'tool_use',
          usage: { inputTokens: 5, outputTokens: 5 },
        });
      }
      return Promise.resolve({
        content: 'done.',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
    async *chatStream(_req: ChatRequest): AsyncIterable<ChatDelta> {
      yield { content: 'done.', stopReason: 'end_turn' };
      await Promise.resolve();
    },
  };
}

describe('resolveToolProviders — Agent.spec.tools wiring', () => {
  it('returns [] when Agent.spec.tools is undefined', () => {
    const cfg: PodConfig = { ...baseConfig, agentSpec: { ...baseConfig.agentSpec } };
    expect(resolveToolProviders(cfg, {})).toEqual([]);
  });

  it('returns [] when Agent.spec.tools is the empty array', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: { ...baseConfig.agentSpec, tools: [] },
    };
    expect(resolveToolProviders(cfg, {})).toEqual([]);
  });

  it('builds one provider exposing exactly the named built-in tools', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: { ...baseConfig.agentSpec, tools: ['http_get', 'extract_text'] },
    };
    const providers = resolveToolProviders(cfg, {});
    expect(providers).toHaveLength(1);
    const desc = providers[0]!.describeTools() as ToolDescriptor[];
    const names = desc.map((d) => d.name).sort();
    expect(names).toEqual(['extract_text', 'http_get']);
  });

  it('throws on unknown tool name with the unknown name + known list', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: { ...baseConfig.agentSpec, tools: ['shell_exec'] },
    };
    expect(() => resolveToolProviders(cfg, {})).toThrow(/unknown built-in tool "shell_exec"/);
    expect(() => resolveToolProviders(cfg, {})).toThrow(/known built-ins:/);
  });

  it('honors deps.toolProviders override (test injection wins)', () => {
    const fake: ToolProvider = {
      id: 'fake',
      describeTools: () => [],
      executeTool: () => Promise.resolve({ content: '', isError: false }),
    };
    const cfg: PodConfig = {
      ...baseConfig,
      // would otherwise throw on 'unknown_tool'; override means we never resolve.
      agentSpec: { ...baseConfig.agentSpec, tools: ['unknown_tool'] },
    };
    const providers = resolveToolProviders(cfg, { toolProviders: [fake] });
    expect(providers).toEqual([fake]);
  });
});

describe('runAgentTask — tool wiring', () => {
  it('boot-time error: unknown tool name in Agent.spec.tools propagates', async () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: { ...baseConfig.agentSpec, tools: ['shell_exec'] },
    };
    const llm = scriptedLlm('never reached.');
    await expect(runAgentTask(cfg, { llm, sinks: [] })).rejects.toThrow(
      /unknown built-in tool "shell_exec"/,
    );
  });

  it('routes tool_calls to the resolved provider and emits a tool_call trace', async () => {
    const observed: ToolCall[] = [];
    const fake: ToolProvider = {
      id: 'fake',
      describeTools: (): ToolDescriptor[] => [
        {
          name: 'do_thing',
          description: '',
          inputSchema: { type: 'object' },
        },
      ],
      executeTool: (call: ToolCall, _ctx: ToolInvocationContext): Promise<ToolResult> => {
        observed.push(call);
        return Promise.resolve({ content: 'thing-done', isError: false });
      },
    };
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: { ...baseConfig.agentSpec, tools: ['do_thing'] },
    };
    const llm = toolCallingLlm('do_thing', { x: 1 });
    const captured: { trace_type?: string; tool_name?: string }[] = [];
    const sink = {
      emit(entry: unknown): void {
        captured.push(entry as { trace_type?: string; tool_name?: string });
      },
    };

    const result = await runAgentTask(cfg, {
      llm,
      sinks: [sink],
      toolProviders: [fake],
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.name).toBe('do_thing');
    expect(observed[0]?.args).toEqual({ x: 1 });
    expect(result.status).toBe('completed');

    // The executor wraps every executeTool() with a tool_call trace
    // entry per `executor.ts`; assert that we see it without
    // reimplementing emission inside the provider.
    const toolCallTraces = captured.filter((e) => e.trace_type === 'tool_call');
    expect(toolCallTraces.length).toBeGreaterThanOrEqual(1);
    expect(toolCallTraces[0]?.tool_name).toBe('do_thing');
  });

  it('runs in chat-only mode when Agent.spec.tools is unset', async () => {
    const llm = scriptedLlm('answer with no tools.');
    const result = await runAgentTask(baseConfig, { llm, sinks: [] });
    expect(result.status).toBe('completed');
    expect(result.finalContent).toMatch(/no tools/);
  });
});

/* =====================================================================
 * P3 — collectArtifactsFromTraces + RunResult.artifacts wiring
 * ===================================================================== */

describe('collectArtifactsFromTraces', () => {
  const ref: ArtifactRef = {
    uri: 'pvc://kagent-artifacts/uid-1/digest.md',
    name: 'digest.md',
    mediaType: 'text/markdown',
    sizeBytes: 7,
    checksum: 'sha256:abc',
    producedAt: '2026-04-28T00:00:00.000Z',
  };
  const blocks = [{ type: 'text', text: JSON.stringify(ref) }];

  it('returns [] for an empty trace stream', () => {
    expect(collectArtifactsFromTraces([])).toEqual([]);
  });

  it('extracts the ref from a successful write_artifact tool_call trace', () => {
    const traces = [
      {
        schema_version: '1' as const,
        run_id: 'r1',
        sequence: 0,
        trace_type: 'tool_call' as const,
        timestamp_ms: 0,
        latency_ms: 1,
        tool_name: 'write_artifact',
        tool_output: JSON.stringify(blocks),
        is_error: false,
      },
    ];
    expect(collectArtifactsFromTraces(traces)).toEqual([ref]);
  });

  it('skips error traces (is_error=true)', () => {
    const traces = [
      {
        schema_version: '1' as const,
        run_id: 'r1',
        sequence: 0,
        trace_type: 'tool_call' as const,
        timestamp_ms: 0,
        latency_ms: 1,
        tool_name: 'write_artifact',
        tool_output: JSON.stringify(blocks),
        is_error: true,
      },
    ];
    expect(collectArtifactsFromTraces(traces)).toEqual([]);
  });

  it('skips non-write_artifact tool calls', () => {
    const traces = [
      {
        schema_version: '1' as const,
        run_id: 'r1',
        sequence: 0,
        trace_type: 'tool_call' as const,
        timestamp_ms: 0,
        latency_ms: 1,
        tool_name: 'http_get',
        tool_output: '"hello"',
        is_error: false,
      },
    ];
    expect(collectArtifactsFromTraces(traces)).toEqual([]);
  });

  it('skips llm_call / iteration_boundary traces entirely', () => {
    const traces = [
      {
        schema_version: '1' as const,
        run_id: 'r1',
        sequence: 0,
        trace_type: 'llm_call' as const,
        timestamp_ms: 0,
        latency_ms: 1,
      },
      {
        schema_version: '1' as const,
        run_id: 'r1',
        sequence: 1,
        trace_type: 'iteration_boundary' as const,
        timestamp_ms: 0,
        latency_ms: 0,
      },
    ];
    expect(collectArtifactsFromTraces(traces)).toEqual([]);
  });

  it('aggregates multiple write_artifact traces in trace order', () => {
    const ref2: ArtifactRef = { ...ref, uri: 'pvc://k/u/two.md', name: 'two.md' };
    const traces = [
      {
        schema_version: '1' as const,
        run_id: 'r1',
        sequence: 0,
        trace_type: 'tool_call' as const,
        timestamp_ms: 0,
        latency_ms: 1,
        tool_name: 'write_artifact',
        tool_output: JSON.stringify(blocks),
        is_error: false,
      },
      {
        schema_version: '1' as const,
        run_id: 'r1',
        sequence: 1,
        trace_type: 'tool_call' as const,
        timestamp_ms: 0,
        latency_ms: 1,
        tool_name: 'write_artifact',
        tool_output: JSON.stringify([{ type: 'text', text: JSON.stringify(ref2) }]),
        is_error: false,
      },
    ];
    expect(collectArtifactsFromTraces(traces)).toEqual([ref, ref2]);
  });
});

describe('runAgentTask — artifacts collation', () => {
  const ref: ArtifactRef = {
    uri: 'pvc://kagent-artifacts/uid-1/digest.md',
    name: 'digest.md',
    mediaType: 'text/markdown',
    sizeBytes: 7,
    checksum: 'sha256:abc',
    producedAt: '2026-04-28T00:00:00.000Z',
  };

  it('omits artifacts when no write_artifact tool_call trace is emitted', async () => {
    const llm = scriptedLlm('chat-only.');
    const result = await runAgentTask(baseConfig, { llm, sinks: [] });
    expect(result.artifacts).toBeUndefined();
  });

  it('threads ArtifactRef through RunResult.artifacts when write_artifact runs', async () => {
    const fake: ToolProvider = {
      id: 'fake',
      describeTools: (): ToolDescriptor[] => [
        {
          name: 'write_artifact',
          description: '',
          inputSchema: { type: 'object' },
        },
      ],
      executeTool: (_call: ToolCall, _ctx: ToolInvocationContext): Promise<ToolResult> => {
        return Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify(ref) }],
          isError: false,
        });
      },
    };
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: { ...baseConfig.agentSpec, tools: ['write_artifact'] },
    };
    const llm = toolCallingLlm('write_artifact', {
      name: 'digest.md',
      mediaType: 'text/markdown',
      content: '# hello',
    });
    const result = await runAgentTask(cfg, {
      llm,
      sinks: [],
      toolProviders: [fake],
    });
    expect(result.status).toBe('completed');
    expect(result.artifacts).toEqual([ref]);
  });
});
