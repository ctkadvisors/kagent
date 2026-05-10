---
phase: 04-review-queue-projection-promotion-path
verified: 2026-05-10T00:00:00Z
status: gaps_found
score: 2/3 must-haves verified
overrides_applied: 0
re_verification: null
gaps:
  - truth: 'AgentTemplate promotion proposal flow exists end-to-end: accept/reject decisions are recorded as audit events tied back to the candidate'
    status: partial
    reason: 'CR-01 (code-review BLOCKER): when candidate-template CR creation succeeds but the subsequent annotation PATCH fails, the handler returns HTTP 500 and emits ZERO audit events — neither review.accepted nor template.candidate.promoted fires. The AgentTemplate CR exists in the cluster, the AgentTask has no review-decision annotation, so it stays in the queue. A reviewer retry hits the K8s 409 collision path (line 333) and returns 422 with STILL no audit events. The audit log permanently lacks any record of the AgentTemplate that was actually created. The spec header at line 195 of review-queue.ts promises events fire when the CR exists, but the code order forecloses them.'
    artifacts:
      - path: 'packages/workbench-api/src/routes/review-queue.ts'
        issue: 'Lines 349-375 (annotation patch) return 500 on failure BEFORE lines 377-431 (audit emission). CR creation at lines 311-346 succeeds and captures agentTemplateRef, but the TEMPLATE_CANDIDATE_PROMOTED event is gated inside the post-patch audit block at line 402. On patch failure, execution exits at line 374 without ever reaching the audit block.'
    missing:
      - "Emit template.candidate.promoted IMMEDIATELY after CR creation succeeds (between line 320 and line 349), before the annotation patch attempt. This preserves the audit record of the CR's existence even when the subsequent patch fails. A test must assert template.candidate.promoted published on CR-create-success + patch-failure path."
  - truth: 'Replay / eval signals (existing v0.1 controllers) surface their outputs into the review queue projection — a failed eval or replay divergence becomes a queue row with the same shape as a verifier failure. Reviewer can navigate from queue row to underlying eval/replay artifact.'
    status: partial
    reason: "SC3 is only partially satisfied. The review-queue projection accepts the v0.2 scoped-down interpretation: verifier-failed and suspicious-detector rows proxy for eval/replay signals (CONTEXT.md D-04-A), and the ReviewReason enum reserves replay-divergence and eval-failed slots for Phase 5+. However, the ROADMAP SC3 text says 'a failed eval or replay divergence becomes a queue row' — which does NOT happen in v0.2 (zero producers). The 'Reviewer can navigate from queue row to underlying eval/replay artifact' is satisfied ONLY indirectly: the Task column in ReviewPage links to #/tasks/<ns>/<name> (TaskDetail), where the trace link is visible. There is no direct traceLink column rendered in ReviewPage, and the traceLink field in ReviewQueueRow (populated by the classifier for all row types) is never surfaced to the reviewer. Navigation from queue row to artifact exists but is one hop indirect."
    artifacts:
      - path: 'packages/workbench-ui/src/ReviewPage.tsx'
        issue: 'traceLink field from ReviewQueueRow DTO is never rendered in the table. The Task column (line 189) links to #/tasks/<ns>/<name> which is indirect navigation to the artifact. Per SC3, direct row-to-artifact navigation should be available from the queue row itself.'
    missing:
      - 'Either: (a) render traceLink as a direct column or hyperlink in the ReviewPage table for rows that have it, OR (b) explicit acknowledgment that indirect navigation via TaskDetail is the accepted Phase 4 scope per CONTEXT.md D-04-A and SC3 is satisfied by the stub + docs approach.'
human_verification:
  - test: 'Accept a verifier-failed AgentTask via POST /api/review-queue (against a real cluster or integration test harness)'
    expected: 'review-decision: accepted annotation written to AgentTask; review.accepted audit event in JetStream; AgentTask disappears from GET /api/review-queue on next poll'
    why_human: 'Cannot test K8s API write path programmatically without a running cluster; only unit tests with mock customApi are available.'
  - test: 'Accept a candidate-template task, then artificially fail the annotation PATCH (e.g., RBAC revocation), and verify the audit record'
    expected: 'After CR-01 fix: template.candidate.promoted event should be present in the audit log even though the annotation PATCH failed'
    why_human: 'End-to-end failure injection requires a real cluster; the unit test for this path only mocks the customApi.'
  - test: 'Open ReviewPage at #/review and click the Task column link for a verifier-failed row'
    expected: 'Navigates to TaskDetail where the Langfuse trace link is visible; operator can follow it to the underlying eval artifact'
    why_human: 'Visual flow and link rendering require browser verification; unit tests mock the routing.'
