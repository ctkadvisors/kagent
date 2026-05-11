# Requirements: kagent (v0.2 — workflow-substrate hardening + observation-first experiments)

**Defined:** 2026-05-09
**Re-steered:** 2026-05-09 PM (north stars → candidate inputs; proto-society → future research; CRD-first phases removed; AgentDisposition → overlay-first prototype)
**Core Value:** The substrate turns intent into verified reusable capability under bounded resources, observable state, and revocable authority. **Signals propose; governance disposes.** Agents may propose; substrate or human governance promotes; no agent self-escalates authority.

> **Source provenance.** No PRDs were ingested. The two ingested SPEC-tagged design north stars (`docs/NORTH-STAR-SYSTEM-DESIGN.md`, `docs/PROTO-SOCIETY-DESIGN.md`) are treated as **candidate inputs**, not commitments. `docs/COMMAND-CENTER-CONTRACT.md` is a **binding implementation contract** for any Workbench/Command Center work in this milestone (see PROJECT.md "Concrete Implementation Contracts").

> **Mandatory gates per requirement.** Every Candidate Requirement below must, on completion, satisfy:
>
> - **§11 bounds test (`C-bounds`)** — declared capability + bounded resource drain + observable state transition + auditable output + revocation path
> - **§15 one-sentence test (workflow form)** — helps the substrate turn intent into verified reusable capability with clearer authority, resource accounting, observability, review, or revocation
> - **For Workbench/Command Center work:** `COMMAND-CENTER-CONTRACT.md` Prime Directive — every visible object/action/animation maps back to a substrate source

> **Output structure.** Per the 2026-05-09 PM re-steering, this document is organized into:
>
> 1. **Candidate Requirements** (active milestone scope; unlocked, proposed)
> 2. **Proposed Decisions** (referenced; full text in PROJECT.md)
> 3. **Explicit Non-Goals** (locked exclusions)
> 4. **Future Research / Speculative Concepts** (deferred until empirical signal)
> 5. **Concrete Implementation Contracts** (binding for in-scope surfaces)

## 1. Candidate Requirements (v0.2 milestone scope)

Each candidate requirement maps to exactly one phase in `ROADMAP.md`. All status: **proposed (unlocked)**. Promotion to a locked requirement requires explicit operator acceptance via PRD/ADR.

### AgentDisposition prototype (overlay-first, no CRD) — DISP

The smallest first move per the **corrected** posture: prototype idle/attention behavior on existing substrate primitives; observe; promote to field or CRD only after observed repeated behavior justifies. The proto-society `C-agent-disposition` schema sketch is recorded as **future-research target shape**, not v0.2 commitment.

- [ ] **DISP-01** _(candidate)_: Operator can express idle/attention behavior for an existing `Agent` as an **overlay** on the existing substrate — annotation on the `Agent` CR, a sibling `ConfigMap` referenced by `agentRef`, or an `ArtifactRef`-shaped record carried alongside the Agent. The chosen overlay form must be representable today using shipped v0.1 primitives (no new CRD, no new reconciler). Fields covered: `idleBehavior.readChannels[]` (where to read), `idleBehavior.attentionBudget.{tokensPerDay, pollIntervalSeconds}` (bounded drain), `idleBehavior.proposalScope.{mayProposeAgainst[], maxProposalsPerDay}` (bounded action). A schema-validation Job rejects overlays missing any of these fields.
- [ ] **DISP-02** _(candidate)_: The overlay's `proposalScope.mayProposeAgainst` is enforced **at the existing capability-JWT scope check**, not via a new admission webhook. Proposal-issuance paths in workbench-api / operator already check capability scope; the overlay narrows the scope at issuance time. A unit test proves an overlay declaring `proposalScope.mayProposeAgainst: [templates]` causes the existing capability-JWT scope check to reject a tool-change or capability-policy proposal with a typed audit event tied back to the overlay. (No self-promotion: the overlay narrows, never widens, the JWT scope.)
- [ ] **DISP-03** _(candidate)_: Disposition counters (`spentTokensToday`, `postsToday`, `proposalsToday`) are surfaced as a **read projection** in workbench-api derived from existing telemetry (token usage from gateway DTOs, proposal counts from existing audit-event stream). Counters reset at a documented daily boundary. Over-budget conditions emit substrate audit events with structured reasons via the existing audit-event surface. **No new persistence primitive** — the projection is computed.
- [ ] **DISP-04** _(candidate)_: Workbench Command Center renders a "disposition" overlay alongside existing flow-economy flows (`C-flow-economy`: model power, token, build power, etc.). The overlay obeys `COMMAND-CENTER-CONTRACT.md` Prime Directive — every rendered field has a backing substrate source field; no UI-only state. Overlay shows budget remaining and over-budget event count per agent. Reload-stable: closing and reopening Command Center reconstructs the overlay from API state.

