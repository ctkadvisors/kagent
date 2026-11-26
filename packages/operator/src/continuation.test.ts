/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { CustomObjectsApi } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';

import {
  CHECKPOINT_MEDIA_TYPE,
  continuationEnv,
  maxContinuations,
  planContinuation,
} from './continuation.js';
import type { Agent, AgentTask } from './crds/index.js';
import { maybeContinue } from './main.js';

const now = new Date('2026-11-26T19:20:00Z');
const SUM = `sha256:${'a'.repeat(64)}`;

const agent = (max?: string): Agent =>
  ({
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'Agent',
    metadata: {
      name: 'fleet-inventor',
      namespace: 'kagent-system',
      ...(max !== undefined && {
        annotations: { 'kagent.knuteson.io/max-continuations': max },
      }),
    },
    spec: {},
  }) as unknown as Agent;

const failed = (over: {
  name?: string;
  error?: string;
  annotations?: Record<string, string>;
  parentTask?: string;
  completedAt?: string;
  artifacts?: unknown[];
  payload?: unknown;
}): AgentTask =>
  ({
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'AgentTask',
    metadata: {
      name: over.name ?? 'fleet-nightly-invention-1795705500',
      namespace: 'kagent-system',
      uid: 'uid-first',
      labels: {
        'kagent.knuteson.io/trigger-kind': 'schedule',
        'kagent.knuteson.io/trigger-name': 'fleet-nightly-invention',
      },
      annotations: {
        'kagent.knuteson.io/placeholder-cap': 'wave0-shared-all-rights',
        'kagent.knuteson.io/triggered-at': '2026-11-26T15:05:00.000Z',
        'kagent.knuteson.io/template-candidate': 'check-x',
        ...over.annotations,
      },
    },
    spec: {
      targetAgent: 'fleet-inventor',
      payload: over.payload ?? { text: 'invent' },
      runConfig: { timeoutSeconds: 14400, maxIterations: 300 },
      ...(over.parentTask !== undefined && { parentTask: over.parentTask }),
    },
    status: {
      phase: 'Failed',
      error: over.error ?? 'task time limit reached (timeoutSeconds 14400)',
      completedAt: over.completedAt ?? '2026-11-26T19:05:46Z',
      artifacts: over.artifacts ?? [
        {
          uri: 'pvc://kagent-artifacts/uid-first/.kagent/checkpoint.json',
          name: '.kagent/checkpoint.json',
          mediaType: CHECKPOINT_MEDIA_TYPE,
          checksum: SUM,
        },
      ],
    },
  }) as unknown as AgentTask;

const skip = (task: AgentTask, a: Agent = agent('2')): string => {
  const plan = planContinuation(task, a, now);
  return 'skip' in plan ? plan.skip : `CONTINUED as ${plan.continuation.metadata.name}`;
};

describe('planContinuation', () => {
  it('continues a task that hit its time limit, carrying its work, labels and checkpoint digest', () => {
    const plan = planContinuation(failed({}), agent('2'), now);
    if (!('continuation' in plan)) throw new Error(plan.skip);
    expect(plan.continuation.metadata).toEqual({
      name: 'fleet-nightly-invention-1795705500-cont1',
      namespace: 'kagent-system',
      labels: {
        'kagent.knuteson.io/trigger-kind': 'schedule',
        'kagent.knuteson.io/trigger-name': 'fleet-nightly-invention',
      },
      annotations: {
        'kagent.knuteson.io/placeholder-cap': 'wave0-shared-all-rights',
        'kagent.knuteson.io/continues-uid': 'uid-first',
        'kagent.knuteson.io/continues-name': 'fleet-nightly-invention-1795705500',
        'kagent.knuteson.io/continues-reason': 'task time limit reached (timeoutSeconds 14400)',
        'kagent.knuteson.io/continuation-index': '1',
        'kagent.knuteson.io/continues-checksum': SUM,
      },
    });
    expect(plan.continuation.spec).toEqual(failed({}).spec);
  });

  it('continues the other failures more time would fix', () => {
    for (const error of [
      'agent stopped after reaching maxIterations before producing final assistant content',
      'cancelled: SIGTERM received',
      '[pod/PodFailed] Pod kat-abc-xyz reached phase=Failed',
    ]) {
      expect(skip(failed({ error })), error).toMatch(/^CONTINUED/);
    }
  });

  it('does not continue what more time would not fix, or what nobody asked to continue', () => {
    expect(skip(failed({ error: 'LLM backend returned HTTP 502' }))).toBe('failure-not-resumable');
    expect(
      skip(failed({ error: 'context_window_substrate_refused: context=65674 window=65536' })),
    ).toBe('failure-not-resumable');
    expect(skip(failed({}), agent())).toBe('agent-not-opted-in');
    expect(skip(failed({}), agent('0'))).toBe('agent-not-opted-in');
    expect(skip(failed({ completedAt: '2026-11-26T17:00:00Z' }))).toBe('finished-too-long-ago');
    const done = failed({});
    (done.status as { phase: string }).phase = 'Completed';
    expect(skip(done)).toBe('not-failed');
  });

  it('counts continuations along the chain and stops at the Agent limit', () => {
    const first = failed({
      name: 'fleet-nightly-invention-1795705500-cont1',
      annotations: { 'kagent.knuteson.io/continuation-index': '1' },
    });
    expect(skip(first)).toBe('CONTINUED as fleet-nightly-invention-1795705500-cont2');
    const second = failed({
      name: 'fleet-nightly-invention-1795705500-cont2',
      annotations: { 'kagent.knuteson.io/continuation-index': '2' },
    });
    expect(skip(second)).toBe('continuations-exhausted');
    expect(maxContinuations(agent('99'))).toBe(5);
  });

  it('keeps the name within 63 characters and drops a deadline that has passed', () => {
    const plan = planContinuation(
      failed({
        name: 'a'.repeat(63),
        payload: { text: 'x', execution_deadline_at: '2026-11-26T19:00:00Z' },
      }),
      agent('1'),
      now,
    );
    if (!('continuation' in plan)) throw new Error(plan.skip);
    expect(plan.continuation.metadata.name).toHaveLength(63);
    expect(plan.continuation.metadata.name.endsWith('-cont1')).toBe(true);
    expect(plan.continuation.spec.payload).toEqual({ text: 'x' });
  });

  it('continues without a digest when the pod never reported a checkpoint', () => {
    const plan = planContinuation(failed({ artifacts: [] }), agent('1'), now);
    if (!('continuation' in plan)) throw new Error(plan.skip);
    expect('kagent.knuteson.io/continues-checksum' in plan.continuation.metadata.annotations).toBe(
      false,
    );
  });
});

