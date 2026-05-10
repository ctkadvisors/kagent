<!--
  SPDX-License-Identifier: MIT
  Copyright (c) 2026 Chris Knuteson
-->
# Phase 2: Command Center Contract Hardening — Research

**Researched:** 2026-05-10
**Domain:** React/TypeScript workbench-ui source-binding generalization + pressure overlay
**Confidence:** HIGH (all findings verified against actual source files in this session)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-CC-01-A:** Per-component opt-in extension of Phase 1's pattern, plus a layout-mapper assertion for the canvas side. New closed-enum field-name types alongside Phase 1's `DispositionFieldName`; canvas-side assertion in `agentNodes useMemo` pipeline or just before `computeLayout` call; same `isDevBuild()` env detection.
- **D-CC-02-A:** BOTH a DOM snapshot (panels + overlays) AND a scene-graph JSON snapshot (`computeLayout` output) per reload-stability test. Fixture `__fixtures__/cc-snapshot.json`; captured from real workbench-api response set; closed list of presentation-only state allowed to vary.
- **D-CC-03-A:** Inline-expand the existing AgentPanel / TaskPanel / GatewayPanel. No mini-detail components. Prominent "Open in detail page" link at bottom of each panel.
- **D-CC-04-A:** All 9 pressure types in Phase 2. No `/api/pressure` endpoint. No new substrate state. Single global `pressureDramatization` flag. New `pressure.ts` module with `PRESSURE_TYPES` array.

### Claude's Discretion

