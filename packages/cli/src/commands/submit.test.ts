/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import type {
  AgentTaskCreated,
  AgentTaskStatus,
  CreateAgentTaskInput,
  KubeClient,
} from '../k8s-client.js';
import { submitTask, waitForTask } from './submit.js';

function makeClient(opts: {
  readonly contextNamespace?: string;
  readonly statusSequence?: readonly (AgentTaskStatus | undefined)[];
  readonly throwOnCreate?: Error;
}): KubeClient & {
  readonly createCalls: readonly CreateAgentTaskInput[];
  readonly statusCalls: readonly { ns: string; name: string }[];
} {
  const createCalls: CreateAgentTaskInput[] = [];
  const statusCalls: { ns: string; name: string }[] = [];
  let cursor = 0;
  const seq = opts.statusSequence ?? [];
  return {
    currentContextNamespace: opts.contextNamespace,
    clusterServer: 'https://test.invalid:6443',
    createCalls,
    statusCalls,
    createTask(input: CreateAgentTaskInput): Promise<AgentTaskCreated> {
      if (opts.throwOnCreate !== undefined) return Promise.reject(opts.throwOnCreate);
      createCalls.push(input);
      return Promise.resolve({
        namespace: input.namespace,
        name: input.name,
        uid: `uid-${input.name}`,
        creationTimestamp: '2026-05-01T15:00:00Z',
      });
    },
    getTaskStatus(ns: string, name: string): Promise<AgentTaskStatus | undefined> {
      statusCalls.push({ ns, name });
      const next = seq[cursor];
      cursor++;
      return Promise.resolve(next);
    },
  };
}

describe('submitTask', () => {
  it('creates an AgentTask with the correct manifest and exits 0 (no --wait)', async () => {
    const client = makeClient({ contextNamespace: 'kagent-system' });
    const stdout: string[] = [];
    const result = await submitTask({
      targetAgent: 'smoke-test',
      prompt: 'What is etcd?',
      generateName: () => 'cli-fixed01',
      stdout: (line) => stdout.push(line),
      client,
    });
    expect(result.exitCode).toBe(0);
    expect(client.createCalls.length).toBe(1);
    const call = client.createCalls[0]!;
    expect(call.namespace).toBe('kagent-system');
    expect(call.name).toBe('cli-fixed01');
    expect(call.targetAgent).toBe('smoke-test');
    expect(call.originalUserMessage).toBe('What is etcd?');
    expect(stdout.join('\n')).toContain('Created AgentTask kagent-system/cli-fixed01');
  });

  it('threads --timeout into runConfig', async () => {
    const client = makeClient({ contextNamespace: 'kagent-system' });
    await submitTask({
      targetAgent: 'smoke-test',
      prompt: 'hi',
      timeoutSeconds: 120,
      generateName: () => 'cli-t',
      stdout: () => {},
      client,
    });
    expect(client.createCalls[0]?.runConfig).toEqual({ timeoutSeconds: 120 });
  });

  it('falls back to namespace=default when kubeconfig has no current namespace', async () => {
    const client = makeClient({});
    await submitTask({
      targetAgent: 'smoke-test',
      prompt: 'hi',
      generateName: () => 'cli-t',
      stdout: () => {},
      client,
    });
    expect(client.createCalls[0]?.namespace).toBe('default');
  });

  it('emits JSON to stdout when --json is set (no --wait)', async () => {
    const client = makeClient({ contextNamespace: 'kagent-system' });
    const stdout: string[] = [];
    await submitTask({
      targetAgent: 'smoke-test',
      prompt: 'hi',
      json: true,
      generateName: () => 'cli-j',
      stdout: (line) => stdout.push(line),
      client,
    });
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0]!) as { created: AgentTaskCreated };
    expect(parsed.created.name).toBe('cli-j');
  });

  it('--wait blocks until terminal and exits 0 on Completed', async () => {
    const client = makeClient({
      contextNamespace: 'kagent-system',
      statusSequence: [
        { phase: 'Pending' },
        { phase: 'Dispatched', podName: 'pod-x' },
        { phase: 'Completed', result: { content: 'etcd is a key-value store' } },
      ],
    });
    const stdout: string[] = [];
    const result = await submitTask({
      targetAgent: 'smoke-test',
      prompt: 'hi',
      wait: true,
      pollIntervalMs: 1,
      waitTimeoutMs: 5000,
      generateName: () => 'cli-w',
      stdout: (line) => stdout.push(line),
      client,
    });
    expect(result.exitCode).toBe(0);
    expect(result.final?.phase).toBe('Completed');
    expect(stdout.some((l) => l.includes('phase=Pending'))).toBe(true);
    expect(stdout.some((l) => l.includes('phase=Dispatched'))).toBe(true);
    expect(stdout.some((l) => l.includes('phase=Completed'))).toBe(true);
    expect(stdout.some((l) => l.includes('etcd is a key-value store'))).toBe(true);
  });

  it('--wait exits 1 on Failed', async () => {
    const client = makeClient({
      contextNamespace: 'kagent-system',
      statusSequence: [{ phase: 'Failed', error: 'deadline exceeded' }],
    });
    const stderr: string[] = [];
    const result = await submitTask({
      targetAgent: 'smoke-test',
      prompt: 'hi',
      wait: true,
      pollIntervalMs: 1,
      waitTimeoutMs: 5000,
      generateName: () => 'cli-f',
      stdout: () => {},
      stderr: (line) => stderr.push(line),
      client,
    });
    expect(result.exitCode).toBe(1);
    expect(stderr.some((l) => l.includes('Failed'))).toBe(true);
  });

  it('--wait exits 2 on timeout', async () => {
    const client = makeClient({
      contextNamespace: 'kagent-system',
      statusSequence: [{ phase: 'Pending' }, { phase: 'Pending' }, { phase: 'Pending' }],
    });
    const stderr: string[] = [];
    const result = await submitTask({
      targetAgent: 'smoke-test',
      prompt: 'hi',
      wait: true,
      pollIntervalMs: 1,
      waitTimeoutMs: 5,
      generateName: () => 'cli-to',
      stdout: () => {},
      stderr: (line) => stderr.push(line),
      client,
    });
    expect(result.exitCode).toBe(2);
    expect(stderr.some((l) => l.includes('timed out'))).toBe(true);
  });
});

describe('waitForTask', () => {
  it('returns undefined when no terminal phase reached before timeout', async () => {
    const client = makeClient({
      statusSequence: [{ phase: 'Pending' }, { phase: 'Pending' }],
    });
    const result = await waitForTask(client, 'kagent-system', 'task', {
      pollIntervalMs: 1,
      waitTimeoutMs: 5,
    });
    expect(result).toBeUndefined();
  });
});
