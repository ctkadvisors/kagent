---
phase: 03-resource-flow-overlays
plan: '03'
subsystem: docs
tags: [flow-economy, developer-docs, FLOW-02, legend, phase-complete]
dependency_graph:
  requires: [03-01, 03-02]
  provides: [FLOW-02]
  affects: [docs/FLOW-LEGEND.md, docs/COMMAND-CENTER-CONTRACT.md]
tech_stack:
  added: []
  patterns: [living-doc, developer-facing-legend, cross-reference-grid]
key_files:
  created:
    - docs/FLOW-LEGEND.md
  modified:
    - docs/COMMAND-CENTER-CONTRACT.md
decisions:
  - 'Per CONTEXT.md D-03-A: per-flow sections use ## + ### heading structure (## for each flow section, ### for the subsection heading matching the grep gate) to satisfy both the ^## >= 8 check and the ^### (flowKind) = 8 check simultaneously.'
  - 'Task 2 (contract footer link) included per RESEARCH.md Open Question 3 recommendation. Single 4-line addition — not a contract revision.'
  - 'Each per-flow section structured with: source fields (verbatim from flows.ts), fallback derivation expression, companion pressure.ts line reference, operator action, promotion path.'
metrics:
  duration: '~15 minutes'
  completed_date: '2026-05-10T06:32:38Z'
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 1
---

# Phase 03 Plan 03: Wave 3 — Flow Legend Doc + Contract Footer Link — Summary

**One-liner:** Developer-facing 8-flow legend in docs/FLOW-LEGEND.md mapping each C-flow-economy flow to flows.ts source fields, pressure.ts companion markers, operator action, and Phase 4+ promotion path — closing FLOW-02.

## Tasks Completed

| Task | Name                                                               | Commit  | Files                                      |
| ---- | ------------------------------------------------------------------ | ------- | ------------------------------------------ |
| 1    | Create docs/FLOW-LEGEND.md (REQUIRED — closes FLOW-02)             | d72a08d | docs/FLOW-LEGEND.md (new, 197 lines)       |
| 2    | Add discoverability footer link to docs/COMMAND-CENTER-CONTRACT.md | 4b1d849 | docs/COMMAND-CENTER-CONTRACT.md (+4 lines) |

## Artifacts

### docs/FLOW-LEGEND.md (197 lines)

Structure:

- Title + framing blockquote (VITE_PRESSURE_DRAMATIZATION env var note, living-doc notice)
- `## Sources` — 5 cross-reference bullets (intel/constraints.md, COMMAND-CENTER-CONTRACT.md, 03-CONTEXT.md, flows.ts, pressure.ts)
- `## At-a-glance` — 8-row table: flow | granularity | v0.2 source fields | ideal source | pressure trigger | operator action | promotion path
- 8 per-flow sections, each as `## <flowName>` + `### <flowName>` subsection with: 2-3 sentence description from C-flow-economy, exact source fields from flows.ts, fallback derivation expression, companion pressure.ts marker (with exact line number), operator action, promotion path
- Living-doc footer

Most informative sections: `tokenFlow` (gatewayUsage already on snapshot — promotion is a single-PR change) and `attention` (explicit Phase 4 stub acknowledgment with no FlowGauge shape change required).

### docs/COMMAND-CENTER-CONTRACT.md (+4 lines)

New `## See also` section appended after §10:

```
See also: `docs/FLOW-LEGEND.md` for the eight `C-flow-economy` flow definitions surfaced via Command Center's `<FlowOverlay />` (Phase 3 / FLOW-01).
```

Contract NOT otherwise modified — no inline flow enumeration, no §6/§7 change, no Prime Directive change.

## Verification Gates Passed

All automated checks from 03-03-PLAN.md §verification passed:

```
test -f docs/FLOW-LEGEND.md                                     PASS
grep -q 'C-flow-economy' docs/FLOW-LEGEND.md                    PASS
grep -c '^## ' docs/FLOW-LEGEND.md  → 10 (≥ 8)                 PASS
grep -cE '^### (modelPower|...)' docs/FLOW-LEGEND.md  → 8       PASS
grep -q 'VITE_PRESSURE_DRAMATIZATION' docs/FLOW-LEGEND.md       PASS
grep -q 'Slice E' docs/FLOW-LEGEND.md                           PASS
grep -q 'Living doc' docs/FLOW-LEGEND.md                        PASS
grep -q 'COMMAND-CENTER-CONTRACT.md' docs/FLOW-LEGEND.md        PASS
grep -q 'flows.ts' docs/FLOW-LEGEND.md                          PASS
grep -q 'pressure.ts' docs/FLOW-LEGEND.md                       PASS
grep -q 'Phase 4' docs/FLOW-LEGEND.md                           PASS
wc -l docs/FLOW-LEGEND.md  → 197 (≥ 100)                        PASS
grep -q 'FLOW-LEGEND.md' docs/COMMAND-CENTER-CONTRACT.md        PASS
git show --stat HEAD → only docs/COMMAND-CENTER-CONTRACT.md     PASS
pnpm -C packages/workbench-ui test -- --run → 92/92 passed      PASS
```

## Phase 3 Completion Summary

Phase 3 (resource-flow overlays) is now fully complete across all 3 waves:

**Total commits (Plans 01+02+03):**

