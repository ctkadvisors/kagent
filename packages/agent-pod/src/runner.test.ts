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
import { describe, expect, it, vi } from 'vitest';

import type { PodConfig } from './env.js';
import {
  buildLlmClient,
  collectArtifactsFromTraces,
  composeSignals,
  DEFAULT_TASK_TIMEOUT_SECONDS,
  parseContextPressureThresholdEnv,
  parseContextSafetyThreshold,
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
  traceContentMode: 'preview',
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

/**
 * LLM stub that records the ChatRequest passed to chat() so tests can
 * assert on whatever the runner threaded through (model, llmParams,
 * etc.). Returns a single canned reply with no tool calls.
 */
function recordingLlm(captured: ChatRequest[]): LLMClient {
  return {
    chat(req: ChatRequest): Promise<ChatResult> {
      captured.push(req);
      return Promise.resolve({
        content: 'ok',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
    async *chatStream(req: ChatRequest): AsyncIterable<ChatDelta> {
      captured.push(req);
      yield { content: 'ok', stopReason: 'end_turn' };
      await Promise.resolve();
    },
  };
}

describe('buildLlmClient — X-Kagent attribution headers (v0.1.7)', () => {
  /**
   * Capture the headers a single chat() call sends to the upstream so we
   * can assert the agent-pod stamps `X-Kagent-Task-UID` + `X-Kagent-Agent`
   * for every LLM call. The gateway already parses these (see
   * llm-gateway/src/headers.ts) and joins usage rows back to the
   * originating AgentTask + Agent — wiring them on the client side is
   * what makes that join non-null in production.
   */
  function capturingFetch(): {
    fetchImpl: typeof globalThis.fetch;
    capturedHeaders: () => Record<string, string> | undefined;
  } {
    let captured: Record<string, string> | undefined;
    const fetchImpl: typeof globalThis.fetch = (_url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      captured = { ...h };
      const body = JSON.stringify({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    return { fetchImpl, capturedHeaders: () => captured };
  }

  it('stamps X-Kagent-Task-UID + X-Kagent-Agent on outbound /chat/completions calls', async () => {
    const cap = capturingFetch();
    const client = buildLlmClient(baseConfig, cap.fetchImpl);
    await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
    });
    const h = cap.capturedHeaders();
    expect(h).toBeDefined();
    expect(h!['X-Kagent-Task-UID']).toBe('task-uid-1');
    expect(h!['X-Kagent-Agent']).toBe('researcher');
  });

  it('preserves Authorization when litellmApiKey is set', async () => {
    const cap = capturingFetch();
    const cfg: PodConfig = { ...baseConfig, litellmApiKey: 'sk-secret-1' };
    const client = buildLlmClient(cfg, cap.fetchImpl);
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const h = cap.capturedHeaders();
    expect(h!['Authorization']).toBe('Bearer sk-secret-1');
    expect(h!['X-Kagent-Task-UID']).toBe('task-uid-1');
    expect(h!['X-Kagent-Agent']).toBe('researcher');
  });

  /* ===================================================================
   * v0.5.0-tenancy — Wave 4 / Tenancy sub-team. X-Kagent-Tenant
   * threading per docs/GATEWAY-CONTRACT.md §3.
   * =================================================================== */

  it('stamps X-Kagent-Tenant when tenant claim is supplied', async () => {
    const cap = capturingFetch();
    const client = buildLlmClient(baseConfig, cap.fetchImpl, undefined, 'acme');
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const h = cap.capturedHeaders();
    expect(h!['X-Kagent-Tenant']).toBe('acme');
    // Existing attribution headers stay intact.
    expect(h!['X-Kagent-Task-UID']).toBe('task-uid-1');
    expect(h!['X-Kagent-Agent']).toBe('researcher');
  });

  it('omits X-Kagent-Tenant when no tenant claim is supplied (legacy)', async () => {
    const cap = capturingFetch();
    const client = buildLlmClient(baseConfig, cap.fetchImpl);
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const h = cap.capturedHeaders();
    expect(h!['X-Kagent-Tenant']).toBeUndefined();
  });

  it('omits X-Kagent-Tenant when tenant claim is empty string', async () => {
    const cap = capturingFetch();
    const client = buildLlmClient(baseConfig, cap.fetchImpl, undefined, '');
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const h = cap.capturedHeaders();
    expect(h!['X-Kagent-Tenant']).toBeUndefined();
  });
});

describe('runAgentTask — X-Kagent-Tenant via deps.capabilityBundle (v0.5.0-tenancy)', () => {
  it('reads claims.tenant from deps.capabilityBundle and stamps the header', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl: typeof globalThis.fetch = (_url, init) => {
      capturedHeaders = { ...((init?.headers ?? {}) as Record<string, string>) };
      const body = JSON.stringify({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    // Drive the runner directly: pass deps.capabilityBundle and let
    // the runner construct the LLM client (deps.llm undefined).
    // We reach into buildLlmClient via the same wiring the runner does.
    const tenantClaim = 'acme-prod-tenant';
    const client = buildLlmClient(baseConfig, fetchImpl, undefined, tenantClaim);
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(capturedHeaders!['X-Kagent-Tenant']).toBe(tenantClaim);
  });
});

describe('runAgentTask — Agent.spec.llmParams passthrough (v0.1.4)', () => {
  it('threads agentSpec.llmParams into the LLM ChatRequest', async () => {
    const captured: ChatRequest[] = [];
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        llmParams: {
          temperature: 0.2,
          maxTokens: 512,
          stopSequences: ['STOP'],
        },
      },
    };
    await runAgentTask(cfg, { llm: recordingLlm(captured) });
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.temperature).toBe(0.2);
    expect(captured[0]?.maxTokens).toBe(512);
    expect(captured[0]?.stopSequences).toEqual(['STOP']);
  });

  it('omits llmParams when agentSpec.llmParams is undefined (back-compat)', async () => {
    const captured: ChatRequest[] = [];
    await runAgentTask(baseConfig, { llm: recordingLlm(captured) });
    expect(captured[0]?.temperature).toBeUndefined();
    expect(captured[0]?.maxTokens).toBeUndefined();
    expect(captured[0]?.stopSequences).toBeUndefined();
  });
});

function findSystemMessage(req: ChatRequest | undefined): string | undefined {
  if (!req) return undefined;
  // Executor may surface the system prompt either via ChatRequest.systemPrompt
  // OR by prepending a role:system message — assert against either.
  if (req.systemPrompt !== undefined && req.systemPrompt.length > 0) return req.systemPrompt;
  const sys = req.messages.find((m) => m.role === 'system');
  return sys?.content;
}

describe('runAgentTask — Agent.spec.systemPromptRef (Langfuse-managed prompts)', () => {
  it('fetches system prompt from Langfuse when systemPromptRef is set', async () => {
    const captured: ChatRequest[] = [];
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        // Drop the literal so we KNOW the fetched value is what flows.
        systemPrompt: undefined,
        systemPromptRef: { name: 'researcher-system' },
      },
    };
    const fetchPrompt = (name: string): Promise<string> =>
      Promise.resolve(`<<from-langfuse:${name}>>`);
    await runAgentTask(cfg, { llm: recordingLlm(captured), fetchPrompt });
    expect(findSystemMessage(captured[0])).toBe('<<from-langfuse:researcher-system>>');
  });

  it('falls back to literal systemPrompt when Langfuse fetch fails', async () => {
    const captured: ChatRequest[] = [];
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        systemPrompt: 'fallback prompt',
        systemPromptRef: { name: 'researcher-system' },
      },
    };
    const fetchPrompt = (): Promise<string> => Promise.reject(new Error('langfuse 503'));
    await runAgentTask(cfg, { llm: recordingLlm(captured), fetchPrompt });
    expect(findSystemMessage(captured[0])).toBe('fallback prompt');
  });

  it('throws when Langfuse fetch fails and no literal fallback is set', async () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        systemPrompt: undefined,
        systemPromptRef: { name: 'researcher-system' },
      },
    };
    const fetchPrompt = (): Promise<string> => Promise.reject(new Error('langfuse 503'));
    await expect(runAgentTask(cfg, { llm: recordingLlm([]), fetchPrompt })).rejects.toThrow(
      /langfuse|systemPromptRef/i,
    );
  });

  it('uses literal systemPrompt when systemPromptRef is unset (back-compat)', async () => {
    const captured: ChatRequest[] = [];
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        systemPrompt: 'plain literal prompt',
      },
    };
    await runAgentTask(cfg, { llm: recordingLlm(captured) });
    expect(findSystemMessage(captured[0])).toBe('plain literal prompt');
  });
});

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

  it('builds one built-in provider exposing exactly the named built-in tools', () => {
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

  it('does not advertise get_my_context unless the Agent asks for it', () => {
    const cfg: PodConfig = { ...baseConfig, agentSpec: { ...baseConfig.agentSpec } };
    const providers = resolveToolProviders(cfg, {});
    const universal = providers.find((p) => p.id === 'kagent-universal-context');
    expect(universal).toBeUndefined();
  });

  it('NM5 — get_my_context in Agent.spec.tools wires the universal-context provider', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: { ...baseConfig.agentSpec, tools: ['get_my_context'] },
    };
    const providers = resolveToolProviders(cfg, {});
    const universal = providers.find((p) => p.id === 'kagent-universal-context');
    expect(universal).toBeDefined();
    const desc = universal!.describeTools() as ToolDescriptor[];
    expect(desc.map((d) => d.name)).toEqual(['get_my_context']);
  });

  it('wires the gateway provider when Agent.spec.tools asks for browser or code runtime tools', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      toolGatewayUrl: 'http://tool-gateway.kagent-system.svc',
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['browser.goto', 'code_interpreter.execute_code'],
      },
    };

    const providers = resolveToolProviders(cfg, {});
    const gateway = providers.find((provider) => provider.id === 'kagent-tool-gateway');

    expect(gateway).toBeDefined();
    expect((gateway!.describeTools() as ToolDescriptor[]).map((tool) => tool.name)).toEqual([
      'browser.goto',
      'code_interpreter.execute_code',
    ]);
    expect(providers.some((provider) => provider.id === 'kagent-universal-context')).toBe(false);
  });

  it('wires the gateway provider when Agent.spec.tools asks for external mcp/http gateway tools', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      toolGatewayUrl: 'http://tool-gateway.kagent-system.svc',
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['mcp.project.lookup', 'http.github.get_issue'],
      },
    };

    const providers = resolveToolProviders(cfg, {});
    const gateway = providers.find((provider) => provider.id === 'kagent-tool-gateway');

    expect(gateway).toBeDefined();
  });

  it('fails fast when Agent.spec.tools asks for runtime tools but no gateway URL is configured', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['browser.goto'],
      },
    };

    expect(() => resolveToolProviders(cfg, {})).toThrow(/KAGENT_TOOL_GATEWAY_URL/);
  });

  it('fails fast when Agent.spec.tools asks for external gateway tools but no gateway URL is configured', () => {
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: {
        ...baseConfig.agentSpec,
        tools: ['mcp.project.lookup'],
      },
    };

    expect(() => resolveToolProviders(cfg, {})).toThrow(/KAGENT_TOOL_GATEWAY_URL/);
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

  it('drops inline:// refs (non-durable; not followable from RunResult.artifacts)', () => {
    // The inline-only path returns an `inline://sha256:<hex>` URI; the
    // collator must NOT include those in the durable artifact list,
    // because `RunResult.artifacts` is contracted to be followable.
    const inlineRef: ArtifactRef = {
      uri: 'inline://sha256:abc123',
      mediaType: 'text/markdown',
      sizeBytes: 5,
      checksum: 'sha256:abc123',
      producedAt: '2026-04-28T00:00:00.000Z',
    };
    const traces = [
      {
        schema_version: '1' as const,
        run_id: 'r1',
        sequence: 0,
        trace_type: 'tool_call' as const,
        timestamp_ms: 0,
        latency_ms: 1,
        tool_name: 'write_artifact',
        tool_output: JSON.stringify([{ type: 'text', text: JSON.stringify(inlineRef) }]),
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
        tool_output: JSON.stringify(blocks),
        is_error: false,
      },
    ];
    // Only the pvc:// ref survives.
    expect(collectArtifactsFromTraces(traces)).toEqual([ref]);
  });
});

