/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocalCodeRunner } from './code-runner.js';
import { createPodCodeRunnerFactory, type SandboxKube } from './pod-code-runner.js';
import { createSandboxHandler } from './sandbox-worker.js';

const task = (uid: string) => ({
  tenant: 'default',
  namespace: 'kagent-system',
  taskUid: uid,
  agentName: 'fleet-check',
});

function worker(token: string) {
  const runner = new LocalCodeRunner({
    workspaceDir: mkdtempSync(join(tmpdir(), 'sbx-')),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp' },
  });
  return createSandboxHandler(runner, token);
}

describe('createSandboxHandler', () => {
  it('runs code and files for its own token only', async () => {
    const handle = worker('t'.repeat(64));
    const auth = `Bearer ${'t'.repeat(64)}`;
    const run = (op: string, arg: unknown, a: string | null = auth) =>
      handle('POST', '/v1/run', a, JSON.stringify({ op, arg }));
    expect((await run('listFiles', undefined, null)).status).toBe(401);
    expect((await run('listFiles', undefined, `Bearer ${'x'.repeat(64)}`)).status).toBe(401);
    expect((await run('rmRf', '/')).status).toBe(400);
    expect((await run('writeFiles', [{ path: 'a.txt', content: 'hi' }])).body).toEqual({
      ok: true,
      result: null,
    });
    const read = (await run('readFiles', ['a.txt'])).body as { result: { content: string }[] };
    expect(read.result[0]?.content).toBe('hi');
    const out = (await run('executeCode', { language: 'javascript', code: 'console.log(6*7)' }))
      .body as {
      result: { stdout: string; exitCode: number };
    };
    expect(out.result.stdout.trim()).toBe('42');
    expect(out.result.exitCode).toBe(0);
  });
});

describe('createPodCodeRunnerFactory', () => {
  function cluster() {
    const jobs: Record<string, Record<string, unknown>>[] = [];
    const deletes: string[] = [];
    const handlers = new Map<string, ReturnType<typeof worker>>();
    let healthyIps = new Set<string>();
    const kube: SandboxKube = {
      createJob: (_ns, job) => {
        jobs.push(job as never);
        const name = (job['metadata'] as { name: string }).name;
        const env = (job['spec'] as never)['template']['spec']['containers'][0]['env'] as {
          name: string;
          value: string;
        }[];
        const token = env.find((e) => e.name === 'KAGENT_SANDBOX_TOKEN')?.value ?? '';
        handlers.set(`10.0.0.${String(jobs.length)}`, worker(token));
        healthyIps.add(`10.0.0.${String(jobs.length)}`);
        void name;
        return Promise.resolve();
      },
      deleteTaskJobs: (_ns, uid) => {
        deletes.push(uid);
        return Promise.resolve();
      },
      runningPodIp: () => Promise.resolve(`10.0.0.${String(jobs.length)}`),
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const handle = handlers.get(u.hostname);
      if (handle === undefined || !healthyIps.has(u.hostname)) throw new Error('ECONNREFUSED');
      const headers = new Headers(init?.headers);
      const reply = await handle(
        init?.method ?? 'GET',
        u.pathname,
        headers.get('authorization'),
        typeof init?.body === 'string' ? init.body : '',
      );
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch;
    return {
      jobs,
      deletes,
      kill: () => {
        healthyIps = new Set();
      },
      factory: createPodCodeRunnerFactory({
        kube,
        namespace: 'kagent-system',
        image: 'gw:1',
        fetch: fetchImpl,
        sleep: () => Promise.resolve(),
      }),
    };
  }

  it('gives each task its own tokenless sandbox and reuses it', async () => {
    const c = cluster();
    const a = c.factory(task('uid-a'));
    await a.writeFiles([{ path: 'x', content: '1' }]);
    expect((await a.readFiles(['x']))[0]?.content).toBe('1');
    expect(c.jobs).toHaveLength(1);
    const pod = (c.jobs[0]!['spec'] as never)['template']['spec'] as Record<string, unknown>;
    expect(pod['automountServiceAccountToken']).toBe(false);
    const env = (pod['containers'] as { env: { name: string }[] }[])[0]!.env.map((e) => e.name);
    expect(env).toEqual([
      'KAGENT_SANDBOX_TOKEN',
      'KAGENT_SANDBOX_IDLE_SECONDS',
      'KAGENT_SANDBOX_PORT',
    ]);
    // another task never sees this one's files
    const b = c.factory(task('uid-b'));
    await expect(b.readFiles(['x'])).rejects.toThrow();
    expect(c.jobs).toHaveLength(2);
  });

  it('replaces a sandbox that stopped answering', async () => {
    const c = cluster();
    const a = c.factory(task('uid-a'));
    await a.listFiles();
    c.kill();
    await a.listFiles();
    expect(c.jobs).toHaveLength(2);
    expect(c.deletes).toEqual(['uid-a', 'uid-a']);
  });
});
