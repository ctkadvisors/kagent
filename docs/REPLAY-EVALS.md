# Replay / Eval Harness — Phase 5 Substrate Primitive

**Date:** 2026-04-26
**Status:** Design, pre-implementation
**Phase:** 5 (E2E + first consumer + comparison rig)
**Prereqs:** `docs/WHY.md` §6, `docs/DESIGN-V0.1.md` §2, `docs/ROADMAP.md` Phase 5 + "Comparison rig"

> Read [`WHY.md`](./WHY.md) §6 first. The reason this primitive exists is to honor the falsifiable success criterion ahead of the work, not after.

---

## 1. Motivation

`WHY.md` §6 + `ROADMAP.md` "Comparison rig" commit to a falsifiable test before v0.1 ships: run the existing 5-topic researcher workload through `homelab-orchestrator` AND through kagent v0.1 for one week each; compare completion rate, median cost, median latency, and the detector-flag distribution. If kagent does not improve on the baseline, that is admit-failure territory.

That test needs a substrate primitive to be repeatable, queryable, and cheap. Without one, every comparison degrades into ad-hoc CSV joins of Langfuse exports against `kubectl get agenttask -o yaml` dumps. The harness is that primitive: an `AgentTaskRun` resource per execution attempt + a thin `ReplaySet` controller that fans N runs across `{model, agentSpec, seed}`, with a stable schema for the resulting metric series. It is a substrate primitive, not a workload primitive — researcher today, summarizer tomorrow, SeekArc agents later all evaluate the same way.

---

## 2. What gets captured for replay

A replay is reproducible iff every input the loop saw and every output it produced is preserved. From the existing `ExecutionResult` + `TraceEntry` surface (`packages/agent-loop/src/{executor,trace}.ts`) the substrate already knows most of this; the harness commits to writing it down at a stable path.

Per-run capture:

1. **Prompt(s)** — resolved `originalUserMessage`, `parentDistillation`, `payload` from AgentTask spec, plus `systemPrompt` from Agent.spec at run-start. Untruncated. (`truncateForStorage` is a Langfuse-emit concern; replay capture must be byte-exact.)
2. **Agent.spec snapshot** — full Agent CRD `.spec` at dispatch time (model, systemPrompt, tools[], capabilities[], sandboxProfile). Snapshotted because the live Agent may evolve between original Run and a later replay.
3. **Model id + provider** — already in `Agent.spec.model` (provider-prefixed). Replay can override.
4. **Tool list + tool-call args/responses** — every `tool_call` TraceEntry: `tool_name`, `tool_provider_id`, untruncated `tool_input`, untruncated tool output, `is_error`. Phase 1's trace stream is sufficient; harness writes a "full-fidelity" mirror per Run alongside the truncated Langfuse stream.
5. **Artifact refs** — assume the Phase 5 Artifacts workstream ships `ArtifactRef = {uri, sha256, sizeBytes, mediaType, producedAtMs}`. The Run records every artifact ref the loop produced (digest deltas the harness can diff).
6. **Trace IDs** — OTel `traceId` + per-entry `run_id`. Lets the comparison rig `JOIN` Langfuse spans against AgentTaskRun rows without bespoke ID mapping.
7. **RNG seeds** — for `temperature > 0`, the seed passed to the LLM (LiteLLM forwards `seed` to OpenAI/Bedrock/Anthropic). Seed-set ≠ deterministic, but pins one axis.
8. **Timestamps** — `createdAt`, `startedAt`, `completedAt` (already in AgentTaskStatus) + `dispatchLatencyMs` (Created→Pod-Running) and `e2eLatencyMs` (Created→status patched).
9. **Cost** — `RunBudget.cumulativeCostUsd`, promoted from a substrate-internal field to a CRD-status field.
10. **Detector verdict** — `structuralVerdict.suspicious` + per-flag breakdown (`synthesis_low_yield`, `methodology_fabrication`, `tool_use_omission`, `truncated_synthesis`, `refusal`).
11. **Run config** — `maxIterations`, `tokenLimit`, `costLimitUsd`, `timeoutSeconds`. The replay knob.