**Promotion gate (post-phase observation).** Within ~7 days of pilot operation under DISP-01..04, capture which fields are read often, which are written often, which are silently ignored, and whether overlay collisions occur. If repeated behavior across ≥2 agents demands it, file a Future Research → Candidate Requirement promotion for `AgentDisposition` as a CRD field on `Agent` or as a sibling CRD. Until then: overlay-only.

### Command Center contract hardening — CC

Per `docs/COMMAND-CENTER-CONTRACT.md` §7 "Slice A — Contract hardening" and §7 "Slice B — Operational read depth". This is the _implementation_ work that makes the existing Command Center provably source-bound.

- [ ] **CC-01** _(candidate)_: A development-only assertion fires when any rendered Agent node lacks a backing `AgentSummaryRow` from `/api/agents`, or any rendered task sprite lacks a backing `TaskSummary` from `/api/tasks`. Triggers in dev builds, no-ops in prod. Fixture-based test asserts the assertion fires for synthesized orphan nodes.
- [ ] **CC-02** _(candidate)_: Reloading `/#/command` reconstructs the same world from API state. Presentation-only state (camera, selection, hover, audio, bookmarks, short-lived FX) is the **only** state that survives or is lost across reload; all world-object state derives from API responses. Vitest snapshot test seeded with a captured API response asserts the rendered DOM tree matches across reloads.
- [ ] **CC-03** _(candidate)_: Agent / Task / Gateway selection panels show operational read depth per Slice B: tools, capabilities, model/modelClass, namespace, active task count, failure count (Agent); phase, timestamps, suspicious tags, verifier, trace link, artifact count, parent/child counters (Task); capacity rows, in-flight cap, recent usage, ModelEndpoint identity (Gateway). Direct links exist to the existing TaskDetail, GatewayPage, ClusterPage routes.
- [ ] **CC-04** _(candidate)_: Pressure overlay (`COMMAND-CENTER-CONTRACT.md` §6 + Slice E) renders pressure types from existing DTO fields: context pressure, gateway saturation, policy denial, verifier failure, artifact debt, trace gap, pod failure, quota wall, stale telemetry. Each pressure marker carries the source field name and a detail link. UI can run in "base-building-only" mode with pressure dramatization disabled while keeping the same data.

### Resource-flow overlays — FLOW

Per `C-flow-economy` and `COMMAND-CENTER-CONTRACT.md` §3 source-of-truth map. Make the eight flow types visible as ongoing overlays sourced from existing Workbench API DTOs. No new CRDs; no new persistence.

- [ ] **FLOW-01** _(candidate)_: Each of the eight `C-flow-economy` flows (model power, token flow, build power, pod capacity, artifact bandwidth, authority, trust, attention) is rendered as a Command Center overlay with a documented source field and pressure trigger from existing DTOs. A test fixture asserts each flow has a non-null source field reference.
- [ ] **FLOW-02** _(candidate)_: A "flow legend" exists in developer docs (NOT in main UI chrome per `COMMAND-CENTER-CONTRACT.md` Slice E acceptance) mapping each flow to its substrate source, pressure trigger, and operator action. Living doc updated as flows evolve.