- Exact file split for `pressure.ts` (could become `pressure/index.ts` + per-kind modules if > ~400 lines).
- Whether the layout-mapper assertion lives in `computeLayout` or in CommandView's snapshot→layout pipeline call site.
- Snapshot fixture date and exact agent/task/gateway count.
- Whether to add `traceLink` to `TaskSummary` (default: defer).
- Whether `localStorage`-backed bookmarks survive reload (default: RESET).
- Whether to add a CI lint that greps for `data-source-field` coverage (default: defer).
- Whether hash-route anchor support is needed for deep links (default: defer).
- Whether `state.streamLastEventAt` already exists or needs a small addition (planner inspects — it DOES already exist as `lastEventAt`; see finding #3 below).

### Deferred Ideas (OUT OF SCOPE)

- `/api/pressure` workbench-api projection
- `PressureRecord` CRD or substrate-emitted pressure DTOs
- Hash-route anchor support (`#/cluster?node=<name>`)
- Adding `traceLink` to `TaskSummary`
- Embedded mini-detail components
- Per-pressure-type dramatization toggles
- Generalizing source-binding to other Workbench surfaces (TaskList, TaskDetail, GatewayPage, ClusterPage)
- `localStorage`-backed bookmark persistence
- CI lint for `data-source-field` attribute coverage
- Construction mode (Slice C) and Tool Foundry (Slice D)
- Adding `streamLastEventAt` to a workbench-api DTO

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CC-01 | Dev-only assertion fires when any rendered Agent node lacks a backing `AgentSummaryRow`, or any rendered task sprite lacks a backing `TaskSummary`. Fixture-based test asserts assertion fires for orphan nodes and is no-op in prod. | Layout mapper insertion point identified (agentNodes useMemo in CommandView.tsx lines 175-201; assertion fires before computeLayout at line 274); isDevBuild() function body verified; source-binding.ts extension points confirmed. |
| CC-02 | Reloading `/#/command` reconstructs same world from API state. Vitest snapshot test (DOM + scene-graph JSON) seeded with captured API fixture asserts rendered DOM tree matches across reloads. | Fixture capture curl pipeline documented; snapshot test pattern confirmed from DispositionOverlay.test.tsx; `__fixtures__/` dir does not yet exist (Wave 0 gap); `__snapshots__/` dir exists with DispositionOverlay snapshot. |
| CC-03 | Selection panels show operational read depth per Slice B. All panels gain "Open in detail page" link. | Exact panel start lines confirmed (AgentPanel=1898, TaskPanel=2000, GatewayPanel=1697); TaskSummary vs TaskDetail field split documented precisely; hash-route deep-link pattern (`#/tasks/<ns>/<name>`) confirmed from existing code. |
| CC-04 | Pressure overlay (9 types) from existing DTO fields. Each marker carries source-field name + detail link. Base-building-only mode with `pressureDramatization=false`. | `pilotEvidence` field paths verified on `TaskDetail` (TaskSummary-only fallbacks documented for each type); `lastEventAt` already exists in CommandSnapshot (stale-telemetry pressure can use it directly); `pressureDramatization` flag mechanics confirmed. |

</phase_requirements>

---

## Summary

Phase 2 is a pure UI extension phase — all work in `packages/workbench-ui/`. It generalizes Phase 1's per-component source-binding pattern (shipped as `source-binding.ts` + `DispositionOverlay.tsx`) to the whole Command Center: agent nodes, task sprites, gateway rows, and a new nine-type pressure overlay. No backend changes, no CRD changes, no new API endpoints.

The research found the codebase is in excellent shape for this phase. Phase 1 established all the patterns Phase 2 extends: closed-enum field-name types, `assertSourceField`/`assertSourceFields` helpers, `data-source-field`/`data-source-fields` DOM attributes, `pressureDramatization` prop, and reload-stability snapshot tests. Every new file and every panel addition has an exact template to mirror.

Three critical decisions from CONTEXT.md "Claude's Discretion" are now resolved by code inspection: (1) `lastEventAt` already exists in `CommandSnapshot` — stale-telemetry pressure uses it directly without any addition to `state.ts`. (2) The canvas-side orphan assertion belongs in the `agentNodes useMemo` in `CommandView.tsx` at the `computeLayout` call site (lines 265-277) — NOT inside `computeLayout` itself (which is a pure function that should remain pure). (3) The `__fixtures__/` directory does not exist yet and is a Wave 0 creation gap.

**Primary recommendation:** Start Wave 0 by creating `__fixtures__/cc-snapshot.json` + `pressure.ts` skeleton + extending `source-binding.ts` with new enum types. Everything else flows from those three files.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| CC-01 source-binding assertion (React panels) | Frontend client (workbench-ui) | — | Dev-only runtime guard; emits `data-source-field` DOM attrs for debuggability; no server involvement |
| CC-01 canvas-side orphan assertion | Frontend client (workbench-ui) | — | Lives at `agentNodes useMemo`→`computeLayout` call site in CommandView.tsx; pure snapshot→layout pipeline check |
| CC-02 fixture capture | Manual (dev machine) | API (workbench-api) | `curl/jq` against running `workbench-api` dev server; committed once to git |
| CC-02 reload-stability test | Frontend client (workbench-ui) | — | Vitest jsdom, `@testing-library/react`, no browser |
| CC-03 panel read depth (AgentPanel/TaskPanel/GatewayPanel) | Frontend client (workbench-ui) | — | Inline HTML KV rows reading from existing `snapshot.*` Maps; no API changes |
| CC-04 pressure classification logic | Frontend client (workbench-ui) | — | `pressure.ts` derives all 9 types from existing `CommandSnapshot` fields; no new DTO, no new endpoint |
| CC-04 pressure overlay rendering | Frontend client (workbench-ui) | — | HTML-over-canvas markers (same position strategy as `DispositionOverlay`); extends `pressureDramatization` |
| `pilotEvidence` field access (context/verifier/trace/pod) | Frontend client (workbench-ui) | API (TaskDetail fetch) | Only available on `TaskDetail`, not `TaskSummary`; Task-Summary-only fallbacks documented per pressure type |

---

## Standard Stack

### Core (in-use, verified)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| react | 18.x | Component rendering | Project dependency [VERIFIED: codebase] |
| @testing-library/react | 16.3.0 | Component test rendering | Already installed [VERIFIED: package.json] |
| @testing-library/dom | 10.4.1 | DOM assertions | Already installed [VERIFIED: package.json] |
| @testing-library/jest-dom | 6.9.1 | Extended matchers | Already installed [VERIFIED: package.json] |
| vitest | 4.1.4 | Test runner | Project standard [VERIFIED: package.json] |
| @vitest/coverage-v8 | 4.1.4 | Coverage reporter | Already configured [VERIFIED: vitest.config.ts] |

### No new dependencies required

Phase 2 adds NO new npm dependencies. All required libraries are already installed.

**Version verification:** All versions confirmed against `packages/workbench-ui/package.json` in this session. [VERIFIED: package.json]

---

## Architecture Patterns

### System Architecture Diagram

```
workbench-api (running)
  GET /api/agents → AgentSummaryRow[]
  GET /api/tasks  → TaskSummary[]
  GET /api/gateway/capacity → GatewayCapacityRow[]
  GET /api/dispositions → DispositionOverlayRow[]
  SSE /api/stream → heartbeat + cache events
       |
       v
useCommandSnapshot() [state.ts]
  ├── agents: Map<string, AgentSummaryRow>
  ├── tasks:  Map<string, TaskSummary>
  ├── gatewayCapacity: GatewayCapacityRow[]
  ├── dispositions: Map<string, DispositionOverlayRow>
  ├── lastEventAt: number  ← stale-telemetry pressure reads this
  └── error: string|null
       |
       ├── agentNodes useMemo [CommandView.tsx:175]
       │     Maps snapshot.agents + snapshot.tasks into AgentNode[]
       │     INSERTION POINT: CC-01 canvas-side orphan assertion HERE
       │     ↓
       │   computeLayout(agentNodes, bounds) [layout.ts]
       │     Returns LayoutResult { gateway, agents: Map<key, position>, factions }
       |
       ├── SelectionPanel [CommandView.tsx:1670]
       │     ├── GatewayPanel [line 1697] — CC-03 extension target
       │     ├── AgentPanel   [line 1898] — CC-03 extension target
       │     └── TaskPanel    [line 2000] — CC-03 extension target
       |
       ├── DispositionOverlay [already shipped, Phase 1]
       │     reads snapshot.dispositions
       │
       ├── PressureOverlay [CC-04, NEW]
       │     reads snapshot.agents, tasks, gatewayCapacity, lastEventAt
       │     classifies via pressure.ts PRESSURE_TYPES[].classify(snapshot)
       │     emits HTML markers with data-source-field + detailLink
       │
       └── source-binding.ts [extended from Phase 1]
             ├── AgentSummaryFieldName (new)
             ├── TaskSummaryFieldName (new)
             ├── GatewayCapacityFieldName (new)
             ├── PressureFieldName (new, derived from PRESSURE_TYPES)
             └── isDevBuild(), assertSourceField/Fields, useSourceField/Fields (unchanged)
```

### Recommended Project Structure

```
packages/workbench-ui/src/command/
├── source-binding.ts          # EXTEND: add 4 new enum types
├── source-binding.test.ts     # EXTEND: add CC-01 orphan tests for new types
├── DispositionOverlay.tsx      # UNCHANGED (Phase 1 complete)
├── DispositionOverlay.test.tsx # UNCHANGED
├── pressure.ts                # NEW: PRESSURE_TYPES array + classify + detailLink
├── pressure.test.ts           # NEW: 9-scenario per-type fixture tests
├── PressureOverlay.tsx         # NEW: renders PressureMarker[] from pressure.ts
├── PressureOverlay.test.tsx    # NEW: snapshot + source-binding tests (mirrors DispositionOverlay.test.tsx)
├── state.ts                   # NO CHANGE: lastEventAt already present
├── layout.ts                  # NO CHANGE: computeLayout stays pure
├── __fixtures__/
│   └── cc-snapshot.json       # NEW Wave 0: captured from workbench-api
└── __snapshots__/
    ├── DispositionOverlay.test.tsx.snap  # existing
    ├── PressureOverlay.test.tsx.snap     # NEW (generated by vitest)
    └── cc-reload-stability.test.tsx.snap # NEW (generated by vitest)
```

The CC-02 reload-stability test may live in a new file (e.g., `command/cc-reload-stability.test.tsx`) — the exact placement is planner discretion.

### Pattern 1: source-binding.ts Extension Shape

The existing file imports `DispositionOverlayRow` and defines `DispositionFieldName` as a closed union. Phase 2 adds three more closed unions and generics. The helpers `assertSourceField`, `assertSourceFields`, `useSourceField`, `useSourceFields` are generic over the field-name union — new types slot in without changing the runtime helpers.

```typescript
// Source: packages/workbench-ui/src/command/source-binding.ts (Phase 1 pattern)
// Extend this file — do NOT replace it.

// New: Phase 2 closed-enum types
export type AgentSummaryFieldName =
  | 'name' | 'namespace' | 'model' | 'modelClass' | 'tools' | 'capabilities';

export type TaskSummaryFieldName =
  | 'name' | 'namespace' | 'uid' | 'phase' | 'targetAgent' | 'targetCapability'
  | 'model' | 'createdAt' | 'startedAt' | 'completedAt' | 'podName' | 'error'
  | 'suspicious' | 'artifactCount' | 'childCount' | 'aggregatePhase';

export type GatewayCapacityFieldName =
  | 'model' | 'endpoint' | 'backendKind' | 'inFlight' | 'currentCap'
  | 'seed' | 'max' | 'minSafe' | 'recentP50Ms' | 'crName' | 'crNamespace';

// PressureFieldName is computed from PRESSURE_TYPES at module load in pressure.ts
// and re-exported from there — keeps single source of truth in one place.

// Generic helpers (unchanged runtime; widened TypeScript signature):
export function assertSourceField<T extends object, K extends keyof T & string>(
  row: T,
  field: K,
): void { ... }
```

[VERIFIED: source-binding.ts lines 112-120 — current signature uses `DispositionOverlayRow` directly; Phase 2 widens to generic `<T extends object, K extends keyof T & string>` or adds parallel overloaded helpers per DTO type. The planner chooses the generics approach vs. separate helpers per type — both work.]

### Pattern 2: Canvas-side Orphan Assertion Insertion Point

The `agentNodes useMemo` in `CommandView.tsx` (lines 175-201) already iterates `snapshot.agents` and `snapshot.tasks` to build `AgentNode[]`. A task's `targetAgent` key (`${t.namespace}/${t.targetAgent}`) may not exist in `snapshot.agents` — that IS the orphan scenario. The assertion belongs here, not in `computeLayout` (which is a pure spatial function and should stay pure).

```typescript
// Source: packages/workbench-ui/src/CommandView.tsx lines 175-201
// Insertion point: AFTER building the map, BEFORE return
const agentNodes = useMemo<readonly AgentNode[]>(() => {
  const map = new Map<string, AgentNode>();
  for (const a of snapshot.agents.values()) { ... }
  for (const t of snapshot.tasks.values()) {
    const key = `${t.namespace}/${t.targetAgent}`;
    // CC-01: orphan assertion — task references agent key not in snapshot.agents
    if (isDevBuild() && t.targetAgent !== undefined && !snapshot.agents.has(key)) {
      throw new Error(
        `CC-01 source-binding violation: task '${t.namespace}/${t.name}' ` +
        `references agent key '${key}' not in snapshot.agents. ` +
        `See COMMAND-CENTER-CONTRACT.md §2.`
      );
    }
    if (!map.has(key)) { ... }
  }
  return Array.from(map.values());
}, [snapshot.agents, snapshot.tasks]);
```

[VERIFIED: CommandView.tsx lines 175-201 — current code adds agent-nodes from orphan task targets WITHOUT any assertion. The CC-01 assertion closes this gap.]

**Note:** The current code at line 188-199 already handles the case where `t.targetAgent` produces a key not in `snapshot.agents` by adding it as a synthetic AgentNode. CC-01 changes the behavior: in dev, the orphan task reference throws. In prod, the current fallback behavior can remain (the assertion is no-op). The planner must decide: (a) keep the fallback in prod only, or (b) remove the fallback entirely and let the assertion enforce strict source-binding. Option (a) is safer for v0.2.

### Pattern 3: DispositionOverlay HTML-over-Canvas Pattern

DispositionOverlay renders as an `<aside>` absolutely positioned HTML element alongside the canvas — NOT as SVG overlay or canvas draw calls. [VERIFIED: DispositionOverlay.tsx lines 72-191] The `<aside>` uses CSS module classes. The pressure overlay follows the same shape.

Representative JSX (quoted verbatim from DispositionOverlay.tsx):

```tsx
// Source: DispositionOverlay.tsx lines 110-125
<div
  className={styles.metric}
  data-source-fields={useSourceFields(['spentTokensToday', 'idleBehavior'])}
>
  <span className={styles.metricLabel}>Tokens</span>{' '}
  <span
    className={
      tokensExceeded && pressureDramatization
        ? styles.pressureDramatic
        : styles.metricValue
    }
  >
    {tokensExceeded
      ? `+${fmtNumber(row.spentTokensToday - tokensPerDay)} over budget`
      : `${fmtNumber(tokensRemaining)} remaining`}
  </span>
</div>
```

```tsx
// Source: DispositionOverlay.tsx lines 159-172 — pressure marker (anchor with detail link)
{tokensExceeded && (
  <a
    className={
      pressureDramatization
        ? styles.pressureMarker
        : styles.pressureMarkerSubdued
    }
    data-source-fields={useSourceFields(['spentTokensToday', 'idleBehavior'])}
    href={agentDetailHref}
  >
    Tokens over budget — open agent detail →
  </a>
)}
```

[VERIFIED: DispositionOverlay.tsx]

### Pattern 4: pressureDramatization Flag Wiring

The flag is defined at module scope in `CommandView.tsx` (lines 83-85):

```typescript
// Source: CommandView.tsx lines 83-85
const pressureDramatization: boolean =
  (import.meta as unknown as { env?: { VITE_PRESSURE_DRAMATIZATION?: string } }).env
    ?.VITE_PRESSURE_DRAMATIZATION !== 'false';
```

It is passed as a prop to `DispositionOverlay` at line 1384:
```tsx
<DispositionOverlay
  snapshot={snapshot}
  pressureDramatization={pressureDramatization}
/>
```

The new `PressureOverlay` receives the same prop verbatim. No new env-var. No new detection logic. [VERIFIED: CommandView.tsx]

### Pattern 5: Hash-Route Deep Links (existing)

From `CommandView.tsx` (task detail links at lines 1971, 1985):
```tsx
href={`#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`}
```

From `App.tsx` lines 17-21 (routes):
- `#/` (or no hash) → TaskList
- `#/tasks/<namespace>/<name>` → TaskDetail
- `#/gateway` → GatewayPage
- `#/cluster` → ClusterPage
- `#/command` → CommandView

[VERIFIED: App.tsx, CommandView.tsx]

### Pattern 6: Reload-Stability Snapshot Test (existing pattern from Phase 1)

From `DispositionOverlay.test.tsx` Test 7 (lines 193-228):

```typescript
// Source: DispositionOverlay.test.tsx lines 206-218
function snapshotShape(container: HTMLElement): unknown {
  return Array.from(container.querySelectorAll('[data-agent-ref]')).map((row) => ({
    agentRef: row.getAttribute('data-agent-ref'),
    text: row.textContent,
    sourceFields: Array.from(
      row.querySelectorAll('[data-source-field],[data-source-fields]'),
    ).map((el) => ({
      tag: el.tagName.toLowerCase(),
      singleField: el.getAttribute('data-source-field'),
      multiFields: el.getAttribute('data-source-fields'),
      text: el.textContent,
    })),
  }));
}
const { container, rerender } = render(<DispositionOverlay snapshot={snapshot} />);
const first = snapshotShape(container);
rerender(<DispositionOverlay snapshot={snapshot} />);
const second = snapshotShape(container);
expect(second).toEqual(first);
expect(second).toMatchSnapshot();
```

[VERIFIED: DispositionOverlay.test.tsx — CC-02 mirrors this with a full unmount/remount pattern]

### Anti-Patterns to Avoid

- **Mutating `computeLayout` to add assertions:** `layout.ts` is a pure spatial function. Keep it pure. Assertions belong in the `agentNodes useMemo` caller in `CommandView.tsx`.
- **New env-var for pressure per-type:** Single `VITE_PRESSURE_DRAMATIZATION` covers all 9 types. Adding per-type toggles is explicitly deferred.
- **`innerHTML`/raw HTML snapshot strings in reload-stability test:** Use stable selectors (data attributes + textContent), NOT `innerHTML`. `innerHTML` contains CSS-module hash suffixes that change per build (per OpenCode LOW #8 documented in DispositionOverlay.test.tsx).
- **Fetching TaskDetail for pressure classification in `pressure.ts`:** All 9 pressure types must be derived from `CommandSnapshot` (TaskSummary + GatewayCapacityRow + lastEventAt). `TaskDetail` is NOT in the snapshot. TaskSummary-only fallbacks are documented below.
- **Adding `agentRef`-keyed loop to the existing `agentNodes useMemo`:** The current code supports tasks whose `targetAgent` is not in `snapshot.agents`. The orphan assertion must be designed carefully — see Finding #7 for the exact "TASK-ORPHAN" vs "AGENT-ORPHAN" distinction.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Test environment setup | New jsdom setup | Existing `vitest.config.ts` (already configured with jsdom + react plugin) | Phase 1 set this up; Phase 2 inherits it |
| CSS-hash-agnostic snapshots | Raw `innerHTML` string snapshots | `data-source-field` attribute selectors + textContent | CSS modules generate build-time hashes; raw HTML snapshots would fail on every rebuild |
| `pressureDramatization` detection | New env-var / new hook | `VITE_PRESSURE_DRAMATIZATION` already wired at module scope in `CommandView.tsx:83` | Phase 1 established this; Phase 2 passes the same boolean prop |
| `isDevBuild()` reimplementation | New prod/dev check | `isDevBuild()` from `source-binding.ts` | Handles NODE_ENV, Vite import.meta.env.PROD/DEV, and safe-default; already tested |
| Pressure endpoint | `/api/pressure` workbench-api route | UI-side derivation in `pressure.ts` | Explicitly locked out of scope in all three constraint documents |

---

## Findings: Specific Answers for the Planner

### Finding 1: `pilotEvidence` field paths and TaskSummary vs TaskDetail availability

`pilotEvidence` is on `TaskDetail`, NOT on `TaskSummary`. [VERIFIED: packages/workbench-ui/src/types.ts line 177]

`TaskSummary` fields (in the Command Center snapshot — Command Center is snapshot-only):
`name`, `namespace`, `uid`, `phase?`, `targetAgent?`, `targetCapability?`, `model?`, `createdAt?`, `startedAt?`, `completedAt?`, `podName?`, `error?`, `suspicious?`, `artifactCount?`, `childCount?`, `aggregatePhase?`

`TaskDetail`-only fields (NOT in snapshot; only available via `GET /api/tasks/<ns>/<name>`):
`originalUserMessage?`, `payload?`, `result?`, `expectedTools?`, `parentDistillation?`, `parentTask?`, `containerStatuses`, `children?`, `artifacts?`, `successCount?`, `failureCount?`, `inFlightCount?`, `traceLink?`, `pilotEvidence?`

`TaskPilotEvidence` internal fields (`pilotEvidence.*`):
- `pilotEvidence.audit.{labels, annotations, tenant?, createdBy?, managedBy?, parentTaskUid?}`
- `pilotEvidence.policy.{agentResolved, tools?, capabilities?, allowedChildAgents?, allowedChildTemplates?, maxConcurrentChildren?, maxInFlightTasks?}`
- `pilotEvidence.taskGraph.{childCount?, successCount?, failureCount?, inFlightCount?, aggregatePhase?, parentTask?}`
- `pilotEvidence.artifacts.{count?}`
- `pilotEvidence.structuralVerdict?.{suspicious}`
- `pilotEvidence.verification?.{passed, mode, reason?, completedAt?}`
- `pilotEvidence.capabilityRef?`
- `pilotEvidence.runConfig?: Record<string, unknown>` — maxIterations lives here but is an opaque value; planner must not assume a specific key name

[VERIFIED: packages/workbench-ui/src/types.ts lines 115-178]

### Finding 2: Per-pressure-type source fields with TaskSummary-only fallbacks

| Pressure Kind | Ideal Source | In TaskSummary Snapshot? | TaskSummary Fallback |
|---------------|-------------|--------------------------|---------------------|
| context | `pilotEvidence.policy.maxConcurrentChildren` + `pilotEvidence.taskGraph.inFlightCount` ratio | NO (TaskDetail only) | `childCount >= 2 && phase === 'Dispatched'` as weak heuristic; or defer firing unless pilotEvidence is reachable |
| gateway saturation | `GatewayCapacityRow.inFlight / GatewayCapacityRow.currentCap >= 0.8` | YES (gatewayCapacity is in snapshot) | N/A — all fields available |
| policy denial | audit-event SSE kind (existing SSE stream) | PARTIAL — SSE `cache` events are `{kind, op, key}`; NO structured audit-event kind in current SSE shape | Fallback: `phase === 'Failed' && error` containing "policy" or "capability" string match (ASSUMED heuristic; fragile) — recommend BLOCKING on this type unless a clean source field is found |
| verifier failure | `pilotEvidence.verification.passed === false` | NO (TaskDetail only) | `phase === 'Failed' && error` containing "verifier" — weak; CONTEXT.md already documents this fallback |
| artifact debt | `artifactCount === 0 && phase === 'Completed'` | YES — `artifactCount` is on TaskSummary | N/A — available in snapshot |
| trace gap | `traceLink === undefined` on terminal task | NO (`traceLink` only on TaskDetail) | `phase === 'Completed' || phase === 'Failed'` AND we cannot verify traceLink from snapshot → marker fires as "trace link unknown"; links to TaskDetail |
| pod failure | `phase === 'Failed' && podName !== undefined` | YES — both fields on TaskSummary | N/A — good enough for v0.2 |
| quota wall | `dispositions[agentKey].overBudget === true` | YES — dispositions Map is in snapshot (Phase 1) | N/A — use disposition overlay's overBudget field; detailLink → `#/tasks/<ns>/<name>` for most recent task |
| stale telemetry | SSE heartbeat staleness via `lastEventAt` | YES — `CommandSnapshot.lastEventAt: number` is already in the snapshot | N/A — available |

[VERIFIED: types.ts, state.ts; policy-denial fallback is ASSUMED fragile]

**Planner note on policy denial:** The current SSE stream emits `{kind: 'task'|'agent'|'job'|'pod', op: 'upsert'|'delete', key: string}` — there is NO structured audit-event kind. The CONTEXT.md says "audit-event stream consumed by SSE" but the existing `subscribeCacheEvents` in `api.ts` only handles `cache` and `heartbeat` event types. The planner should document that policy-denial pressure uses `phase === 'Failed' && error?.includes('policy')` as a v0.2 best-effort fallback, OR defer this specific type to Phase 3 when an audit-event stream is added. The default posture per CONTEXT.md is "all 9 derived from existing fields" — the fallback string match satisfies the letter but is fragile.

### Finding 3: `streamLastEventAt` status in `useCommandSnapshot`

`CommandSnapshot` already has `lastEventAt: number` (not `streamLastEventAt`). [VERIFIED: state.ts lines 69, 93, 195, 207, 229]

- `lastEventAt` is updated on every SSE `cache` event AND on every heartbeat event (line 207).
- It is initialized to `Date.now()` on mount.
- The stale-telemetry pressure type should use `snapshot.lastEventAt`, not a new field.
- No change to `state.ts` is required for this pressure type.

### Finding 4: DispositionOverlay render surface

`DispositionOverlay` renders as an absolutely positioned HTML `<aside>` element — NOT SVG, NOT canvas draw calls. [VERIFIED: DispositionOverlay.tsx line 72]

The `<aside>` uses CSS module class `styles.card`. The pressure overlay should follow the same shape: a top-level HTML element (e.g., `<section>` or `<aside>`) with CSS module positioning, containing HTML markers (likely `<a>` elements) per pressure marker. The existing CSS module `DispositionOverlay.module.css` is the template for the new `PressureOverlay.module.css`.

### Finding 5: `pressureDramatization` flag — exact wiring

Module-scope constant in `CommandView.tsx`:
```typescript
// Source: CommandView.tsx line 83-85
const pressureDramatization: boolean =
  (import.meta as unknown as { env?: { VITE_PRESSURE_DRAMATIZATION?: string } }).env
    ?.VITE_PRESSURE_DRAMATIZATION !== 'false';
```

Passed to `DispositionOverlay` at line 1382-1385. The new `PressureOverlay` receives it at the SAME JSX location (just below `<DispositionOverlay />`).

`DispositionOverlay` interface declares it as `readonly pressureDramatization?: boolean` with default `true`. The new `PressureOverlay` uses identical interface shape.

[VERIFIED: CommandView.tsx, DispositionOverlay.tsx]

### Finding 6: `computeLayout` signature and return shape

```typescript
// Source: layout.ts lines 103, 53-57
export function computeLayout(agents: readonly AgentNode[], bounds: CanvasBounds): LayoutResult

export interface LayoutResult {
  readonly gateway: { x: number; y: number };
  readonly agents: ReadonlyMap<string, AgentPosition>;
  readonly factions: ReadonlyMap<string, { angle: number; count: number }>;
}
```

`computeLayout` is called at `CommandView.tsx:274` inside the RAF render loop, with `agentNodes` (the useMemo result). The CC-01 canvas-side assertion belongs in the `useMemo` at lines 175-201 — before the array is passed to `computeLayout` — so it runs once per snapshot change rather than once per animation frame. [VERIFIED: layout.ts, CommandView.tsx]

The CC-02 scene-graph snapshot is `JSON.stringify(computeLayout(agentNodes, bounds))` — but since `computeLayout` is deterministic from `agentNodes`, the test can call it directly with a known `bounds` value (e.g., `{width: 1280, height: 800}`) rather than needing access to `layoutRef.current`.

### Finding 7: Canvas-side orphan assertion — "TASK-ORPHAN" vs "AGENT-ORPHAN" distinction

The current `agentNodes useMemo` has TWO kinds of agents in the final array:
1. Agents from `snapshot.agents` (fully backed by `AgentSummaryRow`)
2. Agents synthesized from `snapshot.tasks` whose `targetAgent` is NOT in `snapshot.agents` (lines 188-199)

The CC-01 assertion applies to case 2: a task references an agent key that doesn't exist in `snapshot.agents`. This IS an orphan per the contract. But it's worth noting that today the code handles this gracefully (no assertion, just synthesizes a node). The planner must decide whether the assertion should:

(a) **Throw** in dev (strict enforcement — tasks that reference nonexistent agents fail loudly)
(b) **Warn** in dev (console.warn, not throw — less disruptive for the homelab where agents may be briefly absent from the snapshot during SSE churn)

CONTEXT.md says "Throws in dev with a message naming the orphan key." Option (a) is the locked decision. The planner should note that a brief window during SSE reconnect may produce false positives — `isDevBuild()` + throw is still the right call, but the error message should direct the developer to check SSE connectivity, not just assume a contract violation.

### Finding 8: CC-02 fixture capture mechanics

The workbench-ui dev server command: `pnpm -C packages/workbench-ui dev` (Vite, proxies `/api/*` to workbench-api). The workbench-api start: `pnpm -C packages/workbench-api start`.

Fixture capture pipeline (against a running `workbench-api` on `localhost:3001` or via Vite proxy):

```bash
# Run these against the workbench-api dev server.
# Requires a cluster/mock cluster with at least:
#   - 3 agents in kagent-system
#   - 6 tasks (mix of phases including at least 1 Failed, 1 Completed with artifacts)
#   - 2 gateway endpoints with one near saturation
#   - 1 disposition with overBudget=true

WORKBENCH_API=http://localhost:3001

# Capture all four endpoints into one fixture file
jq -n \
  --argjson agents    "$(curl -s $WORKBENCH_API/api/agents)" \
  --argjson tasks     "$(curl -s $WORKBENCH_API/api/tasks)" \
  --argjson gateway   "$(curl -s $WORKBENCH_API/api/gateway/capacity)" \
  --argjson dispositions "$(curl -s $WORKBENCH_API/api/dispositions)" \
  '{agents: $agents, tasks: $tasks, gatewayCapacity: $gateway, dispositions: $dispositions}' \
  > packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json
```

If no live workbench-api is available (homelab GitOps-only per CLAUDE.md), the planner should create the fixture by hand with synthetic data matching the DTO shapes from `packages/workbench-ui/src/types.ts`. The fixture must include at least one case for each of the 9 pressure types. [VERIFIED: api.ts endpoint paths, types.ts DTO shapes]

### Finding 9: Existing snapshot files

```
packages/workbench-ui/src/command/__snapshots__/
└── DispositionOverlay.test.tsx.snap
```

One snapshot file exists (Phase 1 Test 7 — reload stability). [VERIFIED: filesystem]

The Phase 2 planner adds:
- `PressureOverlay.test.tsx.snap` (from CC-04 snapshot tests)
- `cc-reload-stability.test.tsx.snap` (from CC-02 test, or inline snapshot in the test file)

### Finding 10: `TaskSummaryFieldName` closed enum — exact fields

From `TaskSummary` in `packages/workbench-ui/src/types.ts` [VERIFIED]:

```
name, namespace, uid, phase, targetAgent, targetCapability, model,
createdAt, startedAt, completedAt, podName, error, suspicious,
artifactCount, childCount, aggregatePhase
```

These 16 fields match CONTEXT.md's `TaskSummaryFieldName` union exactly.

### Finding 11: `AgentSummaryFieldName` closed enum — exact fields

From `AgentSummaryRow` in `packages/workbench-ui/src/types.ts` [VERIFIED]:

```
name, namespace, model, modelClass, tools, capabilities
```

Note: `AgentSummaryRow` (workbench-ui/src/types.ts) does NOT have `sandboxProfile` or `recentTaskCounts` — those are on `AgentSummary` in `packages/dto/src/types.ts`. The workbench-ui types.ts has a LOCAL `AgentSummaryRow` interface with only 6 fields (lines 191-204). [VERIFIED: types.ts line 191-204]

### Finding 12: `GatewayCapacityFieldName` closed enum — exact fields

From `GatewayCapacityRow` in `packages/workbench-ui/src/types.ts` [VERIFIED]:

```
model, endpoint, backendKind, inFlight, currentCap, seed, max, minSafe,
recentP50Ms, crName, crNamespace
```

`recentP50Ms` is typed `number | null` (not optional). Planner must handle null in rendering. [VERIFIED: types.ts line 248-265]

### Finding 13: `isDevBuild()` function body (for test authoring)

```typescript
// Source: source-binding.ts lines 75-99
function isDevBuild(): boolean {
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const nodeEnv = proc?.env?.NODE_ENV;
  if (nodeEnv === 'production') return false;        // (1) explicit prod marker
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean; PROD?: boolean } }).env;
    if (env?.PROD === true) return false;             // (2) Vite PROD flag
    if (env?.DEV === true) return true;              // (3) Vite DEV flag
  } catch { }
  if (nodeEnv !== undefined) return nodeEnv !== 'production'; // (4) other NODE_ENV
  return true;                                        // (5) safe default = dev
}
```

Test pattern: `vi.stubEnv('NODE_ENV', 'production')` disables assertions (step 1 fires first).
`vi.stubEnv('NODE_ENV', 'development')` (or default) keeps assertions active.
[VERIFIED: source-binding.ts lines 75-99]

### Finding 14: `source-binding.ts` generics migration plan

**Current:** `assertSourceField` takes `(row: DispositionOverlayRow, field: DispositionFieldName)`.
**Phase 2 needs:** `assertSourceField` for 4 DTO types.

Two viable approaches:

**Option A — Widen to generic:**
```typescript
export function assertSourceField<T extends object, K extends keyof T & string>(
  row: T, field: K
): void { ... }
```
This breaks the closed-enum guarantee at the TypeScript level (any object + any keyof works). Less safe but simpler.

**Option B — Per-DTO overloads:**
Add `assertAgentSourceField`, `assertTaskSourceField`, `assertGatewaySourceField` alongside the existing `assertSourceField`. Keeps each call site narrowed to the correct enum.

**Recommendation (planner's decision):** Option A is simpler and the closed enum is enforced at the CALL SITE by TypeScript (the enum type narrows what `K` can be when the caller passes a string literal). The assertion's runtime check (`field in row`) is the same either way. Option A is the Phase 2 path of least resistance since all existing source-binding.test.ts tests still pass.

### Finding 15: Existing hash-route deep link pattern (verbatim from code)

From `CommandView.tsx` AgentPanel (line 1971, 1985):
```tsx
href={`#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`}
```

From `CommandView.tsx` TaskPanel (line 2036):
```tsx
href={`#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`}
```

GatewayPage route from `App.tsx`:
```
#/gateway   → GatewayPage
#/cluster   → ClusterPage
```

GatewayPanel additions in CC-03 use `href="#/gateway"` (no namespace/name suffix needed; GatewayPage renders all endpoints). [VERIFIED: App.tsx, CommandView.tsx]

---

## Common Pitfalls

### Pitfall 1: `agentNodes` orphan assertion — false positive during SSE reconnect

**What goes wrong:** When the SSE stream disconnects briefly, the cache may stale-out (agents disappear, tasks remain). The orphan assertion fires for every task referencing an agent that temporarily dropped from the snapshot.
**Why it happens:** `useCommandSnapshot` refetches agents on SSE events, but between events there's a window where the maps are inconsistent.
**How to avoid:** The assertion should check `isDevBuild()` AND also emit a `console.warn` instead of `throw` for the task-references-absent-agent case (keeping `throw` only for the hard violation: a scene node rendered by `drawScene` whose key returns `undefined` from `snapshot.agents.get(key)`). Alternatively, `throw` in dev is fine — the test fixture is frozen and won't have this transient state.
**Warning signs:** Tests that use real `useCommandSnapshot()` (not mocked) may flap if the fixture loading order is non-deterministic.

### Pitfall 2: `pressure.ts` classify function called on every render

**What goes wrong:** If `classify(snapshot)` is called during React render (inside the component function body), it runs on every snapshot state change — potentially multiple times per second under SSE activity.
**Why it happens:** Pressure classification is O(snapshot size) — iterating all tasks, all agents, all gateway rows. Not expensive for a 3-agent homelab, but the pattern should be consistent.
**How to avoid:** Wrap `classify(snapshot)` in `useMemo(() => PRESSURE_TYPES.flatMap(pt => pt.classify(snapshot)), [snapshot])` in the `PressureOverlay` component. The `snapshot` reference changes only when the Maps change, which is correct.
**Warning signs:** Profiler shows `PressureOverlay` rendering > 60fps.

### Pitfall 3: `recentP50Ms: number | null` in GatewayCapacityRow

**What goes wrong:** `recentP50Ms` is typed `number | null` — rendering it with `?? '—'` is correct, but `!== undefined` guards will not catch the null case.
**Why it happens:** The workbench-api maps SQL `NULL` values as JSON `null` (not `undefined`). The comment at `GatewayUsageRow` explicitly warns about this (types.ts lines 284-286).
**How to avoid:** Use `row.recentP50Ms != null` (double-equals, catches both null and undefined), or `row.recentP50Ms !== null && row.recentP50Ms !== undefined`.
**Warning signs:** `null.toString()` error in GatewayCapacityPanel rendering.

### Pitfall 4: CC-02 reload-stability test — `layoutRef.current` is not directly testable

**What goes wrong:** `layoutRef` is a React ref maintained inside `CommandView`'s render loop — it's not exposed as a prop or return value. The reload-stability test cannot directly access `layoutRef.current`.
**Why it happens:** `computeLayout` is called inside the RAF `useEffect`, not during React render.
**How to avoid:** The CC-02 test verifies the scene-graph by calling `computeLayout` directly in the test with the same `agentNodes` input derived from the fixture. Since `computeLayout` is a pure deterministic function, `computeLayout(agentNodesFromFixture, {width: 1280, height: 800})` produces the same result as the RAF loop would. [VERIFIED: layout.ts — pure function, no side effects]
**Warning signs:** Test tries to access `layoutRef.current` via `container.querySelector('[data-layout-ref]')` or similar — there is no such attribute; the layout is canvas-only.

### Pitfall 5: `import.meta.env.VITE_PRESSURE_DRAMATIZATION` — static inlining at build time

**What goes wrong:** Tests that try to mock `VITE_PRESSURE_DRAMATIZATION` via `vi.stubEnv` may not work because `pressureDramatization` is evaluated ONCE at module load time and cached as a module-scope constant.
**Why it happens:** Vite inlines `import.meta.env` values at build time; `vi.stubEnv` operates on `process.env`, not `import.meta.env`.
**How to avoid:** In tests, mock the module or accept that `pressureDramatization` is always `true` in the test environment (since `VITE_PRESSURE_DRAMATIZATION` is not set in vitest). Test both code paths by passing `pressureDramatization={true}` and `pressureDramatization={false}` as explicit props to the overlay component — this is how `DispositionOverlay.test.tsx` Test 5 handles it. [VERIFIED: DispositionOverlay.test.tsx Test 5 pattern]

### Pitfall 6: `TaskSummaryFieldName` for computed values (active task counter, failure counters)

**What goes wrong:** The active-task counter in AgentPanel (count of `inFlight.length`) derives from iterating ALL tasks and matching `targetAgent` + non-terminal phase. This is a COMPUTED value from TWO fields on EACH task — `phase` and `targetAgent`. The source-binding assertion for this counter should be `useSourceFields(['phase', 'targetAgent'])` on each task, NOT a direct field on `AgentSummaryRow`.
**Why it happens:** The counter is derived from the `snapshot.tasks` Map, not from a direct field on `AgentSummaryRow`.
**How to avoid:** Document the data-source-fields attribute as `data-source-fields="phase,targetAgent"` on the counter element. This is consistent with CONTEXT.md D-CC-03-A which already specifies `useSourceFields(['phase', 'targetAgent'])` for this case.
**Warning signs:** Code that writes `data-source-field="inFlightCount"` on the AgentPanel counter — `inFlightCount` is not on `AgentSummaryRow`, it's on `TaskDetail`.

---

## Code Examples

### CC-01: Canvas-Side Orphan Assertion (insertion point)

```typescript
// Source: CommandView.tsx lines 175-201, extended for CC-01
// Pattern from: source-binding.ts isDevBuild()
const agentNodes = useMemo<readonly AgentNode[]>(() => {
  const map = new Map<string, AgentNode>();
  for (const a of snapshot.agents.values()) {
    const key = `${a.namespace}/${a.name}`;
    map.set(key, { key, namespace: a.namespace, name: a.name, ... });
  }
  for (const t of snapshot.tasks.values()) {
    if (t.targetAgent === undefined) continue;
    const key = `${t.namespace}/${t.targetAgent}`;
    // CC-01: canvas-side orphan assertion
    if (isDevBuild() && !snapshot.agents.has(key)) {
      throw new Error(
        `CC-01 source-binding violation: task '${t.namespace}/${t.name}' references agent ` +
        `'${key}' not in snapshot.agents. See COMMAND-CENTER-CONTRACT.md §2 Prime Directive.`
      );
    }
    if (!map.has(key)) {
      map.set(key, { key, namespace: t.namespace, name: t.targetAgent, ... });
    }
  }
  return Array.from(map.values());
}, [snapshot.agents, snapshot.tasks]);
```

### CC-04: `pressure.ts` module skeleton

```typescript
// MIT header required
// packages/workbench-ui/src/command/pressure.ts

import type { CommandSnapshot } from './state.js';

export interface PressureMarker {
  readonly kind: PressureType['kind'];
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly affectedKey?: string; // ns/name of the agent or task
  readonly detailLink: string;
  readonly label: string;
}

export interface PressureType {
  readonly kind:
    | 'context' | 'gateway' | 'policy' | 'verifier'
    | 'artifact' | 'trace' | 'pod' | 'quota' | 'telemetry';
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly classify: (snapshot: CommandSnapshot) => PressureMarker[];
  readonly detailLink: (marker: PressureMarker) => string;
}

export const PRESSURE_TYPES: readonly PressureType[] = [ ... ]; // 9 entries

// PressureFieldName is derived from PRESSURE_TYPES to keep single source of truth:
export type PressureFieldName = typeof PRESSURE_TYPES[number]['kind'];
```

### CC-03: `AgentPanel` source-field addition pattern

```tsx
// Source: CommandView.tsx AgentPanel (line 1898), extended for CC-03
// Mirror of DispositionOverlay.tsx's pattern for data-source-fields

{a?.capabilities && a.capabilities.length > 0 ? (
  <div
    className={styles.panelKv}
    data-source-field={useSourceField('capabilities' as AgentSummaryFieldName)}
  >
    <span>Capabilities</span>
    <span>{a.capabilities.join(', ')}</span>
  </div>
) : null}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct DTO field access without source-binding | `assertSourceField` + `data-source-field` DOM attributes | Phase 1 (DISP-04) | Dev-time contract enforcement; Phase 2 generalizes |
| Single overlay type (DispositionOverlay) | Multiple overlays (Disposition + Pressure) | Phase 2 (this phase) | Each overlay is independently testable |
| No fixture directory | `__fixtures__/cc-snapshot.json` | Phase 2 Wave 0 | Enables deterministic reload-stability tests |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Policy denial pressure can be approximated with `phase === 'Failed' && error?.includes('policy')` | Finding #2 | Marker fires for non-policy failures, OR misses policy denials with different error text. Risk: LOW accuracy pressure signal. The CONTEXT.md already documents this as a known gap. |
| A2 | `computeLayout` return value is JSON-serializable (no circular references, no functions) | Finding #4 (Pitfall 4) | If not serializable, `JSON.stringify(computeLayout(...))` in the CC-02 test throws. Inspection shows `LayoutResult` contains `{gateway: {x,y}, agents: Map<string, AgentPosition>, factions: Map<string, ...>}` — Maps are NOT JSON-serializable by default; planner must convert to object or use `Array.from` in the snapshot assertion. |
| A3 | The agentNodes orphan throw is acceptable even if it fires during transient SSE reconnect | Finding #7 | Tests that render CommandView with a live SSE connection may get unexpected throws. In practice, tests mock `subscribeCacheEvents` (established pattern in state.test.ts), so this is test-safe. |

**Note on A2 (CRITICAL):** `Map` objects serialize to `{}` with `JSON.stringify`. The CC-02 scene-graph snapshot must use `Array.from(layout.agents.entries())` or a custom serializer, NOT raw `JSON.stringify(layoutRef.current)`. The planner must handle this explicitly in the test design.

---

## Open Questions

1. **Policy denial pressure source field**
   - What we know: The SSE stream only emits `{kind: 'task'|'agent'|'job'|'pod', op: 'upsert'|'delete', key: string}` — no structured audit-event type.
   - What's unclear: Does the workbench-api emit any structured policy-denial signal in the current codebase that the UI can consume?
   - Recommendation: Check `packages/workbench-api/` for any `/api/audit` or similar endpoint. If none exists, use `phase === 'Failed' && error` string matching as v0.2 fallback and document it in `pressure.ts` with a TODO for Phase 3.

2. **`AgentSummaryRow.sandboxProfile` not in workbench-ui types**
   - What we know: `packages/dto/src/types.ts AgentSummary` has `sandboxProfile: 'default' | 'strict'`, but `packages/workbench-ui/src/types.ts AgentSummaryRow` does NOT include it.
   - What's unclear: Does the workbench-api currently serialize `sandboxProfile` in the `/api/agents` response? If yes, it's available at runtime but the TypeScript type doesn't declare it.
   - Recommendation: For CC-03 AgentPanel, limit to the declared `AgentSummaryRow` fields. Do not access `sandboxProfile` unless the UI type is updated. Not a blocker.

3. **`LayoutResult.agents` Map serialization in CC-02 scene-graph snapshot**
   - What we know: `Map` does not serialize to JSON by default.
   - What's unclear: Whether the planner should use `JSON.stringify(Object.fromEntries(layout.agents))`, a recursive replacer, or simply assert on `Array.from(layout.agents.entries()).sort(...)` for snapshot stability.
   - Recommendation: Use `Object.fromEntries(layout.agents)` for the scene-graph snapshot — it produces a stable key-sorted object suitable for `toMatchSnapshot()`.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | vitest, workbench-api start | Yes | 23.11.1 | — |
| pnpm | `pnpm -C packages/workbench-ui test` | Confirmed (project uses pnpm workspace) [VERIFIED: package.json] | — | — |
| vitest (workbench-ui) | All tests | Yes | 4.1.4 (installed) | — |
| @testing-library/react | DispositionOverlay.test.tsx pattern | Yes | 16.3.0 (installed) | — |
| workbench-api (for fixture capture) | CC-02 fixture | Needs running instance | — | Hand-craft fixture from types.ts shapes |
| K8s cluster (for live workbench-api) | CC-02 fixture capture with real data | Homelab only (GitOps) | — | Hand-craft fixture |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:**
- Live workbench-api for fixture capture → hand-craft `cc-snapshot.json` using `types.ts` shapes directly. The fixture is committed to git; it doesn't require a live cluster after that.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.4 |
| Config file | `packages/workbench-ui/vitest.config.ts` |
| Quick run command | `pnpm -C packages/workbench-ui test` |
| Full suite command | `pnpm -C packages/workbench-ui test -- --coverage` |

Coverage thresholds: NOT configured in `vitest.config.ts` (coverage is `provider: 'v8'`, `reporter: ['text', 'lcov']` — no `thresholds`). The planner may add `thresholds: { lines: 85, ... }` to enforce CC's ≥85% on source-binding.ts + pressure.ts. [VERIFIED: vitest.config.ts]

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CC-01 | Orphan agent assertion fires in dev | unit | `pnpm -C packages/workbench-ui test -- source-binding` | Partial — source-binding.test.ts covers disposition slice; CC-01 additions needed |
| CC-01 | Production no-op for orphan assertion | unit | same | Partial — Test 3 pattern in source-binding.test.ts covers it; new type-specific tests needed |
| CC-01 | Canvas-side orphan assertion in agentNodes useMemo | unit | `pnpm -C packages/workbench-ui test -- cc-orphan` | No — Wave 0 gap |
| CC-02 | Reload-stability DOM snapshot matches across remounts | snapshot | `pnpm -C packages/workbench-ui test -- cc-reload` | No — Wave 0 gap |
| CC-02 | Reload-stability scene-graph (computeLayout output) matches | snapshot | same | No — Wave 0 gap |
| CC-03 | AgentPanel renders capabilities/modelClass/counters with data-source-field | unit | `pnpm -C packages/workbench-ui test -- AgentPanel` | No — Wave 0 gap |
| CC-03 | TaskPanel renders timestamps/suspicious/artifact-count with data-source-field | unit | `pnpm -C packages/workbench-ui test -- TaskPanel` | No — Wave 0 gap |
| CC-03 | GatewayPanel renders with data-source-fields + open-in-GatewayPage link | unit | `pnpm -C packages/workbench-ui test -- GatewayPanel` | No — Wave 0 gap |
| CC-04 | Each of 9 pressure types fires when source data is present | unit | `pnpm -C packages/workbench-ui test -- pressure` | No — Wave 0 gap |
| CC-04 | Each of 9 pressure types does NOT fire when source data is absent | unit | same | No — Wave 0 gap |
| CC-04 | PressureOverlay renders markers with data-source-field + pressureDramatization | snapshot | `pnpm -C packages/workbench-ui test -- PressureOverlay` | No — Wave 0 gap |

### Sampling Rate

- **Per task commit:** `pnpm -C packages/workbench-ui test`
- **Per wave merge:** `pnpm -C packages/workbench-ui test -- --coverage`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` — CC-02 fixture (hand-craft or capture)
- [ ] `packages/workbench-ui/src/command/pressure.ts` — skeleton with `PRESSURE_TYPES` array, `PressureMarker` interface, `PressureType` interface
- [ ] `packages/workbench-ui/src/command/pressure.test.ts` — 9 per-type scenarios (present+absent)
- [ ] `packages/workbench-ui/src/command/PressureOverlay.tsx` — skeleton (renders `null` until classify is implemented)
- [ ] `packages/workbench-ui/src/command/PressureOverlay.test.tsx` — snapshot + source-binding tests
- [ ] `packages/workbench-ui/src/command/PressureOverlay.module.css` — empty placeholder
- [ ] Extend `packages/workbench-ui/vitest.config.ts` to add coverage thresholds (optional per planner)

---

## Security Domain

Phase 2 is pure read-side UI hardening — no new authentication, no new API endpoints, no user input processing beyond what already exists in the Command Center (task dispatch, which is out of scope for this phase). No ASVS categories newly applicable. The existing session/auth boundary is enforced by workbench-api (not changed in this phase).

Security enforcement is nominally enabled per default config, but this phase introduces no new attack surface. [ASSUMED: no `security_enforcement: false` in config.json, but the config.json only has `workflow._auto_chain_active: false`]

---

## Project Constraints (from CLAUDE.md)

| Directive | Phase 2 Compliance |
|-----------|-------------------|
| TypeScript primary, strict mode, ESM, Node 22 target | All new files are `.ts`/`.tsx` with ESM imports and strict types |
| MIT license header on every `.ts` source file | Required on `pressure.ts`, `PressureOverlay.tsx`, `PressureOverlay.test.tsx`, `PressureOverlay.module.css` (CSS doesn't need it; .ts/.tsx do) |
| Conventional commits with `phase-02-...` scope | `feat(phase-02-source-binding): ...`, `feat(phase-02-pressure): ...`, etc. |
| No squash-on-merge | Each atomic task commit survives; GSD enforces |
| Tests: vitest, co-located `*.test.ts`, ≥85% on source-binding.ts and pressure.ts, ≥75% on glue code | Enforced by phase test posture |
| No new CRD, no new workbench-api endpoint, no imperative kubectl | All Phase 2 work is in `packages/workbench-ui/` |
| `gh pr create` and `gh pr merge` are NOT a unit | PR created, merge requires explicit consent |
| GitOps only on homelab (verify via Job manifests, not imperative kubectl) | Not applicable — Phase 2 is pure UI; no cluster verification needed |

---

## Sources

### Primary (HIGH confidence)

- `packages/workbench-ui/src/command/source-binding.ts` — exact `isDevBuild()` body, assert helpers, `DispositionFieldName` shape [VERIFIED in session]
- `packages/workbench-ui/src/command/source-binding.test.ts` — test patterns, vi.stubEnv usage [VERIFIED in session]
- `packages/workbench-ui/src/command/DispositionOverlay.tsx` — HTML-over-canvas render surface, `pressureDramatization` prop shape, JSX patterns [VERIFIED in session]
- `packages/workbench-ui/src/command/DispositionOverlay.test.tsx` — reload-stability snapshot strategy, `snapshotShape` function, Test 7 mount/rerender pattern [VERIFIED in session]
- `packages/workbench-ui/src/command/state.ts` — `CommandSnapshot` interface, `lastEventAt` field, SSE wiring [VERIFIED in session]
- `packages/workbench-ui/src/command/layout.ts` — `computeLayout` exact signature, `LayoutResult` shape, pure function confirmation [VERIFIED in session]
- `packages/workbench-ui/src/CommandView.tsx` — `pressureDramatization` module-scope const (line 83), `agentNodes useMemo` (line 175), panel locations (AgentPanel 1898, TaskPanel 2000, GatewayPanel 1697), overlay mount site (line 1382), hash-route deep links [VERIFIED in session]
- `packages/workbench-ui/src/types.ts` — `TaskSummary`, `TaskDetail`, `AgentSummaryRow`, `GatewayCapacityRow`, `TaskPilotEvidence` exact fields [VERIFIED in session]
- `packages/workbench-ui/src/api.ts` — API endpoint paths, `subscribeCacheEvents` SSE shape [VERIFIED in session]
- `packages/workbench-ui/src/App.tsx` — hash-route table [VERIFIED in session]
- `packages/workbench-ui/vitest.config.ts` — jsdom env, coverage provider, no thresholds [VERIFIED in session]
- `packages/workbench-ui/package.json` — testing-library versions, dev/test scripts [VERIFIED in session]
- `packages/dto/src/types.ts` — `TaskDetail`, `AgentSummary` (note: different from workbench-ui's `AgentSummaryRow`) [VERIFIED in session]
- `docs/COMMAND-CENTER-CONTRACT.md` — §2 Prime Directive, §6 pressure types table, §7 Slice A/B/E acceptance [VERIFIED in session]

### Secondary (MEDIUM confidence)

- `.planning/phases/01-agentdisposition-v0/01-04-PLAN.md` — DISP-04 plan; confirmed Phase 1 shipped exactly the source-binding.ts and DispositionOverlay.tsx patterns described [VERIFIED: plan matches actual code]

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — all dependencies verified against package.json in this session
- Architecture: HIGH — all source files read directly; no assumptions on structure
- Field paths: HIGH — verified against actual types.ts files
- Pitfalls: HIGH (structural) / MEDIUM (policy-denial source) — structural pitfalls observed directly in code; policy-denial fallback is an acknowledged gap in CONTEXT.md
- Test patterns: HIGH — DispositionOverlay.test.tsx is the verbatim template

**Research date:** 2026-05-10
**Valid until:** Stable — this is pure UI work against a committed codebase; valid until types.ts or CommandView.tsx changes

---

## RESEARCH COMPLETE
