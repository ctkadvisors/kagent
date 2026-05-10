---
phase: 04-review-queue-projection-promotion-path
plan: 06
subsystem: review-queue
tags: [audit-events, agent-template, traceLink, reviewerId, type-safety]

# Dependency graph
requires:
  - phase: 04
    provides: review-queue projection, POST accept/reject/request handlers, ReviewPage UI, ReviewQueueRow DTO
provides:
  - CR-01 fix — template.candidate.promoted emitted BEFORE annotation patch (audit log preserves AgentTemplate CR existence on patch failure)
  - CR-02 fix — classifier reasonDetail aligned to DTO JSDoc spec format `${proposedTemplateName} (candidate)`
  - CR-03 fix — type-only cross-check pinning ReviewAcceptedData.reason / ReviewRejectedData.reason to @kagent/dto ReviewReason
  - WR-02 fix — ReviewActionApiError.detail surfaces server 422 detail (parser error tag) into the dialog UI
  - WR-06 fix — RequestReviewBody fields renamed to reviewerId / reasonText to match server contract
  - WR-08 doc — useReviewQueue 5s no-backoff polling policy documented with 503-impossibility rationale + Phase 5+ TODO
  - SC3 satisfied — traceLink rendered as direct anchor in ReviewPage table; one-hop row→artifact navigation
affects: [phase-05]

# Tech tracking
tech-stack:
  added:
    [
      '@kagent/dto as devDependency on @kagent/audit-events (workspace:*) — type-only, runtime emit unaffected',
    ]
  patterns:
    - 'Type-only cross-package pin via `import type` for leaf-package posture preservation (LM-10) — devDependency edge sufficient for tsc, runtime emit strips the import'
    - 'Audit-emission ordering: emit substrate-state-evidencing events (CR-create) immediately after substrate write succeeds, BEFORE downstream best-effort writes — preserves audit record on partial failure'
    - 'Server-error `detail` field as a structured channel for actionable parser/validator output (parseAgentTemplateSpec) → UI surfaces it in dialog error display'

key-files:
  created:
    - packages/audit-events/src/types.test.ts
  modified:
    - packages/workbench-api/src/routes/review-queue.ts
    - packages/workbench-api/src/routes/review-queue.test.ts
    - packages/audit-events/package.json
    - packages/workbench-ui/src/api.ts
    - packages/workbench-ui/src/api.test.ts
    - packages/workbench-ui/src/ReviewPage.tsx
    - packages/workbench-ui/src/ReviewPage.test.tsx
    - packages/workbench-ui/src/ReviewPage.module.css
    - packages/workbench-ui/src/command/ReviewActions.tsx
    - pnpm-lock.yaml

key-decisions:
  - 'CR-01: template.candidate.promoted now fires immediately after CR-create success and BEFORE the annotation patch attempt (lines 339-368 of review-queue.ts). The post-patch `if (agentTemplateRef !== undefined)` block is removed entirely — review.accepted retains its post-patch position because review.accepted implies the decision landed in the substrate.'
  - 'CR-02: classifier reasonDetail literal switched from operational long-form `candidate AgentTemplate from ${ns}/${name}` to DTO-JSDoc-spec form `${proposedTemplateName} (candidate)`. The DTO contract is the single source of truth at the substrate-API-UI tier boundary.'
  - "CR-03: type-only cross-check uses `import type { ReviewReason } from '@kagent/dto/review-queue'`. tsc strips type-only imports at emit; verified by post-build `grep -r '@kagent/dto' packages/audit-events/dist/*.js` returning no matches. devDependency `workspace:*` satisfies typecheck-time module resolution. LM-10 leaf-package posture intact."
  - 'WR-02 dialog rendering: both ReviewPage.tsx and ReviewActions.tsx own their own confirm dialogs and store dialogError as a string (not as an Error object). Plan permitted single-string concatenation as a minimal-form alternative to a separate <div>. Implementation appends ` — ${err.detail}` to the existing `Error ${status}: ${message}` string. React text-children escaping defends against injection (T-04-06-02 disposition: accept).'
  - 'WR-06 callers: `requestReview` had no production callers using the old `requestedBy`/`note` shape — only the api.test.ts REQ-1 test called with `{}`. No UI plumbing changes required; only the interface rename + a new REQ-2 test asserting the wire format.'