---

# Phase 4: Review Queue Projection + Promotion Path — Verification Report

**Phase Goal:** Strengthen review queue ergonomics, AgentTemplate promotion, and replay/eval signal surfacing using existing v0.1 substrate primitives — `AgentTask`, `ArtifactRef`, verifier outputs, audit events. No `Tool`, `SteeringEvent`, `TaskReview`, `Channel`, or `Post` CRD.
**Verified:** 2026-05-10T00:00:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Success Criteria from ROADMAP.md)

| #   | Truth                                                                                                                                                                 | Status                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Review queue projection lists every terminal AgentTask needing review, sorted by staleness, reload-stable, no new persistence                                         | VERIFIED                 | `GET /api/review-queue` in `routes/review-queue.ts` (981 lines): pure-read `SnapshotCache.listTasks()` + `classifyTask()` classifier (lines 776-928); sort at line 181; reload-stability asserted in Test 12 of 26 passing tests. Router mounted at line 229 of `router.ts`.                                                                                                                                                                                                                                                                                                                                                  |
| 2   | AgentTemplate promotion flow end-to-end: candidate reviewable in queue; accept/reject recorded as audit events; accepted candidate becomes versioned AgentTemplate CR | PARTIAL (BLOCKER: CR-01) | POST handlers implemented: accept (lines 200-440), reject (lines 457-577), request (lines 578-690). CR creation at lines 311-346 precedes annotation patch at lines 349-375. However: annotation patch failure (line 374) returns 500 BEFORE audit emission block (lines 377-431), so `template.candidate.promoted` is never emitted when CR is created but patch fails. The audit log permanently misses the CR creation event in this failure mode. CR-01 from the code review is confirmed.                                                                                                                                |
| 3   | Replay/eval signals surface into queue projection; reviewer can navigate from queue row to underlying eval/replay artifact                                            | PARTIAL                  | `ReviewReason` enum has `replay-divergence` + `eval-failed` slots (Phase 5+ stubs, zero v0.2 producers per CONTEXT.md D-04-A). Verifier-failed + suspicious-detector rows proxy for eval/replay signals. `traceLink` is populated in every row type by classifier (lines 802-830) but is NOT rendered in ReviewPage — navigation is indirect via Task column → #/tasks/<ns>/<name> → TaskDetail. CONTEXT.md D-04-A approved this scoping, but the ROADMAP SC3 language says "becomes a queue row" and "navigate from queue row to underlying eval/replay artifact" which the current implementation satisfies only partially. |

**Score:** 1/3 truths fully VERIFIED (SC1 passes cleanly; SC2 passes except CR-01 audit-order gap; SC3 passes only at the stub/indirect level)

### Forbidden CRD Constraint

VERIFIED — No `Tool`, `SteeringEvent`, `TaskReview`, `Channel`, or `Post` CRD was introduced. Only RBAC Role extensions (`agenttasks: [patch]`, `agenttemplates: [create]`) and ClusterRole read-verb extension (`agenttemplates: [get,list,watch]`) were added.

### Requirements Coverage

| Requirement | Plans               | Status              | Evidence                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REV-01      | 04-02, 04-04, 04-05 | SATISFIED           | `GET /api/review-queue` projection live; staleness sort verified; reload-stability tested (Test 12); `useReviewQueue` 5s polling hook in api.ts; ReviewPage at #/review; attention flow flipped to reviewQueueRowCount                                                                                |
| REV-02      | 04-03, 04-04        | PARTIAL (CR-01 gap) | POST accept/reject/request handlers implemented; candidate-template CR creation path works; accept/reject 503/404/409/422/500 ladder covered; ReviewPage + ReviewActions UI surfaces exist; but CR-01: audit event emission ordering leaves substrate inconsistent on patch failure after CR creation |
| REV-03      | 04-01, 04-02, 04-05 | PARTIAL             | Enum slots reserved; verifier-failed + suspicious-detector proxy the eval/replay signal space in v0.2; docs footers in REPLAY-EVALS.md + AGENT-TEMPLATES.md; but zero actual replay/eval producers and traceLink not rendered directly in ReviewPage                                                  |

