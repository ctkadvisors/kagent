---
phase: 3
slug: resource-flow-overlays
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-10
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `.planning/phases/03-resource-flow-overlays/03-RESEARCH.md` §Validation Architecture

---

## Test Infrastructure

| Property               | Value                                                                            |
| ---------------------- | -------------------------------------------------------------------------------- |
| **Framework**          | vitest 2.x (per `packages/workbench-ui/package.json`)                            |
| **Config file**        | `packages/workbench-ui/vitest.config.ts` (existing — no change needed)           |
| **Quick run command**  | `pnpm -C packages/workbench-ui test -- flows.test.ts FlowOverlay.test.tsx --run` |
| **Full suite command** | `pnpm -C packages/workbench-ui test -- --run`                                    |
| **Estimated runtime**  | quick ~5–10s; full ~30–60s                                                       |

---

## Sampling Rate

- **After every task commit:** Run `pnpm -C packages/workbench-ui test -- flows.test.ts FlowOverlay.test.tsx --run`
- **After every plan wave:** Run `pnpm -C packages/workbench-ui test -- --run`
- **Before `/gsd-verify-work`:** Full suite must be green; `docs/FLOW-LEGEND.md` must exist with 8 flow sections
- **Max feedback latency:** ~10s (quick), ~60s (full)

---

## Per-Task Verification Map

