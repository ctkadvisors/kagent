/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { ToolDescriptor, ToolInvocationContext } from '@kagent/agent-loop';
import { describe, expect, it, vi } from 'vitest';

import { requestedGatewayToolNames, ToolGatewayProvider } from './tool-gateway-provider.js';

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

function syncDescriptors(value: ToolDescriptor[] | Promise<ToolDescriptor[]>): ToolDescriptor[] {
  if (value instanceof Promise) throw new Error('expected synchronous descriptor list');
  return value;
}

function parsedRequestBody(call: CapturedRequest | undefined): Record<string, unknown> {
  const body = call?.init?.body;
  if (typeof body !== 'string') throw new Error('expected string request body');
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected object request body');
  }
  return parsed as Record<string, unknown>;
}

describe('ToolGatewayProvider', () => {
  it('recognizes runtime plus mcp/http gateway tool names', () => {
    expect(
      requestedGatewayToolNames([
        'browser.goto',
        'code_interpreter.execute_code',
        'mcp.project.lookup',
        'http.github.get_issue',
        'extract_text',
      ]),
    ).toEqual([
      'browser.goto',
      'code_interpreter.execute_code',
      'mcp.project.lookup',
      'http.github.get_issue',
    ]);
  });

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
    expect(syncDescriptors(provider.describeTools()).map((tool) => tool.name)).toEqual([
      'browser.goto',
      'code_interpreter.execute_code',
    ]);
  });

  it('fetches external mcp/http tool descriptors from the gateway describe endpoint', async () => {
    const { calls, fetch } = makeFetch([
      makeJsonResponse({
        tools: [
          {
            name: 'mcp.project.lookup',
            description: 'Look up project metadata from an MCP server.',
            inputSchema: { type: 'object', properties: { project: { type: 'string' } } },
          },
        ],
      }),
    ]);
    const provider = new ToolGatewayProvider({
      baseUrl: 'http://tool-gateway.kagent-system.svc',
      fetch,
      task: {
        tenant: 'homelab',
        namespace: 'kagent-draft',
        taskUid: 'task-1',
        agentName: 'agent',
      },
      tools: ['browser.goto', 'mcp.project.lookup'],
    });

    const descriptors = await provider.describeTools(ctx());

    expect(descriptors.map((tool) => tool.name)).toEqual(['browser.goto', 'mcp.project.lookup']);
    expect(descriptors[1]).toEqual({
      name: 'mcp.project.lookup',
      description: 'Look up project metadata from an MCP server.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' } } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://tool-gateway.kagent-system.svc/v1/tool-runtime/describe');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      task: {
        tenant: 'homelab',
        namespace: 'kagent-draft',
        taskUid: 'task-1',
        agentName: 'agent',
      },
      toolNames: ['mcp.project.lookup'],
    });
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

  it('forwards granted external gateway tool calls', async () => {
    const { calls, fetch } = makeFetch([
      makeJsonResponse({
        content: '{"project":"kagent"}',
        isError: false,
      }),
    ]);
    const provider = new ToolGatewayProvider({
      baseUrl: 'http://tool-gateway.kagent-system.svc',
      fetch,
      task: {
        tenant: 'homelab',
        namespace: 'kagent-draft',
        taskUid: 'task-1',
        agentName: 'agent',
      },
      tools: ['mcp.project.lookup'],
    });

    await expect(
      provider.executeTool(
        { id: 'call-1', name: 'mcp.project.lookup', args: { project: 'kagent' } },
        ctx(),
      ),
    ).resolves.toEqual({ content: '{"project":"kagent"}', isError: false });
    expect(parsedRequestBody(calls[0])).toMatchObject({
      call: { name: 'mcp.project.lookup' },
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
