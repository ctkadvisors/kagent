/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalCodeRunner } from './code-runner.js';
import { defineFleetRunTool } from './fleet-run-tool.js';

it('returns complete bounded stdout past the former silent 6000-character slice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-complete-output-'));
  const runner = new LocalCodeRunner({ workspaceDir: root, env: { PATH: process.env.PATH ?? '' } });
  const stdout =
    'intakewatch on intake: exit 1\n\n' +
    JSON.stringify({
      stuck_receipt_count: 2,
      receipts: Array.from({ length: 100 }, () => ({ note: 'x'.repeat(270) })),
    }) +
    '\n';
  const tool = defineFleetRunTool({
    playgroundUrl: 'http://fixture',
    signingKey: 'fixture',
    codeRunnerFor: () => runner,
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            files: {
              'report.mjs':
                'process.stdout.write(' + JSON.stringify(stdout) + '); process.exitCode=1;',
            },
          }),
        ),
      ),
  });
  const result = await tool({
    task: { tenant: 't', namespace: 'n', taskUid: 'task', agentName: 'check-fixture' },
    request: new Request('http://gateway'),
    call: {
      id: 'op',
      name: 'fleet.run_tool',
      args: { folder: '2026-10-26-intakewatch', sha: 'a'.repeat(40), run: 'node report.mjs' },
    },
  });
  const envelope = JSON.parse(result.content) as {
    stdout: string;
    outputComplete: boolean;
    exit: number;
  };
  expect(envelope.stdout).toBe(stdout);
  expect(envelope.outputComplete).toBe(true);
  expect(envelope.exit).toBe(1);
});

it('declares runner truncation while preserving its existing byte ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-output-limit-'));
  const runner = new LocalCodeRunner({
    workspaceDir: root,
    env: { PATH: process.env.PATH ?? '' },
    outputLimitBytes: 32,
  });
  const result = await runner.executeCode({
    language: 'javascript',
    code: "process.stdout.write('雪'.repeat(100));",
  });
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(32);
  expect(result).toHaveProperty('stdoutTruncated', true);
});

it.each([
  { timedOut: true, exitCode: null, signal: 'SIGKILL' as const },
  { timedOut: false, exitCode: 1, signal: null },
  { timedOut: false, exitCode: 0, signal: 'SIGTERM' as const },
])(
  'refuses an apparently complete inner envelope when the outer runner failed: %j',
  async (outer) => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-outer-failed-'));
    const runner = new LocalCodeRunner({ workspaceDir: root, env: {} });
    runner.executeCode = () =>
      Promise.resolve({
        ...outer,
        stdout:
          '@@fleet.run_tool@@' +
          JSON.stringify({
            status: 0,
            signal: null,
            stdout: 'check on input: exit 0\n\n{"count":0}',
            stderr: '',
            outputComplete: true,
          }),
        stderr: '',
      });
    const tool = defineFleetRunTool({
      playgroundUrl: 'http://fixture',
      signingKey: 'fixture',
      codeRunnerFor: () => runner,
      fetch: () => Promise.resolve(new Response(JSON.stringify({ files: { 'main.mjs': '' } }))),
    });
    const result = await tool({
      task: { tenant: 't', namespace: 'n', taskUid: 'task', agentName: 'check-fixture' },
      request: new Request('http://gateway'),
      call: {
        id: 'op',
        name: 'fleet.run_tool',
        args: { folder: '2026-10-26-intakewatch', sha: 'a'.repeat(40), run: 'node main.mjs' },
      },
    });
    expect(result.isError).toBe(true);
  },
);
