/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Per-task code sandboxes. Before this, every task's code ran as a child of
 * the gateway process: beside the gateway's signing key, able to read any
 * other task's workspace, sharing one /tmp (a fleet check once passed its
 * verification only because an earlier run had left /tmp/em behind). Now the
 * first code call of a task creates a Job running sandbox-worker.ts, and every
 * later call of that task goes to it. The Job carries no service-account
 * token and no env of the gateway's; the gateway recovers its bearer token internally from the owned Job on restart.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { V1Job } from '@kubernetes/client-node';

import type {
  CodeRunnerFile,
  CodeRunnerListEntry,
  CodeRunnerReadResult,
  CommandResult,
  ExecuteCodeInput,
  ExecuteCommandInput,
  StartedCommand,
} from './code-runner.js';
import type {
  ToolGatewayCodeRunner,
  ToolGatewayCodeRunnerFactory,
  ToolGatewayTaskIdentity,
} from './http-server.js';
import type { SandboxOp } from './sandbox-worker.js';

export const SANDBOX_TASK_LABEL = 'kagent.knuteson.io/sandbox-task';
const SANDBOX_PORT = 8080;

/** Kubernetes calls already covered by the sandbox Role; see kube-jobs.ts. */
export interface SandboxKube {
  createJob(namespace: string, job: Record<string, unknown>): Promise<void>;
  listTaskJobs(namespace: string, taskUid: string): Promise<readonly V1Job[]>;
  /** Delete only the exact terminal Job observed, never a replacement with the same name. */
  deleteJob(namespace: string, name: string, uid: string): Promise<void>;
  /** The IP of the Job's running pod, or undefined while it is not running yet. */
  runningPodIp(namespace: string, jobName: string, jobUid: string): Promise<string | undefined>;
}

export interface PodCodeRunnerOptions {
  readonly kube: SandboxKube;
  readonly namespace: string;
  readonly image: string;
  readonly runtimeClassName?: string;
  readonly idleSeconds?: number;
  readonly maxLifetimeSeconds?: number;
  readonly resources?: Record<string, unknown>;
  /** Where sandboxes may run: the image's architectures, typically. */
  readonly nodeSelector?: Record<string, string>;
  /** A resolver for cluster names only: the cluster's own DNS forwards any name to the
   *  internet, a channel out of a sandbox that dials nothing else (2026-10-15, egressmeter). */
  readonly dnsConfig?: Record<string, unknown>;
  readonly readyTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Sandbox {
  readonly url: string;
  readonly token: string;
  readonly jobUid: string;
  readonly workspaceRecreated: boolean;
}

export function sandboxJob(
  options: PodCodeRunnerOptions,
  task: ToolGatewayTaskIdentity,
  name: string,
  token: string,
): Record<string, unknown> {
  const labels = {
    'app.kubernetes.io/component': 'code-sandbox',
    'app.kubernetes.io/managed-by': 'kagent-tool-gateway',
    [SANDBOX_TASK_LABEL]: task.taskUid,
    'kagent.knuteson.io/agent': task.agentName,
  };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: options.namespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      activeDeadlineSeconds: options.maxLifetimeSeconds ?? 6 * 3600,
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: 'Never',
          ...(options.runtimeClassName !== undefined && {
            runtimeClassName: options.runtimeClassName,
          }),
          ...(options.nodeSelector !== undefined && { nodeSelector: options.nodeSelector }),
          ...(options.dnsConfig !== undefined && {
            dnsPolicy: 'None',
            dnsConfig: options.dnsConfig,
          }),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            fsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'sandbox',
              image: options.image,
              command: ['node', '/app/packages/tool-gateway/dist/sandbox-worker.js'],
              env: [
                { name: 'KAGENT_SANDBOX_TOKEN', value: token },
                { name: 'KAGENT_SANDBOX_IDLE_SECONDS', value: String(options.idleSeconds ?? 1800) },
                { name: 'KAGENT_SANDBOX_PORT', value: String(SANDBOX_PORT) },
              ],
              ports: [{ name: 'http', containerPort: SANDBOX_PORT }],
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'workspace', mountPath: '/workspace' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
              ...(options.resources !== undefined && { resources: options.resources }),
            },
          ],
          volumes: [
            { name: 'workspace', emptyDir: { sizeLimit: '2Gi' } },
            { name: 'tmp', emptyDir: { sizeLimit: '1Gi' } },
          ],
        },
      },
    },
  };
}

