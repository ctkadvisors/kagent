/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import type { AgentTask } from '@kagent/dto';
import { API_GROUP_VERSION } from '@kagent/dto';

import { SnapshotCache } from './cache.js';
import { SseBroker, formatCacheEvent, formatHeartbeat } from './sse.js';

function makeTask(name: string): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: { name, namespace: 'default', uid: `uid-${name}` },
    spec: { payload: {} },
  };
}

describe('formatCacheEvent', () => {
  it('produces an SSE frame with event=cache', () => {
    const wire = formatCacheEvent({ kind: 'task', op: 'upsert', key: 'default/alpha' });
    expect(wire.event).toBe('cache');
    expect(JSON.parse(wire.data)).toEqual({
      kind: 'task',
      op: 'upsert',
      key: 'default/alpha',
    });
  });
});

describe('formatHeartbeat', () => {
  it('produces an SSE frame with event=heartbeat and ISO timestamp', () => {
    const fixed = new Date('2026-04-26T12:00:00Z');
    const wire = formatHeartbeat(fixed);
    expect(wire.event).toBe('heartbeat');
    expect(JSON.parse(wire.data)).toEqual({ ts: '2026-04-26T12:00:00.000Z' });
  });
});

describe('SseBroker', () => {
  it('forwards cache events to subscribers', () => {
    const cache = new SnapshotCache();
    const broker = new SseBroker(cache);
    const sink = vi.fn();
    broker.subscribe(sink);
    cache.upsertTask(makeTask('alpha'));
    expect(sink).toHaveBeenCalledTimes(1);
    const wire = sink.mock.calls[0]?.[0] as { event: string; data: string };
    expect(wire.event).toBe('cache');
    expect(JSON.parse(wire.data)).toMatchObject({ kind: 'task', op: 'upsert' });
  });

  it('unsubscribe stops the flow', () => {
    const cache = new SnapshotCache();
    const broker = new SseBroker(cache);
    const sink = vi.fn();
    const sub = broker.subscribe(sink);
    sub.unsubscribe();
    cache.upsertTask(makeTask('alpha'));
    expect(sink).not.toHaveBeenCalled();
  });

  it('counts sink errors as dropped events', () => {
    const cache = new SnapshotCache();
    const broker = new SseBroker(cache);
    const sub = broker.subscribe(() => {
      throw new Error('socket gone');
    });
    cache.upsertTask(makeTask('alpha'));
    expect(sub.droppedCount()).toBe(1);
    expect(broker.totalDropped()).toBe(1);
  });

  it('multiple subscribers each get their own copy', () => {
    const cache = new SnapshotCache();
    const broker = new SseBroker(cache);
    const a = vi.fn();
    const b = vi.fn();
    broker.subscribe(a);
    broker.subscribe(b);
    cache.upsertTask(makeTask('alpha'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
