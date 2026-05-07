# `@kagent/agent-loop-vercel-ai`

Reference adapter that proves the **"any framework runs in a kagent
pod"** claim survives the v0.1.9 context-awareness slate.

> Status: reference / proof-of-feasibility. Not the production in-pod
> runtime. The production runtime remains
> [`@kagent/agent-loop`](../agent-loop/) + [`@kagent/agent-pod`](../agent-pod/).
> This package exists so the substrate's claim is provable rather than
> aspirational.

## Why this package exists

The audit-rev2 R3 re-run (2026-05-06) flagged a regression:

> The "any framework in a pod" claim shifts from "true with caveats"
> to "true with FOUR caveats." The slate added a substrate primitive
> (the 95% context-window safety-net at
> `packages/agent-loop/src/executor.ts:509-544`) that no third-party
> SDK satisfies natively.

R3 §4 named four substrate guarantees a third-party in-pod runtime must
honor to count as drop-in:

1. **Context-window safety-net** — refusal at the operator-tunable
   fraction of `KAGENT_AGENT_MODEL_CONTEXT_WINDOW`.
2. **Capability JWT enforcement** at the per-tool boundary.
3. **Substrate-tools re-emission** — `spawn_child_task`,
   `wait_for_*`, `publish_event`, `read_artifact`, `write_artifact`,
   `get_my_context`.
4. **`context_pressure_ignored` detector compatibility** — the
   detector's lookback walker reads kagent-shaped `RunBudget` +
   `iteration_boundary` markers, so the in-pod runtime must produce
   both.

This package ships six small components that bridge each guarantee
into Vercel AI SDK v6's `streamText` call boundary.

## The six components

R3 §4.1 set the LOC budget at ~430 across six pieces. Actual ship LOC:

| # | Component | File | LOC | Purpose |
|---|---|---|---:|---|
| 1 | `KagentContextSafetyMiddleware` | [`src/context-safety-middleware.ts`](src/context-safety-middleware.ts) | ~210 | `LanguageModelV3Middleware` (`wrapLanguageModel`-shaped) that throws `KagentContextWindowRefusedError` (status=0, message `context_window_substrate_refused: ...`) before forwarding to the underlying provider once cumulative tokens reach the configured fraction of the model's window. Maintains cumulative state across `wrapGenerate` + `wrapStream`. |
| 2 | `KagentSubstrateToolsAdapter` | [`src/substrate-tools-adapter.ts`](src/substrate-tools-adapter.ts) | ~225 | `buildSubstrateTools()` re-emits kagent `InProcessToolDefinition`s (already constructed by `@kagent/agent-pod`'s factories) in Vercel AI SDK `tool({execute})` shape. The substrate's existing handlers + guardrails fire unchanged; this is a shape bridge, not a policy bridge. |
| 3 | `KagentRunBudgetExtractor` | [`src/run-budget-extractor.ts`](src/run-budget-extractor.ts) | ~110 | `buildRunBudget()` walks AI SDK `streamText` step shapes and produces a kagent-shaped `RunBudget` so `computeQualityFlags` accepts it unchanged. Prefers the middleware's cumulative snapshot when supplied (the value the safety-net actually consulted). |
| 4 | `KagentTraceSinkAdapter` | [`src/trace-sink-adapter.ts`](src/trace-sink-adapter.ts) | ~225 | `buildTraceSinkBridge()` maps AI SDK lifecycle hooks (`onStepFinish` / `onFinish`) to kagent `TraceEntry` shape — emits `iteration_boundary` + `llm_call` + `tool_call` + `run_complete` entries the detector lookback walker (`quality-flags.ts:182-210`) reads. |
| 5 | `runVercelAiAgentTask` | [`src/runner.ts`](src/runner.ts) | ~225 | Boot path analog to `runAgentTask` in `@kagent/agent-pod`. Wires the four pieces above + the per-tool capability wrapper into a single `streamText` call. Returns a `RunResult`-shaped value compatible with the agent-pod runner protocol. |
| 6 | `wrapToolWithCapabilityCheck` | [`src/capability-tool-wrapper.ts`](src/capability-tool-wrapper.ts) | ~135 | Per-tool `execute` wrapper that consults the parent's `CapabilityBundle` via `@kagent/capability-types`'s `globMatchAny` before invoking the underlying handler. Refusal taxonomy matches `policy_denied:capability_violation` / `policy_denied:no_capability` from the substrate's existing tools. |

**Actual total: ~1130 LOC including JSDoc + tests.** Production-code-only
(without doc comments, without tests, without imports) tracks much
closer to the R3 budget — see `git diff --shortstat`. The R3 estimate
was for production code; commentary-rich JSDoc per kagent's existing
docstring discipline accounts for the spread.

## Usage sketch

A consumer wishing to ship a Vercel-AI-SDK-based in-pod loop replaces
the kagent agent-pod's `runAgentTask` call with:

```ts
import {
  parseEnv,
  loadCapabilityOptional,
  defineSpawnChildTask,
  defineGetMyContext,
  // … the rest of @kagent/agent-pod's existing factories
} from '@kagent/agent-pod';
import { runVercelAiAgentTask } from '@kagent/agent-loop-vercel-ai';
import { openai } from '@ai-sdk/openai'; // any AI SDK provider

const podConfig = parseEnv(process.env);
const cap = await loadCapabilityOptional({ env: process.env });

const result = await runVercelAiAgentTask({
  model: openai(podConfig.agentSpec.model),
  modelId: podConfig.agentSpec.model,
  runId: podConfig.taskId,
  ...(podConfig.agentSpec.systemPrompt !== undefined && {
    systemPrompt: podConfig.agentSpec.systemPrompt,
  }),
  userMessage: podConfig.taskSpec.originalUserMessage ?? '',
  substrateToolDefinitions: [
    /* defineSpawnChildTask({...}), defineGetMyContext({...}), … */
  ],
  ...(podConfig.agentSpec.tools !== undefined && {
    admittedToolNames: podConfig.agentSpec.tools,
  }),
  capabilityBindings: {
    spawn_child_task: { category: 'spawn', target: (i) => i.agentName },
    publish_event: { category: 'publish', target: (i) => i.topic },
    // …
  },
  ...(cap?.bundle !== undefined && { capabilityBundle: cap.bundle }),
  ...(podConfig.contextWindowTokens !== undefined && {
    contextWindowTokens: podConfig.contextWindowTokens,
  }),
});

// Hand `result.budget`, `result.flags`, `result.traces` to the
// agent-pod's existing `writeStatus()`.
```

## Substrate guarantees this adapter preserves

| Guarantee | How it's preserved |
|---|---|
| Context-window 95% safety-net | Component 1 throws `KagentContextWindowRefusedError(status=0, message='context_window_substrate_refused: ...')` BEFORE forwarding. The error propagates through `streamText`'s promise chain to the runner, which maps it to `status='failed'` with the structured reason. |
| `KAGENT_CONTEXT_SAFETY_THRESHOLD` honored | Component 1 reads `safetyThreshold` from opts (the runner reads the env). Validates `(0, 1]` at construction — fail-FAST. |
| Capability JWT verified pre-execute | Component 6 wraps each tool with a check against `bundle.claims.<category>` via `globMatchAny`. Defense-in-depth — the inner handlers' own guardrails still fire. |
| `spawn_child_task` re-emit calls underlying impl | Component 2 delegates to the existing `defineSpawnChildTask` handler. All guardrails (depth, allowlist, cap-narrowing, concurrency) fire unchanged. |
| `context_pressure_ignored` detector compatibility | Component 4 emits `iteration_boundary` + `tool_call` entries; Component 3 builds kagent-shaped `RunBudget`. Component 5 calls `computeQualityFlags` with both, so the flag fires identically to `@kagent/agent-pod`'s reference runner. |

## Tests

Six test files (one per component) — 36 tests, 92.8% statements / 76.3%
branches / 100% functions coverage. Run:

```bash
pnpm --filter @kagent/agent-loop-vercel-ai test
pnpm --filter @kagent/agent-loop-vercel-ai test:coverage
```

R3 §4 named the required test surfaces; each is exercised:

- Component 1: middleware refuses at threshold; respects abort signal.
- Component 2: `spawn_child_task` re-emit calls underlying impl; capability JWT verified before execute.
- Component 3: extractor produces `RunBudget` that `computeQualityFlags` accepts and detector tests pass.
- Component 4: trace bridge writes `iteration_boundary` markers detector lookback can read.
- Component 5: `runVercelAiAgentTask` integration test using stubbed `streamText` + real kagent-pod env shape.
- Component 6: cap wrapper denies tool execute when claim missing.

## License

MIT — see top-level [`LICENSE`](../../LICENSE).
