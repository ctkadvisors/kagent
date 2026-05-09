# Roadmap: kagent — v0.2 (workflow-substrate hardening + observation-first experiments)

## Overview

The v0.1 workflow substrate is shipped: operator + CRDs, NATS A2A bus, agent-pod runtime, capability-JWT, LiteLLM gateway, Langfuse traces, replay/eval/supervision/quotas controllers, workbench API + UI. Historical v0.1 phases are captured in `docs/ROADMAP.md`.

**Re-steered 2026-05-09 PM.** This roadmap is forward-looking and **observation-first**: v0.2 hardens what's already real (Workbench, Command Center, review/promotion paths over existing substrate state) and runs minimum-viable observation experiments (idle/attention overlays on existing Agents) before any new CRD or controller is introduced. Proto-society primitives (CRD-shaped Channels, Posts, CoalitionProposals, reputation, society kill-switch) are recorded in REQUIREMENTS.md §4 "Future Research" and intentionally **not** in this roadmap.

Every phase must answer the §11 bounds test affirmatively (declared capability + bounded resource drain + observable state transition + auditable output + revocation path) and the §15 one-sentence test (helps the substrate turn intent into verified reusable capability with clearer authority, resource accounting, observability, review, or revocation). Workbench/Command Center work additionally honors the `docs/COMMAND-CENTER-CONTRACT.md` Prime Directive.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)
- 999.x: Future-research backlog placeholders (see REQUIREMENTS.md §4)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: AgentDisposition prototype (overlay-first)** — express idle/attention behavior as overlay on existing `Agent`; surface in workbench-api as a read projection; render in Command Center as overlay; observe before promoting to a CRD
- [ ] **Phase 2: Command Center contract hardening** — make existing Command Center provably source-bound (Slice A) and add operational read depth on selection panels (Slice B) per `docs/COMMAND-CENTER-CONTRACT.md`
- [ ] **Phase 3: Resource-flow overlays** — render `C-flow-economy` flows from existing Workbench API DTOs; pressure overlay (Slice E); base-building-only fallback mode
- [ ] **Phase 4: Review queue projection + promotion path** — strengthen review queue, AgentTemplate promotion, replay/eval signal surfacing using existing v0.1 substrate primitives; no new CRDs
- [ ] **Phase 5: Workbench usability primitives** — hotkeys, multi-select, replay-from-context; RTS feel as usability, not visual chrome

## Phase Details

### Phase 1: AgentDisposition prototype (overlay-first, no CRD)

**Goal**: Idle agent behavior becomes representable on the existing substrate **without introducing a new CRD or reconciler**. An overlay (annotation, ConfigMap, or artifact record) on an existing `Agent` declares idle behavior, attention budget, and proposal scope. Workbench-api exposes a read projection. Command Center shows the overlay. Observability uses existing telemetry. The phase deliberately produces evidence to decide whether to promote to a field on `Agent` or to a sibling CRD in a future milestone.
**Depends on**: Nothing (first v0.2 phase; layers on shipped v0.1 substrate).
**Requirements**: DISP-01, DISP-02, DISP-03, DISP-04
**Success Criteria** (what must be TRUE):

1. Operator can attach an idle-behavior overlay to an existing `Agent` using ONLY shipped v0.1 primitives (annotation, ConfigMap referenced by `agentRef`, or artifact record). The overlay carries `idleBehavior.readChannels[]`, `idleBehavior.attentionBudget.{tokensPerDay, pollIntervalSeconds}`, `idleBehavior.proposalScope.{mayProposeAgainst[], maxProposalsPerDay}`. A schema-validation Job rejects overlays missing any required field.
2. The overlay's `proposalScope.mayProposeAgainst` narrows the existing capability-JWT scope **at issuance time** in the existing capability-JWT scope check — it never widens it. A unit test proves an overlay declaring `proposalScope.mayProposeAgainst: [templates]` causes the existing capability-JWT scope check to reject a tool-change or capability-policy proposal with a typed audit event tied back to the overlay (self-proposal, never self-promotion).
3. Workbench-api exposes `/dispositions` (or equivalent overlay projection endpoint) computed from existing telemetry — gateway DTOs for token usage, audit-event stream for proposal counts. Counters reset at a documented daily boundary. Over-budget conditions emit substrate audit events with structured reasons via the existing audit-event surface. **No new persistence primitive is introduced.**
4. Command Center renders a "disposition" overlay alongside existing flow-economy flows. Every rendered field has a backing substrate source field (per `COMMAND-CENTER-CONTRACT.md` Prime Directive). Overlay shows budget remaining and over-budget event count per agent. Reload-stable: closing and reopening Command Center reconstructs the overlay from API state.

**Promotion gate (post-phase observation):** within ~7 days of overlay use across ≥2 agents, capture which fields are read often, which are written often, which are silently ignored, and whether overlay collisions occur. If repeated behavior justifies it, file a Future Research → Candidate Requirement promotion for `AgentDisposition` as a CRD field on `Agent` or as a sibling CRD. Until then: overlay-only.

**Plans**: 4 plans
**UI hint**: yes (Workbench/Command Center work — `COMMAND-CENTER-CONTRACT.md` is binding)

