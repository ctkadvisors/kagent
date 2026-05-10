---
phase: 03-resource-flow-overlays
plan: 01
subsystem: workbench-ui / command-center
tags: [flows, source-binding, vitest, tdd, wave-1]
dependency-graph:
  requires: [02-04-SUMMARY.md]
  provides: [FLOW_TYPES, FlowGauge, FlowType, FlowFieldName, cc-snapshot-fixture-extended]
  affects: [03-02-PLAN.md (Wave 2 imports FLOW_TYPES)]
tech-stack:
  added: []
  patterns: [closed-enum-from-array, pure-function-compute, v0.2-fallback-with-promotion-path]
key-files:
  created:
    - packages/workbench-ui/src/command/flows.ts
    - packages/workbench-ui/src/command/flows.test.ts
  modified:
    - packages/workbench-ui/src/command/source-binding.ts
    - packages/workbench-ui/src/command/source-binding.test.ts
    - packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json
decisions:
  - 'exactOptionalPropertyTypes: true requires omitting capacity property when undefined rather than setting it explicitly — use conditional spread (...(cap !== undefined ? { capacity: cap } : {}))'
  - "Pre-commit hook (pnpm -r typecheck) forces test + implementation into same commit when types are type-import-only — deviation from plan's strict RED→GREEN separate-commit discipline"
  - 'flows.test.ts taskKey() helper removed — not needed in unit tests; included in flows.ts for future use pattern from pressure.ts'
metrics:
  duration: ~10 minutes
  completed: 2026-05-10
  tasks-completed: 2
  files-modified: 5
---

# Phase 3 Plan 01: Flow Data Module + Tests (Wave 1) Summary

Wave 1 of Phase 3 ships the pure-data + tests + fixture foundation for FLOW-01. Eight `C-flow-economy` flow types are implemented as a closed-enum typed array in `flows.ts`, proved by 17 vitest tests, and source-binding is extended with the `FlowFieldName` re-export — ready for Wave 2's `<FlowOverlay />` component.

## What Was Built

**`packages/workbench-ui/src/command/flows.ts`** (322 lines) — Pure-data module mirroring `pressure.ts`. Exports:

- `FlowGauge` interface (kind, sourceField?, sourceFields?, affectedKey?, detailLink, label, value, capacity?, unit?)
- `FlowType` interface (kind union of 8 literals, granularity union of 5 literals, compute function, detailLink function)
- `FLOW_TYPES: readonly FlowType[]` with 8 entries in canonical order
- `FlowFieldName = FlowType['kind']` closed-enum footer (same pattern as `pressure.ts:319`)

**`packages/workbench-ui/src/command/flows.test.ts`** (295 lines) — 17 vitest tests:

- 8 "fires" tests (one per flow with minimal snapshot exercising the trigger)
- 8 "absent" tests (one per flow with empty snapshot — returns `[]`)
- 1 FLOW-01 fixture-assertion test: `for (const ft of FLOW_TYPES) { expect(ft.sourceField ?? ft.sourceFields).toBeDefined(); }`

**`packages/workbench-ui/src/command/source-binding.ts`** — One new re-export block added after existing `PressureFieldName` re-export:

```ts
export type { FlowFieldName } from './flows.js';
```

**`packages/workbench-ui/src/command/source-binding.test.ts`** — Two new narrowing tests added (Test K + Test L) proving `useSourceField<FlowFieldName>` and `useSourceFields<FlowFieldName>` accept all 8 kind literals correctly.

**`packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json`** — Additive 2-field delta on `fanout-005` task:

- `"model": "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"` (fires `tokenFlow`)
- `"podName": "fanout-005-pod"` (fires `podCapacity`)

## Test Output

```
pnpm -C packages/workbench-ui test -- flows.test.ts source-binding.test.ts --run

 Test Files  2 passed (2)
      Tests  38 passed (38)
   Duration  373ms
```

Full suite: 9 test files, 87 tests — all green.

## Deviations from Plan

### Structural Deviation: Pre-commit Hook Forces Joint Commits

**Found during:** Task 1 (RED phase attempt)
**Issue:** The pre-commit hook runs `pnpm -r typecheck` (TypeScript compile across all packages). When `flows.test.ts` imports from `'./flows.js'` which doesn't exist yet, `tsc` reports errors and the hook aborts the commit. Same with `source-binding.test.ts` importing `FlowFieldName` before the re-export is added.
**Fix:** Created a typed stub `flows.ts` (empty `FLOW_TYPES: readonly FlowType[] = []`) in the same commit as `flows.test.ts`. For Task 2, committed `source-binding.ts` implementation in the same commit as the test file. The "RED" state is still observable via the 8 failing vitest assertions (fire tests all fail with empty FLOW_TYPES) and the TypeScript errors before the implementation.
**Impact:** Plan's strict RED→GREEN separate-commit discipline is approximated rather than exact. The RED state is evident: first commit has 8 failing fire tests + a passing empty fixture-assertion (vacuously true on empty FLOW_TYPES). GREEN commit replaces the stub with the full implementation.
**Files modified:** flows.ts (stub → implementation across commits)

### Rule 1 (Bug Fix): exactOptionalPropertyTypes Incompatibility

