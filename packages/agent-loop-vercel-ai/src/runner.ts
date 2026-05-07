/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Component 5 — `runVercelAiAgentTask` (R3 §4.1).
 *
 * Boot path analog to `@kagent/agent-pod`'s `runAgentTask`. Wires the
 * four substrate-bridge components (context-safety middleware,
 * substrate tools adapter, run-budget extractor, trace-sink adapter)
 * + the per-tool capability wrapper into a single `streamText` call,
 * returning a `RunResult`-shaped value compatible with the agent-pod
 * runner protocol.
 *
 * Production positioning: this function is what a kagent operator
 * would call from a Vercel-AI-SDK-based in-pod runtime's `main.ts`
 * to run a single AgentTask. It honors the same four substrate
 * guarantees as `@kagent/agent-pod`'s reference runner:
 *
 *   1. Context-window safety-net at 95% (Component 1).
 *   2. Capability JWT enforcement per-tool (Component 6).
 *   3. Substrate tools (`spawn_child_task` etc.) re-emitted in
 *      Vercel AI SDK shape (Component 2).
 *   4. `context_pressure_ignored` detector compatibility via the
 *      run-budget extractor (Component 3) + trace-sink bridge
 *      (Component 4).
 *
 * Status: reference adapter, not the production runtime. The
 * production in-pod runtime remains `@kagent/agent-pod`.
 */

import {
  computeQualityFlags,
  type ContextPressureOpts,
  type RunBudget,
  type TerminalStatus,
  type TraceEntry,
} from '@kagent/agent-loop';
import type { CapabilityBundle } from '@kagent/capability-types';
import type { InProcessToolDefinition } from '@kagent/in-process-tool-provider';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { stepCountIs, streamText, wrapLanguageModel, type ModelMessage } from 'ai';

import {
  KagentContextSafetyMiddleware,
  KagentContextWindowRefusedError,
} from './context-safety-middleware.js';
import {
  buildSubstrateTools,
  type SubstrateToolCapabilityBinding,
} from './substrate-tools-adapter.js';
import { buildRunBudget } from './run-budget-extractor.js';
import { buildTraceSinkBridge } from './trace-sink-adapter.js';

/**
 * Inputs to `runVercelAiAgentTask`. Designed so a runner-side caller
 * can build the value from parsed `PodConfig` (reuse
 * `@kagent/agent-pod`'s env reader) + the in-pod K8s/JWT/cap state
 * the existing `main.ts` already resolves.
 */
export interface RunVercelAiAgentTaskInput {
  /** Model id passed to AI SDK telemetry + traces. */
  readonly model: LanguageModelV3;
  readonly modelId?: string;
  readonly runId: string;
  /** System prompt — equivalent to `Agent.spec.systemPrompt`. */
  readonly systemPrompt?: string;
  /** Initial user message. Equivalent to `pickUserMessage(podConfig)`. */
  readonly userMessage: string;
  /** Substrate tool definitions the runner has already constructed. */
  readonly substrateToolDefinitions?: readonly InProcessToolDefinition[];
  /** `Agent.spec.tools` allowlist — passes through to the adapter. */
  readonly admittedToolNames?: readonly string[];
  /** Per-tool capability bindings — see Component 2. */
  readonly capabilityBindings?: Readonly<Record<string, SubstrateToolCapabilityBinding>>;
  /** Verified bundle from `cap-consumer.loadCapabilityOptional`. */
  readonly capabilityBundle?: CapabilityBundle;
  /** Operator-projected `KAGENT_AGENT_MODEL_CONTEXT_WINDOW`. */
  readonly contextWindowTokens?: number;
  /** Operator-projected `KAGENT_CONTEXT_SAFETY_THRESHOLD`. */
  readonly contextSafetyThreshold?: number;
  /** Detector-tunable threshold from `KAGENT_CONTEXT_PRESSURE_THRESHOLD`. */
  readonly contextPressureThreshold?: number;
  /**
   * Detector escape — when `spawn_child_task` is not admitted on the
   * Agent, the detector skips per `quality-flags.ts:150-157`.
   */
  readonly spawnToolAdmitted?: boolean;
  /** Caller-owned cancellation. */
  readonly signal?: AbortSignal;
  /**
   * Step cap. Threaded into AI SDK's `stopWhen: stepCountIs(maxSteps)`
   * so the implicit tool-using agent loop continues for at most this
   * many steps. Defaults to 16 — matches the agent-pod runner's
   * `maxIterations` default for the reference loop. The AI SDK's own
   * default is `stepCountIs(1)` (single LLM step) — without this thread
   * a tool-using agent would terminate after the first model call.
   * See R3-B1 (audit-rev3) — `runner.ts:181-193` previously declared
   * the field but did not pass it to `streamText`.
   */
  readonly maxSteps?: number;
  /**
   * Test injection — when supplied, runs through this stub instead of
   * the real `streamText`. The test harness uses this to drive
   * deterministic step shapes without spinning up a model.
   */
  readonly _streamText?: typeof streamText;
}

/**
 * Output — same shape as `@kagent/agent-pod`'s `RunResult` (the agent-pod
 * type is structurally compatible — we redeclare locally to avoid
 * importing the agent-pod package transitively).
 */
export interface VercelAiRunResult {
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly finalContent: string | null;
  readonly flags: readonly string[];
  readonly traces: readonly TraceEntry[];
  readonly budget: RunBudget;
  readonly error?: { readonly message: string };
}

/**
 * Run one AgentTask through Vercel AI SDK's `streamText`, honoring all
 * four substrate guarantees.
 */
