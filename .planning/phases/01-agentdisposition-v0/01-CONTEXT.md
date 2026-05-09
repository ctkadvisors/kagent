# Phase 1: AgentDisposition prototype (overlay-first, no CRD) — Context

**Gathered:** 2026-05-09 PM
**Status:** Ready for planning
**Source:** Operator re-steering directive 2026-05-09 PM (during /gsd-plan-phase 1)
**Re-steered roadmap commit:** 793fe7b

> **Critical framing.** This phase is the smallest first move per the **corrected** posture from the 2026-05-09 PM re-steering. **Phase 1 introduces NO new CRD and NO new reconciler.** It prototypes idle/attention behavior on existing v0.1 substrate primitives, surfaces the result in workbench-api as a read projection, and renders it in Command Center as an overlay over existing flow-economy flows. Promotion to a CRD field on `Agent` (or to a sibling `AgentDisposition` CRD) is **post-phase observation work**, not Phase 1 work.

<domain>
## Phase Boundary

**In scope (Phase 1 delivers):**

1. An overlay representation for idle/attention behavior, attached to an existing `Agent` using ONLY shipped v0.1 primitives. The overlay must carry the fields named in `C-agent-disposition` (idleBehavior.readChannels[], attentionBudget.{tokensPerDay, pollIntervalSeconds}, proposalScope.{mayProposeAgainst[], maxProposalsPerDay}) but in a non-CRD form.
2. A schema-validation Job that rejects overlays missing required fields.
3. Existing capability-JWT scope check enforcement of `proposalScope.mayProposeAgainst` at proposal-issuance time. The overlay narrows JWT scope; it never widens.
4. A workbench-api read projection (e.g., `/dispositions`) computed from existing telemetry — gateway DTOs for token usage; existing audit-event stream for proposal counts. **No new persistence primitive.**
5. A Command Center overlay rendering disposition state alongside existing flow-economy flows, honoring `COMMAND-CENTER-CONTRACT.md` Prime Directive (every rendered field has a backing substrate source).
6. Audit events for over-budget conditions emitted via the existing audit-event surface with structured reasons.
7. Reload-stable rendering — closing and reopening Command Center reconstructs the overlay from API state.
8. Observation hooks (logs/metrics, no new telemetry primitive) sufficient to capture which fields are read/written/ignored across ≥2 agents over ~7 days. The Phase 1 closure produces an evidence packet that the operator can use to decide whether to file a Future Research → Candidate Requirement promotion for `AgentDisposition` as a CRD.

**Out of scope for Phase 1 (locked exclusions):**

- Any new CRD (`AgentDisposition`, `Channel`, `Post`, `CoalitionProposal`, `Tool`, `SteeringEvent`, `TaskReview`).
- Any new reconciler / controller.
- Any new admission webhook (the existing capability-JWT scope check is sufficient; we narrow it via the overlay rather than add a new gate).
- Any new persistence primitive (counters are computed projections from existing telemetry).
- Discourse layer (Posts, Channels) — Phase 1 only declares `readChannels[]` references in the overlay; nothing reads from them in v0.2.
- Consolidation controller (Future Research, see REQUIREMENTS.md §4).
- CoalitionProposal admission (Future Research, see REQUIREMENTS.md §4).
- Substrate-level proto-society kill-switch implementation (Future Research; the principle in D4 remains binding for any future deployment of the layer).
- Any UI-only state in Command Center — every disposition overlay field must derive from a workbench-api source field per `COMMAND-CENTER-CONTRACT.md` Prime Directive.

</domain>

<decisions>
## Implementation Decisions (locked for this phase)

### Overlay form (the key shape decision)

**Decision: Defer the choice of overlay carrier (annotation vs ConfigMap vs ArtifactRef) to the planner, but commit to ALL of these properties:**

- The carrier MUST be a shipped v0.1 primitive — no new kind.
- The carrier MUST be `kubectl get`-inspectable so the operator can see disposition state without going through workbench-ui.
- The carrier MUST be referenceable by `agentRef` (namespace/name of an existing `Agent`).
- The carrier MUST be modifiable via GitOps (ArgoCD-deployable from a manifest in `../new_localai/` overlay).
- The carrier MUST validate via a Job (not an admission webhook) — Job manifests ship with the phase per the GitOps-only constraint.

**Reasoning:** The three options each have different ergonomics:

- **Annotation on `Agent`:** simplest; co-located with the Agent CR; but YAML is awkward to author for nested fields like `attentionBudget` and `proposalScope`. Annotations are strings; nested structure has to be JSON-encoded.
- **Sibling `ConfigMap` referenced by `agentRef`:** cleanest for nested structured fields; standard Kubernetes shape; existing operators / kubectl / GitOps tools all handle ConfigMaps natively. Adds one indirection (Agent → ConfigMap by `agentRef`).
- **`ArtifactRef`-shaped record:** consistent with v0.1 patterns for "things we don't want to CRD-ify yet"; integrates with the existing artifact verifier path; but maps oddly onto Kubernetes-shaped operator workflows (artifacts are object-store-shaped, dispositions are config-shaped).