Storage: AgentTaskRun.status fields for the small queryable bits (cost, latencies, flags, terminalStatus); ArtifactRef-pointed object-store blobs for bulk fidelity (full prompts, full traces, tool IO). The CRD stays small; the "tape" lives behind an ArtifactRef.

---

## 3. CRD shape: `AgentTaskRun` per attempt vs `AgentTask.status.attempts[]`

**Decision: `AgentTaskRun` as a separate first-class CRD, owned by AgentTask via ownerReferences.** Rejected alternative: a `status.attempts[]` array growing per execution.

Reasoning, prioritized for the comparison rig:

- **Queryability dominates.** The rig needs `kubectl get agenttaskrun -l task=topic-7,model=...llama-4-scout...` to return all replays of one task on one model in one shell command. Field/label-selectors work on top-level resources, not on array-element indices inside a sibling's status. Any `kubectl get agenttask -o json | jq '.items[].status.attempts[] | select(...)'` is a tax we pay every comparison.
- **Status-array growth is a known K8s anti-pattern.** Unbounded growth hits etcd's per-object size cap (1 MiB default) and balloons watch-event payloads. Separate resources scale linearly.
- **OwnerReferences give the lifecycle properties for free.** `AgentTaskRun.ownerReferences = [AgentTask]` cascades on delete; same mental model, no storage coupling.
- **OTel + Langfuse already model run-as-resource.** Both expect a stable `run_id` per attempt; `TraceEntry.run_id` IS already a per-attempt id. Setting `AgentTaskRun.metadata.name = run_id` gives 1:1 with the trace store, zero reconciliation logic.
- **Replay is not just retry-on-failure.** A replay can be deliberate (model A vs B, Agent.spec v3 vs v4, temp=0 vs temp=0.7). Treating each attempt as a peer resource that records its inputs (model, seed, agentSpec snapshot) is more honest than treating the original as canonical and replays as second-class.

Cost: one extra controller (AgentTaskRun reconciler driving Job-per-Run, replacing the current direct Task→Job dispatch) and one extra CRD. Both small. AgentTask becomes the "logical task" — what the user wants done — and AgentTaskRun is the "execution attempt" — one specific (Agent.spec snapshot, model, seed, runConfig) actually run.

---

## 4. Eval metrics surface

Given N AgentTaskRuns labeled `task=<task-uid>` (or `replaySet=<set-uid>`), the harness exposes:

- **Completion rate** — `count(terminalStatus='completed' AND structuralVerdict.suspicious is empty) / count(*)`. Vacuous-but-completed runs (any flag fired) count against this — matches `WHY.md` §6.
- **Latency distribution** — `median(e2eLatencyMs)`, `p95(e2eLatencyMs)`, `median(dispatchLatencyMs)`. Dispatch latency isolates substrate cold-start from model latency.
- **Cost distribution** — `median(costUsd)`, `p95(costUsd)`, `sum(costUsd)`. Median is the headline; sum is the budget receipt.
- **Detector-flag distribution** — per-flag fire rate from the five flags in `packages/agent-loop/src/detectors/`. (Replaces the F1/F2/F3 vocabulary from HARNESS-LESSONS with the actual flag names.)
- **Artifact comparison** — pairwise across runs of the same logical task: `presenceMatrix`, `shaEqualMatrix`, `sizeDeltaPct`. Answers "did model B produce the same daily digest as model A, just slower / cheaper?" without manual diffing.
- **Token distribution** — `median(cumulativeInputTokens + cumulativeOutputTokens)`. Cost proxy when reporting is missing (Ollama, on-prem).

Computed by a stateless reducer: `AgentTaskRun[] → RunSetReport`. Lives in a new tiny package `@kagent/eval` (out of scope for this design, in scope for Phase 5 implementation).

---

## 5. Run-metadata schema

TS surface (proposal — to land in `packages/operator/src/crds/types.ts` during implementation; this design doc does not edit that file):

