# Command Center Contract

**Date:** 2026-05-08
**Status:** next-steps contract for the RTS Workbench overlay
**Audience:** future implementation agent working on `packages/workbench-*`

North-star context: [`NORTH-STAR-SYSTEM-DESIGN.md`](./NORTH-STAR-SYSTEM-DESIGN.md).

This document makes the 90s RTS Workbench direction tangible without
letting the UI become a second platform. The Command Center is a rich
projection over the substrate, not a game state engine.

## 1. Thesis

The substrate is already game-shaped:

- `Agent` objects are buildable structures.
- `AgentTask` objects are units moving through work.
- `ModelEndpoint` capacity is a resource bar.
- Capabilities are tech permissions.
- Artifacts are produced materials.
- Events, audit records, traces, and verifier results are the battle log.
- Quotas, policy denials, deadlines, context pressure, and gateway
  saturation are the pressure systems.

The UI can lean into that shape because the metaphor lowers cognitive
load for a graph-shaped execution fabric. It must remain faithful to
the underlying control plane.

## 2. Prime directive

Every visible world object, animation, action, and alert MUST derive
from one of these sources:

- Kubernetes CRDs: `Agent`, `AgentTask`, `ModelEndpoint`,
  `AgentTemplate`, `Tenant`, `Workspace`, `AgentWorkflow`
- Kubernetes-owned runtime objects: Jobs, Pods, conditions, events
- kagent DTOs exposed by Workbench API
- audit events
- gateway admin surfaces
- artifacts, traces, and verifier results

The UI MUST NOT maintain independent strategic state. If it cannot be
reconstructed from Workbench API responses after a page reload, it is
presentation state only and must not affect substrate behavior.

## 3. Source-of-truth map

| RTS concept | Substrate source | Allowed UI behavior | Forbidden behavior |
|---|---|---|---|
| HQ / command center | Workbench API health, operator health, gateway capacity | Render central base, show health/capacity, deep-link to cluster/gateway pages | Invent hidden global health score with no source field |
| Agent building | `AgentSummaryRow` from `/api/agents` | Position by namespace/faction, decorate by tools/capabilities/model class | Show an Agent that does not exist in API cache |
| Unit / worker | `TaskSummary` from `/api/tasks` | Animate by phase, route toward target Agent, color by status | Keep a completed/failed unit alive as active work after API says terminal |
| Build queue | non-terminal `AgentTask`s grouped by target Agent | Stack or queue sprites, show ETA only if derived from timestamps | Promise scheduling order unless the substrate exposes it |
| Tech unlock | promoted tool/template/capability record | Display new affordance after catalog object exists | Treat a model-generated suggestion as available tool authority |
| Resource bar | gateway usage/capacity, token/cost usage, quota status | Show in-flight, token/min, spend, caps | Mix estimated UI-only points with real quota numbers |
| Fog of war | stale cache/SSE heartbeat/informer readiness | Dim regions with stale telemetry | Hide failures to preserve visual theme |
| Alert | failure reason, suspicious detector, verifier fail, audit denial | Use incident visual language and link to evidence | Create fictional enemies without observable backing |
| Construction | POST/PATCH that creates or mutates CRDs through Workbench API | Show build animation after API accepts write | Optimistically create durable objects without server confirmation |

## 4. Action contract

Command Center actions are allowed only when they write the same
substrate object another channel would write.

Allowed action classes:

- Create `AgentTask` through the existing `POST /api/tasks` surface.
- Patch bounded operational knobs already exposed by Workbench API, such
  as ModelEndpoint in-flight caps.
- Open trace, artifact, detail, gateway, and cluster views.
- Future: instantiate `Agent` from approved `AgentTemplate`.
- Future: promote a verified tool artifact into a versioned tool or
  template catalog.
- Future: quarantine/freeze a template by writing the same CRD field or
  annotation the CLI/GitOps path would write.

Forbidden action classes:

