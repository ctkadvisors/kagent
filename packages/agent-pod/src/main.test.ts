/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { CapabilityBundle } from '@kagent/capability-types';
import { EventPublisher, type EventNatsConnectionLike } from '@kagent/events';
import { describe, expect, it } from 'vitest';

import { definePublishEvent } from './builtin-tools-publish.js';
import type { PodConfig } from './env.js';
import { buildCancelledResult, buildShutdownPlan, selectPublishCapabilityBundle } from './main.js';

const baseConfig: PodConfig = {
  taskId: 'task-uid-1',
  taskName: 't1',
  taskNamespace: 'default',
  agentName: 'researcher',
  agentSpec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
  },
  taskSpec: {
    payload: {},
  },
  litellmBaseUrl: 'http://litellm.test:4000/v1',
  logLevel: 'info',
  traceContentMode: 'preview',
};

describe('buildShutdownPlan (WS-G — SIGTERM orchestration helper)', () => {
  it('shouldRun=true on the first signal', () => {
    const plan = buildShutdownPlan('SIGTERM', false);
    expect(plan.signalName).toBe('SIGTERM');
    expect(plan.shouldRun).toBe(true);
  });

  it('shouldRun=false on re-entry (idempotent under repeated signals)', () => {
    const plan = buildShutdownPlan('SIGTERM', true);
    expect(plan.shouldRun).toBe(false);
  });

  it('passes through the signal name verbatim for both SIGTERM and SIGINT', () => {
    expect(buildShutdownPlan('SIGINT', false).signalName).toBe('SIGINT');
    expect(buildShutdownPlan('SIGTERM', false).signalName).toBe('SIGTERM');
  });
});

describe('buildCancelledResult (WS-G — pre-runner / mid-cancel synthesis)', () => {
  it('mirrors the runner cancelled-shape: status=cancelled, empty traces, error.message=signal', () => {
    const result = buildCancelledResult(baseConfig, 'SIGTERM');
    expect(result.runId).toBe(baseConfig.taskId);
    expect(result.status).toBe('cancelled');
    expect(result.finalContent).toBeNull();
    expect(result.flags).toEqual([]);
    expect(result.traces).toEqual([]);
    expect(result.budget.cumulativeInputTokens).toBe(0);
    expect(result.budget.cumulativeOutputTokens).toBe(0);
    expect(result.budget.cumulativeCostUsd).toBeNull();
    expect(result.error?.message).toBe('cancelled: SIGTERM received');
  });

  it('reflects the SIGINT signal name in the error message', () => {
    const result = buildCancelledResult(baseConfig, 'SIGINT');
    expect(result.error?.message).toBe('cancelled: SIGINT received');
  });
});

/* =====================================================================
 * v0.1.11 — W3C Trace Context propagation seam.
 *
 * Two pure helpers exported from main.ts:
 *   - buildSpawnTraceparentGetter(taskId): returns a () => string
 *     callback the spawn tool plumbs into SpawnToolDeps. Always
 *     produces a deterministic v00 traceparent for the parent's
 *     own runId so the child can re-derive the same trace tree.
 *   - parseInheritedParentSpanContext(env): reads OTEL_TRACEPARENT
 *     out of process.env and returns a {traceId, spanId} suitable
 *     for OtelTraceSinkOptions.parentSpanContext, or undefined when
 *     the env is absent / malformed.
 * ===================================================================== */

