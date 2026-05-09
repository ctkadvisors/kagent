# kagent

## What This Is

kagent is a K3s-native, OSS, MIT-licensed agent-farm operator that composes Kata Containers + NATS JetStream + Node 22 + LiteLLM + Langfuse into a per-agent-microVM substrate. The workflow substrate (v0.1) is shipped: tasks are dispatched, agents execute in pods, artifacts are reviewed, capability is promoted under capability-JWT scope.

The next milestone (v0.2) hardens the workflow substrate where it's already real — Workbench usability, source-bound Command Center, resource-flow overlays, and review/consolidation/promotion machinery over the existing task/artifact/verifier state — and runs minimum-viable observation experiments (idle/attention overlays on existing Agents) before any new CRD or controller is introduced.

Proto-society primitives (CRD-shaped Channels, Posts, CoalitionProposals, reputation algorithms, society kill-switch) are **future research, not v0.2 commitments**. They become candidates only after the workflow-substrate and Workbench/Command Center work proves out repeated behavior that demands them.

## Core Value

The substrate turns intent into verified reusable capability under bounded resources, observable state, and revocable authority. Every new power the system gains is tested, scoped, observable, and revocable. **Signals propose; governance disposes.** Agents may issue **proposals** (for new capability, tools, templates, policies, catalog changes); the substrate or human governance promotes them. **No agent self-escalates authority.**

## Output Structure

Per the 2026-05-09 PM re-steering, all synthesized outputs in this planning corpus are organized into the following classes. Anything inherited from the two ingested north stars (`docs/NORTH-STAR-SYSTEM-DESIGN.md`, `docs/PROTO-SOCIETY-DESIGN.md`) is treated as **input**, not commitment, until separately accepted by a PRD or ADR.

| Class                                      | Status                        | Source pressure                                                                                        |
| ------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Candidate Requirements**                 | unlocked, proposed            | Concrete acceptance criteria for the active milestone; replaceable until execution                     |
| **Proposed Decisions**                     | unlocked, proposed            | Design positions inferred from north stars or expressed by the operator; not ADRs                      |
| **Explicit Non-Goals**                     | locked                        | What this milestone will NOT do; documented to prevent re-adding                                       |
| **Future Research / Speculative Concepts** | unlocked, deferred            | Concepts surfaced by the north stars or operator that need empirical signal before becoming candidates |
| **Concrete Implementation Contracts**      | binding for in-scope surfaces | Documents that constrain HOW in-scope work must be done (e.g., `docs/COMMAND-CENTER-CONTRACT.md`)      |

**Promotion path:** Future Research → Candidate Requirement (when empirical signal accumulates) → Locked Requirement (when explicitly accepted via PRD/ADR) → Implementation. No phase plan may pull from Future Research without explicit promotion.

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

### Active (Candidate Requirements — v0.2 scope)

<!-- v0.2 hardens what's already real and runs minimum-viable observation experiments. -->
<!-- Each candidate requirement maps to exactly one phase in ROADMAP.md. -->

See `.planning/REQUIREMENTS.md` for full v0.2 candidate requirement list.

Summary of active scope:

- [ ] **AgentDisposition prototype (overlay-first, no CRD)** — represent idle/attention behavior as annotation on existing `Agent` (or as configmap / artifact record); surface in workbench-api as a read projection; render in Command Center as an overlay over existing economy flows. Promote to field or CRD only after observed repeated behavior justifies.
- [ ] **Command Center contract hardening** — implement Slice A (source-bound assertions, snapshot mapper tests, fixture-based reload stability) and Slice B (operational read depth on Agent/Task/Gateway selection panels) from `docs/COMMAND-CENTER-CONTRACT.md`.
- [ ] **Resource-flow overlays** — make `C-flow-economy` flows (model power, token, build power, pod, artifact bandwidth, authority, trust, attention) visible as Command Center overlays sourced from existing Workbench API DTOs. No new CRDs.
- [ ] **Review / consolidation / promotion over existing state** — strengthen review queue ergonomics, AgentTemplate promotion path, and replay/eval signal surfacing using existing `AgentTask`/`ArtifactRef`/verifier outputs. No `Tool`, `SteeringEvent`, `TaskReview`, `Channel`, or `Post` CRD.
- [ ] **Workbench usability hardening** — fill in operational read depth and reduce friction on the surfaces operators use daily; honor the "RTS feel = USABILITY, not visual chrome" constraint.

