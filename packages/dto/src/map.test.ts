/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import type { V1Job, V1Pod } from '@kubernetes/client-node';

import { type Agent, type AgentTask, type AgentTaskPhase, type AgentTaskStatus } from './crds.js';
import { agentSummary, podFailureSummary, taskDetail, taskSummary, traceLink } from './map.js';

/* =====================================================================
 * Fixture builders
 * ===================================================================== */

function makeTask(overrides: {
  name?: string;
  uid?: string;
  namespace?: string;
  phase?: AgentTaskPhase;
  status?: AgentTaskStatus;
  spec?: Partial<AgentTask['spec']>;
}): AgentTask {
  const baseStatus = overrides.status;
  const merged: AgentTaskStatus | undefined =
    baseStatus !== undefined
      ? baseStatus
      : overrides.phase !== undefined
        ? { phase: overrides.phase }
        : undefined;

  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'AgentTask',
    metadata: {
      name: overrides.name ?? 'task-fixture',
      namespace: overrides.namespace ?? 'kagent-system',
      uid: overrides.uid ?? '9b1a8c4e-fixture',
      creationTimestamp: new Date('2026-04-26T12:00:00Z'),
    },
    spec: {
      targetAgent: 'researcher',
      payload: { topic: 'kata-containers' },
      ...overrides.spec,
    },
    ...(merged !== undefined && { status: merged }),
  };
}

function makeAgent(overrides: Partial<Agent['spec']> & { name?: string } = {}): Agent {
  const { name, ...spec } = overrides;
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'Agent',
    metadata: { name: name ?? 'researcher', namespace: 'kagent-system' },
    spec: {
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      tools: ['fetch_url'],
      capabilities: ['research'],
      sandboxProfile: 'default',
      ...spec,
    },
  };
}

function jobWithCondition(
  type: string,
  status: 'True' | 'False',
  extras: Partial<{ reason: string; message: string }> = {},
): V1Job {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'kat-9b1a-job', namespace: 'kagent-system' },
    spec: { backoffLimit: 0, template: { spec: { containers: [] } } },
    status: {
      conditions: [
        {
          type,
          status,
          lastTransitionTime: new Date('2026-04-26T12:01:00Z'),
          ...extras,
        },
      ],
    },
  };
}

function podWithImagePullBackOff(): V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'kat-9b1a-job-xyz', namespace: 'kagent-system' },
    spec: { containers: [{ name: 'agent', image: 'ghcr.io/missing:tag' }] },
    status: {
      phase: 'Pending',
      conditions: [
        {
          type: 'PodScheduled',
          status: 'True',
          lastTransitionTime: new Date('2026-04-26T12:00:30Z'),
        },
      ],
      containerStatuses: [
        {
          name: 'agent',
          image: 'ghcr.io/missing:tag',
          imageID: '',
          ready: false,
          restartCount: 0,
          started: false,
          state: {
            waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image' },
          },
        },
      ],
    },
  };
}

/* =====================================================================
 * taskSummary — phase coverage
 * ===================================================================== */

