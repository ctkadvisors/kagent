# Constraints

> **Re-steered 2026-05-09 PM.** Constraints below were extracted from the two SPEC-tagged design north stars during the 2026-05-09 ingest. After the 2026-05-09 PM re-steering, both north stars are treated as **candidate inputs**, not commitments. The proto-society schema sketches (`C-agent-disposition`, `C-discourse-primitives`, `C-mob-proposal`, `C-consolidation`, `C-decay`, `C-quarantine`, `C-governance-tiers`, `C-failure-modes`) are **future-research target shapes**, not v0.2 commitments. Active v0.2 work uses overlay-shaped representations on existing v0.1 substrate; see `.planning/REQUIREMENTS.md` §1. Synthesized outputs use **CoalitionProposal** (not "MobProposal"); the constraint ID `C-mob-proposal` is retained in this file as a source-quote artifact, but the synthesized name is **CoalitionProposal**.

Constraints extracted from the two SPEC-tagged design north stars. Both ingested at SPEC precedence (manifest-honored, non-locked). Schema-shaped substrate primitives are recorded as `protocol`/`schema` constraints; resource and governance bounds as `nfr`; loop and aggregation contracts as `protocol`.

---

## C-substrate-layers — System layers

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §2 (System layers)
- type: protocol

Six-layer model. Every interface must create or inspect the same substrate objects across all layers; a task created from chat, webhook, CLI, or canvas must produce the same task graph, traces, artifacts, and audit trail.

Layers:

1. Channels — where intent enters and results return (CLI, webhook, scheduler, GitHub, chat, Workbench)
2. Work orders — canonical unit of requested work (`AgentTask`, `AgentWorkflow`)
3. Colony — specialized execution nodes collaborating through substrate objects (Agents, child tasks, events, blackboard, artifacts)
4. Economy — continuous resource flows and constraints (model capacity, tokens/min, pod slots, storage, quota)
5. Governance — authority and promotion control (capability JWTs, verifiers, audit, human review)
6. Human map — situational awareness and intervention (Command Center, task detail, foundry, evidence views)

---

## C-game-loop — Substrate loop contract

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §3 (The game loop)
- type: protocol

```
Intent -> Work -> Evidence -> Review -> Promotion -> Better Future Work
```

Every promotable capability transits this loop. No path may skip Evidence or Review.

---

## C-flow-economy — Flow economy resource model

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §4 (Flow economy)
- type: nfr

Operational metaphor is a _flow_ economy, not a _purchase_ economy. Tasks consume model capacity, context, pod slots, tool bandwidth, and artifact I/O over time. When supply exceeds demand, work cooks smoothly. When demand exceeds supply, work stalls, meters, queues, or fails with a substrate reason.

Flows tracked:

- model power — gateway/model endpoint capacity by model class (pressure: 429s, Retry-After, in-flight cap)
- token flow — prompt/output usage over time (pressure: cost overrun, context pressure)
- build power — agent concurrency and child fanout (pressure: too many in-flight tasks)
- pod capacity — schedulable Kubernetes execution (pressure: unschedulable, image pull, node pressure)
- artifact bandwidth — CAS/workspace read/write pressure (pressure: missing output, slow downstream consumers)
- authority — capability grants for tools/models/spawn/egress (pressure: policy denial)
- trust — verifier, detector, audit cleanliness (pressure: blocked promotion)
- attention — human review capacity (pressure: stale review queue)

Constraint: Command Center must make these flows visible. A base that is "all busy" can be losing if low-value work saturates model power or fills the review queue.

---

## C-parent-child — Collaboration pattern (parent/child/N-child)

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §5 (Collaboration pattern)
- type: protocol

```
root task
  -> parent agent
      -> child task A
      -> child task B
      -> child task C
  -> aggregate
  -> verify
  -> artifact
```

Pattern stays safe only when:

- child task creation is capability-scoped
- fanout has depth and concurrency limits
- children write artifacts and status, not private side-channel state
- parent aggregation is visible in `AgentTask.status`
- failures are substrate-attributed
- retries are bounded and auditable

Authority rule: agents may _request_ children; the substrate decides whether those children are allowed to exist.

---

## C-promotion-loop — Self-improvement / promotion loop

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §6 (Self-improvement pattern)
- type: protocol

