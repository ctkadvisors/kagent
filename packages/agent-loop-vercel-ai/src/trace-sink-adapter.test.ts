/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for Component 4 — `buildTraceSinkBridge`.
 *
 * R3 §4.1 requires: trace bridge writes `iteration_boundary` markers
 * the detector lookback can read.
 */

import { describe, expect, it } from 'vitest';

import { buildTraceSinkBridge } from './trace-sink-adapter.js';

describe('buildTraceSinkBridge', () => {
  it('emits iteration_boundary entries that the detector lookback walker reads', () => {
    const bridge = buildTraceSinkBridge({ runId: 'r1', model: 'm' });
    bridge.openIteration();
    bridge.openIteration();
    bridge.openIteration();
    const traces = bridge.traces();
    const boundaries = traces.filter((t) => t.trace_type === 'iteration_boundary');
    expect(boundaries.length).toBe(3);
    expect(boundaries[0]?.iteration).toBe(0);
    expect(boundaries[1]?.iteration).toBe(1);
    expect(boundaries[2]?.iteration).toBe(2);
  });

  it('emits llm_call entries with model + token estimates from steps', () => {
    const bridge = buildTraceSinkBridge({ runId: 'r1', model: 'gpt-4o' });
    bridge.onStepFinish({
      text: 'hello world',
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
      toolCalls: [],
      toolResults: [],
    });
    const traces = bridge.traces();
    const llm = traces.find((t) => t.trace_type === 'llm_call');
    expect(llm).toBeDefined();
    expect(llm?.model).toBe('gpt-4o');
    expect(llm?.input_tokens_est).toBe(100);
    expect(llm?.output_tokens_est).toBe(50);
    expect(llm?.stop_reason).toBe('stop');
  });

  it('emits tool_call entries for each tool result on a step', () => {
    const bridge = buildTraceSinkBridge({ runId: 'r1' });
    bridge.onStepFinish({
      text: '',
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [{ toolName: 'spawn_child_task', input: { agentName: 'x' } }],
      toolResults: [{ toolName: 'spawn_child_task', output: { name: 'child-1' } }],
    });
    const traces = bridge.traces();
    const tool = traces.find((t) => t.trace_type === 'tool_call');
    expect(tool).toBeDefined();
    expect(tool?.tool_name).toBe('spawn_child_task');
    expect(tool?.tool_provider_id).toBe('vercel-ai-adapter');
    expect(tool?.is_error).toBe(false);
  });

  it('marks tool_call entries as is_error when output carries isError flag', () => {
    const bridge = buildTraceSinkBridge({ runId: 'r1' });
    bridge.onStepFinish({
      text: '',
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [{ toolName: 'foo', input: {} }],
      toolResults: [{ toolName: 'foo', output: { isError: true, content: 'oops' } }],
    });
    const tool = bridge.traces().find((t) => t.trace_type === 'tool_call');
    expect(tool?.is_error).toBe(true);
  });

  it('emits a run_complete entry with cumulative tokens + status', () => {
    const bridge = buildTraceSinkBridge({ runId: 'r1' });
    bridge.openIteration();
    bridge.onFinish({
      finalText: 'done',
      status: 'completed',
      cumulativeInputTokens: 500,
      cumulativeOutputTokens: 250,
    });
    const final = bridge.traces().find((t) => t.trace_type === 'run_complete');
    expect(final).toBeDefined();
    expect(final?.final_content).toBe('done');
    expect(final?.final_status).toBe('completed');
    expect(final?.cumulative_input_tokens).toBe(500);
    expect(final?.cumulative_output_tokens).toBe(250);
  });

  it('produces strictly monotonic sequence numbers across all entry types', () => {
    const bridge = buildTraceSinkBridge({ runId: 'r1' });
    bridge.openIteration();
    bridge.onStepFinish({
      text: 'a',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [{ toolName: 't', input: {} }],
      toolResults: [{ toolName: 't', output: 'ok' }],
    });
    bridge.onFinish({
      finalText: 'a',
      status: 'completed',
      cumulativeInputTokens: 1,
      cumulativeOutputTokens: 1,
    });
    const seqs = bridge.traces().map((t) => t.sequence);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('forwards every emitted entry to registered TraceSinks (R3-LOW-2)', () => {
    // Build a fake sink that captures emitted entries. The bridge's
    // `traces()` accessor still returns the in-memory collection;
    // the new contract is that the SAME stream also fans out to
    // every registered sink so production OTel + Langfuse + Stdout
    // sinks see every entry.
    const captured: { entries: { trace_type: string; sequence: number }[] } = { entries: [] };
    const sink = {
      emit: (entry: { trace_type: string; sequence: number }): void => {
        captured.entries.push({ trace_type: entry.trace_type, sequence: entry.sequence });
      },
    };
    const bridge = buildTraceSinkBridge({
      runId: 'r1',
      model: 'm',
      traceSinks: [sink],
    });
    bridge.openIteration();
    bridge.onStepFinish({
      text: 'hi',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [{ toolName: 't', input: {} }],
      toolResults: [{ toolName: 't', output: 'ok' }],
    });
    bridge.onFinish({
      finalText: 'hi',
      status: 'completed',
      cumulativeInputTokens: 1,
      cumulativeOutputTokens: 1,
    });
    // The sink should have received: iteration_boundary, llm_call,
    // tool_call, run_complete (4 entries, monotonic sequence).
    expect(captured.entries.map((e) => e.trace_type)).toEqual([
      'iteration_boundary',
      'llm_call',
      'tool_call',
      'run_complete',
    ]);
    // The in-memory `traces()` accessor must remain identical to the
    // sink stream — this preserves back-compat for callers that read
    // the array.
    expect(bridge.traces().length).toBe(captured.entries.length);
  });

  it('swallows sink emit() errors so a buggy sink cannot crash the run (R3-LOW-2)', () => {
    const goodSink = {
      received: 0,
      emit: function emitGood(): void {
        this.received++;
      },
    };
    const badSink = {
      emit: (): void => {
        throw new Error('intentional sink failure');
      },
    };
    const bridge = buildTraceSinkBridge({
      runId: 'r1',
      traceSinks: [badSink, goodSink],
    });
    expect(() => bridge.openIteration()).not.toThrow();
    expect(() => bridge.openIteration()).not.toThrow();
    // Good sink should still have observed both entries even though
    // the bad sink threw on each one.
    expect(goodSink.received).toBe(2);
  });
});