### Required Artifacts

| Artifact                                                                       | Expected                                                                                                          | Status   | Details                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dto/src/review-queue.ts`                                             | ReviewQueueRow, ReviewReason 6-member enum, assertIsReviewQueueRow                                                | VERIFIED | 278 lines; all exports present including D-04 inline comment                                                                                               |
| `packages/dto/src/template-candidate.ts`                                       | parseAgentTemplateSpec parser                                                                                     | VERIFIED | 252 lines; 8-step validation including agentSpec required, templateVersion, parameters, budget, toolAllowlist, toolDefaults                                |
| `packages/audit-events/src/event-types.ts`                                     | REVIEW_REQUESTED, REVIEW_ACCEPTED, REVIEW_REJECTED, TEMPLATE_CANDIDATE_PROMOTED; ALL_EVENT_TYPES count 53         | VERIFIED | Lines 209-212 add 4 constants; ALL_EVENT_TYPES has 53 items (count confirmed by node script)                                                               |
| `packages/audit-events/src/types.ts`                                           | ReviewAcceptedData, ReviewRejectedData, ReviewRequestedData, TemplateCandidatePromotedData interfaces             | VERIFIED | Present at lines 940-980+; ReviewReason inline-copied as 6-member union (CR-03: desync risk, but structurally present)                                     |
| `packages/workbench-api/src/__fixtures__/review-queue-snapshot.json`           | 6+ fixture entries covering all classifier scenarios                                                              | VERIFIED | File exists; loaded via JSON import-attributes in test file                                                                                                |
| `packages/workbench-api/src/__fixtures__/candidate-template.yaml`              | Candidate template YAML fixture                                                                                   | VERIFIED | File exists                                                                                                                                                |
| `packages/workbench-api/src/routes/review-queue.ts`                            | reviewQueueRoute factory + classifyTask + POST handlers; min 400 lines                                            | VERIFIED | 981 lines; GET handler at line 161; POST accept/reject/request at lines 200/457/578; classifyTask exported at line 776; no 501 stubs remain                |
| `packages/workbench-api/src/routes/review-queue.test.ts`                       | 26 tests covering GET + POST paths; reload-stability; assertIsReviewQueueRow drift-defense                        | VERIFIED | 1102 lines; 26 test cases confirmed; reload-stability at Test 12; assertIsReviewQueueRow drift defense at Test 2                                           |
| `packages/workbench-api/src/router.ts`                                         | reviewQueueRoute registered at /api/review-queue                                                                  | VERIFIED | Line 34 import; lines 229-237 route registration with all deps                                                                                             |
| `packages/workbench-api/src/routes/tasks.ts`                                   | extractK8sStatus and readCreatedMeta exported                                                                     | VERIFIED | Lines 349 and 377: `export function extractK8sStatus` and `export function readCreatedMeta`                                                                |
| `packages/workbench-ui/src/types.ts`                                           | Re-exports ReviewQueueRow, ReviewReason, ArtifactRefSummary                                                       | VERIFIED | Line 40 re-export from @kagent/dto/review-queue                                                                                                            |
| `packages/workbench-ui/src/api.ts`                                             | fetchReviewQueue, acceptReviewQueueRow, rejectReviewQueueRow, requestReview, useReviewQueue, ReviewActionApiError | VERIFIED | All present at lines 277-504; 5s polling confirmed at line 504                                                                                             |
| `packages/workbench-ui/src/App.tsx`                                            | #/review hash route → ReviewPage                                                                                  | VERIFIED | Lines 56, 68, 140-142: ReviewRoute kind, parseHash, mount                                                                                                  |
| `packages/workbench-ui/src/ReviewPage.tsx`                                     | Table with Accept/Reject/Task-link actions; confirm modal; data-source-field                                      | VERIFIED | Exists; table at line 170; data-source-field at lines 193-209; confirm modal at lines 239-290; CSS at ReviewPage.module.css (reasonPill, backdrop, dialog) |
| `packages/workbench-ui/src/command/ReviewActions.tsx`                          | Inline component with 4 trigger conditions; returns null when ineligible                                          | VERIFIED | Lines 59-73: phase=Failed, suspicious.length>0, review-requested=true, template-candidate=true triggers; null return when ineligible                       |
| `packages/workbench-ui/src/TaskDetail.tsx`                                     | ReviewActions mounted above DetailBody                                                                            | VERIFIED | Lines 28 import, 104-106 mount with onDecision=refetch                                                                                                     |
| `packages/workbench-ui/src/command/source-binding.ts`                          | ReviewQueueFieldName 14-member closed enum                                                                        | VERIFIED | Lines 112-126: exactly 14 members matching ReviewQueueRow fields                                                                                           |
| `packages/workbench-ui/src/command/state.ts`                                   | CommandSnapshot.reviewQueueRowCount?: number                                                                      | VERIFIED | Line 74                                                                                                                                                    |
| `packages/workbench-ui/src/command/flows.ts`                                   | attention flow flipped to reviewQueueRowCount; detailLink #/review; label "review queue"                          | VERIFIED | Lines 289-308: sourceFields: ['reviewQueueRowCount'], compute reads s.reviewQueueRowCount ?? 0, detailLink '#/review', label 'review queue'                |
| `packages/workbench-ui/src/CommandView.tsx`                                    | useReviewQueue() wired → reviewQueueRowCount in snapshot                                                          | VERIFIED | Lines 34, 117-119: imports useReviewQueue; rows.length passed as reviewQueueRowCount                                                                       |
| `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` | agenttasks:[patch] + agenttemplates:[create]                                                                      | VERIFIED | Lines 57, 63: both verbs present                                                                                                                           |
| `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml`         | agenttemplates:[get,list,watch] + agenttemplates/status:[get]                                                     | VERIFIED | Lines 45-46 and 54-55                                                                                                                                      |
| `docs/AGENT-TEMPLATES.md`                                                      | Footer "Promotion via review queue (Phase 4)" with media type                                                     | VERIFIED | Line 232: section exists; line 236: promotion flow described                                                                                               |
| `docs/REPLAY-EVALS.md`                                                         | Footer "REV-03 stub — Phase 4 placement"                                                                          | VERIFIED | Lines 219-223: section present with replay-divergence/eval-failed description                                                                              |
| `docs/SUBSTRATE-V1.md`                                                         | §4.3 audit catalog extended with 4 new Phase 4 event types                                                        | VERIFIED | Lines 342-345: review.requested, review.accepted, review.rejected, template.candidate.promoted                                                             |

### Key Link Verification

| From                           | To                                                                          | Via                                                                                                 | Status | Details                              |
| ------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ | ------------------------------------ |
| `routes/review-queue.ts`       | `cache.ts (SnapshotCache.listTasks())`                                      | `import type { SnapshotCache } from '../cache.js'`                                                  | WIRED  | Line 54; used at lines 162, 210, 496 |
| `routes/review-queue.ts`       | `@kagent/dto (ReviewQueueRow, ReviewReason)`                                | `import { assertIsReviewQueueRow, type ReviewQueueRow } from '@kagent/dto'`                         | WIRED  | Lines 39-43                          |
| `routes/review-queue.ts`       | `@kagent/audit-events (REVIEW_ACCEPTED, TEMPLATE_CANDIDATE_PROMOTED, etc.)` | `import { REVIEW_REQUESTED, REVIEW_ACCEPTED, ... } from '@kagent/audit-events'`                     | WIRED  | Lines 46-52; used at lines 380-428   |
| `routes/review-queue.ts`       | `routes/tasks.ts (extractK8sStatus, readCreatedMeta)`                       | `import { extractK8sStatus, readCreatedMeta } from './tasks.js'`                                    | WIRED  | Line 56; used at lines 322, 320      |
| `routes/review-queue.ts`       | `@kagent/dto (parseAgentTemplateSpec)`                                      | `import { ..., parseAgentTemplateSpec ... } from '@kagent/dto'`                                     | WIRED  | Line 39; used at line 290            |
| `routes/review-queue.test.ts`  | `__fixtures__/review-queue-snapshot.json`                                   | `import reviewQueueFixture from '../__fixtures__/review-queue-snapshot.json' with { type: 'json' }` | WIRED  | Line 52                              |
| `router.ts`                    | `routes/review-queue.ts (reviewQueueRoute)`                                 | `app.route('/api/review-queue', reviewQueueRoute({ ... }))`                                         | WIRED  | Lines 34, 229-237                    |
| `workbench-ui/api.ts`          | `GET /api/review-queue`                                                     | `fetch('/api/review-queue')` in fetchReviewQueue                                                    | WIRED  | Line 359+                            |
| `flows.ts (attention compute)` | `state.ts (CommandSnapshot.reviewQueueRowCount)`                            | `s.reviewQueueRowCount ?? 0`                                                                        | WIRED  | Line 294                             |
| `CommandView.tsx`              | `useReviewQueue()`                                                          | `const { rows: reviewRows } = useReviewQueue()`                                                     | WIRED  | Lines 34, 117-119                    |

### Data-Flow Trace (Level 4)

| Artifact                     | Data Variable                            | Source                                                                                              | Produces Real Data                                                                                     | Status  |
| ---------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| `ReviewPage.tsx`             | `rows` from `useReviewQueue()`           | `fetchReviewQueue()` → `GET /api/review-queue` → `classifyTask(SnapshotCache.listTasks())`          | Yes — SnapshotCache is populated by the operator informer; projection is pure-read over real task data | FLOWING |
| `flows.ts attention compute` | `s.reviewQueueRowCount`                  | `CommandView.tsx` → `useReviewQueue().rows.length` → `fetchReviewQueue()` → `GET /api/review-queue` | Yes — counts real queue rows                                                                           | FLOWING |
| `ReviewActions.tsx`          | `task.pilotEvidence?.audit?.annotations` | TaskDetail prop chain from `useEffect` + `fetchTaskDetail()`                                        | Yes — reads real AgentTask annotation data from cache                                                  | FLOWING |

### Behavioral Spot-Checks

| Behavior                                                            | Check                                                  | Result                                       | Status         |
| ------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------- | -------------- |
| review-queue.ts has POST accept/reject/request handlers (not stubs) | `grep -n "501" routes/review-queue.ts`                 | No matches                                   | PASS           |
| extractK8sStatus exported from tasks.ts                             | `grep -E "^export function extractK8sStatus" tasks.ts` | Line 349 matches                             | PASS           |
| reviewQueueRoute registered in router.ts                            | `grep "api/review-queue" router.ts`                    | Lines 229-237 match                          | PASS           |
| 501 stubs gone                                                      | `grep "501.*not yet implemented" review-queue.ts`      | No matches                                   | PASS           |
| ALL_EVENT_TYPES has 53 members                                      | Node count script                                      | Count: 53                                    | PASS           |
| No forbidden CRDs (Tool, SteeringEvent, TaskReview, Channel, Post)  | Find in packages yaml + ts                             | No matches                                   | PASS           |
| ReviewQueueFieldName has 14 members                                 | grep source-binding.ts                                 | 14 confirmed                                 | PASS           |
| annotation PATCH failure path emits no audit events (CR-01 defect)  | Code read lines 349-431                                | Line 374 returns before line 377 audit block | FAIL (BLOCKER) |

### Anti-Patterns Found

| File                                                        | Issue                                                                                                                                                                                                                                                                       | Severity | Impact                                                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/workbench-api/src/routes/review-queue.ts:349-431` | CR-01 BLOCKER: annotation patch failure (line 374) early-returns 500 BEFORE audit event emission block (line 377). AgentTemplate CR exists, review-decision annotation absent, no audit trail.                                                                              | BLOCKER  | Reviewer retry hits K8s 409 on CR collision → 422 with zero audit events; permanent audit gap for any candidate-template accept where the patch step is flaky            |
| `packages/workbench-api/src/routes/review-queue.ts:900`     | CR-02 (code review): classifier reasonDetail for candidate-template is `"candidate AgentTemplate from ${ns}/${name}"` but DTO JSDoc at `dto/review-queue.ts:85` documents `"proposedTemplateName + ' (candidate)'"`. Spec mismatch between DTO contract and implementation. | WARNING  | UI renders "candidate AgentTemplate from kagent-system/foo" instead of documented "foo-template (candidate)"; tests pass only because they don't enforce the spec format |
| `packages/audit-events/src/types.ts:940-979`                | CR-03 (code review): ReviewAcceptedData.reason and ReviewRejectedData.reason are inline copies of the ReviewReason union from @kagent/dto. No compile-time sync check links the two unions; a rename in dto/review-queue.ts won't surface as a tsc error in audit-events.   | WARNING  | Silent desync risk on any ReviewReason enum change; breaking only at workbench-api call sites, not in audit-events package itself                                        |
| `packages/workbench-ui/src/api.ts:500-512`                  | WR-08: useReviewQueue polling has no exponential backoff on error; fires every 5s indefinitely on persistent failure.                                                                                                                                                       | WARNING  | Low practical risk (GET endpoint rarely 503s); backoff pattern missing                                                                                                   |
| `packages/workbench-ui/src/api.ts:394`                      | WR-02: acceptReviewQueueRow error handler only reads `errBody.error`, silently drops `detail` field (parser error from parseAgentTemplateSpec).                                                                                                                             | WARNING  | Operator sees "candidate-template parse failed" but not the specific parse error tag                                                                                     |
| `packages/workbench-ui/src/api.ts:436`                      | WR-06: requestReview API helper sends `{ requestedBy, note }` but server reads `{ reviewerId, reasonText }`. Both fields silently discarded.                                                                                                                                | WARNING  | Note and requestedBy from UI are never recorded in the audit event or annotation                                                                                         |

