---
phase: 05-workbench-usability-primitives
plan: '01'
subsystem: workbench-ui, workbench-api, audit-events
tags: [scaffolding, hotkeys, replay, selection, alerts, audit-events, validators, wave-1]
dependency_graph:
  requires: []
  provides:
    - hotkeys.ts — isTextTarget(), HOTKEY_CHEAT_SHEET, useGlobalHotkeys() stub
    - HotkeyCheatSheet.tsx — modal component skeleton (isOpen/onClose/esc/backdrop)
    - useAlert.ts — shared alert-text state hook with auto-dismiss TTL
    - ReplayModal.tsx — replay task modal (agent select, reason textarea, replayOf submit)
    - SelectionActions.tsx — multi-select action bar (open tabs, copy IDs, scroll to failure)
    - types.ts (workbench-ui) — ReplayOfReference interface + replayOf on CreateTaskRequest
    - types-write.ts (workbench-api) — ReplayOfReference interface + replayOf on CreateTaskRequest
    - validators.ts — validateReplayOf() sub-helper with RFC1123/UUID/newline/byte guards
    - audit-events types.ts — TaskReplayCreatedData interface + task.replay.created union member
    - audit-events event-types.ts — TASK_REPLAY_CREATED constant, ALL_EVENT_TYPES 53→54
  affects:
    - packages/workbench-ui/src (new files, types.ts modified)
    - packages/workbench-api/src/routes/validators.ts (new function)
    - packages/workbench-api/src/types-write.ts (extended)
    - packages/audit-events/src (event-types.ts, types.ts, types.test.ts, make-event.test.ts)
tech_stack:
  added: []
  patterns:
    - skeleton-with-todo — it.todo() in new test files so vitest exits 0
    - useAlert shared util — useState + useRef timer + useCallback for stable identity
    - exactOptionalPropertyTypes spread pattern — ...(val && { key: val }) for optional K8s refs
    - discriminated union extension — CloudEvents audit event data typed union
key_files:
  created:
    - packages/workbench-ui/src/hotkeys.ts
    - packages/workbench-ui/src/hotkeys.test.ts
    - packages/workbench-ui/src/HotkeyCheatSheet.tsx
    - packages/workbench-ui/src/HotkeyCheatSheet.module.css
    - packages/workbench-ui/src/HotkeyCheatSheet.test.tsx
    - packages/workbench-ui/src/useAlert.ts
    - packages/workbench-ui/src/useAlert.test.ts
    - packages/workbench-ui/src/ReplayModal.tsx
    - packages/workbench-ui/src/ReplayModal.module.css
    - packages/workbench-ui/src/ReplayModal.test.tsx
    - packages/workbench-ui/src/command/SelectionActions.tsx
    - packages/workbench-ui/src/command/SelectionActions.module.css
    - packages/workbench-ui/src/command/SelectionActions.test.tsx
  modified:
    - packages/workbench-ui/src/types.ts
    - packages/workbench-api/src/types-write.ts
    - packages/workbench-api/src/routes/validators.ts
    - packages/workbench-api/src/routes/validators.test.ts
    - packages/audit-events/src/event-types.ts
    - packages/audit-events/src/types.ts
    - packages/audit-events/src/types.test.ts
    - packages/audit-events/src/make-event.test.ts
decisions:
  - useAlert implemented as shared util (single hook, all callers use it) per RESEARCH §3.3
  - validateReplayOf is a standalone sub-helper; NOT wired into validateCreateTaskBody (Plan 02 wires the call)
  - HotkeyCheatSheet styled to match NewTaskModal pattern (no new CSS primitives)
  - ReplayModal uses exactOptionalPropertyTypes spread for optional reason field
  - SelectionActions returns null when selection.keys.size < 2 (always-mounted pattern)
  - audit-events catalog grows 53→54; TaskReplayCreatedData ships with the constant (LM-10 leaf-dep)
metrics:
  duration: ~45min (across two sessions due to context compaction)
  completed: '2026-05-10'
  tasks_completed: 3
  files_created: 13
  files_modified: 8
---

