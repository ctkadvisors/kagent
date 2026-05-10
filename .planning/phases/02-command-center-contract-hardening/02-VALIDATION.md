---
phase: 02
slug: command-center-contract-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-10
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from `02-RESEARCH.md` "Validation Architecture" section. The planner is the source of truth for filling in the per-task verification map and Wave 0 task IDs once `*-PLAN.md` files exist.

---

## Test Infrastructure

| Property               | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| **Framework**          | vitest 4.1.4 (jsdom env, `@testing-library/react` 16.3.0) |
| **Config file**        | `packages/workbench-ui/vitest.config.ts`                  |
| **Quick run command**  | `pnpm -C packages/workbench-ui test -- --run`             |
| **Full suite command** | `pnpm -C packages/workbench-ui test -- --run --coverage`  |
| **Estimated runtime**  | ~30s quick / ~60s with coverage                           |

Coverage thresholds: NOT yet configured in `vitest.config.ts` (provider `'v8'`, reporter `['text', 'lcov']`, no `thresholds`). Phase 2 test posture targets ≥85% on `source-binding.ts` (extended) and `pressure.ts` (new), ≥75% on glue code (CommandView panel additions, layout-mapper assertion). Planner may add `thresholds: { lines: 85, ... }` for `source-binding.ts` + `pressure.ts` paths.

---

## Sampling Rate

- **After every task commit:** Run `pnpm -C packages/workbench-ui test -- --run` (~30s, well under the 60s feedback-latency target)
- **After every plan wave:** Run `pnpm -C packages/workbench-ui test -- --run --coverage` (~60s)
- **Before `/gsd-verify-work`:** Full suite + coverage must be green; coverage targets documented above
- **Max feedback latency:** 60 seconds (quick run on commit)

---

## Per-Task Verification Map

> _Filled in by the planner once `02-NN-PLAN.md` files are written. Each plan's `<automated>` block produces one row per task. Rows below are the requirement-level expectations the planner must cover._

| Task ID | Plan | Wave | Requirement                    | Threat Ref | Secure Behavior                                                                                                                    | Test Type | Automated Command                                             | File Exists | Status     |
| ------- | ---- | ---- | ------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------- | ----------- | ---------- |
| TBD     | TBD  | 0    | CC-01..04 (Wave 0 scaffolding) | —          | N/A (test scaffolding only)                                                                                                        | scaffold  | `pnpm -C packages/workbench-ui test -- --run`                 | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 1    | CC-01                          | —          | Orphan agent assertion fires in dev                                                                                                | unit      | `pnpm -C packages/workbench-ui test -- --run source-binding`  | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 1    | CC-01                          | —          | Orphan assertion is no-op in `NODE_ENV=production`                                                                                 | unit      | same as above                                                 | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 1    | CC-01                          | —          | Canvas-side orphan assertion in `agentNodes useMemo` (CommandView lines 175-201, fires before `computeLayout`)                     | unit      | `pnpm -C packages/workbench-ui test -- --run cc-orphan`       | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 1    | CC-04                          | —          | All 9 pressure types fire when source data is present (per type)                                                                   | unit      | `pnpm -C packages/workbench-ui test -- --run pressure`        | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 1    | CC-04                          | —          | All 9 pressure types do NOT fire when source data is absent (per type)                                                             | unit      | same as above                                                 | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 2    | CC-03                          | —          | `AgentPanel` renders capabilities/modelClass/active-tasks/recent-failures with `data-source-field`                                 | unit      | `pnpm -C packages/workbench-ui test -- --run AgentPanel`      | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 2    | CC-03                          | —          | `TaskPanel` renders timestamps/suspicious/verifier/trace-link/artifact-count/parent-child with `data-source-field`                 | unit      | `pnpm -C packages/workbench-ui test -- --run TaskPanel`       | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 2    | CC-03                          | —          | `GatewayPanel` renders capacity rows with `data-source-fields` + "Open in GatewayPage →" deep-link                                 | unit      | `pnpm -C packages/workbench-ui test -- --run GatewayPanel`    | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 2    | CC-04                          | —          | `PressureOverlay` renders markers with `data-source-field` + reads `pressureDramatization` flag (subdued mode keeps same data)     | snapshot  | `pnpm -C packages/workbench-ui test -- --run PressureOverlay` | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 3    | CC-02                          | —          | Reload-stability DOM snapshot matches across mount → unmount → re-mount with same fixture                                          | snapshot  | `pnpm -C packages/workbench-ui test -- --run cc-reload`       | ❌ W0       | ⬜ pending |
| TBD     | TBD  | 3    | CC-02                          | —          | Reload-stability scene-graph (`computeLayout` output, serialized via `Array.from(layout.agents.entries())`) matches across reloads | snapshot  | same as above                                                 | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