### Human Verification Required

#### 1. Candidate-template accept under real K8s

**Test:** Deploy workbench-api against a real K3s cluster; create an AgentTask with `template-candidate=true` annotation and a valid `payloadBase64` artifact; POST accept via UI ReviewPage.
**Expected:** AgentTemplate CR created; review-decision: accepted annotation written; review.accepted and template.candidate.promoted events in JetStream; task disappears from GET /api/review-queue next poll.
**Why human:** Unit tests mock customApi; real K8s RBAC, CR schema validation, and NATS publish path are not exercised.

#### 2. Patch-failure audit ordering (CR-01 regression test)

**Test:** After the CR-01 fix is applied, accept a candidate-template task where the annotation PATCH fails (e.g., revoke RBAC mid-flight or mock the patch to reject).
**Expected:** template.candidate.promoted event IS in the audit log before the 500 response. review.accepted event is absent (patch failed). Retry by reviewer returns 409 (task annotation not set), and a second accept attempt succeeds cleanly.
**Why human:** Integration test harness needed for controlled PATCH failure injection.

#### 3. Visual navigation from queue row to eval/replay artifact

**Test:** Open #/review in browser; click the Task column link for a verifier-failed row.
**Expected:** TaskDetail opens; Langfuse trace link is visible and clickable; reviewer can follow it to the trace.
**Why human:** Browser visual + link verification not covered by unit tests.

