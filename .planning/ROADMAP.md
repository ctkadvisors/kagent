# Roadmap: kagent — v0.2 (proto-society foundations)

## Overview

The v0.1 workflow substrate is shipped: operator + CRDs, NATS A2A bus, agent-pod runtime, capability-JWT, LiteLLM gateway, Langfuse traces, replay/eval/supervision/quotas controllers, workbench API + UI. Historical v0.1 phases are captured in `docs/ROADMAP.md`.

This roadmap is **forward-looking only**: v0.2 lays the smallest substrate primitives required for emergent agent collectives — a _proto-society_ — to form on top of the workflow substrate, in dependency order from `docs/PROTO-SOCIETY-DESIGN.md` "Substrate primitives needed" §1–6, ending with a substrate-level kill-switch (non-negotiable per `D4`) and a small pilot deployment to observe under bounded budget. Every phase must answer the §11 bounds test affirmatively (declared capability + bounded resource drain + observable state transition + auditable output + revocation path) and the §15 one-sentence test (helps the collective generate, refine, and govern its own intent while keeping authority/observation/review/revocation legible to humans).

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: AgentDisposition v0** — CRD + reconciler + capability-JWT scope + workbench projection; the smallest first move
- [ ] **Phase 2: Discourse primitives** — Channel/Post as artifacts; durable, citable, attention-budgeted; no CRD until usage justifies
- [ ] **Phase 3: Consolidation controller** — Read-only daemon that proposes hygiene actions to the existing review queue
- [ ] **Phase 4: MobProposal + coalition action** — CRD + signed quorum + no-self-review + ring-review detection
- [ ] **Phase 5: Decay / revalidation** — Per-class staleness function + revalidationPolicy; re-review proposals at threshold crossings
- [ ] **Phase 6: Quarantine semantics** — First-class holding pattern with bounded TTL and explicit exit paths
- [ ] **Phase 7: Substrate-level revocation kill-switch** — Operator-only, society-independent, auditable; non-negotiable
- [ ] **Phase 8: Pilot deployment + observation** — Two agents, one channel, small budget, 7+ days; collect evidence and retrospective

## Phase Details

### Phase 1: AgentDisposition v0

**Goal**: Idle agent behavior becomes cost-visible and capability-scoped — the substrate represents what an agent does between tasks as a first-class object that an operator can inspect, budget, and revoke.
**Depends on**: Nothing (first v0.2 phase; layers on shipped v0.1 substrate)
**Requirements**: DISP-01, DISP-02, DISP-03, DISP-04
**Success Criteria** (what must be TRUE):

1. An operator can `kubectl apply` an `AgentDisposition` referencing an existing `Agent` and observe the disposition's spec/status via `kubectl get agentdisposition` with all `C-agent-disposition` fields populated.
2. An agent whose disposition declares `proposalScope.mayProposeAgainst: [templates]` cannot issue a tool-change or capability-policy proposal — the substrate rejects with a typed audit event tying the rejection back to the disposition's capability-JWT scope.
3. An operator can read `AgentDisposition.status.spentTokensToday` and `proposalsToday` and see them increment in step with disposition activity; over-budget conditions emit substrate audit events with structured reasons.
4. The Workbench Command Center renders a "dispositions" flow alongside the existing economy flows (model power, token, build power, etc.); the flow shows budget remaining and over-budget event count per disposition.
   **Plans**: TBD
   **UI hint**: yes

Plans:

- [ ] 01-01: TBD

### Phase 2: Discourse primitives

**Goal**: Agents can post into named channels with durable, citable records — discourse is representable as substrate state without forcing a CRD before the read-side proves out.
**Depends on**: Phase 1 (Posts consume `AgentDisposition` attention budget per DISC-03)
**Requirements**: DISC-01, DISC-02, DISC-03, DISC-04, DISC-05
**Success Criteria** (what must be TRUE):

1. An operator can declare a channel (configmap or namespaced object form) carrying name/visibility/participants/retention; a verifier Job rejects channel definitions missing any of the four fields.
2. An agent can issue a `Post` (artifact-shape) referencing a channel and citing prior posts/artifacts; the post is write-once + append-only and tampering an existing post body fails verification.
3. A post issued by an over-budget agent is rejected at the substrate boundary — the disposition's attention budget is enforced as a precondition, not a post-hoc audit.
4. Channel retention runs as a scheduled Job and prunes posts past the channel's TTL; each pruned post emits one audit event; pruned content cannot be restored in-place (signed re-import is the only path back).
5. The substrate exposes a citation-graph read API: given a post id, the set of posts/artifacts it cites and the set of posts that cite it are returnable without reading the underlying storage layout.
   **Plans**: TBD

Plans:

- [ ] 02-01: TBD

### Phase 3: Consolidation controller

