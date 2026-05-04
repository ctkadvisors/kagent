/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildEventDispatcher,
  computeConsumerName,
  type ConsumerFactory,
  type EventSubscription,
  type JetStreamMsgLike,
  type ResolvedEventSubscription,
} from './dispatcher.js';
import { buildCloudEvent } from './make-event.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface StubConsumer {
  resolved: ResolvedEventSubscription;
  deliver: (msg: JetStreamMsgLike) => void;
  closed: number;
}

function makeFactory(): {
  factory: ConsumerFactory;
  registry: StubConsumer[];
} {
  const registry: StubConsumer[] = [];
  const factory: ConsumerFactory = (resolved, onMsg) => {
    const stub: StubConsumer = {
      resolved,
      deliver: onMsg,
      closed: 0,
    };
    registry.push(stub);
    return Promise.resolve({
      close: () => {
        stub.closed++;
        return Promise.resolve();
      },
    });
  };
  return { factory, registry };
}

interface CountingMsg extends JetStreamMsgLike {
  readonly acks: number;
  readonly naks: number;
  readonly terms: number;
}

function makeMsg(envelope: unknown): CountingMsg {
  let acks = 0;
  let naks = 0;
  let terms = 0;
  const data = new TextEncoder().encode(JSON.stringify(envelope));
  return {
    data,
    subject: 'kagent.events.research.findings',
    ack: () => {
      acks++;
    },
    nak: () => {
      naks++;
    },
    term: () => {
      terms++;
    },
    get acks() {
      return acks;
    },
    get naks() {
      return naks;
    },
    get terms() {
      return terms;
    },
  };
}

const noopCreateAgentTask = (): Promise<void> => Promise.resolve();

describe('computeConsumerName', () => {
  it('emits a deterministic, JetStream-valid durable name', () => {
    const a = computeConsumerName({ agentName: 'researcher', topic: 'research.findings' });
    const b = computeConsumerName({ agentName: 'researcher', topic: 'research.findings' });
    expect(a).toBe(b);
    expect(a.startsWith('kagent-evt-researcher-')).toBe(true);
    expect(a).toMatch(/^kagent-evt-researcher-[0-9a-f]{16}$/);
  });

  it('different topics produce different consumer names', () => {
    const a = computeConsumerName({ agentName: 'r', topic: 'research.findings' });
    const b = computeConsumerName({ agentName: 'r', topic: 'research.priorities' });
    expect(a).not.toBe(b);
  });

  it('truncates very long agent names to keep total length sane', () => {
    const long = 'a'.repeat(200);
    const name = computeConsumerName({ agentName: long, topic: 'research.findings' });
    // 11 + 64 (capped agent) + 1 + 16 = 92.
    expect(name.length).toBeLessThanOrEqual(92);
  });
});

describe('EventDispatcher.applySubscriptions', () => {
  it('drops subscriptions with topic outside subscribeClaims (defense-in-depth)', async () => {
    const { factory, registry } = makeFactory();
    const createAgentTask = vi
      .fn<
        (sub: ResolvedEventSubscription, ev: ReturnType<typeof buildCloudEvent>) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    const dispatcher = buildEventDispatcher({
      buildConsumer: factory,
      createAgentTask,
      logger: silentLogger,
    });
    const sub: EventSubscription = {
      agentNamespace: 'default',
      agentName: 'researcher',
      topic: 'audit.task.completed',
      subscribeClaims: ['research.*'],
    };
    await dispatcher.applySubscriptions([sub]);
    expect(registry).toHaveLength(0);
    expect(dispatcher.getActiveSubscriptions()).toHaveLength(0);
  });

  it('drops subscriptions with malformed topic', async () => {
    const { factory, registry } = makeFactory();
    const dispatcher = buildEventDispatcher({
      buildConsumer: factory,
      createAgentTask: noopCreateAgentTask,
      logger: silentLogger,
    });
    await dispatcher.applySubscriptions([
      {
        agentNamespace: 'default',
        agentName: 'researcher',
        topic: 'audit.*',
        subscribeClaims: ['*'],
      },
    ]);
    expect(registry).toHaveLength(0);
  });

  it('registers a consumer for an admitted subscription', async () => {
    const { factory, registry } = makeFactory();
    const dispatcher = buildEventDispatcher({
      buildConsumer: factory,
      createAgentTask: noopCreateAgentTask,
      logger: silentLogger,
    });
    await dispatcher.applySubscriptions([
      {
        agentNamespace: 'default',
        agentName: 'researcher',
        topic: 'research.priorities',
        subscribeClaims: ['research.*'],
        inputBinding: { inputName: 'event_payload' },
      },
    ]);
    expect(registry).toHaveLength(1);
    const active = dispatcher.getActiveSubscriptions();
    expect(active).toHaveLength(1);
    expect(active[0]?.subject).toBe('kagent.events.research.priorities');
    expect(active[0]?.inputBinding?.inputName).toBe('event_payload');
  });

  it('is idempotent — re-apply with the same set is a no-op', async () => {
    const { factory, registry } = makeFactory();
    const dispatcher = buildEventDispatcher({
      buildConsumer: factory,
      createAgentTask: noopCreateAgentTask,
      logger: silentLogger,
    });
    const sub: EventSubscription = {
      agentNamespace: 'default',
      agentName: 'researcher',
      topic: 'research.priorities',
      subscribeClaims: ['research.*'],
    };
    await dispatcher.applySubscriptions([sub]);
    await dispatcher.applySubscriptions([sub]);
    expect(registry).toHaveLength(1);
  });

  it('removes consumers no longer in the desired set', async () => {
    const { factory, registry } = makeFactory();
    const dispatcher = buildEventDispatcher({
      buildConsumer: factory,
      createAgentTask: noopCreateAgentTask,
      logger: silentLogger,
    });
    const sub: EventSubscription = {
      agentNamespace: 'default',
      agentName: 'researcher',
      topic: 'research.priorities',
      subscribeClaims: ['research.*'],
    };
    await dispatcher.applySubscriptions([sub]);
    await dispatcher.applySubscriptions([]);
    expect(registry[0]?.closed).toBe(1);
    expect(dispatcher.getActiveSubscriptions()).toHaveLength(0);
  });

  it('stop() closes every consumer', async () => {
    const { factory, registry } = makeFactory();
    const dispatcher = buildEventDispatcher({
      buildConsumer: factory,
      createAgentTask: noopCreateAgentTask,
      logger: silentLogger,
    });
    await dispatcher.applySubscriptions([
      {
        agentNamespace: 'default',
        agentName: 'researcher',
        topic: 'research.priorities',
        subscribeClaims: ['research.*'],
      },
      {
        agentNamespace: 'default',
        agentName: 'reviewer',
        topic: 'task.review_requested',
        subscribeClaims: ['task.*'],
      },
    ]);
    expect(registry).toHaveLength(2);
    await dispatcher.stop();
    expect(registry[0]?.closed).toBe(1);
    expect(registry[1]?.closed).toBe(1);
  });
});

