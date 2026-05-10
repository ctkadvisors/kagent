---
phase: 04-review-queue-projection-promotion-path
verified: 2026-05-10T19:18:00Z
status: verified
score: 3/3 must-haves verified
gaps_found: 0/3
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 2/3
  gaps_closed:
    - 'CR-01 (BLOCKER) — template.candidate.promoted now emitted IMMEDIATELY after CR creation, BEFORE annotation patch (review-queue.ts:367 < :388). On patch failure the audit log permanently records AgentTemplate CR existence; review.accepted is correctly NOT emitted because the decision did not land.'
    - 'SC3 (WARNING) — traceLink rendered as direct <a target="_blank" rel="noreferrer"> anchor in ReviewPage.tsx:208-219 for rows that carry the field; one-hop row→artifact navigation now matches the literal ROADMAP SC3 language.'
  gaps_remaining: []
  regressions: []
warning_anti_patterns_closed:
  - 'CR-02 — classifier reasonDetail aligned to DTO JSDoc spec format `${proposedTemplateName} (candidate)` (review-queue.ts:907); old "candidate AgentTemplate from ${ns}/${name}" form removed; Test 6 enforces exact string.'
  - 'CR-03 — type-only cross-check pinning ReviewAcceptedData.reason / ReviewRejectedData.reason to @kagent/dto ReviewReason via `import type` (audit-events/src/types.test.ts NEW; @kagent/dto added as devDependencies in audit-events/package.json — LM-10 leaf-package posture preserved).'
  - 'WR-02 — ReviewActionApiError now carries `readonly detail?: string`; 422 handlers in api.ts read `errBody.detail` and propagate to dialog UI in ReviewPage.tsx and ReviewActions.tsx via string concatenation.'
  - 'WR-06 — RequestReviewBody fields renamed `requestedBy → reviewerId`, `note → reasonText` to match server contract; new Test REQ-2 asserts the wire format.'
  - 'WR-08 (doc-only) — JSDoc above useReviewQueue documents the 5s no-backoff polling policy with the 503-structurally-impossible rationale (api.ts:483-501) and a Phase 5+ TODO marker for a shared polling helper.'
human_verification: # carried forward from prior report — operational, not plannable code work
  - test: 'Candidate-template accept under real K3s'
    expected: 'AgentTemplate CR created; review-decision: accepted annotation written; review.accepted and template.candidate.promoted events in JetStream; task disappears from GET /api/review-queue next poll'
    why_human: 'Unit tests mock customApi; real K8s RBAC, CR schema validation, and NATS publish path are not exercised. Run as part of homelab deployment validation.'
  - test: 'Patch-failure audit ordering (CR-01 regression test under real cluster)'
    expected: 'After CR-01 fix is deployed, accept a candidate-template task while the annotation PATCH fails (e.g., RBAC revocation mid-flight). Verify template.candidate.promoted IS in the audit log; review.accepted is absent; reviewer retry returns 409 (k8s collision) and a second clean accept attempt succeeds.'
    why_human: 'End-to-end failure injection requires a real cluster; unit test exercises this path with a mocked customApi (W2-Test CR-01 in review-queue.test.ts) but real K8s + NATS confirms the substrate-level invariant.'
  - test: 'Visual one-hop navigation from #/review row to underlying eval/replay artifact (SC3)'
    expected: 'Open #/review in browser; for a row with traceLink, click the new "trace" anchor adjacent to the Task cell. Tab opens to the Langfuse trace URL. For a row without traceLink, only the Task cell link is present and indirect navigation via TaskDetail still works.'
    why_human: 'Browser visual flow requires manual exercise; unit test (Test SC3 in ReviewPage.test.tsx) asserts the anchor renders with the correct href/target/rel but not the click-through behavior in a live browser.'
---

# Phase 4: Review Queue Projection + Promotion Path — Verification Report (Re-Verification)

