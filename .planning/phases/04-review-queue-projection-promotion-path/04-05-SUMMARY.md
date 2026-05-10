---
phase: 04-review-queue-projection-promotion-path
plan: '05'
subsystem: workbench-ui
tags: [attention-flow, review-queue, snapshot, docs, REV-01, REV-02, REV-03]
dependency_graph:
  requires: [04-01-PLAN.md, 04-02-PLAN.md, 04-04-PLAN.md]
  provides: [reviewQueueRowCount-in-snapshot, attention-flow-flipped, REV-03-stub-docs]
  affects:
    - packages/workbench-ui/src/command/state.ts
    - packages/workbench-ui/src/command/flows.ts
    - packages/workbench-ui/src/command/flows.test.ts
    - packages/workbench-ui/src/CommandView.tsx
    - packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap
    - docs/AGENT-TEMPLATES.md
    - docs/REPLAY-EVALS.md
    - docs/SUBSTRATE-V1.md
tech_stack:
  added: []
  patterns:
    - useMemo snapshot extension (spread baseSnapshot + reviewQueueRowCount)
    - TDD RED/GREEN for flows.test.ts attention pair flip
    - Snapshot regen in dedicated commit (LM-8 / RESEARCH.md Pitfall 1)
    - Docs footers appended (AGENT-TEMPLATES, REPLAY-EVALS, SUBSTRATE-V1)
key_files:
  created: []
  modified:
    - packages/workbench-ui/src/command/state.ts
    - packages/workbench-ui/src/command/flows.ts
    - packages/workbench-ui/src/command/flows.test.ts
    - packages/workbench-ui/src/CommandView.tsx
    - packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap
    - docs/AGENT-TEMPLATES.md
    - docs/REPLAY-EVALS.md
    - docs/SUBSTRATE-V1.md
decisions:
  - useMemo on spread-extended snapshot limits re-renders to count changes only (T-04-W4-02 accepted)
  - Snapshot regen in dedicated commit per LM-8; diff is surgical (4 lines changed)
  - Docs catalog table includes all 53 events in delivery order matching event-types.ts comment order
metrics:
  duration_minutes: 30
  completed_date: '2026-05-10'
  tasks_completed: 5
  files_changed: 8
---

# Phase 04 Plan 05: Wave 4 Attention-Flow Flip + Docs Summary

**One-liner:** Phase 3 `attention` flow gauge flipped from Failed+suspicious proxy to real `/api/review-queue` row count; snapshot regenerated in isolated commit; three docs footers (AgentTemplate promotion media type, REV-03 stub note, 53-event audit catalog) close out Phase 4.

## Tasks Completed

| Task     | Name                                                                        | Commit  | Files                   |
| -------- | --------------------------------------------------------------------------- | ------- | ----------------------- |
| 1 (W4-A) | Add reviewQueueRowCount to CommandSnapshot in state.ts                      | 6b6b58c | state.ts                |
| 2 (W4-B) | Flip flows.ts attention compute body + update flows.test.ts                 | 2a57df6 | flows.ts, flows.test.ts |
| 3 (W4-C) | Wire useReviewQueue() into CommandView.tsx snapshot                         | 11ee301 | CommandView.tsx         |
| 4 (W4-D) | Regenerate cc-reload.test.tsx.snap (dedicated commit per LM-8)              | 116d816 | cc-reload.test.tsx.snap |
| 5 (W4-E) | Append docs footers to AGENT-TEMPLATES.md, REPLAY-EVALS.md, SUBSTRATE-V1.md | 2cbdc54 | 3 docs files            |

## Snapshot Diff Summary

The `cc-reload.test.tsx.snap` diff (commit 116d816) contains:

- **links section:** removed the `"#/tasks"` attention entry `"awaiting review queue projection — Phase 4 3 items"` — the cc-reload fetch mock returns `{}` for `/api/review-queue`, giving 0 rows, so the attention gauge returns `[]`.
- **sourceBound section:** the attention FlowOverlay empty-state label changed from `tag: "a", multiFields: "phase,suspicious"` to `tag: "div", multiFields: "reviewQueueRowCount"`, with text `"— no attention source data"`. This is the expected empty-state render when no attention gauges fire.