### Review / consolidation / promotion over existing state — REV

Tighten the existing review queue, AgentTemplate promotion path, and replay/eval signal surfacing using the v0.1 substrate primitives — `AgentTask`, `ArtifactRef`, verifier outputs, audit events. **No `Tool`, `SteeringEvent`, `TaskReview`, `Channel`, or `Post` CRD.**

- [ ] **REV-01** _(candidate)_: A review queue projection in workbench-api lists every terminal `AgentTask` whose result needs review (verifier failed, suspicious detector flagged, or human-review-requested) sorted by staleness (oldest first). The queue is computed from existing `AgentTask.status` + verifier results + audit events; no new persistence. Reload-stable.
- [ ] **REV-02** _(candidate)_: AgentTemplate promotion proposal flow exists end-to-end: a candidate `AgentTemplate` (artifact-shape today) is reviewable in the queue, accept/reject decisions are recorded as audit events tied back to the candidate, and an accepted candidate becomes a versioned `AgentTemplate` CR via the existing operator-write path. Single-reviewer path covered; multi-reviewer is future research.
- [ ] **REV-03** _(candidate)_: Replay / eval signals (existing v0.1 controllers) surface their outputs into the review queue projection: a failed eval or a replay divergence becomes a row in the queue with the same shape as a verifier failure. Reviewer can navigate from queue row to the underlying eval/replay artifact.

### Workbench usability hardening — WB

Carry forward `feedback_workbench_rts_ui_aesthetic.md`: RTS feel = USABILITY, not visual chrome. Every WB candidate is a usability primitive (hotkey, multi-select, dispatch, replay, audit-trace shortcut, FX), not a reskin.

- [x] **WB-01** _(candidate)_: Hotkey scheme for the most-used Workbench operations (open task detail, open agent detail, navigate to gateway, open trace, dismiss alert, jump to review queue). Documented in a developer-facing keyboard cheat sheet. Hotkeys map to existing actions; no new substrate state.
- [x] **WB-02** _(candidate)_: Multi-select on Command Center sprites (Agents, tasks, gateways) for bulk-inspect actions (open all selected detail views in tabs, copy IDs, scroll to first failure). Bulk-mutate actions remain forbidden until the underlying CRD write path explicitly supports the operation.
- [x] **WB-03** _(candidate)_: Replay-from-context surface: from any task detail, an operator can re-dispatch the same input under a different model class or a different agent, creating a new `AgentTask` with a recorded `replayOf` annotation pointing to the original. No new CRD; uses existing AgentTask write path.

### Coverage

| Candidate | Phase   | Status   |
| --------- | ------- | -------- |
| DISP-01   | Phase 1 | Pending  |
| DISP-02   | Phase 1 | Pending  |
| DISP-03   | Phase 1 | Pending  |
| DISP-04   | Phase 1 | Pending  |
| CC-01     | Phase 2 | Pending  |
| CC-02     | Phase 2 | Pending  |
| CC-03     | Phase 2 | Pending  |
| CC-04     | Phase 2 | Pending  |
| FLOW-01   | Phase 3 | Pending  |
| FLOW-02   | Phase 3 | Pending  |
| REV-01    | Phase 4 | Pending  |
| REV-02    | Phase 4 | Pending  |
| REV-03    | Phase 4 | Pending  |
| WB-01     | Phase 5 | Complete |
| WB-02     | Phase 5 | Complete |
| WB-03     | Phase 5 | Complete |

**Coverage:**

- v0.2 candidate requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0 ✓

## 2. Proposed Decisions

Full text in `.planning/PROJECT.md` "Key Decisions". Summary referenced from candidate requirements:

- **D1** Substrate ships substrate primitives only (no SDK / gateway / trace store / K8s-mgmt agent / DAG engine)
- **D2** Defer CRDs until repeated behavior justifies one — applies to **AgentDisposition itself** in v0.2
- **D3** Signals propose; governance disposes
- **D4** Substrate-level revocation is non-negotiable _if_ a proto-society layer is ever deployed (the layer is future research; the principle remains binding)
- **D5** Workflow north star is foundational; proto-society lives on top — proto-society is opt-in AND future research
- **D6** Self-proposal, not self-promotion (re-steering correction)
- **D7** `docs/COMMAND-CENTER-CONTRACT.md` is binding for Workbench/Command Center work

## 3. Explicit Non-Goals (v0.2)

Documented to prevent scope creep. **Locked.**

| Non-Goal                                                     | Reason                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `AgentDisposition` as a CRD                                  | Per D2, prototype as overlay first. The proto-society source schema is a future-research target.       |
| `Channel` / `Post` CRDs                                      | Defer until read-side proves out (future research).                                                    |
| `CoalitionProposal` CRD (renamed from "MobProposal")         | Defer until coalition action is real (future research).                                                |
| Consolidation controller                                     | Defer until manual review queue ergonomics prove what hygiene means (future research).                 |
| Decay / revalidation policy as schema metadata               | Defer until a real catalog object ages badly (future research).                                        |
| Quarantine semantics as first-class state                    | Defer until at least one real object needs to be quarantined (future research).                        |
| Substrate-level proto-society kill-switch implementation     | The layer being killed is future research; principle remains binding for any deployment of that layer. |
| UI for the discourse layer                                   | Source spec defers until empirical signal (future research).                                           |
| Specific reputation algorithm                                | Premature optimization without pilot signal (future research).                                         |
| Specific voting rule for CoalitionProposal                   | Premature optimization (future research).                                                              |
| Specific agent personality / persona                         | Application-layer concern; substrate hosts whatever operator seeds.                                    |
| AGI speculation                                              | Out of scope; focus on what's actionable under bounded resources.                                      |
| Agent SDK                                                    | v0.1 non-goal; carried forward (D1).                                                                   |
| LLM gateway implementation                                   | LiteLLM Proxy is the dependency, not a deliverable (D1).                                               |
| Trace store implementation                                   | Langfuse is the dependency, not a deliverable (D1).                                                    |
| K8s-management agent                                         | Different problem domain (`kagent.dev`, Solo.io) (D1).                                                 |
| Workflow / DAG / Swarm engine                                | A2A is messaging-primitive level only (D1).                                                            |
| `Tool` CRD                                                   | D2 — defer until usage justifies (future research).                                                    |
| `SteeringEvent` CRD                                          | D2 — annotations + existing API actions sufficient until proven otherwise (future research).           |
| `TaskReview` CRD                                             | D2 — review queue projection over existing state covers v0.2; CRD is future research.                  |
| Imperative `kubectl apply/exec/port-forward` against homelab | GitOps only; verification ships as Job manifests.                                                      |
| Continuous biographical memory per individual agent          | Agents are session-scoped; the society persists, not the agent (acknowledged from intel/context.md).   |
| Workbench painted/sprite-skinned chrome                      | Per memory: RTS feel = usability primitives, not visual reskin.                                        |
| UI-only world state in Command Center                        | `COMMAND-CENTER-CONTRACT.md` Prime Directive forbids it.                                               |

## 4. Future Research / Speculative Concepts

Surfaced by the ingested north stars and operator vision. **Unlocked, deferred.** Promotion to Candidate Requirement requires empirical signal AND explicit acceptance.

### Proto-society primitives (from `docs/PROTO-SOCIETY-DESIGN.md`)

