# Requirements

> **Re-steered 2026-05-09 PM.** This file records **requirement candidates** drawn from the two ingested SPEC-tagged design north stars. After the 2026-05-09 PM re-steering, both north stars are treated as **candidate inputs**, not commitments. Authoritative active milestone scope lives in `.planning/REQUIREMENTS.md` §1 "Candidate Requirements"; deferred concepts live in `.planning/REQUIREMENTS.md` §4 "Future Research / Speculative Concepts". Synthesized outputs use **CoalitionProposal** (not "MobProposal") and **self-proposal** (not "self-promotion") — the original source-document terms are preserved here when quoting source material.

No PRDs were ingested. The two ingested documents are SPEC-tagged design north stars. They describe goals, non-goals, and winning conditions in PRD-adjacent language but do not enumerate per-feature acceptance criteria as canonical PRDs would.

The downstream consumer should treat the goals/non-goals/winning-conditions sections of the north stars as _requirement candidates_ — useful for shaping `REQUIREMENTS.md` but not yet structured as `REQ-*` IDs with per-criterion acceptance.

## Requirement candidates pulled from goals/winning-conditions (NOT canonical REQ-IDs)

### Workflow substrate (from `NORTH-STAR-SYSTEM-DESIGN.md`)

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §10 (Winning conditions), §13 (Implementation posture)

Per task winning condition:

- output delivered
- verifier passed or review recorded
- trace and artifacts linked
- detector flags clean or explicitly reviewed
- cost and latency inside budget

Per workflow winning condition:

- child tasks aggregate cleanly
- retries are bounded
- blocked states are explainable
- final artifact is accepted

Per colony winning condition:

- repeated work becomes reusable capability
- promoted capability is tested, scoped, versioned, and revocable
- resource stalls are visible before they become outages
- authority does not expand silently
- human review load trends down per unit of useful output

Per project winning condition:

- any channel can create the same work order
- every channel produces the same evidence trail
- the substrate can add hardware, tools, agents, and workflows without changing its laws

Near-term implementation requirements (suggested):

- Command Center stays source-bound (renders substrate state, never speculates UI-only state)
- read-depth precedes write-depth (observability before mutation surfaces)
- resource-flow overlays on existing objects
- review queues over existing task/artifact/verifier state
- Tool Foundry as a read model over candidate artifacts (no `Tool` CRD)

Medium-term:

- bounded steering actions
- promotion workflow for AgentTemplates
- replay/eval signals into review
- resource priority/metering semantics

Long-term decision points (NOT requirements; explicit "decide whether"):

- whether promoted tools require a `Tool` CRD
- whether steering/review require first-class CRDs
- whether agent-sandbox becomes the isolation backend
- how physical hardware appears as resource producers and tool-bearing structures

### Proto-society (from `PROTO-SOCIETY-DESIGN.md`)

- source: docs/PROTO-SOCIETY-DESIGN.md (Substrate primitives needed; Implementation posture)

Near-term proof-of-concept:

- `AgentDisposition` as a sibling spec object to `Agent` (idle behavior, attention budget, proposal scope)
- tiny discourse primitive — `Post` records as artifacts initially (no `Channel`/`Discussion` CRD yet)
- consolidation controller wired as opt-in, read-only daemon; surfaces proposals to existing review queue
- run with one or two agents, one channel, a small budget; observe

Medium-term:

- promote `Channel` and `Post` to first-class CRDs once read-side proves out
- `CoalitionProposal` (renamed from source-document "MobProposal") for coalition action (signed quorum; self-review prevention; ring-review detection)
- decay / revalidation as a property on catalog object kinds
- quarantine semantics with explicit TTL and exit paths
- ground-truth eval scaffolding external to society signals

Long-term:

- multi-tenant cognitive subsystem boundaries with cross-tenant capability portability
- reputation algorithm hardening against capture
- adversarial trust model: provenance chains, attestation of agent runtime, signed proposals
- substrate-level revocation kill switch provably independent of society state

### Non-goals (from both documents)

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §14, docs/PROTO-SOCIETY-DESIGN.md ("What this document explicitly does not specify")

Workflow substrate non-goals:

- no UI-only world state
- no direct self-granting authority
- no hidden self-modifying production code
- no arbitrary YAML editor as the main product surface
- no chat-first product pivot
- no visual metaphor that hides failures
- no new CRD until repeated behavior proves it belongs in the substrate

Proto-society non-specifications (deferred until empirical signal):

- UI for the discourse layer
- specific reputation algorithms (PageRank-like / upvote / citation-weighted / hybrid)
- specific mob-proposal voting rules (simple quorum / weighted / liquid democracy)
- specific personality/persona of agents (application-layer concern)
- AGI speculation (out of scope)

## The one-sentence test

Both documents converge on a single gate for any future feature.

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §15, docs/PROTO-SOCIETY-DESIGN.md ("One-sentence test, extended")

Workflow form:

> Does this help the system turn intent into verified reusable capability with clearer authority, resource accounting, observability, review, or revocation?

Proto-society extension:

> Does this help the agent collective generate, refine, and govern its own intent — while keeping authority, observation, review, and revocation paths legible and operable to humans?

If a feature permits agent self-organization but reduces the operator's ability to inspect or revoke, it is the wrong feature.
