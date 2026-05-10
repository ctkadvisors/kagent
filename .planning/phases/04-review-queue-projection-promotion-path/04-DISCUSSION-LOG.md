# Phase 4: Review queue projection + promotion path — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-10
**Phase:** 04-review-queue-projection-promotion-path
**Areas discussed:** Review-queue projection shape, Human-review-requested signal, Candidate-template + accept/reject write path, Replay/eval signal scope (REV-03)
**Mode:** discuss-phase, "follow best 'recommended' suggestions" — user accepted recommended option in each area; no roundtrip needed beyond the initial multi-select.

---

## Review-queue projection shape

| Option                                                        | Description                                                                                                                                                                                                                       | Selected        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Server-side `/api/review-queue` route + DTO                   | New route in workbench-api mirroring `/api/dispositions`. New `ReviewQueueRow` DTO. UI consumes via new `useReviewQueue()` hook. Phase 3's `attention` flow gauge flips to read from the new projection.                          | ✓ (recommended) |
| Fold into existing `/api/tasks` as `?needsReview=true` filter | Reuse existing route; UI side filters tasks. Saves a route but bloats `/api/tasks` with multi-source projection logic and forces the UI to compute staleness from audit events.                                                   |                 |
| UI-side derivation                                            | UI consumes `/api/tasks` + audit-event SSE; computes the queue client-side. Mirrors Phase 2/3 pressure/flows posture. Conflicts with REV-01's "in workbench-api" wording and breaks Phase 3's attention-flow stub promotion path. |                 |

**User's choice:** recommended (server-side route + DTO + new hook).
**Notes:** REV-01 explicitly says "Review queue projection in workbench-api"; mirroring DISP-03's pattern keeps the read-side architecture coherent.

---

## Human-review-requested signal

| Option                                                                      | Description                                                                                                                                                                                                                              | Selected        |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Annotation `kagent.knuteson.io/review-requested: "true"` + implicit signals | Operator-written annotation as authoritative explicit signal; verifier-failed / suspicious / candidate-template are implicit. New `POST /api/review-queue/:ns/:name/request` operator endpoint. Agents do NOT write the annotation (D6). | ✓ (recommended) |
| Implicit-only (no annotation)                                               | Queue rows derived purely from verifier/suspicious/candidate signals. No way for an operator to flag a Completed-clean task for spot-audit.                                                                                              |                 |
| New CRD `ReviewRequest`                                                     | First-class substrate primitive for the request. Violates D2 ("defer CRDs until repeated behavior justifies").                                                                                                                           |                 |
| Agent-side write of the annotation                                          | Agents may set `review-requested: true` themselves. Violates D6 (self-proposal, not self-promotion) and expands DISP-02's locked proposal-kind enum.                                                                                     |                 |

**User's choice:** recommended (annotation + implicit signals + operator-only POST).
**Notes:** Annotations are the lightest substrate primitive; implicit signals catch the common cases automatically; the explicit annotation handles the spot-audit case.

---

## Candidate-template + accept/reject write path

| Option                                                                                                                                                                                                                                                                   | Description                                                                                                                                                                                                  | Selected        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `#/review` page + inline `ReviewActions` in TaskDetail; sub-path POSTs (`/accept`, `/reject`); ArtifactRef-shaped candidates; promoted CRs via existing operator-write path; new RBAC verbs `agenttasks: [patch]` + `agenttemplates: [create]` on the chart actions Role | Two reviewer entry points share a single write contract. Candidates live as artifacts at rest; promotion creates the existing AgentTemplate CR. RBAC additive on the existing release-namespace-scoped Role. | ✓ (recommended) |
| Single entry point (just `#/review` page, nothing inline)                                                                                                                                                                                                                | No inline TaskDetail action; reviewer must always go to the dedicated page. Loses ergonomics for the common "I'm already on this task's detail page" flow.                                                   |                 |
| PATCH-by-annotation (no POST endpoint)                                                                                                                                                                                                                                   | Reviewer sends a PATCH directly to AgentTask with the decision annotation. Less clear intent; harder to wire audit-event emission; conflates client-side CR creation with server-side authorization.         |                 |
| New `ReviewDecision` CRD as the authoritative decision record                                                                                                                                                                                                            | First-class CRD for accept/reject. Violates D2; multi-reviewer is future research anyway so single-CRD-per-decision is over-design.                                                                          |                 |