### Out of Scope (v0.2)

<!-- Explicit boundaries. Documented to prevent re-adding. -->

Workflow-substrate-level (from `NORTH-STAR-SYSTEM-DESIGN.md` §14, `docs/COMMAND-CENTER-CONTRACT.md` §9, and re-steering directives):

- **UI-only world state** — Command Center stays source-bound; every visible object/animation/action MUST derive from CRDs, Workbench API DTOs, audit events, gateway state, artifacts, traces, or verifier output (per `COMMAND-CENTER-CONTRACT.md` §2 "Prime directive")
- **Direct self-granting authority** — agents may _propose_, never enact; no self-escalation
- **Hidden self-modifying production code** — every change goes through review/promotion
- **Arbitrary YAML editor as the main product surface** — interface model § applies
- **Chat-first product pivot** — chat is one channel among many
- **Visual metaphor that hides failures** — RTS aesthetic surfaces real pressure, not fictional opponents
- **New CRDs before repeated behavior justifies them** — overlay first, CRD only when read-side proves out (this includes AgentDisposition itself)
- **Workbench painted/sprite-skinned chrome** — character lives in usability primitives (hotkeys, multi-select, dispatch, replay, FX), not visual reskins (per memory and abandoned 2026-05-08 sprite-GUI experiment)

Substrate non-goals carried from v0.1:

- Implement an agent SDK — agents in pods run any framework
- Implement an LLM gateway — uses LiteLLM Proxy
- Implement a trace store — uses Langfuse self-hosted
- Implement a Kubernetes-management agent — different problem domain (`kagent.dev`, Solo.io)
- Track cluster manifests — `../new_localai/` does that
- Build a workflow / DAG / Swarm engine — A2A is messaging-primitive level only

### Future Research / Speculative Concepts

<!-- Surfaced by the ingested north stars or by operator vision. NOT v0.2 commitments. -->
<!-- Promotion to Candidate Requirement requires empirical signal AND explicit acceptance. -->

From `docs/PROTO-SOCIETY-DESIGN.md` (proto-society primitives):

- `AgentDisposition` as a first-class CRD (vs the v0.2 overlay prototype) — promote only after observed repeated overlay use justifies the schema
- `Channel` and `Post` as first-class CRDs (vs artifact records) — defer until read-side proves out
- `CoalitionProposal` (renamed from "MobProposal" in source) — coalition action with signed quorum, no-self-review, ring-review detection. Defer until repeated proposal patterns justify the CRD shape.
- Consolidation controller — read-only daemon proposing hygiene actions to the existing review queue. Defer until manual review-queue ergonomics prove what "hygiene" should mean.
- Decay / revalidation policy — per-class staleness function + revalidation policy on catalog objects. Defer until a real catalog object ages badly enough to need it.
- Quarantine semantics as a first-class state — defer until at least one real object needs to be quarantined.
- **Substrate-level revocation kill-switch** — non-negotiable _if_ the proto-society layer is ever deployed (per `D4` candidate); but the layer itself is future research, so the kill-switch implementation is also future research. The principle remains binding.
- Reputation algorithms (PageRank-like / upvote / citation-weighted / hybrid) — algorithm-pick deferred until pilot signal exists.
- Voting rules for `CoalitionProposal` (simple quorum / weighted / liquid democracy) — deferred until coalitions are real.
- Pilot deployment of the proto-society layer (1–2 agents, one channel, small budget, observe) — only after primitives exist; primitives don't exist yet.

From `docs/NORTH-STAR-SYSTEM-DESIGN.md` "long-term decision points":

- Whether promoted tools require a `Tool` CRD (vs artifact + verifier + AgentTemplate)
- Whether steering/review require first-class CRDs (vs annotations + actions)
- Whether agent-sandbox replaces Kata Containers as the isolation backend
- How physical hardware appears as resource producers and tool-bearing structures
- Multi-tenant cognitive subsystem boundaries with cross-tenant capability portability

Operator-flagged but unscoped:

- "Self-improving pal" personal-research deployment — application-layer concern; substrate hosts whatever the operator seeds. Not a substrate goal.
- HYBRID-AGENT-POLICY.md ingestion — referenced by both north stars; not yet ingested. Pull via `/gsd-ingest-docs` if/when per-agent reactive+deliberative policy details become load-bearing for an active phase.