**Phase Goal:** Strengthen review queue ergonomics, AgentTemplate promotion, and replay/eval signal surfacing using existing v0.1 substrate primitives — `AgentTask`, `ArtifactRef`, verifier outputs, audit events. No `Tool`, `SteeringEvent`, `TaskReview`, `Channel`, or `Post` CRD.
**Verified:** 2026-05-10T19:18:00Z
**Status:** verified
**Re-verification:** Yes — Wave 5 / Plan 04-06 gap closure shipped. Prior report at `04-VERIFICATION.md` (2026-05-10T00:00:00Z) found `gaps_found: 2/3`. This re-verification finds `gaps_found: 0/3`.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| #   | Truth (ROADMAP SC)                                                                                                                                                                                 | Status   | Evidence (codebase)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **SC1 / REV-01** — Review queue projection lists every terminal AgentTask needing review, sorted by staleness, reload-stable, no new persistence                                                   | VERIFIED | `GET /api/review-queue` in `routes/review-queue.ts` (988 lines): pure-read over `SnapshotCache.listTasks()` + `classifyTask()` priority-ordered classifier; sort by descending stalenessSeconds; reload-stability test in `review-queue.test.ts` (Test 12 of 27 passing). Router mount at `router.ts:229-237`. No new persistence (computed projection only). Status: unchanged from prior report.                                                                                                                                                                                                                                     |
| 2   | **SC2 / REV-02** — AgentTemplate promotion flow end-to-end: candidate reviewable in queue; accept/reject recorded as audit events tied back; accepted candidate becomes versioned AgentTemplate CR | VERIFIED | POST handlers wired (accept lines 200-440; reject lines 457-577; request lines 578-690). **CR-01 fix landed:** `TEMPLATE_CANDIDATE_PROMOTED` published at `routes/review-queue.ts:367` BEFORE `patchNamespacedCustomObject` at `:388`. Audit log permanently records AgentTemplate CR existence even on annotation-patch failure. Regression test `W2-Test CR-01` (review-queue.test.ts:753-812) asserts the new ordering: publish-call invocationCallOrder < patch-call invocationCallOrder, only `template.candidate.promoted` in publish history (not `review.accepted`), 500 returned. The 27-test suite passes.                   |
| 3   | **SC3 / REV-03** — Replay/eval signals surface into queue projection; reviewer can navigate from queue row to underlying eval/replay artifact in ONE hop                                           | VERIFIED | `traceLink` rendered as a direct `<a target="_blank" rel="noreferrer">` anchor in `ReviewPage.tsx:208-219` adjacent to the Task cell, for rows whose `traceLink` is a non-empty string. Test SC3 in `ReviewPage.test.tsx:113-142` asserts the anchor renders with the correct href, target, and rel attributes, and is absent for rows without traceLink. The verifier-failed + suspicious-detector classifications (the v0.2 producers per CONTEXT.md D-04-A) populate traceLink at the classifier level (review-queue.ts:802-830). Reserved enum slots `replay-divergence` and `eval-failed` carried forward for Phase 5+ producers. |

**Score:** 3/3 truths fully VERIFIED.

### Forbidden CRD Constraint

VERIFIED — No new `Tool`, `SteeringEvent`, `TaskReview`, `Channel`, or `Post` CRD introduced. Only RBAC Role extensions (`agenttasks: [patch]`, `agenttemplates: [create]`) and ClusterRole read-verb extension (`agenttemplates: [get,list,watch]`) — same as prior report. Spot-check via grep on `packages/operator/charts/` shows no forbidden `kind:` declarations.

### Requirements Coverage

| Requirement | Plans                          | Status    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REV-01      | 04-02, 04-04, 04-05            | SATISFIED | `GET /api/review-queue` projection live; descending-staleness sort verified; reload-stability tested; `useReviewQueue` 5s polling hook in `api.ts:503`; ReviewPage at `#/review`; attention flow flipped to reviewQueueRowCount in `flows.ts:289-308`. Unchanged from prior report.                                                                                                                                     |
| REV-02      | 04-03, 04-04, **04-06**        | SATISFIED | POST handlers; candidate-template CR creation BEFORE annotation patch; **CR-01 audit-emit ordering fix landed** so substrate cannot reach a state with the AgentTemplate CR present and zero audit record. Single-reviewer scope per CONTEXT.md D-03; multi-reviewer is future research per REQUIREMENTS.md §4. ReviewPage + ReviewActions UI surfaces exist. Plan 04-06 gap closure tightens the audit-emit invariant. |
| REV-03      | 04-01, 04-02, 04-05, **04-06** | SATISFIED | Enum slots reserved (replay-divergence, eval-failed; zero v0.2 producers per D-04-A); verifier-failed + suspicious-detector classifications proxy the v0.2 eval/replay signal space; **SC3 traceLink direct anchor in ReviewPage** delivers literal one-hop row→artifact navigation. Docs footers in REPLAY-EVALS.md + AGENT-TEMPLATES.md retain the Phase 5+ promotion path.                                           |

