# Hybrid Agent Policy — Oldschool + LLM AI

**Status:** Forward-looking design seed (planted 2026-05-08, not yet planned).
**Trigger to surface:** when v0.2 requirements are scoped — this is a fit for
the milestone after v0.1 substrate ships.

## What this is

The next direction for the kagent control plane: make the duality between
**reactive / oldschool game-AI** and **deliberative / LLM-backed AI**
first-class and visible in the Agent CRD and the workbench.

Today, every kagent agent is implicitly hybrid — the agent loop has retry
caps, timeouts, escalation, and supervision rules wrapping the LLM calls.
But that reactive scaffolding is hardcoded. The next iteration makes it
**configurable, declarative, and visible** — a `Agent.spec.policy` field
that holds an explicit behavior tree and reactive guards, surfaced in the
workbench's right-click unit-detail panel as a live diagram.

## Why this matters

- **Predictability:** "if cost > $X, refuse next dispatch" should be a
  declarative rule on the Agent, not buried in an agent-loop branch.
- **Composability:** real agent systems are mostly orchestration (this
  agent calls those tools, fans out to those children, aggregates with
  this rule). Behavior trees express that compactly.
- **Debuggability:** when an agent does something surprising, the
  operator should be able to see the active node in its tree and the
  guards that did/didn't fire — same way RTS players inspect unit AI.
- **Cost discipline:** reactive guards are microseconds; LLM calls are
  seconds and dollars. Making the boundary explicit lets the cheap path
  short-circuit before the expensive path runs.

## Patterns to adopt (and where they map)

| RTS / oldschool-AI pattern | kagent CRD field (proposed) | Workbench surface |
|---|---|---|
| Behavior tree (root → selectors → sequences → actions) | `Agent.spec.policy.behaviorTree` | Live diagram in unit-detail panel; active node highlighted |
| FSM / unit phase (idle / busy / fail) | `Task.status.phase` (already exists) | Voxel phase-color spire + idle bob (already exists) |
| Reactive guards (utility-AI scoring rules) | `Agent.spec.guards[]` | Small pip icons over the unit when a guard fires; flash on trip |
| Squad commander policy (aggregate K-of-N) | `Agent.spec.supervision.aggregator` (extends existing supervision) | Animated "deliberating" ring around parent until N reports |
| Blackboard / shared memory | `Task.status.blackboard` projection | Side panel shows accumulated facts; watchable like a mini-state |
| Triggers / scripted alarms | `Agent.spec.guards[]` (overlap with reactive) | Klaxon already wired; add visible threat ring per guard type |
| Pathfinding / message routing | NATS routes (already there) | Belt-pulse already renders |
| Veterancy / experience | `Task.status.outcomes.successRate` rollup | Veterancy stars (currently cosmetic) become real |

## The interaction model

Each agent's policy is a **single behavior tree** with leaves of two kinds:

- **`Action.script`** — synchronous, deterministic, microseconds.
  Built-ins: `retry`, `escalate`, `wait`, `dispatch_child`, `set_blackboard`,
  `assert_budget`, `pick_model`, `cancel_siblings`, `aggregate_children`.
- **`Action.llm`** — asynchronous, probabilistic, ms-to-seconds.
  Calls a model with a templated prompt that may read from the blackboard.
  Records cost + tokens + trace link to status.

Each node may be guarded by `Agent.spec.guards[]` rules — utility-AI-style
scoring expressions evaluated before the node runs. Guards can refuse,
defer, or rewrite the call (e.g., downgrade model class on cost overrun).

## Workbench rendering (what we're already building toward)

The right-click unit-detail panel — the surface we sketched chrome for
during 2026-05-08 visual work — is exactly where this lands:

- **Header:** agent name + faction + current FSM phase
- **Stat sheet:** model class, in-flight count, recent cost, success rate
  (the existing veterancy surface, now real)
- **Behavior tree diagram:** scrollable inline tree with the active node
  highlighted; clicking a node shows its config / last result
- **Guard pips:** small icons for each guard, color-coded by recent trip
- **Blackboard table:** key/value of agent-local memory
- **Action footer:** Inspect / Re-dispatch / Open trace / Cancel
  (the existing TaskActionMenu's four actions)

In-RTS metaphor: this is the "unit info panel" RTS players muscle-memory
toward — Halo Wars-style. The shapes the workbench has been growing into
(voxel sprites, hp bars, vapor trails, supervision belts) all serve this
end-state where the operator inspects an agent the same way an RTS player
inspects a unit's stance + orders.

## Dependencies

- **Operator:** new `Agent.spec.policy` and `Agent.spec.guards` schema;
  agent-loop must consume them to gate / sequence its existing flow.
- **Workbench API:** project policy state into `status.policy.activeNode`
  and `status.guards[]` (firing history). New SSE events for active-node
  transitions.
- **Workbench UI:** new BehaviorTreeView component in the unit-detail
  panel. Re-uses voxel layout for the in-canvas surface; new SVG renderer
  for the tree diagram.
- **Image assets:** RA2-style guard-pip icon set (small 32×32 sprites,
  one per guard type).

## Out of scope for the first cut

- **Editing the tree from the workbench** — read-only diagram first;
  policy mutations go through git-managed CRDs (per CLAUDE.md GitOps
  rule), not click-to-edit. Editing UI is a separate phase.
- **Cross-agent learning** — each agent's policy is its own; no shared
  meta-policy. Multi-agent coordination still goes through supervision
  + NATS message bus, not a global policy store.
- **Replanning during a task** — the tree config is read at agent-loop
  spawn; mid-task changes require restart. Hot-reload is a follow-up.

## Open design questions

- Behavior-tree DSL: YAML inline, separate `BehaviorTree` CRD, or a
  Helm-chart-style values pattern?
- Guard expression language: CEL, JSONPath + simple ops, or a tiny DSL?
- How do supervision-aggregator policies compose with behavior trees on
  the parent agent? (One thought: the aggregator IS a node in the
  parent's tree, gated by "all children reported".)
- Where do "memory across tasks" semantics land — blackboard scoped per
  agent (resets each run) vs. per agent-namespace (persistent)?
