/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import type { V1Job, V1Pod } from '@kubernetes/client-node';

import { API_GROUP_VERSION, type Agent, type AgentTask } from '@kagent/dto';

import { SnapshotCache } from '../cache.js';
import { tasksRoute } from './tasks.js';

function makeTask(overrides: {
  readonly name: string;
  readonly namespace?: string;
  readonly uid?: string;
  readonly createdAt?: string;
  readonly targetAgent?: string;
  readonly targetCapability?: string;
  readonly phase?: AgentTask['status'] extends infer Status
    ? Status extends { readonly phase?: infer Phase }
      ? Phase
      : never
    : never;
  readonly error?: string;
  readonly payload?: unknown;
}): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name: overrides.name,
      namespace: overrides.namespace ?? 'default',
      uid: overrides.uid ?? `uid-${overrides.name}`,
      ...(overrides.createdAt !== undefined && {
        creationTimestamp: new Date(overrides.createdAt),
      }),
    },
    spec: {
      ...(overrides.targetAgent !== undefined && { targetAgent: overrides.targetAgent }),
      ...(overrides.targetCapability !== undefined && {
        targetCapability: overrides.targetCapability,
      }),
      payload: overrides.payload ?? { topic: overrides.name },
    },
    ...(overrides.phase !== undefined && {
      status: {
        phase: overrides.phase,
        ...(overrides.error !== undefined && { error: overrides.error }),
      },
    }),
  };
}

function makeAgent(name: string, namespace = 'default'): Agent {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Agent',
    metadata: { name, namespace, uid: `agent-${name}` },
    spec: {
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      tools: ['http_get'],
      capabilities: ['research'],
    },
  };
}

function makeJob(name: string, taskName: string, namespace = 'default'): V1Job {
  return {
    metadata: {
      name,
      namespace,
      labels: { 'kagent.knuteson.io/task': taskName },
    },
  };
}

function makePod(name: string, taskName: string, namespace = 'default'): V1Pod {
  return {
    metadata: {
      name,
      namespace,
      labels: { 'kagent.knuteson.io/task': taskName },
    },
    status: {
      containerStatuses: [
        {
          name: 'agent',
          image: 'ghcr.io/ctkadvisors/kagent-agent-pod:test',
          imageID: 'sha256:test',
          ready: true,
          restartCount: 0,
          started: true,
        },
      ],
    },
  };
}

function buildApp(cache: SnapshotCache) {
  return tasksRoute({ cache });
}