**Goal**: A read-only "sleep" daemon turns recent substrate state into proposals — the substrate becomes one of the signal sources alongside agents and human steering, but signals still propose; governance still disposes.
**Depends on**: Phase 2 (controller reads citation counts, post engagement); transitively Phase 1 (reads disposition status). Disabled-by-default Helm flag prevents the controller from running in deployments that opt out of the proto-society layer.
**Requirements**: CONS-01, CONS-02, CONS-03, CONS-04
**Success Criteria** (what must be TRUE):

1. A consolidation controller process exists, ships disabled-by-default, and when enabled wakes on a configurable schedule (and on task-tree close) to emit proposals into the existing review queue — same pipeline as any other proposal per `C-promotion-loop`.
2. The controller's capability-JWT carries no write scopes against catalog objects; a unit test asserts the JWT cannot mutate templates, verifiers, tools, or capability policies.
3. Every proposal carries `proposer: consolidation-controller` plus the inputs that produced it (citation list, failure-rate window, etc.); a reviewer can replay the inputs deterministically or get a substrate-attributed explanation why not.
4. When the proposal queue grows past a configurable threshold the substrate throttles new proposals and surfaces queue depth as a "trust" pressure flow per `C-flow-economy`; an operator-issued substrate action pauses the controller within one reconcile cycle.
   **Plans**: TBD

### Phase 4: MobProposal + coalition action

**Goal**: Coalition action is representable as a substrate object — multiple agents agreeing on a proposal becomes a signed, quorum-checked, no-self-review, ring-review-detectable artifact that the existing review pipeline acts on.
**Depends on**: Phase 3 (MobProposal flows through the same review pipeline the consolidation controller already uses); transitively Phase 1 (proposer signatures verified against capability-JWT public keys from disposition scope).
**Requirements**: MOB-01, MOB-02, MOB-03, MOB-04, MOB-05
**Success Criteria** (what must be TRUE):

1. An operator can `kubectl apply` a `MobProposal` whose spec carries `proposers[]` (each with agent + signature), `proposal.{kind,target,reason,citations[]}`, and `status.{reviewState,requiredReviewers,decision}` per `C-mob-proposal`. Single-proposer payloads are rejected with a typed CRD validation error.
2. Each proposer signature is verified against their agent's capability-JWT public key at admission; an unverifiable or scope-mismatched signature rejects the proposal and emits a typed audit event identifying the offending proposer.
3. The substrate enforces quorum (≥N proposers, default N≥2; capability-policy proposals require N≥3 multi-human review per `C-governance-tiers`); quorum failure rejects with a typed reason; the test suite covers the boundary cases.
4. An agent listed in `proposers[]` cannot also appear as a reviewer on the same proposal — the controller rejects such review attempts as self-review.
5. A periodic Job scans recent proposals + reviews and flags clusters where the same N agents review each other's proposals beyond a configurable rate; flagged clusters surface as quarantine candidates and trigger rate-limiting on those agents' subsequent coalition actions.
   **Plans**: TBD

### Phase 5: Decay / revalidation

