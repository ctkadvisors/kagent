/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { ToolInvocationContext } from '@kagent/agent-loop';
import { describe, expect, it, vi } from 'vitest';

import {
  buildExternalToolRegistry,
  parseExternalToolProviderConfig,
} from './external-providers.js';

function ctx(): ToolInvocationContext {
  return { runId: 'run-1', abortSignal: new AbortController().signal };
}

describe('external tool provider config', () => {
  it('parses HTTP and MCP provider hooks from JSON config', () => {
    expect(
      parseExternalToolProviderConfig(
        JSON.stringify({
          providers: [
            {
              kind: 'http',
              id: 'project-api',
              baseUrl: 'http://project-api.kagent-system.svc',
              tools: [
                {
                  name: 'http.project.lookup',
                  description: 'Look up project metadata.',
                  inputSchema: { type: 'object' },
                  method: 'POST',
                  path: '/lookup',
                },
              ],
            },
            {
              kind: 'mcpStdio',
              id: 'local-mcp',
              command: 'node',
              args: ['server.js'],
              envAllowlist: ['PATH'],
            },
            {
              kind: 'remoteMcp',
              id: 'remote-mcp',
              url: 'http://remote-mcp.kagent-system.svc/mcp',
              headers: { 'x-scope': 'readonly' },
            },
          ],
        }),
      ),
    ).toEqual({
      providers: [
        expect.objectContaining({ kind: 'http', id: 'project-api' }),
        expect.objectContaining({ kind: 'mcpStdio', id: 'local-mcp' }),
        expect.objectContaining({ kind: 'remoteMcp', id: 'remote-mcp' }),
      ],
    });
  });

  it('builds an executable registry for configured HTTP ad hoc tools', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ project: 'kagent' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ) as unknown as typeof fetch;
    const config = parseExternalToolProviderConfig(
      JSON.stringify({
        providers: [
          {
            kind: 'http',
            id: 'project-api',
            baseUrl: 'http://project-api.kagent-system.svc',
            tools: [
              {
                name: 'http.project.lookup',
                description: 'Look up project metadata.',
                inputSchema: { type: 'object' },
                method: 'POST',
                path: '/lookup',
              },
            ],
          },
        ],
      }),
    );
    const registry = buildExternalToolRegistry(config, { fetch: fetchImpl });

    await expect(registry.describeTools(ctx())).resolves.toEqual([
      {
        name: 'http.project.lookup',
        description: 'Look up project metadata.',
        inputSchema: { type: 'object' },
      },
    ]);
    await expect(
      registry.executeTool(
        {
          task: {
            tenant: 'homelab',
            namespace: 'kagent-draft',
            taskUid: 'task-1',
            agentName: 'agent',
          },
          call: { id: 'call-1', name: 'http.project.lookup', args: { project: 'kagent' } },
        },
        ctx(),
      ),
    ).resolves.toEqual({
      content: '{"project":"kagent"}',
      isError: false,
      metadata: { status: 200, headers: { 'content-type': 'application/json' } },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://project-api.kagent-system.svc/lookup',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('withMcpToolPrefix', () => {
  const inner = {
    id: 'remote-mcp',
    describeTools: vi.fn(() =>
      Promise.resolve([
        { name: 'add_memory', description: 'Add an episode.', inputSchema: {} },
        { name: 'mcp.already_prefixed', description: '', inputSchema: {} },
      ]),
    ),
    executeTool: vi.fn(() => Promise.resolve({ content: 'ok', isError: false })),
  };

  it('advertises raw MCP tool names under the gateway mcp.* namespace', async () => {
    const { withMcpToolPrefix } = await import('./external-providers.js');
    const wrapped = withMcpToolPrefix(inner);
    const tools = await wrapped.describeTools(ctx());
    expect(tools.map((t) => t.name)).toEqual(['mcp.add_memory', 'mcp.already_prefixed']);
  });

  it('strips the mcp. prefix before delegating execution', async () => {
    const { withMcpToolPrefix } = await import('./external-providers.js');
    const wrapped = withMcpToolPrefix(inner);
    await wrapped.executeTool({ id: 'call-1', name: 'mcp.add_memory', args: {} }, ctx());
    expect(inner.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'add_memory' }),
      expect.anything(),
    );
  });
});