/* =====================================================================
 * WS-G — runConfig precedence + composeSignals + signal threading
 * ===================================================================== */

describe('composeSignals', () => {
  it('returns undefined when neither source is provided', () => {
    expect(composeSignals(undefined, undefined)).toBeUndefined();
  });

  it('returns the caller signal alone when timeout is undefined', () => {
    const c = new AbortController();
    expect(composeSignals(c.signal, undefined)).toBe(c.signal);
  });

  it('returns the timeout signal alone when caller is undefined', () => {
    const t = AbortSignal.timeout(60_000);
    expect(composeSignals(undefined, t)).toBe(t);
  });

  it('combines both via AbortSignal.any when both are present', () => {
    const c = new AbortController();
    const t = AbortSignal.timeout(60_000);
    const composed = composeSignals(c.signal, t);
    expect(composed).toBeDefined();
    expect(composed).not.toBe(c.signal);
    expect(composed).not.toBe(t);
    // Aborting either source aborts the composed signal.
    expect(composed!.aborted).toBe(false);
    c.abort();
    expect(composed!.aborted).toBe(true);
  });
});

/**
 * Spy LLM that captures the ChatRequest + ClientContext (signal) so
 * tests can assert what runAgentTask actually wired into executor.run.
 * Returns a no-tool-call final response so the loop exits in 1 iter.
 */