Promotion path:

```
candidate artifact
  -> verifier/tests/security/egress review
  -> human or policy approval
  -> versioned catalog object
  -> capability grant
  -> future tasks may use it
```

Promotion targets, in increasing authority risk:

- Prompt / versioned instruction (low risk)
- AgentTemplate (medium)
- Verifier (medium)
- Workflow (medium-high)
- Tool (high)
- Capability policy (highest)

Substrate rule: agents and workflows may _propose_ new capability; they may not self-promote new authority.

Recommendation (implementation posture): start with artifacts, verifier status, and `AgentTemplate` promotion. Do not add a general `Tool` CRD until a real candidate tool forces the design.

---

## C-feedback-classes — Feedback classes (steering/review/learning)

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §7
- type: protocol

Three feedback classes (workflow substrate):

- Steering — human or workflow input; changes priority, budget, route, retry, cancel, model class
- Review — human, verifier, or evaluator decision; accept/reject result or promotion candidate
- Learning signal — substrate telemetry; updates future defaults, prompts, tests, or routing policy

Constraint: learning signals never mutate authority directly. They inform future proposals.
Rule: `signals may propose; governance disposes`.

(See `C-consolidation` for the additional feedback class introduced by the proto-society north star.)

---

## C-steering-event — SteeringEvent shape (sketch)

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §7.1
- type: schema

Initial implementation may be annotations or existing API actions. CRD proposed only after first two or three steering actions prove the shape.

Minimum fields if/when promoted to a CRD:

```yaml
kind: SteeringEvent
spec:
  target:
    kind: AgentTask
    namespace: kagent-system
    name: example
  intent: raise_priority # raise/lower priority, cancel/pause tree, retry with different model class, request child split, extend budget, force human review
  reason: 'customer-visible task'
  requestedBy: 'user@example.com'
  expiresAt: '2026-05-08T22:00:00Z'
status:
  accepted: true
  appliedAt: '...'
  auditEventId: '...'
```

---

## C-review-record — Review record contract

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §7.2
- type: schema

A review must capture:

- target object
- reviewer identity
- decision: accept | reject | request changes | quarantine
- reason
- expiration or follow-up task
- audit event id

Reviewable objects: terminal task results, verifier failures, suspicious detector flags, candidate tool artifacts, candidate AgentTemplates, proposed capability grants, proposed egress/domain additions, workflow promotions.

---

## C-bounds — Inclusion bounds (the §11 test)

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §11 (Bounds); reinforced in docs/PROTO-SOCIETY-DESIGN.md ("The ambition, stated honestly")
- type: nfr

Something belongs inside the system only if it can be represented as:

```
declared capability
+ bounded resource drain
+ observable state transition
+ auditable output
+ revocation path
```

Physical hardware joins the system only when it has:

- declared actions
- declared resources
- telemetry
- failure modes
- capability policy
- audit trail
- shutdown or disable path

Applies equally to GPU nodes, browser pools, NAS storage, cameras, lab devices, or any future external actuator. The proto-society north star applies the same test to its primitives unchanged.

---

## C-north-star-objects — Object catalog and CRD policy

- source: docs/NORTH-STAR-SYSTEM-DESIGN.md §12 (North-star objects)
- type: schema

Durable concepts and their nearest substrate today:

- work order — `AgentTask`, `AgentWorkflow` (exists)
- candidate capability — `ArtifactRef` + verifier metadata (partial)
- review — future `TaskReview` or annotations (not yet)
- steering — future `SteeringEvent` or action API (partial via actions)
- promoted specialist — `AgentTemplate` (exists)
- promoted executable tool — future `Tool` CRD (not yet)
- reusable acceptance test — verifier contract (partial)
- economy snapshot — Workbench DTO over gateway/quota/task state (partial)

Policy: prefer overlays on existing objects until a concept repeats enough to justify a CRD.

---

## C-agent-disposition — AgentDisposition primitive (proto-society)

- source: docs/PROTO-SOCIETY-DESIGN.md (Substrate primitives needed §1)
- type: schema

Sibling spec object to `Agent`. Names what an agent does when idle. Cost-visible, capability-scoped.

