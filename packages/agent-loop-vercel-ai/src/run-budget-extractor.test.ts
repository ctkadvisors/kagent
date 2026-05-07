/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for Component 3 — `buildRunBudget`.
 *
 * R3 §4.1 requires: extractor produces `RunBudget` that
 * `computeQualityFlags` accepts and the `context_pressure_ignored`
 * detector recognizes.
 */

import { describe, expect, it } from 'vitest';
import { computeQualityFlags } from '@kagent/agent-loop';
import type { TraceEntry } from '@kagent/agent-loop';

import { buildRunBudget } from './run-budget-extractor.js';

describe('buildRunBudget', () => {
  it('sums per-step usage and produces a kagent RunBudget', () => {
    const out = buildRunBudget({
      steps: [
        { usage: { inputTokens: 100, outputTokens: 50 } },
        { usage: { inputTokens: 200, outputTokens: 75 } },
      ],
      contextWindowTokens: 1000,
    });
    expect(out.budget.cumulativeInputTokens).toBe(300);
    expect(out.budget.cumulativeOutputTokens).toBe(125);
    expect(out.budget.cumulativeCostUsd).toBeNull();
    expect(out.budget.contextWindowTokens).toBe(1000);
    expect(out.utilization).toBeCloseTo(0.425);
  });

  it('omits contextWindowTokens when not provided (back-compat no-op path)', () => {
    const out = buildRunBudget({
      steps: [{ usage: { inputTokens: 100, outputTokens: 50 } }],
    });
    expect(out.budget.contextWindowTokens).toBeUndefined();
    expect(out.utilization).toBeNull();
  });

  it('prefers middleware cumulative snapshot over step sum', () => {
    const out = buildRunBudget({
      steps: [{ usage: { inputTokens: 100, outputTokens: 50 } }],
      cumulativeFromMiddleware: { input: 999, output: 1 },
      contextWindowTokens: 2000,
    });
    expect(out.budget.cumulativeInputTokens).toBe(999);
    expect(out.budget.cumulativeOutputTokens).toBe(1);
  });

  it('produces a budget that the context_pressure_ignored detector ACCEPTS', () => {
    // Cumulative tokens 800 vs window 1000 → utilization 0.8 above default
    // pressureThreshold (0.7). With NO spawn_child_task in the trace
    // AND `spawnToolAdmitted: true`, the detector MUST fire.
    const { budget } = buildRunBudget({
      steps: [],
      cumulativeFromMiddleware: { input: 600, output: 200 },
      contextWindowTokens: 1000,
    });
    const traces: TraceEntry[] = [
      {
        schema_version: '1',
        run_id: 'r',
        sequence: 0,
        trace_type: 'iteration_boundary',
        timestamp_ms: 0,
        latency_ms: 0,
        iteration: 0,
      },
      {
        schema_version: '1',
        run_id: 'r',
        sequence: 1,
        trace_type: 'iteration_boundary',
        timestamp_ms: 0,
        latency_ms: 0,
        iteration: 1,
      },
      {
        schema_version: '1',
        run_id: 'r',
        sequence: 2,
        trace_type: 'iteration_boundary',
        timestamp_ms: 0,
        latency_ms: 0,
        iteration: 2,
      },
      {
        schema_version: '1',
        run_id: 'r',
        sequence: 3,
        trace_type: 'iteration_boundary',
        timestamp_ms: 0,
        latency_ms: 0,
        iteration: 3,
      },
    ];
    const flags = computeQualityFlags(traces, 'final', 'go', budget, {
      spawnToolAdmitted: true,
    });
    expect(flags).toContain('context_pressure_ignored');
  });

  it('detector does NOT fire when spawn_child_task is admitted but appeared in lookback', () => {
    const { budget } = buildRunBudget({
      steps: [],
      cumulativeFromMiddleware: { input: 600, output: 200 },
      contextWindowTokens: 1000,
    });
    const traces: TraceEntry[] = [
      {
        schema_version: '1',
        run_id: 'r',
        sequence: 0,
        trace_type: 'iteration_boundary',
        timestamp_ms: 0,
        latency_ms: 0,
        iteration: 0,
      },
      {
        schema_version: '1',
        run_id: 'r',
        sequence: 1,
        trace_type: 'tool_call',
        timestamp_ms: 0,
        latency_ms: 0,
        tool_name: 'spawn_child_task',
        is_error: false,
      },
    ];
    const flags = computeQualityFlags(traces, 'final', 'go', budget, {
      spawnToolAdmitted: true,
    });
    expect(flags).not.toContain('context_pressure_ignored');
  });
});
