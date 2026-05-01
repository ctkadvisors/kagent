/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `kagent submit` — create an AgentTask and (optionally) wait for it
 * to reach a terminal phase.
 *
 * Usage:
 *   kagent submit <agent> "<prompt>" [--namespace <ns>] [--timeout <sec>]
 *                                    [--name <name>] [--wait] [--json]
 */

import {
  createKubeClient,
  type AgentTaskCreated,
  type AgentTaskStatus,
  type KubeClient,
} from '../k8s-client.js';

export interface SubmitOptions {
  readonly targetAgent: string;
  readonly prompt: string;
  readonly namespace?: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
  readonly wait?: boolean;
  readonly json?: boolean;
  /** Test-injectable client; production builds one from kubeconfig. */
  readonly client?: KubeClient;
  /**
   * Test-injectable identity generator. Production uses a small
   * crypto.getRandomValues-backed nanoid-like impl.
   */
  readonly generateName?: () => string;
  /** Test-injectable poll interval (ms). Default 2000. */
  readonly pollIntervalMs?: number;
  /** Test-injectable wait timeout (ms). Default 10 min. */
  readonly waitTimeoutMs?: number;
  /** Optional logger override (default = console.log/console.error). */
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export interface SubmitResult {
  readonly created: AgentTaskCreated;
  readonly final?: AgentTaskStatus;
  readonly exitCode: number;
}

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';

function defaultGenerateName(): string {
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += ALPHA[b % ALPHA.length];
  return `cli-${s}`;
}

export async function submitTask(opts: SubmitOptions): Promise<SubmitResult> {
  const stdout = opts.stdout ?? ((line: string): void => console.log(line));
  const stderr = opts.stderr ?? ((line: string): void => console.error(line));
  const client = opts.client ?? createKubeClient();
  const namespace = opts.namespace ?? client.currentContextNamespace ?? 'default';
  const name = opts.name ?? (opts.generateName ?? defaultGenerateName)();

  const created = await client.createTask({
    namespace,
    name,
    targetAgent: opts.targetAgent,
    originalUserMessage: opts.prompt,
    ...(opts.timeoutSeconds !== undefined && {
      runConfig: { timeoutSeconds: opts.timeoutSeconds },
    }),
  });

  if (opts.json !== true) {
    stdout(`Created AgentTask ${created.namespace}/${created.name} (uid: ${created.uid})`);
  }

  if (opts.wait !== true) {
    if (opts.json === true) {
      stdout(JSON.stringify({ created }));
    }
    return { created, exitCode: 0 };
  }

  const onPhaseChange =
    opts.json === true
      ? undefined
      : (phase: string, podName: string | undefined): void => {
          const podSuffix = podName !== undefined ? ` (pod: ${podName})` : '';
          stdout(`  phase=${phase}${podSuffix}`);
        };
  const final = await waitForTask(client, created.namespace, created.name, {
    pollIntervalMs: opts.pollIntervalMs ?? 2000,
    waitTimeoutMs: opts.waitTimeoutMs ?? 10 * 60_000,
    ...(onPhaseChange !== undefined && { onPhaseChange }),
  });

  if (final === undefined) {
    stderr(`timed out waiting for ${created.namespace}/${created.name} to reach a terminal phase`);
    if (opts.json === true) {
      stdout(JSON.stringify({ created, timedOut: true }));
    }
    return { created, exitCode: 2 };
  }

  if (opts.json === true) {
    stdout(JSON.stringify({ created, final }));
  } else if (final.phase === 'Completed') {
    stdout(`✔ Completed`);
    if (final.result?.content !== undefined) {
      stdout('');
      stdout(final.result.content);
    }
  } else if (final.phase === 'Failed') {
    stderr(`✗ Failed: ${final.error ?? '(no error message)'}`);
  }

  return {
    created,
    final,
    exitCode: final.phase === 'Completed' ? 0 : 1,
  };
}

export interface WaitOptions {
  readonly pollIntervalMs: number;
  readonly waitTimeoutMs: number;
  readonly onPhaseChange?: (phase: string, podName: string | undefined) => void;
}

export async function waitForTask(
  client: KubeClient,
  namespace: string,
  name: string,
  opts: WaitOptions,
): Promise<AgentTaskStatus | undefined> {
  const deadline = Date.now() + opts.waitTimeoutMs;
  let lastPhase: string | undefined;
  while (Date.now() < deadline) {
    const status = await client.getTaskStatus(namespace, name);
    if (status !== undefined) {
      const phase = status.phase ?? 'Pending';
      if (phase !== lastPhase) {
        opts.onPhaseChange?.(phase, status.podName);
        lastPhase = phase;
      }
      if (phase === 'Completed' || phase === 'Failed') return status;
    }
    await sleep(opts.pollIntervalMs);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
