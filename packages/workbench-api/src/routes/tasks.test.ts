/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';
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

  it('attaches traceLink to task summaries when langfuseBaseUrl is configured', async () => {
    const cache = new SnapshotCache();
    cache.upsertTask(
      makeTask({
        name: 'traced',
        uid: 'uid-trace-fixture',
        phase: 'Completed',
        createdAt: '2026-04-27T11:00:00Z',
      }),
    );

    const app = tasksRoute({
      cache,
      langfuseBaseUrl: 'https://langfuse.example.com',
    });
    const res = await app.request('/api/tasks');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly items: readonly {
        readonly traceLink?: {
          readonly provider: string;
          readonly runId: string;
          readonly url: string;
        };
      }[];
    };
    expect(body.items[0]?.traceLink?.provider).toBe('langfuse');
    expect(body.items[0]?.traceLink?.runId).toBe('uid-trace-fixture');
    expect(body.items[0]?.traceLink?.url).toMatch(
      /^https:\/\/langfuse\.example\.com\/trace\/[0-9a-f]{32}$/,
    );
    expect(body.items[0]?.traceLink?.url).not.toContain('uid-trace-fixture');
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

  it('attaches pilot evidence from task metadata, status, and agent policy', async () => {
    const cache = new SnapshotCache();
    const agent = {
      ...makeAgent('orchestrator', 'kagent-system'),
      spec: {
        ...makeAgent('orchestrator', 'kagent-system').spec,
        tools: ['spawn_child_task', 'write_artifact'],
        capabilities: ['orchestrate'],
        allowedChildAgents: ['summarizer'],
        allowedChildTemplates: ['researcher'],
        maxConcurrentChildren: 3,
        maxInFlightTasks: 2,
      },
    };
    const baseTask = makeTask({
      name: 'pilot-parent',
      namespace: 'kagent-system',
      uid: 'uid-pilot-parent',
      targetAgent: 'orchestrator',
      phase: 'Completed',
    });
    const task = {
      ...baseTask,
      metadata: {
        ...baseTask.metadata,
        labels: {
          'kagent.knuteson.io/tenant': 'enterprise-pilot',
          'kagent.knuteson.io/managed-by': 'kagent-operator',
          'kagent.knuteson.io/parent-task-uid': 'uid-root',
          'app.kubernetes.io/created-by': 'kagent-workbench-api',
          'unrelated.example.com/noise': 'drop-me',
        },
        annotations: {
          'kagent.knuteson.io/evidence-id': 'rc-2026-05-04',
          'opaque.example.com/noise': 'drop-me',
        },
      },
      spec: {
        ...baseTask.spec,
        parentTask: 'uid-root',
        runConfig: { timeoutSeconds: 120, maxIterations: 8 },
      },
      status: {
        ...baseTask.status,
        structuralVerdict: { suspicious: [] },
        artifacts: [{ uri: 'pvc://kagent-artifacts/uid-pilot-parent/digest.md' }],
        children: [
          {
            name: 'pilot-child',
            namespace: 'kagent-system',
            uid: 'uid-child',
            phase: 'Completed',
          },
        ],
        aggregatePhase: 'AllComplete',
        successCount: 1,
        failureCount: 0,
        inFlightCount: 0,
        verification: {
          passed: true,
          mode: 'script',
          completedAt: '2026-05-04T12:00:00Z',
        },
        capabilityRef: 'cap-jti-123',
      },
    } as AgentTask;
    cache.upsertAgent(agent);
    cache.upsertTask(task);

    const res = await buildApp(cache).request('/api/tasks/kagent-system/pilot-parent');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly pilotEvidence?: {
        readonly audit: {
          readonly labels: Readonly<Record<string, string>>;
          readonly annotations: Readonly<Record<string, string>>;
          readonly tenant?: string;
          readonly createdBy?: string;
          readonly managedBy?: string;
          readonly parentTaskUid?: string;
        };
        readonly policy: {
          readonly agentResolved: boolean;
          readonly tools?: readonly string[];
          readonly allowedChildAgents?: readonly string[];
          readonly allowedChildTemplates?: readonly string[];
          readonly maxConcurrentChildren?: number;
          readonly maxInFlightTasks?: number;
        };
        readonly taskGraph: {
          readonly childCount?: number;
          readonly successCount?: number;
          readonly failureCount?: number;
          readonly inFlightCount?: number;
          readonly aggregatePhase?: string;
          readonly parentTask?: string;
        };
        readonly artifacts: { readonly count?: number };
        readonly verification?: { readonly passed: boolean; readonly mode: string };
        readonly capabilityRef?: string;
        readonly runConfig?: Readonly<Record<string, unknown>>;
      };
    };
    expect(body.pilotEvidence?.audit.tenant).toBe('enterprise-pilot');
    expect(body.pilotEvidence?.audit.createdBy).toBe('kagent-workbench-api');
    expect(body.pilotEvidence?.audit.managedBy).toBe('kagent-operator');
    expect(body.pilotEvidence?.audit.parentTaskUid).toBe('uid-root');
    expect(body.pilotEvidence?.audit.labels['unrelated.example.com/noise']).toBeUndefined();
    expect(body.pilotEvidence?.audit.annotations['kagent.knuteson.io/evidence-id']).toBe(
      'rc-2026-05-04',
    );
    expect(body.pilotEvidence?.policy.agentResolved).toBe(true);
    expect(body.pilotEvidence?.policy.tools).toEqual(['spawn_child_task', 'write_artifact']);
    expect(body.pilotEvidence?.policy.allowedChildAgents).toEqual(['summarizer']);
    expect(body.pilotEvidence?.policy.allowedChildTemplates).toEqual(['researcher']);
    expect(body.pilotEvidence?.policy.maxConcurrentChildren).toBe(3);
    expect(body.pilotEvidence?.policy.maxInFlightTasks).toBe(2);
    expect(body.pilotEvidence?.taskGraph).toMatchObject({
      childCount: 1,
      successCount: 1,
      failureCount: 0,
      inFlightCount: 0,
      aggregatePhase: 'AllComplete',
      parentTask: 'uid-root',
    });
    expect(body.pilotEvidence?.artifacts.count).toBe(1);
    expect(body.pilotEvidence?.verification).toEqual({
      passed: true,
      mode: 'script',
      completedAt: '2026-05-04T12:00:00Z',
    });
    expect(body.pilotEvidence?.capabilityRef).toBe('cap-jti-123');
    expect(body.pilotEvidence?.runConfig).toEqual({ timeoutSeconds: 120, maxIterations: 8 });
  });

  /* ===================================================================
   * POST /api/tasks — WS-J write surface
   * =================================================================== */

  /**
   * Build a stub CustomObjectsApi that records calls and returns either
   * a synthetic created object OR throws an ApiException-shaped error.
   */
  function makeFakeCustomApi(opts?: {
    readonly throwStatus?: number;
    readonly returnedUid?: string;
  }) {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      api: {
        createNamespacedCustomObject: (args: Record<string, unknown>) => {
          calls.push(args);
          if (opts?.throwStatus !== undefined) {
            // Mirrors the @kubernetes/client-node ApiException shape:
            // `code` carries the HTTP status; tests can also assert on
            // `body.code` via the `body` field.
            const e = new Error(`mock K8s status ${String(opts.throwStatus)}`) as Error & {
              code?: number;
            };
            e.code = opts.throwStatus;
            return Promise.reject(e);
          }
          const body = args.body as { metadata: { name: string; namespace: string } };
          return Promise.resolve({
            apiVersion: 'kagent.knuteson.io/v1alpha1',
            kind: 'AgentTask',
            metadata: {
              name: body.metadata.name,
              namespace: body.metadata.namespace,
              uid: opts?.returnedUid ?? 'uid-created-fixture',
              creationTimestamp: '2026-05-01T15:00:00Z',
            },
            spec: (args.body as { spec: unknown }).spec,
          });
        },
      } as unknown as import('@kubernetes/client-node').CustomObjectsApi,
    };
  }

  it('returns 503 when no customApi is configured (write surface disabled)', async () => {
    const cache = new SnapshotCache();
    const app = tasksRoute({ cache });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'smoke-test', originalUserMessage: 'hi' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { readonly error: string };
    expect(body.error).toContain('write surface disabled');
  });

  it('creates an AgentTask CR with correct manifest shape and returns 201', async () => {
    const cache = new SnapshotCache();
    cache.upsertAgent(makeAgent('smoke-test', 'kagent-system'));
    const fake = makeFakeCustomApi({ returnedUid: 'uid-abc' });
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
      generateName: () => 'manual-fixed01',
    });

    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'smoke-test',
        originalUserMessage: 'What is etcd?',
        runConfig: { timeoutSeconds: 60 },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      readonly namespace: string;
      readonly name: string;
      readonly uid: string;
      readonly phase: string;
      readonly _links: { readonly detail: string; readonly ui: string };
    };
    expect(body.namespace).toBe('kagent-system');
    expect(body.name).toBe('manual-fixed01');
    expect(body.uid).toBe('uid-abc');
    expect(body.phase).toBe('Pending');
    expect(body._links.detail).toBe('/api/tasks/kagent-system/manual-fixed01');
    expect(body._links.ui).toBe('/#/tasks/kagent-system/manual-fixed01');

    expect(fake.calls.length).toBe(1);
    const call = fake.calls[0]!;
    expect(call.namespace).toBe('kagent-system');
    expect(call.plural).toBe('agenttasks');
    const manifest = call.body as {
      metadata: { name: string; namespace: string; labels: Record<string, string> };
      spec: { targetAgent: string; originalUserMessage: string; runConfig?: unknown };
    };
    expect(manifest.metadata.name).toBe('manual-fixed01');
    expect(manifest.metadata.namespace).toBe('kagent-system');
    expect(manifest.metadata.labels['kagent.knuteson.io/managed-by']).toBe('kagent-operator');
    expect(manifest.metadata.labels['app.kubernetes.io/created-by']).toBe('kagent-workbench-api');
    expect(manifest.spec.targetAgent).toBe('smoke-test');
    expect(manifest.spec.originalUserMessage).toBe('What is etcd?');
    expect(manifest.spec.runConfig).toEqual({ timeoutSeconds: 60 });
  });

  it('rejects missing targetAgent with 400', async () => {
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi();
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ originalUserMessage: 'hi' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      readonly error: string;
      readonly fields: ReadonlyArray<{ readonly field: string; readonly code: string }>;
    };
    expect(body.fields.some((f) => f.field === 'targetAgent' && f.code === 'missing')).toBe(true);
    expect(fake.calls.length).toBe(0);
  });

  it('rejects empty originalUserMessage with 400', async () => {
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi();
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'smoke-test', originalUserMessage: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range timeoutSeconds with 422', async () => {
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi();
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'smoke-test',
        originalUserMessage: 'hi',
        runConfig: { timeoutSeconds: 999_999 },
      }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects invalid agent name shape with 400', async () => {
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi();
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'NotALabel', originalUserMessage: 'hi' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when target agent has not been observed in the namespace', async () => {
    const cache = new SnapshotCache();
    // Cache HAS observed at least one agent in the namespace, just not the named one.
    cache.upsertAgent(makeAgent('other-agent', 'kagent-system'));
    const fake = makeFakeCustomApi();
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'missing-agent', originalUserMessage: 'hi' }),
    });
    expect(res.status).toBe(404);
    expect(fake.calls.length).toBe(0);
  });

  it('does NOT short-circuit 404 when the cache has not observed any agent in the namespace', async () => {
    // Cold cache: informer hasn't reached the namespace yet. We let the
    // K8s API call be the authoritative gate; the test simulates a
    // successful create.
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi();
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'cold-namespace',
      generateName: () => 'manual-cold01',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'maybe-exists', originalUserMessage: 'hi' }),
    });
    expect(res.status).toBe(201);
    expect(fake.calls.length).toBe(1);
  });

  it('returns 409 on K8s name collision', async () => {
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi({ throwStatus: 409 });
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'smoke-test',
        originalUserMessage: 'hi',
        name: 'collision-fixture',
      }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 403 on K8s RBAC denial', async () => {
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi({ throwStatus: 403 });
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'smoke-test', originalUserMessage: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 on malformed JSON body', async () => {
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi();
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
  });

  // Audit-rev2 L17 — the catch-all 500 path must not leak the
  // underlying K8s API error string. The diagnostic stays in stderr
  // (logged structurally), the response body is a generic message.
  it('returns sanitized 500 body on unmapped K8s error — does not leak err.message', async () => {
    const cache = new SnapshotCache();
    // Use a status code that is NOT 409/404/403 (the structured branches).
    const fake = makeFakeCustomApi({ throwStatus: 500 });
    // Squelch the diagnostic stderr to keep test output clean while
    // still asserting it fired with the structured fields.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'smoke-test', originalUserMessage: 'hi' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { readonly error: string };
    // The user-facing body is generic.
    expect(body.error).toBe('internal error processing task creation; see workbench-api logs');
    // It does NOT carry the raw err.message ("mock K8s status 500").
    expect(body.error).not.toContain('mock K8s status');
    expect(body.error).not.toContain('K8s API call failed');
    // The structured diagnostic IS logged (so operators can still
    // debug from logs).
    expect(errSpy).toHaveBeenCalled();
    const logCall = errSpy.mock.calls[0]?.join(' ') ?? '';
    expect(logCall).toContain('POST /api/tasks');
    expect(logCall).toContain('mock K8s status 500');
    errSpy.mockRestore();
  });

  it('rejects reserved kagent.knuteson.io/* labels', async () => {
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi();
    const app = tasksRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'smoke-test',
        originalUserMessage: 'hi',
        labels: { 'kagent.knuteson.io/foo': 'bar' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      readonly fields: ReadonlyArray<{ readonly field: string; readonly code: string }>;
    };
    expect(body.fields.some((f) => f.code === 'invalid-name')).toBe(true);
  });
});