describe('EventDispatcher message handling', () => {
  it('parses CE envelope, calls createAgentTask, acks message', async () => {
    const { factory, registry } = makeFactory();
    const created: Array<{ sub: ResolvedEventSubscription; data: unknown }> = [];
    const dispatcher = buildEventDispatcher({
      buildConsumer: factory,
      createAgentTask: (sub, event) => {
        created.push({ sub, data: event.data });
        return Promise.resolve();
      },
      logger: silentLogger,
    });
    await dispatcher.applySubscriptions([
      {
        agentNamespace: 'default',
        agentName: 'researcher',
        topic: 'research.priorities',
        subscribeClaims: ['research.*'],
      },
    ]);
    const event = buildCloudEvent({
      type: 'research.priorities',
      source: 'kagent.knuteson.io/agent-pod/origin/abc',
      data: { priority: 'high' },
    });
    const msg = makeMsg(event);
    registry[0]?.deliver(msg);
    // Async — wait one tick for the dispatcher's promise queue.
    await new Promise<void>((r) => {
      setImmediate(r);
    });
    expect(created).toHaveLength(1);
    expect((created[0]?.data as { priority: string }).priority).toBe('high');
    expect(msg.acks).toBe(1);
    expect(msg.naks).toBe(0);
  });

  it('terminates delivery on unparseable JSON', async () => {
    const { factory, registry } = makeFactory();
    const createAgentTask = vi
      .fn<
        (sub: ResolvedEventSubscription, ev: ReturnType<typeof buildCloudEvent>) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    const dispatcher = buildEventDispatcher({
      buildConsumer: factory,
      createAgentTask,
      logger: silentLogger,
    });
    await dispatcher.applySubscriptions([
      {
        agentNamespace: 'default',
        agentName: 'researcher',
        topic: 'research.priorities',
        subscribeClaims: ['research.*'],
      },
    ]);
    const data = new TextEncoder().encode('not-json');
    let acks = 0;
    let naks = 0;
    let terms = 0;
    registry[0]?.deliver({
      data,
      subject: 'kagent.events.research.priorities',
      ack: () => {
        acks++;
      },
      nak: () => {
        naks++;
      },
      term: () => {
        terms++;
      },
    });
    await new Promise<void>((r) => {
      setImmediate(r);
    });
    expect(createAgentTask).not.toHaveBeenCalled();
    expect(terms).toBe(1);
    expect(naks).toBe(0);
    expect(acks).toBe(0);
  });

  it('naks when createAgentTask throws', async () => {
    const { factory, registry } = makeFactory();
    const dispatcher = buildEventDispatcher({
      buildConsumer: factory,
      createAgentTask: () => Promise.reject(new Error('K8s API: 503 Service Unavailable')),
      logger: silentLogger,
    });
    await dispatcher.applySubscriptions([
      {
        agentNamespace: 'default',
        agentName: 'researcher',
        topic: 'research.priorities',
        subscribeClaims: ['research.*'],
      },
    ]);
    const event = buildCloudEvent({
      type: 'research.priorities',
      source: 'src',
      data: { x: 1 },
    });
    const msg = makeMsg(event);
    registry[0]?.deliver(msg);
    await new Promise<void>((r) => {
      setImmediate(r);
    });
    expect(msg.naks).toBe(1);
    expect(msg.acks).toBe(0);
  });
});
