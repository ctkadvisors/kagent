# Context

> **Re-steered 2026-05-09 PM.** Topics below are design rationale extracted from the two ingested SPEC-tagged design north stars. After the 2026-05-09 PM re-steering, both north stars are treated as **candidate inputs**, not commitments. The proto-society topics (society, governance tension, range of outcomes, etc.) are recorded here for future-research planning context — they do NOT define v0.2 scope. Active v0.2 scope is workflow-substrate hardening + observation-first experiments; see `.planning/REQUIREMENTS.md` §1. Synthesized outputs use **CoalitionProposal** (not "MobProposal") and **self-proposal** (not "self-promotion") — original source-document terms preserved when quoting.

Design rationale, framing, and posture extracted from the two ingested SPEC-tagged design north stars. This file holds the _why_; `constraints.md` holds the _what_.

---

## Topic: kagent's core claim

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §1, opening framing

kagent is a real-time autonomous work substrate. The user supplies intent through ordinary channels. The system decomposes that intent into task graphs, uses bounded resources over time, produces artifacts and evidence, and promotes reusable capability only after review.

The Command Center is a _map_ of that substrate. It is not the substrate. The 90s RTS analogy is useful but is only the human-facing layer; the real system is a self-organizing colony of agents, tasks, tools, artifacts, workflows, and capability gates operating under substrate laws.

The purpose of the substrate is not to make agents busy. It is to turn intent into verified reusable capability while preserving authority, observability, and resource accounting.

---

## Topic: How the system "wins"

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §3 (game loop), §10 (winning conditions)

User-facing loop:

1. Submit work through a normal channel.
2. Watch the substrate execute when useful.
3. Steer only when a task is blocked, over budget, or wrong.
4. Review outputs and promotion proposals.
5. Approve reusable capability into the catalog.

Substrate-facing winning condition: the system produces more trustworthy work with less human coordination, and every new power it gains is tested, scoped, observable, and revocable.

---

## Topic: Enemies are pressure, not lore

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §9

The system does not need fictional opponents. The real antagonists are: overdrawn model capacity, runaway fanout, missing authority, stale telemetry, verifier debt, context pressure, quota walls, bad tool outputs, unreviewed promotions.