describe('a child task', () => {
  it('is continued as a sibling under the same parent', () => {
    const child = failed({ parentTask: 'uid-parent', name: 'inv-1-c-abc123' });
    (child.metadata as { ownerReferences?: unknown }).ownerReferences = [
      {
        apiVersion: 'kagent.knuteson.io/v1alpha1',
        kind: 'AgentTask',
        name: 'inv-1',
        uid: 'uid-parent',
      },
    ];
    const plan = planContinuation(child, agent('1'), now);
    if (!('continuation' in plan)) throw new Error(plan.skip);
    expect(plan.continuation.metadata.name).toBe('inv-1-c-abc123-cont1');
    expect(plan.continuation.spec.parentTask).toBe('uid-parent');
    expect(plan.continuation.metadata.ownerReferences).toEqual([
      {
        apiVersion: 'kagent.knuteson.io/v1alpha1',
        kind: 'AgentTask',
        name: 'inv-1',
        uid: 'uid-parent',
      },
    ]);
    // A root task has no owner to carry.
    const root = planContinuation(failed({}), agent('1'), now);
    expect('continuation' in root && 'ownerReferences' in root.continuation.metadata).toBe(false);
  });
});

describe('continuationEnv', () => {
  it('hands the pod the task to resume, its digest and why it stopped', () => {
    const plan = planContinuation(failed({}), agent('1'), now);
    if (!('continuation' in plan)) throw new Error(plan.skip);
    expect(continuationEnv(plan.continuation)).toEqual([
      { name: 'KAGENT_CONTINUES_TASK_UID', value: 'uid-first' },
      { name: 'KAGENT_CONTINUES_CHECKSUM', value: SUM },
      { name: 'KAGENT_CONTINUES_REASON', value: 'task time limit reached (timeoutSeconds 14400)' },
    ]);
    expect(continuationEnv(failed({}))).toEqual([]);
  });
});

describe('maybeContinue', () => {
  const api = (a: Agent, create = vi.fn(() => Promise.resolve({}))) => ({
    api: {
      getNamespacedCustomObject: vi.fn(() => Promise.resolve(a)),
      createNamespacedCustomObject: create,
    } as unknown as CustomObjectsApi,
    create,
  });

  it('creates the continuation task once; a repeat event finds it there', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const first = api(agent('2'));
    expect(await maybeContinue(failed({}), { customApi: first.api }, now)).toBe('continued');
    expect(first.create.mock.calls[0]?.[0]).toMatchObject({
      plural: 'agenttasks',
      namespace: 'kagent-system',
      body: { metadata: { name: 'fleet-nightly-invention-1795705500-cont1' } },
    });
    const again = api(
      agent('2'),
      vi.fn(() => Promise.reject(Object.assign(new Error('exists'), { code: 409 }))),
    );
    expect(await maybeContinue(failed({}), { customApi: again.api }, now)).toBe('exists');
    log.mockRestore();
  });

  it('creates nothing for an Agent that did not opt in, and never throws', async () => {
    const quiet = api(agent());
    expect(await maybeContinue(failed({}), { customApi: quiet.api }, now)).toBe('skipped');
    expect(quiet.create).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = api(
      agent('2'),
      vi.fn(() => Promise.reject(new Error('apiserver down'))),
    );
    expect(await maybeContinue(failed({}), { customApi: broken.api }, now)).toBe('skipped');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
