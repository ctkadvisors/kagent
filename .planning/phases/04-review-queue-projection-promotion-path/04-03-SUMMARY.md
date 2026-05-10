---
phase: 04-review-queue-projection-promotion-path
plan: '03'
subsystem: workbench-api / review-queue POST handlers
tags: [review-queue, promotion, agent-template, write-path, tdd, rev-02]
dependency_graph:
  requires:
    - 04-01-PLAN.md # dto + audit-event contracts
    - 04-02-PLAN.md # GET handler + classifyTask + MERGE_PATCH_OPTIONS + 501 stubs
  provides:
    - POST /api/review-queue/:namespace/:name/accept (5-step path; AgentTemplate CR creation)
    - POST /api/review-queue/:namespace/:name/reject  (annotation write; audit event)
    - POST /api/review-queue/:namespace/:name/request (annotation write; audit event)
    - Exported extractK8sStatus + readCreatedMeta from tasks.ts (LM-3 lift)
  affects:
    - packages/workbench-api/src/routes/review-queue.ts
    - packages/workbench-api/src/routes/review-queue.test.ts
    - packages/workbench-api/src/routes/tasks.ts
tech_stack:
  added: []
  patterns:
    - Hono POST handler with async K8s API calls
    - JSON merge-patch annotation write (MERGE_PATCH_OPTIONS)
    - TDD RED/GREEN cycle (failing tests first, then implementation)
    - AgentTemplate CR creation via CustomObjectsApi.createNamespacedCustomObject
    - Best-effort audit event emit (swallow-and-log on failure, per dispositions.ts precedent)
    - Test-injectable deps.readArtifact seam for artifact YAML resolution
key_files:
  created: []
  modified:
    - packages/workbench-api/src/routes/review-queue.ts
    - packages/workbench-api/src/routes/review-queue.test.ts
    - packages/workbench-api/src/routes/tasks.ts
decisions:
  - 'LM-3: export extractK8sStatus + readCreatedMeta from tasks.ts rather than creating a new shared k8s-helpers.ts module; two consumers do not justify a new file (RESEARCH.md Q11 / PATTERNS.md W2.1)'
  - "deps.readArtifact injection seam: test path injects Promise.resolve(candidateYaml); v0.2 production falls back to artifact's payloadBase64 field; PVC resolution deferred to v0.3"
  - 'K8s 409 CR collision → 422 fail-loud (reviewer reproposes); NOT treated as success-equivalent (PATTERNS.md open question — default: hard-fail per RESEARCH.md Pitfall 2)'
  - 'Audit event data uses `reviewerId: string | undefined` / `reasonText: string | undefined` directly (required fields per audit-events types.ts) rather than conditional spread'
  - "agentTemplateRef promotion event: namespace/name fields default to '' when readCreatedMeta returns undefined (K8s create succeeded but metadata missing — defensive, not expected in prod)"
metrics:
  duration: '~25 minutes'
  completed: '2026-05-10'
  tasks_completed: 2
  files_modified: 3
---

# Phase 04 Plan 03: Review Queue POST Handlers (accept / reject / request) Summary

Wave 2 of Phase 4 delivers the first annotation-driven write path from workbench-api: `POST /api/review-queue/:namespace/:name/accept|reject|request`. This is the REV-02 acceptance: a single-reviewer accept handler that creates a versioned `AgentTemplate` CR before writing the immutable `review-decision: accepted` annotation, paired with a reject handler that records the operator's "no" as a substrate audit event.

## One-liner

REV-02 review write path: accept/reject/request POST handlers with AgentTemplate CR promotion, 503 fail-closed gate, and TDD-verified 5-step accept handler (cache-lookup → conflict-check → CR-create → annotation-patch → audit-emit).

## What Was Delivered

### Task 1 (W2-A): LM-3 Helper Export from tasks.ts

Added `export` keyword to two existing internal helpers in `packages/workbench-api/src/routes/tasks.ts`:

- `extractK8sStatus(err: unknown): number | undefined` — extracts HTTP status from K8s ApiException shapes
- `readCreatedMeta(obj: unknown): CreatedMeta` — picks `metadata.{name,namespace,uid,creationTimestamp}` from K8s API untyped return