### Required Artifacts

| Artifact                                                 | Expected                                                                                                                                                         | Status   | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench-api/src/routes/review-queue.ts`      | TEMPLATE_CANDIDATE_PROMOTED emit BEFORE patchNamespacedCustomObject; classifier reasonDetail = `${proposedTemplateName} (candidate)` for candidate-template rows | VERIFIED | 988 lines. Emit at line 367 (inside post-CR-create / pre-patch block at lines 354-384); patch at line 388. Classifier reasonDetail at line 907 — exact spec format. Old "candidate AgentTemplate from" string returns 0 grep matches.                                                                                                                                                                                                                     |
| `packages/workbench-api/src/routes/review-queue.test.ts` | W2-Test CR-01 regression test for patch-failure path; W2-Test 6 strict-string assertion for reasonDetail                                                         | VERIFIED | 1185 lines, 27 tests passing. W2-Test CR-01 at line 753 asserts publish call order < patch call order, exactly one publish (TEMPLATE_CANDIDATE_PROMOTED), no review.accepted in publish history, 500 response. W2-Test 6 at line 900 enforces the exact `${proposedTemplateName} (candidate)` literal.                                                                                                                                                    |
| `packages/audit-events/src/types.test.ts` (NEW)          | Type-only cross-check pinning ReviewAcceptedData.reason and ReviewRejectedData.reason to @kagent/dto ReviewReason                                                | VERIFIED | 28 lines. `import type { ReviewReason }` from `@kagent/dto/review-queue` (line 8). Two `it()` blocks (lines 12, 22) assert bidirectional assignability. tsc strips type-only import at emit (LM-10 preserved).                                                                                                                                                                                                                                            |
| `packages/audit-events/package.json`                     | @kagent/dto added as devDependency at workspace:\*                                                                                                               | VERIFIED | Line 28: `"@kagent/dto": "workspace:*"` in devDependencies. Runtime dependencies block unchanged.                                                                                                                                                                                                                                                                                                                                                         |
| `packages/workbench-ui/src/api.ts`                       | RequestReviewBody renamed (reviewerId/reasonText); ReviewActionApiError.detail field; useReviewQueue JSDoc with 5s no-backoff rationale                          | VERIFIED | 548 lines. RequestReviewBody at lines 309-312 with reviewerId/reasonText. ReviewActionApiError class at lines 345-362 with `readonly detail?: string` (line 353) and ctor signature `constructor(status, message, detail?)` (line 354). 422 handlers in accept/reject/request read `errBody.detail` and propagate. JSDoc above useReviewQueue at lines 483-501 documents 5s no-backoff with 503-structurally-impossible rationale + Phase 5+ TODO marker. |
| `packages/workbench-ui/src/api.test.ts`                  | WR-02 Test ACC-2 + ACC-2b for detail surfacing; WR-06 Test REQ-2 for reviewerId/reasonText wire format                                                           | VERIFIED | 370 lines, 11 tests passing in this file (24 total across api.test.ts + ReviewPage.test.tsx). Test ACC-2 at line 254 asserts `caught?.detail === 'missing agentSpec.targetAgent'`. Test ACC-2b at line 277 asserts `caught?.detail === undefined` when server omits detail. Test REQ-2 at line 352 asserts request body `{ reviewerId, reasonText }`.                                                                                                     |
| `packages/workbench-ui/src/ReviewPage.tsx`               | traceLink anchor adjacent to Task cell with target=\_blank rel=noreferrer                                                                                        | VERIFIED | 319 lines. Lines 206-219 render `<a href={row.traceLink} target="_blank" rel="noreferrer" className={styles.traceLink} data-testid={...}>trace</a>` only when row.traceLink is a non-empty string. Wired with data-source-field for source-binding contract.                                                                                                                                                                                              |
| `packages/workbench-ui/src/ReviewPage.test.tsx`          | Test SC3 asserts traceLink anchor render with correct href/target/rel, absent when row.traceLink omitted                                                         | VERIFIED | 292 lines. Test SC3 at line 113 mounts two rows (with + without traceLink), asserts exactly one anchor with the correct href, target=\_blank, rel=noreferrer. data-testid scoping confirms per-row rendering.                                                                                                                                                                                                                                             |
| `packages/workbench-ui/src/ReviewPage.module.css`        | .traceLink CSS class                                                                                                                                             | VERIFIED | Modified per SUMMARY (Plan 04-06 commit 1ee669d).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/workbench-ui/src/command/ReviewActions.tsx`    | Dialog error string includes error.detail when present (mirror of WR-02)                                                                                         | VERIFIED | Modified per SUMMARY (Plan 04-06 commit 243d259); same pattern as ReviewPage.tsx confirm dialog.                                                                                                                                                                                                                                                                                                                                                          |

