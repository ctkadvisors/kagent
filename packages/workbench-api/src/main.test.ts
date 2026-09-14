/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// `main()` is not exported from main.ts, so exercise the entrypoint as a
// child process (the same `tsx src/main.ts` the `start` script runs). A
// misconfigured WORKBENCH_PORT must fail fast with a descriptive error
// *before* the server is created, rather than an uncaught Hono listen
// throw once the chart-managed env var is set to a bad value.
const runWithEnv = (portValue: string): { code: number; stdout: string; stderr: string } => {
  try {
    return execFileSync('npx', ['tsx', 'src/main.ts'], {
      env: {
        ...process.env,
        WORKBENCH_PORT: portValue,
        KAGENT_NO_INFORMER: '1',
        // Keep the probe/auth paths from hanging on a real cluster.
        WORKBENCH_AUTH_REQUIRED: 'false',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
  } catch (err) {
    // execFileSync throws a ChildProcessError on non-zero exit; read
    // its stdout/stderr (if any) plus the exit status.
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
};

describe('WORKBENCH_PORT validation', () => {
  it('rejects a non-numeric port with a descriptive error', () => {
    const { code, stderr } = runWithEnv('not-a-number');
    expect(code).not.toBe(0);
    expect(stderr).toContain('invalid WORKBENCH_PORT');
    expect(stderr).toContain('not-a-number');
  });

  it('rejects an out-of-range port', () => {
    const { code, stderr } = runWithEnv('70000');
    expect(code).not.toBe(0);
    expect(stderr).toContain('invalid WORKBENCH_PORT');
  });
});
