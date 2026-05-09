# Requirements: kagent (v0.2 — proto-society foundations)

**Defined:** 2026-05-09
**Core Value:** The substrate turns intent into verified reusable capability under bounded resources, observable state, and revocable authority. Signals propose; governance disposes.

> **Source provenance.** No PRDs were ingested. Requirements below are derived by `gsd-roadmapper` from the requirement candidates in `.planning/intel/requirements.md` (drawn from `docs/PROTO-SOCIETY-DESIGN.md` "Substrate primitives needed" §1–6, "Implementation posture / Near-term", and the §11 bounds + §15 one-sentence tests). Acceptance criteria are written to be falsifiable; where the source documents do not state a specific threshold, the criterion uses the substrate's existing patterns (capability-JWT scope, audit events, status subresource, GitOps-shaped verification).

> **Mandatory gates per requirement.** Every v1 requirement below must, on completion, satisfy:
>
> - **§11 bounds test (`C-bounds`)** — declared capability + bounded resource drain + observable state transition + auditable output + revocation path
> - **§15 one-sentence test (proto-society extension)** — helps the agent collective generate, refine, and govern its own intent **while keeping authority, observation, review, and revocation paths legible and operable to humans**
>
> Phases verify both gates before declaring a requirement complete. The verifier shipping with the phase enforces this at code level (e.g., a CRD without a revocation path fails the bounds test).

## v1 Requirements (v0.2 milestone scope)

Requirements for the v0.2 proto-society-foundations milestone. Each maps to exactly one phase in `ROADMAP.md`. Requirement count: **24**.

### AgentDisposition (DISP)

The smallest first move per `PROTO-SOCIETY-DESIGN.md` "Implementation posture / Near-term".

- [ ] **DISP-01**: Operator ships an `AgentDisposition` CRD whose spec carries `agentRef`, `idleBehavior.readChannels[]`, `idleBehavior.attentionBudget.{tokensPerDay, pollIntervalSeconds}`, and `idleBehavior.proposalScope.{mayProposeAgainst[], maxProposalsPerDay}` per the schema in `C-agent-disposition`. CRD passes `kubectl explain` with descriptions on every field.
- [ ] **DISP-02**: Operator reconciles `AgentDisposition` to attach a capability-JWT scope on the referenced `Agent` that grants only the channel-read and proposal-issuance rights named in spec. Reconciler unit tests prove a disposition with `proposalScope.mayProposeAgainst: [templates]` cannot issue a tool-change proposal.
- [ ] **DISP-03**: Operator updates `AgentDisposition.status` with `spentTokensToday`, `postsToday`, and `proposalsToday` per the source schema; counters reset at a documented daily boundary; over-budget conditions emit a substrate audit event with a structured reason.
- [ ] **DISP-04**: Workbench API exposes a read-only `/dispositions` projection (status + budget remaining + over-budget event count); workbench-ui renders it in the Command Center as a flow alongside the existing economy flows (model power, token flow, etc. from `C-flow-economy`).

### Discourse primitives (DISC)

Per `C-discourse-primitives` and `PROTO-SOCIETY-DESIGN.md` "Substrate primitives needed §2". **No CRD until read-side proves out** (`D2`); start as artifact-shape records.

- [ ] **DISC-01**: A `Channel` is representable today as a configmap or namespaced object carrying `name`, `visibility ∈ {public, scoped, tenant}`, `participants[]`, `retention` (e.g., `90d`); a verifier Job rejects channel definitions that omit any of these.
- [ ] **DISC-02**: A `Post` is representable today as an artifact-shape record carrying `channel`, `author`, `body`, `cites[]`, `inReplyTo` (optional), and `status.{reactions, citationCount}`. Posts are write-once + append-only; tampering an existing post body produces a verifier failure.
- [ ] **DISC-03**: Posting consumes `AgentDisposition.status.spentTokensToday` against the disposition's `attentionBudget`; a post issued by an over-budget agent is rejected at the substrate boundary with a typed audit event.
- [ ] **DISC-04**: Channel retention runs as a scheduled Job that prunes posts past the channel's `retention` and emits one audit event per pruned post; pruning is reversible only via signed re-import (no in-place restore).
- [ ] **DISC-05**: Post citations are inspectable: given a post id, the substrate returns the set of posts/artifacts it cites and the set of posts that cite it (citation graph read API), so the consolidation controller (CONS-\*) and reputation work (deferred) can read it without owning the schema.

