---
phase: 02-command-center-contract-hardening
plan: 03
subsystem: ui
tags: [typescript, react, vitest, command-center, source-binding, pressure, cc-03, cc-04]

# Dependency graph
requires:
  - phase: 02-command-center-contract-hardening
    provides: source-binding.ts generic helpers + 4 closed-enum field-name unions (Wave 0; assertCanvasOrphan added Wave 1)
  - phase: 02-command-center-contract-hardening
    provides: pressure.ts populated with 9 PRESSURE_TYPES entries + PressureMarker / PressureType interfaces (Wave 1)
  - phase: 02-command-center-contract-hardening
    provides: PressureOverlay.tsx + PressureOverlay.test.tsx + PressureOverlay.module.css scaffolds (Wave 0)
provides:
  - PressureOverlay full <aside><ul><li><a> JSX rendering PressureMarker[] with data-source-field(s) attributes + href = marker.detailLink (CC-04)
  - PressureOverlay.module.css populated (.card top-left so it does NOT overlap DispositionOverlay; .header/.list/.row/.pressureMarker/.pressureMarkerSubdued)
  - 4 vitest tests in PressureOverlay.test.tsx (replacing the Wave 0 it.todo placeholders); committed snapshot
  - <PressureOverlay /> mounted in CommandView.tsx alongside the existing <DispositionOverlay /> with the same pressureDramatization prop
  - AgentPanel KV rows for namespace/model/modelClass/tools/capabilities (each carrying data-source-field) + in-flight + failed-1m + failed-1h counters (multi-field source-binding) + bottom "Open agent in cluster view →" deep link to #/cluster
  - TaskPanel KV rows for phase/agent/model/createdAt/startedAt/completedAt/suspicious/artifactCount/childCount + verifier/trace gap placeholders + error row source-binding + existing "Open detail →" preserved as bottom CTA
  - GatewayPanel meta row carries data-source-fields=inFlight,currentCap; conditional recentP50Ms KV row with `!= null` guard; bottom "Open in GatewayPage →" deep link
