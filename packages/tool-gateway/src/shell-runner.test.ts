/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { SshShellRunner } from './shell-runner.js';

function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  close: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdout,
    stderr,
    kill: vi.fn(),
  });
  return {
    child,
    emitStdout: (s: string) => stdout.emit('data', Buffer.from(s)),
    emitStderr: (s: string) => stderr.emit('data', Buffer.from(s)),
    close: (code: number | null, signal: NodeJS.Signals | null) =>
      child.emit('close', code, signal),
  };
}

function makeRunner(spawnImpl: ReturnType<typeof vi.fn>): SshShellRunner {
  return new SshShellRunner({
    sshKeyPath: '/secrets/kagent-builder-ssh-key/id_ed25519',
    sshUser: 'kagent-builder',
    spawnImpl: spawnImpl as unknown as never,
  });
}

describe('SshShellRunner', () => {
  it('rejects a host outside the closed elitemini2/jetson2 enum before spawning anything', async () => {
    const spawnImpl = vi.fn();
    const runner = makeRunner(spawnImpl);

    await expect(
      // @ts-expect-error -- deliberately passing an invalid host to test the runtime guard
      runner.exec({ host: 'elitemini', command: 'echo hi' }),
    ).rejects.toThrow(/policy_denied.*host/i);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('rejects commands containing sudo before spawning anything', async () => {
    const spawnImpl = vi.fn();
    const runner = makeRunner(spawnImpl);

    await expect(runner.exec({ host: 'jetson2', command: 'sudo reboot' })).rejects.toThrow(
      /policy_denied.*sudo/i,
    );
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('rejects commands that touch authorized_keys before spawning anything', async () => {
    const spawnImpl = vi.fn();
    const runner = makeRunner(spawnImpl);

    await expect(
      runner.exec({ host: 'jetson2', command: 'echo x >> ~/.ssh/authorized_keys' }),
    ).rejects.toThrow(/policy_denied.*authorized_keys/i);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('invokes ssh with the key, user, resolved host IP, and a timeout-wrapped command', async () => {
    const fake = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(fake.child);
    const runner = makeRunner(spawnImpl);

    const resultPromise = runner.exec({
      host: 'elitemini2',
      command: 'echo hi',
      timeoutSeconds: 30,
    });
    fake.emitStdout('hi\n');
    fake.close(0, null);
    const result = await resultPromise;

    expect(result).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0, timedOut: false });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [command, args] = spawnImpl.mock.calls[0] as [string, string[]];
    expect(command).toBe('ssh');
    expect(args).toEqual([
      '-i',
      '/secrets/kagent-builder-ssh-key/id_ed25519',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'BatchMode=yes',
      'kagent-builder@192.168.68.74',
      'timeout 30s echo hi',
    ]);
  });

  it('defaults to a 120s timeout and caps any requested timeout at 600s', async () => {
    const fake = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(fake.child);
    const runner = makeRunner(spawnImpl);

    const p1 = runner.exec({ host: 'jetson2', command: 'echo a' });
    fake.close(0, null);
    await p1;
    expect((spawnImpl.mock.calls[0] as [string, string[]])[1].at(-1)).toBe('timeout 120s echo a');

    const fake2 = fakeChild();
    spawnImpl.mockReturnValue(fake2.child);
    const p2 = runner.exec({ host: 'jetson2', command: 'echo b', timeoutSeconds: 99_999 });
    fake2.close(0, null);
    await p2;
    expect((spawnImpl.mock.calls[1] as [string, string[]])[1].at(-1)).toBe('timeout 600s echo b');
  });

  it('captures stderr and a non-zero exit code without throwing', async () => {
    const fake = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(fake.child);
    const runner = makeRunner(spawnImpl);

    const resultPromise = runner.exec({ host: 'jetson2', command: 'false' });
    fake.emitStderr('boom\n');
    fake.close(1, null);
    const result = await resultPromise;

    expect(result).toEqual({ stdout: '', stderr: 'boom\n', exitCode: 1, timedOut: false });
  });
});
