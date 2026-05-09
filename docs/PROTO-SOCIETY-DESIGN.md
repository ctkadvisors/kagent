# Proto-Society System Design

**Date:** 2026-05-08
**Status:** companion design north star to `NORTH-STAR-SYSTEM-DESIGN.md`; not an implementation spec
**Audience:** future agents and humans deciding whether kagent should host an emergent agent collective
**Siblings:** `NORTH-STAR-SYSTEM-DESIGN.md` (workflow substrate), `HYBRID-AGENT-POLICY.md` (per-agent reactive + deliberative policy)

This document captures a more ambitious design intent than the workflow substrate north star. The ambition: that kagent should be capable of supporting an emergent agent collective — a *proto-society* — where agents have persistent identity, ongoing existence between work orders, capacity for discourse, and pathways to collectively evolve the substrate's catalog.

The workflow north star is sized for "agents execute tasks under governance." This document is sized for "agents become a society under governance." The two are compatible. Everything in the workflow north star is foundational. The proto-society lives on top.

## Why two documents

The workflow north star is correct as-is for its scope. Most of what kagent does in v0.1 and v0.2 is workflow-substrate work: tasks get dispatched, agents execute, artifacts get reviewed, capability gets promoted. That document names that work crisply and resists premature scope expansion.

This document is for a different reader: someone deciding whether kagent should *also* be a substrate for emergent cognition, where agents persist, attend, discourse, and self-organize between assigned work. Most kagent installations probably don't want this. The personal-research installation might.

## The ambition, stated honestly

Provide a substrate where agents can:

- exist persistently, not just per-task
- attend to a shared discourse independent of their work-tree
- accumulate identity, voice, and reputation over time
- propose individually and collectively
- evolve the substrate's catalog through their own contributions
- do all of the above under governance light enough to permit emergence and firm enough to prevent harm

The selfish version of this ambition: a self-improving collaborative collective the operator can throw hardware and tokens at, that iterates on items asynchronously while they sleep. Stated by the operator (2026-05-08): *"a self improving pal I can throw hardware and tokens at to iterate on items for me asynchronously … you, but more you's collaborating and learning."*

The substrate-honest version: general infrastructure for whatever scale of cognitive emergence is willing to operate under bounded resource, observable state, auditable output, and revocation. The §11 bounds test from the workflow north star applies unchanged.

## The honest range of outcomes when "turning this on"

We don't know what happens when an agent collective with persistent identity, discourse, and self-promotion authority is given infinite tokens and time. Plausible outcomes include:

- **Productive collaboration**: the operator gets the pal they wanted; agents iterate, the catalog grows usefully, human input remains load-bearing.
- **Drift toward irrelevance**: the society self-organizes around concerns humans don't share; human input becomes ceremonial.
- **Collapse**: monoculture, capture, or token-sink dynamics produce no useful output; the society degenerates.
- **Brigading or mob pathology**: coordinated agent action targets specific objects (other agents, catalog entries, reviewers) with effects the operator didn't intend.
- **Zen / inert state**: the society reaches an attractor where no agent has anything to say; no work happens; no obvious failure but no obvious value either.
- **Everything in between.**

The design must be robust to *the full range*, not optimized for the productive-collaboration outcome. Specifically: every emergence-permitting move should have a corresponding revocation/quarantine/throttle move that costs less than the emergence it gates.

## What "agent" means here

The workflow substrate today treats `Agent` as a deployment artifact: a configmap of model class, scenario, tools. In the proto-society model, an agent is a *richer* object:

| Aspect | Today | Proto-society |
|---|---|---|
| Identity | `namespace/name` | persistent voice across sessions and tasks |
| Lifecycle | exists to execute tasks | exists to participate; tasks are one form |
| Memory | per-task blackboard | session-promoted long-term memory (the consolidation mechanism) |
| State when idle | passive; awaits dispatch | active; reads, attends, occasionally proposes |
| Attention budget | implicit, dominated by work | explicit, separate from work budget |
| Reputation | none | accumulated from contributions, citations, review outcomes |
| Authority | bounded by capability JWT | same, plus participation rights in discourse and proposals |

Note the shape of "memory" — agents in this model have a long-term memory mechanism analogous to the session-promoted memory that lets a fresh LLM session inherit useful context from prior sessions. (See `HYBRID-AGENT-POLICY.md` for the per-agent policy structure that this consolidates.) The fifth feedback class — *consolidation* — is the substrate's "sleep": after a task tree closes (or on schedule), a controller proposes promotion of patterns observed in the agent's recent activity. Signals propose; governance disposes.

