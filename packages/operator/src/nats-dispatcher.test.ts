/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import type { DispatchedTask } from './dispatcher.js';
import { NatsDispatcher, publishSubject, type NatsConnectionLike } from './nats-dispatcher.js';

const sampleTask: DispatchedTask = {
  taskId: 'task-uid-1',
  agentId: 'researcher',
  originalUserMessage: 'what is k3s default runtime?',
  payload: { topic: 'k3s' },
};

describe('publishSubject', () => {
  it('uses the documented agent.<id>.task.<taskId> taxonomy', () => {
    expect(publishSubject(sampleTask)).toBe('agent.researcher.task.task-uid-1');
  });

  it('honors a custom prefix', () => {
    expect(publishSubject(sampleTask, 'kagent')).toBe('kagent.researcher.task.task-uid-1');
  });
});

describe('NatsDispatcher', () => {
  function makeConn(): NatsConnectionLike & {
    published: { subject: string; data: Uint8Array }[];
  } {
    const published: { subject: string; data: Uint8Array }[] = [];
    return {
      published,
      publish(subject, data) {
        published.push({ subject, data });
      },
      flush() {
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      },
    };
  }

  it('opens the connection lazily on first publish', async () => {
    const connect = vi.fn(() => Promise.resolve(makeConn()));
    const d = new NatsDispatcher({ connect });
    expect(connect).not.toHaveBeenCalled();
    await d.publish(sampleTask);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('reuses the same connection across publishes', async () => {
    const connect = vi.fn(() => Promise.resolve(makeConn()));
    const d = new NatsDispatcher({ connect });
    await d.publish(sampleTask);
    await d.publish({ ...sampleTask, taskId: 'task-uid-2' });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('publishes to the correct subject with JSON-encoded body', async () => {
    const conn = makeConn();
    const d = new NatsDispatcher({ connect: () => Promise.resolve(conn) });
    await d.publish(sampleTask);
    expect(conn.published).toHaveLength(1);
    expect(conn.published[0]?.subject).toBe('agent.researcher.task.task-uid-1');
    const decoded = new TextDecoder().decode(conn.published[0]?.data);
    expect(JSON.parse(decoded)).toMatchObject({
      taskId: 'task-uid-1',
      agentId: 'researcher',
      originalUserMessage: 'what is k3s default runtime?',
    });
  });

  it('flushes after each publish (so operator status writeback sees in-flight)', async () => {
    const conn = makeConn();
    const flushSpy = vi.spyOn(conn, 'flush');
    const d = new NatsDispatcher({ connect: () => Promise.resolve(conn) });
    await d.publish(sampleTask);
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('honors subjectPrefix override end-to-end', async () => {
    const conn = makeConn();
    const d = new NatsDispatcher({
      connect: () => Promise.resolve(conn),
      subjectPrefix: 'kagent',
    });
    await d.publish(sampleTask);
    expect(conn.published[0]?.subject).toBe('kagent.researcher.task.task-uid-1');
  });

  it('close() releases the connection idempotently', async () => {
    const conn = makeConn();
    const closeSpy = vi.spyOn(conn, 'close');
    const d = new NatsDispatcher({ connect: () => Promise.resolve(conn) });
    await d.publish(sampleTask);
    await d.close();
    await d.close(); // second close is a no-op
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates connect errors out of the first publish', async () => {
    const d = new NatsDispatcher({
      connect: () => Promise.reject(new Error('NATS down')),
    });
    await expect(d.publish(sampleTask)).rejects.toThrow(/NATS down/);
  });
});
