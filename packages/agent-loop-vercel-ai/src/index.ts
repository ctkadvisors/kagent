/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/agent-loop-vercel-ai` — reference adapter that proves the
 * "any framework runs in a kagent pod" claim survives the v0.1.9
 * context-awareness slate.
 *
 * Audit-rev2 R3 §4 named four substrate guarantees that a third-party
 * in-pod runtime must honor to count as "drop-in":
 *
 *   1. Context-window safety-net (95% pre-call refusal). See
 *      `KagentContextSafetyMiddleware` — Vercel AI SDK middleware that
 *      throws BEFORE every `doGenerate` / `doStream` when cumulative
 *      tokens cross the configured fraction of the model's window.
 *   2. Capability JWT enforcement at the per-tool boundary. See
 *      `wrapToolWithCapabilityCheck` — wraps each `tool({execute})` so
 *      the operator-minted JWT is re-verified before the tool fires.
 *   3. Substrate-tools re-emission. See `KagentSubstrateToolsAdapter` —
 *      registers `spawn_child_task`, `wait_for_*`, `publish_event`,
 *      `read_artifact`, `write_artifact`, `get_my_context` in
 *      Vercel AI SDK `tool()` shape by delegating to the existing
 *      implementations from `@kagent/agent-pod`.
 *   4. `context_pressure_ignored` detector compatibility. See
 *      `KagentRunBudgetExtractor` — produces a kagent-shaped `RunBudget`
 *      so `computeQualityFlags` can run against post-streamText results.
 *      `KagentTraceSinkAdapter` produces compatible `TraceEntry` records
 *      so the lookback walker (`quality-flags.ts:182-210`) sees the
 *      `iteration_boundary` markers it expects.
 *
 * `runVercelAiAgentTask` wires all six pieces into a `streamText` call
 * and returns a `RunResult`-shaped value compatible with the agent-pod
 * runner protocol — the same shape `@kagent/agent-pod`'s `runAgentTask`
 * returns. A consumer wishing to ship a Vercel-AI-SDK in-pod loop can
 * call this from their own `main.ts` analog without re-implementing
 * the substrate's safety-net + capability-gate + tool registry.
 *
 * Total LOC budget per R3 §4.1: ~430 LOC across the six components.
 *
 * Status: this is a reference / proof-of-feasibility adapter. It is NOT
 * the production in-pod runtime — `@kagent/agent-loop` (the executor
 * forked from agent-runtime) remains the reference loop. This package
 * exists so kagent's claim "any framework runs in a pod" is provable
 * rather than aspirational.
 */

export {
  KagentContextSafetyMiddleware,
  buildKagentContextSafetyMiddleware,
  type KagentContextSafetyOpts,
} from './context-safety-middleware.js';

export {
  buildSubstrateTools,
  type SubstrateToolsAdapterOpts,
  type SubstrateToolBundle,
} from './substrate-tools-adapter.js';

export {
  buildRunBudget,
  type RunBudgetExtractorInput,
  type ExtractedRunBudget,
} from './run-budget-extractor.js';

export {
  buildTraceSinkBridge,
  type TraceSinkBridgeOpts,
  type TraceSinkBridgeHandle,
} from './trace-sink-adapter.js';

export {
  wrapToolWithCapabilityCheck,
  type CapabilityCheckOpts,
  type CapabilityCategory,
} from './capability-tool-wrapper.js';

export {
  runVercelAiAgentTask,
  type RunVercelAiAgentTaskInput,
  type VercelAiRunResult,
} from './runner.js';
