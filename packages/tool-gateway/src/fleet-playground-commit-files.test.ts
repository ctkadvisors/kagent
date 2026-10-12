/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { defineFleetPlaygroundCommitFiles } from './fleet-playground-commit-files.js';
import type { ToolGatewayCodeRunner, ToolGatewayHandlerInput } from './http-server.js';

const task = { tenant: 't', namespace: 'kagent-system', taskUid: 'uid-1', agentName: 'inventor' };
const args = {
  folder: '2026-10-12-capture',
  message: 'Capture actual minutes',
  files: { 'input/minutes.txt': 'browser-captures/one/page.txt' },
};
const SHA = 'a'.repeat(40);
function input(value: unknown = args): ToolGatewayHandlerInput {
  return {
    task,
    call: { id: 'c1', name: 'fleet.playground_commit_files', args: value },
    request: new Request('http://gateway/invoke', { method: 'POST' }),
  };
}
function fixture(
  reads = [{ path: 'browser-captures/one/page.txt', content: '  ACTION-348: café 🧪\r\n\n' }],
) {
  const readFiles = vi.fn(() => Promise.resolve(reads));
  const codeRunnerFor = vi.fn(() => ({ readFiles }) as unknown as ToolGatewayCodeRunner);
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          sha: SHA,
          url: `https://github.com/ctkadvisors/fleet-playground/tree/${SHA}/${args.folder}`,
          folder: args.folder,
          files: ['input/minutes.txt'],
        }),
        { status: 201 },
      ),
    ),
  );
  const tool = defineFleetPlaygroundCommitFiles({
    playgroundUrl: 'http://playground/',
    signingKey: 'dummy',
    codeRunnerFor,
    fetch,
  });
  return { tool, readFiles, codeRunnerFor, fetch };
}

describe('fleet.playground_commit_files', () => {
  it('reads task workspace bytes and signs exactly the JSON sent to the existing commit endpoint', async () => {
    const f = fixture();
    const result = await f.tool(input());
    expect(result.isError).toBe(false);
    expect(f.codeRunnerFor).toHaveBeenCalledWith(task);
    expect(f.readFiles).toHaveBeenCalledWith(['browser-captures/one/page.txt']);
    const [url, init] = f.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://playground/commit');
    const body = init.body as string;
    const posted = JSON.parse(body) as { files: Record<string, string> };
    expect(posted).toEqual({
      ...args,
      files: { 'input/minutes.txt': '  ACTION-348: café 🧪\r\n\n' },
    });
    const headers = init.headers as Record<string, string>;
    const digest = createHash('sha256').update(body).digest('hex');
    const signed = [
      task.agentName,
      task.taskUid,
      task.namespace,
      headers['X-Kagent-Ts'],
      digest,
    ].join('\n');
    expect(headers['X-Kagent-Sig']).toBe(
      createHmac('sha256', 'dummy').update(signed).digest('hex'),
    );
    const receipt = JSON.parse(result.content as string) as {
      sha: string;
      fileDigests: Record<string, string>;
    };
    expect(receipt.sha).toBe(SHA);
    expect(receipt.fileDigests['input/minutes.txt']).toBe(
      createHash('sha256').update(posted.files['input/minutes.txt']!).digest('hex'),
    );
  });

  it.each([
    { ...args, folder: '../escape' },
    { ...args, files: {} },
    { ...args, files: { '../escape': 'page.txt' } },
    { ...args, files: { 'out.txt': '../escape' } },
    { ...args, files: { 'out.txt': '/etc/passwd' } },
    { ...args, files: { 'out.txt': 7 } },
    {
      ...args,
      files: Object.fromEntries(
        Array.from({ length: 61 }, (_, i) => [`f${i}.txt`, `source${i}.txt`]),
      ),
    },
  ])('refuses invalid scope or file bounds before reading or posting', async (value) => {
    const f = fixture();
    expect((await f.tool(input(value))).isError).toBe(true);
    expect(f.readFiles).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(
    [
      [],
      [{ path: 'wrong.txt', content: 'fiction' }],
      [
        { path: 'browser-captures/one/page.txt', content: 'first' },
        { path: 'browser-captures/one/page.txt', content: 'duplicate' },
      ],
    ].map((reads) => ({ reads })),
  )(
    'refuses missing, mismatched or duplicate returned paths without partial commit',
    async ({ reads }) => {
      const f = fixture(reads);
      expect((await f.tool(input())).isError).toBe(true);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it('enforces the existing 512 KiB limit using UTF-8 bytes before POST', async () => {
    const f = fixture([{ path: 'browser-captures/one/page.txt', content: 'é'.repeat(300000) }]);
    expect((await f.tool(input())).isError).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('reports a refused commit without a fabricated SHA receipt', async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response('{"error":"commit refused"}', { status: 400 }));
    const result = await f.tool(input());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('HTTP 400');
  });
});
