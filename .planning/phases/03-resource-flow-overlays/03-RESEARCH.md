## RESEARCH COMPLETE

# Phase 3: Resource-flow overlays — Research

**Researched:** 2026-05-10
**Domain:** Workbench UI presentation-layer derivation of `C-flow-economy` flows in Command Center
**Confidence:** HIGH (every claim verified against the actual current code; Phase 2 patterns are shipping and tested)

## Summary

Phase 3 GENERALIZES the Phase 2 `pressure.ts` / `PressureOverlay.tsx` shape from binary "fired/didn't" markers into continuous gauges for the eight `C-flow-economy` flows. There is no new module pattern, no new substrate primitive, no new endpoint, no new env var — every piece either already ships in Phase 1+2 (`source-binding.ts`, `useCommandSnapshot()`, `cc-snapshot.json` fixture, `cc-reload.test.tsx`, `VITE_PRESSURE_DRAMATIZATION` flag) or is a 1:1 mirror of an existing file with the noun changed from "pressure" to "flow".

The single significant finding from this research is that **CONTEXT.md D-02-tokenFlow's premise that `GatewayUsageRow` "lives on `/api/gateway/usage`, NOT on the snapshot today" is stale** — `useCommandSnapshot()` already exposes `gatewayUsage: readonly GatewayUsageRow[]` on the snapshot (state.ts:88, 226; api.ts:194). The planner can therefore implement `tokenFlow` as a real per-model `inputTokens + outputTokens` sum rather than the documented v0.2 `task-count × model` proxy, without expanding the substrate's primitive surface. This is the only material divergence from CONTEXT.md; the other four v0.2 fallbacks (buildPower, podCapacity, authority, trust, attention) are correctly bounded and should be implemented as specified.