describe('taskSummary', () => {
  it('handles a Pending task with no status block', () => {
    const t = makeTask({ name: 'pending-task' });
    const s = taskSummary(t);
    expect(s).toMatchObject({
      name: 'pending-task',
      namespace: 'kagent-system',
      uid: '9b1a8c4e-fixture',
      targetAgent: 'researcher',
    });
    expect(s.phase).toBeUndefined();
    expect(s.error).toBeUndefined();
    expect(s.suspicious).toBeUndefined();
    expect(s.createdAt).toBe('2026-04-26T12:00:00.000Z');
  });

  it('handles a Dispatched (in-progress) task', () => {
    const t = makeTask({
      phase: 'Dispatched',
      status: {
        phase: 'Dispatched',
        startedAt: '2026-04-26T12:00:30Z',
        podName: 'kat-9b1a-job-xyz',
      },
    });
    expect(taskSummary(t)).toMatchObject({
      phase: 'Dispatched',
      startedAt: '2026-04-26T12:00:30Z',
      podName: 'kat-9b1a-job-xyz',
    });
  });

  it('surfaces model from a supplied Agent fixture', () => {
    const t = makeTask({});
    const a = makeAgent();
    expect(taskSummary(t, { agent: a }).model).toBe(
      'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    );
  });

  it('handles a Completed task with non-vacuous result + no suspicious tags', () => {
    const t = makeTask({
      status: {
        phase: 'Completed',
        startedAt: '2026-04-26T12:00:30Z',
        completedAt: '2026-04-26T12:02:11Z',
        result: { content: 'Kata Containers is a runtime that...' },
        structuralVerdict: { suspicious: [] },
      },
    });
    const s = taskSummary(t);
    expect(s.phase).toBe('Completed');
    expect(s.suspicious).toEqual([]);
    expect(s.completedAt).toBe('2026-04-26T12:02:11Z');
  });

  it('surfaces structuralVerdict.suspicious tags into the summary', () => {
    const t = makeTask({
      status: {
        phase: 'Completed',
        result: { content: 'partial' },
        structuralVerdict: { suspicious: ['F1', 'synthesis_low_yield'] },
      },
    });
    expect(taskSummary(t).suspicious).toEqual(['F1', 'synthesis_low_yield']);
  });

  it('handles a Failed task with operator-set error message', () => {
    const t = makeTask({
      status: {
        phase: 'Failed',
        error: 'Job kat-9b1a-job reached condition Failed=True',
        completedAt: '2026-04-26T12:05:00Z',
      },
    });
    const s = taskSummary(t);
    expect(s.phase).toBe('Failed');
    expect(s.error).toContain('Failed=True');
  });

  it('omits all optional fields when status is undefined (defensive)', () => {
    const t = makeTask({});
    const s = taskSummary(t);
    expect(Object.hasOwn(s, 'phase')).toBe(false);
    expect(Object.hasOwn(s, 'error')).toBe(false);
    expect(Object.hasOwn(s, 'suspicious')).toBe(false);
    expect(Object.hasOwn(s, 'podName')).toBe(false);
  });
});

/* =====================================================================
 * taskDetail — phase coverage + heavy-fields surfacing
 * ===================================================================== */

describe('taskDetail', () => {
  it('inherits all summary fields and adds heavy-payload fields', () => {
    const t = makeTask({
      spec: {
        originalUserMessage: 'research kata containers',
        parentDistillation: 'user wants a brief on Kata',
        expectedTools: ['fetch_url', 'web_search'],
      },
      status: {
        phase: 'Completed',
        result: { content: 'Brief: ...' },
        structuralVerdict: { suspicious: [] },
      },
    });
    const d = taskDetail(t);
    expect(d.originalUserMessage).toBe('research kata containers');
    expect(d.parentDistillation).toBe('user wants a brief on Kata');
    expect(d.expectedTools).toEqual(['fetch_url', 'web_search']);
    expect(d.result).toEqual({ content: 'Brief: ...' });
    expect(d.payload).toEqual({ topic: 'kata-containers' });
    expect(d.containerStatuses).toEqual([]);
    expect(d.eventsSummary).toEqual([]);
  });

  it('forwards container statuses from the supplied Pod', () => {
    const t = makeTask({ status: { phase: 'Failed' } });
    const pod = podWithImagePullBackOff();
    const d = taskDetail(t, { pod });
    expect(d.containerStatuses).toHaveLength(1);
    expect(d.containerStatuses[0]?.name).toBe('agent');
    expect(d.containerStatuses[0]?.state?.waiting?.reason).toBe('ImagePullBackOff');
  });

  it('threads opts.events through as the eventsSummary placeholder', () => {
    const t = makeTask({});
    const d = taskDetail(t, {
      events: [
        {
          type: 'Warning',
          reason: 'BackOff',
          message: 'Back-off pulling image',
          lastTimestamp: '2026-04-26T12:01:30Z',
        },
      ],
    });
    expect(d.eventsSummary).toHaveLength(1);
    expect(d.eventsSummary[0]?.reason).toBe('BackOff');
  });
});

/* =====================================================================
 * agentSummary
 * ===================================================================== */

describe('agentSummary', () => {
  it('maps base fields with defaults when sandboxProfile is unset', () => {
    const a = makeAgent({ sandboxProfile: undefined });
    expect(agentSummary(a)).toMatchObject({
      name: 'researcher',
      namespace: 'kagent-system',
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      sandboxProfile: 'default',
      capabilities: ['research'],
      tools: ['fetch_url'],
      recentTaskCounts: { pending: 0, dispatched: 0, completed: 0, failed: 0 },
    });
  });

  it('counts tasks by phase when a snapshot is supplied', () => {
    const a = makeAgent();
    const tasks: AgentTask[] = [
      makeTask({ name: 'a', uid: 'u1', phase: 'Pending' }),
      makeTask({ name: 'b', uid: 'u2', phase: 'Dispatched' }),
      makeTask({ name: 'c', uid: 'u3', phase: 'Completed' }),
      makeTask({ name: 'd', uid: 'u4', phase: 'Completed' }),
      makeTask({ name: 'e', uid: 'u5', phase: 'Failed' }),
      // Different agent — must not be counted
      makeTask({ name: 'f', uid: 'u6', phase: 'Failed', spec: { targetAgent: 'other' } }),
    ];
    expect(agentSummary(a, { tasks }).recentTaskCounts).toEqual({
      pending: 1,
      dispatched: 1,
      completed: 2,
      failed: 1,
    });
  });

  it('counts a task with undefined phase as pending (operator unobserved)', () => {
    const a = makeAgent();
    const tasks: AgentTask[] = [makeTask({ name: 'unseen', uid: 'u' })];
    expect(agentSummary(a, { tasks }).recentTaskCounts.pending).toBe(1);
  });
});

/* =====================================================================
 * podFailureSummary
 * ===================================================================== */

describe('podFailureSummary', () => {
  it('returns null when Job + Pod are both healthy', () => {
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'kat-1' },
      status: { active: 1 },
    };
    const pod: V1Pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'kat-1-xyz' },
      status: { phase: 'Running' },
    };
    expect(podFailureSummary(job, pod)).toBeNull();
  });

  it('flags ImagePullBackOff via Pod fixture and surfaces container name', () => {
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'kat-9b1a-job' },
      status: { active: 1 },
    };
    const pod = podWithImagePullBackOff();
    const s = podFailureSummary(job, pod);
    expect(s).not.toBeNull();
    expect(s?.verdict.reason).toBe('ImagePullBackOff');
    expect(s?.verdict.source).toBe('pod');
    expect(s?.podName).toBe('kat-9b1a-job-xyz');
    expect(s?.containerName).toBe('agent');
    expect(s?.lastTransitionTime).toBe('2026-04-26T12:00:30.000Z');
  });

  it('flags DeadlineExceeded via Job condition', () => {
    const job = jobWithCondition('DeadlineExceeded', 'True', {
      message: 'Job kat-9b1a-job exceeded activeDeadlineSeconds',
    });
    const s = podFailureSummary(job);
    expect(s?.verdict.reason).toBe('DeadlineExceeded');
    expect(s?.verdict.source).toBe('job');
    expect(s?.podName).toBeUndefined();
    expect(s?.lastTransitionTime).toBe('2026-04-26T12:01:00.000Z');
  });
});

