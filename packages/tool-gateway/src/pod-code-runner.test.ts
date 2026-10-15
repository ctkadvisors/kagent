/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { V1Job } from '@kubernetes/client-node';

import { LocalCodeRunner } from './code-runner.js';
import { createPodCodeRunnerFactory, sandboxJob, type SandboxKube } from './pod-code-runner.js';
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
    const jobs: V1Job[] = [];
    const deleted = new Set<string>();
    const ips = new Map<string, string>();
    const deletes: string[] = [];
    const handlers = new Map<string, ReturnType<typeof worker>>();
    let healthyIps = new Set<string>();
    let healthFailures = 0;
    const kube: SandboxKube = {
      createJob: (_ns, job) => {
        const candidateName = (job.metadata as { name: string }).name;
        if (
          jobs.some(
            (j) =>
              j.metadata?.namespace === _ns &&
              j.metadata?.name === candidateName &&
              !deleted.has(j.metadata.uid!),
          )
        )
          return Promise.reject(Object.assign(new Error('conflict'), { code: 409 }));
        jobs.push(job);
        (job.metadata as Record<string, unknown>).uid = `job-${jobs.length}`;
        const name = (job['metadata'] as { name: string }).name;
        const env = (job['spec'] as never)['template']['spec']['containers'][0]['env'] as {
          name: string;
          value: string;
        }[];
        const token = env.find((e) => e.name === 'KAGENT_SANDBOX_TOKEN')?.value ?? '';
        handlers.set(`10.0.0.${String(jobs.length)}`, worker(token));
        healthyIps.add(`10.0.0.${String(jobs.length)}`);
        ips.set(name, `10.0.0.${String(jobs.length)}`);
        return Promise.resolve();
      },
      deleteJob: (_ns, name, uid) => {
        const job = jobs.find((j) => j.metadata?.name === name && j.metadata?.uid === uid);
        if (job) {
          deletes.push(name);
          deleted.add(uid);
        }
        return Promise.resolve();
      },
      listTaskJobs: (namespace, uid) =>
        Promise.resolve(
          jobs.filter(
            (job) =>
              job.metadata?.namespace === namespace &&
              job.metadata?.labels?.['kagent.knuteson.io/sandbox-task'] === uid &&
              !deleted.has(job.metadata.uid!),
          ),
        ),
      runningPodIp: (_namespace, name, jobUid) => {
        const job = jobs.find(
          (j) => j.metadata?.name === name && (jobUid === undefined || j.metadata?.uid === jobUid),
        );
        return Promise.resolve(job ? ips.get(name) : undefined);
      },
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const handle = handlers.get(u.hostname);
      if (handle === undefined || !healthyIps.has(u.hostname)) throw new Error('ECONNREFUSED');
      const probe =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { op?: unknown; arg?: unknown })
          : {};
      if (
        healthFailures > 0 &&
        probe.op === 'readFiles' &&
        Array.isArray(probe.arg) &&
        probe.arg.length === 0
      ) {
        healthFailures -= 1;
        throw new Error('temporary network outage');
      }
      const headers = new Headers(init?.headers);
      const reply = await handle(
        init?.method ?? 'GET',
        u.pathname,
        headers.get('authorization'),
        typeof init?.body === 'string' ? init.body : '',
      );
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch;
    const newFactory = () =>
      createPodCodeRunnerFactory({
        kube,
        namespace: 'kagent-system',
        image: 'gw:2',
        fetch: fetchImpl,
        readyTimeoutMs: 100,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
      });
    return {
      kube,
      jobs,
      newFactory,
      useLegacyName: () => {
        const job = jobs[0]!;
        const oldName = job.metadata!.name!;
        job.metadata!.name = 'kagent-sbx-uid-a-old123';
        ips.set(job.metadata!.name, ips.get(oldName)!);
      },
      removeJobs: () => {
        for (const job of jobs) deleted.add(job.metadata!.uid!);
        healthyIps = new Set();
      },
      failHealthCalls: (count: number) => {
        healthFailures = count;
      },
      deletes,
      kill: () => {
        healthyIps = new Set();
      },
      factory: createPodCodeRunnerFactory({
        kube,
        namespace: 'kagent-system',
        image: 'gw:1',
        fetch: fetchImpl,
        readyTimeoutMs: 100,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
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

  it('reattaches after factory restart without deleting the live Job or losing saved bytes', async () => {
    const c = cluster();
    const original = c.factory(task('uid-a'));
    const content = '  saved café 🧪\r\n\n';
    await original.writeFiles([{ path: 'input/source.txt', content }]);
    c.useLegacyName();
    const deletesBefore = c.deletes.length;
    const restarted = c.newFactory()(task('uid-a'));
    expect(await restarted.readFiles(['input/source.txt'])).toEqual([
      { path: 'input/source.txt', content },
    ]);
    expect(c.jobs).toHaveLength(1);
    expect(c.deletes).toHaveLength(deletesBefore);
    // A newly created verifier/task cannot acquire this workspace.
    await expect(
      c.newFactory()(task('uid-verifier')).readFiles(['input/source.txt']),
    ).rejects.toThrow();
    expect(c.jobs).toHaveLength(2);
  });

  it.each(['namespace', 'task', 'manager', 'component', 'agent', 'worker', 'token'])(
    'does not reattach a Job with mismatched %s identity',
    async (field) => {
      const c = cluster();
      await c.factory(task('uid-a')).writeFiles([{ path: 'private.txt', content: 'old bytes' }]);
      const job = c.jobs[0]!;
      if (field === 'namespace') job.metadata!.namespace = 'other';
      if (field === 'task') job.metadata!.labels!['kagent.knuteson.io/sandbox-task'] = 'uid-other';
      if (field === 'manager') job.metadata!.labels!['app.kubernetes.io/managed-by'] = 'other';
      if (field === 'component') job.metadata!.labels!['app.kubernetes.io/component'] = 'other';
      if (field === 'agent') job.metadata!.labels!['kagent.knuteson.io/agent'] = 'other';
      if (field === 'worker') job.spec!.template.spec!.containers[0]!.command = ['other-worker'];
      if (field === 'token')
        job.spec!.template.spec!.containers[0]!.env![0]!.value = '0'.repeat(64);
      // Simulate an unexpectedly broad API response; the factory must validate ownership itself.
      c.kube.listTaskJobs = () => Promise.resolve(c.jobs);
      await expect(c.newFactory()(task('uid-a')).readFiles(['private.txt'])).rejects.toThrow();
      expect(c.jobs).toHaveLength(field === 'namespace' ? 2 : 1);
      expect(c.deletes).toEqual([]);
    },
  );

  it('preserves an unavailable active sandbox instead of erasing its workspace', async () => {
    const c = cluster();
    const a = c.factory(task('uid-a'));
    await a.listFiles();
    c.kill();
    await expect(a.listFiles()).rejects.toThrow('code_sandbox_unavailable');
    expect(c.jobs).toHaveLength(1);
    expect(c.deletes).toEqual([]);
  });
  it.each(['Complete', 'Failed'])(
    'reports confirmed %s workspace loss once and creates a fresh sandbox',
    async (type) => {
      const c = cluster();
      await c.factory(task('uid-a')).writeFiles([{ path: 'old.txt', content: 'old' }]);
      c.jobs[0]!.status = { conditions: [{ type, status: 'True' }] };
      c.kill();
      const recovered = c.newFactory()(task('uid-a'));
      await expect(recovered.listFiles()).rejects.toThrow('workspace_recreated');
      expect(await recovered.listFiles()).toEqual([]);
      expect(c.jobs).toHaveLength(2);
      expect(c.deletes).toEqual([c.jobs[0]!.metadata!.name]);
    },
  );

  it('concurrent factories adopt one Job without deleting either caller workspace', async () => {
    const c = cluster();
    const a = c.factory(task('uid-a'));
    const b = c.newFactory()(task('uid-a'));
    await Promise.all([
      a.writeFiles([{ path: 'a.txt', content: 'a' }]),
      b.writeFiles([{ path: 'b.txt', content: 'b' }]),
    ]);
    expect(await a.readFiles(['a.txt', 'b.txt'])).toEqual([
      { path: 'a.txt', content: 'a' },
      { path: 'b.txt', content: 'b' },
    ]);
    expect(c.jobs).toHaveLength(1);
    expect(c.deletes).toEqual([]);
  });
  it('waits through transient authenticated probe failures and preserves the saved workspace', async () => {
    const c = cluster();
    await c.factory(task('uid-a')).writeFiles([{ path: 'saved.txt', content: 'preserved' }]);
    c.failHealthCalls(2);
    expect(await c.newFactory()(task('uid-a')).readFiles(['saved.txt'])).toEqual([
      { path: 'saved.txt', content: 'preserved' },
    ]);
    expect(c.jobs).toHaveLength(1);
    expect(c.deletes).toEqual([]);
  });
  it('reports loss when a previously known Job disappeared before recreation', async () => {
    const c = cluster();
    const runner = c.factory(task('uid-a'));
    await runner.writeFiles([{ path: 'old.txt', content: 'old' }]);
    c.removeJobs();
    await expect(runner.listFiles()).rejects.toThrow('workspace_recreated');
    expect(await runner.listFiles()).toEqual([]);
    expect(c.jobs).toHaveLength(2);
    expect(c.deletes).toEqual([]);
  });
  it('retains known generation across an acquisition outage and reports loss on retry', async () => {
    const c = cluster();
    const runner = c.factory(task('uid-a'));
    await runner.writeFiles([{ path: 'old.txt', content: 'old' }]);
    c.removeJobs();
    const list = c.kube.listTaskJobs.bind(c.kube);
    c.kube.listTaskJobs = () => Promise.reject(new Error('API unavailable'));
    await expect(runner.listFiles()).rejects.toThrow('API unavailable');
    c.kube.listTaskJobs = list;
    await expect(runner.listFiles()).rejects.toThrow('workspace_recreated');
    expect(await runner.listFiles()).toEqual([]);
  });

  it('both previously attached factories report a changed Job generation after a creation race', async () => {
    const c = cluster();
    const a = c.factory(task('uid-a'));
    const b = c.newFactory()(task('uid-a'));
    await a.writeFiles([{ path: 'old.txt', content: 'old' }]);
    await b.readFiles(['old.txt']);
    c.removeJobs();
    const results = await Promise.allSettled([a.listFiles(), b.listFiles()]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected')
        expect(String(result.reason)).toContain('workspace_recreated');
    }
    expect(await a.listFiles()).toEqual([]);
    expect(await b.listFiles()).toEqual([]);
    expect(c.jobs).toHaveLength(2);
    expect(c.deletes).toEqual([]);
  });
  it('retains observed terminal generation when replacement readiness times out before retry', async () => {
    const c = cluster();
    await c.factory(task('uid-a')).writeFiles([{ path: 'old.txt', content: 'old' }]);
    c.jobs[0]!.status = { conditions: [{ type: 'Complete', status: 'True' }] };
    c.kill();
    c.failHealthCalls(10000);
    const recovered = c.newFactory()(task('uid-a'));
    await expect(recovered.listFiles()).rejects.toThrow('code_sandbox_unavailable');
    c.failHealthCalls(0);
    await expect(recovered.listFiles()).rejects.toThrow('workspace_recreated');
    expect(await recovered.listFiles()).toEqual([]);
    expect(c.jobs).toHaveLength(2);
  });
});

describe('sandboxJob', () => {
  const pod = (dnsConfig?: Record<string, unknown>) =>
    (
      sandboxJob(
        {
          kube: {} as SandboxKube,
          namespace: 'kagent-system',
          image: 'i',
          ...(dnsConfig && { dnsConfig }),
        },
        task('uid-a'),
        'kagent-sbx-x',
        'a'.repeat(64),
      )['spec'] as never
    )['template']['spec'] as Record<string, unknown>;

  it('uses only the configured resolver when one is set, the cluster DNS otherwise', () => {
    const dnsConfig = { nameservers: ['10.43.0.53'], searches: ['svc.cluster.local'] };
    expect(pod(dnsConfig)).toMatchObject({ dnsPolicy: 'None', dnsConfig });
    expect(pod()).not.toHaveProperty('dnsPolicy');
    expect(pod()).not.toHaveProperty('dnsConfig');
  });
});