**Recommendation to the planner:** lead with **sibling ConfigMap** as the primary candidate; document the alternative carriers as decision points the planner exposes for the operator's confirmation in PLAN.md. The schema validation Job and the workbench-api read projection should be carrier-agnostic enough that switching carriers later is a contained change.

### Capability-JWT scope narrowing

**Decision: Narrow the existing capability-JWT scope at proposal-issuance time using the overlay's `proposalScope.mayProposeAgainst`. Do NOT add a new admission webhook.**

- The existing capability-JWT scope check (in operator and/or workbench-api proposal-issuance paths) already validates whether a JWT is scoped for a given action.
- The overlay provides a per-Agent narrowing rule: "this agent's JWT is allowed to propose only against the kinds listed in `mayProposeAgainst`."
- At issuance time, the proposal handler reads the overlay (via `agentRef`) and rejects proposals whose `kind` is not in `mayProposeAgainst` with a typed audit event referencing the overlay.
- **Self-proposal, not self-promotion:** the overlay narrows scope; it never widens. Even if an attacker forges an overlay with a wider `mayProposeAgainst`, the underlying capability-JWT still gates promotion. The overlay is a _defense-in-depth narrowing_, not a grant mechanism.

### Counter projection (no new persistence)

**Decision: Compute `spentTokensToday`, `postsToday`, `proposalsToday` as a workbench-api projection from existing telemetry. NO new database table, no new CRD status field, no new etcd key. Annotations on the existing disposition ConfigMap carrier are NOT a new persistence primitive — they are an existing K8s primitive being used.**