affects: [02-04, command-center, workbench-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'PressureOverlay mirrors DispositionOverlay HTML-over-canvas pattern (RESEARCH.md Pattern 3): absolutely-positioned <aside>, CSS-module class names, useMemo around classify, early-return null when empty'
    - "Conditional spread `{...(sf !== undefined ? { 'data-source-field': sf } : {})}` keeps strict-typed JSX (no attribute set to undefined) while still emitting the attribute when the marker carries it"
    - "AgentPanel failure counters use a single Date.now() snapshot per render (`const nowMs = Date.now()`) so the 1m and 1h windows share the same wallclock reference; Wave 3's reload-stability test uses vi.useFakeTimers() + vi.setSystemTime() to freeze it"
    - '`satisfies AgentSummaryFieldName` (and friends) at every source-bind call site narrows the closed-enum at the call site without forcing an `as` cast — TS 4.9+ syntax already in use across the workbench-ui package'

key-files:
  created: []
  modified:
    - packages/workbench-ui/src/command/PressureOverlay.tsx
    - packages/workbench-ui/src/command/PressureOverlay.module.css
    - packages/workbench-ui/src/command/PressureOverlay.test.tsx
    - packages/workbench-ui/src/CommandView.tsx
  fixtures-generated:
    - packages/workbench-ui/src/command/__snapshots__/PressureOverlay.test.tsx.snap

key-decisions:
  - 'PressureOverlay positioned top: 56px; left: 16px (DispositionOverlay sits top: 56px; right: 16px) — same vertical band, opposite horizontal corner so the two overlays never visually collide on common viewport sizes.'
  - 'Conditional spread for data-source-field(s) attributes (instead of explicit undefined values) sidesteps the React strict-typed JSX rejection; preserves the attribute-presence-equals-source-binding contract (Wave 3 reload-stability test only checks attribute values).'
  - "AgentPanel failure counters compute Date.now() once per render and share the same nowMs across the 1m and 1h filter windows; the recent[] iteration is O(|recent|) total per render. Reload-stability is delegated to Wave 3's vi.useFakeTimers() — encoded inline via per-render Date.now() rather than a memoized timer ref."
  - "TaskPanel verifier and trace placeholder rows render '—' / 'open task detail →' literals (no data-source-field) because the actual values live on TaskDetail (pilotEvidence.verification, traceLink), not in the snapshot. The existing 'Open detail →' link is the resolution per CONTEXT.md D-CC-03-A and Deferred Ideas."
  - 'AgentPanel namespace KV row was added even though the panelSub already shows the namespace visually — panelSub does not carry data-source-field. The new namespace row is the source-bound version and is what scrapers / Wave 3 selector trees see.'

patterns-established:
  - 'satisfies <FieldName>[] for multi-field call sites — replaces the `as <FieldName>[]` cast pattern; same closed-enum narrowing, no unsafe coercion'
  - 'Conditional attribute spread for optional DOM attributes — `{...(value !== undefined ? { attr: value } : {})}` — works with strict-typed JSX without per-attribute escape hatches'
  - 'Single-Date.now()-per-render for any AgentPanel/TaskPanel computation that crosses multiple time windows (e.g. failed-1m + failed-1h share `nowMs`) — keeps reload tests stable when paired with vi.useFakeTimers()'

requirements-completed: [CC-03, CC-04]

# Metrics
duration: ~10min
completed: 2026-05-09
---

# Phase 02 Plan 03: Wave-2 Panel Read Depth + Pressure Overlay Render Layer Summary

**Wave-2 wires the user-visible surface for CC-03 (Slice B operational read depth) and CC-04 (pressure overlay JSX). Wave 1 produced the data; Wave 2 puts it on screen with the source-binding contract enforced by `data-source-field(s)` DOM attributes — PressureOverlay full JSX + mount alongside DispositionOverlay, AgentPanel/TaskPanel/GatewayPanel inline expansion with closed-enum-narrowed source-bound KV rows.**

## Performance

- **Duration:** ~10 minutes
- **Started:** 2026-05-09T21:46:00Z
- **Completed:** 2026-05-09T21:55:00Z
- **Tasks:** 2
- **Files modified:** 4 (PressureOverlay.tsx, PressureOverlay.module.css, PressureOverlay.test.tsx, CommandView.tsx)
- **Files created:** 0 (1 generated under `__snapshots__/`)
- **Commits:** 2 task commits + 1 metadata commit (this SUMMARY.md)
- **Tests added:** 4 (replacing 4 it.todo placeholders in PressureOverlay.test.tsx)

## Accomplishments

- **CC-04 PressureOverlay JSX shipped.** Replaced the Wave-0 null-render scaffold with a full `<aside class={styles.card}><ul class={styles.list}><li class={styles.row}><a ...>label →</a></li></ul></aside>` rendering. Markers are computed by `useMemo<readonly PressureMarker[]>(() => PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot)), [snapshot])`. Each anchor carries `href={marker.detailLink}`, conditionally emits `data-source-field={marker.sourceField}` (single) or `data-source-fields={marker.sourceFields.join(',')}` (multi), and selects `styles.pressureMarker` vs `styles.pressureMarkerSubdued` via the `pressureDramatization` prop (default `true`). Empty state still returns `null` (verifies via the existing `markers.length === 0` early return).
- **PressureOverlay.module.css populated.** `.card` positioned `top: 56px; left: 16px` (DispositionOverlay sits `top: 56px; right: 16px` — same vertical band, opposite corner). Class vocabulary mirrors DispositionOverlay (`.card/.header/.list/.row/.pressureMarker/.pressureMarkerSubdued`). Color palette stays in the existing dark-navy + accent style — red accent (`#f87171`) for the pressure header (vs DispositionOverlay's amber `#fbbf24`) so the two overlays read as distinct categories without expanding the visual chrome surface.
- **4 vitest tests replace the it.todo placeholders.** Test 1 — gateway-saturation snapshot triggers the gateway pressure marker; the anchor carries `data-source-fields="inFlight,currentCap"` and `href="#/gateway"`. Test 2 — reload-stability via `snapshotShape(container)` (selectors-only — no innerHTML, per RESEARCH.md anti-pattern), captured before and after `rerender()` with the same snapshot, asserted `toEqual` AND `toMatchSnapshot`. Test 3 — `pressureDramatization={true}` applies a class containing `pressureMarker` (and not `Subdued`). Test 4 — `pressureDramatization={false}` uses the subdued class AND the model-name text remains legible.
- **PressureOverlay mounted in CommandView.tsx** immediately after the existing `<DispositionOverlay />` JSX (around line 1382), receiving the same `snapshot` and `pressureDramatization` props. No new env var introduced — Slice E base-building-only mode covers all 9 pressure types via the single global `VITE_PRESSURE_DRAMATIZATION` flag per CONTEXT.md D-CC-04-A.
- **CC-03 AgentPanel inline-expansion.** Added namespace KV row (source-bound; panelSub remains the visual subtitle), Model row gains `data-source-field`, optional Model class row when `a?.modelClass !== undefined && a.modelClass !== a?.model`, Tools row gains `data-source-field`, always-rendered Capabilities row, In flight counter (`useSourceFields(['phase', 'targetAgent'] satisfies TaskSummaryFieldName[])`), Failed (1m) + Failed (1h) counters (`useSourceFields(['phase', 'completedAt'] satisfies TaskSummaryFieldName[])`), bottom `Open agent in cluster view →` link to `#/cluster` (agents have no dedicated detail page in v0.2 per CONTEXT.md D-CC-03-A). Dev-time `assertSourceField(a, 'name')` and `assertSourceField(a, 'namespace')` calls fire before the JSX return when `a !== undefined`.
- **CC-03 TaskPanel inline-expansion.** Phase/Agent/Model rows gain `data-source-field`. Conditional createdAt/startedAt/completedAt rows render only when defined (each source-bound). Conditional Suspicious chip row when `t.suspicious !== undefined && t.suspicious.length > 0`. Always-rendered Artifacts (`artifactCount`) and Children (`childCount`) rows defaulting to 0 when undefined per CONTEXT.md D-CC-03-A. Verifier and Trace placeholder rows ('—' / 'open task detail →') document the gap that pilotEvidence.verification and traceLink live on TaskDetail, not TaskSummary — the existing `Open detail →` link is the resolution. Existing error row gains `data-source-field`. Dev-time `assertSourceField(t, 'phase' / 'targetAgent')` calls fire before the JSX return.
- **CC-03 GatewayPanel inline-expansion.** Meta row gains `data-source-fields="inFlight,currentCap"` (multi-field bind because the visible "X / Y in flight" string derives from both). Conditional `recentP50Ms` KV row gated by `row.recentP50Ms != null` (double-equals per RESEARCH.md Pitfall 3 — the field is `number | null`, not undefined). New bottom `Open in GatewayPage →` link to existing `#/gateway` route.
- **All gates green.** `pnpm -C packages/workbench-ui test -- --run` exits 0 with **67 passed + 1 todo across 8 files** (Wave 1 was 63 passed + 5 todo across 8 files; 4 todos converted to passing tests this wave). The 1 remaining todo is the cc-reload.test.tsx placeholder Wave 3 fills. `pnpm -C packages/workbench-ui exec tsc --noEmit -p tsconfig.build.json` exits 0. Pre-commit hooks (eslint --max-warnings 0 + prettier + monorepo-wide tsc -r typecheck) green on both task commits.
- **Wave 2 acceptance gate flips:** the 02-VALIDATION.md per-task verification map's CC-03 panel-render rows (AgentPanel/TaskPanel/GatewayPanel) and CC-04 PressureOverlay snapshot row flip from ❌ W0 to ✅; only the CC-02 reload-stability rows remain pending until Wave 3.

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement PressureOverlay full JSX + module.css + 4 real tests + mount in CommandView (CC-04)** — `389f13a` (feat)
2. **Task 2: Inline-expand AgentPanel/TaskPanel/GatewayPanel with Slice-B fields (CC-03)** — `3ca2381` (feat)

_Plan metadata commit (this SUMMARY.md): added separately at the end of execution._

## Files Created/Modified

- `packages/workbench-ui/src/command/PressureOverlay.tsx` — **modified.** Wave-0 null-render scaffold replaced with the full `<aside><ul><li><a>` JSX rendering one anchor per `PressureMarker`. Conditional `data-source-field` (single) or `data-source-fields` (multi-comma-joined) emitted via the conditional-spread pattern. `pressureDramatization` toggle selects `styles.pressureMarker` vs `styles.pressureMarkerSubdued`. The empty-marker case still returns `null`. Markers are computed by `useMemo<readonly PressureMarker[]>` keyed on `[snapshot]` per RESEARCH.md Pitfall 2.
- `packages/workbench-ui/src/command/PressureOverlay.module.css` — **modified.** Wave-0 placeholder replaced with `.card` (`position: absolute; top: 56px; left: 16px; z-index: 7` — same band as DispositionOverlay; opposite corner), `.header` (red accent uppercase label), `.list` / `.row` (flexbox vertical), `.pressureMarker` (subtle red glow border), `.pressureMarkerSubdued` (transparent background, slate border).
- `packages/workbench-ui/src/command/PressureOverlay.test.tsx` — **modified.** 4 it.todo placeholders replaced with 4 real tests; `makeSnapshot(overrides)` factory and `snapshotShape(container)` helper mirror the DispositionOverlay test patterns. The reload-stability test commits a snapshot file so future drift is caught.
- `packages/workbench-ui/src/CommandView.tsx` — **modified.** Imports widened: `PressureOverlay` import added; `assertCanvasOrphan` import block widened to also export `assertSourceField`, `useSourceField`, `useSourceFields`, plus type-only `AgentSummaryFieldName`, `TaskSummaryFieldName`, `GatewayCapacityFieldName`. `<PressureOverlay />` mounted alongside the existing `<DispositionOverlay />`. GatewayPanel branch (`selection.kind === 'gateway'`) gains data-source-fields on the meta row, conditional recentP50Ms row, and bottom `Open in GatewayPage →` link. AgentPanel function body gains assertSourceField pre-render calls, namespace/model/modelClass/tools/capabilities KV rows + counters + bottom `Open agent in cluster view →` link. TaskPanel function body gains assertSourceField pre-render calls, source-binding on existing rows, conditional timestamps + suspicious chips rows, always-rendered Artifacts / Children rows, Verifier / Trace gap placeholders, source-bound error row.
- `packages/workbench-ui/src/command/__snapshots__/PressureOverlay.test.tsx.snap` — **generated** by Test 2's `toMatchSnapshot()` call. Captures the selector-only shape (tag, href, source-field attrs, text) of the gateway-saturation + artifact-debt + trace markers — drift detection for future PRs.

## Decisions Made

- **`{...(sf !== undefined ? { 'data-source-field': sf } : {})}` conditional spread** for the data-source-field(s) attributes (instead of `data-source-field={sf ?? undefined}`). Setting an attribute to `undefined` causes React to still emit the attribute (with the literal string "undefined") in some test environments, AND the strict TypeScript JSX checker rejects `data-source-field={string | undefined}` against the standard HTML attribute type. The conditional spread sidesteps both: when the value is `undefined`, the attribute is not present in the spread object, so React never emits it. Wave 3's reload-stability test asserts on attribute values, so the present/absent distinction matters.
- **PressureOverlay positioned `top: 56px; left: 16px`** (DispositionOverlay sits `top: 56px; right: 16px`). Same vertical band, opposite horizontal corner. The two overlays read as separate categories at a glance without overlapping at common viewport sizes; `z-index: 7` matches DispositionOverlay so they share the same layer above the hotkey strip and below the alert ticker.
- **AgentPanel computes `Date.now()` once per render** via `const nowMs = Date.now()` and shares it across the failed-1m and failed-1h filter calls. This keeps the two counters consistent within a single render frame; reload-stability is delegated to Wave 3's `vi.useFakeTimers()` + `vi.setSystemTime()`. Caching the value per render (rather than per panel mount) keeps the counter live without binding it to a useState — a useState would force re-render on every clock tick and re-introduce the over-render concern from RESEARCH.md Pitfall 2.
- **TaskPanel Verifier and Trace rows render literal placeholders** with no `data-source-field` attribute. The actual values live on TaskDetail (`pilotEvidence.verification`, `traceLink`) and are not in the snapshot. CONTEXT.md D-CC-03-A documents these as TaskDetail-only fields; the existing `Open detail →` link is the resolution. Adding `data-source-field` placeholders pointing at TaskSummary fields would create false source-bindings; rendering literal placeholders makes the gap visible to operators and to scrapers.
- **AgentPanel always renders the Capabilities row** (rendering `'—'` when empty/undefined). Operators frequently want to answer "what is this agent for?" from the panel, and the absence of capabilities is itself information; conditionally hiding the row would silently flatten the answer.
- **`satisfies <FieldName>` (and `satisfies <FieldName>[]`)** at every source-bind call site rather than `as <FieldName>` casts. The `satisfies` operator preserves the literal type on the value while enforcing assignability to the closed-enum union — TS 4.9+ syntax already in use across the workbench-ui package. `as` casts work but lose the literal narrowing and are slightly looser at the point of inference.
- **GatewayPanel `recentP50Ms != null` (double-equals)** per RESEARCH.md Pitfall 3. The field is typed `number | null` (workbench-api maps SQL NULLs as JSON null). Using `!== undefined` would let null values through and render `null.toString()` (or interpolate as the string "null"). Double-equals catches both null and undefined in one condition.

## Deviations from Plan

None — plan executed exactly as written. Both tasks landed with their full action lists; `pnpm test --run` and `tsc --noEmit` both passed at every commit gate. The one minor mechanical adjustment was using `satisfies` instead of `as` for the closed-enum narrowing (the plan's example code used `as`; either works under TS strict, and `satisfies` is the workbench-ui norm).

## Authentication Gates

None — pure UI-package code; no auth surface touched.

## Issues Encountered

- **Pre-commit hook required Node 22, machine default is Node 23.11.1.** Resolved by running `source ~/.nvm/nvm.sh && nvm use 22` before each `git commit` (per the execution-environment note in the prompt). Both task commits passed the hook (lint-staged + monorepo-wide tsc -r typecheck) without `--no-verify`.

## User Setup Required

None — pure UI-package code under `packages/workbench-ui/src/` and `packages/workbench-ui/src/command/`. No new env vars (Slice E `VITE_PRESSURE_DRAMATIZATION` is already wired and is preserved). No new endpoints, no new substrate state, no GitOps overlay changes. Phase 2 remains read-side only; revocation is via `NODE_ENV=production` (assertions become no-ops) or `VITE_PRESSURE_DRAMATIZATION=false` (subdued visual treatment for all 9 pressure types via the single global flag).

## Next Phase Readiness

Wave 3 (02-04-PLAN.md) can begin immediately:

- All Wave-2 panel sites carry `data-source-field` (single) or `data-source-fields` (multi), so the cc-reload.test.tsx selector-tree assertion has a stable, CSS-hash-free shape to capture.
- `PressureOverlay` is mounted with the same `pressureDramatization` flag as `DispositionOverlay`; Wave 3's reload-stability test exercises both overlays under the same fixture without overlay-specific setup.
- AgentPanel's failure counters depend on `Date.now()`, so Wave 3 must use `vi.useFakeTimers()` + `vi.setSystemTime(new Date('2026-05-10T12:00:00Z'))` to freeze the wallclock — this requirement is documented in CONTEXT.md, RESEARCH.md, and 02-04-PLAN.md, and the implementation honors that contract by computing `Date.now()` once per render.
- `LayoutResult.agents` is a `ReadonlyMap` and not directly JSON-serializable; Wave 3's scene-graph snapshot must use `Object.fromEntries(layout.agents)` per RESEARCH.md Open Question 3 / Assumption A2. No Wave-2 change affects this requirement.
- 1 it.todo placeholder remains in `cc-reload.test.tsx` (Wave 0 — Wave 3 fills it). No Wave-2 todos remain.

No blockers. No concerns.

## §11 Bounds Test (Wave 2)

- **Declared capability:** every Agent / Task / Gateway selection panel surfaces operational read depth, with each rendered field carrying its substrate source field name; pressure markers render alongside dispositions with the same source-binding contract.
- **Bounded resource drain:** PressureOverlay wraps `PRESSURE_TYPES.flatMap(pt => pt.classify(snapshot))` in `useMemo([snapshot])` (RESEARCH.md Pitfall 2); AgentPanel failure counters are O(|recent|) per render with a single `Date.now()` snapshot shared across windows; GatewayPanel meta-row data-source-fields adds one DOM attribute per row (no layout cost). Production builds skip the dev-only `assertSourceField` calls — runtime cost is identical to Wave 1 in production.
- **Observable state transition:** vitest count climbs from 63 passed + 5 todo (Wave 1) to 67 passed + 1 todo (Wave 2) — 4 todos converted to passing tests; the new tests assert on `data-source-field(s)` attribute values, not class strings, so the snapshot is CSS-hash-stable.
- **Auditable output:** `pnpm -C packages/workbench-ui test -- --run` runs in CI; the `__snapshots__/PressureOverlay.test.tsx.snap` file captures the selector-only marker shape and surfaces drift on future PRs. The new panel additions are scrapeable via `[data-source-field], [data-source-fields]` selectors — Wave 3 enumerates them deterministically.
- **Revocation path:** `NODE_ENV=production` disables all `assertSourceField` calls (existing Phase-1 behavior preserved); `VITE_PRESSURE_DRAMATIZATION=false` toggles to the subdued class for all 9 pressure types via the existing single-global-flag pattern. Pure UI-package code; a single revert removes Wave 2 (pressure.ts and source-binding.ts from Wave 1 remain intact and continue to be importable).

## §15 One-Sentence Test (Wave 2)

Inline-expanding the existing selection panels with source-bound KV rows and rendering the nine pressure types as a sibling overlay strengthens operator read depth and legibility of failure pressure — both pure UI surface, both honoring the Prime Directive's "every visible element derives from a substrate source" requirement.

## Self-Check: PASSED

All 4 modified files were touched and remain green:

- ✓ packages/workbench-ui/src/command/PressureOverlay.tsx (full JSX; useMemo + conditional spread)
- ✓ packages/workbench-ui/src/command/PressureOverlay.module.css (.card top-left; .pressureMarker / .pressureMarkerSubdued)
- ✓ packages/workbench-ui/src/command/PressureOverlay.test.tsx (4 real tests; 0 it.todo)
- ✓ packages/workbench-ui/src/CommandView.tsx (PressureOverlay import + mount; AgentPanel/TaskPanel/GatewayPanel additions)

Both task commits exist in git log:

- ✓ 389f13a feat(02-03): implement PressureOverlay JSX + mount in CommandView (CC-04)
- ✓ 3ca2381 feat(02-03): inline-expand AgentPanel/TaskPanel/GatewayPanel with Slice-B fields (CC-03)

Verification gates green:

- ✓ `pnpm -C packages/workbench-ui test -- --run` → 67 passed + 1 todo across 8 files (no failures)
- ✓ `pnpm -C packages/workbench-ui exec tsc --noEmit -p tsconfig.build.json` → exit 0
- ✓ Pre-commit hooks (eslint --max-warnings 0 + prettier + monorepo-wide tsc -r typecheck) green on both task commits

Acceptance criteria spot-check:

- ✓ `grep -E "^export const PressureOverlay" packages/workbench-ui/src/command/PressureOverlay.tsx` → 1 line
- ✓ `grep -E "PRESSURE_TYPES.flatMap" packages/workbench-ui/src/command/PressureOverlay.tsx` → 1 line
- ✓ `grep -E "data-source-field" packages/workbench-ui/src/command/PressureOverlay.tsx` → ≥1 line
- ✓ `grep -E "data-source-fields" packages/workbench-ui/src/command/PressureOverlay.tsx` → ≥1 line
- ✓ `grep -E "pressureDramatization \\? styles\\.pressureMarker : styles\\.pressureMarkerSubdued" packages/workbench-ui/src/command/PressureOverlay.tsx` → 1 line
- ✓ `grep -E "^\\.pressureMarker" packages/workbench-ui/src/command/PressureOverlay.module.css` → 1+ lines
- ✓ `grep -E "^\\.pressureMarkerSubdued" packages/workbench-ui/src/command/PressureOverlay.module.css` → 1 line
- ✓ `grep -E "import \\{ PressureOverlay \\} from './command/PressureOverlay\\.js'" packages/workbench-ui/src/CommandView.tsx` → 1 line
- ✓ `grep -E "<PressureOverlay" packages/workbench-ui/src/CommandView.tsx` → 1 line (the mount JSX)
- ✓ `grep -c "it.todo" packages/workbench-ui/src/command/PressureOverlay.test.tsx` → 0
- ✓ `grep -cE "^  it\\(" packages/workbench-ui/src/command/PressureOverlay.test.tsx` → 4
- ✓ `grep -E "data-source-field=\\{useSourceField\\('capabilities'" packages/workbench-ui/src/CommandView.tsx` → 1 line
- ✓ `grep -E "data-source-field=\\{useSourceField\\('modelClass'" packages/workbench-ui/src/CommandView.tsx` → 1 line
- ✓ `grep -cE "useSourceFields\\(" packages/workbench-ui/src/CommandView.tsx` → 4 lines (in-flight + 1m + 1h + gateway meta)
- ✓ `grep -E "data-source-field=\\{useSourceField\\('createdAt'" packages/workbench-ui/src/CommandView.tsx` → 1 line
- ✓ `grep -E "data-source-field=\\{useSourceField\\('suspicious'" packages/workbench-ui/src/CommandView.tsx` → 1 line
- ✓ `grep -E "data-source-field=\\{useSourceField\\('artifactCount'" packages/workbench-ui/src/CommandView.tsx` → 1 line
- ✓ `grep -E "data-source-field=\\{useSourceField\\('childCount'" packages/workbench-ui/src/CommandView.tsx` → 1 line
- ✓ `grep -E "data-source-field=\\{useSourceField\\('recentP50Ms'" packages/workbench-ui/src/CommandView.tsx` → 1 line
- ✓ `grep -E "row\\.recentP50Ms != null" packages/workbench-ui/src/CommandView.tsx` → 1 line
- ✓ `grep -cE 'href="#/gateway"' packages/workbench-ui/src/CommandView.tsx` → 2 (existing route helper plus the new bottom link)
- ✓ `grep -cE 'href="#/cluster"' packages/workbench-ui/src/CommandView.tsx` → 2 (existing helper plus the new AgentPanel bottom link)
- ✓ `grep -c "Open detail" packages/workbench-ui/src/CommandView.tsx` → ≥1 (existing TaskPanel link preserved)

---

_Phase: 02-command-center-contract-hardening_
_Completed: 2026-05-09_