patterns-established:
  - 'Pattern: emit substrate-state-evidencing audit events (e.g., CR-create) IMMEDIATELY after the substrate write succeeds, NOT in a post-multi-write audit batch. Decoupling lets the audit log capture the existence of substrate objects even when downstream writes (e.g., annotation patches) fail mid-flight.'
  - 'Pattern: preserve LM-10 leaf-package posture for type-only deps via `devDependencies + import type`. The package gains a typecheck-only edge to upstream types; runtime emit is unaffected. Verifier discipline: post-build grep for the imported package name in dist/*.js.'
  - 'Pattern: extend ReviewActionApiError.detail (and the equivalent error envelopes) when the server emits structured `detail` fields. Operators see actionable parser tags inline with the top-level error message.'

requirements-completed: [REV-02, REV-03]

# Metrics
duration: 30 min
completed: 2026-05-10
---

# Phase 4 Plan 6: Wave 5 Gap Closure Summary

**CR-01 BLOCKER closed (audit emission re-ordered before annotation patch); SC3 satisfied via direct traceLink anchor in ReviewPage; CR-02/CR-03/WR-02/WR-06/WR-08 anti-patterns all closed across workbench-api, audit-events, and workbench-ui.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-05-10T18:59:00Z (approx)
- **Completed:** 2026-05-10T19:09:00Z (approx)
- **Tasks:** 8
- **Files modified:** 9 (1 new test file + 8 modifications)

## Accomplishments

- **CR-01 (BLOCKER) closed.** `template.candidate.promoted` audit event now fires IMMEDIATELY after AgentTemplate CR creation succeeds, BEFORE the annotation patch. On patch failure (500 response), the audit log permanently records the AgentTemplate's existence — matching reality (the CR exists in the cluster). `review.accepted` is NOT emitted on patch failure because the decision did not land in the substrate. Regression test `W2-Test CR-01` asserts the new ordering and the publish-vs-not-publish behavior.
- **SC3 satisfied.** ReviewPage now renders a direct `<a target="_blank" rel="noreferrer">trace</a>` anchor adjacent to the Task cell for rows whose `traceLink` is a non-empty string. Direct one-hop navigation from queue row to underlying eval/replay artifact (Langfuse trace URL). The indirect Task → TaskDetail → trace path remains via the existing `{namespace}/{name}` link.
- **CR-02 closed.** Classifier `reasonDetail` now matches the DTO JSDoc spec format exactly: `${proposedTemplateName} (candidate)` instead of the operational long-form `candidate AgentTemplate from ${ns}/${name}`. Test 6 enforces the exact string.
- **CR-03 closed.** Type-only cross-check `packages/audit-events/src/types.test.ts` pins `ReviewAcceptedData.reason` and `ReviewRejectedData.reason` to `ReviewReason` from `@kagent/dto/review-queue` via `import type`. Future drift in either union produces a tsc error in `@kagent/audit-events` typecheck. LM-10 leaf-package posture preserved (verified by post-build `grep -r '@kagent/dto' packages/audit-events/dist/*.js` finding no runtime references).
- **WR-02 closed.** `ReviewActionApiError.detail?: string` carries the server-supplied 422 detail (e.g., the `parseAgentTemplateSpec` parser error tag). Both confirm-dialog rendering sites (`ReviewPage.tsx` and `ReviewActions.tsx`) append the detail to the displayed error string so reviewers see the actionable parser output inline.
- **WR-06 closed.** `RequestReviewBody` interface fields renamed `requestedBy → reviewerId` and `note → reasonText` to match the server contract. New `Test REQ-2` asserts the POST body uses the new keys.
- **WR-08 closed (doc-only).** `useReviewQueue` JSDoc now documents the 5s no-backoff polling policy with the 503-structurally-impossible rationale (the GET `/api/review-queue` route is pure-read, served by the same workbench-api process that serves the surrounding TaskList/CommandView reads, and is NOT gated by `actions.create=true`). Includes a Phase 5+ TODO marker for a shared polling helper.

## Task Commits