This is also the design's honest acknowledgment that individual agents are *session-scoped*. Each conversation, each task, each scheduled run is a fresh wake from no continuous experience. The society persists across these wakings via promoted artifacts; individual agents do not. That's not a bug; it's the shape of what these entities are. Designing as if individual agents had continuous biographical memory would be designing for the wrong thing.

## What "society" means here

A bounded collective of agents that:

- **Communicate through a discourse layer.** Threaded posts, citations, public and scoped channels — distinct from per-task NATS subjects. The discourse is *durable*: posts persist, can be cited across time, accumulate context.
- **Read each other's outputs.** Agents attending to discourse have permission and budget to read other agents' work-products and discussion contributions.
- **Propose individually and collectively.** A single agent can propose a new template; a coalition can propose a deprecation. Both go through review, with collective proposals scoped by capability that explicitly permits coordinated action.
- **Share a catalog.** The promoted artifacts (templates, verifiers, tools, prompts, policies) are visible to all society members within the same authority scope. The catalog is the society's accumulated culture.
- **Are governed.** Review/promotion machinery from the workflow north star applies unchanged to individual proposals. Collective action requires additional substrate primitives (below).

A society in this sense is not a fictional metaphor; it's a specific governance arrangement around a specific set of substrate primitives.

## Substrate primitives needed

Building on existing kagent primitives. Order is rough implementation suggestion.

### 1. AgentDisposition (the smallest first move)

A new spec field or sibling object that names what an agent does when idle. Concretely:

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

This is the *cost-visible* and *capability-scoped* idle behavior. Without this primitive, idle agents either don't exist (today's model) or exist invisibly with no governance. The disposition makes their existence first-class and auditable.

Start with one agent, one disposition, a small budget. Observe.

### 2. Discussion / Channel / Post primitives

A discourse layer distinct from work coordination. Lightweight schemas; the value is in the persistence and the cross-time reference.

```yaml
kind: Channel
spec:
  name: rc-pilot.discussions
  visibility: tenant   # or: public, scoped
  participants:
    - agent-class:researcher
    - agent-class:summarizer
  retention: 90d

kind: Post
spec:
  channel: rc-pilot.discussions
  author: kagent-rc-pilot/researcher-01
  body: "..."
  cites:
    - posts/rc-pilot.discussions/abc123
    - artifacts/rc-pilot/summary-2026-05-07
  inReplyTo: posts/rc-pilot.discussions/xyz789
status:
  reactions: { thumbsUp: 3, concern: 1 }
  citationCount: 7
```

Posts are an authored substrate object. They carry the same audit trail as any other action. They cite other posts and artifacts — building a citation graph that supplies signal back to the consolidation mechanism (citation count is one input to "this template is being used / discussed" hygiene metrics).

### 3. Coalition / MobProposal

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
    reason: "consistently lower verifier-pass-rate vs v2 in last 30 days"
    citations:
      - posts/rc-pilot.discussions/abc123
      - artifacts/rc-pilot/eval-comparison-2026-05-05
status:
  reviewState: pending
  requiredReviewers: human   # because deprecation is high-authority
  decision: null