| Task ID  | Plan            | Wave | Requirement | Threat Ref | Secure Behavior                                      | Test Type   | Automated Command                                                                         | File Exists | Status     |
| -------- | --------------- | ---- | ----------- | ---------- | ---------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- | ----------- | ---------- |
| 03-XX-01 | flows-module    | 1    | FLOW-01     | —          | every flow has non-null source field                 | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "non-null source" --run`          | ❌ W0       | ⬜ pending |
| 03-XX-02 | flows-module    | 1    | FLOW-01     | —          | each `compute()` fires on positive fixture           | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "fires" --run`                    | ❌ W0       | ⬜ pending |
| 03-XX-03 | flows-module    | 1    | FLOW-01     | —          | each `compute()` empty on absent data                | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "empty" --run`                    | ❌ W0       | ⬜ pending |
| 03-XX-04 | overlay-render  | 2    | FLOW-01     | —          | `data-source-field(s)` DOM attributes present        | integration | `pnpm -C packages/workbench-ui test -- FlowOverlay.test.tsx -t "data-source" --run`       | ❌ W0       | ⬜ pending |
| 03-XX-05 | overlay-render  | 2    | FLOW-01     | —          | `pressureDramatization` swap (dramatic↔subdued)      | integration | `pnpm -C packages/workbench-ui test -- FlowOverlay.test.tsx -t "dramatic\|subdued" --run` | ❌ W0       | ⬜ pending |
| 03-XX-06 | mount-cv        | 2    | FLOW-01     | —          | `<FlowOverlay/>` mounts in CommandView               | integration | `pnpm -C packages/workbench-ui test -- cc-reload.test.tsx --run`                          | ✓ (regen)   | ⬜ pending |
| 03-XX-07 | snapshot-regen  | 2    | FLOW-01     | —          | reload-stability snapshot equals across remount      | integration | `pnpm -C packages/workbench-ui test -- cc-reload.test.tsx --run`                          | ✓           | ⬜ pending |
| 03-XX-08 | source-bind-ext | 1    | FLOW-01     | —          | `FlowFieldName` narrows in `assertSourceField/s`     | unit        | `pnpm -C packages/workbench-ui test -- source-binding.test.ts --run`                      | ✓ (extend)  | ⬜ pending |
| 03-XX-09 | flow-legend-doc | 1    | FLOW-02     | —          | `docs/FLOW-LEGEND.md` exists, references constraints | manual      | `test -f docs/FLOW-LEGEND.md && grep -q 'C-flow-economy' docs/FLOW-LEGEND.md`             | ❌ W1       | ⬜ pending |
| 03-XX-10 | flow-legend-doc | 1    | FLOW-02     | —          | 8 flow sections present in legend                    | manual      | `[ "$(grep -c '^## ' docs/FLOW-LEGEND.md)" -ge 8 ]`                                       | ❌ W1       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

_Note: Task IDs above are placeholders (`XX`); the planner finalizes plan-id and per-task IDs in PLAN.md frontmatter. The mapping of behavior → automated command is the binding part._

---

## Wave 0 Requirements

- [ ] `packages/workbench-ui/src/command/flows.ts` — covers FLOW-01 (8 entries + closed-enum)
- [ ] `packages/workbench-ui/src/command/FlowOverlay.tsx` — covers FLOW-01 (rendering + source-binding + dramatic/subdued)
- [ ] `packages/workbench-ui/src/command/FlowOverlay.module.css` — covers FLOW-01 (visual treatment)
- [ ] `packages/workbench-ui/src/command/flows.test.ts` — covers FLOW-01 (16 + 1 fixture-assert minimum tests)
- [ ] `packages/workbench-ui/src/command/FlowOverlay.test.tsx` — covers FLOW-01 (4 render/dramatization tests)
- [ ] Extension to `packages/workbench-ui/src/command/source-binding.ts` (line ~112 — add `FlowFieldName` re-export)
- [ ] Extension to `packages/workbench-ui/src/command/source-binding.test.ts` — covers FLOW-01 type narrowing
- [ ] Extension to `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` — covers FLOW-01 fixture-fires + reload-stability
- [ ] `<FlowOverlay />` mount in `packages/workbench-ui/src/CommandView.tsx`
- [ ] Snapshot regen of `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap` (intentional `vitest -u` after FlowOverlay mounts)
- [ ] `docs/FLOW-LEGEND.md` — covers FLOW-02 (developer-facing legend)
- [ ] (OPTIONAL, separate commit) Reference link in `docs/COMMAND-CENTER-CONTRACT.md` references — discoverability for FLOW-02

**Framework install:** None — vitest 2.x already present, no new test infrastructure required.

---

## Per-Dimension Mapping (Nyquist 8)

| Dim | Name                  | Phase 3 Concrete Test/Assertion                                                                                                                                                                                                                                      |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Functional            | `flows.test.ts` 16 tests (8 fires + 8 empty); `FlowOverlay.test.tsx` 4 tests (render + dramatic + subdued + reload-stability)                                                                                                                                        |
| D2  | Structural            | TypeScript strict-compile: `FlowFieldName = FlowType['kind']` derived enum; `FlowGauge`/`FlowType` interfaces enforce shape. `tsc --noEmit` clean across the workbench-ui package.                                                                                   |
| D3  | Data integrity        | FLOW-01 fixture-assertion: `for (const ft of FLOW_TYPES) { expect(ft.sourceField ?? ft.sourceFields).toBeDefined(); }` — proves every flow has a non-null source-field reference. Plus `data-source-field(s)` DOM attribute coverage on every rendered gauge.        |
| D4  | Interface contract    | `source-binding.test.ts` extension: `assertSourceField<FlowFieldName>` narrows correctly; `assertSourceFields<FlowFieldName>` accepts arrays of FlowFieldName. CC-01 dev-orphan-assertion (existing) catches any synthesized fixture row that lacks a backing field. |
| D5  | Regression            | `cc-reload.test.tsx` re-runs with the regenerated snapshot — proves no UI-only state survives reload. `cc-orphan.test.ts` (existing) stays green. `pressure.test.ts` + `PressureOverlay.test.tsx` (existing) stay green — Phase 3 is additive, not modifying.        |
| D6  | Performance (bounded) | `compute()` is O(snapshot size) per render and runs only on snapshot change (useMemo dep array). FlowOverlay is `<aside>` + ~8×~3 anchors = ~25 DOM nodes worst case; no canvas, no animation loop. UI render only — no load-test required at v0.2 scale.            |
| D7  | Security              | N/A — pure read-side UI. No new auth surface, no new write surface, no new secrets. Source-binding contract (D7) is the relevant integrity check; covered under D3+D4 above.                                                                                         |
| D8  | Validation harness    | `pnpm -C packages/workbench-ui test -- --run` is the single command. Vitest CI run is the auditable surface. Snapshot file in git is the diff-reviewable artifact. No new harness needed.                                                                            |

---

## Manual-Only Verifications

| Behavior                                                                                       | Requirement | Why Manual                                                 | Test Instructions                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/FLOW-LEGEND.md` content quality (per-flow paragraphs read clearly)                       | FLOW-02     | Prose quality is judgment                                  | Reviewer reads each of 8 sections; checks for: substrate source field cited, pressure trigger cited, operator action stated, v0.2 fallback noted (where applicable), promotion path stated. |
| Workbench dev-server visual sanity (`pnpm -C packages/workbench-ui dev` + open Command Center) | FLOW-01     | Visual readability is judgment; jsdom doesn't paint pixels | Operator opens Command Center; confirms 8 flow sections visible, gauges render with current values, `VITE_PRESSURE_DRAMATIZATION=false` mutes the visual treatment without changing data.   |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s (full); < 10s (quick)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
