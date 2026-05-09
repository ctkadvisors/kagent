# kagent

## What This Is

kagent is a K3s-native, OSS, MIT-licensed agent-farm operator that composes Kata Containers + NATS JetStream + Node 22 + LiteLLM + Langfuse into a per-agent-microVM substrate. The workflow substrate (v0.1) is shipped: tasks are dispatched, agents execute in pods, artifacts are reviewed, capability is promoted under capability-JWT scope. The next milestone (v0.2) lays the smallest substrate primitives required for **emergent agent collectives** — a proto-society — to form on top of the workflow substrate, in dependency order.

## Core Value

The substrate turns intent into verified reusable capability under bounded resources, observable state, and revocable authority. Every new power the system gains is tested, scoped, observable, and revocable. **Signals propose; governance disposes.**

## Requirements

### Validated

<!-- Shipped and confirmed valuable as part of the v0.1 workflow substrate. Locked. -->

- ✓ Operator + AgentTask/AgentWorkflow/Agent/AgentTemplate CRDs — v0.1
- ✓ Per-agent pod runtime with capability-JWT auth — v0.1
- ✓ NATS JetStream A2A bus — v0.1
- ✓ LiteLLM gateway integration (Cloudflare AI Gateway default; Ollama opt-in) — v0.1
- ✓ Langfuse trace sink with GenAI semconv attributes — v0.1
- ✓ Workbench API + UI (RTS Command Center read-side) — v0.1
- ✓ Replay / evals / supervision / quotas / egress / locality / cache / keyrotation / versioning controllers — v0.1
- ✓ HTTP, MCP, in-process tool providers — v0.1
- ✓ Audit events + trace sinks across operator, gateway, pod paths — v0.1

### Active

<!-- v0.2 proto-society foundations. Each requirement maps to exactly one phase in ROADMAP.md. -->

See `.planning/REQUIREMENTS.md` for full v0.2 requirement list (DISP-_, DISC-_, CONS-_, MOB-_, DECAY-_, QUAR-_, REVOKE-_, PILOT-_).

Summary of active scope:

- [ ] AgentDisposition v0 — make idle agent behavior cost-visible and capability-scoped
- [ ] Discourse primitives — Channel/Post as artifacts; durable, citable, attention-budgeted
- [ ] Consolidation controller — read-only daemon that proposes hygiene actions to the existing review queue
- [ ] MobProposal — coalition action with signed quorum, no-self-review, ring-review detection
- [ ] Decay/revalidation policy — staleness function + revalidation policy per catalog-object class
- [ ] Quarantine semantics — first-class holding pattern with bounded TTL and explicit exit paths
- [ ] Substrate-level revocation kill-switch — proven independent of society state (non-negotiable)
- [ ] Pilot deployment — 1–2 agents, one channel, small budget, observe; opt-in to the proto-society layer

### Out of Scope (v0.2)

<!-- Explicit boundaries. Documented to prevent re-adding. -->

Workflow-substrate-level (from `NORTH-STAR-SYSTEM-DESIGN.md` §14):

- UI-only world state — Command Center stays source-bound; no speculation about state the substrate doesn't carry
- Direct self-granting authority — agents may propose, never enact
- Hidden self-modifying production code — every change goes through review/promotion
- Arbitrary YAML editor as the main product surface — interface model § applies
- Chat-first product pivot — chat is one channel among many
- Visual metaphor that hides failures — RTS aesthetic must surface real pressure, not invent fictional opponents
- New CRDs before repeated behavior justifies them — overlay first, CRD only when the read-side proves out

Proto-society-level (from `PROTO-SOCIETY-DESIGN.md` "What this document explicitly does not specify"):

- UI for the discourse layer — deferred until empirical signal
- Specific reputation algorithms (PageRank-like / upvote / citation-weighted / hybrid) — deferred
- Specific mob-proposal voting rules (simple quorum / weighted / liquid democracy) — deferred
- Specific personality/persona of agents — application-layer concern; substrate hosts whatever the operator seeds
- AGI speculation — out of scope; focus on what's actionable under bounded resources and current model capabilities

Substrate non-goals carried from v0.1:

- Implement an agent SDK — agents in pods run any framework
- Implement an LLM gateway — uses LiteLLM Proxy
- Implement a trace store — uses Langfuse self-hosted
- Implement a Kubernetes-management agent — different problem domain
- Track cluster manifests — `new_localai/` does that
- Build a workflow / DAG / Swarm engine — A2A is messaging-primitive level only

## Context

**Two design north stars (both ingested as SPEC, both load-bearing):**

- `docs/NORTH-STAR-SYSTEM-DESIGN.md` — workflow substrate (foundational, v0.1 scope)
- `docs/PROTO-SOCIETY-DESIGN.md` — proto-society primitives layered on top (v0.2 scope; opt-in per deployment)
- `docs/HYBRID-AGENT-POLICY.md` — referenced by both north stars but **not yet ingested**; if v0.2 work depends on per-agent reactive+deliberative policy details, run `/gsd-ingest-docs` to pull it in before scoping affected phases

**Operational environment:**

- Homelab K3s cluster managed by `../new_localai/`; ArgoCD is the GitOps engine
- LLM endpoint default: Cloudflare AI Gateway (`workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`)
- Per-agent isolation backend: Kata Containers (`RuntimeClass: kata`); long-term decision pending
- Trace sink: Langfuse self-hosted; observability bound to substrate state, not speculative

**Implementation posture (both north stars):** prefer overlays on existing objects until repeated behavior proves a CRD belongs in the substrate. Token-throwing is the _scaling_ test, not the _correctness_ test. The proof of concept needs the primitives, not infinite tokens.

**Operator's stated motivation (acknowledged, not promoted to substrate goal):** "a self-improving pal I can throw hardware and tokens at to iterate on items for me asynchronously." The honest design move is to separate substrate (works for any operator) from deployment (configures substrate for the personal-pal use case). Operator owns seeding, not delegation.

**Honest range of v0.2 outcomes when "turning the society on":** productive collaboration, drift toward irrelevance, collapse, brigading, zen/inert state, everything in between. The design must be robust to _the full range_, not optimized for the productive outcome. Every emergence-permitting move requires a corresponding revocation/quarantine/throttle move that costs less than the emergence it gates.

## Constraints

### Load-bearing tests (every roadmap item must answer)

- **§11 bounds test (`C-bounds`)** — Something belongs inside the substrate only if it can be represented as: declared capability + bounded resource drain + observable state transition + auditable output + revocation path. Applies equally to GPU nodes, browser pools, AgentDispositions, MobProposals, anything else. No exceptions.
- **§15 one-sentence test (workflow)** — Does this help the system turn intent into verified reusable capability with clearer authority, resource accounting, observability, review, or revocation? If no → likely ornament, application code, or model-gateway scope.
- **§15 one-sentence test (proto-society extension)** — Does this help the agent collective generate, refine, and govern its own intent — while keeping authority, observation, review, and revocation paths legible and operable to humans? If a feature permits self-organization but reduces the operator's ability to inspect or revoke, it is the wrong feature.

### Architectural / protocol constraints (from intel/constraints.md)

- **C-substrate-layers** — Six-layer model (Channels → Work orders → Colony → Economy → Governance → Human map). Every interface creates/inspects the same substrate objects.
- **C-game-loop** — `Intent → Work → Evidence → Review → Promotion → Better Future Work`. No path may skip Evidence or Review.
- **C-parent-child** — Child task creation is capability-scoped; fanout has depth/concurrency limits; agents request children, the substrate decides.
- **C-promotion-loop** — Agents propose new capability; never self-promote new authority.
- **C-feedback-classes + C-consolidation** — Steering, Review, Learning signal, Consolidation. Signals propose; governance disposes.

### Schema / object constraints

- **C-steering-event**, **C-review-record**, **C-north-star-objects** — overlay first, CRD only when usage justifies. No `Tool` CRD, no `SteeringEvent` CRD, no `Channel`/`Post` CRD until candidates force the design.
- **C-agent-disposition** — sibling spec object to `Agent` (idle behavior, attention budget, proposal scope). The smallest first move for v0.2.
- **C-discourse-primitives** — Channel/Post; start as artifacts, promote to CRDs only when read-side proves out.
- **C-mob-proposal** — signed quorum (≥N); no self-review; ring-review detection; rate-limit coalitions.

### NFR constraints

