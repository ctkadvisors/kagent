<!--
  SPDX-License-Identifier: MIT
  Copyright (c) 2026 Chris Knuteson
-->

---

phase: 02
slug: command-center-contract-hardening
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-10
updated: 2026-05-10

---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Per-task `Task ID` / `Plan` columns now reference the four `02-NN-PLAN.md` files. Wave 0 scaffolds land in 02-01; Wave 1 logic in 02-02; Wave 2 panels + overlay in 02-03; Wave 3 reload-stability test in 02-04.

---

## Test Infrastructure

| Property               | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| **Framework**          | vitest 4.1.4 (jsdom env, `@testing-library/react` 16.3.0) |
| **Config file**        | `packages/workbench-ui/vitest.config.ts`                  |
| **Quick run command**  | `pnpm -C packages/workbench-ui test -- --run`             |
| **Full suite command** | `pnpm -C packages/workbench-ui test -- --run --coverage`  |
| **Estimated runtime**  | ~30s quick / ~60s with coverage                           |

Coverage thresholds: NOT yet configured in `vitest.config.ts` (provider `'v8'`, reporter `['text', 'lcov']`, no `thresholds`). Phase 2 test posture targets ≥85% on `source-binding.ts` (extended) and `pressure.ts` (new), ≥75% on glue code (CommandView panel additions, layout-mapper assertion). Planner may add `thresholds: { lines: 85, ... }` for `source-binding.ts` + `pressure.ts` paths — left as Claude's Discretion in CONTEXT.md and not enforced in any plan.

---

## Sampling Rate

- **After every task commit:** Run `pnpm -C packages/workbench-ui test -- --run` (~30s, well under the 60s feedback-latency target)
- **After every plan wave:** Run `pnpm -C packages/workbench-ui test -- --run --coverage` (~60s)
- **Before `/gsd-verify-work`:** Full suite + coverage must be green; coverage targets documented above
- **Max feedback latency:** 60 seconds (quick run on commit)

---

## Per-Task Verification Map

| Task ID      | Plan  | Wave | Requirement                                               | Threat Ref       | Secure Behavior                                                                                                 | Test Type | Automated Command                                                      | File Exists | Status     |
| ------------ | ----- | ---- | --------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------- | ----------- | ---------- |
| 02-01 Task 1 | 02-01 | 0    | CC-01..04 (source-binding.ts widening + new closed enums) | T-02-04          | Adds 4 new closed enums + generic helpers; existing Tests 1-10 still green                                      | unit      | `pnpm -C packages/workbench-ui test -- --run source-binding`           | ❌ W0       | ⬜ pending |
| 02-01 Task 2 | 02-01 | 0    | CC-04 (pressure.ts/.test.ts + PressureOverlay scaffolds)  | T-02-01, T-02-02 | Skeleton modules with it.todo placeholders; tsc clean                                                           | scaffold  | `pnpm -C packages/workbench-ui test -- --run pressure PressureOverlay` | ❌ W0       | ⬜ pending |
| 02-01 Task 3 | 02-01 | 0    | CC-01, CC-02 (cc-orphan + cc-reload + fixture)            | T-02-01          | Skeleton tests + cc-snapshot.json with all 9 pressure-trigger scenarios                                         | scaffold  | `pnpm -C packages/workbench-ui test -- --run cc-orphan cc-reload`      | ❌ W0       | ⬜ pending |
| 02-02 Task 1 | 02-02 | 1    | CC-01 (canvas-orphan assertion in CommandView.tsx)        | T-02-07          | assertCanvasOrphan throws in dev when task targets a missing agent key; no-op in prod                           | unit      | `pnpm -C packages/workbench-ui test -- --run cc-orphan`                | ❌ W0       | ⬜ pending |
| 02-02 Task 1 | 02-02 | 1    | CC-01 (production no-op for orphan assertion)             | T-02-07          | Orphan assertion is no-op in `NODE_ENV=production`                                                              | unit      | `pnpm -C packages/workbench-ui test -- --run cc-orphan`                | ❌ W0       | ⬜ pending |
| 02-02 Task 2 | 02-02 | 1    | CC-04 (PRESSURE_TYPES populated with 9 entries; 18 tests) | T-02-05, T-02-06 | All 9 pressure types fire / do-not-fire correctly per synthesized snapshots                                     | unit      | `pnpm -C packages/workbench-ui test -- --run pressure`                 | ❌ W0       | ⬜ pending |
| 02-03 Task 1 | 02-03 | 2    | CC-04 (PressureOverlay full JSX + mount in CommandView)   | T-02-05, T-02-06 | PressureOverlay renders markers with data-source-field(s); pressureDramatization toggles dramatic/subdued class | snapshot  | `pnpm -C packages/workbench-ui test -- --run PressureOverlay`          | ❌ W0       | ⬜ pending |
| 02-03 Task 2 | 02-03 | 2    | CC-03 (AgentPanel additions)                              | T-02-08, T-02-11 | AgentPanel renders capabilities/modelClass/active-tasks/recent-failures with `data-source-field(s)`             | unit      | `pnpm -C packages/workbench-ui test -- --run`                          | ❌ W0       | ⬜ pending |
| 02-03 Task 2 | 02-03 | 2    | CC-03 (TaskPanel additions)                               | T-02-08          | TaskPanel renders timestamps/suspicious/artifact-count/child-count with `data-source-field`                     | unit      | `pnpm -C packages/workbench-ui test -- --run`                          | ❌ W0       | ⬜ pending |
| 02-03 Task 2 | 02-03 | 2    | CC-03 (GatewayPanel additions)                            | T-02-10          | GatewayPanel renders capacity rows with `data-source-fields` + "Open in GatewayPage →" deep-link                | unit      | `pnpm -C packages/workbench-ui test -- --run`                          | ❌ W0       | ⬜ pending |
| 02-04 Task 1 | 02-04 | 3    | CC-02 (DOM reload-stability)                              | T-02-12, T-02-14 | Mount → unmount → fresh-remount with same fixture: DOM snapshot matches across reloads                          | snapshot  | `pnpm -C packages/workbench-ui test -- --run cc-reload`                | ❌ W0       | ⬜ pending |
| 02-04 Task 1 | 02-04 | 3    | CC-02 (scene-graph reload-stability)                      | T-02-12, T-02-14 | Scene-graph (`computeLayout` output, serialized via `Object.fromEntries(layout.agents)`) matches across reloads | snapshot  | `pnpm -C packages/workbench-ui test -- --run cc-reload`                | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