### Concrete Implementation Contracts

<!-- Binding documents for HOW in-scope work must be done. -->
<!-- These take precedence over north-star design language for their respective surfaces. -->

| Surface                    | Contract                          | Status                                                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workbench / Command Center | `docs/COMMAND-CENTER-CONTRACT.md` | **Binding for v0.2 Workbench/Command Center work.** Higher implementation weight than the north stars for this surface. Key invariant: every world object/action/animation MUST map back to CRDs, Workbench API DTOs, audit events, gateway state, artifacts, traces, or verifier output. No UI-only game state. |
| Image / asset generation   | `docs/IMAGE-ASSETS.md`            | Pipeline guidance; no active visual lock for the workbench.                                                                                                                                                                                                                                                      |
| Tech / runtime / repo      | `CLAUDE.md` (root)                | Authoritative for tech stack, runtime, conventions, GitOps posture.                                                                                                                                                                                                                                              |

## Context

**Two design north stars (ingested 2026-05-09 as SPEC; treated as candidate inputs after 2026-05-09 PM re-steering):**

- `docs/NORTH-STAR-SYSTEM-DESIGN.md` — workflow substrate; foundational; v0.1 reflects most of its scope; v0.2 hardens it
- `docs/PROTO-SOCIETY-DESIGN.md` — proto-society primitives that _could_ layer on top; **future research, not v0.2 commitment**
- `docs/HYBRID-AGENT-POLICY.md` — referenced by both north stars but **not yet ingested**

**Operational environment:**

- Homelab K3s cluster managed by `../new_localai/`; ArgoCD is the GitOps engine
- LLM endpoint default: Cloudflare AI Gateway (`workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`)
- Per-agent isolation backend: Kata Containers (`RuntimeClass: kata`); long-term decision pending
- Trace sink: Langfuse self-hosted; observability bound to substrate state, not speculative

**Implementation posture:** prefer overlays on existing objects until repeated behavior proves a CRD belongs in the substrate. Token-throwing is the _scaling_ test, not the _correctness_ test. Read-depth precedes write-depth.

## Constraints

### Load-bearing tests (every roadmap item must answer)

- **§11 bounds test (`C-bounds`)** — Something belongs inside the substrate only if it can be represented as: declared capability + bounded resource drain + observable state transition + auditable output + revocation path. No exceptions.
- **§15 one-sentence test (workflow)** — Does this help the system turn intent into verified reusable capability with clearer authority, resource accounting, observability, review, or revocation? If no → likely ornament, application code, or model-gateway scope.
- **`COMMAND-CENTER-CONTRACT.md` Prime Directive** — for any Workbench/Command Center work, every visible world object/animation/action MUST derive from a substrate source. UI-only state is forbidden.

### Architectural / protocol constraints (from intel/constraints.md)

- **C-substrate-layers** — Six-layer model (Channels → Work orders → Colony → Economy → Governance → Human map). Every interface creates/inspects the same substrate objects.
- **C-game-loop** — `Intent → Work → Evidence → Review → Promotion → Better Future Work`. No path may skip Evidence or Review.
- **C-parent-child** — Child task creation is capability-scoped; fanout has depth/concurrency limits; agents request children, the substrate decides.
- **C-promotion-loop** — Agents propose new capability; **never self-promote new authority** (self-proposal, not self-promotion).
- **C-feedback-classes** — Steering, Review, Learning signal. Signals propose; governance disposes.

### Schema / object constraints

- **C-steering-event**, **C-review-record**, **C-north-star-objects** — overlay first, CRD only when usage justifies.
- **C-agent-disposition** (proto-society source) — recorded as schema _sketch_ for the future-research CRD; v0.2 work uses overlay form (annotation/configmap/artifact), not the schema.
- **C-discourse-primitives**, **C-mob-proposal** (renamed CoalitionProposal in synthesized outputs) — schema sketches for future research; no v0.2 commitment.

### NFR constraints

- **C-flow-economy** — Flow economy, not purchase economy. Command Center surfaces model-power / token / build-power / pod / artifact-bandwidth / authority / trust / attention pressure as ongoing flows from existing DTOs.
- **C-decay**, **C-governance-tiers**, **C-failure-modes**, **C-substrate-vs-deployment** — recorded for future-research planning; not v0.2 commitments.

### Engineering / repo constraints

