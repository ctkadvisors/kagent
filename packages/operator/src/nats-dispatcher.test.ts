/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import type { DispatchedTask } from './dispatcher.js';
import {
  NatsDispatcher,
  publishSubject,
  type NatsConnectionLike,
  type NatsHeadersLike,
  type NatsPublishOptionsLike,
} from './nats-dispatcher.js';

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
    published: { subject: string; data: Uint8Array; opts?: NatsPublishOptionsLike }[];
  } {
    const published: { subject: string; data: Uint8Array; opts?: NatsPublishOptionsLike }[] = [];
    return {
      published,
      publish(subject, data, opts) {
        published.push({ subject, data, ...(opts !== undefined && { opts }) });
      },
      flush() {
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      },
    };
  }

  /**
   * Stub `headers()` factory mirroring nats.js's MsgHdrs surface — only
   * `set(key, value)` is exercised here; we capture writes for assertion.
   */
  function makeHeadersFactory(): {
    factory: () => NatsHeadersLike;
    captured: { key: string; value: string }[];
  } {
    const captured: { key: string; value: string }[] = [];
    return {
      captured,
      factory: () => ({
        set(key, value) {
          captured.push({ key, value });
        },
      }),
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

  /* =====================================================================
   * WS-F: Nats-Msg-Id dedupe header. JetStream's duplicate_window does
   * the actual dropping; the dispatcher's job is to attach the header
   * verbatim from `opts.dedupeId`.
   * ===================================================================== */

  describe('dedupeId → Nats-Msg-Id header', () => {
    it('attaches Nats-Msg-Id when dedupeId is set + headersFactory is wired', async () => {
      const conn = makeConn();
      const { factory, captured } = makeHeadersFactory();
      const d = new NatsDispatcher({
        connect: () => Promise.resolve(conn),
        headersFactory: factory,
      });
      await d.publish(sampleTask, { dedupeId: 'task-uid-1' });
      expect(conn.published).toHaveLength(1);
      expect(conn.published[0]?.opts?.headers).toBeDefined();
      expect(captured).toEqual([{ key: 'Nats-Msg-Id', value: 'task-uid-1' }]);
    });

    it('omits headers entirely when no dedupeId is supplied', async () => {
      const conn = makeConn();
      const { factory, captured } = makeHeadersFactory();
      const d = new NatsDispatcher({
        connect: () => Promise.resolve(conn),
        headersFactory: factory,
      });
      await d.publish(sampleTask);
      expect(conn.published[0]?.opts).toBeUndefined();
      expect(captured).toHaveLength(0);
    });

    it('skips header attachment when headersFactory is not configured (back-compat)', async () => {
      const conn = makeConn();
      const d = new NatsDispatcher({ connect: () => Promise.resolve(conn) });
      await d.publish(sampleTask, { dedupeId: 'task-uid-1' });
      // Publish still happens — just no Nats-Msg-Id. Operator startup
      // wires the factory in main.ts; tests that don't care about
      // dedupe semantics shouldn't be forced to.
      expect(conn.published).toHaveLength(1);
      expect(conn.published[0]?.opts).toBeUndefined();
    });

    it('treats empty-string dedupeId as no-dedupe', async () => {
      const conn = makeConn();
      const { factory, captured } = makeHeadersFactory();
      const d = new NatsDispatcher({
        connect: () => Promise.resolve(conn),
        headersFactory: factory,
      });
      await d.publish(sampleTask, { dedupeId: '' });
      expect(conn.published[0]?.opts).toBeUndefined();
      expect(captured).toHaveLength(0);
    });

    it('uses a fresh headers object per publish (no cross-publish bleed)', async () => {
      const conn = makeConn();
      const { factory, captured } = makeHeadersFactory();
      const d = new NatsDispatcher({
        connect: () => Promise.resolve(conn),
        headersFactory: factory,
      });
      await d.publish(sampleTask, { dedupeId: 'task-uid-1' });
      await d.publish({ ...sampleTask, taskId: 'task-uid-2' }, { dedupeId: 'task-uid-2' });
      expect(captured).toEqual([
        { key: 'Nats-Msg-Id', value: 'task-uid-1' },
        { key: 'Nats-Msg-Id', value: 'task-uid-2' },
      ]);
    });
  });
});