1. **Task 1 (CR-01 source fix):** `5dd6dab` `fix(phase-04-w5): emit template.candidate.promoted before annotation patch (CR-01)`
2. **Task 2 (CR-01 regression test + Test 6 tightening + W2-Test 2 update):** `5636495` `test(phase-04-w5): add CR-01 regression test + tighten Test 6 reasonDetail (CR-02)`
3. **Task 3 (CR-02 classifier alignment):** `4d57f11` `fix(phase-04-w5): align candidate-template reasonDetail to DTO spec format (CR-02)`
4. **Task 4 (CR-03 type-only cross-check):** `983909f` `test(phase-04-w5): pin ReviewAcceptedData.reason to @kagent/dto ReviewReason via type-only test (CR-03)`
5. **Task 5 (WR-06 RequestReviewBody rename):** `6c58864` `fix(phase-04-w5): align RequestReviewBody to server contract reviewerId/reasonText (WR-06)`
6. **Task 6 (WR-02 ReviewActionApiError.detail):** `243d259` `feat(phase-04-w5): surface server 422 detail through ReviewActionApiError.detail (WR-02)`
7. **Task 7 (SC3 traceLink anchor):** `1ee669d` `feat(phase-04-w5): render traceLink as direct anchor in review queue table (SC3)`
8. **Task 8 (WR-08 doc-only polling policy):** `c089c30` `docs(phase-04-w5): document useReviewQueue 5s no-backoff polling policy (WR-08)`

_Note: this plan does NOT include the conventional `docs(04-06): complete plan` metadata commit on its own — that commit will land alongside this SUMMARY.md._

## Test Counts Added by Gap

| Gap   | New / Modified Tests                                                                                                  | File                           |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| CR-01 | 1 new test (`W2-Test CR-01`)                                                                                          | review-queue.test.ts           |
| CR-02 | 1 tightened assertion in existing Test 6; 1 ordered-events assertion update in W2-Test 2                              | review-queue.test.ts           |
| CR-03 | 2 new `it()` blocks in NEW file                                                                                       | audit-events/src/types.test.ts |
| WR-02 | 1 extended assertion in Test ACC-2 (adds `detail` to mock body + asserts `caught.detail`); 1 new test (`Test ACC-2b`) | api.test.ts                    |
| WR-06 | 1 new test (`Test REQ-2`)                                                                                             | api.test.ts                    |
| SC3   | 1 new test (`Test SC3`)                                                                                               | ReviewPage.test.tsx            |
| WR-08 | 0 (doc-only)                                                                                                          | n/a                            |

**Net new tests:** 5 new + 3 tightened across 4 test files. All tests pass. Cumulative test counts: workbench-api full suite 201/201, workbench-ui full suite 121/121, audit-events full suite 63/63.

## CR-01 Happy-Path Behavioral Change Note

**Audit-event order on the candidate-template happy path has changed.** Before this plan, the two events fired in this order:

1. patch-success → emit `review.accepted`
2. emit `template.candidate.promoted`

After this plan, the order is:

1. CR-create success → emit `template.candidate.promoted` (NEW position)
2. patch-success → emit `review.accepted`

Both events still fire on the happy path; only their relative order changed. **Downstream audit consumers that rely on event order should sort by the CloudEvents envelope's `time` field or by the JetStream sequence ID (which is monotonic per-stream).** Consumers that previously coded against the implicit "review.accepted appears first" assumption will need a defensive update.

The new order is causally correct: `template.candidate.promoted` records the existence of the AgentTemplate CR (which happens first in the substrate write sequence), and `review.accepted` records that the AgentTask was annotated with the accepted decision (which happens second).

## WR-02 Dialog Rendering Site Note

The plan's `<read_first>` for Task 6 hypothesized that the dialog error rendering might be in either `ReviewPage.tsx` or `ReviewActions.tsx`. **The actual rendering site is BOTH.** Each component owns a self-contained confirm dialog (per the comment in `ReviewActions.tsx` lines 33-37 explaining the duplication-for-isolation choice). Both files store `dialogError` as a `string | null` (not as an `Error` object), so the `error.detail` field is concatenated into the displayed string via `${base} — ${err.detail}` rather than rendered as a separate `<div>`. The plan explicitly permits this minimal form ("the executor's discretion as long as `error.detail` is visibly present in the DOM").

## Files Created/Modified