**User's choice:** recommended (two entry points, sub-path POSTs, ArtifactRef candidates, additive RBAC).
**Notes:** Candidate carrier as ArtifactRef honors "no new CRD"; promotion creates the EXISTING AgentTemplate CR via existing operator-write path; RBAC split-write-role is the existing H17 convention.

---

## Replay/eval signal scope (REV-03)

| Option                                                                             | Description                                                                                                                                                                                                                                                                                                                                           | Selected        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Forward-compatible stub with documented promotion path                             | Reserve `replay-divergence` and `eval-failed` slots in `ReviewReason` enum. Zero v0.2 producers. Inline comment naming Phase 5 / `docs/REPLAY-EVALS.md` as the producer. Verifier-fail + suspicious-detector reasons (already shipped via D-01) cover what REV-03 calls "replay/eval signals" today. Mirrors Phase 3's `attention` flow stub pattern. | ✓ (recommended) |
| Surface what exists today (no new slots)                                           | Drop `replay-divergence` and `eval-failed`; only `verifier-failed` + `suspicious-detector`. Honest about today's coverage but breaks forward-compat — when AgentTaskRun ships the projection signature changes.                                                                                                                                       |                 |
| Thin "replay divergence" detector over `task-admission.ts` idempotent-replay cache | Detect divergence by comparing cache replay outputs against original outputs. Wrong domain — `task-admission.ts` cache is Stripe-pattern same-input-hash idempotency, not eval-divergence. Conflates two concepts that REPLAY-EVALS.md §3 explicitly tries to separate.                                                                               |                 |
| Wait for Phase 5 (defer REV-03)                                                    | Drop REV-03 from this phase. Conflicts with the requirement and roadmap.                                                                                                                                                                                                                                                                              |                 |

**User's choice:** recommended (forward-compatible stub + promotion path).
**Notes:** REPLAY-EVALS.md is Phase 5 design pre-implementation; AgentTaskRun and ReplaySet CRDs do not exist; honest stub mirrors Phase 3's attention-gauge-stub pattern.

---

## Claude's Discretion

The user's "follow best 'recommended' suggestions" is authority to pick recommendations across all 4 gray areas. Within those locks, planner has discretion on (full list in CONTEXT.md `<decisions>` "Claude's Discretion" block):

- `useReviewQueue()` polling cadence (default 5s; SSE invalidation deferred)
- File split for `routes/review-queue.ts` (single file vs per-handler modules)
- ReviewPage table column ordering and column-set
- Confirm-dialog UX shape (default modal, mirroring `NewTaskModal.tsx`)
- `ReviewActions` mount position in TaskDetail (default top, above existing content)
- ArtifactRef resolution for candidate templates (default: first artifact whose mediaType matches)
- Whether `agenttemplates: [get,list,watch]` is already covered in read-side `clusterrole.yaml` (additive if not)
- Phase 3 `attention` flow integration mechanics (count-only fetch in CommandView vs shared hook)
- AgentTemplate name-collision strategy on accept (default: hard-fail 422)
- Whether to also surface `ReviewActions` in TaskList rows (default: defer)
- Exact integration site for the `attention` `compute()` body change

## Deferred Ideas

(Mirror of CONTEXT.md `<deferred>` block. Listed here for audit completeness — not for downstream agent consumption.)

- `ReviewRequest` / `TaskReview` / `ReviewDecision` CRDs — D2; future research
- Multi-reviewer / `CoalitionProposal` — REQUIREMENTS.md §4 future research
- Real replay-divergence detection / `AgentTaskRun` / `ReplaySet` / `@kagent/eval` — Phase 5 design
- Consolidation controller — REQUIREMENTS.md §4 future research
- Decay / revalidation policy on review-queue rows — REQUIREMENTS.md §4 NFR future research
- Quarantine semantics for rejected candidates — REQUIREMENTS.md §4 NFR future research
- Agent-side write of `review-requested` — D6 violation; future research
- Bulk accept/reject — WB-02 read-only multi-select posture
- Web hook / push on enqueue — defer; SSE stream is sufficient
- Reviewer-identity beyond `X-Forwarded-User` — H17 auth posture; future
- AgentTemplate-version-bump on accept (`templateVersion: N+1` for supersession) — defer
- Auto-accept after timeout — D6; defer
- Bulk-export of audit events — defer; SSE stream is sufficient
- Cross-namespace promotion — H17 release-namespace scope; future feature
- CI lint for `ReviewReason` enum coverage — defer
- SSE-driven invalidation of `useReviewQueue()` — defer
- `#/review/:taskRef` deep-link — defer
- `ReviewActions` in TaskList rows — defer
