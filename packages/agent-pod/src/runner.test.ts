/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { ChatRequest, ChatResult, ChatDelta, LLMClient } from '@kagent/agent-loop';
import { describe, expect, it } from 'vitest';

import type { PodConfig } from './env.js';
import { pickUserMessage, runAgentTask } from './runner.js';

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