- `AgentDisposition` as a first-class CRD — promote post-Phase 1 if overlay-prototype observation justifies. Source schema sketch: `C-agent-disposition`.
- `Channel` and `Post` as first-class CRDs — promote post-pilot if read-side proves out. Source schema sketch: `C-discourse-primitives`.
- `CoalitionProposal` (renamed from "MobProposal") — coalition action with signed quorum, no-self-review, ring-review detection. Source schema sketch: `C-mob-proposal` (in intel; the ID is preserved as a source-quote artifact, but the synthesized name is `CoalitionProposal`).
- Consolidation controller — read-only daemon that proposes hygiene actions to the existing review queue. Source: `C-consolidation`.
- Decay / revalidation policy — per-class staleness function + revalidationPolicy. Source: `C-decay`.
- Quarantine semantics — first-class holding pattern with bounded TTL and explicit exit paths. Source: `C-quarantine`.
- Substrate-level proto-society revocation kill-switch — non-negotiable IF the layer ships. Source: `C-failure-modes` row 8 + `D4`.
- Pilot deployment of proto-society layer (1–2 agents, one channel, small budget, observe) — only after primitives exist.
- Reputation algorithm (PageRank-like / upvote / citation-weighted / hybrid) — pick after pilot signal.
- Voting rules for CoalitionProposal (simple quorum / weighted / liquid democracy) — pick after coalitions are real.
- Reputation-capture defenses: ground-truth eval scaffolding external to society's own signals.
- Adversarial trust: provenance chains, signed runtime attestation, signed proposals with full chain-of-custody.

### Long-term workflow-substrate decisions (from `docs/NORTH-STAR-SYSTEM-DESIGN.md`)

- Whether promoted tools require a `Tool` CRD (vs artifact + verifier + AgentTemplate). Recommendation in `COMMAND-CENTER-CONTRACT.md` §5: do not add until one real promoted tool needs it.
- Whether steering/review require first-class CRDs (vs annotations + actions).
- Whether agent-sandbox replaces Kata Containers as the isolation backend.
- How physical hardware appears as resource producers and tool-bearing structures.
- Multi-tenant cognitive subsystem boundaries with cross-tenant capability portability.

### Operator-flagged

- HYBRID-AGENT-POLICY.md ingestion — referenced by both north stars. If/when per-agent reactive+deliberative policy details become load-bearing for an active phase, run `/gsd-ingest-docs`.
- Tool Foundry promotion target choice (AgentTemplate extension vs `Tool` CRD vs artifact-backed registry) — per `COMMAND-CENTER-CONTRACT.md` §5 and §8 open decision 3.
- Whether Command Center becomes the default Workbench landing page (`COMMAND-CENTER-CONTRACT.md` §8 open decision 1).
- Whether construction mode creates only `AgentTask`s at first or also instantiates `AgentTemplate`s (`COMMAND-CENTER-CONTRACT.md` §8 open decision 2).

## 5. Concrete Implementation Contracts

| Surface                    | Contract                          | Status for v0.2                                                                                                                                                                                                 |
| -------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workbench / Command Center | `docs/COMMAND-CENTER-CONTRACT.md` | **Binding.** All CC-_, FLOW-_, WB-\* candidates verify against the contract's Prime Directive, Source-of-Truth Map (§3), Action Contract (§4), Pressure Systems (§6), and Slice A/B/E acceptance criteria (§7). |
| Image / asset generation   | `docs/IMAGE-ASSETS.md`            | Pipeline guidance; no v0.2 visual lock.                                                                                                                                                                         |
| Tech / runtime / repo      | `CLAUDE.md` (root)                | Authoritative for stack, runtime, GitOps posture.                                                                                                                                                               |

---

_Requirements re-steered: 2026-05-09 PM. Original CRD-first DISP/DISC/CONS/MOB/DECAY/QUAR/REVOKE/PILOT requirements are recorded in `intel/requirements.md` as candidate inputs for future research. Synthesized outputs use `CoalitionProposal` (not "MobProposal") and "self-proposal" (not "self-promotion")._
_Last updated: 2026-05-09 PM after re-steering directive._