All artifacts from prior report (DTO files, fixtures, RBAC manifests, audit-events types, docs footers) carry forward unchanged from the prior verification report and remain VERIFIED.

### Key Link Verification

| From                                                     | To                                                              | Via                                                                                        | Status | Details                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------- |
| `routes/review-queue.ts (line 354 post-CR-create block)` | `auditPublisher.publish({ type: TEMPLATE_CANDIDATE_PROMOTED })` | `await deps.auditPublisher.publish(makeEvent({ type: TEMPLATE_CANDIDATE_PROMOTED, ... }))` | WIRED  | Line 367, BEFORE the patch try at line 388. Causally correct (CR exists → record exists).                 |
| `routes/review-queue.ts (line 388 patch try)`            | `auditPublisher.publish({ type: REVIEW_ACCEPTED })`             | Post-patch try emit block                                                                  | WIRED  | Line 419, GATED on patch-success path.                                                                    |
| `audit-events/src/types.test.ts`                         | `@kagent/dto/review-queue (ReviewReason)`                       | `import type { ReviewReason } from '@kagent/dto/review-queue';`                            | WIRED  | Line 8. Type-only import; tsc strips at emit. devDependencies satisfies typecheck-time module resolution. |
| `workbench-ui/api.ts (acceptReviewQueueRow 422 handler)` | `ReviewActionApiError.detail`                                   | `errBody.detail → new ReviewActionApiError(status, message, errBody.detail)`               | WIRED  | Lines 397-408 (accept), 428-439 (reject), 458-470 (request).                                              |
| `workbench-ui/ReviewPage.tsx (row render)`               | `row.traceLink anchor`                                          | `{typeof row.traceLink === 'string' && row.traceLink.length > 0 ? <a ... /> : null}`       | WIRED  | Lines 208-219. Source-binding via `data-source-field={useSourceField('traceLink')}`.                      |
| `workbench-ui/api.ts useReviewQueue`                     | `5s polling, no backoff`                                        | `setInterval(refresh, 5_000)` at lines 535-537; JSDoc at 478-501 documents the policy      | WIRED  | Doc-only WR-08 closure; behavior unchanged.                                                               |

All key links from prior report (DTO ↔ projection, projection ↔ route, route ↔ router, hook ↔ ReviewPage, attention flow ↔ snapshot) carry forward unchanged.

### Data-Flow Trace (Level 4)

