/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { spawn as nodeSpawn } from 'node:child_process';

/**
 * Closed host enum, not helm/env-configurable. Adding a third host means
 * editing this file (and its tests), not a values.yaml change -- the same
 * "hardcode the allowlist in code" posture code-runner.ts uses for
 * ALLOWED_COMMANDS/DENIED_COMMANDS.
 */
const HOST_IPS: Record<ShellHost, string> = {
  elitemini2: '192.168.68.74',
  jetson2: '192.168.68.75',
};

export type ShellHost = 'elitemini2' | 'jetson2';

export interface ShellExecInput {
  readonly host: ShellHost;
  readonly command: string;
  readonly timeoutSeconds?: number;
}

export interface ShellExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface SshShellRunnerOptions {
  readonly sshKeyPath: string;
  readonly sshUser: string;
  /** Test-only injection point, mirrors provider-factory.ts's fetchImpl pattern. */
  readonly spawnImpl?: typeof nodeSpawn;
  readonly outputLimitBytes?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/**
 * Defense-in-depth command rejection. NOT a substitute for the OS-level
 * no-sudo kagent-builder account -- a cheap extra layer in case that
 * account is ever misconfigured.
 */
const FORBIDDEN_PATTERNS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /\bsudo\b/, reason: 'sudo' },
  { pattern: /authorized_keys/, reason: 'authorized_keys' },
  { pattern: /rm\s+-rf\s+\/(?!\S)/, reason: 'rm -rf /' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, reason: 'fork bomb' },
];

export class SshShellRunner {
  private readonly sshKeyPath: string;
  private readonly sshUser: string;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly outputLimitBytes: number;

  constructor(options: SshShellRunnerOptions) {
    this.sshKeyPath = options.sshKeyPath;
    this.sshUser = options.sshUser;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  }

  async exec(input: ShellExecInput): Promise<ShellExecResult> {
    const ip = this.assertHostAllowed(input.host);
    this.assertCommandAllowed(input.command);
    const timeoutSeconds = this.clampTimeout(input.timeoutSeconds);

    return this.spawnSsh(ip, input.command, timeoutSeconds);
  }

  private assertHostAllowed(host: string): string {
    const ip = (HOST_IPS as Record<string, string | undefined>)[host];
    if (ip === undefined) {
      throw new Error(
        `policy_denied: unknown shell.exec host "${host}" (allowed: ${Object.keys(HOST_IPS).join(', ')})`,
      );
    }
    return ip;
  }

  private assertCommandAllowed(command: string): void {
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(`policy_denied: command matches forbidden pattern "${reason}"`);
      }
    }
  }

  private clampTimeout(requested: number | undefined): number {
    if (requested === undefined) return DEFAULT_TIMEOUT_SECONDS;
    return Math.min(Math.max(1, Math.floor(requested)), MAX_TIMEOUT_SECONDS);
  }

  private spawnSsh(ip: string, command: string, timeoutSeconds: number): Promise<ShellExecResult> {
    const args = [
      '-i',
      this.sshKeyPath,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'BatchMode=yes',
      `${this.sshUser}@${ip}`,
      `timeout ${timeoutSeconds}s ${command}`,
    ];

    const child = this.spawnImpl('ssh', args, { shell: false });

    let stdout = '';
    let stderr = '';

    return new Promise<ShellExecResult>((resolveResult, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = this.appendBounded(stdout, chunk.toString('utf8'));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = this.appendBounded(stderr, chunk.toString('utf8'));
      });
      child.on('error', reject);
      child.on('close', (exitCode) => {
        resolveResult({
          stdout,
          stderr,
          exitCode,
          // The remote `timeout` wrapper exits 124 on its own timeout;
          // ssh's local process isn't killed by us at all here (unlike
          // code-runner.ts's local spawn, this process runs over network
          // I/O and the remote timeout is the authoritative bound).
          timedOut: exitCode === 124,
        });
      });
    });
  }

  private appendBounded(current: string, next: string): string {
    const combined = current + next;
    if (Buffer.byteLength(combined, 'utf8') <= this.outputLimitBytes) return combined;
    return combined.slice(0, this.outputLimitBytes);
  }
}