- Direct pod exec/log terminal.
- Arbitrary YAML editor.
- Prompt playground that bypasses `AgentTask`.
- UI-only tool grants.
- UI-only agent definitions.
- Hidden retries that do not create or annotate an `AgentTask`.

## 5. Tool-foundry loop

The idea "agents build tools that other agents can use" is valid only
as a promotion pipeline, not as prompt-side self-granting.

Proposed substrate flow:

1. An Agent produces a candidate tool as an artifact or workspace output.
2. The candidate is visible in Command Center as "under construction".
3. A verifier task runs tests, static checks, egress review, and contract
   checks against the candidate.
4. Human approval or a policy gate promotes the candidate into a
   versioned tool/template catalog object.
5. Capability policy decides which Agents may use the promoted tool.
6. Future AgentTasks mount or invoke the tool only when their signed
   capability bundle allows it.
7. Command Center renders the promotion as a tech unlock.

Minimum viable implementation:

- Represent candidate output as an `ArtifactRef`.
- Add a read-only "Tool Foundry" panel that lists candidate artifacts
  with producer task, verifier status, and promotion status.
- Add no new write path until the promotion target object is designed.

Promotion target options to evaluate:

- `AgentTemplate` extension: good when the "tool" is really a specialist
  Agent pattern.
- New `Tool` CRD: good when the tool has version, runtime, egress,
  input schema, and tests.
- Artifact-backed built-in tool registry: good as an interim local path,
  but weaker for enterprise policy.

Recommendation: do not add a `Tool` CRD until one real promoted tool
needs it. Start with artifact + verifier + AgentTemplate.

## 6. Enemies and pressure systems

The cleanest "enemy" model is not hostile game units. It is substrate
pressure made visible. That keeps the UI useful while still giving the
RTS layer tension.

Candidate pressure types:

| Pressure | Real signal | Visual treatment | Operator action |
|---|---|---|---|
| Context pressure | `get_my_context` utilization, `context_pressure_ignored`, pre-call refusal | Amber/red aura around task lane or Agent building | Inspect prompt/tool strategy, delegate/split task |
| Gateway saturation | ModelEndpoint in-flight near cap, 429s, Retry-After | Resource bar flashes, HQ belt slows | Patch cap, route model class, wait |
| Policy denial | capability violation, spawn/tool/egress denial | Shield impact on attempted route | Inspect capability claims and Agent policy |
| Verifier failure | `status.verification.passed=false` | Failed construction scaffold | Open verifier evidence, retry with corrected input |
| Artifact debt | required output missing, artifact write failure | Production building stalled | Inspect artifact backend/status |
| Trace gap | no trace link/run id for terminal task | Darkened evidence beacon | Inspect OTel/Langfuse config |
| Pod failure | image pull, unschedulable, deadline, container exit | Structure damage state | Open detail/pod summary |
| Quota wall | tenant/agent compute, storage, gateway quota exceeded | Supply blocked marker | Adjust quota or reduce fanout |
| Stale telemetry | SSE heartbeat/cache stale | Fog overlay over world | Check Workbench API/operator health |

Avoid enemies that imply adversarial security events unless the substrate
has real audit/security signals. A "breach" visual must map to a
specific policy or identity event, not a vibe.

Base-building-only fallback:

If enemy language feels too gimmicky, keep the entire mode constructive:
buildings, queues, tech unlocks, production chains, resource pressure,
and construction failures. The tension comes from throughput and
reliability, not combat. This is the safer enterprise default.

Recommendation:

- Default product language: base building and operations.
- Optional visual theme language: incidents and pressure fronts.
- Avoid labeling failures as "enemy attacks" in visible UI copy.

## 7. Implementation slate

### Slice A - Contract hardening

Goal: make the current Command view provably source-bound.

Tasks:

- Add a small `docs/COMMAND-CENTER-CONTRACT.md` link from
  `docs/WORKBENCH.md`.
- Add fixture-based tests for the Command snapshot mapper/layout:
  Agents, tasks, gateway rows in; expected nodes, lanes, and counters
  out.