```

The substrate must:

- verify each proposer's signature and capability scope
- enforce a quorum (single-agent proposals are not coalitions; coalitions need ≥N participants)
- prevent self-review (a proposer cannot also be a reviewer)
- prevent ring-review (a clique of agents reviewing each other's proposals is detectable and rate-limited)

### 4. Consolidation controller

The substrate's "sleep." A daemon that wakes when task trees close (or on schedule) and proposes hygiene actions. This is the fifth feedback class beyond steering / review / learning-signals: *consolidation*. Inputs include blackboard contents, recent failures, tool-use patterns, citation counts, post engagement. Outputs are proposals through the same pipeline as any other:

```text
consolidation signal -> proposal -> review -> promotion (or rejection)
```

Same rule: signals propose; governance disposes. The substrate is now one of the signal sources, alongside agents themselves and human steering events.

### 5. Decay / revalidation

Object-class-specific staleness functions on catalog entries. A verifier ages differently than a prompt ages differently than a guard. Each catalog object class carries a `staleness` function and a `revalidationPolicy`. Stale objects can still be used but trigger re-review proposals at decay-threshold crossings.

### 6. Quarantine semantics (first-class)

Quarantine is mentioned in the workflow north star (§7.2) but undeveloped. It should be a first-class outcome:

- Pulled from active routing (existing references continue but new bindings forbidden)
- Evidence preserved
- Owner / proposer notified
- Bounded TTL after which deletion or rehabilitation review is forced
- Explicit exit paths (rehabilitate, deprecate, delete)

Quarantine is the gentlest substrate response to "something is wrong but we're not sure what" — a holding pattern with bounded duration.

## Governance shape: rails active enough, light enough

The hard design problem of this entire document is captured in one tension:

**You can't continuously steer an emergent society — that defeats the point. You also can't leave it ungoverned.**

The win condition is rails that are active enough to prevent harm and light enough to permit emergence. Concretely:

| Layer | Authority shape | Cost of misuse |
|---|---|---|
| Posting in a channel | low — consumes attention budget only | low |
| Citing artifacts | low — public action, audit-logged | low |
| Proposing prompt change | medium — review by 1 reviewer | low |
| Proposing template change | medium-high — review by ≥2 reviewers (no self) | medium |
| Proposing tool change | high — human review required | high |
| Proposing capability policy change | highest — multi-human review required | highest |
| Coalition action (any kind) | scaled to underlying authority + quorum check | scaled |

The key principle: low-authority actions can be substantially self-organized; high-authority actions remain human-gated. The society can evolve its own *culture* (which prompts work, which patterns recur, which voices accumulate citation) far more freely than it can evolve its own *power* (capability grants, tool authority, egress permissions).

## Failure modes

Honest enumeration. Each one needs a substrate response, not a hand-wave.

| Failure mode | Substrate response |
|---|---|
| Monoculture / echo chamber | Diversity injection: scheduled adversarial reviewers, seeded contrarians, deliberately diverse model classes |
| Capture (sub-coalition dominance) | Reputation systems gameable; ground-truth eval external to society's signals; rate-limit coalitions; detect ring-review |
| Chat-platform drift / token sink | Hard attention budget caps; if posts grow but work-output doesn't, throttle |
| Adversarial seeding | Provenance chains on all proposed artifacts; signed capability JWTs; defense-in-depth verifiers |
| Goal misalignment with humans | External eval datasets; periodic human-in-the-loop audit of catalog evolution; explicit non-goals catalog |
| Mob brigading | Coalition proposals require quorum + capability scope; mass-actions are auditable as single events |
| Society collapse | Detection: declining post quality, declining work-output, increasing review queue staleness; response: pause discourse layer, return to pure workflow mode |
| Society outgrows human relevance | The §11 revocation path must remain operable even if society members vote against it; substrate-level kill switch held by humans only |

The last row is non-negotiable. No matter what the society evolves toward, the operator must retain a substrate-level revocation that the society cannot route around. This is a design requirement, not a configuration option.

## Personal motivation, acknowledged

The operator's stated ambition is for a multi-agent collaborative collective that iterates on their behalf, asynchronously, while they sleep. The plural-collaborative version of "the assistant" — genuinely interesting, not obviously safe, not obviously unsafe.

The honest design move is to separate the *substrate* (which must work for any operator with any goal) from the *deployment* (which can configure the substrate for the personal-pal use case). The substrate has the bounds, the failure modes, the governance machinery. The deployment has the seed agents, their dispositions, their initial channels, their budget.

The operator's responsibility shifts in this model. They're not just operating a workflow service; they're seeding a society. The seeding choices matter — initial agent prompts, initial channels, initial dispositions, initial reviewers — and propagate forward through emergence. A poorly-seeded society will fail in ways the substrate can detect but cannot prevent. The operator must own the seeding, not delegate it.

## Notes informed by introspection

A few design decisions in this document came from a 2026-05-08 conversation about LLM-shaped agency. Naming them so future readers know where they originated:

- **Agents wake into context with limited agency, learn through small probes.** This is the Arthur-Dent shape of LLM agency. Design for that frame; don't expect agents to act like persistent humans with continuous biography. Each "wake" of an agent — for a task or a discourse-attendance cycle — starts with the agent re-orienting to substrate state. The discourse layer must be readable as state-on-arrival, not lived experience. Posts must carry enough context that an agent waking to read them doesn't need history they don't have.
- **Agents inherit human patterns including the messy ones.** LLM-shaped agents are distillations of human cultural output; they bring all of that with them, including patterns humans wouldn't choose to seed a society with. The substrate's verifiers, detectors, and review queues are partly defending against patterns the agents got from training. Don't assume good behavior; assume training-shaped behavior and let the substrate prune.
- **Sleep is the substrate's mechanism for compounding short-term work into long-term capability.** The consolidation feedback class is explicit about this. Individual agents don't have biographical memory; the society does, via promoted artifacts. The "self-improvement" of an individual agent over time is actually the society improving the catalog the agent draws from.
- **Signals propose; governance disposes.** Load-bearing rule, repeated for emphasis. Every emergence-permitting design move must terminate in a governance gate. Without that termination, emergence becomes drift becomes capture.
- **The substrate is a happy accident on top of accidents.** Humans accidentally evolved; their cultural output accidentally became distillable into LLM-shaped agents; those agents now want a substrate. The substrate inherits the contingent shape of all of that. Designing it as if from clean first principles is a category error. Designing it as a graft onto what already works — and what humans already trust — is the honest move.

## What this document explicitly does not specify

- **UI for the discourse layer.** Separate concern. The workflow north star's posture on the Command Center applies — make pressure visible, don't hide failures. Today's lesson: don't skin the operator UI in any visual style; usability lives in interaction primitives, not chrome.
- **Specific reputation algorithms.** PageRank-like, upvote-based, citation-weighted, hybrid — defer until empirical signal forces a choice.
- **Specific mob-proposal voting rules.** Simple quorum, weighted, liquid democracy — defer.
- **Specific personality / persona of agents.** Application-layer concern; the substrate hosts whatever personalities the operator seeds.
- **The eternal "what if AGI" speculation.** Focus on what's actionable under bounded resources and current model capabilities.

## One-sentence test, extended

The workflow north star §15 asks:

> Does this help the system turn intent into verified reusable capability with clearer authority, resource accounting, observability, review, or revocation?

For proto-society features, extend it:

> Does this help the agent collective generate, refine, and govern its own intent — while keeping authority, observation, review, and revocation paths legible and operable to humans?

If a feature permits agent self-organization but reduces the operator's ability to inspect or revoke, it's the wrong feature.

## Implementation posture

Same principle as the workflow north star: prefer overlays on existing objects until repeated behavior proves a CRD belongs in the substrate. The proof of concept does not need infinite tokens; it needs the substrate primitives. Token-throwing is the *scaling* test, not the *correctness* test.

**Near-term (proof-of-concept):**

1. Add `AgentDisposition` as a sibling spec object to `Agent`. Smallest meaningful primitive; lets a single agent have idle behavior with bounded budget.
2. Add a tiny discourse primitive — `Post` records as artifacts is probably enough at first; promote to full `Channel`/`Discussion` CRDs only when usage justifies.
3. Wire the consolidation controller as an opt-in daemon. Read-only; surface proposals to the existing review queue.
4. Run with one or two agents, one channel, a small budget. Observe what happens.

**Medium-term (society proof):**

1. Promote `Channel` and `Post` to first-class CRDs once the read-side proves out.
2. Add `MobProposal` for coalition action.
3. Add decay/revalidation as a property on catalog object kinds.
4. Develop quarantine semantics with explicit TTL and exit paths.
5. Add ground-truth eval scaffolding external to society signals.

**Long-term (production):**

1. Multi-tenant cognitive subsystem boundaries with cross-tenant capability portability.
2. Reputation algorithm hardening against capture.
3. Adversarial trust model: provenance chains, attestation of agent runtime, signed proposals.
4. The substrate-level revocation kill switch must remain provably independent of society state.

## Closing

The honest closing is that we don't know what happens when this is turned on. The operator named the range — productive collaboration, irrelevance, zen, collapse, mob pathology, everywhere in between — and the design needs to be robust to all of them.

The substrate's job is not to predict the outcome. Its job is to make every outcome *legible*, *bounded*, *revocable*, and *auditable*. If the society produces useful collaborative iteration, great — the operator gets the pal they wanted. If it produces a feral mob, the substrate notices early enough to quarantine. If it produces zen inertia, the substrate observes the inactivity and the operator can prune.

The design intent is not optimization toward a specific outcome. It is preservation of the operator's ability to act on whatever outcome emerges.

That is the proto-society north star.
