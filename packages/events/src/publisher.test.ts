/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { buildEventValidatorRegistry } from './validate.js';
import { EventPublisher, type EventNatsConnectionLike } from './publisher.js';

interface FakeConnection extends EventNatsConnectionLike {
  publishCalls: Array<{ subject: string; data: Uint8Array }>;
  flushCalls: number;
  closeCalls: number;
  publishImpl: (subject: string, data: Uint8Array) => void;
}

function makeFakeConn(): FakeConnection {
  const conn: FakeConnection = {
    publishCalls: [],
    flushCalls: 0,
    closeCalls: 0,
    publishImpl: (subject, data) => {
      conn.publishCalls.push({ subject, data });
    },
    publish(subject, data) {
      conn.publishImpl(subject, data);
    },
    async flush() {
      conn.flushCalls++;
      await Promise.resolve();
    },
    async close() {
      conn.closeCalls++;
      await Promise.resolve();
    },
  };
  return conn;
}

const silentLogger = {
  warn: () => {},
  error: () => {},
};

describe('EventPublisher', () => {
  it('refuses construction with empty source', () => {
    expect(
      () =>
        new EventPublisher({
          source: '',
        }),
    ).toThrow(/source/);
  });

  it('publish throws on invalid topic', async () => {
    const conn = makeFakeConn();
    const pub = new EventPublisher({
      source: 'kagent.knuteson.io/agent-pod/x/y',
      connectFn: () => Promise.resolve(conn),
      logger: silentLogger,
    });
    await pub.connect('nats://stub');
    await expect(pub.publish({ topic: 'Bad.Topic', data: { foo: 1 } })).rejects.toThrow(
      /invalid topic/,
    );
    expect(conn.publishCalls).toHaveLength(0);
  });

  it('publish throws when topic is not admitted by publishClaims', async () => {
    const conn = makeFakeConn();
    const pub = new EventPublisher({
      source: 'kagent.knuteson.io/agent-pod/x/y',
      publishClaims: ['research.*'],
      connectFn: () => Promise.resolve(conn),
      logger: silentLogger,
    });
    await pub.connect('nats://stub');
    await expect(pub.publish({ topic: 'audit.task.completed', data: { foo: 1 } })).rejects.toThrow(
      /not admitted by capability/,
    );
  });

  it('publish admits topic matching publishClaims globs', async () => {
    const conn = makeFakeConn();
    const pub = new EventPublisher({
      source: 'kagent.knuteson.io/agent-pod/x/y',
      publishClaims: ['research.*'],
      connectFn: () => Promise.resolve(conn),
      logger: silentLogger,
    });
    await pub.connect('nats://stub');
    const out = await pub.publish({
      topic: 'research.findings',
      data: { title: 'x' },
      subject: 'AgentTask/default/research-1',
    });
    expect(out.ok).toBe(true);
    expect(conn.publishCalls).toHaveLength(1);
    expect(conn.publishCalls[0]?.subject).toBe('kagent.events.research.findings');
    expect(conn.flushCalls).toBe(1);
    if (out.ok) {
      expect(out.event.specversion).toBe('1.0');
      expect(out.event.type).toBe('research.findings');
      expect(out.event.source).toBe('kagent.knuteson.io/agent-pod/x/y');
      expect(out.event.subject).toBe('AgentTask/default/research-1');
    }
  });

  it('publish runs registered validator + refuses on validator error', async () => {
    const reg = buildEventValidatorRegistry();
    reg.set('research.findings', () => ({ ok: false, error: 'missing field x' }));
    const conn = makeFakeConn();
    const pub = new EventPublisher({
      source: 'kagent.knuteson.io/agent-pod/x/y',
      validators: reg,
      connectFn: () => Promise.resolve(conn),
      logger: silentLogger,
    });
    await pub.connect('nats://stub');
    await expect(pub.publish({ topic: 'research.findings', data: { other: 1 } })).rejects.toThrow(
      /missing field x/,
    );
    expect(conn.publishCalls).toHaveLength(0);
  });

  it('publish on disconnected publisher returns ok: false (best-effort infra)', async () => {
    const pub = new EventPublisher({
      source: 'kagent.knuteson.io/agent-pod/x/y',
      logger: silentLogger,
    });
    const out = await pub.publish({ topic: 'research.findings', data: { x: 1 } });
    expect(out).toEqual({ ok: false, reason: 'disconnected' });
  });

  it('publish recovers ok=false on flush failure + marks disconnected', async () => {
    const conn = makeFakeConn();
    const pub = new EventPublisher({
      source: 'kagent.knuteson.io/agent-pod/x/y',
      connectFn: () => Promise.resolve(conn),
      logger: silentLogger,
    });
    await pub.connect('nats://stub');
    expect(pub.isConnected()).toBe(true);
    conn.publishImpl = () => {
      throw new Error('NATS down');
    };
    const out = await pub.publish({ topic: 'research.findings', data: { x: 1 } });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('flush_failed');
    }
    expect(pub.isConnected()).toBe(false);
  });

  it('connect is idempotent', async () => {
    const factory = vi.fn(() => Promise.resolve(makeFakeConn()));
    const pub = new EventPublisher({
      source: 'src',
      connectFn: factory,
      logger: silentLogger,
    });
    await pub.connect('nats://stub');
    await pub.connect('nats://stub');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('connect with empty URL no-ops', async () => {
    const factory = vi.fn(() => Promise.resolve(makeFakeConn()));
    const pub = new EventPublisher({
      source: 'src',
      connectFn: factory,
      logger: silentLogger,
    });
    await pub.connect('');
    expect(factory).not.toHaveBeenCalled();
    expect(pub.isConnected()).toBe(false);
  });

  it('connect failure leaves publisher disconnected (best-effort)', async () => {
    const factory = vi
      .fn<(url: string) => Promise<EventNatsConnectionLike>>()
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const pub = new EventPublisher({
      source: 'src',
      connectFn: factory,
      logger: silentLogger,
    });
    await expect(pub.connect('nats://unreachable:4222')).resolves.toBeUndefined();
    expect(pub.isConnected()).toBe(false);
  });

  it('close is idempotent + safe on never-connected publisher', async () => {
    const conn = makeFakeConn();
    const pub = new EventPublisher({
      source: 'src',
      connectFn: () => Promise.resolve(conn),
      logger: silentLogger,
    });
    await pub.close();
    await pub.connect('nats://stub');
    await pub.close();
    await pub.close();
    expect(conn.closeCalls).toBe(1);
  });

  it('uses constructor source when input.source omitted', async () => {
    const conn = makeFakeConn();
    const pub = new EventPublisher({
      source: 'kagent.knuteson.io/agent-pod/x/y',
      connectFn: () => Promise.resolve(conn),
      logger: silentLogger,
    });
    await pub.connect('nats://stub');
    const out = await pub.publish({ topic: 'a.b', data: 1 });
    if (!out.ok) throw new Error('expected ok');
    expect(out.event.source).toBe('kagent.knuteson.io/agent-pod/x/y');
  });
});