- **C-flow-economy** — Flow economy, not purchase economy. Command Center surfaces model-power / token / build-power / pod / artifact-bandwidth / authority / trust / attention pressure as ongoing flows.
- **C-decay** — staleness function + revalidationPolicy per catalog-object class.
- **C-governance-tiers** — Authority by action: posting/citing low; prompt-change medium; template-change medium-high; tool-change high; capability-policy-change highest. Coalition actions scaled to underlying authority + quorum check.
- **C-failure-modes** — Eight failure modes, each with a substrate response. The "society outgrows human relevance" row is non-negotiable: substrate-level kill switch must be operable independent of society state.
- **C-substrate-vs-deployment** — Substrate carries bounds/failure modes/governance machinery; deployments carry seed agents, dispositions, channels, budget. Operator owns seeding.

### Engineering / repo constraints

- **Tech stack:** TypeScript (strict, ESM, Node 22 target), pnpm workspace monorepo.
- **Runtime:** Node 22 + tsx for operator and agent-pod images. Bun is the original target (Anthropic owns Bun) but reverted in v0.1 — `@kubernetes/client-node` watch + status-patch paths fail TLS against K3s self-signed CA. Re-evaluate at v0.3+ once Bun's undici/TLS parity catches up.
- **License:** MIT header on every `.ts` source file.
- **Commits:** Conventional Commits (`feat(phase-N-...)`, `fix(phase-N-...)`, etc.). No squash-on-merge.
- **Tests:** vitest, co-located `*.test.ts`. Coverage thresholds: ≥85% on operator reconciler, ≥75% on glue code.
- **Cluster ops:** GitOps only. No imperative `kubectl apply / exec / port-forward` against the homelab cluster. Verification ships as Job manifests.
- **PRs:** `gh pr create` and `gh pr merge` are not a unit; per-PR explicit consent.
- **Hostnames:** check existing `*.knuteson.io` Ingresses (`kubectl get ingress,ingressroute -A` + `../new_localai`) before claiming subdomains.

## Key Decisions

<!-- D1-D5 are PROPOSED design positions inferred from the north stars; NOT locked, NOT ADRs. -->
<!-- Promoting any to ADR status requires explicit user input. -->

| Decision                                                                                                                                                   | Rationale                                                                                                | Outcome                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **D1** Substrate ships substrate primitives only — no agent SDK, no LLM gateway, no trace store, no K8s-management agent, no workflow/DAG engine           | NORTH-STAR §11/§13/§14; keeps surface area honest                                                        | — Pending (proposed; not locked)                  |
| **D2** Defer CRDs until repeated behavior justifies one — no `Tool`, `SteeringEvent`, `TaskReview`, `Channel`, `Post` CRD until usage forces it            | Prefer overlays on existing objects (annotations, status fields, ArtifactRefs); proven posture from v0.1 | — Pending (proposed; not locked)                  |
| **D3** Signals propose; governance disposes — every emergence-permitting design move terminates in a governance gate                                       | Load-bearing rule in both north stars; without it emergence becomes drift becomes capture                | — Pending (treated as load-bearing)               |
| **D4** Substrate-level revocation is non-negotiable — operator retains a kill-switch the agent collective cannot route around, regardless of society votes | C-failure-modes row 8; design requirement, not configuration option                                      | — Pending (treated as design requirement)         |
| **D5** Workflow north star is foundational; proto-society lives on top — proto-society features are opt-in per deployment                                  | Compatibility declaration; most kagent installations are workflow-only                                   | — Pending (proposed; not locked)                  |
| **OSS license**                                                                                                                                            | MIT — repo precedent                                                                                     | ✓ Good                                            |
| **Runtime**                                                                                                                                                | Node 22 + tsx (Bun reverted in v0.1; re-evaluate v0.3+)                                                  | ⚠️ Revisit when Bun TLS parity ships              |
| **Per-agent isolation**                                                                                                                                    | Kata Containers (`RuntimeClass: kata`)                                                                   | — Pending (long-term decision per NORTH-STAR §13) |
| **A2A bus**                                                                                                                                                | NATS JetStream                                                                                           | — Pending (no ADR yet; treated as v0.1 reality)   |

---

_Last updated: 2026-05-09 after intel ingest + v0.2 proto-society roadmap creation_