Both are now importable via `import { extractK8sStatus, readCreatedMeta } from './tasks.js'`. No behavior change; all 20 tasks tests continue to pass.

### Task 2 (W2-B): POST Handler Implementation (TDD)

**RED:** 13 new failing tests added to `review-queue.test.ts` covering the full POST handler surface:

| Test       | Coverage                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| W2-Test 1  | accept verifier-failed happy path → 200, patch called, no CR, one audit event          |
| W2-Test 2  | accept candidate-template: CR created BEFORE patch (call-order assertion), both events |
| W2-Test 3  | accept 503 when customApi undefined (verbatim message)                                 |
| W2-Test 4  | accept 404 when task not in cache                                                      |
| W2-Test 5  | accept 409 when already decided                                                        |
| W2-Test 6  | accept 422 when candidate YAML malformed                                               |
| W2-Test 7  | accept 422 when K8s create 409 collision; annotation patch NOT called                  |
| W2-Test 8  | reject happy path → 200, no CR, review.rejected event                                  |
| W2-Test 9  | reject 409 when already decided                                                        |
| W2-Test 10 | request happy path → 200, patches review-requested, review.requested event             |
| W2-Test 11 | X-Forwarded-User absent → annotation falls back to "unknown"                           |
| W2-Test 12 | reject 503 when customApi undefined                                                    |
| W2-Test 13 | request 503 when customApi undefined                                                   |

**GREEN:** Full implementation replacing the three 501 stubs in `review-queue.ts`:

Accept handler (5-step path per CONTEXT.md D-03-A):

1. 503 fail-closed when `customApi === undefined` (WRITE_DISABLED_MESSAGE verbatim)
2. Cache-lookup → 404 if missing
3. Conflict-check → 409 if `review-decision` annotation already set
4. Body parse + reviewer-id resolution (X-Forwarded-User → body override → 'unknown')
5. Re-classify via `classifyTask()` → 409 if no longer in queue
6. (candidate-template only) parse YAML via `parseAgentTemplateSpec` → 422 on failure; create `AgentTemplate` CR via `createNamespacedCustomObject`; K8s 409/422 → 422 scrubbed; K8s 403 → 403; K8s 5xx → 500 generic + log
7. PATCH AgentTask annotations (`review-decision: accepted`) via merge-patch (AFTER CR creation)
8. Emit `review.accepted` always; additionally emit `template.candidate.promoted` on candidate path (best-effort)
9. Respond 200 with `{ taskRef, decision, auditedAt, ?agentTemplateRef }`

Reject handler: identical steps 1-5, skips step 6, writes `review-decision: rejected`, emits `review.rejected`.

Request handler: steps 1-2, idempotency check for both `review-decision` and `review-requested` → 409, patches `review-requested: "true"` + companion annotations, emits `review.requested`.

## Test Counts

| Category                               | Count                                               |
| -------------------------------------- | --------------------------------------------------- |
| GET /api/review-queue (W1 Plan 02)     | 13                                                  |
| POST accept verifier-failed happy path | 2 (W2-T1 verifier-failed, W2-T2 candidate-template) |
| POST accept error paths                | 5 (503, 404, 409, 422-malformed, 422-k8s-collision) |
| POST reject                            | 2 (W2-T8 happy-path, W2-T9 already-decided)         |
| POST request                           | 1 (W2-T10 happy-path)                               |
| POST all — 503 fail-closed             | 3 (W2-T3, W2-T12, W2-T13)                           |
| POST auth fallback to "unknown"        | 1 (W2-T11)                                          |
| **Total**                              | **26**                                              |

## Candidate Artifact YAML Resolution Seam

The accept handler reads the candidate-template YAML payload via an injectable `deps.readArtifact` seam:

- **Test path**: injects `() => Promise.resolve(candidateYaml)` (W0 fixture file) — fully isolated, no filesystem or PVC dependency
- **Production path (v0.2)**: if `deps.readArtifact` is not supplied, reads `payloadBase64` field from the artifact object (inline base64). If absent → 422
- **Production path (v0.3+)**: PVC resolution via artifact-store client, deferred pending that client

