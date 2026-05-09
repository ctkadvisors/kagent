# Decisions

No ADRs were ingested. The two ingested documents are SPEC-tagged design north stars, not architecture decision records. Their decisions are recorded as constraints (see `constraints.md`) and design rationale (see `context.md`).

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
- status: proposed (compatibility declaration)
- statement: everything in `NORTH-STAR-SYSTEM-DESIGN.md` is foundational. `PROTO-SOCIETY-DESIGN.md` adds primitives that layer on top; it does not replace or contradict the workflow substrate. Most kagent installations are workflow-only; the proto-society layer is opt-in (likely the personal-research deployment first).
- scope: relationship between the two north stars