```ts
export type AgentTaskRunPhase = 'Pending' | 'Dispatched' | 'Completed' | 'Failed';

export interface AgentTaskRunSpec {
  readonly taskRef: { readonly name: string; readonly uid: string };
  readonly agentSpecSnapshot: AgentSpec;          // verbatim at dispatch time
  readonly modelOverride?: string;
  readonly seed?: number | null;                   // recorded even when null
  readonly runConfig?: {
    readonly maxIterations?: number;
    readonly tokenLimit?: number;
    readonly costLimitUsd?: number;
    readonly timeoutSeconds?: number;
  };
  readonly replaySetRef?: { readonly name: string; readonly uid: string };
  readonly attempt: number;                        // 1-based within parent Task
}

export interface AgentTaskRunStatus {
  readonly phase?: AgentTaskRunPhase;
  readonly terminalStatus?: 'completed' | 'failed' | 'timeout' | 'budget_exceeded' | 'cancelled';
  readonly podName?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly dispatchLatencyMs?: number;
  readonly e2eLatencyMs?: number;
  readonly costUsd?: number | null;
  readonly cumulativeInputTokens?: number;
  readonly cumulativeOutputTokens?: number;
  readonly hitIterationCap?: boolean;
  readonly structuralVerdict?: { readonly suspicious: readonly string[] };
  readonly detectorVersion?: string;               // frozen at run-time
  readonly otelTraceId?: string;                   // join key to Langfuse
  readonly tape?: ArtifactRef;                     // full-fidelity untruncated trace + IO
  readonly artifacts?: readonly ArtifactRef[];     // produced outputs
  readonly result?: unknown;
  readonly error?: string;
}
```

CRD excerpt for `manifests/crds/agenttaskruns.yaml` (abbreviated):

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: agenttaskruns.kagent.knuteson.io }
spec:
  group: kagent.knuteson.io
  names: { kind: AgentTaskRun, plural: agenttaskruns, shortNames: [atr] }
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      additionalPrinterColumns:
        - { name: Task,   type: string,  jsonPath: .spec.taskRef.name }
        - { name: Model,  type: string,  jsonPath: .spec.agentSpecSnapshot.model }
        - { name: Phase,  type: string,  jsonPath: .status.phase }
        - { name: CostUsd,type: number,  jsonPath: .status.costUsd }
        - { name: E2eMs,  type: integer, jsonPath: .status.e2eLatencyMs }
      subresources: { status: {} }
      schema: { openAPIV3Schema: { ... } }   # mirrors the TS interfaces
```

Selector-friendly labels stamped on every Run for one-liner aggregation:

- `kagent.knuteson.io/task=<task-uid>`
- `kagent.knuteson.io/model=<sanitized-model-id>`
- `kagent.knuteson.io/replay-set=<set-uid>` (when applicable)
- `kagent.knuteson.io/agent=<agent-name>`

---

## 6. Helper API

The substrate ships ONE primitive — a `ReplaySet` CRD that fans Runs out — and a thin `kagent` CLI wrapper that templates+applies it. CLI is convenience; CRD is the contract.

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: ReplaySet
metadata: { name: scout-vs-sonnet-topic-7 }
spec:
  sourceTask: { name: research-topic-7 }     # cloned to seed each Run
  matrix:
    models: ["workers-ai/...llama-4-scout...", "anthropic/claude-sonnet-4-6"]
    seeds:  [1, 2, 3]                         # cartesian => 6 Runs
  agentSpecOverlay:                           # optional patches to the snapshot
    sandboxProfile: default
  runConfig: { maxIterations: 8, costLimitUsd: 0.50 }
```

Controller: snapshots `sourceTask` + resolved Agent.spec; for each `(model, seed)` cell creates one AgentTaskRun with `replaySetRef`, `agentSpecSnapshot`, `attempt`, dual ownerRefs (source Task + ReplaySet); watches Runs to terminal phase; computes `RunSetReport` and writes it to `ReplaySet.status.report`.

CLI sugar:

```bash
kagent replay <task-name> --model anthropic/claude-sonnet-4-6 --count 5 --seed-base 1000
# ≡ kubectl create -f <generated-replayset.yaml>

kagent replay-report <replayset-name>
# ≡ kubectl get replayset <name> -o yaml | jq .status.report
```

Substrate stays declarative; CLI is for shells, not for CI. CI uses `kubectl create -f` against templated YAML so the artifact lives in git.

---

## 7. Comparison-rig workflow

How `docs/V0.1-COMPARISON.md` (the deliverable promised in `ROADMAP.md` Phase 5) gets produced:

1. **Baseline week — `homelab-orchestrator`.** During the existing CronJob's nightly run, a small adapter writes a `BaselineRun` record per topic into the same object-store bucket the ArtifactRef code uses. Schema mirrors AgentTaskRun.status. 5 topics × 7 days = ~35 baseline rows.
2. **kagent week — replay the baseline.** `kagent replay <task> --count 7` (or one ReplaySet per topic) re-runs each topic seven times. Same model, same Agent.spec (the researcher port), same prompt — only the substrate differs. 35 kagent-side AgentTaskRuns.
3. **Side-by-side query.** Both sides land in queryable form:
   - kagent: `kubectl get agenttaskrun -l agent=researcher -o json | jq ...` against structured CRD-status.
   - baseline: object-store JSON lines, same shape by construction.
   - The `@kagent/eval` reducer takes both arrays, returns `{baseline: RunSetReport, kagent: RunSetReport}`.
4. **Generate the table.** A ~30-LoC Bun script renders the side-by-side report into `docs/V0.1-COMPARISON.md`:

   | Metric | homelab-orchestrator | kagent v0.1 | Delta |
   | --- | --- | --- | --- |
   | Completion rate (clean runs) | 0.83 | 0.91 | +0.08 |
   | Median cost (USD) | 0.014 | 0.011 | -0.003 |
   | Median e2e latency (s) | 38 | 31 | -7 |
   | synthesis_low_yield rate | 0.11 | 0.06 | -0.05 |
   | … | | | |

5. **Verdict.** Per `WHY.md` §6: if the kagent column is no better, v0.1 hasn't earned its shipping; v0.2 (Kata, warm pool, framework swap) becomes the validation bet, not a presumed evolution. The rig outputs the *evidence*, not the verdict — the verdict belongs to a human reading the table.

---

## 8. Open questions

- **Where does the tape live?** v0.1 hand-rolls an in-cluster MinIO PVC; v0.2 pivots to whatever the Artifacts workstream picks. Hard-code the `ArtifactRef` contract, let storage backend be swappable.
- **Provider-side seed support varies.** OpenAI/Bedrock honor `seed`; CF AI Gateway pass-through is inconsistent; Ollama models often ignore it. Record whether the seed was honored (LiteLLM exposes this on response headers) so the reducer doesn't misattribute variance to model quality.
- **Detector heuristics evolve.** When `quality-flags.ts` adds a flag or tunes a threshold, do prior Runs get re-evaluated retroactively? **Decision: NO.** Detector results frozen at run-time; replays under new detectors are themselves new runs. `detectorVersion` is a captured field.
- **ReplaySet matrix granularity.** v0.1 ships `{models, seeds}`. v0.2 candidates: `{systemPromptOverlays, toolListOverlays, sandboxProfiles}`. Don't pre-build them; let demand drive.
- **A2A multi-pod runs.** A delegation chain (researcher → summarizer) is multiple AgentTaskRuns linked via `parentTask`. "Whole-chain completion rate" is a derived metric the reducer computes — it does not leak into CRD shape.
- **Artifacts workstream coupling.** This design assumes `ArtifactRef` exists. If that workstream slips, v0.1 of the harness writes tape paths as plain strings and gets `ArtifactRef` retrofitted in v0.2. Don't block on it.

---

## REV-03 stub — Phase 4 placement

Phase 4 reserves two slots in the `ReviewReason` closed-enum (`@kagent/dto/review-queue.ts`): `replay-divergence` and `eval-failed`. v0.2 producers: zero. The Phase 4 review-queue route (`packages/workbench-api/src/routes/review-queue.ts`) carries an inline comment block at the top of the module documenting the slot and the promotion path.

When the Phase 5 design ships (`AgentTaskRun` CRD + `@kagent/eval` package + `ReplaySet` controller), the eval reducer should emit `replay-divergence` audit events the projection picks up. Concretely, the projection classifier (`classifyTask`) gains a step 2.5: "if any `AgentTaskRun` for this task has `terminalStatus='replayed-divergence'`, emit reason `replay-divergence` with `replayDivergence` populated." The `ReviewQueueRow` shape is unchanged; the projection module's `compute()` body grows ~15 lines.

Until then, `verifier-failed` and `suspicious-detector` cover what `.planning/REQUIREMENTS.md` REV-03 calls "replay/eval signals" today.
