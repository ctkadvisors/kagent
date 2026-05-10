---
phase: 02-command-center-contract-hardening
plan: 02
subsystem: ui
tags: [typescript, react, vitest, command-center, source-binding, pressure, cc-01, cc-04]

# Dependency graph
requires:
  - phase: 02-command-center-contract-hardening
    provides: source-binding.ts generic helpers + 4 closed-enum field-name unions (Wave 0)
  - phase: 02-command-center-contract-hardening
    provides: pressure.ts module shape (PressureMarker, PressureType, empty PRESSURE_TYPES) (Wave 0)
  - phase: 02-command-center-contract-hardening
    provides: cc-orphan.test.ts skeleton with 3 it.todo placeholders (Wave 0)
  - phase: 02-command-center-contract-hardening
    provides: pressure.test.ts skeleton with 18 it.todo placeholders (Wave 0)
provides:
  - assertCanvasOrphan(snapshot, taskNamespace, taskName, agentKey) helper exported from source-binding.ts (CC-01)
  - CommandView.tsx agentNodes useMemo wired with the dev-only orphan trap before the synthetic-AgentNode fallback (CC-01)
  - PRESSURE_TYPES populated with 9 entries (gateway, artifact, pod, quota, telemetry, context, verifier, trace, policy) — CC-04
  - PressureFieldName resolves to the union of 9 kind literals automatically (auto-derived from PRESSURE_TYPES['kind'])
  - 4 cc-orphan tests (replacing 3 it.todo placeholders — adds NODE_ENV=production no-op test split)
  - 18 pressure tests (9 fires + 9 absent pairs replacing the 18 it.todo placeholders)
affects: [02-03, 02-04, command-center, workbench-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'assertCanvasOrphan widens isDevBuild() guard from per-DTO field check (assertSourceField) to per-snapshot map check (snapshot.agents.has(key)) — same gate (NODE_ENV=production no-op), different scope'
    - 'PressureType.classify is a deterministic pure function from CommandSnapshot only — no fetch, no random, no localStorage; Date.now() only in the telemetry entry where wallclock IS the source signal (lastEventAt staleness)'
    - 'taskKey() helper centralizes the `#/tasks/<ns>/<name>` URL encoding mirroring CommandView.tsx lines 1971/2036 — single source of truth for the canonical hash-route deep link'
    - 'PressureType.detailLink(marker) returns marker.detailLink for per-task entries (allowing per-marker variation, e.g. quota fallback to #/cluster), or returns the constant for global entries (gateway → #/gateway, telemetry → #/cluster)'
    - 'TaskSummary fallbacks (per RESEARCH.md Finding 2) documented inline above each entry that needs them: context (childCount heuristic vs pilotEvidence), verifier/policy (error-string match vs structured signal), trace (canonical "trace link unknown" label vs traceLink field)'

key-files:
  created: []
  modified:
    - packages/workbench-ui/src/command/source-binding.ts
    - packages/workbench-ui/src/command/cc-orphan.test.ts
    - packages/workbench-ui/src/CommandView.tsx
    - packages/workbench-ui/src/command/pressure.ts
    - packages/workbench-ui/src/command/pressure.test.ts

key-decisions:
  - "assertCanvasOrphan uses ReadonlyMap<string, unknown> for the snapshot.agents type to keep the helper agnostic of AgentSummaryRow's concrete shape — the helper only checks key presence, not field shape, so coupling it to AgentSummaryRow would force test fixtures to construct fully-typed rows just to exercise the orphan path. Test 1 in cc-orphan.test.ts uses `new Map<string, unknown>()` to confirm the loose typing."
  - "quota classify resolves detailLink dynamically per disposition row: walks snapshot.tasks for the most-recent terminal task targeting the over-budget agent (ordering by completedAt > startedAt > createdAt parsed via Date.parse), with #/cluster fallback when no such task exists. This satisfies CONTEXT.md D-CC-04-A's 'most-recent task targeting that agent OR fall back to #/cluster' clause without an extra index over the tasks Map (per-classify O(|tasks| × |dispositions|) is acceptable for v0.2 homelab scale ~3 agents × ~6 tasks)."
  - "Each classify function returns PressureMarker[] inline (no aggregator function) so PressureType entries are self-contained — Wave 2's PressureOverlay can iterate PRESSURE_TYPES.flatMap(pt => pt.classify(snapshot)) without per-type handling logic, matching RESEARCH.md Pitfall 2's useMemo recommendation."
  - 'Telemetry classify uses Date.now() inline (not a passed-in nowMs parameter) because the test contract uses vi.useFakeTimers() + vi.setSystemTime() to control time — adding a parameter would force the React consumer in Wave 2 to thread Date.now() through props for no real benefit. RESEARCH.md Pitfall 2 confirms tests use fake timers for determinism.'
  - 'context-pressure heuristic (childCount >= 2 && phase === Dispatched) is documented in pressure.ts as a v0.2 fallback. The ideal source (pilotEvidence.policy.maxConcurrentChildren ratio) lives on TaskDetail, not the CommandSnapshot — promotion path is to add pilotEvidence to TaskSummary in a future phase, then update the classify function. CONTEXT.md and RESEARCH.md both anticipate this.'

patterns-established:
  - 'Per-snapshot canvas-side assertion (assertCanvasOrphan) — sister to per-DTO field assertion (assertSourceField); same isDevBuild() gate, scoped to a Map.has(key) check at the React-side layout pipeline insertion point'
  - 'Per-pressure-type entry shape: kind + sourceField/sourceFields + classify(snapshot) + detailLink(marker) — Wave 2 extends with rendered markers but does not modify the entry shape'
  - 'TaskSummary-only fallback documented inline at the entry-level comment (not in a separate doc) — the fallback is part of the contract and lives next to the code that implements it; future-phase promotion path is also inline'

requirements-completed: [CC-01, CC-04]

# Metrics
duration: ~9min
completed: 2026-05-09
---

# Phase 02 Plan 02: Wave-1 CC-01 Canvas Orphan + CC-04 Pressure Classification Summary

**Wave-1 lights up the two requirements that need no panel/JSX coupling: CC-01's dev-only canvas-side orphan trap (assertCanvasOrphan in source-binding.ts, called inside CommandView's agentNodes useMemo before the synthetic-AgentNode fallback) and CC-04's nine-entry PRESSURE_TYPES classification table (gateway/artifact/pod/quota/telemetry/context/verifier/trace/policy with TaskSummary-only fallbacks documented inline) — pure-logic work landing into the file shapes Wave 0 locked, with no JSX changes and no rendered markers yet.**