describe('tasksRoute', () => {
  it('lists task summaries newest first and includes agent-derived model', async () => {
    const cache = new SnapshotCache();
    cache.upsertAgent(makeAgent('researcher'));
    cache.upsertTask(
      makeTask({
        name: 'older',
        targetAgent: 'researcher',
        phase: 'Completed',
        createdAt: '2026-04-27T10:00:00Z',
      }),
    );
    cache.upsertTask(
      makeTask({
        name: 'newer',
        targetAgent: 'researcher',
        phase: 'Dispatched',
        createdAt: '2026-04-27T11:00:00Z',
      }),
    );

    const res = await buildApp(cache).request('/api/tasks');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly items: readonly { readonly name: string; readonly model?: string }[];
    };
    expect(body.items.map((item) => item.name)).toEqual(['newer', 'older']);
    expect(body.items[0]?.model).toBe('workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('filters by namespace, phase, targetAgent, and since', async () => {
    const cache = new SnapshotCache();
    cache.upsertTask(
      makeTask({
        name: 'keep',
        namespace: 'kagent-system',
        targetAgent: 'researcher',
        phase: 'Failed',
        error: 'deadline exceeded',
        createdAt: '2026-04-27T12:00:00Z',
      }),
    );
    cache.upsertTask(
      makeTask({
        name: 'wrong-namespace',
        namespace: 'default',
        targetAgent: 'researcher',
        phase: 'Failed',
        createdAt: '2026-04-27T12:01:00Z',
      }),
    );
    cache.upsertTask(
      makeTask({
        name: 'wrong-phase',
        namespace: 'kagent-system',
        targetAgent: 'researcher',
        phase: 'Completed',
        createdAt: '2026-04-27T12:02:00Z',
      }),
    );
    cache.upsertTask(
      makeTask({
        name: 'too-old',
        namespace: 'kagent-system',
        targetAgent: 'researcher',
        phase: 'Failed',
        createdAt: '2026-04-26T12:00:00Z',
      }),
    );
    cache.upsertTask(
      makeTask({
        name: 'wrong-agent',
        namespace: 'kagent-system',
        targetAgent: 'summarizer',
        phase: 'Failed',
        createdAt: '2026-04-27T12:03:00Z',
      }),
    );

    const res = await buildApp(cache).request(
      '/api/tasks?namespace=kagent-system&phase=Failed&targetAgent=researcher&since=2026-04-27T00:00:00Z',
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly items: readonly { readonly name: string; readonly error?: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.name).toBe('keep');
    expect(body.items[0]?.error).toBe('deadline exceeded');
  });

  it('returns task detail with joined pod container status', async () => {
    const cache = new SnapshotCache();
    cache.upsertAgent(makeAgent('researcher', 'kagent-system'));
    cache.upsertTask(
      makeTask({
        name: 'daily-research',
        namespace: 'kagent-system',
        targetAgent: 'researcher',
        phase: 'Dispatched',
        payload: { topic: 'kagent' },
      }),
    );
    cache.upsertJob(makeJob('daily-research-job', 'daily-research', 'kagent-system'));
    cache.upsertPod(makePod('daily-research-pod', 'daily-research', 'kagent-system'));

    const res = await buildApp(cache).request('/api/tasks/kagent-system/daily-research');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly name: string;
      readonly model?: string;
      readonly payload?: unknown;
      readonly containerStatuses: readonly { readonly name: string }[];
    };
    expect(body.name).toBe('daily-research');
    expect(body.model).toBe('workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(body.payload).toEqual({ topic: 'kagent' });
    expect(body.containerStatuses).toHaveLength(1);
    expect(body.containerStatuses[0]?.name).toBe('agent');
  });

  it('returns JSON 404 for missing task detail', async () => {
    const cache = new SnapshotCache();

    const res = await buildApp(cache).request('/api/tasks/kagent-system/missing');

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      readonly error: string;
      readonly namespace: string;
      readonly name: string;
    };
    expect(body).toEqual({
      error: 'not-found',
      namespace: 'kagent-system',
      name: 'missing',
    });
  });

  it('omits traceLink from detail when langfuseBaseUrl is unset', async () => {
    const cache = new SnapshotCache();
    cache.upsertTask(
      makeTask({
        name: 't',
        namespace: 'kagent-system',
        uid: 'uid-trace-fixture',
        targetAgent: 'researcher',
        phase: 'Completed',
      }),
    );
    const res = await tasksRoute({ cache }).request('/api/tasks/kagent-system/t');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readonly traceLink?: unknown };
    expect(body.traceLink).toBeUndefined();
  });

  it('attaches traceLink with sha256-derived URL when langfuseBaseUrl is configured', async () => {
    const cache = new SnapshotCache();
    cache.upsertTask(
      makeTask({
        name: 't',
        namespace: 'kagent-system',
        uid: 'uid-trace-fixture',
        targetAgent: 'researcher',
        phase: 'Completed',
      }),
    );
    const app = tasksRoute({
      cache,
      langfuseBaseUrl: 'https://langfuse.example.com',
    });
    const res = await app.request('/api/tasks/kagent-system/t');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly traceLink?: { provider: string; runId: string; url: string };
    };
    expect(body.traceLink?.provider).toBe('langfuse');
    expect(body.traceLink?.runId).toBe('uid-trace-fixture');
    // The URL must use the sha256-derived OTel trace ID, NOT the raw UID —
    // the OtelTraceSink stores spans under that derived key (see WS-D + WS-H).
    expect(body.traceLink?.url).toMatch(/^https:\/\/langfuse\.example\.com\/trace\/[0-9a-f]{32}$/);
    expect(body.traceLink?.url).not.toContain('uid-trace-fixture');
  });
});