**Primary recommendation:** Treat `pressure.ts` (319 lines) and `PressureOverlay.tsx` (77 lines) as the line-by-line template for `flows.ts` and `FlowOverlay.tsx`. Mirror them, including the closed-enum-from-array pattern (pressure.ts:319), the per-entry leading comment style (pressure.ts:201–310), the `useMemo` over snapshot in the overlay (PressureOverlay.tsx:45–48), the conditional spread for `data-source-field`/`data-source-fields` (PressureOverlay.tsx:66–67), and the dramatic/subdued CSS class swap (PressureOverlay.tsx:62–64; PressureOverlay.module.css:52–87). Only deviate where flow semantics genuinely differ from pressure semantics: gauges always render (vs markers fired/didn't) and may carry `value`/`capacity`/`unit` (markers do not).

## Architectural Responsibility Map

Phase 3 is single-tier work — every capability lives in the **Browser / Client (workbench-ui SPA)** tier. No backend, no operator, no CRD changes.

| Capability                        | Primary Tier             | Secondary Tier | Rationale                                                                                                                                  |
| --------------------------------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Flow classification (`compute`)   | Browser / Client         | —              | Pure function over the existing `CommandSnapshot`; no I/O, no persistence. Same tier as Phase 2's `pressure.ts` `classify`.                |
| Flow rendering (gauges)           | Browser / Client         | —              | `<aside>` + `<ul>/<li>/<a>` per row, same DOM as `PressureOverlay`. CSS-module-driven; no canvas, no Three.js.                             |
| Source-binding type extension     | Browser / Client         | —              | New `FlowFieldName` closed-enum re-exported from `flows.ts` via `source-binding.ts` mirror of `pressure.ts:319` → `source-binding.ts:112`. |
| Test fixture extension            | Browser / Client (tests) | —              | Additive rows in `cc-snapshot.json`; no new fixture files.                                                                                 |
| Developer docs (`FLOW-LEGEND.md`) | Repo / Docs              | —              | Markdown-only; no UI chrome, no on-canvas legend.                                                                                          |
| Snapshot regeneration             | Browser / Client (tests) | —              | `vitest -u` against `cc-reload.test.tsx.snap` after FlowOverlay first mounts.                                                              |

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01-A: Flow shape — new `FlowOverlay` with continuous gauges (sibling to `PressureOverlay`).** New `packages/workbench-ui/src/command/flows.ts` + `FlowOverlay.tsx`. Mirror `pressure.ts` interface shape exactly (`FlowGauge` + `FlowType` + `FLOW_TYPES` + `compute()` instead of `classify()`). Closed-enum `FlowFieldName = FlowType['kind']`. Each rendered gauge carries `data-source-field` (single) or `data-source-fields` (comma-joined for computed). When `compute()` returns empty, render a "—" stub row so all 8 flows are always visible.
- **D-02-A: Source gaps — TaskSummary-style fallbacks + documented promotion paths.** Per-flow source bindings as enumerated in CONTEXT.md D-02-modelPower..attention. Inline `flows.ts` comment per entry naming ideal source + future promotion phase, mirroring `pressure.ts` lines 201–310. **Researcher note (see Finding 1 below):** the `tokenFlow` fallback assumption that `gatewayUsage` is not on the snapshot is stale — the snapshot already exposes it. Planner should still respect the locked D-02-tokenFlow decision (task-count proxy with `unit='tasks'`), but a follow-up gray area exists if the operator wants to promote to real tokens now. Default: ship as locked.
- **D-03-A: Flow legend — `docs/FLOW-LEGEND.md` + module-level comments in `flows.ts`.** Two surfaces. Doc has 8-row table + per-flow section. Inline comments mirror `pressure.ts` per-entry style. NOT in main UI chrome (no on-canvas legend, no tooltip, no "?" button). Doc linked from `COMMAND-CENTER-CONTRACT.md` references section in a separate doc-update commit (NOT a contract revision).
- **D-04-A: Base-only mode — single global `VITE_PRESSURE_DRAMATIZATION` flag covers flows too.** Flag name stays `VITE_PRESSURE_DRAMATIZATION`. `FlowOverlay` reads `pressureDramatization` prop with default `true`, plumbed from CommandView.tsx line 95–97. Subdued CSS class swap mirrors `pressureMarker` / `pressureMarkerSubdued` pair (PressureOverlay.module.css:52–87).
- **D-05-A: Granularity — per-flow natural granularity (mixed; not uniform).** modelPower=perEndpoint; tokenFlow=perModelClass; buildPower=perAgent; podCapacity=substrateWide (v0.2 fallback); artifactBandwidth/authority/trust/attention=substrateWide. ~13–25 gauges total in v0.2 homelab. Layout: gauges grouped by flow kind, one section per flow with header, gauges stacked within each section. Empty-state rows render placeholder `value=0`, `capacity=undefined`, `label='no <flow> source data'` — silence is data.

### Claude's Discretion

- Exact file structure for `flows.ts` (single file vs `flows/index.ts` + per-kind modules — default single file, mirrors `pressure.ts`).
- Exact JSX layout of `FlowOverlay` (vertical bar / horizontal bar / spark / readout-only when capacity is undefined). Recommended: thin horizontal bar + readout-overlay, mirroring `PressureOverlay`'s row pattern.
- CSS module split (`FlowOverlay.module.css` per section, or share with `PressureOverlay.module.css`). Recommended: separate file per Phase 2's pattern.
- Snapshot fixture additions exact content (planner extends `cc-snapshot.json` with enough rows to fire all 8 flows; current fixture already covers 9 pressure types).
- Whether to add `streamLastEventAt` style snapshot fields for the 4 gap flows now (default: defer per D-02; revisit if a flow's v0.2 fallback is unusable).
- Whether `flows.ts` exports a helper like `getAllGauges(snapshot): readonly FlowGauge[]` for shared consumers, or each consumer iterates `FLOW_TYPES.flatMap(ft => ft.compute(snapshot))` inline (mirror `PressureOverlay.tsx` line 46).
- Exact wording in `docs/FLOW-LEGEND.md` per-flow sections; ASCII gauge sample is welcomed but not required.
- Where to mount `<FlowOverlay />` in CommandView.tsx — alongside `<PressureOverlay />` is the natural sibling site (default: directly after PressureOverlay, lines 1410–1413).
- Whether to add a CI lint that grep-asserts every entry in `FLOW_TYPES` has a corresponding `## <Flow>` section in `docs/FLOW-LEGEND.md` (default: defer; add when there's a real-world drift).

### Deferred Ideas (OUT OF SCOPE)

- `/api/flows` workbench-api projection.
- `FlowRecord` CRD or substrate-emitted flow DTOs.
- Adding `GatewayUsageRow` to the snapshot for real per-request token-flow data — but see Finding 1: `gatewayUsage` is already on the snapshot. The locked D-02-tokenFlow decision still defers using it; promotion is a separate gray area.
- Adding `pilotEvidence` to `TaskSummary` for real verifier/trust data.
- Real review-queue projection for the `attention` flow — Phase 4 owns this.
- Adding `ClusterSnapshot` data to the snapshot for real per-node `podCapacity` gauges.
- Per-faction overlay aggregation.
- Per-flow-type dramatization toggles.
- On-canvas legend tooltip / sidebar key / "?" button on FlowOverlay.
- CI lint that grep-asserts `FLOW_TYPES` ↔ `FLOW-LEGEND.md` sync.
- Generalizing source-binding to OTHER Workbench surfaces (TaskList, TaskDetail, GatewayPage, ClusterPage).
- Modifying `docs/COMMAND-CENTER-CONTRACT.md` §6 to enumerate the 8 flows inline.

## Phase Requirements

| ID      | Description (from REQUIREMENTS.md §1)                                                                                                                                                                                                        | Research Support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLOW-01 | "Each of the eight `C-flow-economy` flows … is rendered as a Command Center overlay with a documented source field and pressure trigger from existing DTOs. A test fixture asserts each flow has a non-null source field reference."         | (a) `flows.ts` `FLOW_TYPES` array — 8 entries, each declares `sourceField` or `sourceFields` derived from the actual `CommandSnapshot` shape verified in Findings 1+5. (b) `flows.test.ts` `for (const ft of FLOW_TYPES) { expect(ft.sourceField ?? ft.sourceFields).toBeDefined(); }` enforces "non-null source field reference" at vitest level. (c) `FlowOverlay.tsx` carries `data-source-field`/`data-source-fields` DOM attributes per `PressureOverlay.tsx:66–67` pattern. (d) Per-instance `compute()`-fires/`compute()`-empty test pairs mirror Phase 2's 9×2 pattern (pressure.test.ts:73–367) → 8×2 = 16 minimum tests. |
| FLOW-02 | "A 'flow legend' exists in developer docs (NOT in main UI chrome per `COMMAND-CENTER-CONTRACT.md` Slice E acceptance) mapping each flow to its substrate source, pressure trigger, and operator action. Living doc updated as flows evolve." | New `docs/FLOW-LEGEND.md` per D-03-A with 8-row table + per-flow section; cross-linked from `docs/COMMAND-CENTER-CONTRACT.md` references in a separate doc-update commit. Inline `flows.ts` per-entry leading comments mirror `pressure.ts:201–310` pattern so the source-of-truth lives next to the code. Slice E "legend in developer docs, NOT in main UI chrome" (`COMMAND-CENTER-CONTRACT.md:255`) is honored — no on-canvas tooltip, no sidebar key, no "?" button.                                                                                                                                                          |

## Project Constraints (from CLAUDE.md)

The following directives from `./CLAUDE.md` are binding for Phase 3. The planner MUST honor each as if locked in CONTEXT.md.

- **TypeScript primary, strict mode, ESM, Node 22 target.** All new files (`flows.ts`, `FlowOverlay.tsx`, `flows.test.ts`, `FlowOverlay.test.tsx`, `FlowOverlay.module.css`) are TypeScript ESM modules. `tsx` is the runtime; no Bun.
- **MIT license header on every `.ts` source file.** Every new `.ts`/`.tsx` file gets the SPDX header. Phase 1+2 pattern (see `pressure.ts:1–4`):
  ```ts
  /**
   * SPDX-License-Identifier: MIT
   * Copyright (c) 2026 Chris Knuteson
   */
  ```
- **Conventional commits, NO squash-on-merge.** Phase 3 commits use `feat(phase-03-XX): …` / `fix(phase-03-XX): …` / `docs(phase-03-XX): …`. Each task is an atomic commit per `/gsd-execute-phase` enforcement.
- **D7 binding: `docs/COMMAND-CENTER-CONTRACT.md`.** Every rendered gauge MUST map back to a substrate source field. The dev-only orphan assertion (CC-01, Phase 2) — already throws on any rendered field that doesn't carry `data-source-field` and a key that resolves on the snapshot — extends automatically to flows because `FlowFieldName` joins the closed-enum union.
- **GitOps only on the homelab cluster — never `kubectl apply/exec/port-forward`.** Phase 3 has zero cluster touches. Verification IS vitest. Deployment (when the planner ships) is the workbench-ui Docker image rebuild + ArgoCD overlay bump in `../new_localai/` (separate, non-Phase-3 scope).
- **Pre-commit hook needs Node 22.** `source ~/.nvm/nvm.sh && nvm use 22` if the machine default has drifted to Node 23+. Documented in Phase 1+2 SUMMARY.md files.
- **`gh pr create` and `gh pr merge` are NOT a unit.** Auto-push branches+tags is the default per memory `feedback_auto_push.md`, but PR merges require per-PR explicit consent.
- **No new CRD, no new reconciler, no new workbench-api endpoint, no new substrate-level persistence primitive.** D2 + CONTEXT.md OOS-line. Phase 3 lives entirely in `packages/workbench-ui/` + `docs/FLOW-LEGEND.md` + (optional, separate commit) `docs/COMMAND-CENTER-CONTRACT.md` references-section link.

## Standard Stack

### Core (already in repo — no installs)

| Library                | Version (lock file)     | Purpose                                           | Why Standard                                                                                                 |
| ---------------------- | ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| react                  | 19.x (per package.json) | Functional component + `useMemo`                  | Already powers `PressureOverlay`; same JSX shell.                                                            |
| typescript             | 5.x (strict)            | Closed-enum types, generic source-binding helpers | Phase 1+2 established `FieldName` closed-enum pattern; Phase 3 adds `FlowFieldName` to the union.            |
| vite                   | 5.x                     | Build, `import.meta.env` flag plumbing            | `VITE_PRESSURE_DRAMATIZATION` is read via `import.meta.env` (CommandView.tsx:96). Phase 3 reuses unchanged.  |
| vitest                 | 2.x (per package.json)  | Unit + snapshot tests, `vi.stubEnv`, fake timers  | Phase 2 `cc-reload.test.tsx` uses selective `vi.useFakeTimers({ toFake: ['Date'] })` — pattern carries over. |
| @testing-library/react | 16.x (per package.json) | DOM render + `waitFor` for async fixtures         | `PressureOverlay.test.tsx` template uses it; FlowOverlay test mirrors.                                       |

[VERIFIED: file inspection of `packages/workbench-ui/package.json` and existing test files; no version drift since Phase 2.]

### Supporting (already in repo)

| Library       | Purpose                            | When to Use                                                          |
| ------------- | ---------------------------------- | -------------------------------------------------------------------- |
| CSS Modules   | Scoped class names with build-hash | `FlowOverlay.module.css` mirrors `PressureOverlay.module.css` shape. |
| `@kagent/dto` | `DispositionOverlayRow` + types    | Phase 3 doesn't need new DTOs; existing types are sufficient.        |

### Alternatives Considered

| Instead of                        | Could Use                                  | Tradeoff                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<aside>` + `<ul>/<li>/<a>` DOM   | Canvas/SVG-rendered gauges                 | Rejected per CONTEXT.md D-01-A: gauges are HTML rows for accessibility + source-binding scrape-ability. Canvas would lose `data-source-field` DOM-attribute scrapability.               |
| Fresh `flowDramatization` flag    | Existing `pressureDramatization` prop+flag | Rejected per CONTEXT.md D-04-A: single global flag covers all overlays. Splitting doubles env-var surface and creates a meaningless "pressure-dramatic-but-flows-subdued" failure mode. |
| `flows/index.ts` + per-kind files | Single `flows.ts` mirroring `pressure.ts`  | Default: single file (mirrors Phase 2 pattern). Split only if `flows.ts` exceeds ~400 lines (8 entries × ~30 lines each ≈ 240 lines, comfortably under).                                |

**Installation:** None. All dependencies present.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────── workbench-api (UNCHANGED) ───────────────────┐
│  /api/agents     /api/tasks     /api/gateway/capacity           │
│  /api/gateway/usage     /api/dispositions                       │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTP + SSE
                             ▼
┌──────────────── workbench-ui useCommandSnapshot() ──────────────┐
│  CommandSnapshot { agents, tasks, gatewayCapacity,              │
│                    gatewayUsage, dispositions, lastEventAt, … } │
└────────────────────────────┬─────────────────────────────────────┘
                             │ snapshot prop (single read)
            ┌────────────────┼────────────────────────┐
            ▼                ▼                        ▼
   <DispositionOverlay>  <PressureOverlay>      <FlowOverlay>     ← NEW
   (Phase 1, DISP-04)    (Phase 2, CC-04)       (Phase 3, FLOW-01) ← NEW
   uses                  uses                    uses
   DISPOSITION_TYPES     PRESSURE_TYPES          FLOW_TYPES        ← NEW
   from disposition      from pressure.ts        from flows.ts     ← NEW
   projection
            │                │                        │
            └────────────────┴────────────────────────┘
                             │ DOM with data-source-field(s)
                             ▼
              CC-01 dev orphan-assertion (PASS in dev,
              no-op in prod) — assertSourceField /
              assertSourceFields close the source-binding loop
```

Phase 3 inserts a single new sibling overlay node into this graph. Every input arrow already exists; every output arrow already exists. The diagram changes by one box.

### Component Responsibilities (Phase 3 deltas only)

| File                                                                                       | Responsibility                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench-ui/src/command/flows.ts` (NEW)                                         | Declare `FlowGauge` + `FlowType` interfaces, `FLOW_TYPES` array (8 entries), `FlowFieldName = FlowType['kind']` derived enum. Each `compute(snapshot)` is a pure function over `CommandSnapshot`. Per-entry leading comment names source + promotion path.                             |
| `packages/workbench-ui/src/command/FlowOverlay.tsx` (NEW)                                  | Render `<aside aria-label="Resource flows">` with 8 sections (one per flow kind). Each section has a header + list of gauges. Each gauge `<a>` carries `data-source-field`(s) + `href={detailLink}`. Subdued/dramatic CSS class swap on `pressureDramatization`.                       |
| `packages/workbench-ui/src/command/FlowOverlay.module.css` (NEW)                           | `card` + `header` + `list` + `row` + `flowGauge` + `flowGaugeSubdued` + `bar` + `barFill` + `readout`. Mirror `PressureOverlay.module.css` positioning conventions but offset to avoid overlap (planner picks: e.g., `top: 56px; right: 16px` opposite side of pressure card on left). |
| `packages/workbench-ui/src/command/flows.test.ts` (NEW)                                    | 16 minimum tests: 8 `compute()`-fires + 8 `compute()`-empty. Plus FLOW-01 fixture-assertion: `for (const ft of FLOW_TYPES) { expect(ft.sourceField ?? ft.sourceFields).toBeDefined(); }`.                                                                                              |
| `packages/workbench-ui/src/command/FlowOverlay.test.tsx` (NEW)                             | 4 tests mirroring `PressureOverlay.test.tsx`: (1) renders gauges with `data-source-field(s)`; (2) reload-stability via stable selectors; (3) `pressureDramatization=true` applies dramatic class; (4) `pressureDramatization=false` keeps data + applies subdued class.                |
| `packages/workbench-ui/src/command/source-binding.ts` (MODIFY)                             | Add `export type { FlowFieldName } from './flows.js';` at the bottom alongside the existing `PressureFieldName` re-export (lines 106–112). No other changes; runtime helpers reused unchanged.                                                                                         |
| `packages/workbench-ui/src/command/source-binding.test.ts` (MODIFY)                        | Add 1–2 tests proving `assertSourceField<FlowFieldName>` / `assertSourceFields<FlowFieldName>` narrow correctly. Mirror existing `PressureFieldName` coverage.                                                                                                                         |
| `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` (MODIFY)                 | Additive rows (see Finding 5) so all 8 flows fire under the same fixture used by `cc-reload.test.tsx`. Do NOT remove existing rows — the 9 pressure types still need to fire.                                                                                                          |
| `packages/workbench-ui/src/command/cc-reload.test.tsx` (no code edit; snapshot regenerate) | One intentional `vitest -u` run after FlowOverlay first mounts. Diff lands as a single reviewable commit. The `__snapshots__/cc-reload.test.tsx.snap` (currently 204 lines) will grow — predictable, additive.                                                                         |
| `packages/workbench-ui/src/CommandView.tsx` (MODIFY)                                       | Add 1 `import` line + 1 JSX block (see Finding 7). Insertion site: directly after `<PressureOverlay />` mount at lines 1410–1413. ~10-line change.                                                                                                                                     |
| `docs/FLOW-LEGEND.md` (NEW)                                                                | 8-row table + per-flow section. Cite `intel/constraints.md §C-flow-economy`, `COMMAND-CENTER-CONTRACT.md` Slice E, CONTEXT.md D-02. Living doc.                                                                                                                                        |
| `docs/COMMAND-CENTER-CONTRACT.md` (OPTIONAL, separate commit)                              | Add a single line under references / footer: "See also: `docs/FLOW-LEGEND.md` for the eight `C-flow-economy` flow definitions." NOT a contract revision; just discoverability.                                                                                                         |

### Recommended Project Structure

```
packages/workbench-ui/src/command/
├── pressure.ts                    # Phase 2 — UNCHANGED
├── PressureOverlay.tsx            # Phase 2 — UNCHANGED
├── PressureOverlay.module.css     # Phase 2 — UNCHANGED
├── pressure.test.ts               # Phase 2 — UNCHANGED
├── PressureOverlay.test.tsx       # Phase 2 — UNCHANGED
├── flows.ts                       # NEW — mirrors pressure.ts
├── FlowOverlay.tsx                # NEW — mirrors PressureOverlay.tsx
├── FlowOverlay.module.css         # NEW — mirrors PressureOverlay.module.css
├── flows.test.ts                  # NEW — mirrors pressure.test.ts (16 min tests)
├── FlowOverlay.test.tsx           # NEW — mirrors PressureOverlay.test.tsx (4 tests)
├── source-binding.ts              # MODIFY — add FlowFieldName re-export at line ~112
├── source-binding.test.ts         # MODIFY — add narrowing test for FlowFieldName
├── __fixtures__/
│   └── cc-snapshot.json           # MODIFY — additive rows for 8-flow fire
├── __snapshots__/
│   └── cc-reload.test.tsx.snap    # AUTO-REGEN via `vitest -u` after FlowOverlay mounts
└── cc-reload.test.tsx             # UNCHANGED (only the snapshot file changes)

docs/
├── COMMAND-CENTER-CONTRACT.md     # OPTIONAL — add 1-line footer link to FLOW-LEGEND.md
└── FLOW-LEGEND.md                 # NEW — developer-facing 8-row legend
```

### Pattern 1: Closed-enum-from-array (PressureFieldName / FlowFieldName)

**What:** Derive a closed-enum type from the `kind` literals in a typed array so the union stays in lockstep with the array contents — single source of truth.
**When to use:** When a string-literal union must always exactly match the entries in a runtime array.
**Example (verbatim from `pressure.ts:314–319`, the template):**

```ts
/**
 * Derived from PRESSURE_TYPES['kind'] so the closed-enum stays in
 * one place. Now resolves to the union of all nine kind literals
 * automatically because PRESSURE_TYPES is populated.
 */
export type PressureFieldName = PressureType['kind'];
```

**Phase 3 mirror (planner adds at the bottom of `flows.ts`):**

```ts
/**
 * Derived from FLOW_TYPES['kind'] so the closed-enum stays in
 * one place. Resolves to the union of all eight kind literals
 * automatically because FLOW_TYPES is populated.
 */
export type FlowFieldName = FlowType['kind'];
```

Then `source-binding.ts:112` gets a sibling line (planner adds):

```ts
export type { FlowFieldName } from './flows.js';
```

[VERIFIED: `pressure.ts` lines 314–319 + `source-binding.ts` line 112 confirm this pattern exists and is the locked Phase 2 convention.]

### Pattern 2: Per-entry leading comment (v0.2 fallback documentation)

**What:** Every `FLOW_TYPES` entry gets a 4–8 line leading comment naming source field(s), the threshold/computation, and (for v0.2 fallbacks) the ideal source + promotion path.
**When to use:** Any entry whose source is a fallback rather than the ideal substrate signal.
**Example (verbatim from `pressure.ts:201–207`):**

```ts
// ─────────────────────────── context pressure ───────────────────────────
// Ideal source is `pilotEvidence.policy.maxConcurrentChildren` ratio
// against `pilotEvidence.taskGraph.inFlightCount`, but pilotEvidence
// lives on TaskDetail, NOT TaskSummary, so the v0.2 heuristic uses
// TaskSummary.childCount >= 2 while phase=Dispatched. Promote to
// the ideal source if pilotEvidence is added to TaskSummary in a
// future phase (per RESEARCH.md Finding 2).
```

**Phase 3 mirror per CONTEXT.md D-02:** every `FLOW_TYPES` entry gets the comment text supplied verbatim in CONTEXT.md D-02-modelPower..attention.

### Pattern 3: Conditional-spread for optional `data-*` attributes

**What:** TypeScript's strict-typed JSX rejects `attribute={undefined}`. Use conditional spread to preserve type-strictness when one of two attributes (single vs multi) is set.
**Example (verbatim from `PressureOverlay.tsx:66–67`):**

```tsx
{...(sf !== undefined ? { 'data-source-field': sf } : {})}
{...(sfs !== undefined ? { 'data-source-fields': sfs.join(',') } : {})}
```

Phase 3 `FlowOverlay.tsx` uses the identical idiom.

### Pattern 4: useMemo over snapshot, no internal state

**What:** The overlay component computes its rendered list from the snapshot prop via `useMemo`. No internal state, no fetches, no `localStorage`. Reload-stable by construction.
**Example (verbatim from `PressureOverlay.tsx:45–48`):**

```tsx
const markers = useMemo<readonly PressureMarker[]>(
  () => PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot)),
  [snapshot],
);
```

**Phase 3 mirror:**

```tsx
const gauges = useMemo<readonly FlowGauge[]>(
  () => FLOW_TYPES.flatMap((ft) => ft.compute(snapshot)),
  [snapshot],
);
```

### Pattern 5: Subdued/dramatic CSS class swap

**What:** The same data renders with one of two CSS classes based on the `pressureDramatization` prop. Class swap, not data toggle.
**Example (verbatim from `PressureOverlay.tsx:62–64`):**

```tsx
className={
  pressureDramatization ? styles.pressureMarker : styles.pressureMarkerSubdued
}
```

**Phase 3 mirror:** `styles.flowGauge` / `styles.flowGaugeSubdued`. CSS classes mirror `PressureOverlay.module.css:51–87`.

### Anti-Patterns to Avoid

- **Adding a new env var (`VITE_FLOW_DRAMATIZATION`).** Locked OUT-OF-SCOPE per D-04-A. Single global flag is the contract.
- **Dual-rendering the same threshold information across `PressureOverlay` AND `FlowOverlay`.** The "Hybrid (gauge + threshold marker)" option was rejected (see DISCUSSION-LOG.md). Pressure markers fire at threshold; flow gauges always show the current ratio. Don't recreate the marker behavior in the gauge.
- **Mutating the snapshot in `compute()`.** Pure functions over `CommandSnapshot` only — same contract as `pressure.ts` `classify`. Any non-pure function will break the `useMemo` reload-stability invariant.
- **Hand-typed `FlowFieldName` union.** Use the derived `FlowType['kind']` form (Pattern 1). Hand-typed union drifts silently from `FLOW_TYPES` array contents.
- **Reading `import.meta.env.VITE_*` inside `flows.ts` or `FlowOverlay.tsx`.** Read it ONCE at the CommandView.tsx module top (lines 95–97 already do this for `pressureDramatization`) and pass the boolean down as a prop. Vite inlines `import.meta.env` at build time; multiple reads = code duplication.
- **Painting on-canvas legend tooltips, "?" buttons, sidebar keys.** Slice E acceptance forbids it — `COMMAND-CENTER-CONTRACT.md:255`. Legend is `docs/FLOW-LEGEND.md` only.
- **Modifying `docs/COMMAND-CENTER-CONTRACT.md` to enumerate the 8 flows inline.** Rejected option in DISCUSSION-LOG.md. The contract is binding and load-bearing; living vs stable doc separation matters.

## Don't Hand-Roll

| Problem                                     | Don't Build                                           | Use Instead                                                                | Why                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Source-binding closed-enum                  | Hand-typed `type FlowFieldName = 'modelPower' \| ...` | Derived `type FlowFieldName = FlowType['kind']` per pressure.ts:319        | Hand-typed union drifts silently when `FLOW_TYPES` array is edited. Derived form fails compile when out of sync.            |
| Dev-only orphan assertion                   | New runtime guard for flows                           | Reuse `assertSourceField`/`assertSourceFields` (source-binding.ts:173,220) | Runtime helpers are generic over the closed-enum K; no new helper needed. Phase 1+2 already shipped them.                   |
| Snapshot fixture                            | New JSON file for flow-only tests                     | Extend existing `cc-snapshot.json` additively                              | Phase 2's fixture already covers 9 pressure types; adding flow-fire rows layers cleanly. Two-fixture coupling = drift risk. |
| Reload-stability test                       | New test file mirroring `cc-reload.test.tsx`          | Re-run existing `cc-reload.test.tsx` with `vitest -u`                      | Snapshot diff is the audit trail. New test would create coverage overlap and snapshot-file proliferation.                   |
| Subdued/dramatic CSS toggle                 | New env-var flag or per-flow toggle                   | Reuse `pressureDramatization` prop (CommandView.tsx:95–97)                 | Single global flag is locked per D-04-A. Plumbing already exists.                                                           |
| URL-of helper for fetch mock                | New helper in `cc-reload.test.tsx`                    | Reuse `urlOf()` (cc-reload.test.tsx:153–159)                               | Already battle-tested for `Request` / `URL` / `string` inputs.                                                              |
| `Object.fromEntries(map)` for Map snapshots | Custom Map serializer                                 | Reuse `serializableLayout()` pattern (cc-reload.test.tsx:111–117)          | Map fields don't JSON-serialize natively; pattern is documented in Phase 2 SUMMARY.                                         |

**Key insight:** Phase 3 is a 1:1 mirror of Phase 2's `pressure.*` shipped pattern. The "don't hand-roll" list above is essentially "don't redesign anything Phase 1+2 already shipped." If the planner is writing a helper the planner thinks is novel, the planner should grep Phase 2's files first.

## Common Pitfalls

### Pitfall 1: Snapshot diff overwhelms reviewer

**What goes wrong:** First `vitest -u` run after `<FlowOverlay />` mounts in CommandView regenerates `cc-reload.test.tsx.snap`. With 8 flow sections × 1–~5 gauges each = 13–25 new `<a>` entries appearing in the snapshot. Combined with the existing 204-line snapshot, diff could be ~50+ lines of new content interleaved with existing pressure / disposition entries.
**Why it happens:** The snapshot captures all `[data-source-field],[data-source-fields]` elements + all anchors (cc-reload.test.tsx:127–141). FlowOverlay adds both.
**How to avoid:** Split the FlowOverlay mount commit from the snapshot-regenerate commit. The mount commit will fail `cc-reload.test.tsx` (this is expected — flag the failure as the trigger for the next commit). The next commit runs `vitest -u` and lands the snapshot diff in isolation. Reviewer scrutinizes only the snapshot file, not interleaved code+snapshot changes.
**Warning signs:** Snapshot file growth > 100 lines on the regen commit. If so, the planner should consider whether the fixture additions are minimal; sometimes a too-rich fixture (e.g., 4 GatewayCapacityRows when 2 suffice) inflates the snapshot needlessly.

### Pitfall 2: Vitest fake-timers leak across tests

**What goes wrong:** Phase 2 `cc-reload.test.tsx` uses `vi.useFakeTimers({ toFake: ['Date'] })` selectively because `vi.useFakeTimers()` (default) freezes `setTimeout`/`setInterval` and breaks fetch promises + `@testing-library/react`'s `waitFor` poller (Phase 2 SUMMARY documented this).
**Why it happens:** Default fake-timers replace ALL timer functions. Async test infrastructure depends on real `setTimeout`.
**How to avoid:** Phase 3 `FlowOverlay.test.tsx` and `flows.test.ts` should use `vi.useFakeTimers({ toFake: ['Date'] })` ONLY when Date.now() determinism is needed (e.g., if any flow's `compute()` reads Date.now() — currently NONE of the 8 flows do, so fake timers may be unnecessary entirely). Default to NO fake timers; add only if a specific test needs Date determinism. Always pair with `afterEach(() => vi.useRealTimers())`.
**Warning signs:** Test hangs at `waitFor`; "Test timed out in 5000ms" errors; fetch promise resolves but test never sees it.

### Pitfall 3: `globalThis.fetch` vs `global.fetch`

**What goes wrong:** Mocking `global.fetch` in jsdom env doesn't intercept calls. Phase 2 SUMMARY documented this — must mock `globalThis.fetch`.
**Example (cc-reload.test.tsx:162):**

```ts
return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => { ... });
```

**How to avoid:** Always use `globalThis.fetch` in Phase 3 tests. This applies to `FlowOverlay.test.tsx` if it ever mocks fetch (but most flow tests are pure-function `compute()` tests on a constructed snapshot — no fetch needed; only `cc-reload.test.tsx` does the fetch dance).

### Pitfall 4: JSON import attributes (Node 22 ESM)

**What goes wrong:** Node 22's ESM JSON imports require the `with { type: 'json' }` attribute. Phase 2 fixture import uses it (cc-reload.test.tsx:51):

```ts
import fixture from './__fixtures__/cc-snapshot.json' with { type: 'json' };
```

**How to avoid:** Any new test that imports the fixture must use `with { type: 'json' }`. If a planner writes `import fixture from './...json';` (no attribute), Node 22 will throw at module load.

### Pitfall 5: CSS-module class hashes break raw-HTML snapshots

**What goes wrong:** `*.module.css` class names get build-time hash suffixes (e.g., `_pressureMarker_a3f8b1`). Raw HTML-string snapshots fail on every rebuild.
**How to avoid:** Phase 3 tests use stable selectors (queries + attributes + textContent), NEVER `container.innerHTML`. Phase 2 documented this in `PressureOverlay.test.tsx:18–19`. The `snapshotShape()` helper (cc-reload.test.tsx:127–141 / PressureOverlay.test.tsx:49–58) is the template.

### Pitfall 6: Pre-commit hook fails on Node ≥ 23

**What goes wrong:** Pre-commit hook is calibrated for Node 22. If the machine default has drifted (Node 23+), hook errors at commit time.
**How to avoid:** Run `source ~/.nvm/nvm.sh && nvm use 22` before `git commit`. Documented in Phase 1+2 SUMMARY. The `/gsd-execute-phase` slash command will retry but won't auto-fix nvm.

### Pitfall 7: Empty-state rows are required, not optional

**What goes wrong:** A naive implementation returns `null` from `FlowOverlay` when `gauges.length === 0`, mirroring `PressureOverlay.tsx:49`. But D-05-A explicitly requires "all 8 flows are ALWAYS visible — silence is data" — the FlowOverlay must render the section even when `compute()` returns empty.
**Why it happens:** Pressure markers fire/don't (binary). Flow gauges are ongoing state — operators need to see "this flow exists, currently zero" vs "this flow is missing from the system".
**How to avoid:** `FlowOverlay`'s grouping iterates `FLOW_TYPES` (not the flat gauge list), and renders the section header always. Per-flow body renders the gauges if non-empty, else a single `—` placeholder row with `value=0`, `label='no <flow> source data'`, `data-source-field=<flow primary source>`. NOTE: this is a DELIBERATE deviation from `PressureOverlay.tsx:49`'s `if (markers.length === 0) return null;` early return.

## Code Examples

Verified patterns from official sources (current code in this repo).

### Example 1: Per-entry FLOW_TYPES shape (planner template)

Mirror of `pressure.ts:76–96` (gateway saturation), adapted for the modelPower flow:

```ts
// Source: packages/workbench-ui/src/command/pressure.ts:76-96 (template)
// New: packages/workbench-ui/src/command/flows.ts (Phase 3)
//
// ─────────────────────────── modelPower ───────────────────────────
// Source fields: GatewayCapacityRow.inFlight + GatewayCapacityRow.currentCap.
// One gauge per gateway endpoint. Gauge: value=inFlight, capacity=currentCap,
// unit='in flight'. Clean source — no v0.2 fallback needed.
{
  kind: 'modelPower',
  granularity: 'perEndpoint',
  sourceFields: ['inFlight', 'currentCap'],
  compute: (s): readonly FlowGauge[] =>
    s.gatewayCapacity.map((row): FlowGauge => ({
      kind: 'modelPower',
      sourceFields: ['inFlight', 'currentCap'],
      affectedKey: row.endpoint,
      detailLink: '#/gateway',
      label: `${row.model}`,
      value: row.inFlight,
      capacity: row.currentCap > 0 ? row.currentCap : undefined,
      unit: 'in flight',
    })),
  detailLink: (): string => '#/gateway',
},
```

### Example 2: Closed-enum-from-array footer (planner template)

```ts
// Source: packages/workbench-ui/src/command/pressure.ts:314-319 (template)
// Mirror this verbatim at the bottom of flows.ts.
/**
 * Derived from FLOW_TYPES['kind'] so the closed-enum stays in
 * one place. Resolves to the union of all eight kind literals
 * automatically because FLOW_TYPES is populated.
 */
