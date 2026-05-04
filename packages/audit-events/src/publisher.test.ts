/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `AuditPublisher` tests — exercises the best-effort, never-throw
 * contract. Audit emission must NEVER break the operator's reconcile
 * loop or the agent-pod's task execution; every adverse path
 * (unreachable NATS, mid-stream connection drop, serialization
 * failure) must log + return cleanly.
 */

import { describe, expect, it, vi } from 'vitest';

import { TASK_ADMITTED } from './event-types.js';
import { makeEvent } from './make-event.js';
import {
  AuditPublisher,
  type AuditConnectFn,
  type AuditLogger,
  type AuditNatsConnectionLike,
} from './publisher.js';

function fixedEvent(): ReturnType<typeof makeEvent> {
  return makeEvent(
    {
      type: TASK_ADMITTED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/default/test',
      data: {
        taskUid: 'uid-1',
        taskNamespace: 'default',
        taskName: 'test',
        agentName: 'agent-x',
        model: 'workers-ai/foo',
        decision: 'admitted',
      },
    },
    { id: () => 'fixed-id', now: () => new Date('2026-05-03T00:00:00.000Z') },
  );
}

interface FakeConnection extends AuditNatsConnectionLike {
  publishCalls: Array<{ subject: string; data: Uint8Array }>;
  flushCalls: number;
  closeCalls: number;
}