- **Tech stack:** TypeScript (strict, ESM, Node 22 target), pnpm workspace monorepo.
- **Runtime:** Node 22 + tsx for operator and agent-pod images. Bun reverted in v0.1 (TLS parity); re-evaluate at v0.3+.
- **License:** MIT header on every `.ts` source file.
- **Commits:** Conventional Commits (`feat(phase-N-...)`, `fix(phase-N-...)`, etc.). No squash-on-merge.
- **Tests:** vitest, co-located `*.test.ts`. Coverage thresholds: ≥85% on operator reconciler, ≥75% on glue code.
- **Cluster ops:** GitOps only. No imperative `kubectl apply / exec / port-forward` against the homelab cluster. Verification ships as Job manifests.
- **PRs:** `gh pr create` and `gh pr merge` are not a unit; per-PR explicit consent.
- **Hostnames:** check existing `*.knuteson.io` Ingresses (`kubectl get ingress,ingressroute -A` + `../new_localai`) before claiming subdomains.

## Key Decisions (Proposed — all unlocked)

<!-- D1-D7 are PROPOSED design positions. NOT locked, NOT ADRs. -->
<!-- Promoting any to ADR status requires explicit user input. -->

| Decision                                                                                                                                                                                          | Rationale                                                                                                                        | Status                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **D1** Substrate ships substrate primitives only — no agent SDK, no LLM gateway, no trace store, no K8s-management agent, no workflow/DAG engine                                                  | NORTH-STAR §11/§13/§14; keeps surface area honest                                                                                | Proposed (unlocked)                                                 |
| **D2** Defer CRDs until repeated behavior justifies one — no `Tool`, `SteeringEvent`, `TaskReview`, `Channel`, `Post`, `AgentDisposition`, `CoalitionProposal` CRD until usage forces it          | Prefer overlays on existing objects (annotations, status fields, ArtifactRefs); proven posture from v0.1                         | Proposed (unlocked)                                                 |
| **D3** Signals propose; governance disposes — every emergence-permitting design move terminates in a governance gate                                                                              | Load-bearing rule in both north stars; without it emergence becomes drift becomes capture                                        | Proposed (treated as load-bearing)                                  |
| **D4** Substrate-level revocation is non-negotiable — IF a proto-society layer is ever deployed, the operator must retain a kill-switch the agent collective cannot route around                  | C-failure-modes row 8; design requirement _for that future layer_; v0.2 ships no proto-society layer to revoke                   | Proposed (binding-if-deployed; the layer itself is future research) |
| **D5** Workflow north star is foundational; proto-society lives on top — proto-society features are opt-in per deployment AND future research, not v0.2 commitment                                | Compatibility declaration; most kagent installations are workflow-only; v0.2 hardens workflow                                    | Proposed (unlocked)                                                 |
| **D6** Self-proposal, not self-promotion — agents propose new capability, tools, templates, policies, catalog changes; substrate or human governance promotes. No agent self-escalates authority. | Re-steering 2026-05-09 PM correction to terminology drift                                                                        | Proposed (treated as load-bearing)                                  |
| **D7** `docs/COMMAND-CENTER-CONTRACT.md` is binding for Workbench/Command Center work — takes precedence over north-star design language for that surface                                         | Re-steering 2026-05-09 PM; the north stars frame the _why_; the contract specifies the _how_ and is closer to the implementation | Proposed (binding for in-scope Workbench/Command Center work)       |
| **OSS license**                                                                                                                                                                                   | MIT — repo precedent                                                                                                             | ✓ Good                                                              |
| **Runtime**                                                                                                                                                                                       | Node 22 + tsx (Bun reverted in v0.1; re-evaluate v0.3+)                                                                          | ⚠️ Revisit when Bun TLS parity ships                                |
| **Per-agent isolation**                                                                                                                                                                           | Kata Containers (`RuntimeClass: kata`)                                                                                           | Pending (long-term decision per NORTH-STAR §13)                     |
| **A2A bus**                                                                                                                                                                                       | NATS JetStream                                                                                                                   | Pending (no ADR yet; treated as v0.1 reality)                       |

---

_Last updated: 2026-05-09 PM after re-steering directive (north stars → candidate inputs; proto-society → future research; AgentDisposition → overlay-first prototype; COMMAND-CENTER-CONTRACT.md ingested as binding contract; self-promotion → self-proposal; MobProposal → CoalitionProposal in synthesized outputs)._