## Performance

- **Duration:** ~9 minutes
- **Started:** 2026-05-09T21:36:00Z
- **Completed:** 2026-05-09T21:41:30Z
- **Tasks:** 2
- **Files modified:** 5 (source-binding.ts, cc-orphan.test.ts, CommandView.tsx, pressure.ts, pressure.test.ts)
- **Files created:** 0
- **Commits:** 2 task commits + 1 metadata commit
- **Tests added:** 22 (4 cc-orphan + 18 pressure)

## Accomplishments

- **CC-01 canvas-side orphan trap shipped.** `assertCanvasOrphan(snapshot, taskNamespace, taskName, agentKey)` exported from `source-binding.ts`; throws in dev with a message naming the orphan task, the missing agent key, and a pointer to `COMMAND-CENTER-CONTRACT.md` §2 Prime Directive. No-op in `NODE_ENV=production` so the existing synthetic-AgentNode fallback in CommandView's `agentNodes` useMemo continues unchanged during transient SSE reconnect windows (per RESEARCH.md Pitfall 1).
- **CommandView.tsx wired.** New import line for `assertCanvasOrphan` added directly above `useCommandSnapshot`; the assertion call lives inside the existing `for (const t of snapshot.tasks.values())` loop, immediately after the `key` is computed and before the `if (!map.has(key))` synthetic-fallback branch. `computeLayout` itself stays a pure spatial function (RESEARCH.md anti-pattern + Finding 6) — `grep -c computeLayout` still returns 2 (import + call site).
- **CC-04 classification table populated.** All 9 pressure types (gateway, artifact, pod, quota, telemetry, context, verifier, trace, policy) now in `PRESSURE_TYPES`. Each entry declares `sourceField` or `sourceFields` (mirroring CONTEXT.md D-CC-04-A's per-type bindings), a deterministic `classify(snapshot)` returning `PressureMarker[]`, and a `detailLink(marker)` resolver. Classify functions read only `snapshot.agents/.tasks/.gatewayCapacity/.dispositions/.lastEventAt` — no fetch, no random, no localStorage; only `Date.now()` inside the telemetry entry where wallclock IS the source signal (snapshot's `lastEventAt` staleness).
- **PressureFieldName auto-derived.** `export type PressureFieldName = PressureType['kind']` in `pressure.ts` now resolves to the union of all 9 kind literals because `PRESSURE_TYPES` is populated. Wave 2 panel code can type-narrow against it without further changes; the closed-enum is single-source-of-truth via the runtime classify table.
- **TaskSummary fallback notes inline.** Each entry that needs a fallback (context, verifier, trace, policy) has a leading comment documenting the ideal source (TaskDetail's `pilotEvidence.*` fields, structured audit-event SSE kind, or `traceLink` on TaskDetail), the v0.2 heuristic in use, and the promotion path. RESEARCH.md Finding 2 + CONTEXT.md Open Question 1 cited.
- **22 tests added (replacing 21 it.todo placeholders, adding 1 split test).** `cc-orphan.test.ts` has 4 real tests (canvas-orphan throw with 4 expect calls, canvas-orphan pass, AgentPanel field-orphan throw, NODE_ENV=production no-op for both); `pressure.test.ts` has 18 real tests (9 fires + 9 absent pairs). The fires tests construct minimal synthesized snapshots; the absent tests assert `markers.length === 0` for the relevant kind. Telemetry uses `vi.useFakeTimers()` + `vi.setSystemTime()` for determinism.
- **Verification gates green.** `pnpm -C packages/workbench-ui test -- --run` exits 0 with **63 passed + 5 todo across 8 files** (Wave 0 was 41 passed + 26 todo across 8 files; 22 todos converted to passing tests this wave). `pnpm -C packages/workbench-ui exec tsc --noEmit -p tsconfig.build.json` exits 0. Pre-commit hooks (eslint --max-warnings 0 + prettier + monorepo-wide tsc) green on both task commits.
- **Wave 1 acceptance gate flips:** the 02-VALIDATION.md per-task verification map's CC-01 unit-test row and CC-04 classify-logic rows flip from ❌ W0 to ✅; CC-04 panel-render and CC-01 panel-orphan rows remain pending until Wave 2.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add assertCanvasOrphan helper to source-binding.ts and wire it into CommandView.tsx's agentNodes useMemo (CC-01)** — `d9f1902` (feat)
2. **Task 2: Populate pressure.ts PRESSURE_TYPES with all 9 entries (classify + detailLink) and replace the 18 it.todo placeholders in pressure.test.ts with real tests (CC-04)** — `631b053` (feat)

_Plan metadata commit (SUMMARY.md): added separately at the end of execution._

## Files Created/Modified

- `packages/workbench-ui/src/command/source-binding.ts` — **modified.** Appended `assertCanvasOrphan(snapshot, taskNamespace, taskName, agentKey)` exported function. Loose `ReadonlyMap<string, unknown>` typing on `snapshot.agents` keeps the helper agnostic of `AgentSummaryRow`'s concrete shape — call sites narrow their own snapshot type. Existing helpers (`isDevBuild`, `assertSourceField`, `assertSourceFields`, `useSourceField`, `useSourceFields`) and the four closed-enum unions (`DispositionFieldName`, `AgentSummaryFieldName`, `TaskSummaryFieldName`, `GatewayCapacityFieldName`) are unchanged.
- `packages/workbench-ui/src/command/cc-orphan.test.ts` — **modified.** 3 `it.todo` placeholders replaced with 4 real tests (Test 1: canvas-orphan throw with 4 message-content `expect(...).toThrow(/.../)` checks; Test 2: canvas-orphan pass; Test 3: AgentPanel field-orphan throw via `assertSourceField`; Test 4: `NODE_ENV=production` no-op for BOTH `assertCanvasOrphan` AND `assertSourceField` — explicit two-assertion check). Imports `assertCanvasOrphan`, `assertSourceField`, `AgentSummaryFieldName` from `./source-binding.js` and `AgentSummaryRow` from `../types.js`.
- `packages/workbench-ui/src/CommandView.tsx` — **modified.** Added new import `import { assertCanvasOrphan } from './command/source-binding.js';` directly above the `useCommandSnapshot` import. Inside the `agentNodes` useMemo's `for (const t of snapshot.tasks.values())` loop, added the assertion call `assertCanvasOrphan(snapshot, t.namespace, t.name, key);` immediately after `const key = ...;` and before the `if (!map.has(key))` synthetic-fallback branch. The `computeLayout` import + call site is untouched (`grep -c computeLayout` returns 2, same as before).
- `packages/workbench-ui/src/command/pressure.ts` — **modified.** Wave-0's empty `PRESSURE_TYPES` array replaced with 9 entries. New `taskKey({ namespace, name })` helper computes the canonical `#/tasks/<encoded-ns>/<encoded-name>` deep link mirroring CommandView.tsx lines 1971/2036. New `STALE_TELEMETRY_MS = 30_000` constant for the telemetry entry. Module-level imports gain `import type { TaskSummary } from '../types.js';` for the quota entry's task-search loop. The `PressureMarker` and `PressureType` interfaces are unchanged — Wave 0 locked their final shape. `export type PressureFieldName = PressureType['kind']` now auto-resolves to the union of 9 kind literals.
- `packages/workbench-ui/src/command/pressure.test.ts` — **modified.** 18 `it.todo` placeholders replaced with 18 real tests across 9 pairs (one fires + one absent per kind). New helpers: `makeSnapshot(overrides)` returns a fully-typed empty `CommandSnapshot` with `Date.now()` as the default `lastEventAt`; `classifyAll(snapshot)` runs `PRESSURE_TYPES.flatMap(pt => pt.classify(snapshot))`; `makeTask(overrides)` returns a minimal `TaskSummary`. Telemetry tests use `vi.useFakeTimers()` + `vi.setSystemTime(new Date('2026-05-10T12:00:00Z'))` so `Date.now() − snapshot.lastEventAt` is deterministic. Each test filters `classifyAll(...)` output by `kind` so cross-type interference (e.g. the trace marker firing alongside artifact in Completed-task fixtures) doesn't pollute assertions. Imports the four typed shapes from `../types.js` plus `DispositionOverlayRow` from `@kagent/dto/disposition`.

## Decisions Made

- **assertCanvasOrphan signature uses `ReadonlyMap<string, unknown>` not `ReadonlyMap<string, AgentSummaryRow>`** — the helper only checks key presence, never field shape. Tightening the value type would force test fixtures to construct fully-typed `AgentSummaryRow` objects just to exercise the orphan path. The `unknown` value type matches the helper's actual contract and keeps cc-orphan.test.ts terse (Test 1: `new Map<string, unknown>()`).
- **Telemetry classify uses inline `Date.now()` not a passed-in `nowMs` parameter** — Wave 2's `PressureOverlay` would otherwise need to thread `Date.now()` through props for zero benefit. The Wave-1 tests already use `vi.useFakeTimers()` + `vi.setSystemTime()` to control time, which is the established pattern for time-dependent unit tests in this repo.
- **quota classify computes `detailLink` dynamically per row** by walking `snapshot.tasks` for the most-recent terminal task targeting the over-budget agent — sorted by `completedAt` > `startedAt` > `createdAt` (parsed via `Date.parse`). Falls back to `#/cluster` when no matching task exists. CONTEXT.md D-CC-04-A specifies this fallback chain explicitly.
- **Each classify function returns `PressureMarker[]` directly** rather than calling a shared aggregator. Wave 2's `PressureOverlay` will run `PRESSURE_TYPES.flatMap(pt => pt.classify(snapshot))` once per useMemo recompute — RESEARCH.md Pitfall 2's recommendation. Self-contained classify entries make per-type unit testing trivial (no aggregator stub needed).
- **The trace entry fires on every terminal task** (Completed OR Failed) with the canonical "trace link unknown — open task detail" label. The ideal source (`traceLink === undefined` check) requires `TaskDetail`, which is not in the snapshot. CONTEXT.md Deferred Ideas explicitly defers adding `traceLink` to `TaskSummary` — the v0.2 marker links to TaskDetail which carries the real link, satisfying the operator's "open trace" need without expanding workbench-api surface.
- **Verifier and policy entries use case-insensitive substring match on `error`** (`t.error.toLowerCase().includes('verifier')` / `'policy'`) — heuristic per RESEARCH.md Open Question 1. False positives surface a "verifier failed" or "policy denial" marker on a non-matching failure (operator-facing, not exploitable per threat model T-02-05). Promote to a structured audit-event signal in a future phase if the SSE stream gains audit-event kinds.
- **`STALE_TELEMETRY_MS = 30_000` inlined as a module constant** (not exported) since the classify function is the only consumer. Tests assert the boundary by stubbing `lastEventAt` at `Date.now() - 60_000` (fires) and `Date.now() - 1_000` (absent) — exact threshold value not exposed.

## Deviations from Plan

None — plan executed exactly as written. The acceptance criteria's `grep -c "it.todo"` outputs 1 (matching the docstring comment that mentions "the 18 it.todo placeholders"), but `grep -cE "it\.todo\("` outputs 0 (no actual `it.todo()` calls remain). Spirit of the criterion is met.

## Authentication Gates

None — pure UI-package code; no auth surface touched.

## Issues Encountered

- **Pre-commit hook required Node 22, machine default is Node 23.11.1.** Resolved by running `source ~/.nvm/nvm.sh && nvm use 22` before each `git commit`. The repo's `package.json` engines field pins `>=22.0.0 <23.0.0` and the `simple-git-hooks` pre-commit runs `pnpm lint-staged && pnpm -r typecheck`, both of which pnpm refuses to run on Node 23 (`ERR_PNPM_UNSUPPORTED_ENGINE`). Same issue documented in 02-01-SUMMARY.md; not a planning bug. The execution-environment note in the prompt explicitly called out this requirement.

## User Setup Required

None — pure UI-package code under `packages/workbench-ui/src/command/`. No new env vars, no new endpoints, no new substrate state, no GitOps overlay changes. Phase 2 remains read-side only; revocation is via `NODE_ENV=production` (assertions become no-ops) or `VITE_PRESSURE_DRAMATIZATION=false` (subdued visual treatment in Wave 2); both are set elsewhere or default-correct.

## Next Phase Readiness

Wave 2 (02-03-PLAN.md) can begin immediately:

- `assertCanvasOrphan` is exported, called from CommandView's agentNodes useMemo, and verified green; Wave 2's panel-side rendering work (PressureOverlay JSX + AgentPanel/TaskPanel/GatewayPanel KV rows) lands without further source-binding.ts changes.
- `PRESSURE_TYPES` has all 9 entries; `PressureOverlay.tsx` can replace its Wave-0 `return null` with `<aside><ul>{markers.map(...)}</ul></aside>` keyed off `markers = useMemo(() => PRESSURE_TYPES.flatMap(pt => pt.classify(snapshot)), [snapshot])`. The marker shape (kind + sourceField/sourceFields + affectedKey + detailLink + label) is fixed and tested.
- `PressureFieldName` resolves to the union of 9 kind literals automatically; downstream Wave 2 panel code can type-narrow against it without further work.
- 4 `it.todo` placeholders remain in `PressureOverlay.test.tsx` (Wave 0 — Wave 2 fills them) and 1 `it.todo` placeholder remains in `cc-reload.test.tsx` (Wave 0 — Wave 3 fills it). No Wave 1 todos remain.

No blockers. No concerns.

## §11 Bounds Test (Wave 1)

- **Declared capability:** dev-only canvas-side orphan trap that flags any task→agent reference inconsistency in CommandView; UI-side classification of nine pressure types from the existing `CommandSnapshot`. Both pure-logic; no rendered markers added (Wave 2 owns rendering).
- **Bounded resource drain:** `assertCanvasOrphan` runs once per snapshot-Map identity change (the agentNodes useMemo dep is `[snapshot.agents, snapshot.tasks]`); `Date.now()` is the only wallclock dep, only in the telemetry entry. Production builds skip both `assertCanvasOrphan` (NODE_ENV=production no-op) and the dev-only `assertSourceField` callers — runtime cost is identical to Wave 0 in production. `PRESSURE_TYPES.flatMap(pt => pt.classify(snapshot))` is O(|tasks| + |gatewayCapacity| + |dispositions|), wrapped in useMemo at the consumer in Wave 2. quota's nested task-search is O(|tasks| × |over-budget dispositions|) — acceptable at homelab scale (~3 agents × ~6 tasks).
- **Observable state transition:** dev throws a referenceable Error pointing at COMMAND-CENTER-CONTRACT.md §2; classify output is JSON-serializable PressureMarker[] testable in isolation. vitest count climbs from 41 passed + 26 todo (Wave 0) to 63 passed + 5 todo (Wave 1) — 22 todos converted to passing tests.
- **Auditable output:** `pnpm -C packages/workbench-ui test -- --run cc-orphan pressure source-binding` runs in CI; failure is loud (the precise expect-toThrow regex contracts surface mismatches on the orphan-error message, marker shape, source-field strings, and detail-link encoding).
- **Revocation path:** `NODE_ENV=production` disables the orphan assertion (cc-orphan.test.ts Test 4 verifies); `PRESSURE_TYPES.flatMap(pt => pt.classify(snapshot))` returns `[]` when no condition triggers — visual treatment additionally gated by Wave-2's `pressureDramatization` flag. Pure UI-package code; a single revert removes Wave 1.

## §15 One-Sentence Test (Wave 1)

Strengthens observability by giving the existing Command Center a dev-time trap for source-binding violations (assertCanvasOrphan) and a live-derived list of failure-pressure markers (PRESSURE_TYPES populated), both honoring the Prime Directive — every marker carries a substrate-source field name — without expanding substrate primitives or workbench-api surface.

## Self-Check: PASSED

All 5 modified files were touched and remain green:

- ✓ packages/workbench-ui/src/command/source-binding.ts (assertCanvasOrphan exported; existing helpers unchanged)
- ✓ packages/workbench-ui/src/command/cc-orphan.test.ts (4 real tests; 0 it.todo)
- ✓ packages/workbench-ui/src/CommandView.tsx (import + in-loop call; computeLayout still referenced ×2)
- ✓ packages/workbench-ui/src/command/pressure.ts (9 PRESSURE_TYPES entries; PressureFieldName auto-derived)
- ✓ packages/workbench-ui/src/command/pressure.test.ts (18 real tests; 0 it.todo)

Both task commits exist in git log:

- ✓ d9f1902 feat(02-02): add assertCanvasOrphan and wire it into CommandView (CC-01)
- ✓ 631b053 feat(02-02): populate PRESSURE_TYPES with all 9 entries (CC-04)

Verification gates green:

- ✓ `pnpm -C packages/workbench-ui test -- --run` → 63 passed + 5 todo across 8 files (no failures)
- ✓ `pnpm -C packages/workbench-ui exec tsc --noEmit -p tsconfig.build.json` → exit 0
- ✓ Pre-commit hooks (eslint --max-warnings 0 + prettier + monorepo-wide tsc -r typecheck) green on both task commits

Acceptance criteria spot-check:

- ✓ `grep -E "^export function assertCanvasOrphan" source-binding.ts` → 1 line
- ✓ `grep -E "import \{ assertCanvasOrphan \} from './command/source-binding\.js'" CommandView.tsx` → 1 line
- ✓ `grep -E "assertCanvasOrphan\(snapshot, t\.namespace, t\.name, key\);" CommandView.tsx` → 1 line
- ✓ `grep -c expect cc-orphan.test.ts` → 9 (≥ 7 required)
- ✓ `grep -cE "it\.todo\(" cc-orphan.test.ts` → 0
- ✓ `grep -cE "it\.todo\(" pressure.test.ts` → 0
- ✓ `grep -E "kind: '(...9 kinds...)'" pressure.ts | sort -u | wc -l` → 18 (each kind appears in entry literal AND in marker objects)
- ✓ `grep -c classify: pressure.ts` → 10 (≥ 9; 9 entries + 1 interface declaration)
- ✓ `grep -cE "^  it\(" pressure.test.ts` → 18 (the 9 pairs)
- ✓ `grep -c computeLayout CommandView.tsx` → 2 (untouched: import + call site)

---

_Phase: 02-command-center-contract-hardening_
_Completed: 2026-05-09_