Plans:

- [x] 01-01-PLAN.md — Wave 0 setup (audit events, RBAC, PROPOSAL_TOOL_MAP, vitest, fixtures) + DISP-01 ConfigMap overlay carrier + schema-validation Job
- [ ] 01-02-PLAN.md — DISP-02 capability-JWT scope narrowing in cap-issuer (narrows-never-widens; typed audit on rejection)
- [ ] 01-03-PLAN.md — DISP-03 workbench-api /api/dispositions projection + over-budget exactly-once-per-day audit emission
- [ ] 01-04-PLAN.md — DISP-04 Command Center DispositionOverlay + CC-01 source-binding (disposition slice) + reload-stability + base-building-only mode

### Phase 2: Command Center contract hardening

**Goal**: Make the existing Command Center provably source-bound. Implements Slice A (contract hardening) and Slice B (operational read depth) from `docs/COMMAND-CENTER-CONTRACT.md` §7. Read-depth precedes write-depth.
**Depends on**: Phase 1 (the disposition overlay rides on Slice A's source-of-truth assertions).
**Requirements**: CC-01, CC-02, CC-03, CC-04
**Success Criteria** (what must be TRUE):

1. A development-only assertion fires when any rendered Agent node lacks a backing `AgentSummaryRow` from `/api/agents`, or any rendered task sprite lacks a backing `TaskSummary` from `/api/tasks`. Triggers in dev builds, no-ops in prod. Fixture-based test asserts the assertion fires for synthesized orphan nodes.
2. Reloading `/#/command` reconstructs the same world from API state. Presentation-only state is restricted to camera, selection, hover, audio, bookmarks, and short-lived FX; all other state derives from API responses. Snapshot test seeded with a captured API response asserts rendered DOM tree matches across reloads.
3. Agent / Task / Gateway selection panels show full operational read depth per `COMMAND-CENTER-CONTRACT.md` §7 Slice B. Direct links exist to existing TaskDetail, GatewayPage, ClusterPage routes.
4. Pressure overlay renders all nine pressure types from existing DTO fields (context, gateway, policy denial, verifier, artifact, trace, pod, quota, telemetry). Each marker carries source field name + detail link. UI runs in "base-building-only" mode with pressure dramatization disabled while keeping the same data.

**Plans**: TBD
**UI hint**: yes (`COMMAND-CENTER-CONTRACT.md` is binding)

### Phase 3: Resource-flow overlays

**Goal**: Make the eight `C-flow-economy` flows visible in Command Center as overlays sourced from existing Workbench API DTOs. Continues Slice E "Pressure system overlay" from `docs/COMMAND-CENTER-CONTRACT.md` §7.
**Depends on**: Phase 2 (Command Center read-depth + pressure overlay foundation).
**Requirements**: FLOW-01, FLOW-02
**Success Criteria** (what must be TRUE):

1. Each of the eight `C-flow-economy` flows (model power, token flow, build power, pod capacity, artifact bandwidth, authority, trust, attention) renders as a Command Center overlay with a documented source field and pressure trigger from existing DTOs. A test fixture asserts each flow has a non-null source field reference; a missing source field fails the test.
2. A "flow legend" exists in developer docs (NOT in main UI chrome per `COMMAND-CENTER-CONTRACT.md` Slice E acceptance) mapping each flow to its substrate source, pressure trigger, and operator action. Living doc updated as flows evolve.

**Plans**: TBD
**UI hint**: yes (`COMMAND-CENTER-CONTRACT.md` is binding)

### Phase 4: Review queue projection + promotion path

**Goal**: Strengthen review queue ergonomics, AgentTemplate promotion, and replay/eval signal surfacing using existing v0.1 substrate primitives — `AgentTask`, `ArtifactRef`, verifier outputs, audit events. **No `Tool`, `SteeringEvent`, `TaskReview`, `Channel`, or `Post` CRD.**
**Depends on**: Nothing structurally; benefits from Phase 2's Command Center read depth (review queue is reachable from Command Center).
**Requirements**: REV-01, REV-02, REV-03
**Success Criteria** (what must be TRUE):

1. Review queue projection in workbench-api lists every terminal `AgentTask` whose result needs review (verifier failed, suspicious detector flagged, or human-review-requested) sorted by staleness. Computed from existing `AgentTask.status` + verifier results + audit events; no new persistence. Reload-stable.
2. AgentTemplate promotion proposal flow exists end-to-end: a candidate `AgentTemplate` (artifact-shape today) is reviewable in the queue; accept/reject decisions are recorded as audit events tied back to the candidate; an accepted candidate becomes a versioned `AgentTemplate` CR via the existing operator-write path. Single-reviewer covered; multi-reviewer is future research.
3. Replay / eval signals (existing v0.1 controllers) surface their outputs into the review queue projection — a failed eval or replay divergence becomes a queue row with the same shape as a verifier failure. Reviewer can navigate from queue row to underlying eval/replay artifact.

**Plans**: TBD

### Phase 5: Workbench usability primitives

**Goal**: Add usability primitives that make the operator's daily workflow less friction-bound. RTS feel here is **usability** — hotkeys, multi-select, dispatch, replay, audit-trace shortcut, FX — NOT visual chrome (per memory `feedback_workbench_rts_ui_aesthetic.md`).
**Depends on**: Phase 2 (Command Center read-depth foundation).
**Requirements**: WB-01, WB-02, WB-03
**Success Criteria** (what must be TRUE):

1. Hotkey scheme covers the most-used Workbench operations (open task detail, open agent detail, navigate to gateway, open trace, dismiss alert, jump to review queue). Documented in a developer-facing keyboard cheat sheet. Hotkeys map to existing actions; no new substrate state.
2. Multi-select on Command Center sprites for bulk-inspect actions (open all selected detail views in tabs, copy IDs, scroll to first failure). Bulk-mutate actions remain forbidden until the underlying CRD write path explicitly supports the operation.
3. Replay-from-context: from any task detail, an operator can re-dispatch the same input under a different model class or a different agent, creating a new `AgentTask` with a recorded `replayOf` annotation pointing to the original. No new CRD; uses existing AgentTask write path.

**Plans**: TBD
**UI hint**: yes (`COMMAND-CENTER-CONTRACT.md` is binding)

## Future Research Backlog (999.x — NOT in v0.2)

Recorded so they don't get re-invented. Promotion to active phase requires empirical signal AND explicit operator acceptance. See REQUIREMENTS.md §4 "Future Research / Speculative Concepts".

- [ ] **Phase 999.1** (future research): `AgentDisposition` as a first-class CRD — pending Phase 1 observation evidence
- [ ] **Phase 999.2** (future research): `Channel` / `Post` as artifacts (then later as CRDs) — defer until read-side proves out
- [ ] **Phase 999.3** (future research): Consolidation controller — defer until manual review queue ergonomics prove what hygiene means
- [ ] **Phase 999.4** (future research): `CoalitionProposal` (renamed from "MobProposal") with signed quorum, no-self-review, ring-review detection
- [ ] **Phase 999.5** (future research): Decay / revalidation policy on catalog object kinds
- [ ] **Phase 999.6** (future research): Quarantine semantics as first-class state
- [ ] **Phase 999.7** (future research): Substrate-level proto-society revocation kill-switch — non-negotiable IF the layer ships
- [ ] **Phase 999.8** (future research): Pilot deployment of proto-society layer (1–2 agents, one channel, small budget, 7+ days observation)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase                                         | Plans Complete | Status      | Completed |
| --------------------------------------------- | -------------- | ----------- | --------- |
| 1. AgentDisposition prototype (overlay-first) | 0/4            | Not started | -         |
| 2. Command Center contract hardening          | 0/TBD          | Not started | -         |
| 3. Resource-flow overlays                     | 0/TBD          | Not started | -         |
| 4. Review queue projection + promotion path   | 0/TBD          | Not started | -         |
| 5. Workbench usability primitives             | 0/TBD          | Not started | -         |
| 999.x Future Research backlog                 | —              | Deferred    | -         |

## Notes

- **Forward-looking only.** Historical v0.1 phases (Phase 0 scope/docs through Phase 5.x agent self-service) are captured in `docs/ROADMAP.md` and not duplicated here.
- **Re-steering 2026-05-09 PM.** This roadmap supersedes the earlier proto-society-first roadmap (commit 7308e9d). The earlier phases' goals are preserved in REQUIREMENTS.md §4 "Future Research / Speculative Concepts" and intel/\* files. The earlier source schema sketches (`C-agent-disposition`, `C-discourse-primitives`, `C-mob-proposal`, etc.) remain in `intel/constraints.md` as **future-research target shapes**, not v0.2 commitments.
- **Per-phase gates.** Every phase must, at completion, satisfy the §11 bounds test (`C-bounds`) and the §15 one-sentence test. Workbench/Command Center work additionally honors `docs/COMMAND-CENTER-CONTRACT.md` Prime Directive. Verifier Jobs shipping with each phase enforce these at code level.
- **D2 CRD policy.** No new CRDs in v0.2. AgentDisposition stays as overlay; review queue stays as projection; flows stay as overlays. CRD promotion is post-observation, post-acceptance, in a future milestone.
- **D6 Self-proposal, not self-promotion.** Phase 1's DISP-02 enforces the existing capability-JWT scope check at issuance time — overlays narrow scope; they never widen it. Agents propose; the substrate or human governance promotes.
- **D7 COMMAND-CENTER-CONTRACT.md priority.** For all UI hint phases (1, 2, 3, 5), the contract takes precedence over north-star design language. Every visible world object/action/animation must map back to a substrate source.
- **HYBRID-AGENT-POLICY.md not yet ingested.** Both source north stars cross-reference it. If a future-research phase activates and depends on per-agent reactive+deliberative policy details, run `/gsd-ingest-docs` first.

---

_Roadmap re-steered: 2026-05-09 PM. Original CRD-first proto-society roadmap (Phases 1–8) demoted to Future Research backlog (999.x). Active phases re-derived from REQUIREMENTS.md §1 "Candidate Requirements" — workflow-substrate hardening + observation-first experiments per operator directive._