This matches the "planner picks: inline-base64 for v0.2" guidance in the plan's behavior block. The seam is documented in JSDoc on `ReviewQueueRouteDeps.readArtifact`.

## Retry / Collision Behavior (K8s 409 on AgentTemplate Create)

When `createNamespacedCustomObject` throws with K8s status 409 (name collision), the handler returns 422 and does NOT proceed to the annotation patch. This is the "fail-loud" posture:

- The reviewer must repropose (change the proposed template name and re-submit)
- The 409 is treated as a hard failure, not a success-equivalent
- Rationale: treating collision as success would silently accept the wrong AgentTemplate CR; the safer path is to surface it as a 422 so the operator can investigate

This is documented in RESEARCH.md Pitfall 2 and the PATTERNS.md open question — the plan default was hard-fail, which is what we implemented.

## Deviations from Plan

None — plan executed exactly as written, with one rule-2 addition:

**[Rule 2 - Missing critical functionality] TypeScript strict mode required explicit `string | undefined` for audit event data fields**

- **Found during:** GREEN phase (pre-commit typecheck)
- **Issue:** `ReviewAcceptedData`, `ReviewRejectedData`, `ReviewRequestedData`, and `TemplateCandidatePromotedData` in `@kagent/audit-events` define `reviewerId` and `reasonText` as `string | undefined` (required fields), not optional. The conditional spread pattern (`...(x !== undefined && { x })`) omits the field entirely when undefined, but the type checker requires the field to be present as `undefined`.
- **Fix:** Changed all three audit event emit blocks to pass `reviewerId` and `reasonText` directly as `string | undefined` (always present, may be `undefined`).
- **Files modified:** `packages/workbench-api/src/routes/review-queue.ts`
- **Commit:** 9bb695f (included in the GREEN commit)

## TDD Gate Compliance

- RED gate: commit `26b175c` — `test(phase-04-w2): add 13 failing W2 tests for POST accept/reject/request handlers (RED)`
- GREEN gate: commit `9bb695f` — `feat(phase-04-w2): implement review-queue accept/reject/request POST handlers (REV-02)`
- REFACTOR gate: not needed — implementation was clean on first pass after TypeScript fixes

## Threat Flags

No new trust boundaries beyond what the plan's threat model already covers:

| Flag                                | File            | Description                                                                                                      |
| ----------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| threat_flag: write-surface-enabled  | review-queue.ts | Three new mutation endpoints; protected by 503 fail-closed when customApi undefined                              |
| threat_flag: candidate-yaml-parsing | review-queue.ts | YAML from artifact parsed before CR creation; two-gate validation: parseAgentTemplateSpec + K8s apiserver schema |

Both flags are in the plan's threat register (T-04-W2-02 for YAML parsing, T-04-W2-06 for cross-namespace EoP).

## Hand-off Note for Plan 04 (W3)

All write surfaces in workbench-api are live. Plan 04 builds the UI: `useReviewQueue` hook polls `GET /api/review-queue`; `ReviewPage` table calls `acceptReviewQueueRow` / `rejectReviewQueueRow` from `api.ts`; `ReviewActions` inline component mounts in `TaskDetail`. The W2 audit-event types ride the existing SSE stream — Plan 04 may optionally subscribe for invalidation, but default v0.2 is poll-only per CONTEXT.md D-01-A.

## Self-Check

PASSED:

- `packages/workbench-api/src/routes/tasks.ts` — `export function extractK8sStatus` exists
- `packages/workbench-api/src/routes/tasks.ts` — `export function readCreatedMeta` exists
- `packages/workbench-api/src/routes/review-queue.ts` — `app.post.*accept`, `app.post.*reject`, `app.post.*request` all present
- `packages/workbench-api/src/routes/review-queue.ts` — no `501.*not yet implemented` stubs remain
- `packages/workbench-api/src/routes/review-queue.ts` — `parseAgentTemplateSpec`, `scrubSecrets`, `REVIEW_ACCEPTED`, `TEMPLATE_CANDIDATE_PROMOTED` all present
- Commits c970c30, 26b175c, 9bb695f all exist in log
- All 26 tests pass; TypeScript strict mode passes with no errors