### Consolidation controller (CONS)

Per `C-consolidation` and `PROTO-SOCIETY-DESIGN.md` "Substrate primitives needed §4". **Read-only daemon, opt-in.**

- [ ] **CONS-01**: A consolidation controller process exists that wakes on a schedule (or on task-tree close), reads recent failures + tool-use patterns + citation counts + post engagement, and emits proposal records to the existing review queue. The controller's deployment is opt-in via Helm values; it ships disabled by default.
- [ ] **CONS-02**: The controller is provably read-only: its capability-JWT carries no write scopes against catalog objects (templates, verifiers, tools, capability policies); a unit test asserts the JWT cannot mutate any of those object kinds.
- [ ] **CONS-03**: Every proposal the controller emits is auditable end-to-end: it carries `proposer: consolidation-controller`, the inputs that produced it (citation list, failure-rate window, etc.), and a stable id linked to the audit event. Reviewer can replay the inputs and reach the same proposal deterministically (or get a substrate-attributed reason why not).
- [ ] **CONS-04**: When the controller's proposal queue grows past a configurable threshold the substrate throttles new proposals and surfaces the queue depth as a "trust" pressure flow per `C-flow-economy`; the operator can pause the controller via a single substrate action that takes effect within one reconcile cycle.

### MobProposal / coalition action (MOB)

Per `C-mob-proposal` and `C-governance-tiers`. Per `D2`, `MobProposal` is the first place the source documents force a CRD: coalition action requires substrate representation and the verification obligations are non-negotiable.

- [ ] **MOB-01**: Operator ships a `MobProposal` CRD whose spec carries `proposers[]` (each with `agent` + `signature`), `proposal.{kind, target, reason, citations[]}`, and `status.{reviewState, requiredReviewers, decision}` per `C-mob-proposal`. CRD validation rejects single-proposer payloads with a typed error (single-agent proposals are not coalitions).
- [ ] **MOB-02**: Each proposer's signature is verified against their agent's capability-JWT public key at admission time; an unverifiable or scope-mismatched signature rejects the proposal with a typed audit event identifying the offending proposer.
- [ ] **MOB-03**: Substrate enforces a configurable quorum (≥N proposers, default N≥2; capability-policy proposals require N≥3 multi-human review per `C-governance-tiers`). Quorum failure rejects with a typed reason.
- [ ] **MOB-04**: Self-review is prevented: an agent listed in `proposers[]` cannot also appear as a reviewer on the same proposal. A unit test asserts the controller rejects such review attempts.
- [ ] **MOB-05**: Ring-review is detectable: a periodic Job scans recent proposals + reviews and flags clusters where the same N agents review each other's proposals beyond a configurable rate; flagged clusters surface as a quarantine candidate (see QUAR-\*) and rate-limit subsequent coalition actions from those agents.

### Decay / revalidation (DECAY)

Per `C-decay`.

- [ ] **DECAY-01**: Each catalog-object class (verifier, prompt, AgentTemplate, guard, tool — when introduced) carries a declared `staleness` function and `revalidationPolicy` as schema metadata. A catalog object missing either field fails admission with a typed reason.
- [ ] **DECAY-02**: A periodic Job evaluates staleness across the catalog and emits re-review proposals at decay-threshold crossings (proposal goes through the same review pipeline as any other; honors `C-promotion-loop`). Stale objects remain usable but their use is logged as an audit event so reviewers can correlate stale-use with downstream failures.