describe('buildSpawnTraceparentGetter (v0.1.11)', () => {
  it('returns a callback that produces a W3C v00 traceparent for the parent task', async () => {
    const { buildSpawnTraceparentGetter } = await import('./main.js');
    const get = buildSpawnTraceparentGetter('task-uid-parent-1');
    const tp = get();
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('is deterministic — same taskId → same traceparent on every call', async () => {
    const { buildSpawnTraceparentGetter } = await import('./main.js');
    const get = buildSpawnTraceparentGetter('task-uid-stable');
    expect(get()).toBe(get());
  });

  it('different taskIds produce different traceparents (no trivial collision)', async () => {
    const { buildSpawnTraceparentGetter } = await import('./main.js');
    expect(buildSpawnTraceparentGetter('a')()).not.toBe(buildSpawnTraceparentGetter('b')());
  });
});

describe('parseInheritedParentSpanContext (v0.1.11)', () => {
  it('returns undefined when OTEL_TRACEPARENT is absent', async () => {
    const { parseInheritedParentSpanContext } = await import('./main.js');
    expect(parseInheritedParentSpanContext({})).toBeUndefined();
  });

  it('returns undefined when OTEL_TRACEPARENT is empty', async () => {
    const { parseInheritedParentSpanContext } = await import('./main.js');
    expect(parseInheritedParentSpanContext({ OTEL_TRACEPARENT: '' })).toBeUndefined();
  });

  it('returns undefined when OTEL_TRACEPARENT is malformed (logs + degrades)', async () => {
    const { parseInheritedParentSpanContext } = await import('./main.js');
    expect(
      parseInheritedParentSpanContext({ OTEL_TRACEPARENT: 'not-a-traceparent' }),
    ).toBeUndefined();
  });

  it('returns the parent context when OTEL_TRACEPARENT is well-formed', async () => {
    const { parseInheritedParentSpanContext } = await import('./main.js');
    const ctx = parseInheritedParentSpanContext({
      OTEL_TRACEPARENT: '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01',
    });
    expect(ctx).toEqual({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: 'fedcba9876543210',
    });
  });
});

/* =====================================================================
 * Audit C2.2 HIGH #2 — fail-closed publish capability selection.
 *
 * `selectPublishCapabilityBundle` is the single decision point the
 * publish-event wiring uses to pick which CapabilityBundle (if any) is
 * threaded to `EventPublisher` + `definePublishEvent`. The trust rule:
 * ONLY the operator-minted, JWKS-verified bundle counts. The Agent's
 * GitOps-mutable `spec.capabilityClaims.publish` MUST NOT be allowed to
 * synthesize a bundle that bypasses the cap-issuer signature check.
 * ===================================================================== */

describe('selectPublishCapabilityBundle (audit C2.2 — no synthetic fallback)', () => {
  const sampleOperatorBundle: CapabilityBundle = {
    iss: 'kagent.knuteson.io/operator',
    sub: 'task-uid:real',
    aud: ['kagent-substrate'],
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: 'cap-real-1',
    claims: { publish: ['research.*'] },
  };

  it('returns the operator-minted bundle verbatim when one was loaded', () => {
    const out = selectPublishCapabilityBundle(sampleOperatorBundle, ['research.*']);
    expect(out).toBe(sampleOperatorBundle);
  });

  it('returns undefined when no operator JWT is mounted, even when Agent.spec.capabilityClaims.publish is non-empty', () => {
    const out = selectPublishCapabilityBundle(undefined, ['research.*', 'audit.completed']);
    expect(out).toBeUndefined();
  });

  it('returns undefined when no operator JWT is mounted and no agent-spec claims either', () => {
    const out = selectPublishCapabilityBundle(undefined, undefined);
    expect(out).toBeUndefined();
  });
});

describe('publish_event wiring (audit C2.2 — fail-closed when no operator JWT)', () => {
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

  const FAKE_CTX = {
    /* satisfies ToolInvocationContext minimally — handler doesn't read it. */
  } as unknown as Parameters<ReturnType<typeof definePublishEvent>['handler']>[1];

  it('refuses publish_event when no operator-signed JWT is mounted, even when Agent.spec.capabilityClaims.publish is non-empty', async () => {
    // Simulate the boot path: no operator-mounted CapabilityBundle (the
    // JWT file at KAGENT_CAP_JWT_FILE was absent), but the Agent CRD
    // spec carries a verbatim `capabilityClaims.publish = ['some.topic']`
    // — exactly the situation the audit flagged as "self-minted bundle
    // bypasses JWKS verification".
    const operatorBundle: CapabilityBundle | undefined = undefined;
    const agentSpecPublishClaims: readonly string[] = ['research.findings'];

    // Run the same selection logic main.ts will use post-fix.
    const wiredBundle = selectPublishCapabilityBundle(operatorBundle, agentSpecPublishClaims);

    // Post-fix invariant: NO synthetic bundle is produced.
    expect(wiredBundle).toBeUndefined();

    // Wire the publish_event tool the way main.ts does, with the wired
    // bundle. The publisher itself gets no `publishClaims` (mirrors the
    // post-fix conditional-spread in main.ts).
    const conn = makeFakeConn();
    const publisher = new EventPublisher({
      source: 'kagent.knuteson.io/agent-pod/researcher/task-uid-1',
      connectFn: () => Promise.resolve(conn),
      logger: { warn: () => {}, error: () => {} },
    });
    await publisher.connect('nats://stub');

    const tool = definePublishEvent({
      publisher,
      capabilityBundle: wiredBundle,
      declaredPublishes: new Set(agentSpecPublishClaims),
    });

    // The tool MUST refuse with policy_denied:no_capability — the LLM
    // sees a structured refusal, NATS sees zero publishes.
    await expect(
      tool.handler({ topic: 'research.findings', data: { x: 1 } }, FAKE_CTX),
    ).rejects.toThrow(/policy_denied:no_capability/);
    expect(conn.publishCalls).toHaveLength(0);
  });
});