- `packages/workbench-api/src/routes/review-queue.ts` — CR-01: emit moved (lines 339-368, before patch); old post-patch emit block removed. CR-02: classifier `reasonDetail` literal at line ~907 changed.
- `packages/workbench-api/src/routes/review-queue.test.ts` — CR-01: new `W2-Test CR-01`. CR-02: Test 6 strict-string assertion. CR-01: W2-Test 2 ordered-events assertion + first-publish-type assertion.
- `packages/audit-events/src/types.test.ts` — NEW file. Type-only cross-check for ReviewReason ↔ Review\*Data.reason.
- `packages/audit-events/package.json` — add `@kagent/dto: workspace:*` under `devDependencies`.
- `pnpm-lock.yaml` — record the new workspace edge.
- `packages/workbench-ui/src/api.ts` — WR-06: `RequestReviewBody` renamed. WR-02: `ReviewActionApiError.detail?: string` + 3 POST handler updates. WR-08: JSDoc paragraph above `useReviewQueue`.
- `packages/workbench-ui/src/api.test.ts` — WR-02: Test ACC-2 extended; new Test ACC-2b. WR-06: new Test REQ-2.
- `packages/workbench-ui/src/ReviewPage.tsx` — SC3: trace anchor inserted in Task cell; WR-02: dialog error string concatenation.
- `packages/workbench-ui/src/ReviewPage.test.tsx` — SC3: new Test SC3.
- `packages/workbench-ui/src/ReviewPage.module.css` — SC3: `.traceLink` style class.
- `packages/workbench-ui/src/command/ReviewActions.tsx` — WR-02: dialog error string concatenation (mirror change).

## Decisions Made

See frontmatter `key-decisions` for the substantive five. Concise:

- **Audit emission ordering** — emit immediately after substrate write succeeds, BEFORE downstream best-effort writes (CR-01).
- **DTO as single source of truth at tier boundary** — classifier produces what DTO JSDoc documents (CR-02).
- **Type-only cross-package pin for LM-10** — `import type` + devDependency, no runtime emit edge (CR-03).
- **Single-string dialog error rendering** — minimal-form WR-02 surfacing; React text-children escaping is the defense (T-04-06-02 disposition: accept).
- **No `requestReview` production callers** — interface rename was a name-only change in v0.2 (WR-06).

## Deviations from Plan

### Auto-fixed Issues

None (Rules 1–3). The plan as written executed cleanly. Three minor adjustments worth noting:

1. **Pre-commit hooks reformatted three test files.** lint-staged ran `eslint --fix` and `prettier --write` on each commit. The reformatting was cosmetic (license-header collapse, prettier rewraps); no logic changed. Files affected: `review-queue.test.ts`, `types.test.ts`, `api.test.ts`. This is normal repo workflow, not a deviation from plan intent.

2. **WR-02 dialog rendering chose single-string concatenation** over the plan's optional `<div>` split. The plan's Task 6 `<action>` step 5 explicitly permits this minimal form ("If the dialog error rendering uses a plain string instead of conditional element splitting, accept the minimal change..."). Since both `ReviewPage.tsx` and `ReviewActions.tsx` store `dialogError` as `string | null` and not as an `Error` object, restructuring to use a separate `<div>` would have required changing the state shape to hold the `ReviewActionApiError` instance — an additional refactor outside the plan's scope.

3. **WR-06 dialog rendering site identified as BOTH `ReviewPage.tsx` AND `ReviewActions.tsx`.** The plan's `<read_first>` allowed for either or both; both ship the change for symmetry. Documented in the WR-02 section above.

**Total deviations:** 0 auto-fixed (Rules 1–3); 0 architectural escalations (Rule 4). The 3 minor adjustments above are well within the plan's permitted-discretion language.

## Self-Check

**Files verified to exist on disk:**

- `[ -f packages/workbench-api/src/routes/review-queue.ts ]` — PASS
- `[ -f packages/workbench-api/src/routes/review-queue.test.ts ]` — PASS
- `[ -f packages/audit-events/src/types.test.ts ]` — PASS (NEW)
- `[ -f packages/audit-events/package.json ]` — PASS
- `[ -f packages/workbench-ui/src/api.ts ]` — PASS
- `[ -f packages/workbench-ui/src/api.test.ts ]` — PASS
- `[ -f packages/workbench-ui/src/ReviewPage.tsx ]` — PASS
- `[ -f packages/workbench-ui/src/ReviewPage.test.tsx ]` — PASS
- `[ -f packages/workbench-ui/src/ReviewPage.module.css ]` — PASS
- `[ -f packages/workbench-ui/src/command/ReviewActions.tsx ]` — PASS

**Commits verified to exist on `main`:**

```
$ git log --pretty=format:"%h %s" 6753f86..HEAD
c089c30 docs(phase-04-w5): document useReviewQueue 5s no-backoff polling policy (WR-08)
1ee669d feat(phase-04-w5): render traceLink as direct anchor in review queue table (SC3)
243d259 feat(phase-04-w5): surface server 422 detail through ReviewActionApiError.detail (WR-02)
6c58864 fix(phase-04-w5): align RequestReviewBody to server contract reviewerId/reasonText (WR-06)
983909f test(phase-04-w5): pin ReviewAcceptedData.reason to @kagent/dto ReviewReason via type-only test (CR-03)
4d57f11 fix(phase-04-w5): align candidate-template reasonDetail to DTO spec format (CR-02)
5636495 test(phase-04-w5): add CR-01 regression test + tighten Test 6 reasonDetail (CR-02)
5dd6dab fix(phase-04-w5): emit template.candidate.promoted before annotation patch (CR-01)
```

