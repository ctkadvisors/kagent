# Flow Legend (developer docs — NOT in main UI chrome)

> Eight `C-flow-economy` resource flows rendered as continuous gauges in
> Command Center's `<FlowOverlay />`. This is the developer-facing source
> of truth for what each flow IS, where its data comes FROM, and how it
> WILL evolve. Per `docs/COMMAND-CENTER-CONTRACT.md` §7 Slice E, this
> legend is NOT replicated as on-canvas chrome (no tooltip, no "?"
> button, no sidebar key). Operators read code + docs.
>
> Visual treatment of all overlays (disposition, pressure, flows) is
> controlled by `VITE_PRESSURE_DRAMATIZATION`. Set `false` for
> base-building-only mode (subdued styling, same data).
>
> Living doc — update when `packages/workbench-ui/src/command/flows.ts`
> adds, removes, or promotes a flow.

## Sources

- `.planning/intel/constraints.md` §C-flow-economy — canonical 8-flow definition
- `docs/COMMAND-CENTER-CONTRACT.md` §7 Slice E — overlay binding contract ("legend in developer docs, NOT in main UI chrome")
- `.planning/phases/03-resource-flow-overlays/03-CONTEXT.md` D-01..D-05 — locked Phase 3 decisions
- `packages/workbench-ui/src/command/flows.ts` — `FLOW_TYPES` source-of-truth (each entry's leading comment names source fields + promotion path)
- `packages/workbench-ui/src/command/pressure.ts` — companion pressure markers (Phase 2 / CC-04)

## At-a-glance

Per `intel/constraints.md §C-flow-economy`: flows track how supply and demand are moving through the substrate in real time. When demand exceeds supply, work stalls, meters, queues, or fails with a substrate reason. Command Center must make these flows visible.

| Flow | Granularity | v0.2 source fields | Ideal source | Pressure trigger | Operator action | Promotion path |
| ---- | ----------- | ------------------ | ------------ | ---------------- | --------------- | -------------- |
| `modelPower` | `perEndpoint` | `GatewayCapacityRow.inFlight` + `GatewayCapacityRow.currentCap` | (clean — same) | `gateway` (`pressure.ts:80`) | Scale gateway / rebalance per-endpoint pool | n/a — source is already clean |
| `tokenFlow` | `perModelClass` | `TaskSummary.model` + `TaskSummary.phase` (Dispatched task count, `unit='tasks'`) | `GatewayUsageRow.inputTokens + outputTokens` rolling 1m per model | (no direct trigger today) | Watch model-class hot-spots; investigate when one model dominates dispatched tasks | Promote when rolling-window aggregation reaches `useCommandSnapshot()` — `gatewayUsage` already on snapshot (state.ts:88) |
| `buildPower` | `perAgent` | `TaskSummary.targetAgent` + `TaskSummary.phase` (Dispatched count per agent) | `pilotEvidence.policy.maxConcurrentChildren` on TaskDetail | `context` (`pressure.ts:208`) | Rebalance work / spawn additional agents when one saturates | Promote when `pilotEvidence` subset reaches `TaskSummary` |
| `podCapacity` | `substrateWide` (v0.2 fallback) | `TaskSummary.podName` + `TaskSummary.phase` (Dispatched or Pending with a podName) | `ClusterNodeRow.managedPodCount / capacity['pods']` per node | `pod` (`pressure.ts:122`) | Scale cluster / cordon nodes / migrate pods | Promote when cluster snapshot joins `useCommandSnapshot()` |
| `artifactBandwidth` | `substrateWide` | `TaskSummary.artifactCount` + `TaskSummary.phase` (sum over Completed tasks) | (clean — same) | `artifact` (`pressure.ts:101`) | Drain artifact debt / triage long-tail completions | n/a — source is already clean |
| `authority` | `substrateWide` | `TaskSummary.error` + `TaskSummary.phase` (Failed tasks where error contains 'policy') | Structured `policy_denied` audit event on SSE stream | `policy` (`pressure.ts:290`) | Review denials / adjust capability-JWT scope | Promote when audit-event kinds reach the SSE stream |
| `trust` | `substrateWide` | `TaskSummary.suspicious` + `TaskSummary.error` + `TaskSummary.phase` (suspicious.length > 0 OR Failed + 'verifier' in error) | `pilotEvidence.verification.passed === false` on TaskDetail | `verifier` (`pressure.ts:233`) | Investigate verifier-failed + suspicious tasks; reviewer queue | Promote when `pilotEvidence` subset reaches `TaskSummary` |
| `attention` | `substrateWide` (Phase 3 stub) | `TaskSummary.phase` + `TaskSummary.suspicious` (Failed OR suspicious — label: 'awaiting review queue projection — Phase 4') | Real review-queue projection (REV-01) | (no direct trigger today) | Jump to review queue and triage oldest items | **Phase 4** owns this — `compute()` body swap with no `FlowGauge` shape change |

## modelPower

### modelPower

Per `intel/constraints.md §C-flow-economy`, model power tracks gateway/model endpoint capacity by model class. Supply is the endpoint's concurrent-request cap (`currentCap`); demand is the number of requests currently in flight (`inFlight`). When demand approaches or exceeds supply, work queues at the gateway — LiteLLM Proxy emits 429s and `Retry-After` headers.

**v0.2 source fields** (`flows.ts:68–90`):\
`GatewayCapacityRow.inFlight` + `GatewayCapacityRow.currentCap`. One gauge per gateway endpoint. This is a clean source — no fallback derivation needed. Gauge: `value=inFlight`, `capacity=currentCap` (when > 0), `unit='in flight'`.

**Fallback derivation:** None. Source is clean.

**Companion pressure trigger:** `gateway` marker at `pressure.ts:80`. Both read the same `GatewayCapacityRow` fields. The pressure marker fires when `inFlight / currentCap >= 0.8` (threshold-fired). The flow gauge is always visible regardless of threshold.

**Operator action:** When the gauge approaches capacity, scale the gateway pool (patch `ModelEndpoint.spec.maxConcurrentRequests`) or rebalance traffic across model classes with lower in-flight counts. The `#/gateway` detail link shows the full capacity row.

**Promotion path:** n/a — source is already the ideal substrate field.

## tokenFlow

### tokenFlow

Per `intel/constraints.md §C-flow-economy`, token flow tracks prompt/output token usage over time. The pressure surface includes cost overrun and context pressure from large-prompt accumulation. The ideal source is a rolling per-model-class token window from `/api/gateway/usage`.

**v0.2 source fields** (`flows.ts:93–125`):\
`TaskSummary.model` + `TaskSummary.phase`. The v0.2 gauge counts Dispatched tasks grouped by model class (`unit='tasks'`). This is an honest proxy — the `label` makes the scope visible ("tasks dispatched per model: `<model>`") rather than pretending to count tokens. `snapshot.gatewayUsage` IS already reachable via `useCommandSnapshot()` (state.ts:88) — promotion to real per-request token counts is a single-PR future change.

**Fallback derivation:**
```
counts = group count(TaskSummary where phase='Dispatched' && model !== undefined) by model
```

**Companion pressure trigger:** No direct pressure trigger today. A future per-model-class token-saturation marker would complement this flow. The `#/gateway` detail link shows gateway rows as the nearest available surface.

**Operator action:** Watch model-class hot-spots. When one model dominates dispatched-task count for an extended period, investigate queue depth, adjust routing policy (LiteLLM Proxy model-class routing), or redistribute work to agents using alternate model classes.

**Promotion path:** Promote when rolling-window aggregation reaches `useCommandSnapshot()`. Because `gatewayUsage` is already on the snapshot (state.ts:88), this is a single-PR `compute()` body change — no `FlowGauge` shape change required. Ship when the task-count proxy proves repeatedly insufficient.

## buildPower

### buildPower

Per `intel/constraints.md §C-flow-economy`, build power tracks agent concurrency and child fanout. When an agent accumulates too many in-flight tasks, its context window fills, it starts exceeding its `maxConcurrentChildren` policy limit, and new child tasks are rejected by the substrate.

**v0.2 source fields** (`flows.ts:128–159`):\
`TaskSummary.targetAgent` + `TaskSummary.phase`. One gauge per agent with at least one Dispatched task. Value = count of `phase=Dispatched` tasks targeting that agent. No capacity bar in v0.2 (the ideal cap lives on `pilotEvidence.policy.maxConcurrentChildren` on TaskDetail).

**Fallback derivation:**
```
count(TaskSummary where targetAgent === agent.name && phase === 'Dispatched') per agent
```

**Companion pressure trigger:** `context` marker at `pressure.ts:208`. Both read task dispatch state. The pressure marker uses `TaskSummary.childCount >= 2` as a v0.2 heuristic for high fanout; the flow gauge sums Dispatched tasks per target agent.

**Operator action:** When one agent's gauge shows a disproportionate in-flight count, rebalance by spawning additional agents of the same template or by reducing the task fanout rate from the orchestrator. The `#/tasks?agent=<name>` detail link filters to that agent's task list.

**Promotion path:** Promote when `pilotEvidence.policy.maxConcurrentChildren` reaches `TaskSummary`. The capacity bar becomes meaningful only once the denominator is available — until then, the open-ended count is the honest shape.

## podCapacity

### podCapacity

Per `intel/constraints.md §C-flow-economy`, pod capacity tracks schedulable Kubernetes execution. When pod slots are exhausted, new task pods are Pending indefinitely — unschedulable due to node resource limits, taint policies, or admission webhook denials.

**v0.2 source fields** (`flows.ts:162–189`):\
`TaskSummary.podName` + `TaskSummary.phase`. Substrate-wide active-pod count: tasks where `podName !== undefined` AND `phase ∈ {Dispatched, Pending}`. Single gauge with no capacity bar in v0.2 (the ideal denominator lives on `ClusterNodeRow.managedPodCount / capacity['pods']` per node).

**Fallback derivation:**
```
count(TaskSummary where podName !== undefined && phase ∈ {'Dispatched', 'Pending'})
```

**Companion pressure trigger:** `pod` marker at `pressure.ts:122`. Both read `TaskSummary.podName`. The pressure marker fires when `phase=Failed && podName !== undefined` (pod failure after scheduling). The flow gauge shows currently-active pod count regardless of failure state.

**Operator action:** When active-pod count grows large, scale the cluster (add nodes via `new_localai/` GitOps) or cordon overloaded nodes. If pods are Pending, check node resource pressure and admission webhook policies. The `#/cluster` detail link shows the cluster summary page.

**Promotion path:** Promote when cluster snapshot joins `useCommandSnapshot()`. The `ClusterNodeRow` shape is already defined in the substrate; adding it to the snapshot hook enables per-node capacity bars without changing `FlowGauge` shape.

## artifactBandwidth

### artifactBandwidth

Per `intel/constraints.md §C-flow-economy`, artifact bandwidth tracks CAS/workspace read/write pressure. The pressure surface includes missing output (a task completes but produces no artifact) and slow downstream consumers stalled on artifact availability.

**v0.2 source fields** (`flows.ts:192–218`):\
`TaskSummary.artifactCount` + `TaskSummary.phase`. Substrate-wide sum of `artifactCount` over `phase=Completed` tasks with `artifactCount > 0`. This is a clean source — no fallback derivation needed.

**Fallback derivation:** None. Source is clean.

**Companion pressure trigger:** `artifact` marker at `pressure.ts:101`. Both read `TaskSummary.artifactCount`. The pressure marker fires when `phase=Completed && artifactCount === 0` (artifact debt — completed without expected output). The flow gauge sums the artifacts that DID arrive, giving the throughput view.

**Operator action:** When the gauge stalls (value stops growing despite active tasks), investigate artifact write failures in the CAS backend. When the `artifact` pressure marker fires alongside a stalled flow, prioritize triage of the debt-bearing tasks. The `#/cluster` detail link shows the cluster/artifact summary.

**Promotion path:** n/a — source is already the ideal substrate field.

## authority

### authority

Per `intel/constraints.md §C-flow-economy`, authority tracks capability grants for tools, models, spawn, and egress. When an agent's capability JWT is missing or too narrow, the substrate denies the action and fails the task with a policy reason. Repeated denials signal a misconfigured agent template or a scope gap in the issued JWT.

**v0.2 source fields** (`flows.ts:220–248`):\
`TaskSummary.error` + `TaskSummary.phase`. Substrate-wide count of `phase=Failed` tasks where `error.toLowerCase().includes('policy')`. Same error-string heuristic as the `policy` pressure marker (best-effort — false positives accepted per threat model T-02-05).

**Fallback derivation:**
```
count(TaskSummary where phase === 'Failed' && error.toLowerCase().includes('policy'))
```

**Companion pressure trigger:** `policy` marker at `pressure.ts:290`. Both read the same `TaskSummary` fields with identical filter logic. The pressure marker fires per failing task (N markers for N denials); the flow gauge sums them into a single substrate-wide count.

**Operator action:** Review the failing tasks' capability claims. Identify which tool, model, spawn, or egress action was denied. Adjust the `AgentTemplate`'s capability JWT scope or raise the issue with the tenant policy owner. The `#/tasks` detail link filters to the task list for drill-down.

**Promotion path:** Promote when a structured `policy_denied` audit-event kind lands on the SSE stream (current SSE only emits `{kind: 'task'|'agent'|'job'|'pod', op, key}` — per RESEARCH.md Open Question 1). A structured signal removes the error-string false-positive risk.

## trust

### trust

Per `intel/constraints.md §C-flow-economy`, trust tracks verifier, detector, and audit cleanliness. When the trust gauge is non-zero, one or more tasks have been flagged as suspicious by a detector or have failed with a verifier error — indicating that promoted work may be compromised or that the verifier contracts need updating.

**v0.2 source fields** (`flows.ts:251–282`):\
`TaskSummary.suspicious` + `TaskSummary.error` + `TaskSummary.phase`. Substrate-wide count of tasks where `suspicious.length > 0` OR (`phase=Failed` AND `error.toLowerCase().includes('verifier')`). Same error-string heuristic as the `verifier` pressure marker (best-effort — false positives accepted).

**Fallback derivation:**
```
count(TaskSummary where suspicious.length > 0
  || (phase === 'Failed' && error.toLowerCase().includes('verifier')))
```

**Companion pressure trigger:** `verifier` marker at `pressure.ts:233`. Both read `TaskSummary.error` with the 'verifier' string match. The pressure marker fires per failing task; the flow gauge counts the union of verifier-failed AND suspicious tasks.

**Operator action:** Open the detail page for each flagged task. Investigate the suspicious tags and verifier evidence. If the verifier contracts are genuinely failing, retry with corrected agent input. If the suspicious flags are false positives, adjust detector thresholds and add the task to the reviewer queue for disposition.

**Promotion path:** Promote when `pilotEvidence.verification.passed` reaches `TaskSummary`. The ideal source (`pilotEvidence.verification.passed === false` on TaskDetail) is already on the detail view — adding it to `TaskSummary` removes the error-string heuristic. Deferred to a future Workbench-hardening phase.

## attention

### attention

Per `intel/constraints.md §C-flow-economy`, attention tracks human review capacity. When the review queue fills faster than reviewers can work through it, stale items accumulate — failed promotions, unreviewed suspicious flags, and blocked capability grants pile up. This is the pressure most directly shaped by human throughput rather than substrate configuration.

**v0.2 source fields** (`flows.ts:284–314`):\
`TaskSummary.phase` + `TaskSummary.suspicious`. Phase 3 stub: substrate-wide count of `phase=Failed` OR `suspicious.length > 0` tasks. The gauge label is `'awaiting review queue projection — Phase 4'` and carries `data-source-fields="phase,suspicious"` to make the stub scope explicit.

**Fallback derivation:**
```
count(TaskSummary where phase === 'Failed' || suspicious.length > 0)
```

**Companion pressure trigger:** No direct pressure trigger today. Phase 4's review-queue projection will map to a dedicated pressure type when the `ReviewQueueRow` DTO lands. The `authority` and `trust` gauges are the nearest current signals for review-queue pressure.

**Operator action:** Jump to the review queue (currently `#/tasks` filtered by Failed or suspicious) and triage the oldest items. Prioritize verifier-failed tasks (trust gauge) and policy-denied tasks (authority gauge) as they block promotion-loop progress.

**Promotion path:** **Phase 4** owns this — `compute()` body swaps to the real review-queue projection (REV-01 in REQUIREMENTS.md) with no `FlowGauge` shape change. The stub label and `data-source-fields` attribute change; all other gauge fields stay identical. This swap is designed to be a single-file, single-function change with no downstream cascade.

---

_Living doc — update when `packages/workbench-ui/src/command/flows.ts` adds, removes, or promotes a flow._