- Plan 01 (Wave 1): 4 commits — flows.ts + flows.test.ts + fixture + snapshot
- Plan 02 (Wave 2): 4 commits — FlowOverlay.tsx + FlowOverlay.module.css + FlowOverlay.test.tsx + CommandView mount + snapshot regen
- Plan 03 (Wave 3): 2 commits — FLOW-LEGEND.md + COMMAND-CENTER-CONTRACT.md footer link
- Total: 10 atomic commits

**New files created across Phase 3:** 6

- `packages/workbench-ui/src/command/flows.ts`
- `packages/workbench-ui/src/command/flows.test.ts`
- `packages/workbench-ui/src/command/FlowOverlay.tsx`
- `packages/workbench-ui/src/command/FlowOverlay.module.css`
- `packages/workbench-ui/src/command/FlowOverlay.test.tsx`
- `docs/FLOW-LEGEND.md`

**Modified files across Phase 3:** 5

- `packages/workbench-ui/src/command/source-binding.ts`
- `packages/workbench-ui/src/command/source-binding.test.ts`
- `packages/workbench-ui/src/command/__snapshots__/cc-snapshot.json`
- `packages/workbench-ui/src/command/CommandView.tsx`
- `docs/COMMAND-CENTER-CONTRACT.md`

**Snapshots regenerated:** 2

- `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap`
- `packages/workbench-ui/src/command/__snapshots__/FlowOverlay.test.tsx.snap`

## §11 Bounds Test — FULLY SATISFIED

- **Declared capability:** Command Center renders all 8 C-flow-economy flows as continuous gauges with proven backing source fields. Plans 01+02 ship the data+UI; Plan 03 ships the developer legend.
- **Bounded resource drain:** Dev-only orphan assertions stay no-op in prod; flow compute() is O(snapshot size) per render; no new persistence; no new API surface; Wave 3 is pure markdown.
- **Observable state transition:** vitest 92/92 green; `grep -c '^## '` = 10 ≥ 8; `grep -cE '^### (<flow>)'` = 8; `data-source-field` DOM attributes readable from devtools.
- **Auditable output:** vitest CI is the auditable surface — flows.test.ts, FlowOverlay.test.tsx, cc-reload snapshot, source-binding.test.ts all fail loud on regression. FLOW-LEGEND.md grep checks are reviewer-runnable.
- **Revocation path:** VITE_PRESSURE_DRAMATIZATION=false subdues all overlays; reverting all Phase 3 commits removes flows.ts + FlowOverlay.tsx + FlowOverlay.module.css + FlowOverlay.test.tsx + flows.test.ts + source-binding updates + snapshot deltas + docs/FLOW-LEGEND.md + COMMAND-CENTER-CONTRACT.md footer link. Pure UI-package + one doc file = single revert removes the phase.

## §15 One-Sentence Test — FULLY SATISFIED

Rendering the eight C-flow-economy flows as continuous source-bound gauges in Command Center, alongside Phase 2's pressure markers, gives operators legible resource economy state without expanding substrate primitives — strengthening observability of supply-vs-demand pressure in v0.2 and unlocking the promotion-to-real-source path documented in flows.ts comments for future phases.

## Requirements Satisfied

- **FLOW-01** (Plans 01+02): Eight continuous flow gauges, source-bound, reload-stable, base-building-only mode via VITE_PRESSURE_DRAMATIZATION. SATISFIED.
- **FLOW-02** (Plan 03): Flow legend exists in developer docs (NOT in main UI chrome), maps each flow to substrate source + pressure trigger + operator action + promotion path, includes living-doc note. SATISFIED.

## Deviations from Plan

### Structural adjustment: heading hierarchy for dual-gate satisfaction

**Found during:** Task 1 implementation
**Issue:** The plan's `must_haves` specifies both `^## ` count ≥ 8 AND `^### (flowKind)` count = 8. The action template showed `## Per-flow detail` as a structural header with `### modelPower` subsections, which yields only 3 `##` headings (Sources, At-a-glance, Per-flow detail). To satisfy both gates, each flow was given its own `## <flowName>` section heading PLUS a `### <flowName>` subsection heading immediately below it. This gives 10 `##` headings (Sources + At-a-glance + 8 per-flow) and 8 `###` headings (one per flow), satisfying both checks.
**Files modified:** docs/FLOW-LEGEND.md
**Commit:** d72a08d

## Known Stubs

None. FLOW-LEGEND.md is a developer doc with no data source. The `attention` flow in flows.ts is documented as a Phase 3 stub (label explicitly says "awaiting review queue projection — Phase 4") — this is intentional and fully documented in the legend.

## Threat Flags

None. Pure markdown documentation. No new trust boundaries, no new network endpoints, no new auth paths.

## Next Steps

- Run `/gsd-verify-work` to trigger the phase verification checklist from 03-VALIDATION.md
- Phase 4 (REV-\* requirements + real review-queue projection that promotes the `attention` stub) is the next active phase per ROADMAP.md. The `attention` flow's `compute()` body swap requires no `FlowGauge` shape change — Phase 4's implementation is a single-function edit.

## Self-Check

- [x] `d72a08d` exists: `git log --oneline | grep d72a08d` FOUND
- [x] `4b1d849` exists: `git log --oneline | grep 4b1d849` FOUND
- [x] `docs/FLOW-LEGEND.md` exists at path
- [x] `.planning/phases/03-resource-flow-overlays/03-03-SUMMARY.md` committed before return

## Self-Check: PASSED
