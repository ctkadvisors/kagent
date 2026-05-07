# Context Awareness — substrate-thin, agent-managed

**Date:** 2026-05-06
**Status:** Design contract, ratified for implementation in a 4-piece slate
**Owner / scope:** v0.1.9 — substrate-level. Four additive primitives, no new CRD, no new strategy enum.

> Read [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §3.2 (AgentTask `runConfig`),
> [`HARNESS-LESSONS.md`](./HARNESS-LESSONS.md) (existing F1/F2/F3 detector pattern), and
> [`MODEL-ROUTING.md`](./MODEL-ROUTING.md) §4 (the `agent.modelClasses` chart map this extends) first.
>
> This doc describes how kagent gives long-running agents enough visibility into
> their own context-window usage to manage handoff themselves — and provides a
> substrate-level safety-net so misbehaving agents fail clean instead of silently
> blowing the upstream provider's `400 context_length_exceeded`.

---

## 1. Problem statement

Today (HEAD `7032be9`), the agent-loop enforces three caps post-call (`packages/agent-loop/src/executor.ts:658-668`):
`maxIterations`, `tokenLimit`, `costLimitUsd`. None of them are aware of the **model's actual context window**. If an
operator forgets to set `runConfig.tokenLimit` (or sets it higher than the model's window), the conversation grows
until the upstream provider returns `400 invalid_request_error: context_length_exceeded`. Per
[`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) §10, that's terminal — no retry, no recovery, AgentTask flips to `Failed`.

The substrate also doesn't surface utilization. An in-pod agent has no way to ask "how close am I to the limit?" so
even prompt-engineered self-management ("if you're past 70% of context, hand off via `spawn_child_task`") is impossible.

This is the gap context awareness closes. The design is **deliberately not auto-compact** — see §2 for the rationale.

## 2. Why manual + safety-net beats auto-compact

Auto-compaction (substrate detects "we're getting close" and automatically summarizes/handoffs) is the obvious answer
and the wrong one for kagent. Three reasons:

1. **Compaction quality is application-shaped.** A researcher needs URLs preserved; a coder needs file paths and the
   last test failure; a long-running monitor needs the most recent N events. One-size policy doesn't work, and when
   the substrate's auto-summarizer drops the wrong thing, kagent gets blamed for an application-shaped failure.
2. **The substrate would own a strategy decision (when to compact, what to keep).** This is the same trap that
   [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §1 explicitly warns against — primitives compose, the substrate doesn't
   choose application strategy.
3. **The user's manual-management pattern (Claude Code) actually works.** Operators delegate to subagents *with
   hand-written briefs* because they don't trust the runtime to summarize itself. That discipline is what we want to
   support — not replace.

So the substrate ships **awareness + safety-net + observability**. Strategy stays at the prompt-and-application layer.

## 3. The four pieces (additive primitives)

```
┌──────────────────────────────────────────────────────────────────┐
│  Piece 1 — Operator-side: contextWindowTokens per modelClass     │
│  Chart map extension; env projected onto every spawned pod.      │
│  KAGENT_AGENT_MODEL_CONTEXT_WINDOW=<integer>                     │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│  Piece 2 — Agent-pod: RunBudget.contextWindowTokens + tool       │
│  Read env at boot; thread through runner → executor → registry.  │
│  defineGetMyContext() returns tokenUtilization{used,window,pct}. │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│  Piece 3 — Executor safety-net at 95% (hard refusal)             │
│  Pre-call check; LLMClientHttpError(0, 'context_window_…')       │
│  Loop exits clean with structured terminal status.               │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│  Piece 4 — Detector: context_pressure_ignored                    │
│  Joins F1/F2/F3 + refusal + synthesis-vacuity battery.           │
│  Flag-only; surfaces in status.structuralVerdict.suspicious[].   │
└──────────────────────────────────────────────────────────────────┘
```

Each piece is independently testable. Each ships with explicit defaults that preserve current behavior when the new
primitive is unset (back-compat is non-negotiable; see §7).

---

## 4. The contract — exact field names, env vars, defaults

**Implementation agents MUST use these exact names. If a name needs to change, change it here first.**

### 4.1 Env vars (operator → agent-pod)

| Env var | Type | Default | Source |
|---|---|---|---|
| `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` | integer (positive) | unset | Resolved operator-side from `agent.modelClasses[<class>].contextWindowTokens` |
| `KAGENT_CONTEXT_SAFETY_THRESHOLD` | float in `(0, 1]` | `0.95` | Operator chart value `agentPod.contextSafetyThreshold`, projected onto every spawned pod |
| `KAGENT_CONTEXT_PRESSURE_THRESHOLD` | float in `(0, 1]` | `0.7` | Operator chart value `agentPod.contextPressureThreshold` (the detector's trigger point) |

When `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` is unset (legacy / pre-v0.1.9 configs / classes without a window declared),
ALL three pieces 2/3/4 degrade gracefully:

- Piece 2: `tokenUtilization.modelWindow` returns `null`, `percentage` returns `null`.
- Piece 3: safety-net is a no-op.
- Piece 4: detector is a no-op.

This is the back-compat path — existing deployments are unaffected until the operator opts in by populating
`contextWindowTokens` in the chart values.

### 4.2 Helm chart shape

`packages/operator/charts/kagent-operator/values.yaml` extends the existing `agent.modelClasses` map. Today each entry is `{ model: <string> }` with comments noting "shape is forward-compatible" — this is the forward use.

```yaml
agent:
  modelClasses:
    tool-caller-default:
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct'
      contextWindowTokens: 131072      # NEW
    text-generator-default:
      model: 'ollama/nemotron-3-nano:4b'
      contextWindowTokens: 8192        # NEW
    reasoner-default:
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct'
      contextWindowTokens: 131072      # NEW

agentPod:
  # Substrate-side circuit breaker. When cumulative tokens reach this fraction
  # of the model's context window, the executor refuses the next LLM call with
  # a substrate-side error instead of letting the upstream's 400 land.
  contextSafetyThreshold: 0.95         # NEW

  # Detector trigger. When utilization passes this fraction AND the agent has
  # not called spawn_child_task in the past N iterations, the
  # `context_pressure_ignored` flag is added to status.structuralVerdict.
  contextPressureThreshold: 0.7        # NEW
```

When `contextWindowTokens` is omitted from a class entry, that class boots normally but the in-pod
`KAGENT_AGENT_MODEL_CONTEXT_WINDOW` env is unset — all four pieces degrade to no-op for tasks using that class.

### 4.3 `RunBudget` extension

In `packages/agent-loop/src/executor.ts`, the existing `RunBudget` interface gains one optional field:

```ts
export interface RunBudget {
  // ... existing fields unchanged ...

  /**
   * The model's context-window size in tokens, when known. Read from the
   * KAGENT_AGENT_MODEL_CONTEXT_WINDOW env var operator-side; threaded through
   * runner.ts. When undefined, pieces 3 (safety-net) and 4 (detector) are
   * no-ops — preserving v0.1.8 behavior for classes without a declared window.
   *
   * Distinct from `tokenLimit` (which is a per-task user cap; lower than the
   * model window by convention). Both can be set; the safety-net fires on
   * whichever is closer to being hit.
   */
  contextWindowTokens?: number;
}
```

`ExecutorRunInput` (the externally-facing argument shape) gains the same field with the same semantics.

### 4.4 `get_my_context` tool return shape

Today `defineGetMyContext` returns `{ taskUid, taskName, taskNamespace, agentName, parentUid?, depth, budget?, capability? }`. Add a sibling field:

```jsonc
{
  // ... existing fields unchanged ...
  "tokenUtilization": {
    "used": 12_450,                  // cumulativeInputTokens + cumulativeOutputTokens at call time
    "modelWindow": 131072,           // null if KAGENT_AGENT_MODEL_CONTEXT_WINDOW unset
    "percentage": 0.094              // used/modelWindow rounded to 4 decimals; null if window unset
  }
}
```

The agent's prompt is responsible for reading `percentage` and acting (e.g., calling `spawn_child_task` with a
hand-written brief at 70%). The substrate provides the data; the application chooses the strategy.

### 4.5 Safety-net behavior (piece 3)

In `packages/agent-loop/src/executor.ts`, **before every LLM call** (i.e., at the top of `chatWithRetry` or its
caller), if `budget.contextWindowTokens !== undefined` AND `budget.cumulativeInputTokens + budget.cumulativeOutputTokens >= safetyThreshold * budget.contextWindowTokens` (where `safetyThreshold` defaults to `0.95` and is read from `KAGENT_CONTEXT_SAFETY_THRESHOLD`):

- **Throw `LLMClientHttpError(0, 'context_window_substrate_refused: cumulative=<used> window=<limit> threshold=<pct>')`** with `status: 0` so the existing 429-retry path does NOT kick in (only 429 retries; everything else fails terminal).
- The loop's existing catch path at `executor.ts:577` writes the error to `RunBudget`'s terminal-state slot.
- The agent-pod's existing `writeStatus` path (per `packages/agent-pod/src/status.ts`) writes `phase: 'Failed'` with `error: 'context_window_substrate_refused: ...'`.
- The last successful `RunResult.finalContent` (the LLM's most recent assistant message) and the most recent tool result MUST be preserved on the terminal status so any downstream resume has a starting point. (This is already the executor's behavior on terminal errors; verify the test asserts it.)

### 4.6 Detector trigger (piece 4)

In `packages/agent-loop/src/detectors/quality-flags.ts`, add a sixth flag id alongside the existing five
(`synthesis_low_yield`, `methodology_fabrication`, `tool_use_omission`, `truncated_synthesis`,
`text_tool_call_attempted`):

| Flag | Trigger | Disposition |
|---|---|---|
| `context_pressure_ignored` | `RunBudget.contextWindowTokens !== undefined` AND `(cumulativeInput + cumulativeOutput) / contextWindowTokens >= pressureThreshold` (default 0.7) AND **the trace contains zero `spawn_child_task` tool calls in the last `N` iterations (default `N = 3`)** | Flag in `structuralVerdict.suspicious[]`. **No action** — observation only. Operators learn which agent prompts are bad at self-management and tune the prompts. |

The detector runs at the existing `computeQualityFlags` callsite (`packages/agent-pod/src/runner.ts:281`). If the
`spawn_child_task` tool isn't admitted for this Agent (i.e., `Agent.spec.allowedChildAgents` is empty per the
implicit-when-X check landed in `1a64c92`), the detector still fires — the agent has no escape hatch and that's a
prompt-author bug worth flagging.

---

## 5. Composition with existing primitives

This slate composes cleanly with what already ships:

- **`spawn_child_task`** (`5d3cb3a`/`1a64c92`/`42a04fd` slate) is the handoff primitive. The agent's prompt names it; the substrate doesn't.
- **AgentWorkflow** (planned `v0.3.2-workflows`) can chain handed-off children into a logical "session" with durable replay.
- **AgentTemplate** is the canonical pattern for shipping a "long-running orchestrator" with the right system-prompt scaffold (analogous to Anthropic's Agent Skills shape).
- **`agent-sandbox` adoption (Path 1 from `UPSTREAM-DIFF-AGENT-SANDBOX.md`)** is orthogonal — long-lived `SandboxClaim`-backed agents inherit the same `get_my_context` and safety-net semantics. The contextWindowTokens env var flows the same way regardless of pod backend.
- **Capability primitive** (the same slate) — `tokenUtilization` is non-sensitive and surfaces unconditionally. Existing cap claims gate `spawn_child_task` admission separately.

What this slate explicitly does NOT add:

- **No auto-compaction.** The substrate never summarizes the agent's conversation.
- **No new `Agent.spec.contextStrategy` enum.** Strategy is implicit in the prompt; substrate only ships awareness + safety-net.
- **No new terminal phase.** Safety-net failures use `phase: 'Failed'` with a structured error reason. Adding a `Handed-Off` phase is plausible future work (`v0.2+`) but premature now — `Failed` + `error: context_window_substrate_refused:...` is greppable.
- **No model-aware compaction.** The agent's choice of summarizer model (when it manually delegates summarization to a child) is application-layer.
- **No automatic spawn-on-pressure.** Even at 94% utilization, the substrate never spawns a child without the LLM asking. The detector flags; the prompt acts.

---

## 6. Implementation slate (4-piece fan-out)

Each piece is a single commit, single agent, isolated git worktree.

| # | Piece | Files | Depends on | Tag |
|---|---|---|---|---|
| 1 | Operator + chart: `contextWindowTokens` per modelClass; project env var | `packages/operator/charts/kagent-operator/values.yaml`, `templates/deployment.yaml`, `packages/operator/src/main.ts` (env injection), `packages/operator/src/model-class-resolver.ts` (extend ModelClassMap) | nothing | `v0.1.9-context-aware.1` |
| 2 | Agent-pod plumbing: env reader, RunBudget extension, get_my_context tool field | `packages/agent-pod/src/env.ts`, `packages/agent-pod/src/runner.ts`, `packages/agent-pod/src/builtin-tools.ts` (defineGetMyContext), `packages/agent-loop/src/executor.ts` (RunBudget interface only — no behavior change here) | piece 1 (consumes env var) | `v0.1.9-context-aware.2` |
| 3 | Executor safety-net at 95% | `packages/agent-loop/src/executor.ts` (pre-call check + new error message) | piece 2 (consumes RunBudget.contextWindowTokens) | `v0.1.9-context-aware.3` |
| 4 | `context_pressure_ignored` detector | `packages/agent-loop/src/detectors/quality-flags.ts`, possibly `packages/agent-pod/src/runner.ts` (callsite) | piece 2 (consumes RunBudget.contextWindowTokens) | `v0.1.9-context-aware.4` |

**Merge order:** 1 → 2 → 3 → 4. Pieces 3 and 4 both add fields to `RunBudget`; if both add the same field with the
same name (per §4.3), git auto-merges cleanly. The doc is the contract that prevents three-way conflicts.

**TDD discipline:** every piece writes failing tests first. Existing tests must continue to pass.

**Helm template smoke:** chart still renders with default values AND with explicit `--set
agent.modelClasses.tool-caller-default.contextWindowTokens=131072`.

---

## 7. Back-compat tail

Existing v0.1.8 deployments must work unchanged after this slate ships:

- `agent.modelClasses` entries WITHOUT `contextWindowTokens` continue to dispatch tasks — env var is unset, all three downstream pieces are no-ops.
- Existing AgentTasks with `runConfig.tokenLimit` set continue to be enforced post-call (existing `executor.ts:658-659` path unchanged).
- The new `KAGENT_CONTEXT_SAFETY_THRESHOLD` env defaults to `0.95` whether or not the operator chart sets it — pieces 3 and 4 only fire when `contextWindowTokens` is also set, so the threshold value is moot until then.
- `get_my_context` returns the new `tokenUtilization` field unconditionally (with `null` modelWindow / percentage when unset). Existing consumers reading the prior field set are unaffected.

The migration story for existing operators: bump chart values to add `contextWindowTokens` per class. One PR. No CRD migration. No agent-pod restart required for already-running tasks (they keep using the per-pod env from when they were dispatched).

---

## 8. Out of scope / explicit non-goals for v0.1.9

- **Cross-task token aggregation.** The contextWindowTokens cap is per-AgentTask. A long-running session built from N handed-off children does not have a "session-wide token budget" — that's the consumer's accounting via AgentWorkflow once it ships.
- **Per-task `runConfig.contextSafetyThreshold` override.** Possible future addition; v0.1.9 ships with chart-wide setting only. Most consumers won't need per-task variance.
- **Adaptive thresholds.** No "if last 3 tasks blew context, lower the threshold." That's autopilot; the substrate stays a good copilot.
- **Cross-model window heuristics.** The chart values are explicit per class; the substrate does not infer windows from model names.
- **Pre-flight estimation.** The check is `cumulative + 0` against threshold — we do NOT try to estimate the size of the next prompt. That estimate would be wrong often enough to be misleading. The 95% safety margin absorbs the next call's input budget by convention.
- **Compaction-quality detector.** No flag like `compaction_lossy`. If the agent self-managed handoff with a bad summary, the existing F1/F2/F3 detectors will catch downstream symptoms (synthesis vacuity, methodology fabrication).

---

## 9. Open questions to resolve in implementation

These aren't blockers for the contract; they're decisions agents may make in flight:

- **Q1.** Should `KAGENT_CONTEXT_PRESSURE_THRESHOLD` and `KAGENT_CONTEXT_SAFETY_THRESHOLD` be a single float or a pair? Lean: pair. The pressure threshold (detector) and the safety threshold (refusal) are conceptually different and operators may want to tune independently.
- **Q2.** When detector fires AND an agent DOES call `spawn_child_task` in the next iteration, is the flag retracted from `structuralVerdict.suspicious[]`? Lean: NO. The flag records that the agent waited until late; the spawn after the fact is good behavior but doesn't undo the fact that the prompt isn't structured to act earlier.
- **Q3.** Should the "N iterations without spawn" lookback be configurable? Lean: NO for v0.1.9. Default `N = 3` matches the existing detector pattern. Add config if a real consumer asks.
- **Q4.** Should the safety-net error preserve the most recent N=2 messages instead of just the last one? Lean: keep what `RunResult` already stores (last `finalContent` + last tool result). Don't expand the terminal-state surface for this piece.
- **Q5.** Should the contextWindowTokens be readable from `Agent.spec` directly as an escape hatch (mirroring the `model` vs `modelClass` precedence pattern)? Lean: NO for v0.1.9. The chart values are the single source of truth. Per-Agent override is plausible v0.2 work if a consumer needs it.

---

## 10. Cross-references

- `packages/agent-loop/src/executor.ts:136-148` — current `RunBudget` interface (extension point for piece 2/3)
- `packages/agent-loop/src/executor.ts:658-668` — existing `tokenLimit` / `costLimitUsd` enforcement (piece 3 sits BEFORE these)
- `packages/agent-loop/src/detectors/quality-flags.ts` — existing detector battery (extension point for piece 4)
- `packages/agent-pod/src/builtin-tools.ts` `defineGetMyContext` — extension point for piece 2's tool field
- `packages/agent-pod/src/runner.ts:281` — `computeQualityFlags` callsite for piece 4
- `packages/agent-pod/src/runner.ts:255-280` — RunBudget assembly site for piece 2
- `packages/agent-pod/src/env.ts` — env reader extension point for piece 2
- `packages/operator/src/model-class-resolver.ts:50-115` — extend ModelClassMap entry shape for piece 1
- `packages/operator/src/main.ts:194-223` (`parseModelClassesEnv`) — parse the extended shape; piece 1
- `packages/operator/charts/kagent-operator/values.yaml:240-260` — chart map; piece 1
- `packages/operator/charts/kagent-operator/templates/deployment.yaml:268-269` — env projection; piece 1
- `docs/AUDIT-2026-05-06.md` C2.1 — the audit findings that prompted the safety-net design (BLOCKERs already fixed in `5d3cb3a`/`1a64c92`/`42a04fd`)
- `docs/UPSTREAM-DIFF-AGENT-SANDBOX.md` §3.1 — the Path 1 / SandboxClaim emission story this slate composes with
- `docs/MODEL-ROUTING.md` §4 — the chart map being extended