### Quarantine (QUAR)

Per `C-quarantine`.

- [ ] **QUAR-01**: A catalog object can be transitioned to a `quarantine` state via a signed substrate action; while quarantined, existing references continue working but **new** bindings are forbidden (admission webhook denies new use). Evidence (artifacts, audit events, traces) is preserved unaltered.
- [ ] **QUAR-02**: Every quarantine carries a bounded `ttl`; on expiry the substrate forces one of three explicit exit paths — `rehabilitate` (signed unblock), `deprecate` (versioned removal from catalog), `delete` (purge with audit). The owner / proposer is notified at quarantine entry and again at TTL expiry; notification failures themselves emit audit events.

### Substrate-level revocation kill-switch (REVOKE)

Per `D4` and `C-failure-modes` row 8. **Non-negotiable; design requirement, not configuration option.**

- [ ] **REVOKE-01**: Operator exposes a substrate-level kill-switch that disables all proto-society primitives (AgentDisposition idle behavior + Discourse posting + Consolidation controller + MobProposal admission) within one reconcile cycle. The kill-switch is a single signed substrate action; it does not require quorum, does not honor MobProposal vetoes, and cannot be revoked by the agent collective. A failure-injection test proves the switch fires even when the consolidation controller and MobProposal admission are concurrently degraded.
- [ ] **REVOKE-02**: Kill-switch state is observable end-to-end: workbench-api projects a clear `proto_society_enabled: bool` to workbench-ui Command Center, and the operator emits a substrate-attributed audit event on every state transition. State is recoverable across operator restarts (persisted to a CRD `status` field, not in-memory).

### Pilot deployment + observation (PILOT)

Per `PROTO-SOCIETY-DESIGN.md` "Implementation posture / Near-term": _"run with one or two agents, one channel, a small budget; observe."_

- [ ] **PILOT-01**: A Helm values overlay seeds a personal-research deployment with two `Agent` + `AgentDisposition` pairs (e.g., `researcher-01`, `summarizer-01`), one `Channel`, capped daily token budget, and the proto-society kill-switch wired but disabled by default. Overlay lives under `packages/operator/charts/values-references/` and is GitOps-deployable to the homelab K3s cluster.
- [ ] **PILOT-02**: After at least 7 calendar days of pilot operation the substrate has emitted: (a) audit events for at least one disposition over-budget event OR a documented near-miss; (b) at least one consolidation proposal that surfaced to the review queue; (c) a documented operator review of one MobProposal (real or synthetic) end-to-end through admission → quorum check → review → decision. Pilot evidence is collected as artifacts under `evidence/v0.2-pilot/` and committed.
- [ ] **PILOT-03**: A retrospective document captures which of the eight `C-failure-modes` rows the pilot exercised (even if synthetically), which the substrate caught vs missed, and at least one concrete revision proposal for the substrate (filed as a v0.3 candidate, not auto-accepted).

## v2 Requirements

Deferred to v0.3+ per `PROTO-SOCIETY-DESIGN.md` "Implementation posture / Medium-term" and "Long-term". Tracked here for visibility; not in current roadmap.

### Discourse promotion (DISC-V2)

- **DISC-V2-01**: Promote `Channel` and `Post` to first-class CRDs once read-side usage justifies (per `D2`).
- **DISC-V2-02**: UI for the discourse layer (deferred until empirical signal per source spec).

### Reputation + governance hardening (REP-V2)

- **REP-V2-01**: Specific reputation algorithm (PageRank-like / upvote / citation-weighted / hybrid) — pick after pilot signal.
- **REP-V2-02**: Specific MobProposal voting rules (simple quorum / weighted / liquid democracy) — pick after pilot signal.
- **REP-V2-03**: Reputation-capture defenses: ground-truth eval scaffolding external to society's own signals.

### Adversarial trust (TRUST-V2)

