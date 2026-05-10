---
phase: 04-review-queue-projection-promotion-path
plan: "04"
subsystem: workbench-ui
tags: [review-queue, ui, react, source-binding, REV-01, REV-02]
dependency_graph:
  requires: [04-01-PLAN.md, 04-02-PLAN.md, 04-03-PLAN.md]
  provides: [ReviewPage, ReviewActions, useReviewQueue, ReviewQueueFieldName]
  affects:
    - packages/workbench-ui/src/App.tsx
    - packages/workbench-ui/src/TaskDetail.tsx
    - packages/workbench-ui/src/command/source-binding.ts
tech_stack:
  added:
    - ReviewPage.tsx (new route page, #/review hash)
    - ReviewActions.tsx (inline component, command/ directory)
  patterns:
    - useReviewQueue hook (5s polling, AbortController, cleanup on unmount)
    - Confirm-dialog mirrors NewTaskModal.tsx (backdrop+Escape, no focus-trap)
    - data-source-field DOM attributes per D7/CC-01 on every ReviewQueueRow cell
    - ReviewQueueFieldName 14-member closed enum extending source-binding.ts
key_files:
  created:
    - packages/workbench-ui/src/ReviewPage.tsx
    - packages/workbench-ui/src/ReviewPage.module.css
    - packages/workbench-ui/src/ReviewPage.test.tsx
    - packages/workbench-ui/src/command/ReviewActions.tsx
    - packages/workbench-ui/src/command/ReviewActions.module.css
    - packages/workbench-ui/src/command/ReviewActions.test.tsx
  modified:
    - packages/workbench-ui/src/types.ts
    - packages/workbench-ui/src/api.ts
    - packages/workbench-ui/src/api.test.ts
    - packages/workbench-ui/src/App.tsx
    - packages/workbench-ui/src/TaskDetail.tsx
    - packages/workbench-ui/src/command/source-binding.ts
    - packages/workbench-ui/src/command/source-binding.test.ts
    - packages/dto/package.json (both worktree and main repo symlink target)
decisions:
  - Confirm dialogs are duplicated (not shared) between ReviewPage and ReviewActions for component isolation — both follow the same NewTaskModal pattern
  - Annotation access path (task.pilotEvidence?.audit?.annotations) was already present in the UI-side TaskDetail type; no additional plumbing was required
  - ReviewActions split into ReviewActions (eligibility guard + null return) and ReviewActionsPanel (actual hook-using component) to satisfy React rules-of-hooks (no conditional hook calls)
  - useReviewQueue polling interval is 5s per CONTEXT.md D-01-A "Claude's Discretion"
metrics:
  duration_minutes: 12
  completed_date: "2026-05-10"
  tasks_completed: 4
  files_changed: 13
---

# Phase 04 Plan 04: Wave 3 UI Surface Summary

**One-liner:** Two reviewer entry points — `#/review` dedicated table page + inline `<ReviewActions>` in TaskDetail — source-bound per D7/CC-01 with a 14-member ReviewQueueFieldName closed enum.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (W3-A) | types.ts re-exports + api.ts fetch/POST helpers + useReviewQueue hook | 469b4de | types.ts, api.ts, api.test.ts |
| 2 (W3-B) | ReviewPage.tsx + ReviewPage.module.css + ReviewPage.test.tsx + App.tsx #/review route | 3240d23 | 4 files |
| 3 (W3-C) | ReviewActions.tsx + ReviewActions.module.css + ReviewActions.test.tsx + TaskDetail.tsx mount | e4be642 | 4 files |
| 4 (W3-D) | Extend source-binding.ts with ReviewQueueFieldName + narrowing tests | 96b88ab | source-binding.ts, source-binding.test.ts |

## Test Counts

| Test file | Before | After | New tests |
|-----------|--------|-------|-----------|
| api.test.ts | 18 | 26 | 8 (fetchReviewQueue, acceptReviewQueueRow, rejectReviewQueueRow, requestReview flows) |
| ReviewPage.test.tsx | 0 | 8 | 8 (render, empty, loading, error, accept flow, reject flow, Escape closes, source-field) |
| ReviewActions.test.tsx | 0 | 7 | 7 (4 trigger conditions, null for clean task, accept confirm, reject confirm) |
| source-binding.test.ts | 21 | 23 | 2 (ReviewQueueFieldName useSourceField, useSourceFields) |
| **Total** | **92** | **117** | **25** |

All 117 tests pass (`pnpm vitest run` exits 0).

## Design Decisions

### Annotation access plumbing
The UI-side `TaskDetail` type already carried `pilotEvidence.audit.annotations` as `Readonly<Record<string, string>>` (types.ts lines 119-126). No additional plumbing to the detail GET handler was required. The access path `task.pilotEvidence?.audit?.annotations ?? {}` is direct.

### Confirm-dialog duplication vs extraction
The plan gave the planner a choice between a shared ConfirmDialog component and duplicating the modal. Both `ReviewPage.tsx` and `ReviewActions.tsx` use their own self-contained modals, following the same NewTaskModal.tsx pattern (backdrop click, Escape key, `role="dialog" aria-modal="true" aria-labelledby={titleId}`, no formal focus-trap). This keeps the two components independently portable and matches the existing project precedent.

### React rules-of-hooks split
`ReviewActions` returns `null` when `eligible === false`. Because hooks cannot be called conditionally, the component was split into:
- `ReviewActions` — eligibility check, returns null or renders `<ReviewActionsPanel />`
- `ReviewActionsPanel` — internal component that unconditionally runs all hooks

### Dto subpath export fix
`@kagent/dto/review-queue` subpath was missing from `packages/dto/package.json`'s exports map. Additionally, the worktree's `@kagent/dto` resolves via symlink to the main repo's dto directory (`packages/workbench-ui/node_modules/@kagent/dto -> ../../../dto`), so the fix was applied to both the worktree's copy and the main repo's copy. The entry added:
```json
"./review-queue": "./src/review-queue.ts"
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing @kagent/dto/review-queue subpath export**
- **Found during:** Task 1 (test run)
- **Issue:** Vite resolution failed for the review-queue subpath import because the subpath was absent from `packages/dto/package.json` exports.
- **Fix:** Added `"./review-queue": "./src/review-queue.ts"` to the exports map in BOTH the worktree's `packages/dto/package.json` and the main repo's `packages/dto/package.json` (symlink target).
- **Files modified:** packages/dto/package.json (both locations)

**2. [Rule 3 - Blocking] Missing @testing-library/jest-dom matchers**
- **Found during:** Task 2 (test writing)
- **Issue:** `toBeInTheDocument()` and `toHaveAttribute()` unavailable because `globals: false` in vitest config; the jest-dom import threw ReferenceError.
- **Fix:** Removed the jest-dom import; used standard vitest matchers (`toBeTruthy()`, `.not.toBeNull()`, `.getAttribute()`).
- **Files modified:** ReviewPage.test.tsx, ReviewActions.test.tsx

**3. [Rule 1 - Bug] DOM accumulation across tests**
- **Found during:** Task 2 (test debugging)
- **Issue:** Tests 5, 6, 7 in ReviewPage.test.tsx saw `Found multiple elements` errors because the DOM accumulated across tests without `globals: true` (testing-library's auto-cleanup requires globals mode).
- **Fix:** Imported `cleanup` from `@testing-library/react` and called it in `afterEach` in all new test files.
- **Files modified:** ReviewPage.test.tsx, ReviewActions.test.tsx

**4. [Rule 1 - Bug] exactOptionalPropertyTypes TypeScript error in ReviewActions.test.tsx**
- **Found during:** Task 3 (typecheck)
- **Issue:** `makePilotEvidence()` returned `TaskDetail['pilotEvidence']` (which includes `undefined` due to the optional field) but `makeTask()` accepted `Partial<TaskDetail>` with `exactOptionalPropertyTypes: true`, causing a type error when assigning.
- **Fix:** Changed return type annotation to `NonNullable<TaskDetail['pilotEvidence']>`.
- **Files modified:** ReviewActions.test.tsx

## Implementation Notes

### Source-binding extension (D7 / CC-01)

The `ReviewQueueFieldName` 14-member closed enum was added inline in `source-binding.ts` (not re-exported from a separate module) because `ReviewQueueRow` is a concrete DTO, not a dynamically composed type like `PressureFieldName` (which uses `typeof PRESSURE_TYPES[number]`). The enum follows the same pattern as `DispositionFieldName` and `GatewayCapacityFieldName`.

Every `<td>` in `ReviewPage.tsx` carries `data-source-field={useSourceField('<ReviewQueueFieldName>')}`. `assertSourceField(row, '<field>')` fires on row-level fields during dev builds.

### XSS defense (T-04-W3-06)

All user-supplied text (`reasonDetail`, `verifierError`, `suspicious[]` items) is rendered exclusively via JSX text nodes — e.g., `<td>{row.reasonDetail}</td>`. No innerHTML-bypassing API is used anywhere in `ReviewPage.tsx` or `ReviewActions.tsx`. React's automatic HTML-entity escaping at the text-node boundary is the single defense per the threat register.

### Polling and AbortController (T-04-W3-07)

`useReviewQueue` polls at 5s intervals with an AbortController created fresh on each refresh. On unmount, `clearInterval` + `abortController.abort()` are called. Tab-visibility pausing is deferred per CONTEXT.md (T-04-W3-07 accepted risk).

## Hand-off Note for Plan 05 (W4)

All UI surfaces are live and source-bound. Plan 05 flips the Phase 3 `attention` flow gauge to read from the new review-queue projection; regenerates `cc-reload.test.tsx.snap` in a single dedicated commit; lands the W4 docs additions (AGENT-TEMPLATES.md, REPLAY-EVALS.md, SUBSTRATE-V1.md). The `useReviewQueue` hook is available for any Plan 05 integration that needs the row count.

## Known Stubs

None. All data flows are wired: `useReviewQueue` polls `/api/review-queue` (W2 Plan 03 endpoint), Accept/Reject call the W2 POST handlers, and `<ReviewActions />` reads live `TaskDetail` data passed from the parent.

## Threat Flags

No new security-relevant surfaces beyond those declared in the plan's threat model.

## Self-Check: PASSED

Files exist:
- packages/workbench-ui/src/ReviewPage.tsx: FOUND
- packages/workbench-ui/src/ReviewPage.module.css: FOUND
- packages/workbench-ui/src/ReviewPage.test.tsx: FOUND
- packages/workbench-ui/src/command/ReviewActions.tsx: FOUND
- packages/workbench-ui/src/command/ReviewActions.module.css: FOUND
- packages/workbench-ui/src/command/ReviewActions.test.tsx: FOUND
- packages/workbench-ui/src/command/source-binding.ts (ReviewQueueFieldName): FOUND

Commits verified:
- 469b4de: feat(phase-04-w3): add review-queue API helpers + useReviewQueue hook + DTO re-exports (REV-01)
- 3240d23: feat(phase-04-w3): add ReviewPage + #/review hash route (REV-02)
- e4be642: feat(phase-04-w3): add inline ReviewActions component in TaskDetail (REV-02)
- 96b88ab: feat(phase-04-w3): extend source-binding.ts with ReviewQueueFieldName (D7 / CC-01)

Test suite: 117 tests pass, 0 failures.
