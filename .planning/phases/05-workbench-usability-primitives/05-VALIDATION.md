---
phase: 05
slug: workbench-usability-primitives
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-10
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `05-RESEARCH.md §5 Validation Architecture` and `§17 Validation Architecture (recap)`.
> Drives Nyquist sampling during `/gsd-execute-phase`.

---

## Test Infrastructure

| Property                   | Value                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Framework**              | vitest 4.1.4 (jsdom env for workbench-ui; node env for workbench-api / audit-events)                                           |
| **Config file**            | `packages/workbench-ui/vite.config.ts`; `packages/workbench-api/vitest.config.ts` (verify exists; create in Wave 0 if missing) |
| **UI quick run**           | `pnpm -C packages/workbench-ui test`                                                                                           |
| **API quick run**          | `pnpm -C packages/workbench-api test`                                                                                          |
| **Audit-events quick run** | `pnpm -C packages/audit-events test`                                                                                           |
| **Full suite command**     | `pnpm -r test` (from repo root)                                                                                                |
| **Estimated runtime**      | ~60 seconds (full workspace)                                                                                                   |

---

## Sampling Rate

- **After every task commit:** Run the touched package's `pnpm -C packages/<pkg> test` (or `--changed` if reliable).
- **After every plan wave:** Run `pnpm -r test`.
- **Before `/gsd-verify-work`:** Full suite must be green; `docs/HOTKEYS.md` manual review; grep for forbidden patterns (no `bulk-accept`/`bulk-reject` in `src/`; no new CRD shapes; no new sound methods on `command/sound.ts`).
- **Max feedback latency:** 60 seconds (workspace full run).

---

## Per-Task Verification Map