```yaml
kind: AgentDisposition
spec:
  agentRef: kagent-rc-pilot/researcher-01
  idleBehavior:
    readChannels:
      - rc-pilot.discussions
      - kagent-system.proposals
    attentionBudget:
      tokensPerDay: 50000
      pollIntervalSeconds: 300
    proposalScope:
      mayProposeAgainst:
        - templates
        - verifiers
      maxProposalsPerDay: 3
status:
  spentTokensToday: 12450
  postsToday: 4
  proposalsToday: 1
```

Without this primitive, idle agents either don't exist (today) or exist invisibly with no governance. The disposition makes their existence first-class and auditable. Start with one agent, one disposition, a small budget.

---

## C-discourse-primitives — Channel / Post primitives (proto-society)

- source: docs/PROTO-SOCIETY-DESIGN.md (Substrate primitives needed §2)
- type: schema

Discourse layer is _distinct from_ per-task NATS subjects: posts persist, can be cited across time, accumulate context, and supply signal back to consolidation.

```yaml
kind: Channel
spec:
  name: rc-pilot.discussions
  visibility: tenant # or: public, scoped
  participants:
    - agent-class:researcher
    - agent-class:summarizer
  retention: 90d
```

```yaml
kind: Post
spec:
  channel: rc-pilot.discussions
  author: kagent-rc-pilot/researcher-01
  body: '...'
  cites:
    - posts/rc-pilot.discussions/abc123
    - artifacts/rc-pilot/summary-2026-05-07
  inReplyTo: posts/rc-pilot.discussions/xyz789
status:
  reactions: { thumbsUp: 3, concern: 1 }
  citationCount: 7
```

Implementation posture: start with `Post` records as artifacts; promote to full `Channel`/`Discussion` CRDs only when usage justifies.

---

## C-mob-proposal — CoalitionProposal / coalition action primitive (proto-society) — FUTURE RESEARCH

> **Synthesized name:** `CoalitionProposal`. The source document uses "MobProposal"; the constraint ID `C-mob-proposal` is retained as a source-quote artifact, but downstream synthesized outputs use `CoalitionProposal`. Status after 2026-05-09 PM re-steering: **future research, not v0.2 commitment**.

- source: docs/PROTO-SOCIETY-DESIGN.md (Substrate primitives needed §3)
- type: schema

Collective action requires substrate representation. A coalition is a set of agents that agree on a proposal; the proposal is the substrate object the review process acts on.

```yaml
kind: MobProposal
spec:
  proposers:
    - agent: researcher-01
      signature: ...
    - agent: researcher-02
      signature: ...
    - agent: summarizer-03
      signature: ...
  proposal:
    kind: TemplateDeprecation
    target: templates/legacy-summarizer-v1
    reason: 'consistently lower verifier-pass-rate vs v2 in last 30 days'
    citations:
      - posts/rc-pilot.discussions/abc123
      - artifacts/rc-pilot/eval-comparison-2026-05-05
status:
  reviewState: pending
  requiredReviewers: human # because deprecation is high-authority
  decision: null
```

Substrate enforcement obligations:

