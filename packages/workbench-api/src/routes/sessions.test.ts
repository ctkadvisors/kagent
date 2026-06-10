/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from '@kagent/dto';

import { SnapshotCache } from '../cache.js';
import { sessionsRoute } from './sessions.js';

function makeAgent(name: string, namespace = 'kagent-system'): Agent {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Agent',
    metadata: { name, namespace, uid: `agent-${name}` },
    spec: {
      modelClass: 'tool-caller-default',
      toolProfileRef: 'browser-code-researcher',
    },
  };
}

function makeTask(overrides: {
  readonly name: string;
  readonly sessionId?: string;
  readonly namespace?: string;
  readonly targetAgent?: string;
  readonly createdAt?: string;
  readonly completedAt?: string;
  readonly phase?: 'Pending' | 'Dispatched' | 'Completed' | 'Failed';
  readonly message?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly labels?: Record<string, string>;
}): AgentTask {
  const sessionId = overrides.sessionId ?? 'ops-room';
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name: overrides.name,
      namespace: overrides.namespace ?? 'kagent-system',
      uid: `uid-${overrides.name}`,
      creationTimestamp: new Date(overrides.createdAt ?? '2026-06-10T10:00:00Z'),
      labels: {
        'kagent.knuteson.io/channel': 'workbench',
        'kagent.knuteson.io/channel-session': sessionId,
        'kagent.knuteson.io/channel-turn': overrides.name,
        ...(overrides.labels ?? {}),
      },
    },
    spec: {
      targetAgent: overrides.targetAgent ?? 'controller',
      originalUserMessage: overrides.message ?? `message for ${overrides.name}`,
      payload: { channel: 'workbench', sessionId },
    },
    status: {
      phase: overrides.phase ?? 'Completed',
      ...(overrides.completedAt !== undefined && { completedAt: overrides.completedAt }),
      ...(overrides.result !== undefined && { result: overrides.result }),
      ...(overrides.error !== undefined && { error: overrides.error }),
    },
  };
}

function makeFakeCustomApi(opts?: { readonly returnedUid?: string }) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    api: {
      createNamespacedCustomObject: (args: Record<string, unknown>) => {
        calls.push(args);
        const manifest = args.body as {
          metadata: { name: string; namespace: string };
          spec: unknown;
        };
        return Promise.resolve({
          apiVersion: API_GROUP_VERSION,
          kind: 'AgentTask',
          metadata: {
            name: manifest.metadata.name,
            namespace: manifest.metadata.namespace,
            uid: opts?.returnedUid ?? 'uid-created-session-turn',
            creationTimestamp: '2026-06-10T12:00:00Z',
          },
          spec: manifest.spec,
        });
      },
    } as never,
  };
}

