/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import type { PodConfig } from './env.js';
import { buildCancelledResult, buildShutdownPlan } from './main.js';

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
