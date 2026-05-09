# Synthesis Summary

> **Re-steered 2026-05-09 PM.** Counts and structure below describe the 2026-05-09 ingest of `NORTH-STAR-SYSTEM-DESIGN.md` + `PROTO-SOCIETY-DESIGN.md`. After the 2026-05-09 PM operator directive, both north stars are treated as **candidate inputs**, not commitments. Authoritative active milestone scope and decisions live in `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`. Synthesized outputs use **CoalitionProposal** (not "MobProposal") and **self-proposal** (not "self-promotion").

Entry point for downstream consumers (e.g., `gsd-roadmapper`).

## Doc counts by type

- ADR: 0
- SPEC: 2
- PRD: 0
- DOC: 0
- UNKNOWN: 0
- **Total ingested: 2**

Both source documents were classified as SPEC via manifest override. Both classifier notes flag the documents as hybrid PRD/DOC/SPEC in character: PRD-style goals/non-goals, DOC-style design rationale, SPEC-style schema-shaped substrate primitives (especially proto-society's YAML primitives). The synthesizer honored the manifest tag and treated YAML primitives as constraints, prose framing as context, and high-level goals/winning-conditions as requirement candidates.

## Cross-references and cycle detection

Cross-ref edges in the ingest set:

- `NORTH-STAR-SYSTEM-DESIGN.md` → `PROTO-SOCIETY-DESIGN.md` (in-set)
- `NORTH-STAR-SYSTEM-DESIGN.md` → `HYBRID-AGENT-POLICY.md` (dangling — not in ingest set)
- `PROTO-SOCIETY-DESIGN.md` → `NORTH-STAR-SYSTEM-DESIGN.md` (in-set)
- `PROTO-SOCIETY-DESIGN.md` → `HYBRID-AGENT-POLICY.md` (dangling — not in ingest set)

DFS cycle detection: the two in-set edges form a back-and-forth reference between sibling north stars. This is _citation symmetry_ (each document acknowledges the other as its compatible sibling), not a synthesis cycle in the classifier's sense — neither document depends on the other for content extraction; each can be synthesized independently. No cycle blocker raised.

A note about `HYBRID-AGENT-POLICY.md` is recorded in `context.md` so downstream consumers know a third companion document exists outside this ingest set.

## Decisions locked

**Count: 0**

No ADRs were ingested; no locked decisions were extracted. `decisions.md` documents five proposed/inferred design positions (D1–D5) drawn from the north stars' implementation posture and "non-negotiable" framing — these are NOT locked decisions and are NOT ADRs; they are surfaced so the roadmapper can decide whether to promote any to ADR status.

## Requirements extracted

**Canonical REQ-IDs: 0** (no PRDs ingested)

`requirements.md` records _requirement candidates_ drawn from the north stars' winning-conditions, implementation posture, and non-goals sections. The roadmapper should structure these into `REQ-*` IDs with explicit acceptance criteria — this synthesizer deliberately did not invent IDs or acceptance criteria the source documents did not state.

Major requirement-candidate clusters:

- Workflow substrate winning conditions (per task / per workflow / per colony / per project)
- Workflow substrate near/medium/long-term implementation posture
- Proto-society near/medium/long-term implementation posture
- Workflow substrate non-goals
- Proto-society explicit non-specifications (deferred-until-signal)

## Constraints

**Count: 18**

Breakdown by type:

- protocol: 7 (`C-substrate-layers`, `C-game-loop`, `C-parent-child`, `C-promotion-loop`, `C-feedback-classes`, `C-consolidation`, `C-quarantine`)
- schema: 6 (`C-steering-event`, `C-review-record`, `C-north-star-objects`, `C-agent-disposition`, `C-discourse-primitives`, `C-mob-proposal`)
- nfr: 5 (`C-flow-economy`, `C-bounds`, `C-decay`, `C-governance-tiers`, `C-failure-modes`, `C-substrate-vs-deployment`)

Note: `C-failure-modes` and `C-substrate-vs-deployment` cross the protocol/nfr boundary — both are recorded as nfr because their force is "must-be-true-for-the-substrate-to-be-honest," not strict wire/RPC contracts. Adjust at the roadmapper if a different bucket fits better.

The §11 bounds test (`C-bounds`) and the §15 one-sentence test (recorded in `requirements.md`) are the most load-bearing constraints — both north stars converge on them as the gate every future feature must pass. Any roadmap item that cannot answer the one-sentence test affirmatively is, per the source documents, "likely ornament, application code, or model-gateway scope."

## Context topics

**Count: 12**

`context.md` records the design rationale, framing, and posture topics that don't fit cleanly as constraints or requirements. Topics:

1. kagent's core claim
2. How the system "wins"
3. Enemies are pressure, not lore
4. Interface model — RTS does not replace normal interaction
5. Why two design north stars
6. The honest range of outcomes when "turning the society on"
7. What "agent" means in the proto-society model
8. What "society" means
9. The hard governance tension
10. Notes informed by introspection
11. Operator's stated personal motivation (acknowledged)
12. Implementation posture (both north stars)
13. What is explicitly out of scope
14. Closing posture (proto-society)
15. Cross-references not yet ingested

(Topic count is approximate — some topics are short and could be merged at the roadmapper's discretion.)

## Conflicts

- **0 BLOCKERs** — no LOCKED-vs-LOCKED ADR contradictions (no ADRs ingested), no cycles, no UNKNOWN-low-confidence docs.
- **0 competing-variants** — no PRDs ingested; no overlapping requirement-acceptance pairs to surface.
- **1 INFO** — informal feedback-class numbering between the two north stars (additive, not contradictory). See `INGEST-CONFLICTS.md`.

## Pointers

- Conflicts report: `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/.planning/INGEST-CONFLICTS.md`
- Per-type intel:
  - `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/.planning/intel/decisions.md`
  - `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/.planning/intel/requirements.md`
  - `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/.planning/intel/constraints.md`
  - `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/.planning/intel/context.md`
- Source classifications: `/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/.planning/intel/classifications/`

## Status

**READY** — safe to route to `gsd-roadmapper`. No blockers. No competing variants. Roadmapper should:

1. Decide whether any of D1–D5 in `decisions.md` should be promoted to formal ADRs.
2. Convert requirement-candidate clusters in `requirements.md` into `REQ-*` IDs with explicit acceptance criteria.
3. Treat `C-bounds` and the §15 one-sentence test as the gate every roadmap item must answer.
4. Note that `HYBRID-AGENT-POLICY.md` is referenced but not ingested — flag whether a follow-up ingest is needed before scoping per-agent policy work.
