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
    expect(parseFleetRunToolArgs({ folder: '../etc', sha: SHA, run: 'x' })).toMatch(/^folder /);
    expect(parseFleetRunToolArgs({ folder: '2026-09-26-egressmeter', run: 'x' })).toBe(
      "sha must be the folder's 40-hex commit, got null",
    );
    expect(
      parseFleetRunToolArgs({ folder: '2026-09-26-egressmeter', sha: SHA, run: 'x'.repeat(4001) }),
    ).toBe('run must be a command of 1..4000 chars, got 4001');
    // a delivery's chained command (219 chars on 2026-10-13) runs verbatim
    expect(
      parseFleetRunToolArgs({ folder: '2026-09-26-egressmeter', sha: SHA, run: 'x'.repeat(219) }),
    ).toMatchObject({ run: 'x'.repeat(219) });
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
    const ran: Array<{ language: string; code: string; timeoutMs?: number }> = [];
    const runner = {
      writeFiles: (files: readonly { path: string; content: string }[]) => {
        written.push(...files);
        return Promise.resolve();
      },
      executeCode: (i: { language: string; code: string; timeoutMs?: number }) => {
        ran.push(i);
        const envelope = JSON.stringify({
          status: 1,
          signal: null,
          stdout: 'FLEET-EGRESS v1\n{"channels": 3}\n',
          stderr: 'warn',
        });
        return Promise.resolve({
          stdout: 'noise before\n@@fleet.run_tool@@' + envelope,
          stderr: '',
          exitCode: 0,
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
    expect(ran[0]?.language).toBe('javascript');
    expect(ran[0]?.timeoutMs).toBe(900_000);
    expect(ran[0]?.code).toContain(
      `spawnSync('sh', ['-c', "python3 a.py --json"], { cwd: "2026-09-26-egressmeter"`,
    );
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
      executeCode: () => {
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

describe('fleet.run_capability', () => {
  it('resolves the catalog command without letting the consumer retype or mask it', async () => {
    const snippets: string[] = [];
    const urls: string[] = [];
    const runner = {
      writeFiles: () => Promise.resolve(),
      executeCode: (value: { code: string }) => {
        snippets.push(value.code);
        return Promise.resolve({
          stdout:
            '@@fleet.run_tool@@' +
            JSON.stringify({
              status: 1,
              signal: null,
              stdout: 'stuck receipts found',
              stderr: '',
            }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
        });
      },
    } as unknown as ToolGatewayCodeRunner;
    const tool = defineFleetRunTool({
      playgroundUrl: 'http://playground/',
      signingKey: 'k',
      codeRunnerFor: () => runner,
      fetch: ((url: string) => {
        urls.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('/missions')
                ? {
                    catalog: [
                      {
                        kind: 'capability',
                        template: 'capability-intakewatch',
                        revision: 4,
                        folder: '2026-10-26-intakewatch',
                        sha: SHA,
                        run: 'python3 intakewatch.py --capture real.json',
                        reference_exit: 1,
                        verdict: 91,
                      },
                    ],
                  }
                : { files: { 'intakewatch.py': 'print(1)' } },
            ),
            { status: 200 },
          ),
        );
      }) as unknown as typeof fetch,
    });
    const call = input({ template: 'capability-intakewatch', sha: SHA, revision: 4 });
    const result = await tool({ ...call, call: { ...call.call, name: 'fleet.run_capability' } });
    expect(result.isError).toBe(false);
    expect(urls[0]).toBe('http://report.fleet-authority.svc:8080/missions');
    expect(snippets[0]).toContain('python3 intakewatch.py --capture real.json');
    expect(snippets[0]).not.toContain('echo EXIT');
    expect(JSON.parse(result.content)).toMatchObject({
      template: 'capability-intakewatch',
      revision: 4,
      sha: SHA,
      exit: 1,
      run: 'python3 intakewatch.py --capture real.json',
      reference_exit: 1,
      verdict: 91,
    });
  });
});

it('refuses command overrides and changed catalog pins before creating a runner', async () => {
  let runs = 0;
  const tool = defineFleetRunTool({
    playgroundUrl: 'http://playground',
    signingKey: 'k',
    codeRunnerFor: () => {
      runs += 1;
      throw new Error('must not execute');
    },
    fetch: (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            catalog: [
              {
                kind: 'capability',
                template: 'capability-intakewatch',
                revision: 5,
                folder: '2026-10-26-intakewatch',
                sha: SHA,
                run: 'python3 actual.py',
              },
            ],
          }),
        ),
      )) as unknown as typeof fetch,
  });
  for (const args of [
    { template: 'capability-intakewatch', sha: SHA, revision: 4 },
    {
      template: 'capability-intakewatch',
      sha: SHA,
      revision: 5,
      run: 'python3 actual.py; echo EXIT=$?',
    },
    { template: 'capability-intakewatch', sha: 'b'.repeat(40), revision: 5 },
  ]) {
    const call = input(args);
    const result = await tool({ ...call, call: { ...call.call, name: 'fleet.run_capability' } });
    expect(result.isError).toBe(true);
  }
  expect(runs).toBe(0);
});