- Add a development-only assertion that every rendered Agent node has a
  backing `AgentSummaryRow` and every rendered task sprite has a backing
  `TaskSummary`.
- Keep transient FX keyed by substrate event ids or task phase
  transitions.

Acceptance:

- Reloading `/#/command` reconstructs the same world from API state.
- No world object survives if removed from the snapshot.
- Presentation-only state is limited to camera, selection, hover,
  audio, bookmarks, and short-lived FX.

### Slice B - Operational read depth

Goal: every click answers "what object is this?"

Tasks:

- Agent selection panel shows tools, capabilities, model/modelClass,
  namespace, active task count, failure count.
- Task selection panel shows phase, timestamps, suspicious tags,
  verifier, trace link, artifact count, parent/child counters.
- Gateway selection shows capacity rows, in-flight cap, recent usage,
  and ModelEndpoint identity when available.
- Add direct links to existing TaskDetail, GatewayPage, ClusterPage.

Acceptance:

- Any sprite/building can be traced back to a Workbench API object.
- Incident visuals always have a detail target.

### Slice C - Construction mode, read-safe first

Goal: make "build" vocabulary visible before adding broad write power.

Tasks:

- Render AgentTemplates as unbuilt blueprint pads when the API exposes
  them.
- Render artifact-producing tasks as production chains.
- Render verifier pass/fail as construction complete/blocked.
- Do not create Agent CRs from canvas yet unless forward-auth and write
  RBAC are explicitly enabled.

Acceptance:

- A read-only deployment shows construction semantics with no write RBAC.
- Write affordances hide when `actions.create=false` or auth is absent.

### Slice D - Tool Foundry prototype

Goal: prototype agent-produced tools without self-granting authority.

Tasks:

- Define a UI-only grouping over existing artifacts:
  "candidate-tool" artifacts by media type, label, or verifier contract.
- Add a Tool Foundry panel listing candidate artifacts and verifier
  status.
- Add no promotion mutation until the target object is selected.
- Document the promotion target decision: AgentTemplate extension vs
  future Tool CRD.

Acceptance:

- Agents can produce visible candidate tools.
- No other Agent can use a candidate tool unless the substrate already
  grants it.

### Slice E - Pressure system overlay

Goal: make failures and constraints legible without fictional state.

Tasks:

- Implement a pressure classifier over existing DTO fields:
  context, gateway, policy, verifier, artifact, trace, pod, quota,
  telemetry.
- Add subtle visual states for each pressure type.
- Add a filter that shows only pressure-bearing objects.
- Add a legend in developer docs, not in the main UI chrome.

Acceptance:

- Every pressure marker has a source field and a detail link.
- The UI can run in "base-building-only" mode by disabling pressure
  dramatization while keeping the same data.

## 8. Open decisions

1. Should Command Center become the default Workbench landing page after
   Tier-1 pan/zoom/minimap stabilizes, or remain an alternate view?
2. Should "construction mode" create only `AgentTask`s at first, or also
   instantiate `AgentTemplate`s?
3. Should promoted tools become `AgentTemplate`s, a new `Tool` CRD, or a
   catalog backed by artifacts plus verifier contracts?
4. Should agent-sandbox integration change the world model from Job-based
   tasks to Sandbox/SandboxClaim-backed structures?
5. Should pressure visuals be always-on, or gated behind an "Ops mode"
   toggle?

## 9. Non-goals

- No separate game simulation.
- No UI-only capability grants.
- No combat objective unrelated to substrate health.
- No arbitrary workflow/DAG builder.
- No hidden retry scheduler.
- No prompt/chat surface that bypasses `AgentTask`.
- No dark/cyberpunk visual reset. Follow `docs/IMAGE-ASSETS.md`.

## 10. Guidance for the next implementation agent

Start with Slice A and Slice B. Do not add new CRDs for the RTS layer.
Do not add enemies first. Make the current world truthful, inspectable,
and reload-stable. Once the read model is contractual, the fun parts can
carry their weight.