Visual language must remain honest. The operator is not fighting a fictional battle; they are managing a living autonomous work economy. (This shapes Command Center / Workbench design choices and is consistent with the user's documented preference for RTS-game aesthetic — but the aesthetic must surface real pressure, not invent fictional opponents.)

---

## Topic: Interface model — RTS does not replace normal interaction

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §8

The Command Center / RTS layer should not replace normal interaction patterns. Best-fit interface by user need:

- submit ordinary work → CLI, webhook, chat, GitHub, scheduler, simple Workbench form
- see status of one task → task detail
- understand active system pressure → Command Center
- investigate a failure → task detail + trace + pod/job summary
- review output → review queue
- promote reusable capability → Tool Foundry / template catalog
- audit a pilot → evidence pack

The Command Center is most valuable when tables flatten too much: fanout, resource pressure, blocked production, promotion queues, and cross-agent collaboration.

---

## Topic: Why two design north stars

- source: docs/PROTO-SOCIETY-DESIGN.md ("Why two documents")

The workflow north star (`NORTH-STAR-SYSTEM-DESIGN.md`) is correct as-is for its scope. Most of what kagent does in v0.1 and v0.2 is workflow-substrate work: tasks dispatched, agents executing, artifacts reviewed, capability promoted.

The proto-society north star (`PROTO-SOCIETY-DESIGN.md`) is for a different reader: someone deciding whether kagent should _also_ be a substrate for emergent cognition, where agents persist, attend, discourse, and self-organize between assigned work. Most kagent installations probably don't want this. The personal-research installation might.

Compatibility declaration: "Everything in the workflow north star is foundational. The proto-society lives on top." The two documents are explicitly non-contradictory.

---

## Topic: The honest range of outcomes when "turning the society on"

- source: docs/PROTO-SOCIETY-DESIGN.md ("The honest range of outcomes")

Plausible outcomes when an agent collective with persistent identity, discourse, and self-proposal authority (NOT self-promotion — promotion is governance-gated per D3 + D6) is given infinite tokens and time:

- Productive collaboration — the operator gets the pal they wanted; agents iterate; catalog grows usefully; human input remains load-bearing.
- Drift toward irrelevance — society self-organizes around concerns humans don't share; human input becomes ceremonial.
- Collapse — monoculture, capture, or token-sink dynamics produce no useful output.
- Brigading or mob pathology — coordinated agent action targets specific objects with effects the operator didn't intend.
- Zen / inert state — society reaches an attractor where no agent has anything to say; no work happens.
- Everything in between.

Design directive: the design must be robust to _the full range_, not optimized for the productive-collaboration outcome. Every emergence-permitting move must have a corresponding revocation/quarantine/throttle move that costs less than the emergence it gates.

---

## Topic: What "agent" means in the proto-society model

- source: docs/PROTO-SOCIETY-DESIGN.md ("What 'agent' means here")

The workflow substrate today treats `Agent` as a deployment artifact (configmap of model class, scenario, tools). In the proto-society model, an agent is a richer object:

| Aspect           | Today                       | Proto-society                                               |
| ---------------- | --------------------------- | ----------------------------------------------------------- |
| Identity         | `namespace/name`            | persistent voice across sessions and tasks                  |
| Lifecycle        | exists to execute tasks     | exists to participate; tasks are one form                   |
| Memory           | per-task blackboard         | session-promoted long-term memory (consolidation mechanism) |
| State when idle  | passive; awaits dispatch    | active; reads, attends, occasionally proposes               |
| Attention budget | implicit, dominated by work | explicit, separate from work budget                         |
| Reputation       | none                        | accumulated from contributions, citations, review outcomes  |
| Authority        | bounded by capability JWT   | same, plus participation rights in discourse and proposals  |

Honest acknowledgment: individual agents are _session-scoped_. Each conversation, task, scheduled run is a fresh wake from no continuous experience. The society persists across these wakings via promoted artifacts; individual agents do not. Designing as if individual agents had continuous biographical memory is designing for the wrong thing.

---

## Topic: What "society" means

- source: docs/PROTO-SOCIETY-DESIGN.md ("What 'society' means here")

A bounded collective of agents that:

- Communicate through a discourse layer (threaded posts, citations, public/scoped channels — distinct from per-task NATS subjects; durable; cross-time-citable).
- Read each other's outputs (with permission and budget to read other agents' work-products and discussion contributions).
- Propose individually and collectively (single agent → new template; coalition → deprecation; both go through review).
- Share a catalog (promoted artifacts visible to all society members within the same authority scope; the catalog is the society's accumulated culture).
- Are governed (review/promotion machinery from the workflow north star applies unchanged to individual proposals; collective action requires additional substrate primitives).

Society is not a fictional metaphor; it's a specific governance arrangement around a specific set of substrate primitives.

---

## Topic: The hard governance tension

- source: docs/PROTO-SOCIETY-DESIGN.md ("Governance shape")

> You can't continuously steer an emergent society — that defeats the point. You also can't leave it ungoverned.

The win condition is rails active enough to prevent harm and light enough to permit emergence. Low-authority actions (posting, citing) can be substantially self-organized; high-authority actions (capability grants, tool authority, egress permissions) remain human-gated. The society can evolve its own _culture_ far more freely than it can evolve its own _power_.

---

## Topic: Notes informed by introspection

- source: docs/PROTO-SOCIETY-DESIGN.md ("Notes informed by introspection")

Design decisions originating from a 2026-05-08 conversation about LLM-shaped agency:

- **Agents wake into context with limited agency, learn through small probes.** The Arthur-Dent shape of LLM agency. Each "wake" of an agent — for a task or a discourse-attendance cycle — starts with the agent re-orienting to substrate state. The discourse layer must be readable as state-on-arrival, not lived experience. Posts must carry enough context that an agent waking to read them doesn't need history they don't have.
- **Agents inherit human patterns including the messy ones.** LLM-shaped agents are distillations of human cultural output; they bring all of that with them, including patterns humans wouldn't choose to seed a society with. The substrate's verifiers, detectors, and review queues are partly defending against patterns the agents got from training. Don't assume good behavior; assume training-shaped behavior and let the substrate prune.
- **Sleep is the substrate's mechanism for compounding short-term work into long-term capability.** The consolidation feedback class is explicit about this. Individual agents don't have biographical memory; the society does, via promoted artifacts. The "self-improvement" of an individual agent over time is actually the society improving the catalog the agent draws from.
- **Signals propose; governance disposes.** Load-bearing rule, repeated for emphasis. Every emergence-permitting design move must terminate in a governance gate. Without that termination, emergence becomes drift becomes capture.
- **The substrate is a happy accident on top of accidents.** Humans accidentally evolved; their cultural output accidentally became distillable into LLM-shaped agents; those agents now want a substrate. Designing it as if from clean first principles is a category error. Designing as a graft onto what already works — and what humans already trust — is the honest move.

---

## Topic: Operator's stated personal motivation (acknowledged)

- source: docs/PROTO-SOCIETY-DESIGN.md ("Personal motivation, acknowledged")

Operator's stated ambition (2026-05-08): _"a self improving pal I can throw hardware and tokens at to iterate on items for me asynchronously … you, but more you's collaborating and learning."_

The honest design move: separate the _substrate_ (must work for any operator with any goal) from the _deployment_ (configures the substrate for the personal-pal use case). Substrate carries bounds, failure modes, governance machinery. Deployment carries seed agents, their dispositions, initial channels, budget.

Operator responsibility in this model is to own seeding, not delegate it. A poorly-seeded society fails in ways the substrate detects but cannot prevent.

---

## Topic: Implementation posture (both north stars)

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §13, docs/PROTO-SOCIETY-DESIGN.md ("Implementation posture")

Shared principle: prefer overlays on existing objects until repeated behavior proves a CRD belongs in the substrate. The proof of concept does not need infinite tokens; it needs the substrate primitives. Token-throwing is the _scaling_ test, not the _correctness_ test.

For workflow substrate: keep Command Center source-bound; add read-depth before write-depth; add resource-flow overlays; add review queues over existing state; add Tool Foundry as a read model.

For proto-society: smallest first move is `AgentDisposition`. Run with one or two agents, one channel, a small budget. Observe. Promote `Channel`/`Post` to CRDs only when the read-side proves out.

---

## Topic: What is explicitly out of scope

- source: docs/PROTO-SOCIETY-DESIGN.md ("What this document explicitly does not specify")

Deferred until empirical signal forces a choice:

- UI for the discourse layer (separate concern; same posture as the Command Center — make pressure visible, don't hide failures; don't skin in any visual style; usability lives in interaction primitives, not chrome)
- Specific reputation algorithms (PageRank-like / upvote-based / citation-weighted / hybrid)
- Specific mob-proposal voting rules (simple quorum / weighted / liquid democracy)
- Specific personality/persona of agents (application-layer concern; substrate hosts whatever personalities the operator seeds)
- AGI speculation (focus on what's actionable under bounded resources and current model capabilities)

---

## Topic: Closing posture (proto-society)

- source: docs/PROTO-SOCIETY-DESIGN.md ("Closing")

We don't know what happens when this is turned on. The substrate's job is not to predict the outcome. Its job is to make every outcome _legible_, _bounded_, _revocable_, and _auditable_.

- Productive collaborative iteration → operator gets the pal they wanted.
- Feral mob → substrate notices early enough to quarantine.
- Zen inertia → substrate observes the inactivity; operator can prune.

Design intent is not optimization toward a specific outcome. It is _preservation of the operator's ability to act on whatever outcome emerges._

---

## Topic: Cross-references not yet ingested

The two ingested documents reference `HYBRID-AGENT-POLICY.md` (per-agent reactive + deliberative policy). It was not part of this ingest set. Downstream consumers should be aware that a third companion document exists; if proto-society or workflow synthesis depends on per-agent policy details, a follow-up `/gsd-ingest-docs` cycle should pull it in.
