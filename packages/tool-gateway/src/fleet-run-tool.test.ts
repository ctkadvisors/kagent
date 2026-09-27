/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { defineFleetRunTool, parseFleetRunToolArgs } from './fleet-run-tool.js';
import type { ToolGatewayCodeRunner, ToolGatewayHandlerInput } from './http-server.js';

const task = { tenant: 't', namespace: 'kagent-system', taskUid: 'uid-1', agentName: 'auditor' };
const SHA = 'a'.repeat(40);

function input(args: unknown): ToolGatewayHandlerInput {
  return {
    task,
    call: { id: 'c1', name: 'fleet.run_tool', args },
    request: new Request('http://gw/v1/tool-runtime/invoke', { method: 'POST' }),
  };
}

describe('fleet.run_tool', () => {
  it('refuses malformed args before touching anything', () => {
    expect(parseFleetRunToolArgs({ folder: '../etc', sha: SHA, run: 'x' })).toBeNull();
    expect(
      parseFleetRunToolArgs({ folder: '2026-09-26-egressmeter', sha: 'abc', run: 'x' }),
    ).toBeNull();
    expect(
      parseFleetRunToolArgs({ folder: '2026-09-26-egressmeter', sha: SHA, run: 'x'.repeat(201) }),
    ).toBeNull();
    expect(
      parseFleetRunToolArgs({
        folder: '2026-09-26-egressmeter',
        sha: SHA,
        run: 'python3 a.py',
        timeoutMs: 9e9,
      }),
    ).toEqual({
      folder: '2026-09-26-egressmeter',
      sha: SHA,
      run: 'python3 a.py',
      timeoutMs: 1_500_000,
    });
  });

  it('fetches the pinned tree with the signed identity, writes it into the workspace, runs the command', async () => {
    const fetched: Array<{ url: string; headers: Record<string, string> }> = [];
    const written: Array<{ path: string; content: string }> = [];
    const ran: Array<{ command: string; args?: readonly string[]; timeoutMs?: number }> = [];
    const runner = {
      writeFiles: (files: readonly { path: string; content: string }[]) => {
        written.push(...files);
        return Promise.resolve();
      },
      executeCommand: (i: { command: string; args?: readonly string[]; timeoutMs?: number }) => {
        ran.push(i);
        return Promise.resolve({
          stdout: 'FLEET-EGRESS v1\n{"channels": 3}\n',
          stderr: 'warn',
          exitCode: 1,
          signal: null,
          timedOut: false,
        });
      },
    } as unknown as ToolGatewayCodeRunner;
    const tool = defineFleetRunTool({
      playgroundUrl: 'http://playground/',
      signingKey: 'k',
      codeRunnerFor: () => runner,
      fetch: ((url: string, init: RequestInit) => {
        fetched.push({ url, headers: init.headers as Record<string, string> });
        return Promise.resolve(
          new Response(
            JSON.stringify({ files: { 'a.py': 'print(1)', 'lib/b.py': 'x=1', 'big.bin': 7 } }),
            { status: 200 },
          ),
        );
      }) as unknown as typeof fetch,
    });
    const result = await tool(
      input({ folder: '2026-09-26-egressmeter', sha: SHA, run: 'python3 a.py --json' }),
    );
    expect(fetched[0]?.url).toBe(`http://playground/tree?folder=2026-09-26-egressmeter&sha=${SHA}`);
    expect(fetched[0]?.headers['X-Kagent-Agent']).toBe('auditor');
    expect(fetched[0]?.headers['X-Kagent-Sig']).toMatch(/^[0-9a-f]{64}$/);
    expect(written.map((f) => f.path)).toEqual([
      '2026-09-26-egressmeter/a.py',
      '2026-09-26-egressmeter/lib/b.py',
    ]);
    expect(ran[0]).toEqual({
      command: 'sh',
      args: ['-c', "cd '2026-09-26-egressmeter' && python3 a.py --json"],
      timeoutMs: 900_000,
    });
    expect(result.isError).toBe(false);
    const out = JSON.parse(result.content) as { exit: number; stdout: string; stderr: string };
    expect(out.exit).toBe(1);
    expect(out.stdout).toContain('"channels": 3');
    expect(out.stderr).toBe('warn');
  });

  it('reports a refused or empty tree as an error, never runs', async () => {
    let runs = 0;
    const runner = {
      writeFiles: () => Promise.resolve(),
      executeCommand: () => {
        runs += 1;
        return Promise.resolve({
          stdout: '',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
        });
      },
    } as unknown as ToolGatewayCodeRunner;
    const refused = () =>
      Promise.resolve(new Response('{"error":"no such folder"}', { status: 404 }));
    const tool = defineFleetRunTool({
      playgroundUrl: 'http://playground',
      signingKey: 'k',
      codeRunnerFor: () => runner,
      fetch: refused,
    });
    const r = await tool(input({ folder: '2026-09-26-egressmeter', sha: SHA, run: 'true' }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('HTTP 404');
    expect(runs).toBe(0);
  });
});
