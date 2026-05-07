/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Component 3 — `KagentRunBudgetExtractor` (R3 §4.1).
 *
 * Walks Vercel AI SDK `streamText`/`generateText` result steps and
 * builds a kagent-shaped `RunBudget` so `computeQualityFlags` (the
 * `context_pressure_ignored` detector callsite in
 * `@kagent/agent-loop/detectors/quality-flags.ts:100-116`) accepts the
 * shape unchanged.
 *
 * The detector reads three fields off `RunBudget`:
 *   - `cumulativeInputTokens`
 *   - `cumulativeOutputTokens`
 *   - `contextWindowTokens`
 *
 * Vercel AI SDK exposes per-step `usage` on each `StepResult`
 * (`StepResult.usage.inputTokens`, `StepResult.usage.outputTokens`).
 * The extractor sums these into the kagent shape; `contextWindowTokens`
 * is threaded in from the caller (the runner reads it from the same
 * `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` env that
 * `@kagent/agent-pod/env.ts:parseContextWindowTokens` reads, so both
 * adapters honor the same operator-projected source).
 *
 * Cost is left `null` — Vercel AI SDK doesn't surface per-step USD
 * cost natively; integrators wanting cost accounting can post-process
 * via the gateway's usage-records endpoint. This matches the agent-pod
 * runner's behavior when an LLM client returns `usage.costUsd === null`
 * (see `@kagent/agent-loop/executor.ts:925-927`).
 */

import type { RunBudget } from '@kagent/agent-loop';

/**
 * Per-step shape we accept. Structurally compatible with Vercel AI
 * SDK's `StepResult.usage` (which has an `inputTokens` and
 * `outputTokens` number-or-undefined pair) — we type our own minimal
 * interface so the extractor doesn't depend on an exact AI SDK
 * minor version's union shape.
 */
export interface RunBudgetExtractorInput {
  readonly steps: readonly {
    readonly usage?: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    };
  }[];
  /**
   * Optional model context window. Threaded through so the
   * `context_pressure_ignored` detector reads a populated value when
   * the operator wired one.
   */
  readonly contextWindowTokens?: number;
  /**
   * Optional pre-existing cumulative state. When the runner uses the
   * `KagentContextSafetyMiddleware`'s cumulative counter as the
   * authoritative source, the extractor can re-use that snapshot
   * instead of re-summing from steps. Steps are still iterated for
   * back-compat / sanity check; when both are provided, the cumulative
   * snapshot wins.
   */
  readonly cumulativeFromMiddleware?: {
    readonly input: number;
    readonly output: number;
  };
}

/**
 * Extracted shape — a `RunBudget` plus a derived `utilization`
 * convenience field useful for tests + log lines. The detector
 * doesn't read `utilization`; only `RunBudget` is fed into
 * `computeQualityFlags`.
 */
export interface ExtractedRunBudget {
  readonly budget: RunBudget;
  readonly utilization: number | null;
}

/**
 * Build the kagent `RunBudget` from Vercel AI SDK steps + context-window
 * env. Pure function; no I/O. Idempotent — calling twice with the same
 * input yields equal output.
 */
export function buildRunBudget(input: RunBudgetExtractorInput): ExtractedRunBudget {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const step of input.steps) {
    const u = step.usage;
    if (u) {
      if (typeof u.inputTokens === 'number' && Number.isFinite(u.inputTokens)) {
        inputTokens += u.inputTokens;
      }
      if (typeof u.outputTokens === 'number' && Number.isFinite(u.outputTokens)) {
        outputTokens += u.outputTokens;
      }
    }
  }
  // Middleware-snapshot wins on conflict — it's the same accounting
  // path the substrate's safety-net actually consulted, so any
  // discrepancy with the per-step sum reflects a provider that
  // omitted usage from the step shape but reported it on the wire
  // (the middleware reads the wire-level usage).
  if (input.cumulativeFromMiddleware) {
    inputTokens = input.cumulativeFromMiddleware.input;
    outputTokens = input.cumulativeFromMiddleware.output;
  }
  const budget: RunBudget = {
    cumulativeInputTokens: inputTokens,
    cumulativeOutputTokens: outputTokens,
    cumulativeCostUsd: null,
    ...(input.contextWindowTokens !== undefined && {
      contextWindowTokens: input.contextWindowTokens,
    }),
  };
  const utilization =
    input.contextWindowTokens !== undefined && input.contextWindowTokens > 0
      ? (inputTokens + outputTokens) / input.contextWindowTokens
      : null;
  return { budget, utilization };
}