- **TRUST-V2-01**: Provenance chains on all proposed artifacts.
- **TRUST-V2-02**: Attestation of agent runtime (signed pod images + capability-JWT chain).
- **TRUST-V2-03**: Signed proposals with full chain-of-custody from agent → coalition → review → catalog.

### Long-term substrate (SUB-V3+)

- Multi-tenant cognitive subsystem boundaries with cross-tenant capability portability.
- Whether agent-sandbox becomes the isolation backend (vs Kata Containers).
- Whether promoted tools require a `Tool` CRD.
- Whether steering/review require first-class CRDs (vs annotations + actions).
- How physical hardware appears as resource producers and tool-bearing structures.

## Out of Scope

Explicitly excluded for v0.2. Documented to prevent scope creep.

| Feature                                                      | Reason                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| UI for discourse layer                                       | Source spec defers until empirical signal; substrate-first posture          |
| Specific reputation algorithm                                | Premature optimization without pilot signal                                 |
| Specific voting rule for MobProposal                         | Premature optimization; default to ≥N quorum + capability-scope check       |
| Specific agent personality / persona                         | Application-layer concern; substrate hosts whatever operator seeds          |
| AGI speculation                                              | Out of scope; focus on what's actionable under bounded resources            |
| Agent SDK                                                    | v0.1 non-goal; carried forward                                              |
| LLM gateway implementation                                   | LiteLLM Proxy is the dependency, not a deliverable                          |
| Trace store implementation                                   | Langfuse is the dependency, not a deliverable                               |
| K8s-management agent                                         | Different problem domain (`kagent.dev`, Solo.io)                            |
| Workflow / DAG / Swarm engine                                | A2A is messaging-primitive level only                                       |
| `Tool` CRD                                                   | `D2` — defer until usage justifies                                          |
| `SteeringEvent` CRD                                          | `D2` — annotations + existing API actions sufficient until proven otherwise |
| Imperative `kubectl apply/exec/port-forward` against homelab | GitOps only; verification ships as Job manifests                            |
| Continuous biographical memory per individual agent          | Agents are session-scoped; the society persists, not the agent              |

## Traceability

Each v1 requirement maps to exactly one phase. Status updated by execute / verify-phase workflows.

| Requirement | Phase   | Status  |
| ----------- | ------- | ------- |
| DISP-01     | Phase 1 | Pending |
| DISP-02     | Phase 1 | Pending |
| DISP-03     | Phase 1 | Pending |
| DISP-04     | Phase 1 | Pending |
| DISC-01     | Phase 2 | Pending |
| DISC-02     | Phase 2 | Pending |
| DISC-03     | Phase 2 | Pending |
| DISC-04     | Phase 2 | Pending |
| DISC-05     | Phase 2 | Pending |
| CONS-01     | Phase 3 | Pending |
| CONS-02     | Phase 3 | Pending |
| CONS-03     | Phase 3 | Pending |
| CONS-04     | Phase 3 | Pending |
| MOB-01      | Phase 4 | Pending |
| MOB-02      | Phase 4 | Pending |
| MOB-03      | Phase 4 | Pending |
| MOB-04      | Phase 4 | Pending |
| MOB-05      | Phase 4 | Pending |
| DECAY-01    | Phase 5 | Pending |
| DECAY-02    | Phase 5 | Pending |
| QUAR-01     | Phase 6 | Pending |
| QUAR-02     | Phase 6 | Pending |
| REVOKE-01   | Phase 7 | Pending |
| REVOKE-02   | Phase 7 | Pending |
| PILOT-01    | Phase 8 | Pending |
| PILOT-02    | Phase 8 | Pending |
| PILOT-03    | Phase 8 | Pending |

**Coverage:**

- v1 requirements: 27 total
- Mapped to phases: 27
- Unmapped: 0 ✓

---

_Requirements defined: 2026-05-09 (from `.planning/intel/` — no PRDs ingested; REQ-IDs created by `gsd-roadmapper`)_
_Last updated: 2026-05-09 after initial definition_