# Phase 05 Plan 01: Wave 1 Scaffolding Summary

Pure additive scaffolding for all new Phase 5 files — hotkeys, replay modal, selection actions, shared alert hook — plus type/const/validator extensions in workbench-api and audit-events. No mounts, no behavior wiring; Plan 02 wires everything.

## Commits

| Task   | Commit  | Description                                                                                          |
| ------ | ------- | ---------------------------------------------------------------------------------------------------- |
| Task 1 | 6a7190b | feat(phase-05-w1-01): scaffold hotkeys.ts + HotkeyCheatSheet + useAlert (WB-01)                      |
| Task 2 | d4cbaf0 | feat(phase-05-w1-02): scaffold ReplayModal + SelectionActions + types.ts (WB-02, WB-03)              |
| Task 3 | c56cf99 | feat(phase-05-w1-03): extend audit-events + validators + types-write for replay-from-context (WB-03) |

## What Was Built

### Task 1 — hotkeys + HotkeyCheatSheet + useAlert

**hotkeys.ts** exports `isTextTarget()` (verbatim lift from CommandView, prevents hotkey fire in form fields), `HotkeyEntry` type, `HOTKEY_CHEAT_SHEET` const (12 entries across 4 scopes: global-nav chords `g t/g/c/k/r`, `?` help toggle, task-detail `t`, review-page `j/k/a/r`, command-view `o`), and `useGlobalHotkeys()` stub.

**HotkeyCheatSheet.tsx** is a dialog component (role="dialog" aria-modal) that renders the cheat sheet grouped by scope. Esc-to-close + backdrop-click-to-close mirrors NewTaskModal.

**useAlert.ts** is a shared alert-text hook: `useState<string|null>` + `useRef<number|null>` for timeout ID, default TTL 2500ms, `useCallback` for stable identity, cleanup-on-unmount. Five real tests in `useAlert.test.ts` using `vi.useFakeTimers()`.

### Task 2 — ReplayModal + SelectionActions + types.ts

**ReplayModal.tsx** wraps the replay-task UX: fetches agents on mount, pre-selects original `task.targetAgent`, optional reason textarea (maxLength=256), collapsible pre-block with original user message (JSX text node only — no raw-HTML injection). Submit builds `replayOf: { taskRef: { namespace, name, uid }, ...reason }` and calls `createTask()`. Uses `exactOptionalPropertyTypes`-safe spread for optional `reason`.

**SelectionActions.tsx** renders 3 action buttons (Open N in tabs, Copy N IDs, Scroll to first failure) as an absolutely-positioned overlay at bottom-right of the command canvas. Returns null when `selection.keys.size < 2`.

**types.ts (workbench-ui)** extended with `ReplayOfReference` interface and `readonly replayOf?: ReplayOfReference` on `CreateTaskRequest`.

### Task 3 — audit-events + validators + types-write

**validators.ts** gains `validateReplayOf(raw, errors): ReplayOfReference | undefined` — validates non-object root, non-object taskRef, missing/invalid RFC1123 namespace and name, non-UUID uid, reason >256 bytes UTF-8, reason with `\r`/`\n`. 10 unit tests in validators.test.ts (9 for `validateReplayOf` + existing H16 payload-size tests).

**audit-events event-types.ts** adds `TASK_REPLAY_CREATED = 'task.replay.created' as const` and appends it to the frozen `ALL_EVENT_TYPES` array (53→54).

**audit-events types.ts** adds `TaskReplayCreatedData` interface (newTaskRef, originalTaskRef, decidedBy?, reason?) and the discriminated union member `{ type: 'task.replay.created'; data: TaskReplayCreatedData }` to `AuditEventData`.

**audit-events types.test.ts** updated with catalog-length assertion (54), contains-check for TASK_REPLAY_CREATED, and type-only compile-time cross-check.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated make-event.test.ts catalog assertions for 54-event catalog**