| Req ID | Behavior                                                                           | Test Type     | Automated Command                                                     | File Exists                                                | Status     |
| ------ | ---------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- | ---------- |
| WB-01  | App-level `g <letter>` chord dispatches hash change                                | unit          | `pnpm -C packages/workbench-ui test -t "useGlobalHotkeys"`            | ❌ W0 — `hotkeys.test.ts`                                  | ⬜ pending |
| WB-01  | `isTextTarget` blocks dispatch in INPUT/TEXTAREA/SELECT/contenteditable            | unit          | `pnpm -C packages/workbench-ui test -t "isTextTarget"`                | ❌ W0                                                      | ⬜ pending |
| WB-01  | `g` chord 1500ms timeout silently expires                                          | unit          | `pnpm -C packages/workbench-ui test -t "chord timeout"`               | ❌ W0                                                      | ⬜ pending |
| WB-01  | `Esc` between `g` and follow-up cancels chord                                      | unit          | `pnpm -C packages/workbench-ui test -t "chord cancel"`                | ❌ W0                                                      | ⬜ pending |
| WB-01  | Ctrl+`g` does NOT trigger `g` chord (modifier guard)                               | unit          | `pnpm -C packages/workbench-ui test -t "modifier guard"`              | ❌ W0                                                      | ⬜ pending |
| WB-01  | `?` opens cheat sheet from any non-`#/command` route                               | integration   | `pnpm -C packages/workbench-ui test -t "cheat sheet"`                 | ❌ W0 — `HotkeyCheatSheet.test.tsx`                        | ⬜ pending |
| WB-01  | `?` inside `#/command` short-circuits to CommandView's local hint                  | integration   | `pnpm -C packages/workbench-ui test -t "cheat sheet command"`         | ❌ W0                                                      | ⬜ pending |
| WB-01  | TaskDetail `t` opens `traceLink.url` in new tab when present                       | integration   | `pnpm -C packages/workbench-ui test -t "TaskDetail trace"`            | partial — extend `TaskDetail.test.tsx` (create if missing) | ⬜ pending |
| WB-01  | TaskDetail `t` with no trace fires toast (no tab open)                             | integration   | `pnpm -C packages/workbench-ui test -t "TaskDetail no trace"`         | partial — extend                                           | ⬜ pending |
| WB-01  | ReviewPage `j`/`k` row navigation (stable across refresh via `uid`)                | integration   | `pnpm -C packages/workbench-ui test ReviewPage`                       | ✅ exists; extend                                          | ⬜ pending |
| WB-01  | ReviewPage `a`/`r` opens existing accept/reject confirm                            | integration   | `pnpm -C packages/workbench-ui test -t "ReviewPage accept reject"`    | ✅ extend                                                  | ⬜ pending |
| WB-01  | ReviewPage `Esc` defocuses row                                                     | integration   | `pnpm -C packages/workbench-ui test -t "ReviewPage defocus"`          | ✅ extend                                                  | ⬜ pending |
| WB-01  | CommandView `o` opens TaskDetail for task focus                                    | integration   | `pnpm -C packages/workbench-ui test -t "CommandView open detail"`     | partial — extend                                           | ⬜ pending |
| WB-01  | CommandView `o` on agent focus fires toast (no AgentDetail in v0.2)                | integration   | `pnpm -C packages/workbench-ui test -t "CommandView agent no-op"`     | partial — extend                                           | ⬜ pending |
| WB-01  | `docs/HOTKEYS.md` exists and matches `HOTKEY_CHEAT_SHEET` content                  | manual review | grep + diff against `hotkeys.ts` const                                | ❌ new doc file                                            | ⬜ pending |
| WB-01  | `docs/COMMAND-CENTER-CONTRACT.md` carries discoverability footer link              | manual review | grep for `HOTKEYS.md` in CONTRACT                                     | partial — extend                                           | ⬜ pending |
| WB-02  | `<SelectionActions>` mounts only when `selection.keys.size >= 2`                   | unit          | `pnpm -C packages/workbench-ui test SelectionActions`                 | ❌ W0 — `SelectionActions.test.tsx`                        | ⬜ pending |
| WB-02  | Button labels reflect selection count (`Open 3 in tabs`, `Copy 3 IDs`)             | unit          | `pnpm -C packages/workbench-ui test -t "selection count"`             | ❌ W0                                                      | ⬜ pending |
| WB-02  | "Open N in tabs" caps at 10 + emits overflow toast                                 | unit          | `pnpm -C packages/workbench-ui test -t "tabs cap"`                    | ❌ W0                                                      | ⬜ pending |
| WB-02  | "Copy IDs" calls clipboard + falls back to textarea on permission denial           | unit          | `pnpm -C packages/workbench-ui test -t "copy IDs"`                    | ❌ W0                                                      | ⬜ pending |
| WB-02  | "Scroll to first failure" pans camera via `easeCameraTo`                           | unit          | `pnpm -C packages/workbench-ui test -t "scroll to failure"`           | ❌ W0                                                      | ⬜ pending |
| WB-02  | "Scroll to first failure" no-match → toast, no camera change                       | unit          | `pnpm -C packages/workbench-ui test -t "no failures"`                 | ❌ W0                                                      | ⬜ pending |
| WB-02  | TaskList `?targetAgent=X` query param filters rows                                 | integration   | `pnpm -C packages/workbench-ui test -t "targetAgent filter"`          | partial — extend `TaskList.test.tsx` (create if missing)   | ⬜ pending |
| WB-02  | Bulk-mutate actions ARE NOT shipped (verified by absence)                          | code review   | grep `src/` for `bulk-accept`/`bulk-reject`/`bulk-replay` → 0 matches | manual                                                     | ⬜ pending |
| WB-02  | `cc-orphan` assertion does NOT fire on `<SelectionActions>` button labels          | integration   | existing `cc-reload.test.tsx` after snapshot regen                    | ✅ extend (snapshot regen)                                 | ⬜ pending |
| WB-03  | `validateCreateTaskBody` accepts `replayOf` with valid `taskRef`                   | unit          | `pnpm -C packages/workbench-api test validators`                      | ✅ exists; extend                                          | ⬜ pending |
| WB-03  | `validateReplayOf` rejects missing `taskRef.namespace`/`name`                      | unit          | `pnpm -C packages/workbench-api test -t "validateReplayOf required"`  | ✅ extend                                                  | ⬜ pending |
| WB-03  | `validateReplayOf` rejects non-RFC1123 names                                       | unit          | `pnpm -C packages/workbench-api test -t "validateReplayOf RFC1123"`   | ✅ extend                                                  | ⬜ pending |
| WB-03  | `validateReplayOf` rejects `reason` >256 chars / with newlines                     | unit          | `pnpm -C packages/workbench-api test -t "validateReplayOf reason"`    | ✅ extend                                                  | ⬜ pending |
| WB-03  | `validateReplayOf` rejects malformed `taskRef.uid` UUID                            | unit          | `pnpm -C packages/workbench-api test -t "validateReplayOf uid"`       | ✅ extend                                                  | ⬜ pending |
| WB-03  | POST `/api/tasks` 5-step replay: SnapshotCache miss → 422                          | unit          | `pnpm -C packages/workbench-api test -t "replay snapshot miss"`       | ✅ extend `routes/tasks.test.ts`                           | ⬜ pending |
| WB-03  | POST `/api/tasks` 5-step replay: UID mismatch → 422                                | unit          | `pnpm -C packages/workbench-api test -t "replay UID mismatch"`        | ✅ extend                                                  | ⬜ pending |
| WB-03  | POST `/api/tasks` 5-step replay: happy path → 201 + 5 annotations on new AgentTask | unit          | `pnpm -C packages/workbench-api test -t "replay happy path"`          | ✅ extend                                                  | ⬜ pending |
| WB-03  | POST `/api/tasks` replay emits `task.replay.created` audit event                   | unit          | `pnpm -C packages/workbench-api test -t "task.replay.created"`        | ✅ extend                                                  | ⬜ pending |
| WB-03  | POST `/api/tasks` replay inherits `actions.create=false` fail-closed               | unit          | `pnpm -C packages/workbench-api test -t "replay fail-closed"`         | ✅ extend                                                  | ⬜ pending |
| WB-03  | `ReplayModal` pre-fills target Agent from original task                            | integration   | `pnpm -C packages/workbench-ui test ReplayModal`                      | ❌ W0 — `ReplayModal.test.tsx`                             | ⬜ pending |
| WB-03  | `ReplayModal` dropdown populated from `/api/agents`                                | integration   | `pnpm -C packages/workbench-ui test -t "ReplayModal agents"`          | ❌ W0                                                      | ⬜ pending |
| WB-03  | `ReplayModal` rejects `reason` >256 chars (client-side)                            | integration   | `pnpm -C packages/workbench-ui test -t "ReplayModal reason"`          | ❌ W0                                                      | ⬜ pending |
| WB-03  | `ReplayModal` submit sends `replayOf: { taskRef, reason? }` body                   | integration   | `pnpm -C packages/workbench-ui test -t "ReplayModal submit"`          | ❌ W0                                                      | ⬜ pending |
| WB-03  | `audit-events` extended with `task.replay.created` type + data shape               | type-only     | `pnpm -C packages/audit-events test types`                            | ✅ extend                                                  | ⬜ pending |
| WB-03  | `docs/SUBSTRATE-V1.md` §4.3 catalog grows by 1 entry                               | manual review | grep `task.replay.created` in `SUBSTRATE-V1.md`                       | manual                                                     | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