export function createPodCodeRunnerFactory(
  options: PodCodeRunnerOptions,
): ToolGatewayCodeRunnerFactory {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
  const sandboxes = new Map<string, Promise<Sandbox>>();
  // Retain observed generation even if a later acquisition fails.
  const lastJobUids = new Map<string, string>();

  // A notice belongs to this acquisition, not a particular operation's return type.
  const reportedLoss = new WeakSet<Sandbox>();

  async function healthy(sandbox: Sandbox): Promise<boolean> {
    try {
      const response = await fetchImpl(`${sandbox.url}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sandbox.token}` },
        body: JSON.stringify({ op: 'readFiles', arg: [] }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, readyTimeoutMs))),
      });
      const body = (await response.json()) as { ok?: boolean; result?: unknown };
      return response.ok && body.ok === true && Array.isArray(body.result);
    } catch {
      return false;
    }
  }

  function owned(job: V1Job, task: ToolGatewayTaskIdentity): boolean {
    const labels = job.metadata?.labels;
    const pod = job.spec?.template.spec;
    const worker = pod?.containers[0];
    return (
      job.metadata?.namespace === options.namespace &&
      typeof job.metadata?.name === 'string' &&
      typeof job.metadata.uid === 'string' &&
      labels?.['app.kubernetes.io/component'] === 'code-sandbox' &&
      labels['app.kubernetes.io/managed-by'] === 'kagent-tool-gateway' &&
      labels[SANDBOX_TASK_LABEL] === task.taskUid &&
      labels['kagent.knuteson.io/agent'] === task.agentName &&
      Object.entries(labels).every(
        ([key, value]) => job.spec?.template.metadata?.labels?.[key] === value,
      ) &&
      pod?.automountServiceAccountToken === false &&
      pod.containers.length === 1 &&
      worker?.name === 'sandbox' &&
      JSON.stringify(worker.command) ===
        JSON.stringify(['node', '/app/packages/tool-gateway/dist/sandbox-worker.js']) &&
      worker.env?.filter((entry) => entry.name === 'KAGENT_SANDBOX_TOKEN').length === 1 &&
      /^[0-9a-f]{64}$/.test(
        worker.env.find((entry) => entry.name === 'KAGENT_SANDBOX_TOKEN')?.value ?? '',
      )
    );
  }

  function terminal(job: V1Job): boolean {
    return (
      job.status?.conditions?.some(
        (condition) =>
          (condition.type === 'Complete' || condition.type === 'Failed') &&
          condition.status === 'True',
      ) ?? false
    );
  }

  async function acquire(task: ToolGatewayTaskIdentity): Promise<Sandbox> {
    const deadline = Date.now() + readyTimeoutMs;
    const previousJobUid = lastJobUids.get(task.taskUid);
    let workspaceRecreated = false;
    // Stable creation identity prevents two rolling gateway instances from creating
    // separate workspaces. Legacy random names remain discoverable and reusable.
    const name = `kagent-sbx-${createHash('sha256').update(task.taskUid).digest('hex').slice(0, 40)}`;
    while (Date.now() < deadline) {
      const jobs = (await options.kube.listTaskJobs(options.namespace, task.taskUid)).filter(
        (job) => owned(job, task),
      );
      const active = jobs.filter((job) => !terminal(job));
      if (active.length > 1)
        throw new Error(
          `code_sandbox_unavailable: multiple owned sandboxes for task ${task.taskUid}; preserved`,
        );
      if (active.length === 1) {
        const job = active[0]!;
        if (!job.metadata!.deletionTimestamp) {
          const ip = await options.kube.runningPodIp(
            options.namespace,
            job.metadata!.name!,
            job.metadata!.uid!,
          );
          if (ip !== undefined) {
            const token = job.spec!.template.spec!.containers[0]!.env!.find(
              (entry) => entry.name === 'KAGENT_SANDBOX_TOKEN',
            )!.value!;
            const sandbox = {
              url: `http://${ip}:${String(SANDBOX_PORT)}`,
              token,
              jobUid: job.metadata!.uid!,
              workspaceRecreated:
                workspaceRecreated ||
                (previousJobUid !== undefined && previousJobUid !== job.metadata!.uid),
            };
            if (await healthy(sandbox)) return sandbox;
          }
        }
        // A transient outage does not establish that emptyDir was lost.
        await sleep(1000);
        continue;
      }
      for (const job of jobs) {
        // Keep evidence of terminal loss even if replacement readiness later fails.
        if (!lastJobUids.has(task.taskUid)) lastJobUids.set(task.taskUid, job.metadata!.uid!);
        await options.kube.deleteJob(options.namespace, job.metadata!.name!, job.metadata!.uid!);
        workspaceRecreated = true;
      }
      const token = randomBytes(32).toString('hex');
      try {
        await options.kube.createJob(options.namespace, sandboxJob(options, task, name, token));
      } catch (err) {
        // Another gateway may have won creation; recover its original token.
        const status =
          err !== null && typeof err === 'object'
            ? (err as { code?: number; statusCode?: number })
            : {};
        if (status.code !== 409 && status.statusCode !== 409) throw err;
        await sleep(1000);
      }
    }
    throw new Error(
      `code_sandbox_unavailable: task ${task.taskUid} sandbox not ready in ${String(readyTimeoutMs)} ms; existing Jobs preserved${workspaceRecreated ? '; previous terminal workspace unavailable' : ''}`,
    );
  }

  async function ensure(task: ToolGatewayTaskIdentity): Promise<Sandbox> {
    const known = sandboxes.get(task.taskUid);
    if (known !== undefined) {
      const sandbox = await known.catch(() => undefined);
      if (sandbox !== undefined && (await healthy(sandbox))) return sandbox;
      sandboxes.delete(task.taskUid);
    }
    const acquired = acquire(task).then((sandbox) => {
      lastJobUids.set(task.taskUid, sandbox.jobUid);
      return sandbox;
    });
    sandboxes.set(task.taskUid, acquired);
    acquired.catch(() => {
      if (sandboxes.get(task.taskUid) === acquired) sandboxes.delete(task.taskUid);
    });
    return acquired;
  }

  async function call<T>(task: ToolGatewayTaskIdentity, op: SandboxOp, arg: unknown): Promise<T> {
    const sandbox = await ensure(task);
    if (sandbox.workspaceRecreated && !reportedLoss.has(sandbox)) {
      reportedLoss.add(sandbox);
      throw new Error(
        'workspace_recreated: previous sandbox workspace is unavailable; its emptyDir files were not preserved. A fresh workspace is ready; restore committed files before continuing.',
      );
    }
    const response = await fetchImpl(`${sandbox.url}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sandbox.token}` },
      body: JSON.stringify({ op, arg }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: unknown;
      error?: string;
    };
    if (!response.ok || body.ok !== true) {
      throw new Error(body.error ?? `code sandbox ${String(response.status)}`);
    }
    return body.result as T;
  }

  return (task): ToolGatewayCodeRunner => ({
    executeCode: (input: ExecuteCodeInput) => call<CommandResult>(task, 'executeCode', input),
    executeCommand: (input: ExecuteCommandInput) =>
      call<CommandResult>(task, 'executeCommand', input),
    startCommand: (input: ExecuteCommandInput) => call<StartedCommand>(task, 'startCommand', input),
    stopTask: (taskId: string) => call<CommandResult>(task, 'stopTask', taskId),
    readFiles: (paths: readonly string[]) =>
      call<readonly CodeRunnerReadResult[]>(task, 'readFiles', paths),
    writeFiles: (files: readonly CodeRunnerFile[]) => call<void>(task, 'writeFiles', files),
    listFiles: (root?: string) => call<readonly CodeRunnerListEntry[]>(task, 'listFiles', root),
  });
}
