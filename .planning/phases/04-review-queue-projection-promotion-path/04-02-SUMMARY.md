---
phase: '04'
plan: '02'
subsystem: 'workbench-api'
tags: [wave-1, review-queue, projection, classifier, tdd, REV-01, REV-03]
dependency_graph:
  requires:
    - '@kagent/dto ReviewQueueRow + ReviewReason + assertIsReviewQueueRow (04-01)'
    - '@kagent/audit-events REVIEW_REQUESTED / REVIEW_ACCEPTED / REVIEW_REJECTED / TEMPLATE_CANDIDATE_PROMOTED (04-01)'
    - 'workbench-api __fixtures__/review-queue-snapshot.json (04-01)'
    - 'SnapshotCache.listTasks() (packages/workbench-api/src/cache.ts)'
  provides:
    - 'GET /api/review-queue → { items: ReviewQueueRow[] } (REV-01 acceptance)'
    - 'classifyTask() pure function — single source of truth for row.reason'
    - 'POST /api/review-queue/:ns/:name/{accept,reject,request} stubs → 501 (Plan 04-03 W2 implements)'
    - 'router.ts registration at /api/review-queue (stable across plans)'
  affects:
    - 'packages/workbench-api/src/routes/review-queue.ts (NEW)'
    - 'packages/workbench-api/src/routes/review-queue.test.ts (NEW)'
    - 'packages/workbench-api/src/router.ts (MODIFIED)'
tech_stack:
  added: []
  patterns:
    - 'reviewQueueRoute(deps) factory mirrors dispositionsRoute(deps) posture exactly (W1.1 exact analog)'
    - 'classifyTask() pure function — no I/O, no Date.now() reads (nowMs param), no mutations'
    - 'findCandidateArtifact() helper matches on exact mediaType string (T-04-W1-06 dual-gate)'
    - 'Selective fake-timer pattern vi.useFakeTimers({ toFake: ["Date"] }) per Phase 2 gotchas'
    - 'JSON fixture import via import-attributes (with { type: "json" })'
    - 'LM-1 mount pattern: handlers on "/" inside factory; mounted at "/api/review-queue" from router.ts'
    - 'MERGE_PATCH_OPTIONS declared at module scope (keeps Plan 03 import block stable)'
key_files:
  created:
    - packages/workbench-api/src/routes/review-queue.ts
    - packages/workbench-api/src/routes/review-queue.test.ts
  modified:
    - packages/workbench-api/src/router.ts
decisions:
  - 'classifyTask() is exported (not private) so Plan 03 POST handlers can re-classify at decision-time without importing classifier logic separately'
  - 'Already-decided check (review-decision annotation) done in GET handler (not classifier) — classifier stays pure/annotation-free for the skip logic'
  - 'POST stubs registered in factory (not router.ts) so Plan 03 can replace them without touching router.ts'
  - 'main.ts unchanged — all required deps (cache, customApi, auditPublisher, defaultNamespace, langfuseBaseUrl) already wired by existing buildRouter() call'
  - 'logError declared but void-suppressed (Plan 03 POST handlers will use it for K8s patch errors)'
  - 'No new RouterDeps fields — review-queue reuses existing RouterDeps.{cache, customApi, auditPublisher, defaultNamespace, langfuseBaseUrl}'
metrics:
  duration: '~27 minutes'
  completed_date: '2026-05-10'
  tasks_completed: 2
  files_changed: 3
---

# Phase 4 Plan 02: Wave 1 — GET /api/review-queue Projection Summary

Pure-function classifier over `SnapshotCache.listTasks()` plus a fixture-driven reload-stability test gives the substrate a typed, ordered, reload-stable read projection of every task awaiting review — fulfilling REV-01 and seeding the W2 POST handlers' read-side dependency.

## Tasks Completed

| #         | Commit    | Description                                                                |
| --------- | --------- | -------------------------------------------------------------------------- |
| 1 (RED)   | `046f960` | test(phase-04-w1): add review-queue.test.ts with 13 RED tests              |
| 2 (GREEN) | `3d5183f` | feat(phase-04-w1): implement GET /api/review-queue projection + classifier |

## What Was Built

### Task 1 — Test skeleton (RED phase)

**`packages/workbench-api/src/routes/review-queue.test.ts`** (new, 349 lines):