| Artifact                     | Data Variable                            | Source                                                                                                                                | Produces Real Data                                                                                                             | Status  |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `ReviewPage.tsx`             | `rows` from `useReviewQueue()`           | `fetchReviewQueue()` → `GET /api/review-queue` → `classifyTask(SnapshotCache.listTasks())`                                            | Yes — SnapshotCache populated by operator informer; projection is pure-read over real task data                                | FLOWING |
| `ReviewPage.tsx (traceLink)` | `row.traceLink`                          | classifier in `routes/review-queue.ts` reads task `pilotEvidence.trace?.langfuseTraceUrl` (or equivalent field) and projects into row | Yes — when underlying tasks carry trace metadata, the field flows; otherwise the conditional render correctly hides the anchor | FLOWING |
| `flows.ts attention compute` | `s.reviewQueueRowCount`                  | `CommandView.tsx` → `useReviewQueue().rows.length` → `fetchReviewQueue()` → `GET /api/review-queue`                                   | Yes — counts real queue rows                                                                                                   | FLOWING |
| `ReviewActions.tsx`          | `task.pilotEvidence?.audit?.annotations` | TaskDetail prop chain from `useEffect` + `fetchTaskDetail()`                                                                          | Yes — reads real AgentTask annotation data                                                                                     | FLOWING |

### Behavioral Spot-Checks

| Behavior                                                                             | Check                                                                                        | Result                                                               | Status |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| review-queue.ts emits TEMPLATE_CANDIDATE_PROMOTED before patchNamespacedCustomObject | `grep -nE "TEMPLATE_CANDIDATE_PROMOTED\|patchNamespacedCustomObject" routes/review-queue.ts` | line 367 < line 388                                                  | PASS   |
| Old reasonDetail string fully removed                                                | `grep -c "candidate AgentTemplate from" routes/review-queue.ts`                              | 0                                                                    | PASS   |
| New reasonDetail spec format present                                                 | `grep -c "(candidate)" routes/review-queue.ts`                                               | 1                                                                    | PASS   |
| RequestReviewBody fields match server contract                                       | `grep -nE "reviewerId\?:\|reasonText\?:" workbench-ui/src/api.ts`                            | 6 matches across AcceptReviewBody/RejectReviewBody/RequestReviewBody | PASS   |
| ReviewActionApiError.detail field present                                            | `grep -nE "detail\?:\s*string" workbench-ui/src/api.ts`                                      | 5 matches (1 class field + 1 ctor + 3 errBody locals)                | PASS   |
| Type-only cross-check file present                                                   | `[ -f packages/audit-events/src/types.test.ts ]`                                             | exists, 28 lines                                                     | PASS   |
| @kagent/dto added as devDependency in audit-events                                   | `grep "@kagent/dto" packages/audit-events/package.json`                                      | line 28: workspace:\* under devDependencies                          | PASS   |
| traceLink anchor present in ReviewPage.tsx with target=\_blank rel=noreferrer        | `grep -nE "traceLink" workbench-ui/src/ReviewPage.tsx`                                       | lines 207-215 wire all three attributes                              | PASS   |
| pnpm -F @kagent/workbench-api test routes/review-queue.test.ts                       | full run                                                                                     | 27/27 passing                                                        | PASS   |
| pnpm -F @kagent/audit-events test                                                    | full run                                                                                     | 63/63 passing across 3 test files                                    | PASS   |
| pnpm -F @kagent/workbench-ui test api.test.ts ReviewPage.test.tsx                    | targeted run                                                                                 | 24/24 passing across 2 files                                         | PASS   |
| pnpm -r typecheck                                                                    | all packages                                                                                 | clean across 19 packages                                             | PASS   |
| No 501-stub remnants                                                                 | `grep "501.*not.*implemented" routes/review-queue.ts`                                        | 0 matches                                                            | PASS   |
| No forbidden CRDs (Tool, SteeringEvent, TaskReview, Channel, Post)                   | grep on packages/operator/charts/ for kind:                                                  | 0 matches                                                            | PASS   |
| Gap-closure commits present                                                          | `git log 6753f86..HEAD --oneline`                                                            | 9 commits (8 task + 1 SUMMARY)                                       | PASS   |

### Anti-Patterns Found

| File                                   | Issue                                              | Severity | Impact                                                                                    |
| -------------------------------------- | -------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `packages/workbench-ui/src/api.ts:496` | `TODO (Phase 5+)` marker for shared polling helper | INFO     | Documented Phase 5+ design note per WR-08 doc-only closure; not a defect. Plan-permitted. |

No BLOCKER or WARNING anti-patterns remain. CR-01 / CR-02 / CR-03 / WR-02 / WR-06 / WR-08 all closed and verified by grep + behavioral spot-checks + tests.