- **Found during:** Task 3 test run
- **Issue:** `make-event.test.ts` had a hard-coded ordered array of 53 event types + a `.toBe(53)` length assertion. Adding `TASK_REPLAY_CREATED` to `ALL_EVENT_TYPES` caused 2 test failures.
- **Fix:** Updated the length assertion from 53 to 54 and appended `'task.replay.created'` to the ordered array.
- **Files modified:** `packages/audit-events/src/make-event.test.ts`
- **Commit:** c56cf99 (same Task 3 commit — atomic with the rest)

**2. [Rule 1 - Bug] Write tool paths resolved to main repo instead of worktree (session 1)**

- **Found during:** Initial file creation
- **Issue:** Write tool calls using main-repo-rooted absolute paths wrote to the main repo, not the worktree.
- **Fix:** Copied files from main repo to worktree, removed from main repo. All subsequent writes used worktree-rooted paths.
- **Files affected:** All 13 new files in Task 1 and Task 2 (corrected before commit)

**3. [Rule 1 - Bug] vitest globals not injected — explicit imports required**

- **Found during:** Task 1 skeleton test creation
- **Issue:** `vitest.config.ts` has `globals: false`; skeleton test files using bare `describe`/`it` would fail to parse.
- **Fix:** Added explicit `import { describe, it } from 'vitest'` to all new skeleton test files.
- **Files modified:** All 5 skeleton test files

**4. [Rule 1 - Bug] exactOptionalPropertyTypes TS error in ReplayModal.tsx**

- **Found during:** Task 2 typecheck
- **Issue:** `reason: trimmedReason || undefined` not assignable under `exactOptionalPropertyTypes`.
- **Fix:** Changed to conditional spread: `...(trimmedReason.length > 0 && { reason: trimmedReason })`.
- **Files modified:** `packages/workbench-ui/src/ReplayModal.tsx`

## Known Stubs

The following stubs are intentional — Plan 02 wires the behavior. They do not block the plan's goal (this plan is scaffolding-only).

| File                                                          | Stub                                                        | Reason                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `packages/workbench-ui/src/hotkeys.ts`                        | `useGlobalHotkeys` stub (no-op effect)                      | Plan 02 wires the event listeners              |
| `packages/workbench-ui/src/hotkeys.test.ts`                   | `it.todo()` skeleton tests                                  | Plan 02 adds real tests when behavior is wired |
| `packages/workbench-ui/src/HotkeyCheatSheet.test.tsx`         | `it.todo()` skeleton tests                                  | Plan 02 adds real tests                        |
| `packages/workbench-ui/src/ReplayModal.test.tsx`              | `it.todo()` skeleton tests                                  | Plan 02 adds real tests                        |
| `packages/workbench-ui/src/command/SelectionActions.test.tsx` | `it.todo()` skeleton tests                                  | Plan 02 adds real tests                        |
| `packages/workbench-ui/src/command/SelectionActions.tsx`      | Click handler noop stubs                                    | Plan 02 wires K8s API calls                    |
| `packages/workbench-api/src/routes/validators.ts`             | `validateReplayOf` not called from `validateCreateTaskBody` | Plan 02 wires the call                         |

## Threat Flags

None. All new surface is additive type definitions, pure-function validators, and UI modal components. No new network endpoints or trust boundaries introduced in this plan.

## Self-Check: PASSED

All files verified present and committed:

- `packages/workbench-ui/src/hotkeys.ts` — present in commit 6a7190b
- `packages/workbench-ui/src/HotkeyCheatSheet.tsx` — present in commit 6a7190b
- `packages/workbench-ui/src/useAlert.ts` — present in commit 6a7190b
- `packages/workbench-ui/src/ReplayModal.tsx` — present in commit d4cbaf0
- `packages/workbench-ui/src/command/SelectionActions.tsx` — present in commit d4cbaf0
- `packages/audit-events/src/types.ts` — modified in commit c56cf99
- `packages/audit-events/src/event-types.ts` — modified in commit c56cf99
- `packages/workbench-api/src/routes/validators.ts` — modified in commit c56cf99
- All 27-package typecheck: PASSED (pre-commit hook)
- audit-events tests: 66 passed (3 test files)
- workbench-api tests: 211 passed (14 test files)
- workbench-ui tests: 126 passed + 60 todo (17 test files, 4 skipped as expected)
