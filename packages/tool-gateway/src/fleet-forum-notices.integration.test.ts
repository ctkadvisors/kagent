/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityBundle } from '@kagent/capability-types';
import { AgentExecutor, AgentRegistry, type ChatRequest } from '@kagent/agent-loop';
import { chatAgent } from '../../agent-loop/src/__fixtures__/agents.js';
import { makeStubLLM } from '../../agent-loop/src/__fixtures__/stub-llm.js';
import { ToolGatewayProvider } from '../../agent-pod/src/tool-gateway-provider.js';
import { ToolGatewayHttpHandler } from './http-server.js';
import { FleetForumNotices } from './fleet-forum-notices.js';

// Provider and executor are unchanged from the already-running 7fe8ddc owner.
describe('active mention bridge through unchanged provider and executor', () => {
  it.each([false, true])(
    'reaches the next model request despite an oversized result (isError=%s)',
    async (isError) => {
      const task = {
        tenant: 'homelab',
        namespace: 'kagent-system',
        taskUid: 'live-task',
        agentName: 'researcher',
      };
      const proof = {
        verifiedBundle: {
          sub: 'task-uid:live-task',
          agt: 'kagent-system/researcher',
          claims: { tenant: 'homelab' },
          iat: 100,
          exp: 10000,
        } as CapabilityBundle,
      };
      const original = {
        content: 'real output ' + 'x'.repeat(30000) + ' original tail',
        isError,
        metadata: { preserved: true },
      };
      const handler = new ToolGatewayHttpHandler({
        verifyCaller: () => Promise.resolve(proof),
        forumNotices: new FleetForumNotices({
          url: 'http://forum/api/forum/mentions',
          tenant: 'homelab',
          namespace: 'kagent-system',
          now: () => 200000,
          fetch: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({ posts: [{ id: 42 }], has_more: false, next_after: 42 }),
              ),
            ),
        }),
        externalHandlers: { 'code_interpreter.start_session': () => original },
      });
      let gatewayResult: unknown;
      const provider = new ToolGatewayProvider({
        baseUrl: 'http://gateway',
        task,
        tools: ['code_interpreter.start_session'],
        fetch: async (url, init) => {
          const response = await handler.handle(new Request(url, init));
          gatewayResult = await response.clone().json();
          return response;
        },
      });
      const registry = new AgentRegistry();
      registry.register(chatAgent);
      const requests: ChatRequest[] = [];
      const llm = makeStubLLM({
        recordedRequests: requests,
        scriptedResponses: [
          {
            content: '',
            tool_calls: [{ id: 'call', name: 'code_interpreter.start_session', args: {} }],
          },
          { content: 'received' },
        ],
      });
      await new AgentExecutor({ registry, llm, toolProviders: [provider] }).run({
        agentType: 'chat',
        messages: [{ role: 'user', content: 'continue work' }],
      });
      expect(gatewayResult).toMatchObject({ isError, metadata: original.metadata });
      expect(
        (gatewayResult as { content: { text: string }[] }).content[1]?.text === original.content,
      ).toBe(true);
      const toolMessage = requests[1]?.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toContain('post IDs 42');
      expect(toolMessage?.content).toContain('grant no new authority');
      expect(toolMessage?.content).toContain('original tail');
      expect(toolMessage?.content.length).toBeLessThan(17000);
    },
  );
});