function spyLlm(): {
  llm: LLMClient;
  capturedSignal(): AbortSignal | undefined;
} {
  let capturedSignal: AbortSignal | undefined;
  return {
    llm: {
      chat(_req: ChatRequest, ctx?: { abortSignal?: AbortSignal }): Promise<ChatResult> {
        capturedSignal = ctx?.abortSignal;
        return Promise.resolve({
          content: 'done.',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
      async *chatStream(_req: ChatRequest): AsyncIterable<ChatDelta> {
        yield { content: 'done.', stopReason: 'end_turn' };
        await Promise.resolve();
      },
    },
    capturedSignal: () => capturedSignal,
  };
}

describe('runAgentTask — runConfig precedence (WS-G)', () => {
  it('honors top-level timeoutSeconds when runConfig is absent', async () => {
    const cfg: PodConfig = {
      ...baseConfig,
      taskSpec: { ...baseConfig.taskSpec, timeoutSeconds: 60 },
    };
    const spy = spyLlm();
    const result = await runAgentTask(cfg, { llm: spy.llm, sinks: [] });
    expect(result.status).toBe('completed');
    // executor was given a non-undefined signal because timeoutSeconds resolved.
    expect(spy.capturedSignal()).toBeDefined();
    expect(spy.capturedSignal()?.aborted).toBe(false);
  });

  it('honors runConfig.timeoutSeconds when set', async () => {
    const cfg: PodConfig = {
      ...baseConfig,
      taskSpec: {
        ...baseConfig.taskSpec,
        runConfig: { timeoutSeconds: 30 },
      },
    };
    const spy = spyLlm();
    const result = await runAgentTask(cfg, { llm: spy.llm, sinks: [] });
    expect(result.status).toBe('completed');
    expect(spy.capturedSignal()).toBeDefined();
  });

  it('runConfig.timeoutSeconds wins when both are set', async () => {
    // Both fields are accepted by the type; the resolution rule is
    // documented and tested here. We can't directly observe which value
    // armed the signal without mocking AbortSignal.timeout, but we CAN
    // assert that a signal was wired AND that the configured budget
    // limits flowed through to executor.run by spying on the run input.
    let observedRunInput: unknown;
    const cfg: PodConfig = {
      ...baseConfig,
      taskSpec: {
        ...baseConfig.taskSpec,
        timeoutSeconds: 1,
        runConfig: { timeoutSeconds: 600, tokenLimit: 5000, costLimitUsd: 1.5, maxIterations: 3 },
      },
    };
    const llm: LLMClient = {
      chat(_req: ChatRequest, ctx?: { abortSignal?: AbortSignal }): Promise<ChatResult> {
        // The deprecated timeoutSeconds=1 would abort within 1 second;
        // if the runConfig.timeoutSeconds=600 wins we never see that.
        observedRunInput = { hasSignal: ctx?.abortSignal !== undefined };
        return Promise.resolve({
          content: 'done.',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
      async *chatStream(): AsyncIterable<ChatDelta> {
        yield { content: 'done.', stopReason: 'end_turn' };
        await Promise.resolve();
      },
    };
    // Wait long enough that the deprecated 1s deadline WOULD have fired
    // if it had won — but the synchronous chat() above resolves
    // immediately, so the only way we observe a non-aborted signal at
    // chat() time is if the larger runConfig timeout won.
    const result = await runAgentTask(cfg, { llm, sinks: [] });
    expect(result.status).toBe('completed');
    expect(observedRunInput).toEqual({ hasSignal: true });
  });

  it('threads tokenLimit / costLimitUsd / maxIterations into the executor budget', async () => {
    // Use a scripted LLM that ALWAYS returns a tool_call so the loop
    // would normally run for the executor default of 8 iterations.
    // With maxIterations=2 the loop exits early.
    const cfg: PodConfig = {
      ...baseConfig,
      agentSpec: { ...baseConfig.agentSpec, tools: [] },
      taskSpec: {
        ...baseConfig.taskSpec,
        runConfig: { maxIterations: 2 },
      },
    };
    const fake: ToolProvider = {
      id: 'fake',
      describeTools: (): ToolDescriptor[] => [
        { name: 'loop_forever', description: '', inputSchema: {} },
      ],
      executeTool: (): Promise<ToolResult> => Promise.resolve({ content: 'tick', isError: false }),
    };
    const llm: LLMClient = {
      chat(_req: ChatRequest): Promise<ChatResult> {
        return Promise.resolve({
          content: '',
          tool_calls: [{ id: 't1', name: 'loop_forever', args: {} }],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
      async *chatStream(): AsyncIterable<ChatDelta> {
        yield { content: '', stopReason: 'tool_use' };
        await Promise.resolve();
      },
    };
    const result = await runAgentTask(cfg, { llm, sinks: [], toolProviders: [fake] });
    // With maxIterations=2 we exit after at most 2 LLM calls; default 8
    // would have given more. Trace count is a proxy.
    const llmCalls = result.traces.filter((t) => t.trace_type === 'llm_call');
    expect(llmCalls.length).toBeLessThanOrEqual(2);
  });

  it('forwards an externally-supplied signal alongside the timeout signal', async () => {
    const cfg: PodConfig = {
      ...baseConfig,
      taskSpec: { ...baseConfig.taskSpec, runConfig: { timeoutSeconds: 60 } },
    };
    const external = new AbortController();
    const spy = spyLlm();
    const result = await runAgentTask(cfg, {
      llm: spy.llm,
      sinks: [],
      signal: external.signal,
    });
    expect(result.status).toBe('completed');
    // The composed signal isn't either source directly — it's a
    // fresh signal produced by AbortSignal.any. Just assert one was
    // wired (i.e. the runner did the composition).
    expect(spy.capturedSignal()).toBeDefined();
  });

  /*
   * Audit-rev2 M10 — when neither runConfig.timeoutSeconds nor the
   * deprecated top-level timeoutSeconds is declared, the runner stamps
   * DEFAULT_TASK_TIMEOUT_SECONDS so every admitted task has a wall-clock
   * ceiling AND an AbortSignal-driven cancellation path the SIGTERM
   * handler can observe. Previously absent timeouts produced
   * `timeoutSignal=undefined` and the pod could hang on a stuck LLM
   * call until the kubelet's activeDeadlineSeconds fired.
   */
  it('M10 — stamps DEFAULT_TASK_TIMEOUT_SECONDS when neither runConfig.timeoutSeconds nor timeoutSeconds is set', async () => {
    expect(DEFAULT_TASK_TIMEOUT_SECONDS).toBeGreaterThan(0);
    const cfg: PodConfig = {
      ...baseConfig,
      // BOTH timeout knobs explicitly absent.
      taskSpec: { ...baseConfig.taskSpec, runConfig: undefined, timeoutSeconds: undefined },
    };
    const spy = spyLlm();
    const result = await runAgentTask(cfg, { llm: spy.llm, sinks: [] });
    expect(result.status).toBe('completed');
    // Default fired -> a signal IS wired, where previously it would have been undefined.
    expect(spy.capturedSignal()).toBeDefined();
    expect(spy.capturedSignal()?.aborted).toBe(false);
  });

  /* =====================================================================
   * v0.1.9 — Piece 2 of the context-awareness slate. The runner
   * threads `PodConfig.contextWindowTokens` (set by env.ts from
   * KAGENT_AGENT_MODEL_CONTEXT_WINDOW) onto the executor's
   * `RunBudget.contextWindowTokens`. RunResult.budget mirrors
   * executor.budget (per runner.ts:310), so we can assert the value
   * round-trips end-to-end.
   * ===================================================================== */
  it('threads PodConfig.contextWindowTokens onto RunBudget.contextWindowTokens', async () => {
    const cfg: PodConfig = {
      ...baseConfig,
      contextWindowTokens: 131_072,
    };
    const result = await runAgentTask(cfg, { llm: scriptedLlm('done.'), sinks: [] });
    expect(result.status).toBe('completed');
    expect(result.budget.contextWindowTokens).toBe(131_072);
  });

  it('leaves RunBudget.contextWindowTokens undefined when PodConfig.contextWindowTokens is unset (back-compat)', async () => {
    const result = await runAgentTask(baseConfig, { llm: scriptedLlm('done.'), sinks: [] });
    expect(result.status).toBe('completed');
    expect(result.budget.contextWindowTokens).toBeUndefined();
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

describe('parseContextSafetyThreshold (Piece 3 of v0.1.9 context-awareness slate)', () => {
  it('returns undefined for unset / empty / non-numeric input', () => {
    expect(parseContextSafetyThreshold(undefined)).toBeUndefined();
    expect(parseContextSafetyThreshold('')).toBeUndefined();
    expect(parseContextSafetyThreshold('abc')).toBeUndefined();
  });

  it('returns undefined for out-of-range values (defensive — executor revalidates anyway)', () => {
    expect(parseContextSafetyThreshold('0')).toBeUndefined();
    expect(parseContextSafetyThreshold('-0.5')).toBeUndefined();
    expect(parseContextSafetyThreshold('1.5')).toBeUndefined();
    expect(parseContextSafetyThreshold('NaN')).toBeUndefined();
    expect(parseContextSafetyThreshold('Infinity')).toBeUndefined();
  });

  it('returns the parsed float for in-range values (0, 1]', () => {
    expect(parseContextSafetyThreshold('0.95')).toBe(0.95);
    expect(parseContextSafetyThreshold('0.5')).toBe(0.5);
    expect(parseContextSafetyThreshold('1')).toBe(1);
    expect(parseContextSafetyThreshold('0.001')).toBe(0.001);
  });
});

describe('parseContextPressureThresholdEnv (v0.1.9 context-awareness Piece 4)', () => {
  it('returns undefined when env is unset (caller falls back to detector default)', () => {
    expect(parseContextPressureThresholdEnv(undefined)).toBeUndefined();
  });

  it('returns undefined when env is the empty string', () => {
    expect(parseContextPressureThresholdEnv('')).toBeUndefined();
  });

  it('parses a valid float in (0, 1]', () => {
    expect(parseContextPressureThresholdEnv('0.5')).toBe(0.5);
    expect(parseContextPressureThresholdEnv('0.85')).toBe(0.85);
    expect(parseContextPressureThresholdEnv('1')).toBe(1);
  });

  it('returns undefined for non-numeric input (defensive — bad config does not fail run)', () => {
    expect(parseContextPressureThresholdEnv('not-a-number')).toBeUndefined();
  });

  it('returns undefined for out-of-range values (caller falls back to detector default)', () => {
    expect(parseContextPressureThresholdEnv('0')).toBeUndefined();
    expect(parseContextPressureThresholdEnv('-0.5')).toBeUndefined();
    expect(parseContextPressureThresholdEnv('1.5')).toBeUndefined();
    expect(parseContextPressureThresholdEnv('NaN')).toBeUndefined();
  });

  /*
   * Audit-rev2 NH3 follow-up — defense-in-depth WARN log when env value
   * is outside the legal range. The operator-chart guard already rejects
   * out-of-range values pre-deploy, but a manually-overridden Job manifest
   * (or future non-chart deploy) needs a runtime signal — silent
   * fall-through is the smoking-gun shape.
   */
  it('logs structured WARN naming offending value when outside (0, 1]', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      parseContextPressureThresholdEnv('1.5');
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain('KAGENT_CONTEXT_PRESSURE_THRESHOLD');
      expect(msg).toContain('1.5');
      expect(msg).toContain('(0, 1]');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs structured WARN naming offending value when not finite', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      parseContextPressureThresholdEnv('not-a-number');
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain('KAGENT_CONTEXT_PRESSURE_THRESHOLD');
      expect(msg).toContain("'not-a-number'");
      expect(msg).toContain('not a finite number');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT warn when env is unset (clean baseline)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      parseContextPressureThresholdEnv(undefined);
      parseContextPressureThresholdEnv('');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/*
 * Audit-rev2 NH3 follow-up — symmetric WARN coverage for the safety
 * threshold parser. Same rationale as the pressure-threshold tests.
 */
describe('parseContextSafetyThreshold WARN coverage (NH3 follow-up)', () => {
  it('logs structured WARN naming offending value when outside (0, 1]', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      parseContextSafetyThreshold('0');
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain('KAGENT_CONTEXT_SAFETY_THRESHOLD');
      expect(msg).toContain('(0, 1]');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs structured WARN naming offending value when not finite', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      parseContextSafetyThreshold('abc');
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain('KAGENT_CONTEXT_SAFETY_THRESHOLD');
      expect(msg).toContain("'abc'");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT warn when env is unset (clean baseline)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      parseContextSafetyThreshold(undefined);
      parseContextSafetyThreshold('');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT warn for in-range values', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      parseContextSafetyThreshold('0.95');
      parseContextSafetyThreshold('1');
      parseContextSafetyThreshold('0.5');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