> **Note on `Map` serialization (CC-02):** `LayoutResult.agents` and `LayoutResult.factions` are `ReadonlyMap`, not JSON-serializable by default. 02-04-PLAN.md Task 1 uses `Object.fromEntries(layout.agents)` and `Object.fromEntries(layout.factions)` per RESEARCH.md Open Question 3.

> **Note on Date.now() determinism (CC-02 + AgentPanel failure counters + telemetry pressure):** 02-04-PLAN.md Task 1 uses `vi.useFakeTimers()` + `vi.setSystemTime(new Date('2026-05-10T12:00:00Z'))` so the per-render Date.now() reads in AgentPanel and pressure.ts produce stable results across the two mount cycles.

---

## Wave 0 Requirements

> Scaffolding tasks the planner MUST schedule before any implementation task can land. All covered by 02-01-PLAN.md.

- [x] `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` — covered by 02-01 Task 3
- [x] `packages/workbench-ui/src/command/pressure.ts` — covered by 02-01 Task 2
- [x] `packages/workbench-ui/src/command/pressure.test.ts` — covered by 02-01 Task 2 (18 it.todo placeholders)
- [x] `packages/workbench-ui/src/command/PressureOverlay.tsx` — covered by 02-01 Task 2
- [x] `packages/workbench-ui/src/command/PressureOverlay.test.tsx` — covered by 02-01 Task 2 (4 it.todo placeholders)
- [x] `packages/workbench-ui/src/command/PressureOverlay.module.css` — covered by 02-01 Task 2
- [x] Source-binding.ts new closed-enum types (AgentSummaryFieldName, TaskSummaryFieldName, GatewayCapacityFieldName, PressureFieldName) — covered by 02-01 Task 1
- [x] `packages/workbench-ui/src/command/cc-orphan.test.ts` — covered by 02-01 Task 3
- [x] `packages/workbench-ui/src/command/cc-reload.test.tsx` — covered by 02-01 Task 3
- [ ] (Optional) Extend `packages/workbench-ui/vitest.config.ts` with `coverage.thresholds` — left as Claude's Discretion; not enforced

After 02-01 ships, every `❌ W0` cell in the per-task map flips to `✅` (the file exists; the test is a placeholder until Wave 1+).

---

## Manual-Only Verifications

| Behavior                                                                                                                   | Requirement                       | Why Manual                                                                       | Test Instructions                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual review of `pressureDramatization=false` "base-building-only" mode (subdued styling keeps same data, no dramatic FX) | CC-04                             | jsdom does not render CSS — visual subduing is observable in a real browser only | After 02-03 ships, run `VITE_PRESSURE_DRAMATIZATION=false pnpm -C packages/workbench-ui dev`, navigate to `#/command`, confirm pressure markers render but visual treatment is subdued. Compare against `VITE_PRESSURE_DRAMATIZATION=true` (default) — same markers, same data, different visuals. |
| ArgoCD overlay bump for the rebuilt workbench-ui image                                                                     | (release; not Phase-2 acceptance) | GitOps deploy is owned by `../new_localai/`; not part of this repo's vitest gate | After phase merges and image is built, follow CLAUDE.md "GitOps only on the homelab cluster" — bump the workbench-ui image tag in `../new_localai/` and let ArgoCD deploy. Phase verification does NOT require this; it's release-side, not Phase-2 acceptance.                                    |

All four phase requirements (CC-01..04) have automated verification via vitest. The two manual rows above are explicitly out of the phase's automated gate but documented here so they aren't lost.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (planner enforces in `02-NN-PLAN.md`)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all `❌ W0` references in the per-task map (via 02-01-PLAN.md Tasks 1, 2, 3)
- [x] No watch-mode flags in any automated command (all use `--run`)
- [x] Feedback latency < 60s on quick run; < 90s with coverage
- [x] `nyquist_compliant: true` set in frontmatter — per-task map is fully populated; 02-01 Task IDs cover every Wave-0 file gap

**Approval:** pending — flips to `approved YYYY-MM-DD` after the plan-checker accepts the per-task map this file references and Wave 0 scaffolds land in HEAD.
