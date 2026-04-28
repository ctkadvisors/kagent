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