Net: 3 insertions, 7 deletions. Diff is surgical and reviewer-scrutinizable in isolation.

## Docs Footer Fidelity

All three doc footers were added verbatim from the plan's `<action>` blocks with minor formatting adjustments (prettier normalized some table spacing). Content is faithful:

- `docs/AGENT-TEMPLATES.md`: "## Promotion via review queue (Phase 4)" — media type `application/x-kagent-template-candidate+yaml`, producer/reviewer flow, link to 04-CONTEXT.md.
- `docs/REPLAY-EVALS.md`: "## REV-03 stub — Phase 4 placement" — describes reserved `replay-divergence` / `eval-failed` slots and the Phase 5 promotion path.
- `docs/SUBSTRATE-V1.md` §4.3: Extended with a full 53-event audit catalog table. Added 4 new rows for `review.requested`, `review.accepted`, `review.rejected`, `template.candidate.promoted`.

## Phase 4 Close-out Note

**Phase 4 complete. REV-01, REV-02, REV-03 all delivered.** Roadmap status: Phase 4 -> COMPLETE; Phase 5 (Workbench usability primitives) is next.

- **REV-01**: Server projection (`GET /api/review-queue`) + UI (`ReviewPage`, `ReviewActions`, `useReviewQueue`) + flow gauge wiring — complete.
- **REV-02**: Single-reviewer `POST .../accept|reject|request` handlers + AgentTemplate promotion path via `candidate-template` reason — complete.
- **REV-03**: Forward-compatible stubs (`replay-divergence`, `eval-failed` reasons in `ReviewReason`, inline comment in `routes/review-queue.ts`) + docs footer in `REPLAY-EVALS.md` — complete.

## Deviations from Plan

None — plan executed exactly as written. The test structure (18 tests in flows.test.ts after the +1 sourceFields shape assertion, 118 total in the UI suite) matches the plan's expectations.

## Known Stubs

None. All data flows are wired: `useReviewQueue` polls `/api/review-queue` at 5s, `reviewQueueRowCount` reaches `attention.compute(s)` via the `useMemo`-extended snapshot, and the gauge renders `#/review` when count > 0.

## Threat Flags

No new security-relevant surfaces beyond those declared in the plan's threat model.

## Self-Check: PASSED

Files exist:

- packages/workbench-ui/src/command/state.ts (reviewQueueRowCount): FOUND
- packages/workbench-ui/src/command/flows.ts (reviewQueueRowCount, '#/review'): FOUND
- packages/workbench-ui/src/command/flows.test.ts (reviewQueueRowCount): FOUND
- packages/workbench-ui/src/CommandView.tsx (useReviewQueue, reviewQueueRowCount): FOUND
- packages/workbench-ui/src/command/**snapshots**/cc-reload.test.tsx.snap (reviewQueueRowCount): FOUND
- docs/AGENT-TEMPLATES.md (application/x-kagent-template-candidate+yaml): FOUND
- docs/REPLAY-EVALS.md (REV-03): FOUND
- docs/SUBSTRATE-V1.md (review.accepted): FOUND

Commits verified:

- 6b6b58c: feat(phase-04-w4): add reviewQueueRowCount field to CommandSnapshot (REV-01)
- 2a57df6: feat(phase-04-w4): flip attention flow gauge to /api/review-queue source (REV-01)
- 11ee301: feat(phase-04-w4): wire useReviewQueue into CommandView snapshot (REV-01)
- 116d816: test(phase-04-w4): regen cc-reload.test.tsx.snap after attention-flow flip
- 2cbdc54: docs(phase-04-w4): add review-queue + REV-03 stub + audit-event catalog footers

Test suite: 118 tests pass (`pnpm -C packages/workbench-ui test`), 0 failures.