describe('sessionsRoute', () => {
  it('lists channel sessions newest first from channel-labelled tasks', async () => {
    const cache = new SnapshotCache();
    cache.upsertTask(
      makeTask({
        name: 'older-turn',
        sessionId: 'older-room',
        targetAgent: 'summarizer',
        createdAt: '2026-06-10T09:00:00Z',
        completedAt: '2026-06-10T09:01:00Z',
        message: 'older question',
        result: { content: 'older answer' },
      }),
    );
    cache.upsertTask(
      makeTask({
        name: 'newer-turn',
        sessionId: 'ops-room',
        targetAgent: 'controller',
        createdAt: '2026-06-10T10:00:00Z',
        completedAt: '2026-06-10T10:02:00Z',
        message: 'what is running?',
        result: { content: 'one task is running' },
      }),
    );
    cache.upsertTask({
      ...makeTask({ name: 'not-channel', sessionId: 'ignore-me' }),
      metadata: { name: 'not-channel', namespace: 'kagent-system' },
    });

    const res = await sessionsRoute({ cache }).request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly items: readonly {
        readonly id: string;
        readonly targetAgent?: string;
        readonly turnCount: number;
        readonly lastPhase?: string;
        readonly lastMessagePreview?: string;
      }[];
    };
    expect(body.items.map((s) => s.id)).toEqual(['ops-room', 'older-room']);
    expect(body.items[0]).toMatchObject({
      id: 'ops-room',
      targetAgent: 'controller',
      turnCount: 1,
      lastPhase: 'Completed',
      lastMessagePreview: 'one task is running',
    });
  });

  it('returns a session detail timeline with user, assistant, and task link messages', async () => {
    const cache = new SnapshotCache();
    cache.upsertTask(
      makeTask({
        name: 'turn-1',
        sessionId: 'ops-room',
        createdAt: '2026-06-10T10:00:00Z',
        completedAt: '2026-06-10T10:01:00Z',
        message: 'show active sessions',
        result: { content: 'There are two active sessions.' },
      }),
    );
    cache.upsertTask(
      makeTask({
        name: 'turn-2',
        sessionId: 'ops-room',
        createdAt: '2026-06-10T10:03:00Z',
        phase: 'Failed',
        message: 'tail the broken one',
        error: 'controller timed out',
      }),
    );

    const res = await sessionsRoute({ cache }).request('/api/sessions/ops-room');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readonly id: string;
      readonly messages: readonly {
        readonly role: string;
        readonly content: string;
        readonly task?: { readonly name: string; readonly phase?: string };
      }[];
    };
    expect(body.id).toBe('ops-room');
    expect(body.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:show active sessions',
      'assistant:There are two active sessions.',
      'user:tail the broken one',
      'assistant:controller timed out',
    ]);
    expect(body.messages[1]?.task).toMatchObject({ name: 'turn-1', phase: 'Completed' });
    expect(body.messages[3]?.task).toMatchObject({ name: 'turn-2', phase: 'Failed' });
  });

  it('creates a channel-labelled AgentTask for a new message', async () => {
    const cache = new SnapshotCache();
    cache.upsertAgent(makeAgent('controller'));
    const fake = makeFakeCustomApi({ returnedUid: 'uid-created' });
    const app = sessionsRoute({
      cache,
      customApi: fake.api,
      defaultNamespace: 'kagent-system',
      generateName: () => 'chat-fixed01',
    });

    const res = await app.request('/api/sessions/ops-room/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'controller',
        message: 'What needs attention?',
        runConfig: { timeoutSeconds: 120, maxIterations: 8 },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      readonly sessionId: string;
      readonly task: { readonly namespace: string; readonly name: string; readonly uid: string };
    };
    expect(body).toMatchObject({
      sessionId: 'ops-room',
      task: { namespace: 'kagent-system', name: 'chat-fixed01', uid: 'uid-created' },
    });
    expect(fake.calls).toHaveLength(1);
    const manifest = fake.calls[0]?.body as {
      metadata: { labels: Record<string, string>; annotations: Record<string, string> };
      spec: {
        targetAgent: string;
        originalUserMessage: string;
        payload: Record<string, unknown>;
        runConfig: Record<string, unknown>;
      };
    };
    expect(manifest.metadata.labels['kagent.knuteson.io/channel']).toBe('workbench');
    expect(manifest.metadata.labels['kagent.knuteson.io/channel-session']).toBe('ops-room');
    expect(manifest.metadata.labels['app.kubernetes.io/created-by']).toBe(
      'kagent-workbench-channel',
    );
    expect(manifest.metadata.annotations['kagent.knuteson.io/channel-message']).toBe(
      'What needs attention?',
    );
    expect(manifest.spec.targetAgent).toBe('controller');
    expect(manifest.spec.originalUserMessage).toContain('Session: ops-room');
    expect(manifest.spec.originalUserMessage).toContain('User message:\nWhat needs attention?');
    expect(manifest.spec.payload).toMatchObject({
      channel: 'workbench',
      sessionId: 'ops-room',
      message: 'What needs attention?',
    });
    expect(manifest.spec.runConfig).toEqual({ timeoutSeconds: 120, maxIterations: 8 });
  });

  it('rejects invalid session ids and empty messages without creating a task', async () => {
    const cache = new SnapshotCache();
    const fake = makeFakeCustomApi();
    const app = sessionsRoute({ cache, customApi: fake.api });

    const invalidSession = await app.request('/api/sessions/Bad Session/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'controller', message: 'hi' }),
    });
    expect(invalidSession.status).toBe(400);

    const emptyMessage = await app.request('/api/sessions/ops-room/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'controller', message: '' }),
    });
    expect(emptyMessage.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });
});
