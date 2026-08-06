/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { spawn as nodeSpawn } from 'node:child_process';

/**
 * Closed host allowlist, supplied by deployment config rather than baked
 * into this file.
 *
 * It used to be a hardcoded `elitemini2`/`jetson2` map holding one
 * homelab's RFC1918 addresses, on the same "hardcode the allowlist in
 * code" reasoning code-runner.ts uses for ALLOWED_COMMANDS. That reasoning
 * does not transfer: an allowlist of *commands* is a universal safety
 * property, but an allowlist of *hosts* is deployment-specific. Baking one
 * cluster's addresses in made `shell.exec` dead code for every other
 * deployer, and published those addresses plus the SSH account name in a
 * public repo.
 *
 * The security property is unchanged -- this is still a closed allowlist
 * enforced gateway-side, and the set is still not something a caller can
 * influence per-request. Only its *source* moved, from source code to
 * `toolRuntime.shell.hosts` in the chart (env `KAGENT_SHELL_HOSTS`).
 *
 * Fail-closed: an empty map rejects every host, so `shell.exec` stays
 * inert until an operator names hosts explicitly.
 */
export type ShellHost = string;

/** One allowlisted SSH target. `address` may be an IP or a resolvable name. */
export interface ShellHostEntry {
  readonly name: string;
  readonly address: string;
}

/**
 * Parse `KAGENT_SHELL_HOSTS` -- a JSON array of `{name, address}`. Returns
 * an empty map for unset/blank/malformed input rather than throwing, so a
 * bad value disables the tool instead of crashing the gateway at boot. The
 * caller logs when the result is empty but a shell key/user was supplied.
 */
export function parseShellHostsEnv(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const { name, address } = entry as { name?: unknown; address?: unknown };
    if (typeof name !== 'string' || name.length === 0) continue;
    if (typeof address !== 'string' || address.length === 0) continue;
    out[name] = address;
  }
  return out;
}

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
  /**
   * Allowlisted targets as `name -> address`. Omitted/empty means every
   * host is refused (fail-closed).
   */
  readonly hosts?: Readonly<Record<string, string>>;
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
  private readonly hosts: Readonly<Record<string, string>>;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly outputLimitBytes: number;

  constructor(options: SshShellRunnerOptions) {
    this.sshKeyPath = options.sshKeyPath;
    this.sshUser = options.sshUser;
    this.hosts = options.hosts ?? {};
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  }

  /**
   * Allowlisted host names, sorted. The HTTP layer uses this to publish
   * the `host` enum in the tool descriptor, so the model only ever sees
   * hosts this deployment actually configured.
   */
  hostNames(): readonly string[] {
    return Object.keys(this.hosts).sort();
  }

  async exec(input: ShellExecInput): Promise<ShellExecResult> {
    const ip = this.assertHostAllowed(input.host);
    this.assertCommandAllowed(input.command);
    const timeoutSeconds = this.clampTimeout(input.timeoutSeconds);

    return this.spawnSsh(ip, input.command, timeoutSeconds);
  }

  private assertHostAllowed(host: string): string {
    const address = (this.hosts as Record<string, string | undefined>)[host];
    if (address === undefined) {
      const names = this.hostNames();
      const allowed =
        names.length === 0
          ? 'none configured — set toolRuntime.shell.hosts in the chart'
          : names.join(', ');
      throw new Error(`policy_denied: unknown shell.exec host "${host}" (allowed: ${allowed})`);
    }
    return address;
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
      'UserKnownHostsFile=/tmp/kagent-shell-known-hosts',
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
