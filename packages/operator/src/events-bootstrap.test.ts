/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { CustomObjectsApi } from '@kubernetes/client-node';
import { buildCloudEvent, computeConsumerName } from '@kagent/events';
import { describe, expect, it, vi } from 'vitest';

import {
  EVENT_CONSUMER_ANNOTATION,
  EVENT_ID_ANNOTATION,
  buildEventTriggerAgentTaskCreator,
  provisionEventsStream,
  renderEventTriggerAgentTask,
  type StreamApiLike,
} from './events-bootstrap.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
};

describe('renderEventTriggerAgentTask', () => {
  it('forwards event.data as payload when no inputBinding is declared', () => {
    const event = buildCloudEvent(
      { type: 'research.priorities', source: 'src', data: { priority: 'high' } },
      { id: () => 'event-id-1', now: () => new Date('2026-05-04T12:00:00Z') },
    );
    const manifest = renderEventTriggerAgentTask({
      sub: {
        agentNamespace: 'default',
        agentName: 'researcher',
        topic: 'research.priorities',
        subscribeClaims: ['research.*'],
        consumerName: computeConsumerName({
          agentName: 'researcher',
          topic: 'research.priorities',
        }),
        subject: 'kagent.events.research.priorities',
      },
      event,
      now: new Date('2026-05-04T12:00:00Z'),
      randomSuffix: 'abc123',
    });
    expect(manifest.metadata.namespace).toBe('default');
    expect(manifest.metadata.name).toBe(
      `researcher-evt-${String(Math.floor(new Date('2026-05-04T12:00:00Z').getTime() / 1000))}-abc123`,
    );
    expect(manifest.metadata.labels['kagent.knuteson.io/event-trigger']).toBe('true');
    expect(manifest.metadata.labels['kagent.knuteson.io/event-topic']).toBe('research.priorities');
    expect(manifest.metadata.labels['kagent.knuteson.io/managed-by']).toBe('kagent-events');
    expect(manifest.metadata.annotations[EVENT_ID_ANNOTATION]).toBe('event-id-1');
    expect(manifest.metadata.annotations[EVENT_CONSUMER_ANNOTATION]).toBe(
      computeConsumerName({ agentName: 'researcher', topic: 'research.priorities' }),
    );
    expect(manifest.spec.payload).toEqual({ priority: 'high' });
    expect(manifest.spec.inputs).toBeUndefined();
  });

  it('binds event.data via inputs[<inputBinding>] when declared', () => {
    const event = buildCloudEvent(
      { type: 'research.priorities', source: 'src', data: { priority: 'high' } },
      { id: () => 'event-id-2', now: () => new Date('2026-05-04T12:00:00Z') },
    );
    const manifest = renderEventTriggerAgentTask({
      sub: {
        agentNamespace: 'default',
        agentName: 'researcher',
        topic: 'research.priorities',
        subscribeClaims: ['research.*'],
        inputBinding: { inputName: 'priority_payload' },
        consumerName: computeConsumerName({
          agentName: 'researcher',
          topic: 'research.priorities',
        }),
        subject: 'kagent.events.research.priorities',
      },
      event,
      now: new Date('2026-05-04T12:00:00Z'),
      randomSuffix: 'def456',
    });
    expect(manifest.spec.inputs).toEqual([
      { name: 'priority_payload', from: { scalar: { priority: 'high' } } },
    ]);
    expect(manifest.spec.payload).toEqual({ __event_trigger__: true });
  });
});

