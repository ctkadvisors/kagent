---
phase: 03-resource-flow-overlays
plan: '02'
subsystem: workbench-ui
tags: [react, flow-overlay, command-center, source-binding, vitest, css-module]
dependency_graph:
  requires: [03-01]
  provides: [FLOW-01-ui, cc-reload-stability-extended]
  affects: [CommandView, cc-reload-snapshot]
tech_stack:
  added: []
  patterns:
    - FlowOverlay (React FC, grouped-by-kind, always-visible 8 sections)
    - flowGauge/flowGaugeSubdued CSS class pair (dramatic/subdued toggle)
    - empty-state placeholder row with data-source-field(s) (silence is data)
    - bottom:16px left:16px positioning (non-colliding with PressureOverlay/DispositionOverlay)
key_files:
  created:
    - packages/workbench-ui/src/command/FlowOverlay.tsx
    - packages/workbench-ui/src/command/FlowOverlay.module.css
    - packages/workbench-ui/src/command/FlowOverlay.test.tsx
    - packages/workbench-ui/src/command/__snapshots__/FlowOverlay.test.tsx.snap
  modified:
    - packages/workbench-ui/src/CommandView.tsx
    - packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap
decisions:
  - FlowOverlay positioned at bottom:16px left:16px to avoid collision with PressureOverlay (top:left) and DispositionOverlay (top:right) per RESEARCH.md Open Question 2
  - FlowOverlay never returns null — all 8 sections always visible (deliberate deviation from PressureOverlay:49 per CONTEXT.md D-05-A + RESEARCH.md Pitfall 7)
  - pressureDramatization prop name preserved (not renamed) per CONTEXT.md D-04-A single-global-flag
  - Snapshot regen committed in separate Task 3 commit for reviewer ergonomics per RESEARCH.md Pitfall 1
metrics:
  duration: ~20 min
  completed: '2026-05-10'
  tasks_completed: 3
  files_changed: 6
---

# Phase 03 Plan 02: FlowOverlay Component + CommandView Mount Summary

Wave 2 of Phase 3 — FlowOverlay React component built, CSS module created, component tests written, mounted in CommandView alongside PressureOverlay, cc-reload snapshot regenerated in a separate commit for reviewer ergonomics.

## What Was Built

**FlowOverlay.tsx** (136 lines) — React FC rendering the 8 C-flow-economy flow gauges from the Wave 1 `FLOW_TYPES` data layer. Key design points:

- Groups by `FLOW_TYPES` kind (NOT flat gauge list) — always renders all 8 sections
- Empty-state placeholder rows carry `data-source-field(s)` so the orphan assertion has a backing field even when a flow has no data (deliberate deviation from `PressureOverlay.tsx:49`'s `return null`)
- Horizontal bar + readout overlay when `capacity` is defined; readout-only when capacity is undefined (rate-only flows)
- `useMemo` over snapshot with `[snapshot]` dep — pure, no internal state, reload-stable by construction
- `pressureDramatization` prop (single global flag per D-04-A — NOT renamed to `flowDramatization`)
- Conditional spread idiom for `data-source-field`/`data-source-fields` (strict-typed JSX, no attribute set to undefined)

**FlowOverlay.module.css** (157 lines) — Scoped CSS module positioned at `bottom: 16px; left: 16px; max-height: 60vh; overflow-y: auto` to avoid collision with PressureOverlay (top:left) and DispositionOverlay (top:right). Dramatic/subdued class pair `flowGauge`/`flowGaugeSubdued` using blue tint (vs pressure's red) to visually distinguish resource-economy gauges from binary-threshold markers.

**FlowOverlay.test.tsx** (230 lines, 5 tests):

1. All 8 sections always rendered including empty-state placeholders
2. Gauges carry `data-source-field(s)` and correct `href`
3. Reload stability (stable selectors, matches snapshot)
4. `pressureDramatization=true` applies dramatic class
5. `pressureDramatization=false` keeps data, applies subdued class

**CommandView.tsx** — 1 import line + ~12 JSX lines (FlowOverlay mount with comment block) inserted between `<PressureOverlay />` and `<div className={styles.hotkeyStrip}>`.

**cc-reload.test.tsx.snap** — Auto-regenerated via `vitest -u`; grows by 90 lines capturing FlowOverlay's 8 placeholder anchors + the modelPower/tokenFlow/trust/authority/attention gauges that fire from the cc-snapshot.json fixture.

## Commit History

| Task                        | Commit    | Description                                                                   |
| --------------------------- | --------- | ----------------------------------------------------------------------------- |
| 1 — component + CSS + tests | `fc6a6fd` | feat(phase-03-02): add FlowOverlay component, CSS module, and tests           |
| 2 — CommandView mount       | `59f3d41` | feat(phase-03-02): mount FlowOverlay in CommandView alongside PressureOverlay |
| 3 — snapshot regen          | `8428da6` | chore(phase-03-02): regenerate cc-reload snapshot after FlowOverlay mount     |

## Verification Results

All 92 workbench-ui tests pass after Task 3:

- 10 test files, 92 tests, 0 failures
- `tsc -p tsconfig.build.json --noEmit` clean throughout
- cc-reload.test.tsx: GREEN (1 updated snapshot)
- FlowOverlay.test.tsx: 5 passing tests + 1 initial snapshot written
- cc-reload snapshot grows ~90 lines (within RESEARCH.md Assumption A1 range of 30–60 new lines; slightly more due to 8 always-visible placeholder anchors)

## Deviations from Plan

### Intentional Semantic Deviations (per plan + patterns doc)

**1. [Plan — Deliberate] FlowOverlay does NOT return null on empty data**

- **Deviation from:** `PressureOverlay.tsx:49` `if (markers.length === 0) return null;`
- **Why:** CONTEXT.md D-05-A + RESEARCH.md Pitfall 7 explicitly require all 8 flows always visible — silence is data
- **Implementation:** Groups by `FLOW_TYPES` kind; when `compute()` returns `[]`, renders a `<div className={styles.emptyRow}>` with `data-source-field(s)` from the `FlowType` definition

**2. [Plan — Deliberate] useMemo returns `ReadonlyMap` grouped by kind**

- **Deviation from:** `PressureOverlay.tsx:45–48` flat `useMemo<readonly PressureMarker[]>`
- **Why:** Required for grouped-by-kind section rendering (PATTERNS.md §FlowOverlay pattern assignment)
- **Implementation:** `ReadonlyMap<FlowType['kind'], readonly FlowGauge[]>` built once per snapshot change

No unplanned deviations — plan executed exactly as written.

## Known Stubs

None in this plan's files. The attention flow stub (`label='awaiting review queue projection — Phase 4'`) lives in `flows.ts` (Wave 1 / Plan 01) and is documented there. This plan's FlowOverlay renders what `flows.ts` provides without modification.

## Threat Flags

None. FlowOverlay.tsx + FlowOverlay.module.css + FlowOverlay.test.tsx are read-side UI files with no new network endpoints, no auth paths, no file access, no schema changes. CommandView.tsx change is a pure JSX addition. No new trust boundaries introduced.

## Self-Check: PASSED

- FOUND: packages/workbench-ui/src/command/FlowOverlay.tsx (136 lines, min 80)
- FOUND: packages/workbench-ui/src/command/FlowOverlay.module.css (157 lines, min 60)
- FOUND: packages/workbench-ui/src/command/FlowOverlay.test.tsx (230 lines, min 150)
- FOUND: packages/workbench-ui/src/command/**snapshots**/FlowOverlay.test.tsx.snap
- FOUND: packages/workbench-ui/src/command/**snapshots**/cc-reload.test.tsx.snap
- COMMIT fc6a6fd: verified present
- COMMIT 59f3d41: verified present
- COMMIT 8428da6: verified present
- FlowOverlay.tsx contains 'FlowOverlay': YES
- FlowOverlay.module.css contains 'flowGaugeSubdued': YES
- FlowOverlay.test.tsx contains 'flowGaugeSubdued': YES
- CommandView.tsx contains 'FlowOverlay': YES
- cc-reload.test.tsx.snap contains 'data-source-field': YES
- All 92 workbench-ui tests: PASS
- tsc --noEmit: CLEAN