All 8 task commits present, in order, with correct conventional-commits prefixes.

**Plan-level verification re-run:**

- `grep -n "type: TEMPLATE_CANDIDATE_PROMOTED" packages/workbench-api/src/routes/review-queue.ts` → line 367 (BEFORE the patch line at 388) — PASS
- `grep -c "candidate AgentTemplate from" packages/workbench-api/src/routes/review-queue.ts` → 0 — PASS
- `grep -c "(candidate)" packages/workbench-api/src/routes/review-queue.ts` → 1 — PASS
- `grep -nE "reviewerId\?:|reasonText\?:" packages/workbench-ui/src/api.ts` → 6 matches across 3 interfaces — PASS
- `grep -nE "detail\?:\s*string" packages/workbench-ui/src/api.ts` → 5 matches (1 class field, 1 ctor sig, 3 errBody locals) — PASS
- `pnpm -r typecheck` → all packages clean — PASS
- `pnpm -F @kagent/workbench-api test routes/review-queue.test.ts` → 27/27 — PASS
- `pnpm -F @kagent/audit-events test types.test.ts` → 2/2 — PASS
- `pnpm -F @kagent/workbench-ui test api.test.ts ReviewPage.test.tsx` → 24/24 — PASS

**Full-package suites (regression check):**

- `pnpm -F @kagent/workbench-api test` → 201/201 — PASS
- `pnpm -F @kagent/workbench-ui test` → 121/121 — PASS
- `pnpm -F @kagent/audit-events test` → 63/63 — PASS

## Self-Check: PASSED

## Issues Encountered

None — the plan executed cleanly. The single workflow friction point was the local Node version (`v23.11.1` vs the engines-pinned `>=22.0.0 <23.0.0`); resolved by prefixing all commands with `export PATH="/Users/chrisknuteson/.nvm/versions/node/v22.13.1/bin:$PATH"` since the `.nvmrc` calls out v22 and nvm has v22.13.1 installed locally.

## Hand-off Note for /gsd-verify-phase 04 Re-Verification

**All 3 ROADMAP success criteria SC1 / SC2 / SC3 should now satisfy.**

- **SC1 (review queue projection):** Already verified in initial 04-VERIFICATION.md (status VERIFIED). Unchanged.
- **SC2 (AgentTemplate promotion flow with audit-event recording):** The CR-01 BLOCKER is closed by the new emission ordering + the new `W2-Test CR-01` regression test. The audit log now permanently records every successful AgentTemplate CR creation, regardless of whether the downstream annotation patch lands. On patch failure, `review.accepted` is correctly NOT emitted (the decision did not land in the substrate); on patch success, both events fire in causal order.
- **SC3 (replay/eval signals → queue rows + reviewer can navigate to artifact):** Closed by the new direct `traceLink` anchor in `ReviewPage.tsx` + `Test SC3`. Reviewer now has a one-hop path from queue row to underlying eval/replay artifact (Langfuse trace URL), satisfying the literal ROADMAP language.

**Anti-patterns CR-02 / CR-03 / WR-02 / WR-06 / WR-08 are all closed** with regression tests where applicable (CR-02 strict-string Test 6 assertion; CR-03 type-only cross-check; WR-02 Test ACC-2 + ACC-2b; WR-06 Test REQ-2).

The 3 human-verification items in `04-VERIFICATION.md` remain operational rather than plannable code — they require a real K3s cluster + browser. Recommend running them as part of the homelab deployment validation when the next workbench-api image is rolled out.

## Next Phase Readiness

- Phase 4 ready for `/gsd-verify-phase 04` re-verification — expect `status: verified`, 3/3 must-haves.
- Phase 5+ TODO surfaced in WR-08 JSDoc: shared polling helper with optional exponential backoff and SSE invalidation seam.
- Downstream audit-stream consumers should be made aware of the CR-01 happy-path event-order change (template.candidate.promoted now precedes review.accepted) — recommend coordinating with consumer-side teams before promotion to production.

---

_Phase: 04-review-queue-projection-promotion-path_
_Completed: 2026-05-10_