/* =====================================================================
 * traceLink
 * ===================================================================== */

describe('traceLink', () => {
  it('returns null when the task has no UID', () => {
    const t = makeTask({});
    const tWithoutUid: AgentTask = {
      ...t,
      metadata: { ...t.metadata, uid: undefined },
    };
    expect(traceLink(tWithoutUid, { provider: 'langfuse' })).toBeNull();
  });

  it('returns provider + runId without URL when no baseUrl', () => {
    const t = makeTask({});
    expect(traceLink(t, { provider: 'langfuse' })).toEqual({
      provider: 'langfuse',
      runId: '9b1a8c4e-fixture',
    });
  });

  it('renders Langfuse trace URL', () => {
    const t = makeTask({});
    expect(
      traceLink(t, { provider: 'langfuse', baseUrl: 'https://langfuse.knuteson.io/' }),
    ).toEqual({
      provider: 'langfuse',
      runId: '9b1a8c4e-fixture',
      url: 'https://langfuse.knuteson.io/trace/9b1a8c4e-fixture',
    });
  });

  it('renders Jaeger trace URL', () => {
    const t = makeTask({});
    expect(traceLink(t, { provider: 'jaeger', baseUrl: 'https://jaeger.local' })).toMatchObject({
      url: 'https://jaeger.local/trace/9b1a8c4e-fixture',
    });
  });

  it('renders OTel-collector base URL as-is', () => {
    const t = makeTask({});
    expect(
      traceLink(t, { provider: 'otel-collector', baseUrl: 'https://otel-collector:4318/' }),
    ).toMatchObject({
      url: 'https://otel-collector:4318',
    });
  });
});