**Goal**: Catalog objects age honestly — every promotable object class declares a staleness function and a revalidation policy; stale objects remain usable but trigger re-review proposals at decay-threshold crossings.
**Depends on**: Phase 3 (revalidation proposals flow through the consolidation controller's queue + review pipeline).
**Requirements**: DECAY-01, DECAY-02
**Success Criteria** (what must be TRUE):

1. Every catalog object class (verifier, prompt, AgentTemplate, guard) carries a declared `staleness` function and `revalidationPolicy` as schema metadata; a catalog object missing either field fails admission with a typed reason.
2. A periodic Job evaluates staleness across the catalog and emits re-review proposals at decay-threshold crossings, flowing through the same review pipeline as any other proposal; stale objects remain usable but their continued use is logged as audit events so reviewers can correlate stale-use with downstream failures.
   **Plans**: TBD

### Phase 6: Quarantine semantics

**Goal**: The substrate has a gentle response to "something is wrong but we're not sure what" — a holding pattern that pulls the object from new bindings, preserves evidence, bounds the duration, and forces an explicit exit.
**Depends on**: Phase 4 (ring-review detection from MOB-05 surfaces clusters that need quarantining); Phase 5 (decay events can request quarantine).
**Requirements**: QUAR-01, QUAR-02
**Success Criteria** (what must be TRUE):

1. An operator can transition a catalog object to `quarantine` via a signed substrate action; existing references continue to function but new bindings are denied at the admission webhook; evidence (artifacts, audit events, traces) is preserved unaltered.
2. Every quarantine carries a bounded TTL; on expiry the substrate forces one of three explicit exit paths — `rehabilitate` (signed unblock), `deprecate` (versioned removal), `delete` (purge with audit). Owner / proposer is notified at quarantine entry and at TTL expiry; notification failures themselves emit audit events.
   **Plans**: TBD

### Phase 7: Substrate-level revocation kill-switch

**Goal**: The operator retains a substrate-level revocation that the agent collective cannot route around — non-negotiable per `D4` and `C-failure-modes` row 8 ("society outgrows human relevance"). This is a design requirement, not a configuration option.
**Depends on**: Phases 1–4 (the kill-switch must disable AgentDisposition idle behavior, Discourse posting, Consolidation controller, and MobProposal admission within one reconcile cycle).
**Requirements**: REVOKE-01, REVOKE-02
**Success Criteria** (what must be TRUE):

1. An operator can fire a substrate-level kill-switch via a single signed substrate action; within one reconcile cycle, AgentDisposition idle behavior halts, Discourse posting is denied at the substrate boundary, the Consolidation controller pauses, and MobProposal admission rejects all new proposals. The switch does not require quorum, does not honor MobProposal vetoes, and cannot be revoked by the agent collective.
2. A failure-injection test proves the switch fires correctly even when the consolidation controller and MobProposal admission are concurrently degraded.
3. Kill-switch state is persisted (CRD `status` field; recoverable across operator restarts), projected to workbench-ui Command Center as `proto_society_enabled: bool`, and every state transition emits a substrate-attributed audit event.
   **Plans**: TBD
   **UI hint**: yes

### Phase 8: Pilot deployment + observation

**Goal**: Run the proto-society layer with the minimum substrate that proves it on a real homelab K3s cluster — two agents, one channel, capped budget, kill-switch wired but disabled by default, observed for at least 7 days, retrospectively documented. Token-throwing is the _scaling_ test; this phase is the _correctness_ test.
**Depends on**: Phases 1–7 (every primitive must exist; the kill-switch must be wired and provably operable before the pilot starts taking real signal).
**Requirements**: PILOT-01, PILOT-02, PILOT-03
**Success Criteria** (what must be TRUE):

1. A Helm values overlay seeds a personal-research deployment with two `Agent` + `AgentDisposition` pairs, one channel, capped daily token budget, and the kill-switch wired-but-disabled; the overlay lives under `packages/operator/charts/values-references/` and is GitOps-deployable to the homelab K3s cluster (no imperative `kubectl apply`).
2. After ≥7 calendar days of pilot operation the substrate has emitted (a) at least one disposition over-budget event or documented near-miss, (b) at least one consolidation proposal that surfaced to the review queue, and (c) one operator-reviewed `MobProposal` (real or synthetic) end-to-end through admission → quorum check → review → decision; pilot evidence is committed under `evidence/v0.2-pilot/`.
3. A retrospective document captures which of the eight `C-failure-modes` rows the pilot exercised (even synthetically), which the substrate caught vs missed, and at least one concrete revision proposal filed as a v0.3 candidate (not auto-accepted; honors `D3` "signals propose; governance disposes").
   **Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase                                     | Plans Complete | Status      | Completed |
| ----------------------------------------- | -------------- | ----------- | --------- |
| 1. AgentDisposition v0                    | 0/TBD          | Not started | -         |
| 2. Discourse primitives                   | 0/TBD          | Not started | -         |
| 3. Consolidation controller               | 0/TBD          | Not started | -         |
| 4. MobProposal + coalition action         | 0/TBD          | Not started | -         |
| 5. Decay / revalidation                   | 0/TBD          | Not started | -         |
| 6. Quarantine semantics                   | 0/TBD          | Not started | -         |
| 7. Substrate-level revocation kill-switch | 0/TBD          | Not started | -         |
| 8. Pilot deployment + observation         | 0/TBD          | Not started | -         |

## Notes

- **Forward-looking only.** Historical v0.1 phases (Phase 0 scope/docs through Phase 5.x agent self-service) are captured in `docs/ROADMAP.md` and not duplicated here.
- **Per-phase gates.** Every phase must, at completion, satisfy the §11 bounds test (`C-bounds`) and the §15 one-sentence test (proto-society extension). Verifier Jobs shipping with each phase enforce these at code level.
- **`HYBRID-AGENT-POLICY.md` not yet ingested.** Both source north stars cross-reference it. If Phase 1's idle-behavior modeling or Phase 4's signature scoping turns out to depend on per-agent reactive+deliberative policy details, run `/gsd-ingest-docs` to pull it in before scoping the affected phase. Flagged here so it doesn't surprise downstream `/gsd-plan-phase`.
- **D2 CRD policy.** Phase 1 (AgentDisposition) and Phase 4 (MobProposal) are the two places the source spec forces a CRD: dispositions because idle behavior must be governed, mob proposals because coalition action must be representable for review. All other primitives (Channel, Post, SteeringEvent, Tool, etc.) stay as overlays/artifacts until usage justifies promotion. Promoting any to first-class CRD is a v2 candidate.
- **D4 non-negotiability.** Phase 7 is gated independent of pilot signal — it ships before Phase 8 because the pilot must be revocable from day zero, even synthetically.

---

_Roadmap created: 2026-05-09 by `gsd-roadmapper` from `.planning/intel/` (no PRDs ingested; REQ-IDs derived from `PROTO-SOCIETY-DESIGN.md` "Substrate primitives needed")._
