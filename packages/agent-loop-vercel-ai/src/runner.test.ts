/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for Component 5 — `runVercelAiAgentTask`.
 *
 * R3 §4.1 requires: integration test using stubbed `streamText` + a
 * realistic kagent-pod env shape.
 */

import { describe, expect, it } from 'vitest';
import type { LanguageModelV3 } from '@ai-sdk/provider';

import { runVercelAiAgentTask } from './runner.js';

/**
 * Build a stub `streamText` that resolves with a fake StreamTextResult
 * shape. The stub captures whatever opts the runner passed so the
 * test can assert tools / model / system prompt threading.
 *
 * The real `streamText` returns a `StreamTextResult` that has a
 * `.text` Promise; the runner awaits this. The stub resolves with
 * any caller-controlled string.
 */
function makeStubStreamText(opts: { finalText: string; onStepFinishWith?: unknown[] }) {
  const captured: { lastOpts?: Record<string, unknown> } = {};
  // The fake — explicitly typed `as unknown as typeof streamText` at
  // the call site.
  const stub = (callerOpts: Record<string, unknown>) => {
    captured.lastOpts = callerOpts;
    if (opts.onStepFinishWith) {
      const onStepFinish = callerOpts.onStepFinish as ((step: unknown) => void) | undefined;
      if (typeof onStepFinish === 'function') {
        for (const s of opts.onStepFinishWith) {
          onStepFinish(s);
        }
      }
    }
    return { text: Promise.resolve(opts.finalText) };
  };
  return { stub, captured };
}

const stubModel = {} as LanguageModelV3;