- 13 vitest tests covering the full D-01-A classifier acceptance surface:
  - Test 1: GET / returns 200 with `{ items: ReviewQueueRow[] }`; empty cache → `items: []`
  - Test 2: every emitted row passes `assertIsReviewQueueRow` (drift defense)
  - Test 3: verifier-failed fires with correct `enqueuedAt`, `reasonDetail`, `verifierError`, `taskRef.uid`
  - Test 4: suspicious-detector fires with `reasonDetail = 'hallucination-pattern, unexpected-tool-use'` and `suspicious` array
  - Test 5: human-review-requested fires with `requestedBy = 'operator@kagent'` and correct `enqueuedAt`
  - Test 6: candidate-template fires with `candidateTemplate.artifactRef` populated
  - Test 7: candidate-template WITHOUT matching artifact is OMITTED (returns undefined)
  - Test 8: already-decided task (review-decision annotation) is SKIPPED
  - Test 9: verifier-failed beats suspicious-detector in priority conflict
  - Test 10: sort descending by stalenessSeconds (oldest `enqueuedAt` first)
  - Test 11: `replay-divergence` and `eval-failed` never emitted from v0.2 fixture set (D-04 / REV-03)
  - Test 12: reload-stability — two consecutive GETs return identical items with fixed clock
  - Test 13: candidate-template with wrong-mediaType artifact is OMITTED

- Fixture loaded via JSON import-attributes (`with { type: 'json' }`)
- Selective fake-timer pattern (`vi.useFakeTimers({ toFake: ['Date'] })`) — does NOT break `app.request()` await
- `makeStubCache()` helper: stub form of `SnapshotCache` (no actual instance needed)
- `mountAndFetch()` helper: mounts factory at `/` and returns fetch closure

**Minimal stub in `review-queue.ts`** added in the same commit to satisfy linter/type-checker during RED phase (returns empty items, 7 of 13 tests fail).

### Task 2 — Implementation (GREEN phase)

**`packages/workbench-api/src/routes/review-queue.ts`** (full implementation, ~400 lines after prettier):

- `ReviewQueueRouteDeps` interface: `cache`, `customApi?`, `auditPublisher?`, `now?`, `defaultNamespace?`, `langfuseBaseUrl?`, `logger?`
- `reviewQueueRoute(deps): Hono` factory (LM-1 pattern: handlers on `/` and `/:namespace/:name/{accept,reject,request}`)
- `GET /` handler: O(|cache.tasks|) per request; skips decided tasks; classifies; sorts descending by `stalenessSeconds`
- `classifyTask(task, nowMs, langfuseBaseUrl, defaultNamespace): ReviewQueueRow | undefined` — pure function, D-01-A steps 2–5 priority:
  1. `verifier-failed`: `verification.passed === false` → `enqueuedAt = verification.completedAt ?? status.completedAt ?? creationTimestamp ?? nowIso`
  2. `suspicious-detector`: `structuralVerdict.suspicious.length > 0` → `reasonDetail = suspicious.join(', ')`
  3. `human-review-requested`: `annotation review-requested === 'true'` → `enqueuedAt = annotation review-requested-at ?? creationTimestamp ?? nowIso`
  4. `candidate-template`: `phase === 'Completed' && annotation template-candidate === 'true' && findCandidateArtifact(task) !== undefined`
- `findCandidateArtifact(task)`: finds first artifact whose `mediaType === 'application/x-kagent-template-candidate+yaml'`; returns `undefined` if none
- POST handler stubs: return 501; registered in factory so `router.ts` is stable across plans
- `MERGE_PATCH_OPTIONS` constant declared (Plan 03 uses it)
- Audit-event imports landed (Plan 03 uses them); suppressed via `void` to avoid `no-unused-vars`
- SPDX MIT header present

**`packages/workbench-api/src/router.ts`** (modified):

```typescript
app.route(
  '/api/review-queue',
  reviewQueueRoute({
    cache: deps.cache,
    ...(deps.customApi !== undefined && { customApi: deps.customApi }),
    ...(deps.auditPublisher !== undefined && { auditPublisher: deps.auditPublisher }),
    ...(deps.defaultNamespace !== undefined && { defaultNamespace: deps.defaultNamespace }),
    ...(deps.langfuseBaseUrl !== undefined && { langfuseBaseUrl: deps.langfuseBaseUrl }),
  }),
);
```

No new `RouterDeps` fields. Registration placed alphabetically near the `dispositions` block.

**`packages/workbench-api/src/main.ts`** (unchanged): all required deps already present in the `buildRouter()` call.

## Verification

- `vitest run review-queue.test.ts`: **13 tests passed** (GREEN)
- `vitest run` (full suite): **187 tests passed** (was 174 before; 13 new)
- `pnpm -r typecheck`: **all 27 packages pass** (verified by pre-commit hook on each commit)
- Post-commit deletions check: no tracked files deleted

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] node_modules symlinks missing in worktree**

