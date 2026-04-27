/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * SC3-safe: no provider SDK names beyond the legitimate MCP SDK import,
 * no domain identifiers. Consumed only by `provider.test.ts` siblings —
 * never re-exported from the package barrel (Phase 2 D-21).
 *
 * In-pkg test fixture for `provider.test.ts`. Spawned via
 * `process.execPath --import tsx fixtures/test-mcp-server.ts` per
 * RESEARCH §Compile vs runtime Path A.
 *
 * Tools provided:
 *   - mcp_echo(text: string) → echoes the input as a text block
 *   - env_dump() → returns process.env as JSON-stringified text block (for env-merge test)
 *   - force_error() → returns isError:true (for D-16 isError-preservation test)
 *   - mutate_tools() → toggles internal state + sends notifications/tools/list_changed
 *     (for D-15/D-18 cache-invalidation test); after invocation, tools/list
 *     additionally lists a `mutated_tool` entry as a structural marker.
 *
 * The MCP `initialize` + `notifications/initialized` handshake is handled
 * automatically by `Server` + `StdioServerTransport` — no manual handler
 * registration needed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-server', version: '0.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

let toolsListMutated = false;

server.setRequestHandler(ListToolsRequestSchema, () => {
  const baseTools: Array<{
    name: string;
    description: string;
    inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  }> = [
    {
      name: 'mcp_echo',
      description: 'Echoes the input back as text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'env_dump',
      description: 'Returns process.env as JSON for env-merge testing.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'force_error',
      description: 'Returns isError:true for D-16 isError-preservation test.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'mutate_tools',
      description:
        'Sends notifications/tools/list_changed to client; subsequent tools/list returns an additional mutated_tool entry (D-15/D-18 cache-invalidation test).',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  if (toolsListMutated) {
    baseTools.push({
      name: 'mutated_tool',
      description: 'Visible only after mutate_tools is called (cache-invalidation marker).',
      inputSchema: { type: 'object', properties: {} },
    });
  }
  return { tools: baseTools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'mcp_echo') {
    const text = (req.params.arguments as { text?: string } | undefined)?.text ?? '';
    return { content: [{ type: 'text', text }], isError: false };
  }
  if (req.params.name === 'env_dump') {
    return {
      content: [{ type: 'text', text: JSON.stringify(process.env) }],
      isError: false,
    };
  }
  if (req.params.name === 'force_error') {
    return {
      content: [{ type: 'text', text: 'forced error' }],
      isError: true,
    };
  }
  if (req.params.name === 'mutate_tools') {
    // Toggle the mutated state BEFORE sending the notification so the next
    // tools/list reflects the change.
    toolsListMutated = true;
    await server.notification({ method: 'notifications/tools/list_changed' });
    return { content: [{ type: 'text', text: 'mutated' }], isError: false };
  }
  return {
    content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