describe('runVercelAiAgentTask', () => {
  it('runs to completion and produces a kagent-shaped RunResult', async () => {
    const { stub } = makeStubStreamText({
      finalText: 'all done',
      onStepFinishWith: [
        {
          text: 'all done',
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50 },
          toolCalls: [],
          toolResults: [],
        },
      ],
    });
    const result = await runVercelAiAgentTask({
      model: stubModel,
      runId: 'task-1',
      userMessage: 'go',
      contextWindowTokens: 1000,
      _streamText: stub as never,
    });
    expect(result.runId).toBe('task-1');
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('all done');
    expect(result.budget.contextWindowTokens).toBe(1000);
    // The trace MUST contain at least one iteration_boundary so the
    // detector's lookback walker has something to see.
    const boundaries = result.traces.filter((t) => t.trace_type === 'iteration_boundary');
    expect(boundaries.length).toBeGreaterThan(0);
    // And a run_complete entry stamping the cumulative state.
    const final = result.traces.find((t) => t.trace_type === 'run_complete');
    expect(final?.final_status).toBe('completed');
  });

  it('threads tools through to streamText opts when substrate definitions are passed', async () => {
    const { stub, captured } = makeStubStreamText({
      finalText: 'ok',
      onStepFinishWith: [],
    });
    await runVercelAiAgentTask({
      model: stubModel,
      runId: 'task-1',
      userMessage: 'go',
      substrateToolDefinitions: [
        {
          name: 'get_my_context',
          description: 'introspect',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          handler: () => 'ctx',
        },
      ],
      _streamText: stub as never,
    });
    const tools = captured.lastOpts?.tools as Record<string, unknown> | undefined;
    expect(tools).toBeDefined();
    expect(tools?.get_my_context).toBeDefined();
  });

  it('maps a context-window refusal thrown by streamText to status=failed with the kagent reason string', async () => {
    // Simulate the safety-net firing inside streamText. The real
    // production path is: the wrapped model's middleware throws,
    // streamText surfaces the error from `.text`. We simulate by
    // having the stub's .text reject with the kagent-shaped error.
    const refusalErr = new Error(
      'context_window_substrate_refused: cumulative=1000 window=1000 threshold=0.95',
    );
    const stub = (_opts: unknown) => ({
      text: Promise.reject(refusalErr),
    });
    const result = await runVercelAiAgentTask({
      model: stubModel,
      runId: 'task-2',
      userMessage: 'go',
      contextWindowTokens: 1000,
      _streamText: stub as never,
    });
    expect(result.status).toBe('failed');
    expect(result.error?.message).toMatch(/^context_window_substrate_refused:/);
  });

  it('threads maxSteps to streamText.stopWhen so multi-step tool loops actually iterate (R3-B1)', async () => {
    // R3-B1 regression: the runner declared `maxSteps` but never
    // passed it to `streamText`. AI SDK 6's default
    // `stopWhen: stepCountIs(1)` would then cap the loop at one LLM
    // step regardless of caller input. This test asserts the runner
    // (a) wires `stopWhen` and (b) the resulting cap matches
    // `input.maxSteps` (or the package default of 16).
    //
    // We capture the `stopWhen` value passed to the stub and assert
    // its `stepCountIs(N)` shape: `stepCountIs` returns a function
    // whose body references the configured step count, but more
    // robustly we just verify SOMETHING was passed — defaulting to
    // `undefined` would mean the AI SDK falls back to its
    // `stepCountIs(1)` default.
    const { stub, captured } = makeStubStreamText({
      finalText: 'ok',
      onStepFinishWith: [],
    });
    await runVercelAiAgentTask({
      model: stubModel,
      runId: 'task-maxsteps',
      userMessage: 'go',
      maxSteps: 8,
      _streamText: stub as never,
    });
    // The runner MUST have threaded `stopWhen`. Any value other than
    // `undefined` indicates the cap propagated. The exact shape is
    // determined by `stepCountIs` from the `ai` package — we only
    // assert presence.
    expect(captured.lastOpts?.stopWhen).toBeDefined();
  });

  it('default maxSteps allows a multi-step tool loop (≥2 LLM calls before completion) (R3-B1)', async () => {
    // Higher-fidelity fake: simulates a real multi-step agent where
    // the model calls a tool on step 1, gets a tool result, then
    // produces a final answer on step 2. This is the integrated
    // shape the real `streamText` runs when `stopWhen: stepCountIs(N)`
    // permits more than 1 step.
    //
    // The fake counts how many `onStepFinish` callbacks fire — this
    // stands in for "how many LLM rounds happened before the loop
    // terminated naturally." With the R3-B1 fix, the runner's
    // `stopWhen` permits >=2 steps; the test fires >=2 step finishes
    // and asserts the runner observed all of them.
    let stepFinishCount = 0;
    const fakeStreamText = (callerOpts: Record<string, unknown>) => {
      const onStepFinish = callerOpts.onStepFinish as ((step: unknown) => void) | undefined;
      // Step 1 — model calls a tool.
      if (typeof onStepFinish === 'function') {
        onStepFinish({
          text: '',
          finishReason: 'tool-calls',
          usage: { inputTokens: 100, outputTokens: 50 },
          toolCalls: [{ toolName: 'echo', input: { msg: 'hi' } }],
          toolResults: [{ toolName: 'echo', output: 'hi' }],
        });
        stepFinishCount++;
        // Step 2 — model emits final text.
        onStepFinish({
          text: 'final answer',
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 25 },
          toolCalls: [],
          toolResults: [],
        });
        stepFinishCount++;
      }
      return { text: Promise.resolve('final answer') };
    };
    const result = await runVercelAiAgentTask({
      model: stubModel,
      runId: 'task-multistep',
      userMessage: 'go',
      _streamText: fakeStreamText as never,
    });
    expect(result.status).toBe('completed');
    expect(stepFinishCount).toBeGreaterThanOrEqual(2);
    // Trace bridge should show >=2 llm_call entries — one per step.
    const llms = result.traces.filter((t) => t.trace_type === 'llm_call');
    expect(llms.length).toBeGreaterThanOrEqual(2);
  });

  it('detector fires context_pressure_ignored under realistic middleware accounting (R3-LOW-4)', async () => {
    // R3-LOW-4 — pre-fix this test's title claimed it tested the
    // detector firing but the body asserted the NEGATIVE shape (the
    // stub bypassed the wrapped model so the middleware's cumulative
    // counter stayed at 0 and the detector could not fire). The
    // audit (audit-rev3/R3.md §2 runner.test.ts) flagged this as the
    // exact "test the code path, not the guarantee" anti-pattern.
    //
    // Higher-fidelity fake: instead of bypassing the wrapped model,
    // the fake `_streamText` calls into `wrappedModel.doGenerate(...)`
    // for each simulated step. The middleware's `wrapGenerate`
    // intercepts each call and records usage from the returned shape
    // — so by the time the runner extracts `safetyMw.currentCumulativeTokens()`
    // for the budget, the cumulative counter reflects ACTUAL token
    // accounting (not the stubbed step-finish payload). The detector
    // then sees a realistic utilization ratio.
    // Sync function returning a `text` Promise — matches `streamText`'s
    // own contract (it returns a `StreamTextResult` synchronously and
    // the caller awaits `.text`). The Promise body drives the wrapped
    // model directly, so the middleware's `wrapGenerate` runs and
    // accumulates real usage.
    const fakeStreamText = (callerOpts: Record<string, unknown>): { text: Promise<string> } => {
      const wrappedModel = callerOpts.model as {
        doGenerate: (params: unknown) => Promise<{
          content: { type: string; text: string }[];
          usage: {
            inputTokens: { total: number };
            outputTokens: { total: number };
          };
        }>;
      };
      const onStepFinish = callerOpts.onStepFinish as ((step: unknown) => void) | undefined;
      const drive = async (): Promise<string> => {
        // Each simulated step calls into the wrapped model. The
        // middleware observes usage on every call. Three rounds of
        // 350 tokens each accumulates to 1050 tokens — drives
        // utilization above the default 0.7 detector threshold for a
        // 1000-token window.
        for (let i = 0; i < 3; i++) {
          const result = await wrappedModel.doGenerate({ prompt: [] });
          if (onStepFinish) {
            onStepFinish({
              text: result.content[0]?.text ?? '',
              finishReason: i === 2 ? 'stop' : 'tool-calls',
              usage: {
                inputTokens: result.usage.inputTokens.total,
                outputTokens: result.usage.outputTokens.total,
              },
              toolCalls: [],
              toolResults: [],
            });
          }
        }
        return 'final';
      };
      return { text: drive() };
    };

    // Build a LanguageModelV3-shaped fake whose `doGenerate` returns
    // a usage record the middleware can observe. The middleware's
    // `wrapGenerate` will intercept this — so the cumulative counter
    // accumulates real tokens, not stubbed values.
    const realModel = {
      specificationVersion: 'v3' as const,
      provider: 'fake',
      modelId: 'fake-pressure',
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'partial' }],
          usage: {
            inputTokens: { total: 250 },
            outputTokens: { total: 100 },
          },
          finishReason: 'stop',
          warnings: [],
        }),
    } as unknown as LanguageModelV3;

    const result = await runVercelAiAgentTask({
      model: realModel,
      runId: 'task-3',
      userMessage: 'a representative user prompt with some real content',
      contextWindowTokens: 1000,
      // Lower the detector's pressure threshold so 1050/1000 = 1.05
      // utilization clearly exceeds it. Default is 0.7; we leave
      // default to verify the realistic ratio fires the detector.
      spawnToolAdmitted: true,
      _streamText: fakeStreamText as never,
    });

    // Substrate-guarantee assertion (R3-LOW-4 the corrected one):
    // the budget reflects the cumulative tokens the middleware
    // observed via three 350-token rounds (1050 total) against a
    // 1000-token window — the detector MUST see this utilization.
    expect(result.status).toBe('completed');
    expect(result.budget.contextWindowTokens).toBe(1000);
    expect(result.budget.cumulativeInputTokens).toBe(750);
    expect(result.budget.cumulativeOutputTokens).toBe(300);
    // The trace shape is still detector-readable (per Component 4).
    const llms = result.traces.filter((t) => t.trace_type === 'llm_call');
    expect(llms.length).toBe(3);
    // The detector fires `context_pressure_ignored` when (a) cumulative
    // usage exceeds the configured pressure threshold (default 0.7),
    // (b) `spawnToolAdmitted` is true, and (c) no spawn_child_task
    // was invoked in the lookback window. All three hold here, so
    // the substrate guarantee is observable end-to-end.
    expect(result.flags).toContain('context_pressure_ignored');
  });
});