export type FlowFieldName = FlowType['kind'];
```

### Example 3: source-binding.ts re-export (planner template)

```ts
// Source: packages/workbench-ui/src/command/source-binding.ts:106-112
// Add the FlowFieldName re-export immediately below the existing
// PressureFieldName re-export.
export type { PressureFieldName } from './pressure.js';
export type { FlowFieldName } from './flows.js'; // ← NEW (Phase 3)
```

### Example 4: FlowOverlay JSX shell (planner template)

```tsx
// Source: packages/workbench-ui/src/command/PressureOverlay.tsx:41-77 (template)
// New: packages/workbench-ui/src/command/FlowOverlay.tsx (Phase 3)
//
// Note the deviation from PressureOverlay: NO early return when gauges.length === 0
// (per D-05-A "all 8 flows are ALWAYS visible") and gauges are GROUPED by kind
// (rather than flat-listed) so empty sections can render placeholder rows.

export const FlowOverlay: FC<FlowOverlayProps> = ({ snapshot, pressureDramatization = true }) => {
  const gaugesByKind = useMemo<ReadonlyMap<FlowType['kind'], readonly FlowGauge[]>>(() => {
    const m = new Map<FlowType['kind'], readonly FlowGauge[]>();
    for (const ft of FLOW_TYPES) {
      m.set(ft.kind, ft.compute(snapshot));
    }
    return m;
  }, [snapshot]);

  return (
    <aside className={styles.card} aria-label="Resource flows">
      <header className={styles.header}>Flows</header>
      {FLOW_TYPES.map((ft) => {
        const gauges = gaugesByKind.get(ft.kind) ?? [];
        return (
          <section key={ft.kind} className={styles.section}>
            <h3 className={styles.sectionHeader}>{ft.kind}</h3>
            {gauges.length > 0 ? (
              <ul className={styles.list}>
                {gauges.map((g, i) => {
                  const stableKey = `${g.kind}-${g.affectedKey ?? `idx-${String(i)}`}`;
                  const sf = g.sourceField;
                  const sfs = g.sourceFields;
                  return (
                    <li key={stableKey} className={styles.row}>
                      <a
                        className={
                          pressureDramatization ? styles.flowGauge : styles.flowGaugeSubdued
                        }
                        href={g.detailLink}
                        {...(sf !== undefined ? { 'data-source-field': sf } : {})}
                        {...(sfs !== undefined ? { 'data-source-fields': sfs.join(',') } : {})}
                      >
                        {g.label}{' '}
                        {g.capacity !== undefined
                          ? `${String(g.value)}/${String(g.capacity)} ${g.unit ?? ''}`
                          : `${String(g.value)} ${g.unit ?? ''}`}
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div
                className={styles.emptyRow}
                {...(ft.sourceField !== undefined ? { 'data-source-field': ft.sourceField } : {})}
                {...(ft.sourceFields !== undefined
                  ? { 'data-source-fields': ft.sourceFields.join(',') }
                  : {})}
              >
                — no {ft.kind} source data
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
};
```

### Example 5: CommandView.tsx mount site (planner template)

Insert directly after the existing `<PressureOverlay />` mount (lines 1410–1413):

```tsx
// Source: packages/workbench-ui/src/CommandView.tsx:1404-1413
// Insert the FlowOverlay mount immediately after PressureOverlay.

<PressureOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />;

{
  /* Phase 3 / FLOW-01 — eight C-flow-economy flow gauges. Sibling
    to PressureOverlay; same single global VITE_PRESSURE_DRAMATIZATION
    flag covers both per CONTEXT.md D-04-A. Every gauge carries
    data-source-field(s) per Prime Directive (D7). */
}
<FlowOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />;
```

Plus the import line near CommandView.tsx:53:

```ts
import { FlowOverlay } from './command/FlowOverlay.js';
```

## Runtime State Inventory

> Phase 3 is a presentation-layer-only addition (new component + new pure-function module + additive fixture rows + new docs). It is NOT a rename, refactor, or migration. Section included for completeness; all categories are explicitly empty.

| Category            | Items Found                                                                                                                                                             | Action Required                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Stored data         | None — Phase 3 is presentation-only; no DB writes, no key renames, no collection renames                                                                                | None                                                                                                  |
| Live service config | None — no n8n/Datadog/Tailscale/CF Tunnel dependencies                                                                                                                  | None                                                                                                  |
| OS-registered state | None — no Task Scheduler/launchd/systemd dependencies                                                                                                                   | None                                                                                                  |
| Secrets/env vars    | `VITE_PRESSURE_DRAMATIZATION` already defined in `../new_localai/` workbench-ui Helm overlay (Phase 1+2). Phase 3 reuses unchanged. NO new env var (locked per D-04-A). | None — verified by inspection of Phase 1+2 plumbing in CommandView.tsx:95–97                          |
| Build artifacts     | None — no compiled binaries, no published packages, no Docker image rename                                                                                              | None — workbench-ui Docker image rebuild on next ArgoCD overlay bump is normal CD; not a Phase 3 task |

**The canonical question (rename/refactor):** N/A — Phase 3 is additive. After every file in this PR is added, no runtime systems have stale state because nothing was renamed.

## Environment Availability

> Phase 3 has no external dependencies beyond the existing workbench-ui dev/test toolchain. All required tools are present per Phase 1+2 having shipped.

| Dependency                  | Required By                          | Available         | Version (verify locally) | Fallback        |
| --------------------------- | ------------------------------------ | ----------------- | ------------------------ | --------------- |
| Node 22                     | Pre-commit hook + tsx + vitest       | ✓ (per Phase 1+2) | `node --version`         | None — required |
| pnpm                        | `pnpm -C packages/workbench-ui test` | ✓                 | `pnpm --version`         | None — required |
| vitest 2.x                  | Test runner                          | ✓                 | (in package.json)        | None — required |
| @testing-library/react 16.x | DOM render in tests                  | ✓                 | (in package.json)        | None — required |

**Skip condition does NOT apply:** Phase 3 has dev/test toolchain dependencies, but they are all already present and exercised by Phase 1+2's shipped tests. No new installs.

## Validation Architecture

Phase 3 follows the Nyquist 8-dimension validation strategy. `.planning/config.json` does not set `workflow.nyquist_validation: false`, so this section IS included.

### Test Framework

| Property           | Value                                                                            |
| ------------------ | -------------------------------------------------------------------------------- |
| Framework          | vitest 2.x (per `packages/workbench-ui/package.json`)                            |
| Config file        | `packages/workbench-ui/vitest.config.ts` (existing — no change needed)           |
| Quick run command  | `pnpm -C packages/workbench-ui test -- flows.test.ts FlowOverlay.test.tsx --run` |
| Full suite command | `pnpm -C packages/workbench-ui test -- --run`                                    |

### Phase Requirements → Test Map

| Req ID  | Behavior                                                                                         | Test Type   | Automated Command                                                                           | File Exists?              |
| ------- | ------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| FLOW-01 | Each of 8 flows has a non-null source field reference                                            | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "non-null source" --run`            | ❌ Wave 0                 |
| FLOW-01 | modelPower `compute()` fires when GatewayCapacityRow has inFlight > 0                            | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "modelPower fires" --run`           | ❌ Wave 0                 |
| FLOW-01 | modelPower `compute()` empty when gatewayCapacity is empty                                       | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "modelPower empty" --run`           | ❌ Wave 0                 |
| FLOW-01 | tokenFlow `compute()` fires per `TaskSummary.model` in phase=Dispatched                          | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "tokenFlow fires" --run`            | ❌ Wave 0                 |
| FLOW-01 | tokenFlow `compute()` empty when no Dispatched tasks                                             | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "tokenFlow empty" --run`            | ❌ Wave 0                 |
| FLOW-01 | buildPower `compute()` fires per agent with active tasks targeting them                          | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "buildPower fires" --run`           | ❌ Wave 0                 |
| FLOW-01 | buildPower `compute()` empty when no agent has Dispatched targets                                | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "buildPower empty" --run`           | ❌ Wave 0                 |
| FLOW-01 | podCapacity `compute()` fires when tasks have podName + Dispatched/Pending phase                 | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "podCapacity fires" --run`          | ❌ Wave 0                 |
| FLOW-01 | podCapacity `compute()` empty when no tasks have podName                                         | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "podCapacity empty" --run`          | ❌ Wave 0                 |
| FLOW-01 | artifactBandwidth `compute()` fires when tasks have phase=Completed + artifactCount>0            | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "artifactBandwidth fires" --run`    | ❌ Wave 0                 |
| FLOW-01 | artifactBandwidth `compute()` empty when no Completed tasks have artifacts                       | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "artifactBandwidth empty" --run`    | ❌ Wave 0                 |
| FLOW-01 | authority `compute()` fires when phase=Failed + error contains 'policy'                          | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "authority fires" --run`            | ❌ Wave 0                 |
| FLOW-01 | authority `compute()` empty when no policy-denied failures                                       | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "authority empty" --run`            | ❌ Wave 0                 |
| FLOW-01 | trust `compute()` fires when suspicious is non-empty OR error contains 'verifier'                | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "trust fires" --run`                | ❌ Wave 0                 |
| FLOW-01 | trust `compute()` empty when no suspicious + no verifier failures                                | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "trust empty" --run`                | ❌ Wave 0                 |
| FLOW-01 | attention `compute()` fires when phase=Failed OR suspicious is non-empty                         | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "attention fires" --run`            | ❌ Wave 0                 |
| FLOW-01 | attention `compute()` empty when no failures + no suspicious                                     | unit        | `pnpm -C packages/workbench-ui test -- flows.test.ts -t "attention empty" --run`            | ❌ Wave 0                 |
| FLOW-01 | FlowOverlay renders gauges with `data-source-field(s)` DOM attributes                            | integration | `pnpm -C packages/workbench-ui test -- FlowOverlay.test.tsx -t "data-source" --run`         | ❌ Wave 0                 |
| FLOW-01 | FlowOverlay reload-stability — re-render with same snapshot produces equal selector tree         | integration | `pnpm -C packages/workbench-ui test -- FlowOverlay.test.tsx -t "reload" --run`              | ❌ Wave 0                 |
| FLOW-01 | `pressureDramatization=true` applies dramatic CSS class                                          | integration | `pnpm -C packages/workbench-ui test -- FlowOverlay.test.tsx -t "dramatic" --run`            | ❌ Wave 0                 |
| FLOW-01 | `pressureDramatization=false` applies subdued CSS class but preserves data                       | integration | `pnpm -C packages/workbench-ui test -- FlowOverlay.test.tsx -t "subdued" --run`             | ❌ Wave 0                 |
| FLOW-01 | `cc-reload.test.tsx` deep-equal across remount with FlowOverlay mounted                          | integration | `pnpm -C packages/workbench-ui test -- cc-reload.test.tsx --run`                            | ✓ (snapshot regen needed) |
| FLOW-01 | All 8 flows still source-bound after Phase 2's CC-01 orphan assertion (dev build)                | integration | `pnpm -C packages/workbench-ui test -- cc-orphan.test.ts --run` (existing test stays green) | ✓                         |
| FLOW-02 | `docs/FLOW-LEGEND.md` exists and references `intel/constraints.md §C-flow-economy`               | manual      | `test -f docs/FLOW-LEGEND.md && grep -q 'C-flow-economy' docs/FLOW-LEGEND.md`               | ❌ Wave 1                 |
| FLOW-02 | `docs/FLOW-LEGEND.md` documents all 8 flows (table row count == 8 + per-flow section count == 8) | manual      | grep `^## ` count in `docs/FLOW-LEGEND.md` ≥ 8                                              | ❌ Wave 1                 |

### Sampling Rate

- **Per task commit:** `pnpm -C packages/workbench-ui test -- flows.test.ts FlowOverlay.test.tsx --run` (~5–10s — pure functions + jsdom DOM tests)
- **Per wave merge:** `pnpm -C packages/workbench-ui test -- --run` (full suite — typically 30–60s; includes the regenerated `cc-reload.test.tsx` snapshot)
- **Phase gate:** Full suite green + `docs/FLOW-LEGEND.md` exists with 8 flow sections, before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/workbench-ui/src/command/flows.ts` — covers FLOW-01 (8 entries + closed-enum)
- [ ] `packages/workbench-ui/src/command/FlowOverlay.tsx` — covers FLOW-01 (rendering + source-binding + dramatic/subdued)
- [ ] `packages/workbench-ui/src/command/FlowOverlay.module.css` — covers FLOW-01 (visual treatment)
- [ ] `packages/workbench-ui/src/command/flows.test.ts` — covers FLOW-01 (16 + 1 fixture-assert minimum tests)
- [ ] `packages/workbench-ui/src/command/FlowOverlay.test.tsx` — covers FLOW-01 (4 render/dramatization tests)
- [ ] Extension to `packages/workbench-ui/src/command/source-binding.ts` (line ~112 — add `FlowFieldName` re-export) — covers FLOW-01 source-binding contract
- [ ] Extension to `packages/workbench-ui/src/command/source-binding.test.ts` — covers FLOW-01 type narrowing
- [ ] Extension to `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` — covers FLOW-01 fixture-fires + reload-stability
- [ ] `<FlowOverlay />` mount in `packages/workbench-ui/src/CommandView.tsx` — covers FLOW-01 (visible in Command Center)
- [ ] Snapshot regen of `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap` (intentional `vitest -u` after FlowOverlay mounts)
- [ ] `docs/FLOW-LEGEND.md` — covers FLOW-02 (developer-facing legend)
- [ ] (OPTIONAL, separate commit) Reference link in `docs/COMMAND-CENTER-CONTRACT.md` references — discoverability for FLOW-02

**Framework install:** None — vitest 2.x already present, no new test infrastructure required.

### Per-Dimension Mapping (Nyquist 8)

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

## Security Domain

`security_enforcement` is not explicitly set to `false` in `.planning/config.json` (the file only contains `workflow._auto_chain_active: false`). Treating as enabled, but Phase 3 is a pure read-side UI feature with no new auth/authz/data/secrets/network surface. Most ASVS categories are N/A.

### Applicable ASVS Categories

| ASVS Category         | Applies | Standard Control                                                                                                                                                                                                                                         |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2 Authentication     | no      | No new auth surface; existing workbench-ui session/cookie is unchanged                                                                                                                                                                                   |
| V3 Session Management | no      | No new session state; FlowOverlay reads from existing `useCommandSnapshot()` hook                                                                                                                                                                        |
| V4 Access Control     | no      | No new resource access; UI-side derivation only over already-fetched DTOs                                                                                                                                                                                |
| V5 Input Validation   | partial | `compute()` reads `CommandSnapshot` — already TypeScript-typed via `assertIsDispositionOverlayRow` (Phase 1) and the wire-shape types in `types.ts`. No untrusted input crossing a trust boundary in Phase 3.                                            |
| V6 Cryptography       | no      | No crypto in Phase 3                                                                                                                                                                                                                                     |
| V7 Error Handling     | yes     | `compute()` empty-state must render placeholder rows (per D-05-A); errors in classification do NOT crash the overlay (planner adds defensive empty-array returns on missing fields, mirroring Phase 2's `t.error?.toLowerCase().includes(...)` pattern). |
| V8 Data Protection    | no      | No new data persistence; presentation-only                                                                                                                                                                                                               |
| V9 Communications     | no      | No new network surface                                                                                                                                                                                                                                   |

### Known Threat Patterns for Workbench UI

| Pattern                                        | STRIDE                 | Standard Mitigation                                                                                                                                                          |
| ---------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-site scripting via `error` string render | Tampering              | React text-children auto-escape — `{t.error}` is safe by default. Phase 3 follows the `pressure.ts:218` pattern (text content only, never raw-HTML insertion APIs).          |
| UI-only world state divergence from substrate  | Repudiation            | CC-01 dev-orphan assertion (existing) + `data-source-field(s)` DOM attributes on every rendered gauge — full chain-of-custody from gauge to backing field.                   |
| Snapshot-fixture leak of secrets               | Information disclosure | Fixture is committed to git and contains synthetic data only — `kagent-system/researcher-01` etc. are placeholder names. Planner re-uses synthetic naming for additive rows. |

## Sources

### Primary (HIGH confidence — verified by direct file inspection in this research)

- `packages/workbench-ui/src/command/pressure.ts` — the canonical template (319 lines, 9 entries, 5 v0.2 fallbacks documented inline at lines 201–310)
- `packages/workbench-ui/src/command/PressureOverlay.tsx` — the JSX template (77 lines)
- `packages/workbench-ui/src/command/PressureOverlay.module.css` — the CSS template (88 lines, dramatic/subdued class pair at lines 51–87)
- `packages/workbench-ui/src/command/source-binding.ts` — the source-binding contract (280 lines; FlowFieldName re-export goes at line ~112 alongside PressureFieldName)
- `packages/workbench-ui/src/command/state.ts` — the snapshot shape (260 lines; `CommandSnapshot` interface at line 48–71; `gatewayUsage` exposed at line 88)
- `packages/workbench-ui/src/types.ts` — DTO definitions (`TaskSummary`:48–68; `GatewayCapacityRow`:248–265; `GatewayUsageRow`:272–290; `AgentSummaryRow`:191–204)
- `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` — current fixture (151 lines: 3 agents, 6 tasks, 2 gateway capacity rows, 1 disposition)
- `packages/workbench-ui/src/command/cc-reload.test.tsx` — Phase 2 reload-stability test (253 lines)
- `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap` — committed snapshot (204 lines)
- `packages/workbench-ui/src/CommandView.tsx` — main view (PressureOverlay mount at lines 1410–1413; `pressureDramatization` flag at lines 95–97)
- `packages/workbench-ui/src/command/pressure.test.ts` — test template (367 lines, 18 tests = 9 fires + 9 absent)
- `packages/workbench-ui/src/command/PressureOverlay.test.tsx` — overlay test template (185 lines, 4 tests)
- `.planning/phases/03-resource-flow-overlays/03-CONTEXT.md` — locked decisions D-01..D-05
- `.planning/REQUIREMENTS.md` — FLOW-01 + FLOW-02 acceptance criteria (lines 49–52)
- `.planning/intel/constraints.md` — `C-flow-economy` canonical 8-flow definition (lines 40–58)
- `docs/COMMAND-CENTER-CONTRACT.md` — Slice E "legend in developer docs, NOT in main UI chrome" at line 255
- `CLAUDE.md` (root) — project conventions

### Secondary (MEDIUM confidence — Phase 1+2 SUMMARY.md gotchas referenced)

- `.planning/phases/02-command-center-contract-hardening/02-04-SUMMARY.md` — vitest gotchas (selective fake timers, `globalThis.fetch`, `urlOf()`, `Object.fromEntries` for ReadonlyMap snapshots, JSON import attributes)

### Tertiary (LOW confidence — none required)

None. Every claim in this RESEARCH.md is verified by direct file inspection in this session.

## Findings

The 11 specific research areas requested in the orchestrator brief, each with concrete answers + line numbers + code excerpts.

### Finding 1: DTO field-path verification — CONTEXT.md is stale on `gatewayUsage` exposure

**Verification of CONTEXT.md D-02 bindings against current `packages/workbench-ui/src/types.ts` and `packages/workbench-ui/src/command/state.ts`:**

| Flow              | CONTEXT.md D-02 source field(s)                                                                                                     | Current type definition                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| modelPower        | `GatewayCapacityRow.inFlight` + `GatewayCapacityRow.currentCap`                                                                     | `inFlight: number; currentCap: number` (types.ts:252–253)       | ✓ Verified clean source. Same fields Phase 2's `gateway` pressure marker reads (pressure.ts:82–94).                                                                                                                                                                                                                                                                                                                                                                                                                |
| tokenFlow         | "v0.2 fallback: per-`TaskSummary.model` count of tasks in `phase='Dispatched'`"                                                     | `model?: string` (types.ts:55); `gatewayUsage` IS on snapshot   | ⚠️ **Stale assumption.** CONTEXT.md says `gatewayUsage` is "on `/api/gateway/usage`, NOT on the snapshot today". But `state.ts:88` exposes `gatewayUsage: readonly GatewayUsageRow[]`, and `GatewayUsageRow` carries `inputTokens: number; outputTokens: number; model: string` (types.ts:272–290). The locked D-02-tokenFlow decision still defers to the task-count proxy; planner ships as locked, but flag this as a pre-execution gray area in case the operator wants to promote to real tokens immediately. |
| buildPower        | `Array.from(snapshot.tasks.values()).filter(t => t.targetAgent === agent.name && t.phase === 'Dispatched')`                         | `targetAgent?: string; phase?: AgentTaskPhase` (types.ts:53,52) | ✓ Verified clean source. Aggregation idiom matches `pressure.ts` aggregation patterns.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| podCapacity       | `Array.from(snapshot.tasks.values()).filter(t => t.podName !== undefined && (t.phase === 'Dispatched' \|\| t.phase === 'Pending'))` | `podName?: string` (types.ts:59); `phase` (types.ts:52)         | ✓ Verified. Same fields Phase 2's `pod` pressure marker reads (pressure.ts:124–136).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| artifactBandwidth | `t.phase === 'Completed' && t.artifactCount > 0`, then sum `artifactCount`                                                          | `artifactCount?: number` (types.ts:63); `phase` (types.ts:52)   | ✓ Verified clean source. Same fields Phase 2's `artifact` pressure marker reads (pressure.ts:103–115).                                                                                                                                                                                                                                                                                                                                                                                                             |
| authority         | `t.phase === 'Failed' && t.error?.toLowerCase().includes('policy')`                                                                 | `error?: string` (types.ts:60); `phase` (types.ts:52)           | ✓ Verified — same heuristic as `pressure.ts:281–310` (`policy` marker).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| trust             | `(t.suspicious?.length ?? 0) > 0 \|\| (t.phase === 'Failed' && t.error?.toLowerCase().includes('verifier'))`                        | `suspicious?: readonly string[]` (types.ts:61)                  | ✓ Verified — same heuristics as `pressure.ts:226–254` (`verifier`) + `TaskSummary.suspicious`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| attention         | `t.phase === 'Failed' \|\| (t.suspicious?.length ?? 0) > 0`                                                                         | (same as authority + trust above)                               | ✓ Verified — Phase 4 owns the real review queue projection. Stub uses union of phase=Failed + suspicious.                                                                                                                                                                                                                                                                                                                                                                                                          |

**Action for planner:** Use the locked CONTEXT.md D-02 source-field bindings as-is. Add a single inline comment in `flows.ts` near the `tokenFlow` entry noting that `snapshot.gatewayUsage` IS available if a future operator decision promotes the gauge to real token data — but ship the locked task-count proxy.

[VERIFIED: Direct inspection of `state.ts` line 48–71 (CommandSnapshot interface) and `types.ts` lines 48–68, 191–204, 248–265, 272–290.]

### Finding 2: `pressure.ts` shape extraction (planner template references)

| Convention                                   | File:Line                                | Excerpt / Pattern                                                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closed-enum-from-array                       | `pressure.ts:314–319`                    | `export type PressureFieldName = PressureType['kind'];` — flows.ts mirrors verbatim                                                                                                      |
| Per-entry leading comment (v0.2 fallback)    | `pressure.ts:201–224` (context pressure) | 6-line block naming ideal source + heuristic + promotion path; flows.ts copies CONTEXT.md D-02 comment text verbatim                                                                     |
| Module-level JSDoc + contract reference      | `pressure.ts:6–24`                       | "See COMMAND-CENTER-CONTRACT.md §6 Pressure Systems for the nine canonical pressure types, and CONTEXT.md D-CC-04-A for the decision …" — flows.ts mirrors with §C-flow-economy + D-01-A |
| `taskKey()` hash-route helper                | `pressure.ts:72–74`                      | `function taskKey(t: { ns: string; name: string }): string { return \`#/tasks/${encodeURIComponent(...)}/${encodeURIComponent(...)}\`; }` — flows.ts re-uses verbatim or imports         |
| Pure-function classify/compute over snapshot | `pressure.ts:83–94` (gateway example)    | Map over `s.gatewayCapacity`, filter, return new objects. No mutations. flows.ts compute() mirrors                                                                                       |
| Multi-source `sourceFields` declaration      | `pressure.ts:81–82, 88–89`               | `sourceFields: ['inFlight', 'currentCap']` — comma-joined via `useSourceFields()` in PressureOverlay.tsx:67. flows.ts copies                                                             |

### Finding 3: `PressureOverlay.tsx` render shape extraction

| Convention                                    | File:Line                   | Excerpt / Pattern                                                                                                                                      |
| --------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<aside>` + `aria-label` shell                | `PressureOverlay.tsx:52`    | `<aside className={styles.card} aria-label="Pressure markers">` — FlowOverlay uses `aria-label="Resource flows"`                                       |
| `useMemo` over snapshot                       | `PressureOverlay.tsx:45–48` | `useMemo(() => PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot)), [snapshot])` — FlowOverlay mirrors with FLOW_TYPES.flatMap and compute           |
| Conditional spread for `data-source-field(s)` | `PressureOverlay.tsx:66–67` | `{...(sf !== undefined ? { 'data-source-field': sf } : {})}` — required for strict-typed JSX (no `attribute={undefined}`). FlowOverlay copies verbatim |
| Stable React key per row                      | `PressureOverlay.tsx:56`    | `\`${marker.kind}-${marker.affectedKey ?? \`idx-${String(i)}\`}\``— FlowOverlay copies, with`gauge.kind`+`gauge.affectedKey`                           |
| `pressureDramatization` prop wiring           | `PressureOverlay.tsx:31–43` | `readonly pressureDramatization?: boolean` default `true`; conditional class swap at line 62–64. FlowOverlay copies                                    |
| Mount site in CommandView                     | `CommandView.tsx:1410–1413` | `<PressureOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />` — FlowOverlay mounts immediately after, same prop pair         |
| `pressureDramatization` flag read             | `CommandView.tsx:95–97`     | `import.meta.env.VITE_PRESSURE_DRAMATIZATION !== 'false'` — already plumbed; Phase 3 reuses unchanged                                                  |

**`assertSourceField` / `assertSourceFields` invocation sites:** Phase 2's `PressureOverlay.tsx` does NOT directly call `assertSourceField` — instead, the assertion lives at the panel render sites (`AgentPanel`/`TaskPanel`/`GatewayPanel` in `CommandView.tsx`, per Phase 2's CC-03 work). The PressureOverlay attaches `data-source-field(s)` DOM attributes that the future CC-01 scraper reads. Phase 3 follows the same convention: `FlowOverlay.tsx` declares `data-source-field(s)` per gauge but does NOT call `assertSourceField` directly — the contract is the DOM attribute + the closed-enum FlowFieldName.

**Snapshot-fixture exercise pattern:** `pressure.test.ts:29–41` `makeSnapshot(overrides)` — flows.test.ts mirrors verbatim. Each test builds the minimal snapshot satisfying or violating the trigger.

### Finding 4: `source-binding.ts` extension surface (exact insertion point)

**File:** `packages/workbench-ui/src/command/source-binding.ts`
**Insertion point:** Immediately after the existing `PressureFieldName` re-export at line 112.

**Current state (lines 106–112):**

```ts
/**
 * Re-exported from pressure.ts so PRESSURE_TYPES stays the single
 * source of truth for the pressure kind union (per CONTEXT.md
 * D-CC-04-A). Wave 1 populates PRESSURE_TYPES with all 9 entries; the
 * union resolves automatically.
 */
export type { PressureFieldName } from './pressure.js';
```

**Add immediately below (Phase 3):**

```ts
/**
 * Re-exported from flows.ts so FLOW_TYPES stays the single source of
 * truth for the flow kind union (per CONTEXT.md D-01-A). Wave 1
 * populates FLOW_TYPES with all 8 entries; the union resolves
 * automatically.
 */
export type { FlowFieldName } from './flows.js';
```

**Confirmation that runtime helpers accept the new generic without modification:** `assertSourceField<T extends object, K extends string>(row: T, field: K)` (source-binding.ts:173) is already generic over `K`. `assertSourceFields<T extends object, K extends string>(row: T, fields: readonly K[])` (source-binding.ts:220) is already generic over `K`. `useSourceField<K extends string>(field: K): K` (source-binding.ts:195) and `useSourceFields<K extends string>(fields: readonly K[]): string` (source-binding.ts:244) are already generic. Phase 3 does NOT touch these helpers.

### Finding 5: `cc-snapshot.json` fixture — current rows + additive plan

**Current fixture** (151 lines; full content verified in this research):

- **3 agents:** `researcher-01` (model + class + tools + capabilities), `curator-02` (model + tools + 1 capability), `executor-03` (modelClass only + 1 capability)
- **6 tasks:**
  - `research-001` — Completed, researcher-01, podName, artifactCount=2, model set
  - `research-002` — Completed, curator-02, artifactCount=0 (fires `artifact` pressure)
  - `research-003` — Failed, researcher-01, podName, error contains 'verifier' (fires `pod` + `verifier` + `trace`)
  - `research-004` — Failed, curator-02, podName, error contains 'policy' (fires `pod` + `policy` + `trace`)
  - `fanout-005` — Dispatched, executor-03, childCount=3, suspicious=['high-fanout'] (fires `context`)
  - `research-006` — Pending, researcher-01
- **2 gatewayCapacity rows:** llama-4-scout (8/10 inFlight — fires `gateway`), llama-3.3-70b (1/8 — does not fire)
- **1 disposition row:** researcher-01, overBudget=true (fires `quota`)

**Additive rows needed for 8-flow fire** (planner extends additively — does NOT remove existing rows; existing 9 pressure markers must keep firing):

| Flow                             | What needs to fire                                                                                 | Already fires from existing fixture?                                                            | Additive row needed                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| modelPower                       | ≥1 GatewayCapacityRow with `inFlight > 0` and `currentCap > 0`                                     | ✓ both gateway rows have inFlight > 0                                                           | None — already satisfied                                                                                                     |
| tokenFlow                        | ≥1 TaskSummary with `model` set and `phase='Dispatched'`                                           | ✗ `fanout-005` is Dispatched but has no `model` field; only Completed/Failed tasks have `model` | Add `model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast'` to `fanout-005` (or add a new Dispatched task with model) |
| buildPower                       | ≥1 agent with ≥1 Dispatched task targeting them                                                    | ✓ `fanout-005` (Dispatched) targets `executor-03`                                               | None — already satisfied (executor-03 has 1 active build slot in use)                                                        |
| podCapacity (substrateWide v0.2) | ≥1 TaskSummary with `podName !== undefined && (phase='Dispatched' \|\| 'Pending')`                 | ✗ `fanout-005` (Dispatched) has no podName; `research-006` (Pending) has no podName             | Add `podName: 'fanout-005-pod'` to `fanout-005` (one is sufficient)                                                          |
| artifactBandwidth                | ≥1 TaskSummary with `phase='Completed'` and `artifactCount > 0`                                    | ✓ `research-001` has artifactCount=2; `research-003` (Failed) has 1                             | None — already satisfied (artifactBandwidth only counts Completed; research-001 contributes value=2)                         |
| authority                        | ≥1 TaskSummary with `phase='Failed'` and `error.toLowerCase().includes('policy')`                  | ✓ `research-004` matches                                                                        | None — already satisfied                                                                                                     |
| trust                            | ≥1 TaskSummary with `suspicious.length > 0` OR (`phase='Failed'` and `error.includes('verifier')`) | ✓ `fanout-005.suspicious=['high-fanout']` AND `research-003.error` contains 'verifier'          | None — already satisfied (gives `value=2`)                                                                                   |
| attention (stub)                 | ≥1 TaskSummary with `phase='Failed'` OR `suspicious.length > 0`                                    | ✓ `research-003` Failed + `research-004` Failed + `fanout-005.suspicious`                       | None — already satisfied (gives `value=3`)                                                                                   |

**Net additive change:** ONE field on ONE existing task (`fanout-005`):

1. Add `"model": "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"` to fire tokenFlow per its model class
2. Add `"podName": "fanout-005-pod"` to fire podCapacity (Dispatched task with podName)

This is the minimal change. Existing 9-pressure-type coverage is preserved. The planner may also add a second Dispatched task targeting a second agent if buildPower's "more than one" granularity case is desired for visual variety in the snapshot — defer to planner discretion.

### Finding 6: `cc-reload.test.tsx` extension surface

**File:** `packages/workbench-ui/src/command/cc-reload.test.tsx` — **NO CODE CHANGES NEEDED.**

**What changes:** Only the snapshot file `__snapshots__/cc-reload.test.tsx.snap` (currently 204 lines).

**Mechanism:** The test calls `expect(domSnap2).toMatchSnapshot('dom')` (cc-reload.test.tsx:249) and `expect(layoutSnap2).toMatchSnapshot('layout')` (cc-reload.test.tsx:250). When `<FlowOverlay />` first mounts, the `domSnap2` (which is `snapshotShape()` — every `[data-source-field],[data-source-fields]` element + every `<a>`) will include the new gauges. Test FAILS on the first run.

**Snapshot regeneration:**

```bash
pnpm -C packages/workbench-ui test -- cc-reload.test.tsx --run -u
```

The `-u` flag updates snapshots. The test then passes; the diff lands in `__snapshots__/cc-reload.test.tsx.snap` as a single reviewable file.

**Env vars / timer / fetch mocking already in place (cc-reload.test.tsx:189–202):**

- `vi.stubEnv('NODE_ENV', 'development')` in beforeEach — ensures dev-build orphan assertion runs
- `vi.useFakeTimers({ toFake: ['Date'] })` selective — Date.now() deterministic; setTimeout/setInterval REAL so fetch + waitFor work
- `vi.setSystemTime(new Date('2026-05-10T12:00:00Z'))` — fixed wallclock
- `globalThis.fetch` spy via `makeFetchMock()` — returns fixture data per URL substring match (lines 161–186)

**Expected snapshot diff size:** ~30–60 new lines for FlowOverlay gauges. The planner should land the FlowOverlay mount commit FIRST (which causes `cc-reload.test.tsx` to fail), then a SEPARATE commit runs `vitest -u` and lands ONLY the snapshot diff. This split is the Phase 2 SUMMARY pattern for snapshot-regen commits.

### Finding 7: CommandView.tsx mount site

**Mount location:** Immediately after the existing `<PressureOverlay />` mount at lines 1410–1413.

**Surrounding sibling components in this region (verified in this research):**

- Lines 1399–1402: `<DispositionOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />` (Phase 1 / DISP-04)
- Lines 1410–1413: `<PressureOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />` (Phase 2 / CC-04)
- Lines 1415–1423: `<div className={styles.hotkeyStrip}>` (the bottom hotkey hint strip)

**Natural insertion point:** Between line 1413 (`/>`) and line 1415 (`<div className={styles.hotkeyStrip}>`).

**JSX change (planner inserts ~6 lines, plus 1 import line near line 53):**

```tsx
{
  /* Phase 3 / FLOW-01 — eight C-flow-economy flow gauges. Sibling
    to PressureOverlay; same single global VITE_PRESSURE_DRAMATIZATION
    flag covers both per CONTEXT.md D-04-A. Every gauge carries
    data-source-field(s) per Prime Directive (D7). */
}
<FlowOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />;
```

Plus the import (insert next to existing PressureOverlay import at line 53):

```ts
import { FlowOverlay } from './command/FlowOverlay.js';
```

### Finding 8: Validation Architecture (already populated above)

See `## Validation Architecture` section above. The planner uses that section verbatim to populate `VALIDATION.md`. Per-dimension Nyquist mapping covers D1 (functional), D2 (structural), D3 (data integrity), D4 (interface contract), D5 (regression), D6 (performance — bounded; UI render only), D7 (security — N/A; pure read-side UI), D8 (validation harness).

### Finding 9: Risk surface (failure modes the planner should pre-empt)

| Risk                                                                   | Severity | Mitigation                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cc-reload` snapshot diff drowns the reviewer                          | MEDIUM   | Split FlowOverlay-mount commit from snapshot-regen commit. The mount commit FAILS `cc-reload.test.tsx` (expected); the regen commit runs `vitest -u` and lands ONLY the snapshot diff. Per-Pitfall-1 above.                                                                                                                                                  |
| `FlowFieldName` enum drift from `FLOW_TYPES`                           | LOW      | Use `type FlowFieldName = FlowType['kind']` derived form (Pattern 1). Hand-typed union would drift. Mirror `pressure.ts:319`.                                                                                                                                                                                                                                |
| jsdom missing `IntersectionObserver` / `ResizeObserver`                | LOW      | Phase 2 already runs jsdom for PressureOverlay tests without these polyfills — FlowOverlay's render is identical (`<aside>` + `<ul>/<li>/<a>`); no observer APIs used. No mocks needed.                                                                                                                                                                      |
| Vitest fake timers leak across FlowOverlay test                        | MEDIUM   | Default to NO fake timers in flows.test.ts / FlowOverlay.test.tsx. Phase 2 hit this — selective `vi.useFakeTimers({ toFake: ['Date'] })` only. None of the 8 flows reads `Date.now()`, so fake timers should not be needed at all in Phase 3.                                                                                                                |
| Pre-commit hook Node-22 requirement                                    | LOW      | Run `source ~/.nvm/nvm.sh && nvm use 22` before `git commit`. Documented in Phase 2 SUMMARY. The `/gsd-execute-phase` slash command will retry but won't auto-fix nvm.                                                                                                                                                                                       |
| tokenFlow proxy with `unit='tasks'` mislabeled as a real token rate    | MEDIUM   | Locked per CONTEXT.md D-02-tokenFlow: `unit='tasks'` and `label='tasks dispatched per model'` to be honest about the fallback. Inline comment names the ideal source. The planner MUST use these literals exactly; a casual "tokens/min" label would be a Prime Directive violation.                                                                         |
| Empty-state row missing for a flow with no data                        | MEDIUM   | Per Pitfall 7 above — D-05-A requires "all 8 flows are ALWAYS visible". FlowOverlay deviates from PressureOverlay's `if (markers.length === 0) return null;` (PressureOverlay.tsx:49) — instead, iterates FLOW_TYPES and renders section header always; per-flow body has placeholder row when empty.                                                        |
| Snapshot-fixture coupling between flows.test.ts and pressure.test.ts   | LOW      | flows.test.ts uses `makeSnapshot(overrides)` with empty defaults (mirror of pressure.test.ts:29–41). Each test builds the minimal snapshot exercising its target flow. cc-reload.test.tsx is the only place where fixture-as-JSON is loaded; flows.test.ts does NOT depend on the JSON fixture.                                                              |
| `VITE_PRESSURE_DRAMATIZATION` env var renamed in `../new_localai/`     | LOW      | The env var is plumbed today (Phase 1+2 shipped). Phase 3 does NOT touch `../new_localai/`. If the planner discovers the env var was renamed in a future ArgoCD overlay bump, that's a separate concern outside Phase 3.                                                                                                                                     |
| FlowOverlay layout collides with PressureOverlay or DispositionOverlay | LOW      | PressureOverlay positioned `top: 56px; left: 16px` (PressureOverlay.module.css:14–16). DispositionOverlay positioned `top: 56px; right: 16px` (per Phase 1). Available space: bottom of viewport, OR a third position. Planner picks: e.g., `top: 220px; left: 16px` below PressureOverlay; or `bottom: 16px; left: 16px`. Not blocking but worth designing. |

### Finding 10: Promotion-path discipline (5 v0.2 fallbacks)

Per CONTEXT.md D-02 the planner MUST include in each fallback's `flows.ts` inline comment: (a) ideal source DTO field path, (b) the API endpoint that hosts it today, (c) the future phase that promotes it.

| Flow        | (a) Ideal source                                                                                       | (b) Current API endpoint                                    | (c) Promoting phase                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| tokenFlow   | `GatewayUsageRow.inputTokens + outputTokens` summed over rolling 1m window per `GatewayUsageRow.model` | `/api/gateway/usage` (already on snapshot — see Finding 1)  | A future Workbench-hardening phase that adds rolling-window aggregation to `useCommandSnapshot()` |
| buildPower  | `pilotEvidence.policy.maxConcurrentChildren` on TaskDetail                                             | `/api/tasks/<ns>/<name>` (TaskDetail-only; not on snapshot) | A future Workbench-hardening phase that adds pilotEvidence to TaskSummary                         |
| podCapacity | `ClusterNodeRow.managedPodCount` per node vs `ClusterNodeRow.capacity['pods']`                         | `/api/cluster/snapshot` (ClusterSnapshot — not on snapshot) | A future Workbench-hardening phase that joins cluster snapshot into `useCommandSnapshot()`        |
| authority   | Structured `policy_denied` audit event                                                                 | Future SSE event kind beyond `task\|agent\|job\|pod`        | A future Workbench-hardening phase that adds audit-event kinds to the SSE stream                  |
| trust       | `pilotEvidence.verification.passed === false` on TaskDetail                                            | `/api/tasks/<ns>/<name>` (TaskDetail-only; not on snapshot) | A future Workbench-hardening phase that adds pilotEvidence subset to TaskSummary                  |
| attention   | Real review-queue projection                                                                           | Phase 4 owns (REV-01 in REQUIREMENTS.md)                    | **Phase 4** explicitly                                                                            |

**Verification of (a):**

- tokenFlow ideal source `inputTokens + outputTokens` — present in `GatewayUsageRow` (types.ts:278–279)
- buildPower ideal `pilotEvidence.policy.maxConcurrentChildren` — present in `TaskPilotEvidence` (types.ts:130)
- podCapacity ideal `ClusterNodeRow.managedPodCount` + `capacity['pods']` — present in `ClusterNodeRow` (types.ts:320–321)
- trust ideal `pilotEvidence.verification.passed` — present in `TaskPilotEvidence` (types.ts:147–148)

All four ideal sources exist in the wire-shape types today; only the snapshot integration is deferred. CONTEXT.md is correct on these four. tokenFlow is the only nuance per Finding 1.

### Finding 11: Out-of-scope guardrails (zero changes confirmed)

| Surface                            | Phase 3 changes? | Verification                                                                                                                                                                                                       |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/workbench-api/`          | NO               | Locked OOS in CONTEXT.md. No new endpoint. No new route. No DTO change. Verified by reading types.ts — all needed fields exist.                                                                                    |
| `packages/operator/`               | NO               | Locked OOS. No new CRD, no new reconciler.                                                                                                                                                                         |
| `packages/dto/`                    | NO               | Locked OOS. `@kagent/dto` types are unchanged (only `DispositionOverlayRow` re-export through types.ts is touched by Phase 1, not Phase 3).                                                                        |
| CRD definitions                    | NO               | Locked OOS per D2.                                                                                                                                                                                                 |
| Helm overlays in `../new_localai/` | NO               | `VITE_PRESSURE_DRAMATIZATION` env var already plumbed. No new env var.                                                                                                                                             |
| `packages/agent-pod/`              | NO               | Outside Phase 3 scope entirely.                                                                                                                                                                                    |
| `docs/COMMAND-CENTER-CONTRACT.md`  | OPTIONAL         | Locked: contract is NOT modified to enumerate flows inline (rejected option in DISCUSSION-LOG.md). One footer link to FLOW-LEGEND.md is allowed in a separate doc-update commit; not required for Phase 3 to ship. |
| Verification surface               | vitest only      | No kubectl. No Job manifests. No GitOps overlay bumps. No SSH. Per CLAUDE.md operational context.                                                                                                                  |

**Confirmed:** All Phase 3 changes live in `packages/workbench-ui/src/command/` (new + modified) + `packages/workbench-ui/src/CommandView.tsx` (10-line change) + `docs/FLOW-LEGEND.md` (new).

## Acceptance Criteria Translation

Mapping each FLOW-01 / FLOW-02 success criterion (from `.planning/REQUIREMENTS.md` lines 49–52 + `.planning/ROADMAP.md` Phase 3) to the concrete test/assertion that proves it.

| Success Criterion (from ROADMAP.md / REQUIREMENTS.md)                                                                                                                                                               | Concrete proving test/assertion                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FLOW-01.1: "Each of the eight `C-flow-economy` flows … renders as a Command Center overlay …"                                                                                                                       | (a) `flows.ts` `FLOW_TYPES.length === 8`. (b) `FlowOverlay.test.tsx` Test 1 — render with full snapshot fixture, assert ≥8 sections present. (c) `cc-reload.test.tsx` snapshot includes 8 flow sections.                                                                      |
| FLOW-01.2: "… with a documented source field and pressure trigger from existing DTOs."                                                                                                                              | (a) `flows.test.ts` fixture-assertion: `for (const ft of FLOW_TYPES) { expect(ft.sourceField ?? ft.sourceFields).toBeDefined(); }`. (b) Inline `flows.ts` per-entry leading comment per CONTEXT.md D-02 names source + pressure-trigger relationship for each of the 8 flows. |
| FLOW-01.3: "A test fixture asserts each flow has a non-null source field reference; a missing source field fails the test."                                                                                         | `flows.test.ts` fixture-assertion above is the explicit test. If any future entry omits both `sourceField` AND `sourceFields`, the test fails with `expected undefined to be defined`.                                                                                        |
| FLOW-02.1: "A 'flow legend' exists in developer docs (NOT in main UI chrome per `COMMAND-CENTER-CONTRACT.md` Slice E acceptance) mapping each flow to its substrate source, pressure trigger, and operator action." | (a) `test -f docs/FLOW-LEGEND.md` (manual / CI). (b) `grep -c '^                                                                                                                                                                                                              | ' docs/FLOW-LEGEND.md`confirms the 8-row table. (c)`grep -c '^## ' docs/FLOW-LEGEND.md`confirms 8 per-flow sections. (d) Inspection: every section names substrate source field, pressure trigger (cross-link to`pressure.ts`), operator action. |
| FLOW-02.2: "Living doc updated as flows evolve."                                                                                                                                                                    | Footer line in `docs/FLOW-LEGEND.md`: "Living doc — update when `flows.ts` adds/removes/promotes a flow." (Optional: defer CI lint that grep-asserts FLOW_TYPES ↔ FLOW-LEGEND.md sync per Claude's Discretion.)                                                               |

## Promotion Paths

Per Finding 10 — five v0.2 fallbacks. Planner's `flows.ts` per-entry comments include this verbatim:

| Flow        | Current source (v0.2)                                                                                                                          | Ideal source (post-promotion)                                                  | API endpoint hosting ideal source                                                        | Promoting phase                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| tokenFlow   | Count of `TaskSummary` by model in `phase='Dispatched'` (proxy; `unit='tasks'`)                                                                | `GatewayUsageRow.inputTokens + outputTokens` rolling 1m window per `model`     | `/api/gateway/usage` (already on snapshot per Finding 1; rolling-window aggregation TBD) | Future Workbench-hardening phase that adds rolling-window aggregation to `useCommandSnapshot()`                |
| buildPower  | Per-agent count of `t.targetAgent === agent.name && t.phase === 'Dispatched'` (open-ended; no capacity bar)                                    | `pilotEvidence.policy.maxConcurrentChildren` on TaskDetail                     | `/api/tasks/<ns>/<name>` (TaskDetail-only; not on snapshot today)                        | Future Workbench-hardening phase that adds pilotEvidence subset to TaskSummary                                 |
| podCapacity | Substrate-wide `Array.from(snapshot.tasks.values()).filter(t => t.podName !== undefined && (Dispatched\|Pending))` (open-ended)                | `ClusterNodeRow.managedPodCount` per node vs `ClusterNodeRow.capacity['pods']` | `/api/cluster/snapshot` (ClusterSnapshot — not on snapshot today)                        | Future Workbench-hardening phase that joins cluster snapshot into `useCommandSnapshot()`                       |
| authority   | Substrate-wide count of `t.phase==='Failed' && t.error?.toLowerCase().includes('policy')`                                                      | Structured `policy_denied` audit event                                         | Future SSE event kind beyond `task\|agent\|job\|pod`                                     | Future Workbench-hardening phase that adds audit-event kinds to the SSE stream                                 |
| trust       | Substrate-wide count of `(t.suspicious?.length ?? 0) > 0 \|\| (t.phase==='Failed' && t.error?.includes('verifier'))`                           | `pilotEvidence.verification.passed === false` on TaskDetail                    | `/api/tasks/<ns>/<name>` (TaskDetail-only; not on snapshot today)                        | Future Workbench-hardening phase that adds pilotEvidence subset to TaskSummary                                 |
| attention   | Substrate-wide count of `t.phase==='Failed' \|\| (t.suspicious?.length ?? 0) > 0` (stub; `label='awaiting review queue projection — Phase 4'`) | Real review-queue projection                                                   | `/api/review-queue` (Phase 4 — REV-01)                                                   | **Phase 4** (the stub flips to real projection by changing only `compute()` body; `FlowGauge` shape unchanged) |

**Note:** modelPower, artifactBandwidth — both have CLEAN sources (no v0.2 fallback comment needed). Their entries in `flows.ts` get a 1-line "Clean source" comment instead of the 4–8-line fallback block.

## Files to Create / Modify

| Path                                                                      | Action   | Purpose / one-line why                                                                                                                        |
| ------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench-ui/src/command/flows.ts`                              | CREATE   | 8-entry `FLOW_TYPES` array + `FlowGauge`/`FlowType` interfaces + derived `FlowFieldName` enum. Mirror of `pressure.ts`.                       |
| `packages/workbench-ui/src/command/FlowOverlay.tsx`                       | CREATE   | Sibling overlay rendering 8 flow sections. Mirror of `PressureOverlay.tsx` with grouped-by-kind layout + always-visible empty-state rows.     |
| `packages/workbench-ui/src/command/FlowOverlay.module.css`                | CREATE   | Dramatic + subdued class pair. Mirror of `PressureOverlay.module.css`.                                                                        |
| `packages/workbench-ui/src/command/flows.test.ts`                         | CREATE   | 16 minimum tests (8 fires + 8 absent) + 1 fixture-assertion test. Mirror of `pressure.test.ts`.                                               |
| `packages/workbench-ui/src/command/FlowOverlay.test.tsx`                  | CREATE   | 4 tests (render + reload + dramatic + subdued). Mirror of `PressureOverlay.test.tsx`.                                                         |
| `packages/workbench-ui/src/command/source-binding.ts`                     | MODIFY   | Add `export type { FlowFieldName } from './flows.js';` re-export at line ~112.                                                                |
| `packages/workbench-ui/src/command/source-binding.test.ts`                | MODIFY   | Add 1–2 tests proving `assertSourceField<FlowFieldName>` narrows correctly.                                                                   |
| `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json`         | MODIFY   | Additive: add `model` + `podName` to `fanout-005`. Existing 9-pressure-type coverage preserved; 8-flow coverage achieved.                     |
| `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap` | REGEN    | Auto-regenerated via `pnpm -C packages/workbench-ui test -- cc-reload.test.tsx --run -u` after FlowOverlay first mounts. Lands in own commit. |
| `packages/workbench-ui/src/CommandView.tsx`                               | MODIFY   | 1 import + 1 JSX block (~10 lines). Insert FlowOverlay mount at line 1414, immediately after PressureOverlay (lines 1410–1413).               |
| `docs/FLOW-LEGEND.md`                                                     | CREATE   | Developer-facing legend per FLOW-02 + D-03-A. 8-row table + per-flow section. Cites `intel/constraints.md §C-flow-economy` + Slice E.         |
| `docs/COMMAND-CENTER-CONTRACT.md`                                         | OPTIONAL | Add 1-line footer/references link to `docs/FLOW-LEGEND.md`. NOT a contract revision; ship in a SEPARATE commit if at all.                     |

**Touch surface count:** 6 new files + 5 modified files (+ 1 auto-regenerated snapshot file + 1 optional docs link). All inside `packages/workbench-ui/` and `docs/`.

## Assumptions Log

> The locked decisions in CONTEXT.md D-01..D-05 are treated as user-confirmed; not listed here. The list below is research claims tagged `[ASSUMED]` that were NOT verified in this session and that the planner should flag for confirmation if material.

| #   | Claim                                                                                                                                 | Section               | Risk if Wrong                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | The Phase 2 `cc-reload.test.tsx` snapshot diff after FlowOverlay mount will be ~30–60 new lines, not 200+.                            | Finding 6 / Pitfall 1 | LOW. If the snapshot grows much larger than expected, the planner can either (a) split into smaller fixture cases, or (b) reduce the rendered-element capture in `snapshotShape()`. Worst case is a noisy reviewable diff, not a broken test.                |
| A2  | jsdom does NOT need `IntersectionObserver` / `ResizeObserver` polyfills for FlowOverlay.                                              | Finding 9, Risk row 3 | LOW. FlowOverlay JSX is `<aside>` + `<section>` + `<ul>/<li>/<a>` — no observer APIs. PressureOverlay tests pass without polyfills. If FlowOverlay test fails with `IntersectionObserver is not defined`, planner adds a stub mock per common jsdom pattern. |
| A3  | The 5 v0.2 fallback flows can be implemented without exceeding ~30 lines per `FLOW_TYPES` entry, keeping `flows.ts` under ~400 lines. | Standard Stack table  | LOW. If `flows.ts` grows past ~400 lines, planner splits to `flows/index.ts` + per-kind sub-modules per Claude's Discretion in CONTEXT.md.                                                                                                                   |
| A4  | The buildPower flow's per-agent capacity is "open-ended undefined" in v0.2 (no capacity bar) per CONTEXT.md D-02-buildPower.          | Finding 1, buildPower | LOW (locked decision). If the operator wants a capacity bar today, they can use `agent.capabilities.length` as a proxy, but CONTEXT.md explicitly defers this. Planner respects the lock.                                                                    |
| A5  | The `pressureDramatization` env-var is properly plumbed in `../new_localai/` workbench-ui Helm overlay today (Phase 1+2 shipped).     | Project Constraints   | LOW. Phase 1+2 shipped. If absent, the Vite-inlined default-true means flows render dramatic by default in homelab — same default behavior as pressure markers. No regression.                                                                               |

If any item above proves wrong during execution, planner re-evaluates the affected finding/section and may split a wave or add a defensive task.

## Open Questions

1. **Should the planner promote tokenFlow to real `gatewayUsage`-based tokens immediately?**
   - What we know: `gatewayUsage` IS exposed on `useCommandSnapshot()` (state.ts:88), and `GatewayUsageRow` carries `inputTokens` + `outputTokens` per `model` (types.ts:272–290). The locked CONTEXT.md D-02-tokenFlow decision is to ship the task-count proxy.
   - What's unclear: Was the locked decision made knowing about the existing `gatewayUsage` exposure, or based on the (stale) assumption that it wasn't on the snapshot? CONTEXT.md uses present-tense language: "lives on `/api/gateway/usage`, NOT on the snapshot today" — which is incorrect.
   - Recommendation: Ship as locked (task-count proxy). Add a planner note in PLAN.md highlighting this finding so the operator can choose to promote in a follow-up commit if desired. The locked-shape change is small (swap the `compute()` body to sum tokens; `unit` becomes `'tokens (window)'`); the gauge interface is unchanged. Do NOT autonomously override the locked decision — discussion-phase already happened.

2. **What's the right initial CSS positioning for FlowOverlay so it doesn't collide with PressureOverlay (left, `top: 56px`) or DispositionOverlay (right, `top: 56px`)?**
   - What we know: PressureOverlay is at `top: 56px; left: 16px`, DispositionOverlay at top-right (~ `top: 56px; right: 16px`).
   - What's unclear: With 8 sections × 1–~5 gauges each, FlowOverlay needs more vertical space than PressureOverlay's 5–9 markers. A bottom-positioned overlay might be the cleanest.
   - Recommendation: Per Claude's Discretion in CONTEXT.md (CSS module split). Default suggestion: `bottom: 16px; left: 16px; max-height: 60vh; overflow-y: auto;` — keeps it out of PressureOverlay's vertical band, allows scrolling for many gauges. Planner picks; mention in PLAN.md.

3. **Should the planner add the optional `docs/COMMAND-CENTER-CONTRACT.md` references-link commit?**
   - What we know: CONTEXT.md D-03-A says "added to `docs/COMMAND-CENTER-CONTRACT.md` references section (§9 or footer) so future contributors land on it from the binding contract" — but explicitly notes "The contract itself is NOT modified to add the 8 flows inline".
   - What's unclear: Is the references-link addition part of Phase 3 or a follow-up?
   - Recommendation: Include as the LAST commit in Phase 3, separate from FLOW-LEGEND.md creation. Single-line link change; trivial review.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — every dependency confirmed in package.json + already exercised by Phase 1+2
- Architecture: HIGH — pattern is a 1:1 mirror of Phase 2's shipped `pressure.ts` / `PressureOverlay.tsx`
- Pitfalls: HIGH — pitfalls are documented in Phase 1+2 SUMMARY.md files and verified in this research
- Source field bindings: HIGH — every D-02 binding verified against types.ts and state.ts current state
- Test strategy: HIGH — every test mirrors a shipped Phase 2 test pattern

**One material divergence from CONTEXT.md flagged for planner attention:** Finding 1 / Open Question 1 — `gatewayUsage` IS on the snapshot, contrary to CONTEXT.md D-02-tokenFlow's stale claim. The locked decision still ships as a task-count proxy; planner notes the divergence in PLAN.md.

**Research date:** 2026-05-10
**Valid until:** 2026-06-09 (30 days — stable codebase; flow shape locked; no fast-moving external dependencies)

## RESEARCH COMPLETE