> **Note on `Map` serialization (CC-02):** `LayoutResult.agents` is a `Map`, not JSON-serializable by default. Tests must use `Object.fromEntries(layout.agents)` or `Array.from(layout.agents.entries())`. The planner enforces this in the test file (per RESEARCH §"Pitfalls").

---

## Wave 0 Requirements

> Scaffolding tasks the planner MUST schedule before any implementation task can land.

- [ ] `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` — CC-02 fixture (captured `/api/agents` + `/api/tasks` + `/api/gateway/capacity` + `/api/dispositions`; mix of phases, ≥1 over-budget pressure case, ≥1 gateway saturation case). Hand-craft acceptable for v0.2 if dev workbench-api is not running.
- [ ] `packages/workbench-ui/src/command/pressure.ts` — skeleton with `PressureMarker` interface, `PressureType` interface, empty `PRESSURE_TYPES` array exported. MIT license header. Strict-typed. Implementation populated wave-by-wave or in a single Wave 1 task.
- [ ] `packages/workbench-ui/src/command/pressure.test.ts` — vitest stub with the 9 per-type scenarios (present + absent), all initially `it.todo` so the test file passes Wave 0.
- [ ] `packages/workbench-ui/src/command/PressureOverlay.tsx` — skeleton component (renders `null` until `classify()` + JSX implemented). MIT license header. Mirrors `DispositionOverlay.tsx` shape.
- [ ] `packages/workbench-ui/src/command/PressureOverlay.test.tsx` — vitest stub mirroring `DispositionOverlay.test.tsx`; initial `it.todo` placeholders for snapshot + source-binding tests.
- [ ] `packages/workbench-ui/src/command/PressureOverlay.module.css` — empty placeholder so the import resolves.
- [ ] (Optional) Extend `packages/workbench-ui/vitest.config.ts` with `coverage.thresholds` covering `source-binding.ts` + `pressure.ts` at 85% lines and glue at 75%. Planner discretion.

If any of these scaffolds is not in place when CC-01..04 task verification runs, the assertion that `File Exists` flips from `❌ W0` to `✅` is itself a Wave 0 gate.

---

## Manual-Only Verifications

| Behavior                                                                                                                   | Requirement                       | Why Manual                                                                       | Test Instructions                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual review of `pressureDramatization=false` "base-building-only" mode (subdued styling keeps same data, no dramatic FX) | CC-04                             | jsdom does not render CSS — visual subduing is observable in a real browser only | After Wave 2/3 ships, run `VITE_PRESSURE_DRAMATIZATION=false pnpm -C packages/workbench-ui dev`, navigate to `#/command`, confirm pressure markers render but visual treatment is subdued (no pulsing/flashing). Compare against `VITE_PRESSURE_DRAMATIZATION=true` (default) — same markers, same data, different visuals. |
| ArgoCD overlay bump for the rebuilt workbench-ui image                                                                     | (release; not Phase-2 acceptance) | GitOps deploy is owned by `../new_localai/`; not part of this repo's vitest gate | After phase merges and image is built, follow CLAUDE.md "GitOps only on the homelab cluster" — bump the workbench-ui image tag in `../new_localai/` and let ArgoCD deploy. Phase verification does NOT require this; it's release-side, not Phase-2 acceptance.                                                             |

All four phase requirements (CC-01..04) have automated verification via vitest. The two manual rows above are explicitly out of the phase's automated gate but documented here so they aren't lost.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies (planner enforces in `02-NN-PLAN.md`)
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all `❌ W0` references in the per-task map
- [ ] No watch-mode flags in any automated command (all use `--run`)
- [ ] Feedback latency < 60s on quick run; < 90s with coverage
- [ ] `nyquist_compliant: true` set in frontmatter once planner has filled the per-task map and the executor has shipped Wave 0

**Approval:** pending — flips to `approved YYYY-MM-DD` after the plan-checker accepts the per-task map this file references and Wave 0 scaffolds land in HEAD.