describe('provisionEventsStream', () => {
  it('updates an existing stream', async () => {
    const calls = { info: 0, add: 0, update: 0 };
    const streams: StreamApiLike = {
      info: () => {
        calls.info++;
        return Promise.resolve({ ok: true });
      },
      add: () => {
        calls.add++;
        return Promise.resolve({});
      },
      update: () => {
        calls.update++;
        return Promise.resolve({});
      },
    };
    const out = await provisionEventsStream({
      jsm: { streams },
      config: {
        name: 'kagent-events',
        subjects: ['kagent.events.>'],
        maxAgeNs: 24 * 60 * 60 * 1_000_000_000,
        replicas: 1,
      },
      logger: silentLogger,
    });
    expect(out).toEqual({ created: false });
    expect(calls.info).toBe(1);
    expect(calls.update).toBe(1);
    expect(calls.add).toBe(0);
  });

  it('creates a new stream when info() rejects', async () => {
    const calls = { info: 0, add: 0, update: 0 };
    const streams: StreamApiLike = {
      info: () => {
        calls.info++;
        return Promise.reject(new Error('not found'));
      },
      add: () => {
        calls.add++;
        return Promise.resolve({});
      },
      update: () => {
        calls.update++;
        return Promise.resolve({});
      },
    };
    const out = await provisionEventsStream({
      jsm: { streams },
      config: {
        name: 'kagent-events',
        subjects: ['kagent.events.>'],
        maxAgeNs: 24 * 60 * 60 * 1_000_000_000,
        replicas: 1,
      },
      logger: silentLogger,
    });
    expect(out).toEqual({ created: true });
    expect(calls.add).toBe(1);
  });

  it('soft-fails when both info + add reject (best-effort)', async () => {
    const streams: StreamApiLike = {
      info: () => Promise.reject(new Error('not found')),
      add: () => Promise.reject(new Error('NATS down')),
      update: () => Promise.resolve({}),
    };
    const out = await provisionEventsStream({
      jsm: { streams },
      config: {
        name: 'kagent-events',
        subjects: ['kagent.events.>'],
        maxAgeNs: 24 * 60 * 60 * 1_000_000_000,
        replicas: 1,
      },
      logger: silentLogger,
    });
    expect('skipped' in out ? out.skipped : false).toBe(true);
  });
});

describe('buildEventTriggerAgentTaskCreator', () => {
  it('POSTs the rendered manifest via customApi', async () => {
    const create = vi.fn(() => Promise.resolve({ body: {} }));
    const customApi = {
      createNamespacedCustomObject: create,
    } as unknown as CustomObjectsApi;
    const creator = buildEventTriggerAgentTaskCreator({
      customApi,
      now: () => new Date('2026-05-04T12:00:00Z'),
      randomSuffix: () => 'abc123',
      logger: silentLogger,
    });
    const event = buildCloudEvent(
      { type: 'research.priorities', source: 'src', data: { priority: 'high' } },
      { id: () => 'event-id-1', now: () => new Date('2026-05-04T12:00:00Z') },
    );
    await creator(
      {
        agentNamespace: 'default',
        agentName: 'researcher',
        topic: 'research.priorities',
        subscribeClaims: ['research.*'],
        consumerName: 'kagent-evt-researcher-abc',
        subject: 'kagent.events.research.priorities',
      },
      event,
    );
    expect(create).toHaveBeenCalledTimes(1);
    const arg = (create.mock.calls[0]?.[0] ?? {}) as {
      group?: string;
      namespace?: string;
      plural?: string;
      body?: { metadata?: { name?: string }; spec?: Record<string, unknown> };
    };
    expect(arg.namespace).toBe('default');
    expect(arg.plural).toBe('agenttasks');
    expect(arg.body?.spec?.targetAgent).toBe('researcher');
  });

  it('rethrows on K8s API error so the dispatcher can nak', async () => {
    const create = vi.fn(() => Promise.reject(new Error('503 Service Unavailable')));
    const customApi = {
      createNamespacedCustomObject: create,
    } as unknown as CustomObjectsApi;
    const creator = buildEventTriggerAgentTaskCreator({
      customApi,
      now: () => new Date(),
      randomSuffix: () => 'aaa111',
      logger: silentLogger,
    });
    const event = buildCloudEvent(
      { type: 'research.priorities', source: 'src', data: {} },
      { id: () => 'event-id-9', now: () => 0 },
    );
    await expect(
      creator(
        {
          agentNamespace: 'default',
          agentName: 'researcher',
          topic: 'research.priorities',
          subscribeClaims: ['research.*'],
          consumerName: 'cn',
          subject: 'kagent.events.research.priorities',
        },
        event,
      ),
    ).rejects.toThrow(/event-trigger AgentTask create failed/);
  });
});