### Gaps Summary

Two gaps block full phase-goal achievement:

**Gap 1 — CR-01 (BLOCKER): Audit emission ordering on candidate-template accept path**

When the accept handler creates an AgentTemplate CR successfully but the subsequent annotation PATCH fails, execution returns a 500 at line 374 of `routes/review-queue.ts` without ever reaching the audit event block at line 377. The `template.candidate.promoted` and `review.accepted` events are never emitted. The substrate is left with the AgentTemplate CR existing but no annotation and no audit record. A reviewer retry hits the K8s 409-collision path and also emits no events.

Fix: emit `template.candidate.promoted` immediately after CR creation succeeds (before the patch attempt). This preserves the audit record of the CR's existence regardless of patch outcome.

**Gap 2 — SC3 indirect navigation (WARNING): traceLink not surfaced in ReviewPage**

The ROADMAP SC3 says "Reviewer can navigate from queue row to underlying eval/replay artifact." The implementation provides a Task column link to #/tasks/<ns>/<name> (TaskDetail), where the trace link is available. The `traceLink` field is populated in every `ReviewQueueRow` by the classifier but is never rendered in the ReviewPage table. Navigation is one hop indirect. The plan's CONTEXT.md D-04-A explicitly approved this scoping for v0.2, but the ROADMAP text is more literal. This is a WARNING-tier gap — human decision needed on whether indirect navigation via TaskDetail satisfies SC3 or whether a direct traceLink column is required.

**Additional warnings (non-blocking)**

Three code-review findings (CR-02: reasonDetail spec mismatch, CR-03: audit-events inline-copy desync risk, WR-06: requestReview field name mismatch) and the WR-08 polling backoff absence are warning-tier. They do not block the phase goal but should be resolved before the review surface is promoted to production use.

---

_Verified: 2026-05-10T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
