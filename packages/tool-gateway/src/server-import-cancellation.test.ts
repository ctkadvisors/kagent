/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createServer, request } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalCodeRunner } from './code-runner.js';
import { ToolGatewayHttpHandler } from './http-server.js';
import { handleNodeRequest } from './server.js';

const task = { tenant: 't', namespace: 'ns', taskUid: 'a', agentName: 'a' };
const headers = {
  'content-type': 'application/json',
  'x-kagent-tenant': 't',
  'x-kagent-namespace': 'ns',
  'x-kagent-task-uid': 'a',
  'x-kagent-agent': 'a',
};
const body = JSON.stringify({
  task,
  call: {
    id: 'code',
    name: 'code_interpreter.execute_code',
    args: {
      language: 'python',
      code: 'print(1)',
      inputFiles: [{ path: 'raw.json', content: '{}' }],
    },
  },
});
const complete = { stdout: 'executed', stderr: '', exitCode: 0, signal: null, timedOut: false };

it('does not start code after a real HTTP client disconnect during import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'import-http-abort-'));
  const runner = new LocalCodeRunner({ workspaceDir: root, env: {} });
  let release = () => {};
  let started = () => {};
  let closed = () => {};
  let finished = () => {};
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const clientClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  runner.writeFiles = async () => {
    started();
    await wait;
  };
  const execute = vi.spyOn(runner, 'executeCode').mockResolvedValue(complete);
  const handler = new ToolGatewayHttpHandler({ codeRunner: runner });
  const server = createServer((req, res) => {
    res.once('close', closed);
    void handleNodeRequest((request) => handler.handle(request), req, res).finally(finished);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const client = request({
    host: '127.0.0.1',
    port: address.port,
    method: 'POST',
    path: '/v1/tool-runtime/invoke',
    headers,
  });
  client.on('error', () => {});
  try {
    client.end(body);
    await writing;
    client.destroy();
    await clientClosed;
    release();
    await done;
    expect(execute).not.toHaveBeenCalled();
  } finally {
    release();
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('counts import time against the existing default code timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'import-time-budget-'));
  const runner = new LocalCodeRunner({ workspaceDir: root, env: {} });
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  runner.writeFiles = () => {
    now += 31_000;
    return Promise.resolve();
  };
  const execute = vi.spyOn(runner, 'executeCode').mockResolvedValue(complete);
  try {
    const handler = new ToolGatewayHttpHandler({ codeRunner: runner });
    const response = await handler.handle(
      new Request('http://gateway/v1/tool-runtime/invoke', { method: 'POST', headers, body }),
    );
    const result = (await response.json()) as { isError: boolean; metadata: { timedOut: boolean } };
    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.metadata.timedOut).toBe(true);
  } finally {
    clock.mockRestore();
  }
});