### Human Verification Required

Three operational items remain — these require a real K3s cluster + browser and cannot be exercised by unit tests. They are NOT gaps in the phase work; they are the standard operational validation step before any new image rolls out via GitOps.

#### 1. Candidate-template accept under real K3s

**Test:** Deploy workbench-api against a real K3s cluster; create an AgentTask with `template-candidate=true` annotation and a valid `payloadBase64` artifact; POST accept via UI ReviewPage.
**Expected:** AgentTemplate CR created; `review-decision: accepted` annotation written; `review.accepted` and `template.candidate.promoted` events in JetStream; task disappears from `GET /api/review-queue` next poll.
**Why human:** Unit tests mock customApi; real K8s RBAC, CR schema validation, and NATS publish path are not exercised.

#### 2. CR-01 patch-failure audit ordering under real cluster

**Test:** With the CR-01 fix deployed (HEAD includes commit 5dd6dab), accept a candidate-template task while the annotation PATCH fails (e.g., revoke the `agenttasks: [patch]` RBAC mid-flight).
**Expected:** `template.candidate.promoted` IS in the JetStream audit log even though the patch failed and the response is 500. `review.accepted` is absent. Reviewer retry returns 409 (k8s collision on AgentTemplate CR) and a second clean accept attempt (after RBAC restored) succeeds.
**Why human:** End-to-end failure injection requires a real cluster. The unit-test path (`W2-Test CR-01` in `routes/review-queue.test.ts`) exercises this with a mocked customApi; real K8s + NATS confirms the substrate-level invariant.

#### 3. SC3 visual one-hop navigation

**Test:** Open `#/review` in browser; for a row whose `traceLink` is populated, click the new "trace" anchor adjacent to the Task cell.
**Expected:** New tab opens to the Langfuse trace URL. For rows without traceLink, only the Task cell `{namespace}/{name}` link is rendered (indirect navigation via TaskDetail).
**Why human:** Browser visual flow + click-through behavior requires manual exercise; Test SC3 in `ReviewPage.test.tsx` asserts the anchor renders with correct attributes but does not exercise click-through.

### Gaps Summary

**No gaps remain.**

The two prior gaps (`CR-01 BLOCKER` and `SC3 traceLink WARNING`) are both closed by Plan 04-06:

- **CR-01 fix**: `template.candidate.promoted` audit event now fires immediately after AgentTemplate CR creation succeeds (line 367), BEFORE the annotation patch attempt (line 388). The `review.accepted` event remains gated on the patch-success path. On patch failure: substrate has the AgentTemplate CR, has a `template.candidate.promoted` audit record, but no `review.accepted` and no review-decision annotation — auditors can correctly distinguish "CR created, decision not landed" from "decision landed cleanly". A 27th test (`W2-Test CR-01`) asserts the new ordering and the publish-vs-not-publish behavior on the patch-failure path; the 26th test from the prior report continues to assert ordering on the happy path.
- **SC3 fix**: ReviewPage.tsx now renders a direct `<a href={row.traceLink} target="_blank" rel="noreferrer">trace</a>` anchor adjacent to the Task cell for any row whose `traceLink` is populated. Test SC3 in `ReviewPage.test.tsx` asserts the anchor renders with the correct href/target/rel and is absent for rows without traceLink. The literal ROADMAP SC3 ("Reviewer can navigate from queue row to underlying eval/replay artifact") is now satisfied with one-hop direct navigation; the indirect Task → TaskDetail → trace path remains via the existing `{namespace}/{name}` link.

The five warning-tier anti-patterns (CR-02, CR-03, WR-02, WR-06, WR-08) are all closed. See the `warning_anti_patterns_closed:` block in the frontmatter for the per-finding evidence.

The three human-verification items are operational, not plannable code — they validate the deployed substrate at homelab-rollout time.

---

_Re-verified: 2026-05-10T19:18:00Z_
_Verifier: Claude (gsd-verifier)_
_Prior report: 2026-05-10T00:00:00Z (gaps_found 2/3)_
_Phase status delta: gaps_found 2/3 → verified 3/3_
