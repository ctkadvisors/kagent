/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalCodeRunner } from './code-runner.js';

describe('LocalCodeRunner', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'kagent-code-runner-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  function makeRunner(): LocalCodeRunner {
    return new LocalCodeRunner({
      workspaceDir,
      env: {
        HOME: '/workspace',
        TMPDIR: '/tmp',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        KAGENT_TASK_UID: 'task-1',
        KAGENT_AGENT_NAME: 'agent',
        KAGENT_NAMESPACE: 'kagent',
        KAGENT_TOOL_SESSION_ID: 'code-1',
        KAGENT_TOOL_KIND: 'code_interpreter',
      },
    });
  }

  it('writes and reads files under the workspace root', async () => {
    const runner = makeRunner();

    await runner.writeFiles([{ path: 'data/input.txt', content: 'hello' }]);

    await expect(readFile(join(workspaceDir, 'data/input.txt'), 'utf8')).resolves.toBe('hello');
    await expect(runner.readFiles(['data/input.txt'])).resolves.toEqual([
      { path: 'data/input.txt', content: 'hello' },
    ]);
  });

  it('refuses paths outside the workspace', async () => {
    const runner = makeRunner();

    await expect(runner.writeFiles([{ path: '../escape.txt', content: 'x' }])).rejects.toThrow(
      /policy_denied/,
    );
    await expect(runner.readFiles(['/tmp/escape.txt'])).rejects.toThrow(/policy_denied/);
  });

  it('executes allowlisted commands with cwd pinned to the workspace', async () => {
    const runner = makeRunner();

    const result = await runner.executeCommand({
      command: 'node',
      args: [
        '-e',
        'console.log(process.cwd()); console.log(process.env.OPENAI_API_KEY ?? "clean")',
      ],
      timeoutMs: 2_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(workspaceDir);
    expect(result.stdout).toContain('clean');
    expect(result.timedOut).toBe(false);
  });

  it('denies commands outside the allowlist', async () => {
    const runner = makeRunner();

    await expect(
      runner.executeCommand({ command: 'kubectl', args: ['get', 'pods'] }),
    ).rejects.toThrow(/policy_denied/);
  });

  it('terminates commands that exceed the timeout', async () => {
    const runner = makeRunner();

    const result = await runner.executeCommand({
      command: 'node',
      args: ['-e', 'setTimeout(() => console.log("late"), 5000)'],
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('starts and stops long-running commands by task id', async () => {
    const runner = makeRunner();

    const started = await runner.startCommand({
      command: 'node',
      args: [
        '-e',
        [
          'const { writeFileSync } = require("node:fs");',
          'process.stdout.write("tick\\n", () => writeFileSync("ready.txt", "tick", "utf8"));',
          'setInterval(() => {}, 20);',
        ].join(' '),
      ],
      timeoutMs: 10_000,
    });
    await waitForFileContent(join(workspaceDir, 'ready.txt'), 'tick');
    const result = await runner.stopTask(started.taskId);

    expect(started.taskId).toMatch(/^cmd-/);
    expect(result.exitCode).toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('tick');
  });

  it('executes inline JavaScript code through a temporary workspace file', async () => {
    const runner = makeRunner();

    const result = await runner.executeCode({
      language: 'javascript',
      code: 'console.log("from-code")',
      timeoutMs: 2_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('from-code');
  });
});

async function waitForFileContent(
  path: string,
  expected: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const content = await readFile(path, 'utf8');
      if (content === expected) return;
    } catch {
      /* file is created by the child process once stdout is ready */
    }

    await sleep(10);
  }

  throw new Error(`timed out waiting for ${path}`);
}