**Found during:** Task 1 GREEN phase (TypeScript check)
**Issue:** `tsconfig.json` has `exactOptionalPropertyTypes: true`. Setting `capacity: undefined` explicitly violates this — TypeScript TS2375 rejects it because `readonly capacity?: number` means the property should either be absent or have a `number` value.
**Fix:** Replaced all `capacity: undefined` with omitting the property (or using conditional spread `...(cap !== undefined ? { capacity: cap } : {})` for the modelPower case where capacity may be present or absent).
**Files modified:** `packages/workbench-ui/src/command/flows.ts`
**Commit:** 9a84de5

### Minor: flows.test.ts at 295 Lines (plan min_lines: 300)

**Note:** The plan specified `min_lines: 300` for `flows.test.ts`. Actual file is 295 lines (5 short). All 17 required tests are present. The difference is due to prettier's formatting decisions on multi-line test expectations. The test coverage is complete; the line count is a sizing indicator, not a hard requirement.

### taskKey() Helper in flows.ts — Kept But Unused Directly

**Note:** `taskKey()` is defined in `flows.ts` (mirroring `pressure.ts:72–74`) per PATTERNS.md instructions, but the current 8 FLOW_TYPES entries use string literal detail links (e.g., `'#/tasks'`, `'#/gateway'`, `'#/cluster'`) rather than per-task deep links. The helper is kept for future use (buildPower drill-down to per-task URLs). To satisfy TypeScript's no-unused-variable check, a `void taskKey;` was initially added then removed when the cleaner solution was to have `detailLink: (g): string => g.detailLink` in buildPower (uses the gauge's pre-computed link). The helper remains in the file referenced via internal comment for any future per-task detail link needs.

## FLOW-01 Source Binding Coverage

| Flow              | Granularity   | Source Fields            | v0.2 Status                                 |
| ----------------- | ------------- | ------------------------ | ------------------------------------------- |
| modelPower        | perEndpoint   | inFlight, currentCap     | Clean source                                |
| tokenFlow         | perModelClass | model, phase             | v0.2 fallback (task count proxy)            |
| buildPower        | perAgent      | targetAgent, phase       | v0.2 fallback (open-ended count)            |
| podCapacity       | substrateWide | podName, phase           | v0.2 fallback (substrate-wide)              |
| artifactBandwidth | substrateWide | artifactCount, phase     | Clean source                                |
| authority         | substrateWide | error, phase             | v0.2 fallback (error-string match)          |
| trust             | substrateWide | suspicious, error, phase | v0.2 fallback (suspicious + verifier-error) |
| attention         | substrateWide | phase, suspicious        | Phase 4 stub                                |

All 8 entries have `sourceFields` defined — FLOW-01 fixture-assertion test proves this at runtime.

## Known Stubs

**attention flow:** `label: 'awaiting review queue projection — Phase 4'` with `compute()` body using `phase=Failed || suspicious.length > 0` as a proxy. This is an intentional documented stub per CONTEXT.md D-02-attention. Phase 4 will replace only the `compute()` body; the `FlowGauge` shape is unchanged.

**tokenFlow:** Uses task-count-by-model proxy (`unit: 'tasks'`) rather than real token counts. `snapshot.gatewayUsage` IS available on `useCommandSnapshot()` (state.ts:88) — promotion to real per-request counts is a single-PR `compute()` body change. Documented in inline comment.

## Wave 2 Warning

Wave 2 (03-02-PLAN.md) will mount `<FlowOverlay />` in `CommandView.tsx`. The first run after mounting will **FAIL `cc-reload.test.tsx`** because the snapshot no longer matches. This is EXPECTED per RESEARCH.md Pitfall 1. Wave 2's plan explicitly splits:

1. The `<FlowOverlay />` mount commit (which fails cc-reload)
2. The `vitest -u` snapshot regen commit (which fixes cc-reload)

Do NOT attempt to pre-emptively fix cc-reload.test.tsx from Wave 1. The failing snapshot is the reviewer's signal that the new overlay is visible in the reload-stability test.

## Commits

| Hash    | Type | Description                                                                     |
| ------- | ---- | ------------------------------------------------------------------------------- |
| 67d5de9 | test | Add failing flows.test.ts (RED phase — stub flows.ts + all test cases)          |
| 9a84de5 | feat | Implement flows.ts 8 FLOW_TYPES + fixture additive (GREEN phase)                |
| 40a6e3a | test | Add FlowFieldName narrowing tests + source-binding re-export (Task 2 RED+GREEN) |

## Self-Check: PASSED

- [x] `packages/workbench-ui/src/command/flows.ts` exists (322 lines)
- [x] `packages/workbench-ui/src/command/flows.test.ts` exists (295 lines, 17 tests)
- [x] `packages/workbench-ui/src/command/source-binding.ts` has `FlowFieldName` re-export
- [x] `packages/workbench-ui/src/command/source-binding.test.ts` has Test K + Test L
- [x] `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` has `fanout-005-pod`
- [x] All 87 tests pass (9 test files)
- [x] `tsc --noEmit` exits 0
- [x] 3 atomic commits with `phase-03-01` scope
- [x] FLOW-01 fixture-assertion test passes (all 8 flows have source field defined)