function makeFakeConn(): FakeConnection {
  const conn: FakeConnection = {
    publishCalls: [],
    flushCalls: 0,
    closeCalls: 0,
    publish(subject, data) {
      conn.publishCalls.push({ subject, data });
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

function makeSpyLogger(): AuditLogger & {
  warns: unknown[][];
  errors: unknown[][];
} {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  return {
    warns,
    errors,
    warn: (...args) => {
      warns.push(args);
    },
    error: (...args) => {
      errors.push(args);
    },
  };
}

describe('AuditPublisher — connect()', () => {
  it('happy path opens the NATS connection', async () => {
    const conn = makeFakeConn();
    const connectFn: AuditConnectFn = vi.fn().mockResolvedValue(conn);
    const publisher = new AuditPublisher({ connectFn });
    await publisher.connect('nats://localhost:4222');
    expect(publisher.isConnected()).toBe(true);
    expect(connectFn).toHaveBeenCalledWith('nats://localhost:4222');
  });

  it('idempotent — second connect() is a no-op against an already-open publisher', async () => {
    const conn = makeFakeConn();
    const connectFn: AuditConnectFn = vi.fn().mockResolvedValue(conn);
    const publisher = new AuditPublisher({ connectFn });
    await publisher.connect('nats://localhost:4222');
    await publisher.connect('nats://localhost:4222');
    expect(connectFn).toHaveBeenCalledTimes(1);
  });

  it('connect failure logs warning and stays disconnected (no throw)', async () => {
    const logger = makeSpyLogger();
    const connectFn: AuditConnectFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const publisher = new AuditPublisher({ connectFn, logger });
    await expect(publisher.connect('nats://unreachable:4222')).resolves.toBeUndefined();
    expect(publisher.isConnected()).toBe(false);
    // Warning logged, error NOT logged (audit failures are warns)
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
    expect(logger.errors.length).toBe(0);
  });

  it('empty URL warns and stays disconnected', async () => {
    const logger = makeSpyLogger();
    const connectFn: AuditConnectFn = vi.fn();
    const publisher = new AuditPublisher({ connectFn, logger });
    await publisher.connect('');
    expect(publisher.isConnected()).toBe(false);
    expect(connectFn).not.toHaveBeenCalled();
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AuditPublisher — publish() best-effort contract', () => {
  it('publish on never-connected publisher logs warning and no-ops (no throw)', async () => {
    const logger = makeSpyLogger();
    const publisher = new AuditPublisher({ logger });
    await expect(publisher.publish(fixedEvent())).resolves.toBeUndefined();
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
    expect(publisher.isConnected()).toBe(false);
  });

  it('publish after connect failure logs warning and no-ops', async () => {
    const logger = makeSpyLogger();
    const connectFn: AuditConnectFn = vi.fn().mockRejectedValue(new Error('refused'));
    const publisher = new AuditPublisher({ connectFn, logger });
    await publisher.connect('nats://unreachable:4222');
    logger.warns.length = 0; // clear connect-failure warning
    await expect(publisher.publish(fixedEvent())).resolves.toBeUndefined();
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
  });

  it('happy path: publish encodes JSON to subject `audit.<type>` and flushes', async () => {
    const conn = makeFakeConn();
    const connectFn: AuditConnectFn = vi.fn().mockResolvedValue(conn);
    const publisher = new AuditPublisher({ connectFn });
    await publisher.connect('nats://localhost:4222');
    await publisher.publish(fixedEvent());
    expect(conn.publishCalls.length).toBe(1);
    const call = conn.publishCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('unreachable');
    expect(call.subject).toBe('audit.task.admitted');
    const decoded = new TextDecoder().decode(call.data);
    const parsed = JSON.parse(decoded) as {
      type: string;
      specversion: string;
      data: { taskUid: string };
    };
    expect(parsed.specversion).toBe('1.0');
    expect(parsed.type).toBe('task.admitted');
    expect(parsed.data.taskUid).toBe('uid-1');
    expect(conn.flushCalls).toBe(1);
  });

  it('honors custom subjectPrefix override', async () => {
    const conn = makeFakeConn();
    const connectFn: AuditConnectFn = vi.fn().mockResolvedValue(conn);
    const publisher = new AuditPublisher({ connectFn, subjectPrefix: 'my-audit' });
    await publisher.connect('nats://localhost:4222');
    await publisher.publish(fixedEvent());
    const call = conn.publishCalls[0];
    if (call === undefined) throw new Error('unreachable');
    expect(call.subject).toBe('my-audit.task.admitted');
  });

  it('publish() that throws is caught and logged (best-effort)', async () => {
    const logger = makeSpyLogger();
    const conn = makeFakeConn();
    conn.publish = () => {
      throw new Error('connection closed');
    };
    const connectFn: AuditConnectFn = vi.fn().mockResolvedValue(conn);
    const publisher = new AuditPublisher({ connectFn, logger });
    await publisher.connect('nats://localhost:4222');
    await expect(publisher.publish(fixedEvent())).resolves.toBeUndefined();
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
    // Mark disconnected so the next publish() short-circuits
    expect(publisher.isConnected()).toBe(false);
  });

  it('flush() that throws is caught and logged; subsequent publishes warn-and-no-op', async () => {
    const logger = makeSpyLogger();
    const conn = makeFakeConn();
    conn.flush = async () => {
      await Promise.resolve();
      throw new Error('socket dropped');
    };
    const connectFn: AuditConnectFn = vi.fn().mockResolvedValue(conn);
    const publisher = new AuditPublisher({ connectFn, logger });
    await publisher.connect('nats://localhost:4222');
    await publisher.publish(fixedEvent());
    // First publish: flush threw, logged a warn, marked disconnected
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
    expect(publisher.isConnected()).toBe(false);

    logger.warns.length = 0;
    await publisher.publish(fixedEvent());
    // Second publish: short-circuit on disconnected, logs another warn
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AuditPublisher — close()', () => {
  it('closes the underlying connection', async () => {
    const conn = makeFakeConn();
    const connectFn: AuditConnectFn = vi.fn().mockResolvedValue(conn);
    const publisher = new AuditPublisher({ connectFn });
    await publisher.connect('nats://localhost:4222');
    await publisher.close();
    expect(conn.closeCalls).toBe(1);
    expect(publisher.isConnected()).toBe(false);
  });

  it('idempotent — second close() is a no-op', async () => {
    const conn = makeFakeConn();
    const connectFn: AuditConnectFn = vi.fn().mockResolvedValue(conn);
    const publisher = new AuditPublisher({ connectFn });
    await publisher.connect('nats://localhost:4222');
    await publisher.close();
    await publisher.close();
    expect(conn.closeCalls).toBe(1);
  });

  it('close() on never-connected publisher is a no-op', async () => {
    const publisher = new AuditPublisher();
    await expect(publisher.close()).resolves.toBeUndefined();
  });

  it('swallows close() errors and warns', async () => {
    const logger = makeSpyLogger();
    const conn = makeFakeConn();
    conn.close = async () => {
      await Promise.resolve();
      throw new Error('already closed');
    };
    const connectFn: AuditConnectFn = vi.fn().mockResolvedValue(conn);
    const publisher = new AuditPublisher({ connectFn, logger });
    await publisher.connect('nats://localhost:4222');
    await expect(publisher.close()).resolves.toBeUndefined();
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AuditPublisher — getSource()', () => {
  it('returns the configured source', () => {
    const publisher = new AuditPublisher({ source: 'kagent.knuteson.io/operator' });
    expect(publisher.getSource()).toBe('kagent.knuteson.io/operator');
  });

  it('returns undefined when no source configured', () => {
    const publisher = new AuditPublisher();
    expect(publisher.getSource()).toBeUndefined();
  });
});
