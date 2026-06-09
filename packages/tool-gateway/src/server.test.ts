/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildToolGatewayHandler,
  createToolGatewayServerHandler,
  parseToolGatewayServerConfig,
} from './server.js';

const TASK = {
  tenant: 'homelab',
  namespace: 'kagent-draft',
  taskUid: 'task-1',
  agentName: 'agent',
};

function request(body: unknown): Request {
  return new Request('http://tool-gateway.test/v1/tool-runtime/invoke', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kagent-tenant': TASK.tenant,
      'x-kagent-namespace': TASK.namespace,
      'x-kagent-task-uid': TASK.taskUid,
      'x-kagent-agent': TASK.agentName,
    },
    body: JSON.stringify(body),
  });
}

function invokeBody(name: string, args: unknown): Record<string, unknown> {
  return {
    task: TASK,
    call: {
      id: 'call-1',
      name,
      args,
    },
  };
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}

describe('tool-gateway server', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'kagent-tool-gateway-server-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('parses deploy-time env into a server config', () => {
    expect(
      parseToolGatewayServerConfig({
        KAGENT_TOOL_GATEWAY_PORT: '9090',
        KAGENT_TOOL_RUNTIME_WORKSPACE_ROOT: workspaceRoot,
        KAGENT_TOOL_RUNTIME_PAUSED: 'true',
        KAGENT_STEEL_BASE_URL: 'http://steel.kagent-system.svc.cluster.local:3000',
        KAGENT_STEEL_API_KEY: 'steel-key',
        KAGENT_STEEL_CONNECT_BASE_URL: 'ws://steel.kagent-system.svc.cluster.local:3000',
        KAGENT_TOOL_GATEWAY_EXTERNAL_PROVIDERS_JSON: JSON.stringify({
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
      }),
    ).toEqual({
      port: 9090,
      workspaceRoot,
      paused: true,
      steelBaseUrl: 'http://steel.kagent-system.svc.cluster.local:3000',
      steelApiKey: 'steel-key',
      steelConnectBaseUrl: 'ws://steel.kagent-system.svc.cluster.local:3000',
      externalProviders: {
        providers: [
          expect.objectContaining({
            kind: 'http',
            id: 'project-api',
            baseUrl: 'http://project-api.kagent-system.svc',
          }),
        ],
      },
    });
  });

  it('routes health/readiness locally and invokes the runtime handler for tool calls', async () => {
    const config = parseToolGatewayServerConfig({
      KAGENT_TOOL_RUNTIME_WORKSPACE_ROOT: workspaceRoot,
    });
    const runtimeHandler = buildToolGatewayHandler(config);
    const serverHandler = createToolGatewayServerHandler({
      runtimeHandler,
      isReady: () => !config.paused,
    });

    await expect(
      json(await serverHandler(new Request('http://tool-gateway.test/healthz'))),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      json(await serverHandler(new Request('http://tool-gateway.test/readyz'))),
    ).resolves.toEqual({
      ok: true,
    });

    const response = await serverHandler(
      request(
        invokeBody('code_interpreter.execute_command', {
          command: 'env',
        }),
      ),
    );
    expect(response.status).toBe(200);
    const result = asRecord(await json(response));
    expect(result.isError).toBe(false);
    expect(result.content as string).toContain('KAGENT_TASK_UID=task-1');
  });

  it('keeps health live but readiness failed while the kill switch is paused', async () => {
    const config = parseToolGatewayServerConfig({
      KAGENT_TOOL_RUNTIME_WORKSPACE_ROOT: workspaceRoot,
      KAGENT_TOOL_RUNTIME_PAUSED: 'true',
    });
    const serverHandler = createToolGatewayServerHandler({
      runtimeHandler: buildToolGatewayHandler(config),
      isReady: () => !config.paused,
    });

    const health = await serverHandler(new Request('http://tool-gateway.test/healthz'));
    const ready = await serverHandler(new Request('http://tool-gateway.test/readyz'));

    expect(health.status).toBe(200);
    expect(ready.status).toBe(503);
    await expect(json(ready)).resolves.toEqual({ ok: false, reason: 'paused' });
  });
});