- `spentTokensToday`: sum of token usage from gateway DTOs (existing — gateway already emits per-Agent token usage) over the current day boundary.
- `postsToday`: in v0.2, **this counter remains zero** for any Agent (no Post primitive yet — Posts are Future Research). The field is reserved for forward compatibility; the projection emits 0 with a documented "not-implemented-in-v0.2" comment.
- `proposalsToday`: **annotation-writer pattern (locked 2026-05-09 PM via plan-checker BLOCKER #2 resolution; supersedes the original audit-event-counting design).**
  - **Source of truth:** the disposition ConfigMap's annotation `kagent.knuteson.io/proposals-today` (string-encoded integer). A sibling annotation `kagent.knuteson.io/proposals-today-day` records the UTC day window (`YYYY-MM-DD`) the count belongs to.
  - **Sole writer:** the operator's cap-issuer narrowing step (plan 02). When a successful capability mint includes a proposal-category tool after overlay narrowing, the cap-issuer PATCHes the ConfigMap to increment the annotation by 1 and write the current UTC day. The configmaps:patch RBAC for this is granted in plan 01 (task 3).
  - **Reader:** workbench-api dispositions projection (plan 03). It reads both annotations on every projection request: if the day annotation matches today's UTC day, it parses the count; otherwise it treats the count as 0 (rollover semantics). Workbench-api NEVER writes the annotation.
  - **Why not audit-event-counting?** Adding a NATS JetStream consumer to workbench-api would expand the substrate's primitive surface for the projection. The annotation-writer keeps the projection an O(1) read on the same ConfigMap that already carries the spec — cleaner, fewer moving parts, and the rollover semantics are explicit rather than depending on consumer position-tracking.

**Daily boundary:** UTC midnight, configurable per-deployment via Helm values (defaults to UTC). Documented in the projection's API response. The day-mismatch reset is handled READ-SIDE (workbench-api treats a day-annotation mismatch as count=0); the operator's next narrowing-increment then rewrites both annotations to today.

**Over-budget audit event:** when a projection observes `spentTokensToday > attentionBudget.tokensPerDay` OR `proposalsToday > proposalScope.maxProposalsPerDay`, emit a substrate audit event of `kind: disposition_over_budget` with structured `reason` (`tokens_exceeded` | `proposals_exceeded`), `agentRef`, and current+budget values. Emit at most once per (agent, kind) per day to avoid log floods.

### Command Center overlay rendering

**Decision: Render the disposition overlay in Command Center as a sibling overlay to existing flow-economy flows (model power, token, build power, etc.). Apply Slice A/B + Slice E patterns from `docs/COMMAND-CENTER-CONTRACT.md`.**

- Every rendered field has a documented backing substrate source field.
- The overlay is reload-stable: a fresh page load reconstructs the overlay from API responses; no client-side persistence.
- Pressure dramatization (over-budget visual treatment) follows Slice E acceptance — every pressure marker carries source field + detail link.
- Base-building-only mode: a config flag disables pressure dramatization while keeping the same data.

### COMMAND-CENTER-CONTRACT.md compliance (D7)

**Decision: D7 binds Phase 1's UI work. Every disposition-related world object/animation/action in Command Center MUST map back to a substrate source — Workbench API DTO, audit event, or existing CRD field. UI-only state is forbidden.**

- A development-only assertion fires in Phase 1's UI build when a rendered disposition field lacks a backing source field reference. (CC-01 in REQUIREMENTS.md formalizes this for all of Command Center; Phase 1 implements the disposition slice.)
- Reload stability validated via Vitest snapshot test seeded with a captured API response (CC-02 pattern).

### Test posture

- Vitest, co-located `*.test.ts`, ≥85% on operator-side reconciler-equivalent code (here: capability-JWT scope check narrowing + overlay parsing); ≥75% on glue code (workbench-api projection + UI overlay rendering).
- Schema-validation Job ships as a GitOps-deployable manifest under `packages/operator/charts/` overlays.
- Failure-injection test for over-budget audit-event emission (mock telemetry such that the projection observes over-budget; assert exactly-one audit event).

### Claude's Discretion

- Exact endpoint name for the workbench-api projection (`/dispositions` is suggested but the planner may pick a name consistent with existing endpoint conventions).
- File layout within `packages/workbench-api/` for the new projection (follow existing `packages/workbench-api/src/...` patterns from v0.1).
- Specific Vitest fixture shape for reload-stability tests (consistent with existing Command Center fixtures).
- Whether the Command Center overlay is rendered as a new flow card or integrated into existing flow cards (planner decides; constraint: every field has a source reference).
- Helm values keys for the daily-boundary timezone configuration (consistent with existing Helm value naming).

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents (researcher, planner, checker) MUST read these before planning or implementing.**

### Project planning corpus (re-steered 2026-05-09 PM)

- `.planning/PROJECT.md` — project bones; output structure; D1–D7 (proposed/unlocked); load-bearing tests
- `.planning/REQUIREMENTS.md` — DISP-01..04 candidate acceptance criteria; §3 explicit non-goals; §4 future research (so we don't accidentally pull from it); §5 implementation contracts
- `.planning/ROADMAP.md` — Phase 1 success criteria (4 items); promotion gate language; future-research backlog 999.x
- `.planning/STATE.md` — re-steering record + blockers/concerns

### Source documents (treated as candidate inputs after re-steering)

- `docs/NORTH-STAR-SYSTEM-DESIGN.md` — workflow substrate north star (foundational; v0.1 reflects most of it)
- `docs/PROTO-SOCIETY-DESIGN.md` — proto-society north star; **read with awareness that the CRD-shaped primitives in this doc are Future Research, not v0.2 commitment**

### Binding implementation contract (D7)

- `docs/COMMAND-CENTER-CONTRACT.md` — **binding for Workbench/Command Center work** in Phase 1. Critical sections:
  - §2 Prime directive (every world object derives from substrate source)
  - §3 Source-of-truth map (forbidden behaviors)
  - §4 Action contract (what writes are permitted)
  - §6 Pressure systems (visual treatment for over-budget conditions)
  - §7 Slice A (contract hardening), Slice B (operational read depth), Slice E (pressure overlay) — Phase 1 lights up Slice A patterns for the disposition slice; Phase 2 will generalize Slice A/B.

### Schema sketches (FUTURE RESEARCH — do not implement as CRDs in Phase 1)

- `.planning/intel/constraints.md` `C-agent-disposition` — the source schema sketch for AgentDisposition. Phase 1 USES the field shape (idleBehavior.readChannels[], attentionBudget, proposalScope) but ATTACHES IT AS AN OVERLAY, not as a CRD.
- `.planning/intel/constraints.md` `C-flow-economy` — the eight flows the disposition overlay sits alongside in Command Center.
- `.planning/intel/constraints.md` `C-bounds` — the §11 bounds test the phase must satisfy.

### Project conventions

- `CLAUDE.md` (root) — tech stack, runtime (Node 22 + tsx), commits, GitOps, testing, hostnames

### Existing v0.1 surfaces the planner must work with

- Operator package (`packages/operator/`) — capability-JWT scope check lives here; Phase 1 narrows it via overlay lookup.
- Workbench-api package (`packages/workbench-api/`) — Phase 1 adds the disposition projection endpoint here.
- Workbench-ui package (`packages/workbench-ui/`) — Phase 1 adds the Command Center overlay slice here.
- Existing Helm chart at `packages/operator/charts/` — Phase 1's schema-validation Job manifest ships here.
- Existing audit-events package (`packages/audit-events/`) — Phase 1 emits over-budget events through this surface.

</canonical_refs>

<specifics>
## Specific Ideas / Concrete Requirements from Re-Steering

1. **The user's exact words on the overlay form (preserve verbatim for the planner):**

   > "prototype idle/attention behavior as config, artifact, annotation, or existing Agent/AgentTask overlay; promote to field or CRD only after observed repeated behavior justifies it."

   The planner must propose ONE primary carrier (recommendation: ConfigMap referenced by `agentRef`) and document the alternatives as decision points.

2. **Self-proposal vs self-promotion (D6, verbatim):**

   > "Replace any interpretation of 'self-promotion authority' with 'self-proposal authority.' Agents may propose new capability, tools, templates, policies, or catalog changes. The substrate or human governance process promotes them. No agent self-escalates authority."

   DISP-02's unit test must assert the overlay narrows JWT scope, never widens. Code paths must use "propose" / "proposal" terminology, not "promote" / "promotion."

3. **MobProposal → CoalitionProposal:** the rename applies to synthesized outputs and any new code. Phase 1 does not implement CoalitionProposal (Future Research), so the rename mostly affects comments / type names IF any code references the future-research primitive. Default: avoid mentioning the future primitive at all in Phase 1 code.

4. **`COMMAND-CENTER-CONTRACT.md` §2 Prime Directive (verbatim):**

   > "Every visible world object, animation, action, and alert MUST derive from one of these sources: Kubernetes CRDs ... Kubernetes-owned runtime objects ... kagent DTOs exposed by Workbench API ... audit events ... gateway admin surfaces ... artifacts, traces, and verifier results."
   >
   > "The UI MUST NOT maintain independent strategic state."

   The disposition overlay's UI assertion (CC-01 pattern, scoped to disposition fields in Phase 1) is the test that enforces this.

5. **No imperative kubectl against homelab (CLAUDE.md operational context):** Phase 1's verification ships as Job manifests deployed via ArgoCD. The schema-validation Job is the canonical example; operators run `kubectl get jobs -n kagent-system` to read results, not `kubectl exec`.

6. **GitOps deployability:** the overlay format must be GitOps-deployable from a manifest in `../new_localai/` overlay. The seed manifest can be added as part of Phase 1's evidence packet OR deferred to a future Pilot phase (which is itself Future Research). Phase 1's evidence packet should include a sample overlay manifest documented in the phase summary.

7. **§11 bounds test answer for Phase 1 (must appear in PLAN.md):**
   - Declared capability: an existing `Agent` with an attached idle/attention overlay can read `readChannels[]` (no-op in v0.2; reserved), spend tokens up to `tokensPerDay`, and issue at most `maxProposalsPerDay` proposals against `mayProposeAgainst` kinds.
   - Bounded resource drain: `tokensPerDay` and `maxProposalsPerDay` are explicit caps; over-budget conditions emit audit events.
   - Observable state transition: workbench-api `/dispositions` projection + Command Center overlay both surface current state.
   - Auditable output: over-budget audit events; capability-JWT scope rejections; schema-validation Job results.
   - Revocation path: removing the overlay (kubectl delete on the carrier) immediately removes the narrowing — proposal-issuance falls back to the underlying capability-JWT scope. Operator-driven; no agent involvement.

8. **§15 one-sentence test answer for Phase 1 (must appear in PLAN.md):**

   "Idle agent behavior becomes cost-visible (token-budget projection) and capability-scoped (capability-JWT narrowing) without introducing a new CRD — strengthening authority, resource accounting, observability, and revocation paths over existing v0.1 substrate state."

</specifics>

<deferred>
## Deferred Ideas (Phase 1 explicitly does NOT do these)

- Any read-side that consumes `idleBehavior.readChannels[]` — Posts and Channels are Future Research. Phase 1 records `readChannels[]` for forward compatibility but does not act on it.
- Promotion of `AgentDisposition` to a CRD field on `Agent` or to a sibling CRD — that's the post-phase observation outcome, recorded in Future Research backlog 999.1.
- Multi-reviewer review queue — Phase 4's REV-02 covers single-reviewer; multi-reviewer is Future Research.
- Reputation algorithm — Future Research per REQUIREMENTS.md §4.
- Society-level kill-switch — non-negotiable IF the proto-society layer ships, but the layer doesn't ship in v0.2; the principle (D4) remains binding for any future deployment.
- Discourse layer rendering in Command Center — `readChannels[]` is reserved; no UI for it in Phase 1.
- HYBRID-AGENT-POLICY.md ingestion — not blocking Phase 1 (no per-agent reactive+deliberative policy details needed for the overlay).

</deferred>

---

_Phase: 01-agentdisposition-v0_
_Context gathered: 2026-05-09 PM via /gsd-plan-phase 1 after operator re-steering directive (commit 793fe7b)._