- **Found during:** Task 1 (RED commit attempt)
- **Issue:** The worktree had no `node_modules` (not even a symlink to the main repo's `node_modules`), causing `pnpm -r typecheck` (pre-commit hook) to fail with `tsc: command not found` for all packages.
- **Fix:** Created symlinks `worktree/packages/*/node_modules → kagent/packages/*/node_modules` and `worktree/node_modules → kagent/node_modules` for all 27 packages. This is the same setup Wave 0 had but was lost between executor sessions.
- **Files modified:** node_modules symlinks (not tracked in git)

**2. [Rule 1 - Bug] Linter fails during RED phase**

- **Found during:** Task 1 (RED commit attempt)
- **Issue:** The test file imports `reviewQueueRoute` from `./review-queue.js` which didn't exist yet. ESLint with `@typescript-eslint/unsafe-call` and `@typescript-eslint/unsafe-argument` flagged the import as unresolvable types, blocking the commit.
- **Fix:** Added a minimal stub `review-queue.ts` in the same RED-phase commit (only exports the interface and a no-op factory returning empty items). 7 of 13 tests fail (RED state preserved).

**3. [Rule 1 - Bug] ESLint errors in full implementation**

- **Found during:** Task 2 (GREEN commit attempt)
- **Issues:**
  - `ReviewReason` imported but unused (string literals are narrowed by `ReviewQueueRow.reason`)
  - `deps.logger?.warn` and `deps.logger?.error` flagged as `@typescript-eslint/unbound-method` when destructured
  - POST stub handlers incorrectly marked `async` without `await` expressions
- **Fix:** Removed `ReviewReason` import; wrapped logger methods in arrow functions; removed `async` from POST stubs.

## Known Stubs

The following are INTENTIONAL stubs per the plan's scope boundary:

- **POST /:namespace/:name/accept → 501**: Plan 04-03 (W2) implements the full accept handler.
- **POST /:namespace/:name/reject → 501**: Plan 04-03 (W2) implements the full reject handler.
- **POST /:namespace/:name/request → 501**: Plan 04-03 (W2) implements the full request handler.

These stubs are intentional — the factory registers the URL space so `router.ts` wiring is stable when Plan 03 replaces them.

## Classifier Edge Cases Discovered

1. **`task.status` may be undefined**: `status` is optional in `AgentTask`. The classifier defensively casts to `Record<string, unknown>` and uses `?? {}` to handle the missing case.
2. **Verification fields only in operator types, not DTO**: `verification` is on the operator's `AgentTaskStatus` but not in `@kagent/dto`'s `AgentTaskStatus` (DTO is intentionally shallower). The classifier accesses it via unsafe cast (same approach as `tasks.ts:pilotEvidence()`).
3. **No `model` field on AgentTaskSpec**: `AgentTaskSpec` has `targetAgent` but not `model`. The `model` field in `ReviewQueueRow` will be `undefined` for all v0.2 tasks. The row still passes `assertIsReviewQueueRow` since `model` is optional.

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns beyond what the threat model documents. The GET handler is a pure read over the in-process cache — same trust surface as `GET /api/tasks` which already lists all tasks. The threat register items (T-04-W1-01 through T-04-W1-06) cover this plan's surface and all are handled per their documented dispositions.

## Hand-off Note for Plan 04-03 (W2)

GET projection landed. `classifyTask()` is the single source of truth for `row.reason`. Plan 03's `accept`/`reject` handlers MUST re-classify the task at decision-time to learn its current reason — do NOT trust any client-supplied reason field (the workbench-ui sends the decision action, not the reason it saw when rendering).

The POST handler stubs are in place at `/:namespace/:name/{accept,reject,request}`. Plan 03 replaces the 501 stubs with full implementations. The `MERGE_PATCH_OPTIONS` constant and all audit-event imports (`REVIEW_REQUESTED`, `REVIEW_ACCEPTED`, `REVIEW_REJECTED`, `TEMPLATE_CANDIDATE_PROMOTED`, `makeEvent`) are pre-landed in `review-queue.ts`'s import block — Plan 03 just needs to un-void them.

## Self-Check: PASSED

Files exist:

- `packages/workbench-api/src/routes/review-queue.ts`: YES
- `packages/workbench-api/src/routes/review-queue.test.ts`: YES
- `packages/workbench-api/src/router.ts` (modified): YES

Commits exist:

- `046f960` (test RED phase): FOUND
- `3d5183f` (feat GREEN phase): FOUND