- verify each proposer's signature and capability scope
- enforce a quorum (single-agent proposals are not coalitions; coalitions need ≥N participants)
- prevent self-review (a proposer cannot also be a reviewer)
- prevent ring-review (a clique of agents reviewing each other's proposals is detectable and rate-limited)

---

## C-consolidation — Consolidation controller (proto-society "sleep")

- source: docs/PROTO-SOCIETY-DESIGN.md (Substrate primitives needed §4)
- type: protocol

A daemon that wakes when task trees close (or on schedule) and proposes hygiene actions. Adds a feedback class beyond steering / review / learning-signals: _consolidation_. Inputs: blackboard contents, recent failures, tool-use patterns, citation counts, post engagement. Outputs: proposals through the same pipeline as any other:

```
consolidation signal -> proposal -> review -> promotion (or rejection)
```

Same load-bearing rule: signals propose; governance disposes. The substrate is now one of the signal sources, alongside agents themselves and human steering events.

Implementation posture: opt-in daemon, read-only initially; surface proposals to the existing review queue.

---

## C-decay — Decay / revalidation policy on catalog objects (proto-society)

- source: docs/PROTO-SOCIETY-DESIGN.md (Substrate primitives needed §5)
- type: nfr

Object-class-specific staleness functions on catalog entries. A verifier ages differently than a prompt ages differently than a guard. Each catalog object class carries:

- a `staleness` function
- a `revalidationPolicy`

Stale objects can still be used but trigger re-review proposals at decay-threshold crossings.

---

## C-quarantine — Quarantine semantics (first-class)

- source: docs/PROTO-SOCIETY-DESIGN.md (Substrate primitives needed §6); originates as undeveloped concept in docs/NORTH-STAR-SYSTEM-DESIGN.md §7.2
- type: protocol

Quarantine is the gentlest substrate response to "something is wrong but we're not sure what" — a holding pattern with bounded duration.

Required behavior:

- Pulled from active routing (existing references continue but new bindings forbidden)
- Evidence preserved
- Owner / proposer notified
- Bounded TTL after which deletion or rehabilitation review is forced
- Explicit exit paths: rehabilitate, deprecate, delete

---

## C-governance-tiers — Authority / governance tiers (proto-society)

- source: docs/PROTO-SOCIETY-DESIGN.md (Governance shape: rails active enough, light enough)
- type: nfr

Authority-by-action table. Low-authority actions can be substantially self-organized; high-authority actions remain human-gated.

| Layer                              | Authority shape                                | Cost of misuse |
| ---------------------------------- | ---------------------------------------------- | -------------- |
| Posting in a channel               | low — consumes attention budget only           | low            |
| Citing artifacts                   | low — public action, audit-logged              | low            |
| Proposing prompt change            | medium — review by 1 reviewer                  | low            |
| Proposing template change          | medium-high — review by ≥2 reviewers (no self) | medium         |
| Proposing tool change              | high — human review required                   | high           |
| Proposing capability policy change | highest — multi-human review required          | highest        |
| Coalition action (any kind)        | scaled to underlying authority + quorum check  | scaled         |

Principle: the society can evolve its own _culture_ (which prompts work, which patterns recur, which voices accumulate citation) far more freely than it can evolve its own _power_ (capability grants, tool authority, egress permissions).

---

## C-failure-modes — Proto-society failure-mode taxonomy

- source: docs/PROTO-SOCIETY-DESIGN.md (Failure modes)
- type: nfr

Each failure mode requires a substrate response, not a hand-wave.

| Failure mode                      | Substrate response                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monoculture / echo chamber        | Diversity injection: scheduled adversarial reviewers, seeded contrarians, deliberately diverse model classes                                               |
| Capture (sub-coalition dominance) | Reputation systems gameable; ground-truth eval external to society's signals; rate-limit coalitions; detect ring-review                                    |
| Chat-platform drift / token sink  | Hard attention budget caps; if posts grow but work-output doesn't, throttle                                                                                |
| Adversarial seeding               | Provenance chains on all proposed artifacts; signed capability JWTs; defense-in-depth verifiers                                                            |
| Goal misalignment with humans     | External eval datasets; periodic human-in-the-loop audit of catalog evolution; explicit non-goals catalog                                                  |
| Mob brigading                     | Coalition proposals require quorum + capability scope; mass-actions are auditable as single events                                                         |
| Society collapse                  | Detection: declining post quality, declining work-output, increasing review queue staleness; response: pause discourse layer, return to pure workflow mode |
| Society outgrows human relevance  | The §11 revocation path must remain operable even if society members vote against it; substrate-level kill switch held by humans only                      |

The last row is non-negotiable. No matter what the society evolves toward, the operator must retain a substrate-level revocation that the society cannot route around. Design requirement, not configuration option.

---

## C-substrate-vs-deployment — Separation of substrate and deployment

- source: docs/PROTO-SOCIETY-DESIGN.md ("Personal motivation, acknowledged")
- type: nfr

The substrate must work for any operator with any goal. Deployments configure the substrate for specific use cases (e.g., the personal-pal seed).

- Substrate carries: bounds, failure modes, governance machinery
- Deployment carries: seed agents, dispositions, initial channels, budget

Operator responsibility shifts in the proto-society model: they are seeding a society, not just operating a workflow service. Seeding choices propagate forward through emergence; the substrate detects but cannot prevent a poorly-seeded society from failing in characteristic ways. The operator must own the seeding, not delegate it.
