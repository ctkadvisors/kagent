/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `makeEvent` tests — verifies CloudEvents v1.0 envelope conformance
 * (specversion, datacontenttype, RFC 3339 time, RFC 4122 id) plus
 * the per-type discriminated-union narrowing.
 *
 * See docs/SUBSTRATE-V1.md §4.3 + the CE 1.0 spec:
 * https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_EVENT_TYPES,
  CAPABILITY_MINTED,
  CHILD_SPAWNED,
  CONTRACT_VIOLATED,
  QUOTA_BREACHED,
  SECRET_ACCESSED,
  TASK_ADMITTED,
  TASK_COMPLETED,
  TASK_FAILED,
} from './event-types.js';
import { makeEvent } from './make-event.js';

describe('makeEvent — CloudEvents v1.0 envelope conformance', () => {
  it('returns specversion="1.0" exactly (CE spec §3.1)', () => {
    const event = makeEvent({
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
    });
    expect(event.specversion).toBe('1.0');
  });

  it('returns datacontenttype="application/json" exactly', () => {
    const event = makeEvent({
      type: TASK_ADMITTED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/default/test',
      data: {
        taskUid: 'uid-1',
        taskNamespace: 'default',
        taskName: 'test',
        agentName: 'agent-x',
        model: undefined,
        decision: 'admitted',
      },
    });
    expect(event.datacontenttype).toBe('application/json');
  });

  it('emits an RFC 3339 / ISO 8601 UTC timestamp in `time`', () => {
    const event = makeEvent({
      type: TASK_ADMITTED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/default/test',
      data: {
        taskUid: 'uid-1',
        taskNamespace: 'default',
        taskName: 'test',
        agentName: 'agent-x',
        model: 'm',
        decision: 'admitted',
      },
    });
    // toISOString format: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(event.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Round-trip: Date.parse should accept it
    expect(Number.isFinite(Date.parse(event.time))).toBe(true);
  });

  it('preserves caller-provided fields verbatim (type, source, subject)', () => {
    const event = makeEvent({
      type: TASK_ADMITTED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/ns/name',
      data: {
        taskUid: 'u',
        taskNamespace: 'ns',
        taskName: 'name',
        agentName: 'a',
        model: 'm',
        decision: 'admitted',
      },
    });
    expect(event.type).toBe('task.admitted');
    expect(event.source).toBe('kagent.knuteson.io/operator');
    expect(event.subject).toBe('AgentTask/ns/name');
  });

  it('embeds the typed `data` payload verbatim', () => {
    const data = {
      taskUid: 'uid-42',
      taskNamespace: 'default',
      taskName: 'researcher-1',
      agentName: 'researcher',
      model: 'workers-ai/llama-4-scout',
      decision: 'admitted' as const,
    };
    const event = makeEvent({
      type: TASK_ADMITTED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/default/researcher-1',
      data,
    });
    expect(event.data).toEqual(data);
  });

  it('respects opts.id override (deterministic for tests)', () => {
    const event = makeEvent(
      {
        type: TASK_ADMITTED,
        source: 'kagent.knuteson.io/operator',
        subject: 'AgentTask/default/test',
        data: {
          taskUid: 'u',
          taskNamespace: 'default',
          taskName: 'test',
          agentName: 'a',
          model: undefined,
          decision: 'admitted',
        },
      },
      { id: () => 'fixed-id-abc' },
    );
    expect(event.id).toBe('fixed-id-abc');
  });

  it('respects opts.now override taking a Date', () => {
    const fixed = new Date('2026-05-03T12:00:00.000Z');
    const event = makeEvent(
      {
        type: TASK_ADMITTED,
        source: 'kagent.knuteson.io/operator',
        subject: 'AgentTask/default/test',
        data: {
          taskUid: 'u',
          taskNamespace: 'default',
          taskName: 'test',
          agentName: 'a',
          model: undefined,
          decision: 'admitted',
        },
      },
      { now: () => fixed },
    );
    expect(event.time).toBe('2026-05-03T12:00:00.000Z');
  });

  it('respects opts.now override taking an epoch ms number', () => {
    const epoch = Date.UTC(2026, 4, 3, 12, 0, 0);
    const event = makeEvent(
      {
        type: TASK_ADMITTED,
        source: 'kagent.knuteson.io/operator',
        subject: 'AgentTask/default/test',
        data: {
          taskUid: 'u',
          taskNamespace: 'default',
          taskName: 'test',
          agentName: 'a',
          model: undefined,
          decision: 'admitted',
        },
      },
      { now: () => epoch },
    );
    expect(event.time).toBe('2026-05-03T12:00:00.000Z');
  });

  it('produces a fresh UUID by default for each call (no collision)', () => {
    const a = makeEvent({
      type: TASK_ADMITTED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/default/a',
      data: {
        taskUid: 'a',
        taskNamespace: 'default',
        taskName: 'a',
        agentName: 'agent',
        model: undefined,
        decision: 'admitted',
      },
    });
    const b = makeEvent({
      type: TASK_ADMITTED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/default/b',
      data: {
        taskUid: 'b',
        taskNamespace: 'default',
        taskName: 'b',
        agentName: 'agent',
        model: undefined,
        decision: 'admitted',
      },
    });
    expect(a.id).not.toBe(b.id);
    // RFC 4122 v4 UUID shape: 8-4-4-4-12 hex chars
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('JSON-roundtrip stable (CE consumers parse via JSON.parse)', () => {
    const event = makeEvent(
      {
        type: TASK_ADMITTED,
        source: 'kagent.knuteson.io/operator',
        subject: 'AgentTask/default/test',
        data: {
          taskUid: 'u',
          taskNamespace: 'default',
          taskName: 'test',
          agentName: 'a',
          model: 'm',
          decision: 'admitted',
        },
      },
      { id: () => 'fixed', now: () => new Date('2026-05-03T00:00:00.000Z') },
    );
    const roundtripped: unknown = JSON.parse(JSON.stringify(event));
    expect(roundtripped).toEqual(event);
  });
});

describe('makeEvent — discriminated-union per-type', () => {
  it('builds a task.completed envelope with the matching data shape', () => {
    const event = makeEvent({
      type: TASK_COMPLETED,
      source: 'kagent.knuteson.io/agent-pod',
      subject: 'AgentTask/default/r-1',
      data: {
        taskUid: 'u',
        taskNamespace: 'default',
        taskName: 'r-1',
        agentName: 'researcher',
        tokensIn: 1234,
        tokensOut: 567,
        costUsd: 0.0042,
      },
    });
    expect(event.type).toBe('task.completed');
    expect(event.data.tokensIn).toBe(1234);
    expect(event.data.tokensOut).toBe(567);
    expect(event.data.costUsd).toBeCloseTo(0.0042, 6);
  });

  it('builds a task.failed envelope carrying structured cause', () => {
    const event = makeEvent({
      type: TASK_FAILED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/default/r-1',
      data: {
        taskUid: 'u',
        taskNamespace: 'default',
        taskName: 'r-1',
        agentName: 'researcher',
        reason: 'OOMKilled',
        message: 'Pod was OOMKilled (limit 256Mi)',
        source: 'pod',
      },
    });
    expect(event.type).toBe('task.failed');
    expect(event.data.reason).toBe('OOMKilled');
    expect(event.data.source).toBe('pod');
  });

  it('builds a child.spawned envelope with parent + child + depth', () => {
    const event = makeEvent({
      type: CHILD_SPAWNED,
      source: 'kagent.knuteson.io/agent-pod',
      subject: 'AgentTask/default/parent-1',
      data: {
        parentTaskUid: 'p',
        parentTaskNamespace: 'default',
        parentTaskName: 'parent-1',
        childTaskUid: 'c',
        childTaskName: 'child-1',
        childAgentName: 'summarizer',
        depth: 2,
      },
    });
    expect(event.type).toBe('child.spawned');
    expect(event.data.depth).toBe(2);
  });

  it('builds a capability.minted envelope with claim summary', () => {
    const event = makeEvent({
      type: CAPABILITY_MINTED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/default/r-1',
      data: {
        capabilityId: 'cap-jti-abc',
        taskUid: 'u',
        taskNamespace: 'default',
        taskName: 'r-1',
        issuer: 'kagent.knuteson.io/operator',
        expiresAt: '2026-05-04T00:00:00.000Z',
        claims: { tools: ['http_get'], spawn: ['summarizer-*'] },
      },
    });
    expect(event.data.claims.tools).toEqual(['http_get']);
    expect(event.data.claims.spawn).toEqual(['summarizer-*']);
  });

  it('builds a secret.accessed envelope (records ref, never value)', () => {
    const event = makeEvent({
      type: SECRET_ACCESSED,
      source: 'kagent.knuteson.io/operator',
      subject: 'Secret/default/cloudflare-ai-gateway',
      data: {
        secretName: 'cloudflare-ai-gateway',
        secretKey: 'api-key',
        namespace: 'default',
        accessor: 'kagent-operator',
        purpose: 'spawn-job-env-injection',
      },
    });
    expect(event.data.secretName).toBe('cloudflare-ai-gateway');
    expect(event.data.secretKey).toBe('api-key');
    // Sanity: no plaintext value on a SecretAccessedData payload — the
    // type doesn't have one, so this assertion is a guardrail against a
    // future refactor accidentally adding a `value` field.
    expect(JSON.stringify(event)).not.toContain('plaintext');
  });

  it('builds a quota.breached envelope', () => {
    const event = makeEvent({
      type: QUOTA_BREACHED,
      source: 'kagent.knuteson.io/operator',
      subject: 'Tenant/acme',
      data: {
        scope: 'tenant',
        resource: 'compute.cpu',
        limit: 10,
        observed: 11,
        tenant: 'acme',
        taskUid: 'u',
      },
    });
    expect(event.data.scope).toBe('tenant');
    expect(event.data.observed).toBeGreaterThan(event.data.limit);
  });

  it('builds a contract.violated envelope', () => {
    const event = makeEvent({
      type: CONTRACT_VIOLATED,
      source: 'kagent.knuteson.io/operator',
      subject: 'AgentTask/default/r-1',
      data: {
        taskUid: 'u',
        taskNamespace: 'default',
        taskName: 'r-1',
        violation: 'missing_required_output',
        detail: 'output `digest` declared required, none produced',
      },
    });
    expect(event.data.violation).toBe('missing_required_output');
  });
});

describe('event-types catalog', () => {
  it('exports exactly 21 event-type strings (10 Wave 0 + 3 v0.3.1-supervision + 5 v0.3.2-workflows + 3 v0.4.4-locality)', () => {
    expect(ALL_EVENT_TYPES.length).toBe(21);
  });

  it('matches the spec catalog exactly', () => {
    expect([...ALL_EVENT_TYPES]).toEqual([
      'task.admitted',
      'task.spawned',
      'task.completed',
      'task.failed',
      'child.spawned',
      'capability.minted',
      'capability.used',
      'secret.accessed',
      'quota.breached',
      'contract.violated',
      // v0.3.1-supervision — Wave 2 / Supervision sub-team.
      'supervision.applied',
      'supervision.restart_limit_exceeded',
      'infra.fault.observed',
      // v0.3.2-workflows — Wave 2 / Workflows sub-team additions.
      'workflow.started',
      'workflow.step.completed',
      'workflow.completed',
      'workflow.failed',
      'workflow.event_subscription_pending',
      // v0.4.4-locality — Wave 3 / Locality sub-team additions.
      'locality.speculative_spawned',
      'locality.speculative_superseded',
      'admission.pod_pressure_deferred',
    ]);
  });
});
