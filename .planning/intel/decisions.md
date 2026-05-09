# Decisions

> **Re-steered 2026-05-09 PM.** All D1–D5 below are **candidate, unlocked** design positions inferred from the ingested north stars. The 2026-05-09 PM operator directive added D6 (self-proposal, not self-promotion) and D7 (`docs/COMMAND-CENTER-CONTRACT.md` is binding for Workbench/Command Center work). Authoritative copies of D1–D7 with current status live in `.planning/PROJECT.md` "Key Decisions". The proto-society primitives sketched in `constraints.md` (`C-agent-disposition`, `C-discourse-primitives`, `C-mob-proposal`, etc.) are **future-research target shapes**, not v0.2 commitments — see `.planning/REQUIREMENTS.md` §4.

No ADRs were ingested. The two ingested documents are SPEC-tagged design north stars, not architecture decision records. Their decisions are recorded as constraints (see `constraints.md`) and design rationale (see `context.md`). The 2026-05-09 PM re-steering treats both north stars as **candidate inputs**, not commitments.

If/when ADRs are introduced for kagent (e.g., locking the choice of NATS JetStream as the A2A bus, or Kata Containers as the isolation backend), they should land here with explicit `locked:` status.

## Implicit decisions inferable from the north stars (NOT locked, NOT ADRs)

These are stated as design posture in the source SPECs, surfaced here so downstream consumers know they exist as proposed direction. Promoting them to ADRs is a separate exercise.

### D1. Substrate-vs-application boundary

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §11 (Bounds), §13 (Implementation posture), §14 (Non-goals)
- status: proposed (not locked)
- statement: kagent ships substrate primitives only. Agent SDKs, LLM gateways, trace stores, K8s-management agents, and workflow/DAG engines are explicitly out of scope.
- scope: project surface area

### D2. Defer CRDs until repeated behavior justifies one

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §6 (Self-improvement), §12 (North-star objects), §13 (Implementation posture); reinforced in docs/PROTO-SOCIETY-DESIGN.md (Implementation posture)
- status: proposed (not locked)
- statement: prefer overlays on existing objects (annotations, status fields, ArtifactRefs) until a concept repeats often enough to force a CRD. No `Tool` CRD, `SteeringEvent` CRD, `TaskReview` CRD, `Channel` CRD, or `Post` CRD until candidates force the design.
- scope: CRD addition policy

### D3. Signals propose; governance disposes

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §7.3 (Learning signals); reinforced as load-bearing rule in docs/PROTO-SOCIETY-DESIGN.md
- status: proposed (not locked) but treated as load-bearing in both north stars
- statement: learning signals, consolidation outputs, and any emergent agent-collective output may _propose_ changes to authority, prompts, templates, tools, verifiers, or routing — but never _enact_ them. Every emergence-permitting design move must terminate in a governance gate.
- scope: authority delegation, self-improvement loop, proto-society governance

### D4. Substrate-level revocation is non-negotiable

- source: docs/PROTO-SOCIETY-DESIGN.md (Failure modes — "Society outgrows human relevance"); aligned with docs/NORTH-STAR-SYSTEM-DESIGN.md §11 (Bounds — "revocation path")
- status: proposed (treated as design requirement, not configuration option)
- statement: the operator must retain a substrate-level revocation that the agent collective cannot route around, even if society members vote against it. This is required regardless of which proto-society features are enabled.
- scope: kill-switch / authority floor

### D5. Workflow north star is foundational; proto-society lives on top

- source: docs/PROTO-SOCIETY-DESIGN.md (opening framing, "Why two documents")
- status: proposed (compatibility declaration). After 2026-05-09 PM re-steering, the proto-society layer is **future research, not v0.2 commitment**.
- statement: everything in `NORTH-STAR-SYSTEM-DESIGN.md` is foundational. `PROTO-SOCIETY-DESIGN.md` adds primitives that _could_ layer on top; it does not replace or contradict the workflow substrate. Most kagent installations are workflow-only; the proto-society layer is opt-in AND deferred until empirical signal justifies promotion from Future Research to Candidate Requirement.
- scope: relationship between the two north stars

### D6. Self-proposal, not self-promotion (re-steering correction)

- source: 2026-05-09 PM operator directive (re-steering)
- status: proposed (treated as load-bearing alongside D3)
- statement: agents may **propose** new capability, tools, templates, policies, or catalog changes. The substrate or human governance **promotes** them. **No agent self-escalates authority.** Replaces any earlier interpretation of "self-promotion authority" in the synthesized outputs.
- scope: terminology correction; reinforces D3

### D7. `docs/COMMAND-CENTER-CONTRACT.md` is binding for Workbench/Command Center work

- source: 2026-05-09 PM operator directive (re-steering); contract document at `docs/COMMAND-CENTER-CONTRACT.md`
- status: proposed (binding for in-scope Workbench/Command Center work)
- statement: for any Workbench/Command Center implementation, `docs/COMMAND-CENTER-CONTRACT.md` takes precedence over the north-star design language. Key invariant: every world object/action/animation must map back to CRDs, Workbench API DTOs, audit events, gateway state, artifacts, traces, or verifier output. **No UI-only game state.** The north stars frame the _why_; the contract specifies the _how_.
- scope: implementation contract for the Workbench/Command Center surface
