/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { ToolInvocationContext } from '@kagent/agent-loop';
import { describe, expect, it, vi } from 'vitest';

import { ToolGatewayProvider } from './tool-gateway-provider.js';

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(responses: readonly Response[]): {
  readonly calls: CapturedRequest[];
  readonly fetch: typeof fetch;
} {
  const calls: CapturedRequest[] = [];
  const queue = [...responses];
  const fakeFetch = vi.fn(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: requestUrl(input), init });
      const response = queue.shift();
      if (response === undefined) throw new Error('unexpected fetch call');
      return Promise.resolve(response);
    },
  ) as unknown as typeof fetch;

  return { calls, fetch: fakeFetch };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function ctx(signal = new AbortController().signal): ToolInvocationContext {
  return { runId: 'run-1', abortSignal: signal };
}

describe('ToolGatewayProvider', () => {
  it('describes only requested browser and code interpreter tools', () => {
    const provider = new ToolGatewayProvider({
      baseUrl: 'http://tool-gateway.kagent-system.svc',
      task: {
        tenant: 'homelab',
        namespace: 'kagent-draft',
        taskUid: 'task-1',
        agentName: 'agent',
      },
      tools: ['browser.goto', 'code_interpreter.execute_code'],
    });

    expect(provider.id).toBe('kagent-tool-gateway');
    expect(provider.describeTools().map((tool) => tool.name)).toEqual([
      'browser.goto',
      'code_interpreter.execute_code',
    ]);
  });

  it('forwards tool calls to the gateway with task ownership metadata and abort signal', async () => {
    const controller = new AbortController();
    const { calls, fetch } = makeFetch([
      makeJsonResponse({
        content: 'navigated',
        isError: false,
        metadata: { sessionId: 'browser-1' },
      }),
    ]);
    const provider = new ToolGatewayProvider({
      baseUrl: 'http://tool-gateway.kagent-system.svc/',
      fetch,
      task: {
        tenant: 'homelab',
        namespace: 'kagent-draft',
        taskUid: 'task-1',
        agentName: 'agent',
      },
      tools: ['browser.goto'],
    });

    const result = await provider.executeTool(
      { id: 'call-1', name: 'browser.goto', args: { url: 'https://example.com' } },
      ctx(controller.signal),
    );

    expect(result).toEqual({
      content: 'navigated',
      isError: false,
      metadata: { sessionId: 'browser-1' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://tool-gateway.kagent-system.svc/v1/tool-runtime/invoke');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(calls[0]?.init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-kagent-agent': 'agent',
      'x-kagent-namespace': 'kagent-draft',
      'x-kagent-task-uid': 'task-1',
      'x-kagent-tenant': 'homelab',
    });
    const body = calls[0]?.init?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toEqual({
      task: {
        tenant: 'homelab',
        namespace: 'kagent-draft',
        taskUid: 'task-1',
        agentName: 'agent',
      },
      call: {
        id: 'call-1',
        name: 'browser.goto',
        args: { url: 'https://example.com' },
      },
    });
  });

  it('turns non-2xx gateway responses into tool errors instead of throwing', async () => {
    const { fetch } = makeFetch([makeJsonResponse({ error: 'tool_runtime_paused' }, 503)]);
    const provider = new ToolGatewayProvider({
      baseUrl: 'http://tool-gateway.kagent-system.svc',
      fetch,
      task: {
        tenant: 'homelab',
        namespace: 'kagent-draft',
        taskUid: 'task-1',
        agentName: 'agent',
      },
      tools: ['code_interpreter.execute_code'],
    });

    await expect(
      provider.executeTool(
        { id: 'call-1', name: 'code_interpreter.execute_code', args: { code: 'print(1)' } },
        ctx(),
      ),
    ).resolves.toEqual({
      content: 'Gateway 503: tool_runtime_paused',
      isError: true,
      metadata: { status: 503 },
    });
  });

  it('rejects tool calls that were not granted to this Agent', async () => {
    const provider = new ToolGatewayProvider({
      baseUrl: 'http://tool-gateway.kagent-system.svc',
      task: {
        tenant: 'homelab',
        namespace: 'kagent-draft',
        taskUid: 'task-1',
        agentName: 'agent',
      },
      tools: ['browser.goto'],
    });

    await expect(
      provider.executeTool({ id: 'call-1', name: 'browser.screenshot', args: {} }, ctx()),
    ).resolves.toEqual({
      content: 'policy_denied: tool "browser.screenshot" was not granted to this Agent',
      isError: true,
      metadata: { policy: 'tool-not-granted' },
    });
  });
});
