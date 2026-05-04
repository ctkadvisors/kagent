/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { CapabilityBundle } from '@kagent/capability-types';
import {
  EVENTS_SUBJECT_PREFIX,
  EventPublisher,
  type EventNatsConnectionLike,
} from '@kagent/events';
import { describe, expect, it } from 'vitest';

import { definePublishEvent, PUBLISH_EVENT_MAX_DATA_BYTES } from './builtin-tools-publish.js';

interface FakeConn extends EventNatsConnectionLike {
  publishCalls: Array<{ subject: string; data: Uint8Array }>;
  publish(subject: string, data: Uint8Array): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

function makeFakeConn(): FakeConn {
  const conn: FakeConn = {
    publishCalls: [],
    publish(subject, data) {
      conn.publishCalls.push({ subject, data });
    },
    async flush() {
      await Promise.resolve();
    },
    async close() {
      await Promise.resolve();
    },
  };
  return conn;
}

const silentLogger = {
  warn: () => {},
  error: () => {},
};

const FAKE_CTX = {
  /* satisfies ToolInvocationContext minimally — handler doesn't read it. */
} as unknown as Parameters<ReturnType<typeof definePublishEvent>['handler']>[1];

function bundle(claims: CapabilityBundle['claims']): CapabilityBundle {
  return {
    iss: 'kagent.knuteson.io/operator',
    sub: 'task-uid:abc',
    aud: ['kagent-substrate'],
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: 'cap-test-1',
    claims,
  };
}

async function buildPublisher(
  publishClaims: readonly string[] | undefined,
): Promise<{ publisher: EventPublisher; conn: FakeConn }> {
  const conn = makeFakeConn();
  const publisher = new EventPublisher({
    source: 'kagent.knuteson.io/agent-pod/researcher/abc',
    ...(publishClaims !== undefined && { publishClaims }),
    connectFn: () => Promise.resolve(conn),
    logger: silentLogger,
  });
  await publisher.connect('nats://stub');
  return { publisher, conn };
}

describe('definePublishEvent', () => {
  it('happy path emits the CE envelope to kagent.events.<topic>', async () => {
    const { publisher, conn } = await buildPublisher(['research.*']);
    const tool = definePublishEvent({
      publisher,
      capabilityBundle: bundle({ publish: ['research.*'] }),
      declaredPublishes: new Set(['research.findings']),
    });
    const out = await tool.handler({ topic: 'research.findings', data: { title: 'x' } }, FAKE_CTX);
    expect(conn.publishCalls).toHaveLength(1);
    expect(conn.publishCalls[0]?.subject).toBe(`${EVENTS_SUBJECT_PREFIX}.research.findings`);
    const text = (out as { type: 'text'; text: string }[])[0]?.text ?? '';
    const parsed = JSON.parse(text) as { ok: boolean; type: string; subject: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.type).toBe('research.findings');
    expect(parsed.subject).toBe(`${EVENTS_SUBJECT_PREFIX}.research.findings`);
  });

  it('refuses when capability bundle is missing', async () => {
    const { publisher } = await buildPublisher(undefined);
    const tool = definePublishEvent({
      publisher,
      capabilityBundle: undefined,
      declaredPublishes: new Set(['research.findings']),
    });
    await expect(tool.handler({ topic: 'research.findings', data: {} }, FAKE_CTX)).rejects.toThrow(
      /policy_denied:no_capability/,
    );
  });

  it('refuses when capability has no publish claims', async () => {
    const { publisher } = await buildPublisher([]);
    const tool = definePublishEvent({
      publisher,
      capabilityBundle: bundle({}),
      declaredPublishes: new Set(['research.findings']),
    });
    await expect(tool.handler({ topic: 'research.findings', data: {} }, FAKE_CTX)).rejects.toThrow(
      /policy_denied:no_publish_claims/,
    );
  });

  it('refuses when topic is not in declared publishes[]', async () => {
    const { publisher } = await buildPublisher(['research.*']);
    const tool = definePublishEvent({
      publisher,
      capabilityBundle: bundle({ publish: ['research.*'] }),
      declaredPublishes: new Set(['research.summaries']),
    });
    await expect(tool.handler({ topic: 'research.findings', data: {} }, FAKE_CTX)).rejects.toThrow(
      /policy_denied:topic_not_declared/,
    );
  });

  it('refuses when topic is outside the cap publish-claim list', async () => {
    // Topic IS declared on the Agent's spec.publishes[] but the cap
    // bundle's narrower claim refuses it — the publisher's cap-claim
    // gate (defense-in-depth) translates the publisher's authority
    // error into the policy_denied:capability_violation taxonomy.
    const { publisher } = await buildPublisher(['research.*']);
    const tool = definePublishEvent({
      publisher,
      capabilityBundle: bundle({ publish: ['research.*'] }),
      declaredPublishes: new Set(['audit.completed', 'research.findings']),
    });
    await expect(tool.handler({ topic: 'audit.completed', data: {} }, FAKE_CTX)).rejects.toThrow(
      /policy_denied:capability_violation/,
    );
  });

  it('refuses when payload exceeds 64 KiB cap', async () => {
    const { publisher } = await buildPublisher(['research.*']);
    const tool = definePublishEvent({
      publisher,
      capabilityBundle: bundle({ publish: ['research.*'] }),
      declaredPublishes: new Set(['research.findings']),
    });
    const oversize = 'x'.repeat(PUBLISH_EVENT_MAX_DATA_BYTES + 100);
    await expect(
      tool.handler({ topic: 'research.findings', data: oversize }, FAKE_CTX),
    ).rejects.toThrow(/policy_denied:payload_too_large/);
  });

  it('refuses on invalid topic format (uppercase)', async () => {
    const { publisher } = await buildPublisher(['*']);
    const tool = definePublishEvent({
      publisher,
      capabilityBundle: bundle({ publish: ['*'] }),
      declaredPublishes: new Set(['Research.findings']),
    });
    await expect(tool.handler({ topic: 'Research.findings', data: {} }, FAKE_CTX)).rejects.toThrow(
      /policy_denied:invalid_topic/,
    );
  });

  it('passes optional resource subject through to the envelope', async () => {
    const { publisher, conn } = await buildPublisher(['research.*']);
    const tool = definePublishEvent({
      publisher,
      capabilityBundle: bundle({ publish: ['research.*'] }),
      declaredPublishes: new Set(['research.findings']),
    });
    await tool.handler(
      {
        topic: 'research.findings',
        data: { x: 1 },
        subject: 'AgentTask/default/researcher-1',
      },
      FAKE_CTX,
    );
    const payload = JSON.parse(new TextDecoder().decode(conn.publishCalls[0]?.data)) as {
      subject?: string;
    };
    expect(payload.subject).toBe('AgentTask/default/researcher-1');
  });
});
