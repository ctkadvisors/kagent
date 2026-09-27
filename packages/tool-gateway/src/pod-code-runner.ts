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
 * token and no env of the gateway's; only the gateway knows its bearer token.
 */

import { randomBytes } from 'node:crypto';

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

/** The three Kubernetes calls a sandbox needs; the real one is kube-jobs.ts. */
export interface SandboxKube {
  createJob(namespace: string, job: Record<string, unknown>): Promise<void>;
  /** Delete every sandbox Job of this task (a gateway restart forgets their tokens). */
  deleteTaskJobs(namespace: string, taskUid: string): Promise<void>;
  /** The IP of the Job's running pod, or undefined while it is not running yet. */
  runningPodIp(namespace: string, jobName: string): Promise<string | undefined>;
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
  readonly readyTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Sandbox {
  readonly url: string;
  readonly token: string;
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

  async function healthy(sandbox: Sandbox): Promise<boolean> {
    try {
      return (await fetchImpl(`${sandbox.url}/healthz`)).ok;
    } catch {
      return false;
    }
  }

  async function create(task: ToolGatewayTaskIdentity): Promise<Sandbox> {
    const token = randomBytes(32).toString('hex');
    const name = `kagent-sbx-${task.taskUid.slice(0, 36)}-${randomBytes(3).toString('hex')}`
      .toLowerCase()
      .slice(0, 63);
    await options.kube.deleteTaskJobs(options.namespace, task.taskUid);
    await options.kube.createJob(options.namespace, sandboxJob(options, task, name, token));
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      const ip = await options.kube.runningPodIp(options.namespace, name);
      if (ip !== undefined) {
        const sandbox = { url: `http://${ip}:${String(SANDBOX_PORT)}`, token };
        if (await healthy(sandbox)) return sandbox;
      }
      await sleep(1000);
    }
    throw new Error(
      `code sandbox for task ${task.taskUid} was not ready in ${String(readyTimeoutMs)} ms`,
    );
  }

  async function ensure(task: ToolGatewayTaskIdentity): Promise<Sandbox> {
    const known = sandboxes.get(task.taskUid);
    if (known !== undefined) {
      const sandbox = await known.catch(() => undefined);
      if (sandbox !== undefined && (await healthy(sandbox))) return sandbox;
      sandboxes.delete(task.taskUid);
    }
    const created = create(task);
    sandboxes.set(task.taskUid, created);
    created.catch(() => sandboxes.delete(task.taskUid));
    return created;
  }

  async function call<T>(task: ToolGatewayTaskIdentity, op: SandboxOp, arg: unknown): Promise<T> {
    const sandbox = await ensure(task);
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
