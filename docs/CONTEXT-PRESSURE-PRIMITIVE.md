# Substrate-thin context-pressure handling — a discussion seed for SIG Apps

**Project:** [`ctkadvisors/kagent`](../README.md) (a K3s-native, MIT-licensed agent farm operator — distinct from `kagent.dev`/Solo.io's K8s-operating-agents project; rename pending)
**Audience:** Kubernetes SIG Apps maintainers; SOC2 / regulated-industry operators of long-running agents; agent-platform engineers deciding what belongs at the substrate vs. inside the SDK.
**Companion doc (internal):** [`docs/CONTEXT-AWARENESS.md`](./CONTEXT-AWARENESS.md) — the design contract for kagent contributors.
**Status:** shipped at `HEAD ≈ fc32b13`; one wired-but-dead-code regression caught and fixed at `78975df`.
**Tone:** evidence-led, willing to be wrong. Not a marketing artifact.

---

## 0. The one-paragraph claim

When an LLM agent's conversation approaches its model's context window, every surveyed substrate that ships context-pressure primitives — Anthropic Claude API (`compact-2026-01-12` beta, operator-tunable), Microsoft Agent Framework 1.0 (`CompactionTrigger`/`TokenBudgetComposedStrategy`, experimental), Cloudflare Project Think (macro+micro), Anthropic Managed Memory, Google Vertex Memory Bank, and the Vercel AI SDK community middleware `@context-chef/ai-sdk-middleware` — chose **substrate-thick auto-compaction**: the substrate silently summarizes or truncates the conversation and continues. kagent intentionally bets the OPPOSITE way. Instead, the substrate (a) exposes per-call token utilization to the in-loop agent as a callable tool, (b) refuses the next LLM call at a fixed fraction of the window with a structured terminal error, and (c) emits a quality-flag detector when an agent crossed the pressure threshold but never delegated. **Strategy stays at the prompt-and-application layer.** This document explains the choice, names the production code that implements it, and asks SIG Apps whether it is shaped right to live at the K8s substrate (e.g. as an `agent-sandbox` extension).

---

## 1. The two design choices

There are two coherent answers to "what should the substrate do as a long-running agent runs out of context window?"

### Choice A — substrate-thick auto-compact

The substrate detects pressure (typically at ~95% of the window), runs a summarizer over the conversation, and continues. The agent author rarely sees the seam. UX-friendly for default cases.

Production examples (all proprietary):

- **Anthropic Claude Code** auto-compacts at ~95%; the threshold is hardcoded with a circuit-breaker after three consecutive failed compactions ([GitHub issue anthropics/claude-code#25679](https://github.com/anthropics/claude-code/issues/25679); [orchestrator.dev write-up](https://orchestrator.dev/blog/2026-04-06--claude-code-agent-memory-2026/); [Claude API compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction)).
- **Cloudflare Project Think** ships **macro + micro compaction** in the durable Session API ([blog.cloudflare.com/project-think](https://blog.cloudflare.com/project-think/), [InfoQ coverage](https://www.infoq.com/news/2026/04/cloudflare-project-think/)). Non-destructive; SQLite-backed; the visible affordance to the human operator is `[42%, 462/1100 tokens]`, with the in-agent affordance defaulted off.
- **Anthropic Managed Agents (public beta, April 2026)** ships a Memory primitive that extracts/dedups across sessions ([TestingCatalog write-up](https://www.testingcatalog.com/anthropic-launches-memory-in-claude-agents-for-enterprise/)).
- **Google Vertex AI Agent Runtime / Memory Bank (public preview)** automates "memory generation" via continuous event streaming ([Cloud Memory Bank announcement](https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-memory-bank-in-public-preview)).

### Choice B — substrate-thin observation + refusal

The substrate exposes utilization to the agent, refuses one specific operation (the next LLM call) at a hard threshold, and flags behavior the operator can review. The substrate does not summarize. The agent's prompt — backed by application-layer primitives like a delegation tool or a workflow engine — chooses the strategy.

This is kagent's bet, and the rest of this document explains why we made it. The argument has been condensed from `CONTEXT-AWARENESS.md` §2; in shorter form:

1. **Compaction quality is application-shaped.** A researcher needs URLs preserved; a coder needs file paths and the last test failure; a long-running monitor needs the most recent N events. A single substrate-side summarizer policy cannot win all three at once, and when it drops the wrong thing, the substrate gets blamed for an application-shaped failure.
2. **Substrate-thick compaction owns a strategy decision** ("when do I compact" / "what do I keep") that — by [SUBSTRATE-V1.md §1](./SUBSTRATE-V1.md) — should not live at the substrate. Substrate primitives should compose; they should not pick application strategy.
3. **The manual-management pattern that is empirically working in the wild — Claude Code operators delegating to subagents with hand-written briefs because they don't trust the runtime to summarize itself — is the discipline kagent wants to support, not replace.** The community wisdom is increasingly that the optimal compact threshold is **60–85%, not 95%** ([thesciencetalk.com](https://thesciencetalk.com/ai-academy/claude-code-context-window-explained/); [issue thread](https://github.com/anthropics/claude-code/issues/42375)). Hardcoding 95% as a substrate decision misses by ~10–35 percentage points for the workloads operators actually care about; surfacing a 70% behavioral signal lets the prompt author tune toward the right band.

Choice A is the better default for casual / interactive workloads where invisible-magic UX is the goal. Choice B is the better default for long-running, regulated, on-prem workloads where operator visibility into compaction decisions is the goal. **Both are coherent. They are not the same primitive.**

---

## 2. The four-piece composition (substrate-thin)

kagent's implementation is four small pieces, each independently testable and each degrading to no-op when the operator hasn't opted in. The complete contract is in [`docs/CONTEXT-AWARENESS.md`](./CONTEXT-AWARENESS.md) §3; what follows is the public-facing summary with file:line references into the production code.

### Piece 1 — Operator: `contextWindowTokens` per modelClass

**What it does.** Extends the existing Helm chart `agent.modelClasses` map with one optional integer field (`contextWindowTokens`) per declared model class. The operator resolves the value at AgentTask dispatch and projects it onto the agent-pod via the `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` env var.

**Cited code.** Chart values: `packages/operator/charts/kagent-operator/values.yaml`. Resolver: `packages/operator/src/model-class-resolver.ts`. Env projection: `packages/operator/charts/kagent-operator/templates/deployment.yaml`. Two thresholds (`KAGENT_CONTEXT_SAFETY_THRESHOLD`, default `0.95`; `KAGENT_CONTEXT_PRESSURE_THRESHOLD`, default `0.7`) are projected at chart values `agentPod.contextSafetyThreshold` and `agentPod.contextPressureThreshold` per [`CONTEXT-AWARENESS.md`](./CONTEXT-AWARENESS.md) §4.1.

**Threshold-crossing behavior.** None directly — Piece 1 is plumbing. When omitted, all four pieces degrade to no-op (back-compat path).

### Piece 2 — Agent-pod: env reader, `RunBudget` extension, in-pod introspection tool

**What it does.** Reads `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` at boot and threads it through `runner.ts → AgentExecutor.run() → RunBudget`. The in-pod `get_my_context` tool — already used for self-introspection (taskUid / depth / parent / budget) — gains a `tokenUtilization: { used, modelWindow, percentage }` sibling field that the LLM can call mid-loop to read its current pressure.

**Cited code.**
- `RunBudget.contextWindowTokens` and `ExecutorRunInput.contextWindowTokens` declared in [`packages/agent-loop/src/executor.ts:151-179`](../packages/agent-loop/src/executor.ts) and [`:225-238`](../packages/agent-loop/src/executor.ts).
- `defineGetMyContext` builds the `tokenUtilization` payload at [`packages/agent-pod/src/builtin-tools.ts:1114-1208`](../packages/agent-pod/src/builtin-tools.ts) (the snapshot is consulted at `:1153`; the percentage is rounded to 4 decimals at `:1168-1172`).
- The live-budget bridge that pairs the executor's `onBudgetReady` hook with the tool's `tokenUtilizationSnapshot` thunk lives at [`packages/agent-pod/src/main.ts:359-389`](../packages/agent-pod/src/main.ts) (callsite) and [`:775-800`](../packages/agent-pod/src/main.ts) (`buildTokenUtilizationBridge` pure factory). This is the wireup the v0.1.9 slate originally shipped wired-but-dead — see §4.

**Threshold-crossing behavior.** None directly. Piece 2 is a read-only data export. The agent's prompt is what acts on it (typically by calling `spawn_child_task` with a hand-written brief at ~70% utilization).

### Piece 3 — Executor: pre-call refusal at the safety threshold

**What it does.** **Before every LLM call**, when both `RunBudget.contextWindowTokens` and the per-run safety threshold are set and `cumulativeInputTokens + cumulativeOutputTokens >= safetyThreshold * contextWindowTokens` (default 0.95), the executor throws `LLMClientHttpError(0, 'context_window_substrate_refused: cumulative=<used> window=<limit> threshold=<pct>')`. Status `0` keeps the existing 429-retry path inert (only `status === 429` retries); the loop's normal failed-LLM-call catch arm writes a structured terminal `phase: 'Failed'` with `error.message` reflecting the refusal reason.

**Cited code.** The pre-call check sits inside `chatWithRetry`, immediately before `this.llm.chat()`:

- Pre-call check: [`packages/agent-loop/src/executor.ts:509-544`](../packages/agent-loop/src/executor.ts).
- Refusal construction (`LLMClientHttpError(0, reason)` at line 540, with the message also assigned at 541 so the agent-pod's status writer surfaces the reason verbatim): [`packages/agent-loop/src/executor.ts:529-543`](../packages/agent-loop/src/executor.ts).
- Threshold validation (out-of-range values fail-FAST at the top of `run()`, not silently no-op): [`packages/agent-loop/src/executor.ts:646-672`](../packages/agent-loop/src/executor.ts).

**Threshold-crossing behavior.** Loud, structured, terminal. The most recent successful `RunResult.finalContent` and the most recent tool result are preserved on the terminal status (executor's existing terminal-error contract). A downstream resume — if the operator's prompt is structured for one — has a starting point.

**Why a hard refusal and not auto-recovery?** Three reasons spelled out in `CONTEXT-AWARENESS.md` §2: (1) the substrate would otherwise own compaction quality, (2) silent loss-of-information has no operator-visible failure mode, and (3) refusing keeps the application's manual-management pattern viable.

### Piece 4 — Detector: `context_pressure_ignored` quality flag

**What it does.** A pure-heuristic, post-run detector — alongside the existing `synthesis_low_yield` / `methodology_fabrication` / `tool_use_omission` / `truncated_synthesis` battery — that fires when (a) the operator wired a window, (b) cumulative tokens crossed the pressure threshold (default 0.7), and (c) the trace shows zero `spawn_child_task` calls in the trailing N=3 iterations (i.e. the agent had three full turns under pressure and did not delegate). Surfaces in `status.structuralVerdict.suspicious[]`. **Flag-only — no action.**

**Cited code.** `detectContextPressureIgnored` at [`packages/agent-loop/src/detectors/quality-flags.ts:145-172`](../packages/agent-loop/src/detectors/quality-flags.ts). The lookback walk over `iteration_boundary` trace entries is at [`:182-210`](../packages/agent-loop/src/detectors/quality-flags.ts). Wired into `computeQualityFlags` at [`:100-116`](../packages/agent-loop/src/detectors/quality-flags.ts).

**One subtle defense-in-depth knob:** the detector takes an `opts.spawnToolAdmitted` boolean (defaults to `true` for back-compat). When the runner can prove the agent has no escape hatch by design (i.e., `spawn_child_task` is not in `Agent.spec.tools` and there is no implicit-admit predicate), the detector skips entirely. Researcher agents that legitimately don't delegate stop drowning the structural verdict in a flag the operator cannot tune away. See `quality-flags.ts:69-82` and audit `evidence/audit-rev2/C2.md` §4 NM4.

**Threshold-crossing behavior.** A string literal in `status.structuralVerdict.suspicious[]`. The operator decides whether that prompt needs tuning. The substrate has no opinion.

---

## 3. Comparison table — kagent vs the field

Seven-row × seven-column scorecard. Restated from R2 §4 of the May 2026 audit (`evidence/audit-rev2/R2.md`), expanded per `evidence/audit-rev3/R1.md` §1.1 (which surfaced two understated rows: Microsoft Agent Framework's substrate-thick compaction surface, and Anthropic's now-operator-tunable trigger), and verified by repository / docs read on **2026-05-07**.

> **Freshness commitment.** This table is correct AS OF 2026-05-07. The substrate-thick lane is now broadly populated and moves week-over-week; quarterly re-verification is the working discipline.

| Capability | kagent v0.1.9 | Anthropic Claude API | Microsoft Agent Framework 1.0 | Cloudflare Project Think | Google Vertex Memory Bank | OpenAI Agents SDK 0.14.0 | Vercel AI SDK community |
|---|---|---|---|---|---|---|---|
| **Substrate exposes `tokenUtilization {used, window, pct}` to the in-loop agent as a callable tool** | ✅ via `get_my_context` ([builtin-tools.ts:1114-1208](../packages/agent-pod/src/builtin-tools.ts)) | ❌ | ❌ | ⚠ Session API displays `[42%, 462/1100 tokens]` to humans; no in-agent tool ([Project Think blog](https://blog.cloudflare.com/project-think/)) | ⚠ via Memory Bank events; no in-loop tool ([Memory Bank preview](https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-memory-bank-in-public-preview)) | ⚠ via SDK harness; not substrate-side | ❌ |
| **Substrate refuses the next LLM call at a fixed % threshold (default 0.95)** | ✅ `LLMClientHttpError(0, 'context_window_substrate_refused')` ([executor.ts:509-544](../packages/agent-loop/src/executor.ts)) | ❌ relies on auto-compaction; circuit-breaker is "3 failed compactions", not a % threshold ([Claude API compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction)) | ❌ relies on substrate-thick compaction (see next row) | ❌ relies on macro/micro compaction in the harness | ❌ relies on Memory Bank automated triggers | ❌ relies on upstream provider's 400 | ❌ relies on history compression in middleware |
| **Substrate auto-compacts (this row is inverted — ❌ here = "we don't")** | ❌ explicit non-goal ([CONTEXT-AWARENESS.md §2](./CONTEXT-AWARENESS.md)) | ✅ **operator-tunable** under beta `compact-2026-01-12` — `trigger.value` ≥ 50,000, default 150,000 input tokens ([Claude API compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction)) | ✅ `CompactionTrigger.{TokensExceed,MessagesExceed,TurnsExceed,GroupsExceed,HasToolCalls}`; `TokenBudgetComposedStrategy`; `Pipeline`/`Truncation`/`SlidingWindow`/`ToolResult`/`Summarization`; documented "experimental" (`MAAI001`; Python `agent_framework._compaction`) ([MAF compaction docs](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction)) | ✅ macro + micro, non-destructive, SQLite-backed | ✅ continuous event streaming | ⚠ via SDK memory mgmt; configurable, defaults on | ✅ `@context-chef/ai-sdk-middleware` — history compression + tool-result truncation + auto token tracking ([Vercel community thread](https://community.vercel.com/t/drop-in-middleware-for-context-window-management-in-ai-sdk-agents/38039)) |
| **OOB detector for "agent crossed pressure threshold but never delegated"** | ✅ `context_pressure_ignored` flag ([quality-flags.ts:145-172](../packages/agent-loop/src/detectors/quality-flags.ts)) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Operator-visible audit signal for the context-pressure decision** | ✅ `status.structuralVerdict.suspicious[]` | ❌ | ❌ | ❌ | ⚠ Memory Bank emits change events but not "agent ignored its budget" | ❌ | ❌ |

**Reading (rev3).** Every surveyed substrate that ships context-pressure primitives chose **substrate-thick auto-compaction** — Anthropic Claude API (operator-tunable), Microsoft Agent Framework (Trigger/Strategy/Pipeline, experimental), Cloudflare Project Think (macro+micro), Vercel community middleware. **kagent is the only OSS substrate that bets the OPPOSITE way: refuse + introspect + flag.** No competitor combines kagent's four properties — (a) substrate-side refusal, (b) in-agent introspection, (c) "agent ignored its own budget" detector, and (d) operator-visible audit emission for the pressure decision — but the differentiation is in the **direction of the bet** (substrate-thin vs substrate-thick) and in the **composition** of all four properties at one substrate. The hosted vendors are racing to make context magic invisible; that's the UX bet for casual workloads. kagent intentionally bets the other way for the long-running / regulated workloads where invisibility is the bug.

**Two specific updates vs. the rev2 table:** (1) the row "Substrate auto-compacts" no longer reads "Anthropic at ~95% hardcoded" — the threshold is now operator-tunable under `compact-2026-01-12` beta, default 150,000 input tokens. The kagent distinction is the design choice (refuse + flag, not compact + continue), not threshold configurability. (2) Microsoft Agent Framework moves from "❌ documentation does not mention context primitives" (which was a rev2 README-only scan miss) to "✅ substrate-thick compaction" — MAF ships a substantial Trigger/Strategy/Pipeline surface, documented experimental but production-shaped.

---

## 4. The wired-but-dead-code lesson

The v0.1.9 slate's marquee feature is "agent-managed context handling": the agent reads its own utilization mid-loop and decides whether to hand off. The slate landed across four commits in late April 2026 (`d26fdf9`, `fb549c0`, `73f67f4`, `fc32b13`). All four CI passes were green. All four code reviews approved. The unit tests for `defineGetMyContext` injected a `tokenUtilizationSnapshot` thunk that returned realistic numbers. The integration tests passed.

**The feature was inert in production.** The production callsite in `packages/agent-pod/src/main.ts` constructed `defineGetMyContext` without passing `tokenUtilizationSnapshot`, the optional dep collapsed to its fallback `() => ({ used: 0, modelWindow: null })`, and the LLM read `percentage: null` on every call.

The fix (commit `78975df`) was thirty lines: a `buildTokenUtilizationBridge` factory that pairs the executor's new `onBudgetReady` callback hook with a closure-shared mutable holder, exporting both the bridge's `onBudgetReady` (handed to the executor) and `tokenUtilizationSnapshot` (handed to `defineGetMyContext`). See [`packages/agent-pod/src/main.ts:775-800`](../packages/agent-pod/src/main.ts) for the factory and [`:359-360`](../packages/agent-pod/src/main.ts) for the wireup. The `onBudgetReady` plumbing through the executor is documented in detail at [`packages/agent-loop/src/executor.ts:253-280`](../packages/agent-loop/src/executor.ts) and exercised in regression tests that drive the production wireup, not the unit-with-deps shape.

We named the failure mode and wrote a detection paradigm rather than treat it as a one-off: see [`evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md`](../evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md). The signature has all four of:

1. Optional-shaped dep (`deps.snapshot?: () => Snapshot`).
2. Optional-chained call with a sensible-looking fallback (`deps.snapshot?.() ?? { used: 0, ... }`).
3. Tests inject the dep directly.
4. Production callsite omits the dep.

The fallback collapses to a value that *looks* reasonable, so there's no compile error and no test failure when the production wireup forgets it. The grep-able patterns and triage taxonomy (WBD vs MCALL vs CSPREAD vs DEADBRANCH) are in the linked doc.

**The discipline we now require:**

- Every wave's exit checklist runs the WBD scan in package scope.
- Optional-shaped deps that collapse to a "looks reasonable" fallback are treated as suspect by default and require a regression test that drives the production wireup, not the unit-with-deps shape.
- Where the optional shape is needed for testability, we ship a paired *required-shaped* boot helper (`buildFooForProduction(deps: { snapshot: () => Snapshot })`) so the type system catches omissions next time.
- Commit messages and audit logs name the paradigm explicitly (the 78975df commit message cites NB1 and the paradigm doc).

**Why we are airing this in a SIG-Apps-facing artifact.** Agent platforms are full of "ships optional-shaped, falls back to nothing-happens" wiring. Hosted vendors absorb the cost privately; OSS projects need a name for the failure mode and a public artifact pointing at the discipline so reviewers can recognize it on incoming PRs. We made every classical failure of test-first hygiene; this is the public version of "here's how we caught it, here's what we changed."

---

## 5. Why this is substrate-shaped, not application-shaped

A reasonable critique is "context handling is the agent loop's problem; it doesn't belong at the substrate." We disagree, with three points (the same three as `CONTEXT-AWARENESS.md` §2, restated for the SIG-Apps audience):

### 5.1 Compaction quality is application-shaped — but enforcement is not

Compaction policy ("when do I summarize" / "what do I drop") varies by workload: a researcher needs URLs preserved; a coder needs the last test failure preserved; a long-running monitor needs the most recent N events preserved. **No single substrate-side summarizer wins all three.** The application is the right place to choose.

What is *not* application-shaped is **the budget enforcement decision**: "the upstream provider will return a terminal `400 context_length_exceeded` if we make the next call past the model's window; should we let that happen?" That decision is uniform across applications, has a single correct answer (refuse cleanly with structured error rather than blow up the upstream), and is shaped exactly like the role substrates already play for other budgets (`tokenLimit`, `costLimitUsd`, `timeoutSeconds`).

The substrate-thin design splits these correctly: enforcement at the substrate, strategy at the application.

### 5.2 Substrate-thick auto-compact owns a strategy decision

Auto-compaction means the substrate has chosen *for the application* (a) when to compact, (b) what to keep, (c) which summarizer to use, (d) what the summary template looks like. Each of those is a load-bearing application choice. Operators of one workload may reasonably want a different policy than operators of another. A single substrate-side default cannot serve both well, and any "configurable" surface for those choices reproduces the application's strategy at the substrate's API — which is the [`SUBSTRATE-V1.md §1`](./SUBSTRATE-V1.md) anti-pattern that primitives compose, the substrate doesn't choose application strategy.

Auto-compaction *is* a perfectly good thing to ship; it should ship in the agent's harness or in a higher-layer SDK. It should not ship as a Kubernetes substrate primitive.

### 5.3 The manual-management pattern is what actually works in long-running settings

Claude Code's most successful pattern is operators delegating to subagents with **hand-written briefs**: "research X, return Y, citing real URLs." The discipline works because the human wrote down which information must survive the handoff. That discipline is what we want to support — not replace. Substrate-thin observation + refusal supports manual delegation. Substrate-thick auto-compact subverts it (the substrate's summary clobbers the operator's intended brief).

This is also the regulated-industry case. Operators whose audit posture says "every information-loss event must be traceable" cannot accept a substrate that quietly drops half the conversation. They can accept a substrate that refuses cleanly and surfaces a flag.

---

## 6. Composition with other substrate primitives

The slate is meant to compose, not to monolith. Three intended compositions:

- **`agent-sandbox` (kubernetes-sigs).** The `Sandbox` and `SandboxClaim` CRDs define the per-agent isolation envelope. Context-pressure handling is orthogonal to where the pod runs: a long-running `SandboxClaim`-backed pod inherits the same `get_my_context` introspection, the same 95% safety-net, and the same `context_pressure_ignored` detector regardless of whether the executor is in a Job, a Sandbox, or a future warm-pool slot. The `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` env flows the same way regardless of pod backend. See [`docs/UPSTREAM-DIFF-AGENT-SANDBOX.md`](./UPSTREAM-DIFF-AGENT-SANDBOX.md) for kagent's "Path 1: adopt + extend" plan.
- **Capability narrowing on spawn.** kagent's separate, parallel-shipping capability primitive enforces `child.claims ⊆ parent.claims` at the spawn boundary (see [`docs/PROTOCOLS.md`](./PROTOCOLS.md) slate 5; commits `5d3cb3a`/`1a64c92`/`42a04fd`). Context-pressure composition: when an agent at 70% utilization hands off via `spawn_child_task`, the substrate narrows the child's caps to a strict subset of the parent's. The detector knows about this because `spawnToolAdmitted` is plumbed into `detectContextPressureIgnored` from the runner's view of admitted tools — researcher agents that legitimately don't delegate get the detector skipped, without the operator having to tune a per-agent flag.
- **A2A v1.0 wire and AgentWorkflow durability.** Future work. The `context_pressure_ignored` flag is content the substrate can publish as a CloudEvent on a JetStream `audit` topic; an AgentWorkflow CR can chain handed-off children into a logical "session" with durable replay. Neither is required for the four-piece slate above to work; both make it more useful. See [`docs/PROTOCOLS.md`](./PROTOCOLS.md) §7 for slate ordering and [`docs/SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §3 for the broader 7-primitive frame.

What this slate explicitly does *not* compose with:

- **No `Agent.spec.contextStrategy` enum.** Strategy lives in the prompt; the substrate ships awareness and a circuit-breaker, not a strategy enum.
- **No "Handed-Off" terminal phase.** The 95% refusal exits as `phase: 'Failed'` with `error: 'context_window_substrate_refused: ...'`. Operators can grep. A new terminal phase is plausible v0.2 work but premature for v0.1.9.
- **No model-aware compaction.** A child agent that does summarization is the application's call.

---

## 7. Adoption path for SIG Apps

The thinnest possible upstream contribution is a one-field extension to `agent-sandbox`'s `Sandbox` CR:

```yaml
# kubernetes-sigs/agent-sandbox — proposed Sandbox.spec.contextWindow
apiVersion: agents.x-k8s.io/v1alpha1
kind: Sandbox
spec:
  contextWindow:
    tokens: 131072      # NEW — model's declared context window in tokens
    safetyThreshold: 0.95   # OPTIONAL — refusal threshold; substrate-thin default
    pressureThreshold: 0.7  # OPTIONAL — detector trigger; observation-only
```

Plus a small **runner-side helper library** (something like `sigs.k8s.io/agent-sandbox-runtime`) that:

1. Reads the three values from a downward-API env var pair.
2. Exposes a `getContextWindow()` and `tokenUtilizationSnapshot()` API to the in-pod agent runtime.
3. Exposes a `wrapLLMClient(client, opts)` that injects the pre-call refusal at the configured threshold.
4. Exposes a `detectContextPressureIgnored(trace, budget)` pure function for post-run quality scoring.

The CRD field is opt-in (omit it = no-op). The runner-side helpers are opt-in (don't import them = no-op). No new controller, no new CRD, no new operator. The whole proposal is "add three optional fields to one existing CR; ship four small helpers to support them."

This is *not* a full KEP (Kubernetes Enhancement Proposal) — that document would need formal motivation, design considerations, and rollout plan. We are sketching the shape so SIG Apps maintainers can decide if there's appetite. Two questions worth asking before any KEP:

1. **Does `agent-sandbox` want substrate-shaped context-budget primitives at all?** A reasonable answer is "no — that's the runner's job; we ship isolation only." If so, the helper library can ship as a sibling subproject under SIG Apps, or under the AAIF (Agentic AI Foundation, formed Dec 2025 under Linux Foundation, anchored on MCP / goose / AGENTS.md / A2A).
2. **Does the substrate-thin vs substrate-thick choice belong at the API level (i.e., a `contextStrategy: thin | thick` field) or at the runner level (i.e., the helper library's behavior)?** kagent's strong suggestion: runner level. Putting the choice on the CRD invites every consumer to pick a different value, which spreads strategy decisions across the substrate's API surface — exactly the anti-pattern §5.2 names. Better to ship one helper library that implements substrate-thin, and let consumers who want substrate-thick ship their own helper library or extend Project Think / Vertex Memory Bank instead.

A concrete next step that does not require a KEP: a discussion-issue on `kubernetes-sigs/agent-sandbox` titled "Context-pressure handling: thin observation+refusal, or thick auto-compaction?" with this document linked. The repo's own KEP queue today (verified via `gh api`) shows zero issues mentioning "capability", "identity", "SPIFFE", or "context"; the visible KEPs are 174 (metadata propagation) and 359 (refactor python SDK). The lane is open.

---

## 8. Open questions — feedback welcome

These are decisions kagent has made with educated guesses, not strong evidence; they would benefit most from SIG / community input.

- **Q1 — Tokenizer accuracy and the 95% margin.** The pre-call check reads cumulative tokens off `RunBudget.cumulativeInputTokens + cumulativeOutputTokens`, which is populated from `usage.inputTokens` / `usage.outputTokens` reported by the gateway response. When the upstream gateway/provider does not report usage (some Workers AI shapes, older vLLM builds, untyped openai-compat backends), the executor falls back to a character-count heuristic (`estimateTokens` in `packages/agent-loop/src/trace.ts`). The estimate is 20–40% off depending on the model's tokenization (Llama 4 vs Claude vs GPT-4 each tokenize differently). The 5% margin between 95% refusal and the upstream's terminal 400 absorbs most of this drift in practice — but it's a guess. Is 5% the right margin? Should the substrate emit a `usage_source: 'estimate'` marker on every trace where the fallback fired, so operators tuning tight budgets can verify? See `CONTEXT-AWARENESS.md` §8 NM6.
- **Q2 — Default thresholds.** kagent ships `safetyThreshold = 0.95` (refusal) and `pressureThreshold = 0.7` (detector). Community wisdom for hosted Claude Code increasingly says the *optimal compact threshold* is 60–85% ([thesciencetalk.com](https://thesciencetalk.com/ai-academy/claude-code-context-window-explained/)). Are these the right defaults for an OSS substrate? Should they differ by model class (Llama 4 vs Claude vs GPT) or stay model-agnostic?
- **Q3 — Detector lookback window.** `context_pressure_ignored` fires when the trace contains zero `spawn_child_task` calls in the last N=3 iterations. N=3 matches the existing detector pattern in the kagent codebase. Is N=3 the right default? Should it be configurable per-task? Per-Agent? Per chart?
- **Q4 — Agent-prompt API.** kagent's `get_my_context` returns `tokenUtilization { used, modelWindow, percentage }`. Should the field name match an emerging convention (e.g., what AAIF / A2A / MCP propose for agent introspection)? Should it carry additional fields like `pressureThreshold`/`safetyThreshold` so the prompt can read the operator's tuning directly, rather than hard-coding "if percentage > 0.7"?
- **Q5 — Cross-task aggregation.** The current design is per-AgentTask. A long-running session built from N handed-off children does not have a "session-wide" token budget — that's accounting future kagent's `AgentWorkflow` CRD will need to provide. Should the substrate ship cross-task aggregation primitives, or is that strictly application-layer?

---

## 9. Cross-references

**Within kagent:**
- [`docs/CONTEXT-AWARENESS.md`](./CONTEXT-AWARENESS.md) — design contract for kagent contributors; the audience-specific companion to this document.
- [`docs/SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §1, §3 — the primitive-composition anti-pattern that motivates the substrate-thin choice.
- [`docs/HARNESS-LESSONS.md`](./HARNESS-LESSONS.md) — provenance of the F1/F2/F3 + refusal + synthesis-vacuity detector battery the new `context_pressure_ignored` flag joins.
- [`docs/UPSTREAM-DIFF-AGENT-SANDBOX.md`](./UPSTREAM-DIFF-AGENT-SANDBOX.md) — the "adopt + extend agent-sandbox" plan this slate composes with.
- [`docs/PROTOCOLS.md`](./PROTOCOLS.md) — interop posture and slate ordering for A2A, MCP, capability narrowing, and others.
- [`evidence/audit-rev2/R1.md`](../evidence/audit-rev2/R1.md) §3 — OSS competitor read; verifies no surveyed peer ships the triple.
- [`evidence/audit-rev2/R2.md`](../evidence/audit-rev2/R2.md) §1.2, §4 — proprietary-platform read; verifies hosted vendors all chose auto-compaction.
- [`evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md`](../evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md) — failure-mode anti-pattern, named and grep-able.

**External (verified 2026-05-06):**
- Anthropic Claude Code auto-compaction: [github.com/anthropics/claude-code#25679](https://github.com/anthropics/claude-code/issues/25679); [Claude API compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction); [orchestrator.dev best-practices write-up](https://orchestrator.dev/blog/2026-04-06--claude-code-agent-memory-2026/).
- Cloudflare Project Think: [blog.cloudflare.com/project-think](https://blog.cloudflare.com/project-think/); [InfoQ coverage](https://www.infoq.com/news/2026/04/cloudflare-project-think/); [Sessions API docs](https://developers.cloudflare.com/agents/api-reference/sessions/).
- Anthropic Managed Agents memory (April 2026): [TestingCatalog write-up](https://www.testingcatalog.com/anthropic-launches-memory-in-claude-agents-for-enterprise/).
- Google Vertex Memory Bank: [Cloud announcement](https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-memory-bank-in-public-preview).
- OpenAI Agents SDK 0.14.0 + `SandboxAgent`: [The next evolution of the Agents SDK](https://openai.com/index/the-next-evolution-of-the-agents-sdk/); [OpenAI sandbox agents docs](https://developers.openai.com/api/docs/guides/agents/sandboxes).
- Optimal compaction threshold community wisdom: [Claude Code Context Window Explained](https://thesciencetalk.com/ai-academy/claude-code-context-window-explained/); [issue thread anthropics/claude-code#42375](https://github.com/anthropics/claude-code/issues/42375); [Codex compaction deep dive](https://codex.danielvaughan.com/2026/04/14/context-compaction-deep-dive-codex-cli-claude-code-opencode/).
- `kubernetes-sigs/agent-sandbox`: [github.com/kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox); [Kubernetes blog March 20 2026](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox/).
- Agentic AI Foundation: [Linux Foundation announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation); [InfoQ overview](https://www.infoq.com/news/2025/12/agentic-ai-foundation/).

**Production commits referenced:**
- `d26fdf9 feat(operator/chart): supply contextWindowTokens per modelClass to agent-pods`
- `fb549c0 feat(agent-pod, agent-loop): plumb contextWindowTokens through RunBudget + get_my_context`
- `73f67f4 feat(agent-loop): substrate context-window safety-net at 95% threshold`
- `fc32b13 feat(agent-loop): context_pressure_ignored detector`
- `78975df fix(agent-pod): wire tokenUtilizationSnapshot to live RunBudget for get_my_context (NB1)` — the wired-but-dead-code fix discussed in §4.
