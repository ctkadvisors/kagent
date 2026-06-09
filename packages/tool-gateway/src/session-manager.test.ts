/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { InMemoryToolSessionManager } from './session-manager.js';

describe('InMemoryToolSessionManager', () => {
  it('creates separate sessions for sibling tasks even when tool kind matches', () => {
    const manager = new InMemoryToolSessionManager({
      now: () => new Date('2026-06-08T12:00:00Z'),
    });
    const a = manager.start({
      tenant: 'homelab',
      namespace: 'kagent',
      agentTaskUid: 'task-a',
      agentName: 'agent-a',
      toolKind: 'code_interpreter',
      ttlSeconds: 60,
    });
    const b = manager.start({
      tenant: 'homelab',
      namespace: 'kagent',
      agentTaskUid: 'task-b',
      agentName: 'agent-b',
      toolKind: 'code_interpreter',
      ttlSeconds: 60,
    });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(manager.get(a)?.agentTaskUid).toBe('task-a');
    expect(manager.get(b)?.agentTaskUid).toBe('task-b');
  });

  it('rejects lookup when ownership fields do not match', () => {
    const manager = new InMemoryToolSessionManager({
      now: () => new Date('2026-06-08T12:00:00Z'),
    });
    const session = manager.start({
      tenant: 'homelab',
      namespace: 'kagent',
      agentTaskUid: 'task-a',
      agentName: 'agent-a',
      toolKind: 'browser',
      ttlSeconds: 60,
    });

    expect(
      manager.get({
        ...session,
        agentTaskUid: 'task-b',
      }),
    ).toBeNull();
  });

  it('stops admitting sessions while paused', () => {
    const manager = new InMemoryToolSessionManager({
      now: () => new Date('2026-06-08T12:00:00Z'),
    });
    manager.setPaused(true);

    expect(() =>
      manager.start({
        tenant: 'homelab',
        namespace: 'kagent',
        agentTaskUid: 'task-a',
        agentName: 'agent-a',
        toolKind: 'browser',
        ttlSeconds: 60,
      }),
    ).toThrow(/tool_runtime_paused/);
  });

  it('marks terminated sessions and keeps them unavailable for tool calls', () => {
    const manager = new InMemoryToolSessionManager({
      now: () => new Date('2026-06-08T12:00:00Z'),
    });
    const session = manager.start({
      tenant: 'homelab',
      namespace: 'kagent',
      agentTaskUid: 'task-a',
      agentName: 'agent-a',
      toolKind: 'browser',
      ttlSeconds: 60,
    });
    manager.terminate(session);

    expect(manager.get(session)?.status).toBe('terminated');
    expect(manager.requireReady(session)).toBeNull();
  });
});