New test files (must exist before any plan in a later wave references them):

- [ ] `packages/workbench-ui/src/hotkeys.test.ts` — `isTextTarget` + chord state machine (WB-01)
- [ ] `packages/workbench-ui/src/HotkeyCheatSheet.test.tsx` — modal render + Esc-to-close + section completeness (WB-01)
- [ ] `packages/workbench-ui/src/ReplayModal.test.tsx` — modal pre-fill + submit + validation (WB-03)
- [ ] `packages/workbench-ui/src/command/SelectionActions.test.tsx` — mount-guard + button labels + three action handlers (WB-02)
- [ ] `packages/workbench-ui/src/TaskDetail.test.tsx` — skeleton (create if missing) for `t` key + Replay button mount (WB-01/03)
- [ ] `packages/workbench-ui/src/TaskList.test.tsx` — skeleton (create if missing) for `?targetAgent=X` filter (WB-02)
- [ ] _(Optional, planner discretion)_ `packages/workbench-ui/src/useAlert.test.ts` — shared toast hook if planner promotes it

Test framework / fixture installs: **NONE** — vitest 4.1.4 + jsdom 27.x + testing-library 16.3.0 already installed (verified in `packages/workbench-ui/package.json`).

---

## Manual-Only Verifications

| Behavior                                                       | Requirement | Why Manual                                          | Test Instructions                                                                                                                                                               |
| -------------------------------------------------------------- | ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/HOTKEYS.md` completeness vs shipped `HOTKEY_CHEAT_SHEET` | WB-01       | Doc drift detection requires human comparison       | Open both files; verify every entry in the const has a matching row in the doc and vice versa                                                                                   |
| `docs/COMMAND-CENTER-CONTRACT.md` discoverability footer       | WB-01       | Single-line link added; no contract revision intent | grep `HOTKEYS.md` near end of file; verify it's a footer-style link, not a Prime-Directive amendment                                                                            |
| `docs/SUBSTRATE-V1.md` §4.3 catalog row                        | WB-03       | One-line addition to an ordered list                | grep `task.replay.created` in §4.3; verify alphabetic / chronological ordering preserved                                                                                        |
| §11 bounds-test + §15 one-sentence test text in PLAN.md        | All         | Project-gate convention from `PROJECT.md`           | grep PLAN.md(s) for the two canonical statements per CONTEXT.md anchors #6 + #7                                                                                                 |
| No new substrate primitives shipped                            | All         | Negative verification — grep for forbidden patterns | grep `src/` for new CRD schema, new RBAC verb in `clusterrole-actions.yaml`, new sound method in `command/sound.ts`, new FX type in `command/fx.ts` — all must return 0 matches |
| Touch / mobile / accessibility behavior                        | All         | Out of scope per CONTEXT.md `<deferred>`            | N/A — explicit non-goal                                                                                                                                                         |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies recorded above
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all `❌ W0` references in the verification map
- [ ] No `--watch` mode flags in any plan task
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter after `/gsd-validate-phase 5` passes
- [ ] §11 bounds-test answer present in at least one Phase 5 PLAN.md (anchors CONTEXT.md #6)
- [ ] §15 one-sentence test answer present in at least one Phase 5 PLAN.md (anchors CONTEXT.md #7)

**Approval:** pending
