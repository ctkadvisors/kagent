/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SteelBrowserAdapter, type BrowserAutomationDriver } from './browser-steel.js';
import { LocalCodeRunner } from './code-runner.js';
import { ToolGatewayHttpHandler } from './http-server.js';

const TASK = {
  tenant: 'homelab',
  namespace: 'kagent-draft',
  taskUid: 'task-1',
  agentName: 'agent',
};

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://tool-gateway.test/v1/tool-runtime/invoke', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kagent-tenant': TASK.tenant,
      'x-kagent-namespace': TASK.namespace,
      'x-kagent-task-uid': TASK.taskUid,
      'x-kagent-agent': TASK.agentName,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function requestFor(task: typeof TASK, body: unknown): Request {
  return new Request('http://tool-gateway.test/v1/tool-runtime/invoke', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kagent-tenant': task.tenant,
      'x-kagent-namespace': task.namespace,
      'x-kagent-task-uid': task.taskUid,
      'x-kagent-agent': task.agentName,
    },
    body: JSON.stringify(body),
  });
}

function invokeBody(name: string, args: unknown): Record<string, unknown> {
  return invokeBodyFor(TASK, name, args);
}

function invokeBodyFor(task: typeof TASK, name: string, args: unknown): Record<string, unknown> {
  return {
    task,
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

function makeJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeBrowser(): SteelBrowserAdapter {
  const driver: BrowserAutomationDriver = {
    goto: vi.fn(() => Promise.resolve({ url: 'https://example.com/report', title: 'Report' })),
    click: vi.fn(() => Promise.resolve({ ok: true })),
    screenshot: vi.fn(() =>
      Promise.resolve({ mimeType: 'image/png', base64: Buffer.from('png').toString('base64') }),
    ),
    select: vi.fn(() => Promise.resolve({ ok: true })),
    extractText: vi.fn(() => Promise.resolve({ text: 'Visible report text' })),
    typeText: vi.fn(() => Promise.resolve({ ok: true })),
    waitFor: vi.fn(() => Promise.resolve({ ok: true, matched: 'text' })),
  };
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      makeJsonResponse({
        id: 'browser-1',
        websocketUrl: 'ws://steel.local/session/browser-1',
        sessionViewerUrl: 'http://steel.local/ui/sessions/browser-1',
      }),
    );

  return new SteelBrowserAdapter({
    baseUrl: 'http://steel.local',
    driver,
    fetch: fetchImpl,
  });
}

describe('ToolGatewayHttpHandler', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'kagent-http-server-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  function makeHandler(
    options: Partial<ConstructorParameters<typeof ToolGatewayHttpHandler>[0]> = {},
  ) {
    return new ToolGatewayHttpHandler({
      codeRunner: new LocalCodeRunner({
        workspaceDir,
        env: {
          HOME: '/workspace',
          TMPDIR: '/tmp',
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          KAGENT_TASK_UID: TASK.taskUid,
          KAGENT_AGENT_NAME: TASK.agentName,
          KAGENT_NAMESPACE: TASK.namespace,
          KAGENT_TOOL_SESSION_ID: 'code-1',
          KAGENT_TOOL_KIND: 'code_interpreter',
        },
      }),
      browser: makeBrowser(),
      ...options,
    });
  }

  it('executes code interpreter tool calls and returns a ToolResult JSON payload', async () => {
    const handler = makeHandler();

    const response = await handler.handle(
      request(
        invokeBody('code_interpreter.execute_code', {
          language: 'javascript',
          code: 'console.log("from-http")',
        }),
      ),
    );

    expect(response.status).toBe(200);
    const result = asRecord(await json(response));
    expect(result.isError).toBe(false);
    expect(typeof result.content).toBe('string');
    expect(result.content as string).toContain('from-http');
  });

  it('can resolve code runners per task so workspaces do not bleed across AgentTasks', async () => {
    const makeRunnerForTask = (task: typeof TASK) =>
      new LocalCodeRunner({
        workspaceDir: join(workspaceDir, task.taskUid),
        env: {
          HOME: '/workspace',
          TMPDIR: '/tmp',
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          KAGENT_TASK_UID: task.taskUid,
          KAGENT_AGENT_NAME: task.agentName,
          KAGENT_NAMESPACE: task.namespace,
          KAGENT_TOOL_SESSION_ID: `code-${task.taskUid}`,
          KAGENT_TOOL_KIND: 'code_interpreter',
        },
      });
    const handler = new ToolGatewayHttpHandler({
      browser: makeBrowser(),
      codeRunnerFactory: (task) => makeRunnerForTask(task),
    });
    const taskA = TASK;
    const taskB = { ...TASK, taskUid: 'task-2' };

    const writeResponse = await handler.handle(
      requestFor(
        taskA,
        invokeBodyFor(taskA, 'code_interpreter.write_files', {
          files: [{ path: 'result.txt', content: 'task-a-only' }],
        }),
      ),
    );
    expect(writeResponse.status).toBe(200);

    const readA = asRecord(
      await json(
        await handler.handle(
          requestFor(
            taskA,
            invokeBodyFor(taskA, 'code_interpreter.read_files', { paths: ['result.txt'] }),
          ),
        ),
      ),
    );
    expect(readA.isError).toBe(false);
    expect(readA.content).toBe(JSON.stringify([{ path: 'result.txt', content: 'task-a-only' }]));

    const readB = asRecord(
      await json(
        await handler.handle(
          requestFor(
            taskB,
            invokeBodyFor(taskB, 'code_interpreter.read_files', { paths: ['result.txt'] }),
          ),
        ),
      ),
    );
    expect(readB.isError).toBe(true);
  });

  it('keeps browser sessions task-scoped across start, action, and live-view calls', async () => {
    const handler = makeHandler();

    const startResult = asRecord(
      await json(await handler.handle(request(invokeBody('browser.start_session', {})))),
    );
    expect(startResult.isError).toBe(false);
    expect(typeof startResult.content).toBe('string');
    expect(startResult.content as string).toContain('browser-1');
    expect(startResult.metadata).toEqual({ sessionId: 'browser-1' });
    await expect(
      json(
        await handler.handle(
          request(invokeBody('browser.goto', { url: 'https://example.com/report' })),
        ),
      ),
    ).resolves.toEqual({
      content: JSON.stringify({ url: 'https://example.com/report', title: 'Report' }),
      isError: false,
      metadata: { sessionId: 'browser-1' },
    });
    await expect(
      json(await handler.handle(request(invokeBody('browser.live_view_url', {})))),
    ).resolves.toEqual({
      content: 'http://steel.local/ui/sessions/browser-1',
      isError: false,
      metadata: { sessionId: 'browser-1' },
    });
  });

  it('executes browser click, type, select, and wait tools through the session driver', async () => {
    const handler = makeHandler();

    await expect(
      json(
        await handler.handle(
          request(invokeBody('browser.click', { selector: 'button[name=search]' })),
        ),
      ),
    ).resolves.toEqual({
      content: JSON.stringify({ ok: true }),
      isError: false,
      metadata: { sessionId: 'browser-1' },
    });
    await expect(
      json(
        await handler.handle(
          request(invokeBody('browser.type', { selector: 'input[name=q]', text: 'agent sandbox' })),
        ),
      ),
    ).resolves.toEqual({
      content: JSON.stringify({ ok: true }),
      isError: false,
      metadata: { sessionId: 'browser-1' },
    });
    await expect(
      json(
        await handler.handle(
          request(invokeBody('browser.select', { selector: 'select[name=mode]', value: 'deep' })),
        ),
      ),
    ).resolves.toEqual({
      content: JSON.stringify({ ok: true }),
      isError: false,
      metadata: { sessionId: 'browser-1' },
    });
    await expect(
      json(await handler.handle(request(invokeBody('browser.wait_for', { text: 'Results' })))),
    ).resolves.toEqual({
      content: JSON.stringify({ ok: true, matched: 'text' }),
      isError: false,
      metadata: { sessionId: 'browser-1' },
    });
  });

  it('routes external tool handlers before built-ins for MCP/ad hoc integration', async () => {
    const handler = makeHandler({
      externalHandlers: {
        'mcp.project.lookup': ({ call, task }) => ({
          content: JSON.stringify({ taskUid: task.taskUid, query: call.args }),
          isError: false,
        }),
      },
    });

    const response = await handler.handle(
      request(invokeBody('mcp.project.lookup', { project: 'kagent' })),
    );

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toEqual({
      content: JSON.stringify({ taskUid: TASK.taskUid, query: { project: 'kagent' } }),
      isError: false,
    });
  });

  it('rejects requests when task headers disagree with the body ownership identity', async () => {
    const handler = makeHandler();

    const response = await handler.handle(
      request(
        {
          task: { ...TASK, taskUid: 'body-task' },
          call: { id: 'call-1', name: 'code_interpreter.list_files', args: {} },
        },
        { 'x-kagent-task-uid': 'header-task' },
      ),
    );

    expect(response.status).toBe(403);
    await expect(json(response)).resolves.toEqual({
      error: 'policy_denied: task identity mismatch between headers and request body',
    });
  });

  it('returns a terminal paused error without invoking handlers when the kill switch is set', async () => {
    const handler = makeHandler({
      paused: true,
      externalHandlers: {
        'mcp.project.lookup': () => {
          throw new Error('should not run');
        },
      },
    });

    const response = await handler.handle(
      request(invokeBody('mcp.project.lookup', { project: 'kagent' })),
    );

    expect(response.status).toBe(503);
    await expect(json(response)).resolves.toEqual({ error: 'tool_runtime_paused' });
  });
});