export async function runVercelAiAgentTask(
  input: RunVercelAiAgentTaskInput,
): Promise<VercelAiRunResult> {
  // (1) Context-safety middleware
  const safetyMw = new KagentContextSafetyMiddleware({
    ...(input.contextWindowTokens !== undefined && {
      contextWindowTokens: input.contextWindowTokens,
    }),
    ...(input.contextSafetyThreshold !== undefined && {
      safetyThreshold: input.contextSafetyThreshold,
    }),
  });
  const wrappedModel = wrapLanguageModel({
    model: input.model,
    middleware: safetyMw,
  });

  // (2) Substrate tools — registered only when the caller passed
  //     definitions. A bare-loop run (chat-only) skips this.
  const toolBundle = buildSubstrateTools({
    definitions: input.substrateToolDefinitions ?? [],
    ...(input.admittedToolNames !== undefined && {
      admittedToolNames: input.admittedToolNames,
    }),
    ...(input.capabilityBindings !== undefined && {
      capabilityBindings: input.capabilityBindings,
    }),
    ...(input.capabilityBundle !== undefined && {
      capabilityBundle: input.capabilityBundle,
    }),
    runId: input.runId,
  });

  // (3 + 4) Trace sink bridge — opens an iteration boundary BEFORE the
  // first step so the lookback walker has a delimiter even when
  // streamText returns immediately. Subsequent boundaries are opened
  // by the onStepStart-equivalent path; AI SDK 6 fires onStepFinish
  // per step which the bridge maps to an llm_call entry. We open a
  // new boundary in the onStepFinish handler here, so each boundary
  // delimits the END of an iteration's worth of trace events (the
  // detector's walker treats boundaries as start delimiters; the
  // ordering is consistent because every step produces one boundary
  // BEFORE its llm_call). See `quality-flags.ts:182-210`.
  const trace = buildTraceSinkBridge({
    runId: input.runId,
    ...(input.modelId !== undefined && { model: input.modelId }),
  });
  trace.openIteration();

  // Build the messages array.
  const messages: ModelMessage[] = [{ role: 'user', content: input.userMessage }];

  // Run streamText. The middleware throws on threshold;
  // `streamText` propagates the error out of the resulting promise
  // chain. We catch and map to a `failed` terminal status with the
  // structured reason (mirroring `executor.ts:825-862`).
  let finalContent: string | null = null;
  let status: TerminalStatus = 'completed';
  let errorMessage: string | undefined;
  try {
    // Thread the step cap into AI SDK's `stopWhen`. AI SDK 6 defaults
    // to `stepCountIs(1)` (one LLM call, no implicit tool-loop). The
    // agent-pod reference runner defaults `maxIterations` to a higher
    // value; mirror that here so a tool-using agent actually iterates
    // through tool-call → tool-result → next-step rounds. R3-B1
    // (audit-rev3) — without this thread the runner terminates after
    // ONE LLM step regardless of caller input.
    const stepCap = input.maxSteps ?? 16;
    const stream = (input._streamText ?? streamText)({
      model: wrappedModel,
      ...(input.systemPrompt !== undefined && { system: input.systemPrompt }),
      messages,
      tools: toolBundle.tools,
      stopWhen: stepCountIs(stepCap),
      ...(input.signal !== undefined && { abortSignal: input.signal }),
      onStepFinish: (step) => {
        trace.onStepFinish(step);
        // Open a new iteration boundary for the next step (if any).
        // streamText's stopWhen / onFinish handles termination.
        trace.openIteration();
      },
    });
    // Drain — `streamText` returns a `StreamTextResult`; awaiting
    // `.text` resolves with the final assistant string after the
    // implicit loop finishes.
    finalContent = await stream.text;
  } catch (err) {
    if (err instanceof KagentContextWindowRefusedError) {
      status = 'failed';
      errorMessage = err.message;
    } else if (input.signal?.aborted) {
      status = 'cancelled';
      errorMessage = err instanceof Error ? err.message : String(err);
    } else {
      status = 'failed';
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  // (3) Build the kagent RunBudget. Use the middleware's cumulative
  //     snapshot as the authoritative source — it tracked the same
  //     usage the safety-net consulted.
  const cumulative = safetyMw.currentCumulativeTokens();
  const extracted = buildRunBudget({
    steps: [],
    cumulativeFromMiddleware: { input: cumulative.input, output: cumulative.output },
    ...(input.contextWindowTokens !== undefined && {
      contextWindowTokens: input.contextWindowTokens,
    }),
  });

  // Stamp the run_complete entry on the trace bridge.
  trace.onFinish({
    finalText: finalContent,
    status,
    cumulativeInputTokens: cumulative.input,
    cumulativeOutputTokens: cumulative.output,
  });

  // (4) Run the detector battery — same call shape as
  //     `runner.ts:408-414` in `@kagent/agent-pod`.
  const detectorOpts: ContextPressureOpts = {
    ...(input.spawnToolAdmitted !== undefined && {
      spawnToolAdmitted: input.spawnToolAdmitted,
    }),
    ...(input.contextPressureThreshold !== undefined && {
      pressureThreshold: input.contextPressureThreshold,
    }),
  };
  const flags = computeQualityFlags(
    [...trace.traces()],
    finalContent,
    input.userMessage,
    extracted.budget,
    detectorOpts,
  );

  return {
    runId: input.runId,
    status,
    finalContent,
    flags,
    traces: trace.traces(),
    budget: extracted.budget,
    ...(errorMessage !== undefined && { error: { message: errorMessage } }),
  };
}
