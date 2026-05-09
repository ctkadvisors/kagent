---
status: complete
phase: 01-agentdisposition-v0
plan: 04
subsystem: workbench-ui
tags:
  [
    workbench-ui,
    command-center,
    disposition,
    react,
    vite,
    vitest,
    cc-01,
    source-binding,
    slice-e,
  ]

# Dependency graph
requires:
  - phase: 01-agentdisposition-v0/01-01
    provides:
      - vitest + jsdom + @testing-library/react infra in @kagent/workbench-ui
      - DispositionOverlay parser + label/annotation constants in @kagent/dto
  - phase: 01-agentdisposition-v0/01-02
    provides:
      - operator-written kagent.knuteson.io/proposals-today annotation
        (the source @kagent/workbench-api reads to compute proposalsToday)
  - phase: 01-agentdisposition-v0/01-03
    provides:
      - DispositionOverlayRow + assertIsDispositionOverlayRow in @kagent/dto
      - GET /api/dispositions endpoint returning { items: DispositionOverlayRow[] }
provides:
  - fetchDispositions() in workbench-ui/src/api.ts (runtime-validated)
  - CommandSnapshot.dispositions: ReadonlyMap<string, DispositionOverlayRow>
  - useCommandSnapshot mount-time + agent-SSE + 30s-poll refetch wiring
  - assertSourceField + useSourceField (single) and assertSourceFields +
    useSourceFields (multi-field for computed values per Codex HIGH #5)
    helpers in workbench-ui/src/command/source-binding.ts
  - DispositionOverlay React component + CSS module
  - VITE_PRESSURE_DRAMATIZATION env-var wiring (Slice E base-building-only mode)
  - @kagent/dto/disposition sub-path export (browser-safe leaf import)
affects:
  - Phase 1 closure / promotion-gate evidence (operators see disposition state in Command Center)

# Tech tracking
tech-stack:
  added:
    - '@kagent/dto workspace dep on @kagent/workbench-ui (was previously type-only / absent)'
    - '@kagent/dto/disposition sub-path package export (browser-safe leaf path, no node:crypto pull-in)'
  patterns:
    - 'CC-01 disposition slice: every visible field carries data-source-field (single) OR data-source-fields (multi, comma-joined) attribute pointing at DispositionOverlayRow keys'
    - 'Multi-field source-binding helper for COMPUTED rendered values per Codex HIGH #5 (e.g., "tokens remaining" = idleBehavior.attentionBudget.tokensPerDay − spentTokensToday lists BOTH inputs)'
    - 'Reload-stable rendering: zero client-side persistence; refetch on mount + agent SSE + 30s poll'
    - 'Stable-selector-tree snapshot test (data-source-field(s) + data-agent-ref + textContent) instead of innerHTML — survives CSS-module hash drift across Vite builds (OpenCode LOW #8)'
    - 'globalThis-cast process.env.NODE_ENV read so source-binding stays @types/node-free in the workbench-ui'
    - 'Slice E base-building-only fallback gated by VITE_PRESSURE_DRAMATIZATION env var — same data, subdued CSS class'

key-files:
  created:
    - packages/workbench-ui/src/api.test.ts
    - packages/workbench-ui/src/command/state.test.ts
    - packages/workbench-ui/src/command/source-binding.ts
    - packages/workbench-ui/src/command/source-binding.test.ts
    - packages/workbench-ui/src/command/DispositionOverlay.tsx
    - packages/workbench-ui/src/command/DispositionOverlay.module.css
    - packages/workbench-ui/src/command/DispositionOverlay.test.tsx
    - packages/workbench-ui/src/command/__snapshots__/DispositionOverlay.test.tsx.snap
  modified:
    - packages/workbench-ui/package.json
    - packages/workbench-ui/src/types.ts
    - packages/workbench-ui/src/api.ts
    - packages/workbench-ui/src/command/state.ts
    - packages/workbench-ui/src/CommandView.tsx
    - packages/dto/package.json
    - pnpm-lock.yaml

key-decisions:
  - 'D-DISP-04-A: Single source of truth across the substrate-API-UI boundary — DispositionOverlayRow is imported from @kagent/dto/disposition in workbench-ui (the type the workbench-api emits); no UI-side mirror. Schema drift surfaces at the assertIsDispositionOverlayRow runtime guard.'
  - 'D-DISP-04-B: useCommandSnapshot returns the snapshot directly (existing pattern); the plan suggested a `{ snapshot, ... }` wrapper, but adapting to the existing flat-return shape is the correct integration with Mission/Replay/HoverPreview/SelectionPanel/ActivityLog all of which already pass `snapshot={snapshot}` props from the flat hook return.'
  - 'D-DISP-04-C: Refetch trigger set: mount once + every SSE agent-cache event + 30s polling interval. The workbench SSE stream does not emit ConfigMap-only changes (the operator writes proposals-today annotations from cap-issuer per plan 02), so polling is the v0.2 bridge for overlay create/delete/annotation changes without adding a new informer/SSE kind. 30s chosen as a balance between freshness and request rate; tighter polling can be a v0.3 tuning.'
  - 'D-DISP-04-D: Multi-field source-binding helper introduced per Codex HIGH #5. Computed values (tokens remaining = budget − spent; over-budget delta = spent − budget) MUST list ALL inputs via assertSourceFields/useSourceFields. Single-source values (overBudget boolean, overBudgetEventCountToday count) keep the singular helper. Comma-separated DOM attribute (data-source-fields) is what future CC-01 scrapers parse.'
  - 'D-DISP-04-E: Reload-stability test uses a stable selector tree (data-source-field(s) attributes + data-agent-ref + textContent) instead of container.innerHTML or container.outerHTML. CSS-module class names carry per-build hash suffixes (e.g., `_metricValue_045408`); raw HTML snapshots would fail spuriously across Vite builds (OpenCode LOW #8 mitigation).'
  - 'D-DISP-04-F: postsToday is NOT surfaced in the UI. The DTO already locks it to TypeScript literal `0`; this plan also ensures no "Posts:" label is rendered. Test 9 verifies via `screen.queryByText(/posts/i)` returning null. Posts/Channels graduate from Future Research before this changes.'
  - 'D-DISP-04-G: Slice E pressure dramatization is a CSS class swap, not a data swap. When VITE_PRESSURE_DRAMATIZATION=false the same delta numbers render with the subdued .pressureMarkerSubdued class instead of .pressureMarker; the .pressureDramatic emphasis class is replaced with .metricValue. The data binding (data-source-field(s) attribute) is identical in both modes, so an inspector debugging session sees the same DOM structure regardless of the visual mode.'
  - 'D-DISP-04-H: @kagent/dto/disposition sub-path package export was added to keep the workbench-ui Vite production build browser-safe. Importing from the @kagent/dto barrel pulled `dto/src/map.ts` into the bundle, which uses `node:crypto` (the index.ts re-exports map). The leaf module @kagent/dto/disposition has zero Node-only deps and is the correct surgical scope for the workbench-ui consumer. Operator and workbench-api keep using the barrel import unchanged.'
  - 'D-DISP-04-I: source-binding.ts reads process.env.NODE_ENV through `globalThis` with an inline cast rather than the global `process` reference. The workbench-ui''s tsconfig.build.json (vite/client types only) does NOT include `node` types — this avoids taking @types/node as a UI dep while still letting vitest''s `vi.stubEnv("NODE_ENV", "production")` correctly disable the assertions in the prod-mode tests.'

patterns-established:
  - 'CC-01 source-binding helper pattern (assertSourceField + assertSourceFields + DOM-attribute partner functions) — generalizable to other Command Center slices in Phase 2.'
  - 'Browser-safe sub-path package exports for cross-tier DTOs — pattern for any DTO that is structurally pure-data but lives in a package whose barrel re-exports include Node-only modules.'
  - 'Selector-tree snapshot tests — pattern for any UI test that wants reload-stability proof without becoming brittle to CSS-module hash changes across builds.'
  - 'globalThis-cast process reference — pattern for any UI module that needs NODE_ENV-aware behavior but should not take a @types/node devDep.'

requirements-completed: [DISP-04]

# Metrics
duration: ~1h (single worktree session, tasks 1-4 atomic commits)
completed: 2026-05-09
---

# Phase 01 Plan 04: DispositionOverlay (DISP-04) Summary

**Workbench Command Center now renders a per-Agent disposition overlay alongside Mission and Replay — every rendered field carries a `data-source-field` (or comma-joined `data-source-fields` for computed values) attribute pointing at a `DispositionOverlayRow` key, satisfying the COMMAND-CENTER-CONTRACT.md §2 Prime Directive scoped to the disposition slice. State derives entirely from `GET /api/dispositions` (refetch on mount + every SSE agent event + 30s poll); no client-side persistence; reload-stable by construction. Slice E pressure dramatization is gated by `VITE_PRESSURE_DRAMATIZATION` for base-building-only deployments. ROADMAP success criterion 4 (budget remaining AND over-budget event count per agent) is satisfied via `tokensRemaining` / `proposalsRemaining` blocks plus a separately-rendered `overBudgetEventCountToday` element.**

## Status

**COMPLETE.** Tasks 1-4 (implementation) committed atomically on the worktree branch and merged to main; Task 5 (checkpoint:human-verify) approved by user via end-to-end homelab cluster verification on 2026-05-09. See "Cluster verification (Task 5)" section below for evidence.

## Performance

- **Duration:** ~1h (single worktree session, tasks 1-4 atomic commits, no checkpoints encountered before the plan-level checkpoint)
- **Completed (tasks 1-4):** 2026-05-09
- **Tasks:** 4 / 5 implementation; task 5 = human-verify checkpoint
- **Files modified:** 15 (8 created, 7 modified) across `packages/workbench-ui` and `packages/dto`

## Accomplishments

- Lands DISP-04 (REQ-DISP-04). Workbench-ui imports the SAME `DispositionOverlayRow` type the workbench-api emits (single source of truth across the substrate-API-UI boundary per plan 03 D-DISP-03-A).
- `fetchDispositions()` in `src/api.ts` runs `assertIsDispositionOverlayRow` on every row — the UI side bites when the API drifts. Throws on non-2xx (matches `fetchTasks` pattern; the disposition projection is an explicit Command Center surface, not a "tolerable empty list").
- `useCommandSnapshot` extended with `dispositions: ReadonlyMap<string, DispositionOverlayRow>`. Refetch triggers: mount-once + every SSE 'agent' cache event (rows are agentRef-keyed) + 30s `setInterval` (the v0.2 bridge for ConfigMap-only changes — the operator writes proposals-today annotations per plan 02 but no SSE event covers them today). Cleanup on unmount.
- `source-binding.ts` exports `assertSourceField` + `useSourceField` (single) and `assertSourceFields` + `useSourceFields` (multi). Multi-field variant satisfies Codex HIGH #5: computed rendered values list ALL inputs in a comma-joined attribute. Dev-only assertion (NODE_ENV-gated via `globalThis.process` read); zero overhead in production bundles.
- `DispositionOverlay.tsx` renders one `<li>` per Agent: tokens block (multi-field), proposals block (multi-field), eventCount block (single-field, rendered ONLY when `overBudget=true` per Test 12), pressure-marker anchors per reason (single anchor for tokens_exceeded / proposals_exceeded; both for `'both'`). Detail link points at the existing `/agents/:ns/:name` route — no new routes added per Slice E acceptance.
- CSS module mirrors `Mission.module.css` aesthetics — anchored dark-navy card, amber accent, monospace. NO painted/skinned chrome. RTS feel = USABILITY (per project memory): clear numeric labels + inspector-visible source binding.
- Slice E base-building-only fallback gated by `VITE_PRESSURE_DRAMATIZATION` env var. When false, the same delta numbers render with subdued CSS classes; the data binding (data-source-field attributes) is identical in both modes.
- 27 new tests (5 + 5 + 10 + 12) green; full UI suite at 32/32; full @kagent/dto suite at 63/63 (regression check); full @kagent/workbench-api suite at 174/174 (regression check); typecheck clean; production Vite build green (315.9KB JS / 42.2KB CSS).

## Task Commits

Each task committed atomically on the worktree branch `worktree-agent-a689ec33eeb16b0fa`:

1. **Task 1 — fetchDispositions + useCommandSnapshot extension:** `6c74ae4` (feat)
2. **Task 2 — CC-01 disposition-slice source-binding helpers:** `2d68301` (feat)
3. **Task 3 — DispositionOverlay component + reload-stability + base-building-only:** `1127c6b` (feat)
4. **Task 4 — Mount in CommandView + sub-path export + globalThis cast:** `5cdf22f` (feat)
5. **Worktree → main merge:** `4aafc74` (merge)
6. **Post-tag CI fix (eslint no-unnecessary-type-assertion in DispositionOverlay.test.tsx):** `d40d8f6` (fix) — required to pass CI; v0.2.0-disp-rc.1 tag was deleted + re-cut here. (Companion CI fix `cc528a9` covered prettier on `01-RESEARCH.md` + `.gitignore` for `.playwright-mcp/`.)
7. **SUMMARY closure (this commit):** docs commit on main flipping status → complete and embedding cluster verification evidence.

## Files Created/Modified

Created (8):

- `packages/workbench-ui/src/api.test.ts` — 5 vitest cases covering happy path, non-2xx, schema-drift rejection, empty + missing items defaults.
- `packages/workbench-ui/src/command/state.test.ts` — 5 vitest cases (renderHook + waitFor + fake timers) covering Map-keyed-by-agentRef, SSE agent triggers refetch, SSE task does NOT, single mount-time fetch, periodic 30s tick + unmount cleanup. Uses `vi.mock('../api.js')` to inject mocks; the SSE shim captures the `onCache` callback so tests dispatch synthetic events directly (the same seam the existing agents-side refetch uses; documented in the test header).
- `packages/workbench-ui/src/command/source-binding.ts` — 4 exports: `assertSourceField`, `useSourceField`, `assertSourceFields`, `useSourceFields`. ~140 lines including module JSDoc that links to COMMAND-CENTER-CONTRACT.md §2 Prime Directive.
- `packages/workbench-ui/src/command/source-binding.test.ts` — 10 tests covering single-field pass/throw/no-op/passthrough/closed-key-list and multi-field pass/throw/no-op/comma-join.
- `packages/workbench-ui/src/command/DispositionOverlay.tsx` — ~190 lines. Per-row rendering with multi-field source binds for computed values, single-field for direct DTO bindings, conditional eventCount, pressure-marker anchors with detail links.
- `packages/workbench-ui/src/command/DispositionOverlay.module.css` — anchored card, mirrors Mission's aesthetic. Class names: card, header, list, row, agent, namespace, metric, metricLabel, metricValue, eventCount, pressureDramatic, pressureMarker, pressureMarkerSubdued.
- `packages/workbench-ui/src/command/DispositionOverlay.test.tsx` — 12 cases covering in-budget, over-budget (3 reasons), base-building-only, empty state, reload-stability (stable selector tree, NOT innerHTML), dev-mode assertion fires, postsToday suppressed, detail link href, eventCount rendered+pluralization, eventCount suppressed when not over-budget.
- `packages/workbench-ui/src/command/__snapshots__/DispositionOverlay.test.tsx.snap` — frozen selector tree for the reload-stability test.

Modified (7):

- `packages/workbench-ui/package.json` — added `@kagent/dto: workspace:*` runtime dep.
- `packages/workbench-ui/src/types.ts` — re-exports `DispositionOverlayRow`, `DispositionProposalKind`, `DispositionOverBudgetReason` from `@kagent/dto/disposition`. Documented JSDoc note about the cross-tier DTO exception to the leaf-deps-only convention.
- `packages/workbench-ui/src/api.ts` — added `fetchDispositions()` import + function.
- `packages/workbench-ui/src/command/state.ts` — added `dispositions` state slot + `refetchDispositions()` + mount call + agent-SSE call + 30s `setInterval` + unmount cleanup. Exported `CommandSnapshot.dispositions`.
- `packages/workbench-ui/src/CommandView.tsx` — added `DispositionOverlay` import + module-level `pressureDramatization` env-var read + mount alongside MissionOverlay. Existing Mission/Replay mount logic unchanged.
- `packages/dto/package.json` — added `./disposition` sub-path export so the workbench-ui can import the leaf module without pulling `dto/src/map.ts`'s `node:crypto` into the Vite browser bundle.
- `pnpm-lock.yaml` — refreshed for the new workspace dep.

## Plan-level verifications

All checks PASSED. Reproducible from the SHAs above:

- `pnpm --filter @kagent/workbench-ui exec vitest run src/api.test.ts src/command/state.test.ts` — **10 / 10 tests pass**
- `pnpm --filter @kagent/workbench-ui exec vitest run src/command/source-binding.test.ts` — **10 / 10 tests pass**
- `pnpm --filter @kagent/workbench-ui exec vitest run src/command/DispositionOverlay.test.tsx` — **12 / 12 tests pass**
- `pnpm --filter @kagent/workbench-ui test` (full UI suite) — **32 / 32 tests pass**
- `pnpm --filter @kagent/workbench-ui typecheck` — **clean** (no errors)
- `pnpm --filter @kagent/workbench-ui build` — **clean** Vite production build (315.9 KB JS / 42.2 KB CSS gzipped to 98.6 KB / 8.3 KB)
- `pnpm --filter @kagent/dto test` — **63 / 63 tests pass** (regression check, sub-path export added)
- `pnpm --filter @kagent/workbench-api test` — **174 / 174 tests pass** (regression check, dto barrel import unchanged)
- `grep -c "data-source-field\|data-source-fields\|assertSourceField\|assertSourceFields\|useSourceField\|useSourceFields" packages/workbench-ui/src/command/DispositionOverlay.tsx` returns **16** (>=10 required)
- `grep -c "data-source-fields" packages/workbench-ui/src/command/DispositionOverlay.tsx` returns **5** (>=4 required — every computed rendering uses multi-field per Codex HIGH #5)
- `grep -n "overBudgetEventCountToday" packages/workbench-ui/src/command/DispositionOverlay.tsx` returns **5 lines** (>=2 required — Codex HIGH #4 / ROADMAP S.C.4)
- `grep -c "Posts:\|posts:" packages/workbench-ui/src/command/DispositionOverlay.tsx` returns **0** (postsToday not surfaced)
- `grep -c "container.innerHTML" packages/workbench-ui/src/command/DispositionOverlay.test.tsx` returns **0** (selector-tree test instead per OpenCode LOW #8)
- `grep -c "promote\|promotion\|MobProposal\|CoalitionProposal" packages/workbench-ui/src/command/DispositionOverlay.{tsx,test.tsx,module.css}` returns **0** in all three files (D6 self-proposal terminology honored)
- `grep -c "fetch.*method.*POST\|fetch.*method.*PATCH\|fetch.*method.*PUT" packages/workbench-ui/src/api.ts packages/workbench-ui/src/command/DispositionOverlay.tsx packages/workbench-ui/src/command/state.ts` shows the disposition slice introduces **0 new** write surfaces (the existing `createTask`/`patchModelEndpointInFlight` are pre-existing).

## Component tree summary

```
CommandView (packages/workbench-ui/src/CommandView.tsx)
  ├── module-level: const pressureDramatization = (import.meta.env.VITE_PRESSURE_DRAMATIZATION !== 'false')
  ├── const snapshot = useCommandSnapshot()  ← reads /api/dispositions on mount + agent SSE + 30s poll
  └── render
      ├── ... existing Mission / Replay / Minimap / SelectionPanel / etc ...
      └── <DispositionOverlay
            snapshot={snapshot}                           ← snapshot.dispositions feeds the overlay
            pressureDramatization={pressureDramatization} ← Slice E gate
          />
            └── <aside className={card}>
                  └── <ul className={list}>
                      └── <li data-agent-ref={agentRef}>
                          ├── <div data-source-fields="spentTokensToday,idleBehavior">
                          │     {tokens block — remaining or over budget}
                          ├── <div data-source-fields="proposalsToday,idleBehavior">
                          │     {proposals block}
                          ├── (overBudget) <div data-source-field="overBudgetEventCountToday">
                          │                  {N event(s) today}
                          └── (overBudget reason) <a data-source-fields="..." href="/agents/ns/name">
                                                    {pressure marker}
```

## assertSourceField — relationship to future CC-01 generalization

`source-binding.ts` is a Phase 1 / DISP-04 implementation of the CC-01 (REQUIREMENTS.md / `docs/COMMAND-CENTER-CONTRACT.md` §2) Prime Directive scoped to the disposition slice. It is intentionally NOT generalized:

- The closed `DispositionFieldName` union is the type-system primary defense — the runtime guard exists for synthesized-fixture test runs and dev-mode debugging.
- The DOM attributes (`data-source-field`, `data-source-fields`) are scrapeable. A future CC-01 generalization can walk the DOM at test time, gather every `data-source-field*` attribute, intersect against the substrate's known DTO field names, and assert no orphans. Phase 1 ships the data; Phase 2 ships the cross-cutting scraper.
- The multi-field variant exists because computed rendered values (e.g., "tokens remaining") have multiple inputs. A single `data-source-field` attribute would be a lie of omission. The comma-joined `data-source-fields` form is the Phase 2 scraper's parse target.

## Reload-stability proof — how the API alone reconstructs the overlay

1. `useCommandSnapshot` runs once on mount, calling `refetchDispositions()`. The promise resolves with the API's `{ items: DispositionOverlayRow[] }`; each row passes `assertIsDispositionOverlayRow`; the UI commits a fresh `Map` keyed by agentRef.
2. The same effect installs an SSE subscription. On every `'agent'` cache event the hook calls `refetchDispositions()` (rows are agentRef-keyed, so any agent-cache change is a reasonable refresh trigger).
3. The same effect installs a `setInterval(refetchDispositions, 30_000)`. The workbench SSE stream does not currently emit ConfigMap-change events; the operator's `kagent.knuteson.io/proposals-today` annotation writes (per plan 02) are not visible to SSE. The 30s poll is the v0.2 bridge for both annotation changes AND overlay create/delete via GitOps.
4. Effect cleanup (unmount) closes the SSE subscription and clears both intervals — no leaks.
5. `<DispositionOverlay>` is a pure render of `snapshot.dispositions`. There is no `useState`, `useReducer`, or `useRef` inside the overlay component. Every visible value is a deterministic function of the DTO instance.
6. Reload-stability is verified by `DispositionOverlay.test.tsx` Test 7: render twice with the same snapshot, capture the selector tree both times (data-source-field(s) attributes + data-agent-ref + textContent — NOT className strings, which carry CSS-module hashes), assert structural equality, and freeze with `toMatchSnapshot()`.

## Slice E base-building-only mode wiring

```
vite (build/dev)
  └── VITE_PRESSURE_DRAMATIZATION env var
        ↓ (Vite inlines import.meta.env at build time)
  CommandView.tsx
    └── const pressureDramatization: boolean
          = import.meta.env.VITE_PRESSURE_DRAMATIZATION !== 'false'
        ↓
  <DispositionOverlay pressureDramatization={pressureDramatization}>
        ↓ (per row, conditional CSS class)
  className={tokensExceeded && pressureDramatization
              ? styles.pressureDramatic   ← amber pulse
              : styles.metricValue}        ← subdued
  className={pressureDramatization
              ? styles.pressureMarker        ← amber outlined anchor
              : styles.pressureMarkerSubdued} ← grey outlined anchor
```

The data binding is invariant: every `data-source-field*` attribute is identical in both modes. Inspector-driven debugging gets the same DOM structure regardless of the visual mode.

Phase 2 / 3 generalizes this to other overlays by lifting the env-var read into a `useUiConfig()` hook (or context provider) and threading the flag through every overlay's prop signature. Phase 1 keeps it scoped to the disposition slice — no over-design.

## Cluster verification (Task 5 — end-to-end on homelab K3s)

User-approved end-to-end verification, 2026-05-09. Path A (homelab) ran; Path B (local stub) was not needed.

**Tag cut:** `v0.2.0-disp-rc.1` published to `ghcr.io/ctkadvisors/kagent-*` 2026-05-09T20:49Z. Initial tag cut, deleted, and re-cut at `d40d8f6` after post-tag CI fixes landed.

**Repo SHAs at verification:**

- `kagent` @ tag `v0.2.0-disp-rc.1` → `d40d8f6` (eslint CI fix on DispositionOverlay.test.tsx)
- `new_localai` @ `c5bb7fd` — image-tag bump in `clusters/k3s-homelab/apps/kagent/overlays/homelab` (operator + workbench-api + workbench-ui all to `v0.2.0-disp-rc.1`)
- `new_localai` @ `10f592f` — three demo disposition ConfigMap overlays added to GitOps:
  - `kagent-system/orchestrator-disposition` (broad scope, 500k tokens/day)
  - `kagent-rc-spectrum/rc-spectrum-fanout-orchestrator-disposition` (templates-only, 100k tokens/day)
  - `kagent-system/summarizer-rust-disposition` (small budget, 1 proposal/day)

**ArgoCD sync:** `kagent` (operator) and `kagent-workbench` (api + ui) Applications synced cleanly to the new images.

**Pod state at verification:**

```
NAMESPACE     POD                                    READY   STATUS    IMAGE
kagent-system kagent-workbench-557c79fddf-72f7z      2/2     Running   ghcr.io/.../v0.2.0-disp-rc.1
```

**Live API verification (in-pod `node fetch` against `localhost`):** `GET /api/dispositions` returned a `DispositionOverlayRow[]` with all three demo overlays (orchestrator, rc-spectrum-fanout-orchestrator, summarizer-rust), and `dailyBoundaryUtc=2026-05-09T00:00:00Z`. All rows passed `assertIsDispositionOverlayRow` at the projection boundary.

**User visual verification (Chris, on the workbench Command Center):**

> "it looks the same as before with a few more items"

Three new disposition rows render alongside the existing flow-economy widgets (Mission, Replay, Minimap, SelectionPanel, ActivityLog) — DOM source-binding attributes (`data-source-field`, `data-source-fields`) intact and inspector-visible per CC-01 §2 contract. Approved.

This satisfies plan 04 Task 5 (checkpoint:human-verify) and ROADMAP success criterion 4 end-to-end on a real K3s cluster against real operator-written `kagent.knuteson.io/proposals-today` annotations.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] @kagent/dto barrel import pulled `node:crypto` into the Vite browser bundle**

- **Found during:** Task 4 (`pnpm --filter @kagent/workbench-ui build`)
- **Issue:** Adding `@kagent/dto: workspace:*` as a runtime dep made the workbench-ui import the package's barrel (`src/index.ts`), which re-exports `map.ts` — `map.ts` imports `createHash` from `node:crypto`. Vite's Rollup-driven prod build (correctly) refused to bundle Node-only crypto for a browser target.
- **Fix:** Added a `./disposition` sub-path export to `packages/dto/package.json`. The workbench-ui imports `DispositionOverlayRow` and `assertIsDispositionOverlayRow` directly from `@kagent/dto/disposition` (a leaf module with zero Node-only deps). Operator and workbench-api keep using the `@kagent/dto` barrel import unchanged.
- **Files modified:** `packages/dto/package.json` (sub-path export added); `packages/workbench-ui/src/types.ts`, `src/api.ts`, `src/api.test.ts`, `src/command/source-binding.ts`, `src/command/source-binding.test.ts`, `src/command/DispositionOverlay.tsx`, `src/command/DispositionOverlay.test.tsx` (import paths swapped).
- **Commit:** `5cdf22f` (Task 4 commit message documents the surgery in detail)

**2. [Rule 3 - Blocking] `process` reference in source-binding.ts failed typecheck under tsconfig.build.json (vite/client types only, no `node`)**

- **Found during:** Task 4 (typecheck after sub-path import switch)
- **Issue:** `source-binding.ts` reads `process.env.NODE_ENV` so vitest's `vi.stubEnv("NODE_ENV", "production")` correctly disables the assertions in the prod-mode tests. But the workbench-ui's tsconfig.build.json does NOT include `node` in its types — adding `@types/node` as a UI devDep would be heavier than necessary.
- **Fix:** Read `process` through `globalThis` with an inline cast: `const proc = (globalThis as unknown as { process?: { env?: ... } }).process;`. Typecheck-clean without node types; runtime-safe in Node/vitest (process is on globalThis); a no-op when bundled for the browser (process undefined → fall through to `import.meta.env.DEV`).
- **Files modified:** `packages/workbench-ui/src/command/source-binding.ts`.
- **Commit:** `5cdf22f` (Task 4 commit message documents this fix as well)

**3. [Rule 1 - Test fix] `screen.getByText` with regex matched multiple ancestors in DispositionOverlay.test.tsx**

- **Found during:** Task 3 first test run
- **Issue:** `screen.getByText(/\+5,000 over budget/)` (Test 5) and `screen.getByText('1 event today')` (Test 11) both threw "Found multiple elements" because testing-library matches a node when its element textContent matches the regex/string — and a wrapping element's textContent contains the inner element's text. The `metric` div's textContent includes the inner span's value text, so both matched.
- **Fix:** Test 5 switched to `screen.getAllByText(...).length >= 1` (presence assertion, not uniqueness). Test 11 switched to a `container.querySelector('[data-source-field="overBudgetEventCountToday"]').textContent` assertion — that selector is unique by construction.
- **Files modified:** `packages/workbench-ui/src/command/DispositionOverlay.test.tsx` (tests 5 + 11).
- **Commit:** `1127c6b` (rolled into Task 3)

**4. [Rule 1 - source-binding fix] isDevBuild() priority order had Vite flag winning over NODE_ENV=production**

- **Found during:** Task 2 first test run
- **Issue:** Tests 3 and 9 (production-mode no-op tests) failed because `vi.stubEnv("NODE_ENV", "production")` correctly set `process.env.NODE_ENV` to `"production"` but my initial `isDevBuild()` checked `import.meta.env.DEV` first. Vite sets `import.meta.env.DEV = true` in vitest contexts, so the assertion fired anyway.
- **Fix:** Reordered the priority — `process.env.NODE_ENV === 'production'` wins first (the standard prod marker across the Node/test ecosystem); Vite flags are checked second; remaining NODE_ENV values third; default-dev fifth.
- **Files modified:** `packages/workbench-ui/src/command/source-binding.ts`.
- **Commit:** `2d68301` (rolled into Task 2)

**5. [Note - adapt to existing pattern] `useCommandSnapshot` returns the snapshot directly, not `{ snapshot, ... }`**

- **Found during:** Task 1 plan reading
- **Issue:** The plan's interface description suggested `useCommandSnapshot(): { snapshot: CommandSnapshot, ... }`. The actual existing code returns the `CommandSnapshot` directly. Mission, Replay, HoverPreview, SelectionPanel, ActivityLog all already pass `snapshot={snapshot}` from this flat return shape.
- **Fix:** Adapted the plan's described shape to the existing pattern. Tests use `result.current.dispositions.get(...)` (not `result.current.snapshot.dispositions.get(...)`). The `<DispositionOverlay snapshot={snapshot}>` mount in CommandView still passes the same value the plan intended — the prop interface accepts a `{ dispositions }` shape and `CommandSnapshot` structurally satisfies it.
- **Files modified:** plan-level adaptation; all task 1+ code reflects the existing flat-return shape.
- **Documented in:** D-DISP-04-B above.

### Notes / handling

**6. [Note] eslint-disable comments stripped by lint-staged.** Two `eslint-disable-next-line` comments I added (one in `api.test.ts` for `@typescript-eslint/unbound-method`, one in `state.ts` for `no-console`) were stripped by the pre-commit lint-staged formatting because the underlying rules didn't actually fire in those positions. No semantic change. Captured here for completeness.

**7. [Note — superseded] No homelab cluster verification in this plan.** Originally captured as out-of-scope for the executor; superseded by the cluster verification documented above. The Path A homelab walkthrough did require GitOps work in `../new_localai/` (commits `c5bb7fd` image bump + `10f592f` demo overlays), which has now been done; user visually approved the rendered Command Center on 2026-05-09.

**8. [Note — post-tag CI fixes after worktree merge to main]** After tasks 1-4 merged to main (merge commit `4aafc74`) and the initial `v0.2.0-disp-rc.1` tag was cut, two CI failures surfaced:

- `cc528a9` — prettier formatting on `.planning/phases/01-agentdisposition-v0/01-RESEARCH.md` + `.gitignore` entry for `.playwright-mcp/` artifacts.
- `d40d8f6` — eslint `@typescript-eslint/no-unnecessary-type-assertion` on a handful of redundant casts in `DispositionOverlay.test.tsx`.

The original tag was deleted and re-cut at `d40d8f6` once both fixes landed on main. No production code path was touched; cluster image content at the re-cut tag is functionally identical to what tasks 1-4 produced. Captured here as a deviation for completeness — these are routine CI hygiene fixes, not Rule 1/2/3 deviations against the plan.

---

**Total deviations:** 4 auto-fixed issues (2 Rule 3 blocking; 2 Rule 1 minor); 1 plan adaptation note (existing-pattern win); 3 logging / closure notes (1 superseded by cluster verification; 1 post-tag CI hygiene; 1 lint-staged stripping eslint-disables).
**Impact on plan:** None of the deviations change DISP-04 surface area. All 12 acceptance criteria items in `<verification>` pass. ROADMAP success criterion 4 (budget remaining + over-budget event count per agent + reload stability + base-building-only fallback + source-binding contract) is satisfied end-to-end on the homelab cluster.

## Issues Encountered

1. **`pnpm install` was needed before the first commit** (one-time setup; the fresh worktree had no `node_modules`). Running it once before Task 1's commit-with-hooks pass was sufficient. After adding the new `@kagent/dto` workspace dep in Task 1, a second `pnpm install` resolved the new dep.
2. **CSS-module hash drift would have made an `innerHTML` snapshot test flaky.** Mitigated proactively by Test 7's selector-tree shape capture, per OpenCode LOW #8 plan guidance.
3. **The plan's described `useCommandSnapshot` return shape did not match existing code.** Adapted to existing pattern (deviation #5 above). Existing pattern wins because Mission/Replay/HoverPreview/SelectionPanel/ActivityLog all already consume the flat shape.

## User Setup Required

None for the executor's deliverable (tasks 1-4 code).

For the orchestrator's Task 5 verification (out of scope for the executor):

- **Path A (homelab):** A real disposition ConfigMap must be deployed against a real Agent in `../new_localai/` so `GET /api/dispositions` returns at least one row. Plan 01's seed ConfigMap (`broken-agent`) is filtered by the orphan-overlay filter (plan 03) and will NOT render — that is intentional.
- **Path B (local stub):** A local workbench-api or stub server returning a static `/api/dispositions` response is sufficient. Run with `VITE_API_TARGET=http://localhost:<port> pnpm --filter @kagent/workbench-ui dev`.

## Next Phase Readiness

Phase 1's four DISP requirements are all complete and verified end-to-end on the homelab cluster:

- DISP-01 (plan 01): sibling-ConfigMap overlay carrier + schema-validate Job ✓
- DISP-02 (plan 02): cap-issuer narrowing + proposals-today annotation writer ✓
- DISP-03 (plan 03): GET /api/dispositions projection + over-budget audit ✓
- DISP-04 (plan 04): Command Center overlay + source-binding contract + reload stability ✓ (Task 5 verified on cluster, user-approved)

The post-phase ~7-day observation window begins now. The promotion gate (file Future Research → Candidate Requirement for AgentDisposition CRD) decides based on observed read/write/ignore patterns against the three demo overlays deployed via `new_localai` `10f592f` — a question Phase 1 was explicitly designed to answer.

## Self-Check

Verified the SUMMARY's load-bearing claims:

- All 4 task commits exist on the worktree branch:
  - `6c74ae4 feat(phase-01-disp): wire fetchDispositions into useCommandSnapshot (DISP-04)` — FOUND
  - `2d68301 feat(phase-01-disp): add CC-01 disposition-slice source-binding helper (DISP-04)` — FOUND
  - `1127c6b feat(phase-01-disp): add DispositionOverlay component + reload-stability + base-building-only mode (DISP-04)` — FOUND
  - `5cdf22f feat(phase-01-disp): mount DispositionOverlay in CommandView (DISP-04)` — FOUND
- All 8 created files exist on disk:
  - `packages/workbench-ui/src/api.test.ts` — FOUND
  - `packages/workbench-ui/src/command/state.test.ts` — FOUND
  - `packages/workbench-ui/src/command/source-binding.ts` — FOUND
  - `packages/workbench-ui/src/command/source-binding.test.ts` — FOUND
  - `packages/workbench-ui/src/command/DispositionOverlay.tsx` — FOUND
  - `packages/workbench-ui/src/command/DispositionOverlay.module.css` — FOUND
  - `packages/workbench-ui/src/command/DispositionOverlay.test.tsx` — FOUND
  - `packages/workbench-ui/src/command/__snapshots__/DispositionOverlay.test.tsx.snap` — FOUND
- All 7 modified files exist on disk and reflect the documented changes.
- `pnpm --filter @kagent/workbench-ui test` exits 0 with **32 / 32** tests passing.
- `pnpm --filter @kagent/workbench-ui typecheck` exits 0.
- `pnpm --filter @kagent/workbench-ui build` exits 0 (production Vite build green).
- `pnpm --filter @kagent/dto test` exits 0 with **63 / 63** tests passing (regression check).
- `pnpm --filter @kagent/workbench-api test` exits 0 with **174 / 174** tests passing (regression check).
- No edits to STATE.md or ROADMAP.md (orchestrator owns those).
- No new write surface introduced (`grep -r "fetch.*method.*POST\|fetch.*method.*PATCH\|fetch.*method.*PUT" src/api.ts src/command/DispositionOverlay.tsx src/command/state.ts` shows zero NEW write paths in the disposition slice).
- No "promote" / "promotion" / "MobProposal" / "CoalitionProposal" tokens in any new file (D6 self-proposal terminology honored).
- postsToday NOT surfaced in UI (`grep -c "Posts:\|posts:" packages/workbench-ui/src/command/DispositionOverlay.tsx` returns 0; Test 9 verifies via `screen.queryByText(/posts/i)` returning null).

## Self-Check: PASSED

---

_Phase: 01-agentdisposition-v0_
_Plan: 04_
_Status: complete (tasks 1-4 implementation + Task 5 cluster verification approved by user 2026-05-09; tag v0.2.0-disp-rc.1 cut at d40d8f6)_
_Drafted: 2026-05-09_
_Closed: 2026-05-09_
