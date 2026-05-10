# Phase 3: resource-flow-overlays — Pattern Map

**Mapped:** 2026-05-10
**Files analyzed:** 13 (6 NEW + 7 MODIFIED/REGEN/OPTIONAL)
**Analogs found:** 12 / 13 (only `docs/FLOW-LEGEND.md` lacks a direct analog — uses `pressure.ts` inline-comment block + `COMMAND-CENTER-CONTRACT.md` §7 as joint template)

> **Phase 3 thesis (from RESEARCH.md):** Phase 3 is a 1:1 mirror of Phase 2's shipped `pressure.*` files with the noun changed from "pressure" to "flow". Every analog below is a Phase 2 file currently in the repo; the executor's job is mostly mechanical translation, with two deliberate semantic deviations called out per file.

## File Classification

| New / Modified File                                                               | Role                                                           | Data Flow                                | Closest Analog                                                                              | Match Quality |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------- |
| `packages/workbench-ui/src/command/flows.ts` (NEW)                                | data module / closed-enum array of typed entries               | pure-function transform over snapshot    | `packages/workbench-ui/src/command/pressure.ts`                                             | exact         |
| `packages/workbench-ui/src/command/FlowOverlay.tsx` (NEW)                         | presentation overlay component (React FC + `<aside>`)          | request-response (snapshot prop in, JSX) | `packages/workbench-ui/src/command/PressureOverlay.tsx`                                     | exact         |
| `packages/workbench-ui/src/command/FlowOverlay.module.css` (NEW)                  | scoped CSS module (dramatic + subdued class pair)              | static styling                           | `packages/workbench-ui/src/command/PressureOverlay.module.css`                              | exact         |
| `packages/workbench-ui/src/command/flows.test.ts` (NEW)                           | vitest unit test (8 fires + 8 absent + 1 fixture-assert)       | pure-function assertion                  | `packages/workbench-ui/src/command/pressure.test.ts`                                        | exact         |
| `packages/workbench-ui/src/command/FlowOverlay.test.tsx` (NEW)                    | vitest component test (4 tests, jsdom + RTL)                   | DOM render-and-query                     | `packages/workbench-ui/src/command/PressureOverlay.test.tsx`                                | exact         |
| `packages/workbench-ui/src/command/source-binding.ts` (MODIFY)                    | source-binding contract module — add `FlowFieldName` re-export | type re-export                           | Same file (existing `PressureFieldName` re-export at line 112 is the in-file analog)        | exact         |
| `packages/workbench-ui/src/command/source-binding.test.ts` (MODIFY)               | vitest type-narrowing test — add `FlowFieldName` test(s)       | type-system assertion                    | Same file (existing CC-01 generalization tests A–I, lines 263–438, are the in-file analog)  | exact         |
| `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` (MODIFY)        | committed JSON test fixture                                    | static data                              | Existing fixture — additive ~2-field delta on `fanout-005` task (Finding 5 in RESEARCH.md)  | exact         |
| `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap` (REGEN) | auto-regenerated snapshot artifact                             | committed test artifact                  | Same file — `vitest -u` regenerates after FlowOverlay mounts                                | exact         |
| `packages/workbench-ui/src/CommandView.tsx` (MODIFY)                              | integration mount site — 1 import + 1 JSX block                | sibling component composition            | Existing `<PressureOverlay />` mount at lines 1410–1413 is the in-file analog               | exact         |
| `packages/workbench-ui/src/command/cc-reload.test.tsx` (no code edit)             | vitest reload-stability test (snapshot regen only)             | DOM render-and-query                     | Same file — Phase 3 only triggers a snapshot regen; no code changes                         | exact         |
| `docs/FLOW-LEGEND.md` (NEW)                                                       | developer-facing legend (markdown table + per-flow sections)   | static documentation                     | `pressure.ts` inline comment blocks (lines 6–24, 201–310) + `COMMAND-CENTER-CONTRACT.md` §7 | partial       |
| `docs/COMMAND-CENTER-CONTRACT.md` (OPTIONAL, separate commit)                     | references-section single-line link addition                   | static documentation                     | Existing §7 references in surrounding sections                                              | role-match    |

---

## Pattern Assignments

### `packages/workbench-ui/src/command/flows.ts` (NEW — data module)

**Analog:** `packages/workbench-ui/src/command/pressure.ts` (319 lines)

**SPDX header + module-level JSDoc** — copy `pressure.ts:1–24` shape verbatim, swap noun + cite `C-flow-economy` instead of §6 Pressure Systems, swap `D-CC-04-A` for `D-01-A`:

```ts
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * flows — Phase 3 / FLOW-01. UI-side derivation of eight resource
 * flow gauges from existing CommandSnapshot fields. No new
 * workbench-api endpoint, no new substrate state. Each entry in
 * FLOW_TYPES declares its source field(s), compute function, and
 * detail-link computation.
 *
 * See intel/constraints.md §C-flow-economy for the canonical eight
 * flow definitions, COMMAND-CENTER-CONTRACT.md §7 Slice E for the
 * binding "legend in developer docs, NOT in main UI chrome"
 * constraint, and CONTEXT.md D-01-A for the decision to ship as a
 * sibling overlay to PressureOverlay (NOT a replacement).
 *
 * v0.2 fallback notes (per RESEARCH.md Finding 10):
 *   Five of the eight flows (tokenFlow, buildPower, podCapacity,
 *   authority, trust) have an "ideal" source on TaskDetail or
 *   ClusterSnapshot that does not reach useCommandSnapshot() today.
 *   Each entry's leading comment names the ideal source + promotion
 *   phase, mirroring pressure.ts:201–310.
 */
```

**Imports** (`pressure.ts:26–27`) — copy verbatim:

```ts
import type { CommandSnapshot } from './state.js';
import type { TaskSummary } from '../types.js';
```

**Interface shape** — adapt `pressure.ts:29–58` (PressureMarker + PressureType). Add gauge-specific fields (`value`, `capacity`, `unit`) and rename `classify` → `compute`. Per CONTEXT.md D-01-A:

```ts
export interface FlowGauge {
  readonly kind: FlowType['kind'];
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly affectedKey?: string; // ns/name/endpoint for per-instance gauges
  readonly detailLink: string;
  readonly label: string;
  readonly value: number; // numerator
  readonly capacity?: number; // denominator (undefined for rates without a cap)
  readonly unit?: string; // 'in flight' | 'tasks' | 'pods' | 'denials' | 'events' | 'items' | 'artifacts'
}

export interface FlowType {
  readonly kind:
    | 'modelPower'
    | 'tokenFlow'
    | 'buildPower'
    | 'podCapacity'
    | 'artifactBandwidth'
    | 'authority'
    | 'trust'
    | 'attention';
  readonly granularity: 'perEndpoint' | 'perModelClass' | 'perAgent' | 'perNode' | 'substrateWide';
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly compute: (snapshot: CommandSnapshot) => readonly FlowGauge[];
  readonly detailLink: (gauge: FlowGauge) => string;
}
```

**`taskKey()` helper** — `pressure.ts:72–74`. Re-implement verbatim or import from `pressure.ts` (planner picks; default = duplicate to avoid cross-module coupling):

```ts
function taskKey(t: { readonly namespace: string; readonly name: string }): string {
  return `#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`;
}
```

**Per-entry pattern** — `pressure.ts:76–96` (gateway saturation, the cleanest example):

```ts
// ─────────────────────────── gateway saturation ───────────────────────────
// Source fields: GatewayCapacityRow.inFlight + GatewayCapacityRow.currentCap.
// Fires when inFlight/currentCap >= 0.8 for any gateway row.
{
  kind: 'gateway',
  sourceFields: ['inFlight', 'currentCap'],
  classify: (s): PressureMarker[] =>
    s.gatewayCapacity
      .filter((row) => row.currentCap > 0 && row.inFlight / row.currentCap >= 0.8)
      .map(
        (row): PressureMarker => ({
          kind: 'gateway',
          sourceFields: ['inFlight', 'currentCap'],
          affectedKey: row.endpoint,
          detailLink: '#/gateway',
          label: `${row.model} — ${String(row.inFlight)}/${String(row.currentCap)} in flight (≥80%)`,
        }),
      ),
  detailLink: (): string => '#/gateway',
},
```

Phase 3 mirror for `modelPower` (RESEARCH.md Example 1, lines 386–411):

```ts
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

**v0.2 fallback comment block** — `pressure.ts:201–207` (context pressure, the canonical fallback comment):

```ts
// ─────────────────────────── context pressure ───────────────────────────
// Ideal source is `pilotEvidence.policy.maxConcurrentChildren` ratio
// against `pilotEvidence.taskGraph.inFlightCount`, but pilotEvidence
// lives on TaskDetail, NOT TaskSummary, so the v0.2 heuristic uses
// TaskSummary.childCount >= 2 while phase=Dispatched. Promote to
// the ideal source if pilotEvidence is added to TaskSummary in a
// future phase (per RESEARCH.md Finding 2).
```

Mirror for each Phase 3 fallback flow — text supplied verbatim by CONTEXT.md D-02-tokenFlow, D-02-buildPower, D-02-podCapacity, D-02-authority, D-02-trust, D-02-attention. Five v0.2 fallback comment blocks total (modelPower + artifactBandwidth get a 1-line "Clean source" comment per RESEARCH.md Promotion Paths section).

**Closed-enum-from-array footer** — `pressure.ts:314–319` (the load-bearing pattern):

```ts
/**
 * Derived from PRESSURE_TYPES['kind'] so the closed-enum stays in
 * one place. Now resolves to the union of all nine kind literals
 * automatically because PRESSURE_TYPES is populated.
 */
export type PressureFieldName = PressureType['kind'];
```

Phase 3 mirror — copy with noun + count swap:

```ts
/**
 * Derived from FLOW_TYPES['kind'] so the closed-enum stays in
 * one place. Resolves to the union of all eight kind literals
 * automatically because FLOW_TYPES is populated.
 */
export type FlowFieldName = FlowType['kind'];
```

**What to copy verbatim:**

- SPDX/JSDoc shape, `taskKey()` helper signature, interface property names (`kind`, `sourceField`/`sourceFields`, `affectedKey`, `detailLink`, `label`), per-entry leading-comment style, closed-enum-from-array footer.

**What to change:**

- `classify` → `compute`, add `value`/`capacity`/`unit`/`granularity` fields, swap union literals, citation footers reference `C-flow-economy` + `D-01-A` not §6 + `D-CC-04-A`.

**Pitfalls applicable (from RESEARCH.md §Common Pitfalls):**

- **Pitfall 4 (JSON imports):** N/A here — `flows.ts` doesn't import the JSON fixture.
- **Anti-pattern: Hand-typed `FlowFieldName` union.** Use the derived `FlowType['kind']` form; hand-typed drifts silently. RESEARCH.md §Anti-Patterns.
- **Mutating snapshot in `compute()`.** `compute` MUST be pure — anything else breaks `useMemo` reload-stability invariant.
- **`tokenFlow` mislabeled as a real token rate (Risk row 6, RESEARCH.md Finding 9):** literally use `unit: 'tasks'` and `label: 'tasks dispatched per model'` per CONTEXT.md D-02-tokenFlow. A casual `unit: 'tokens/min'` is a Prime Directive violation. The inline comment ALSO mentions Finding 1 — `gatewayUsage` IS already on the snapshot (state.ts:88) so the operator can promote later by changing only the `compute()` body.

---

### `packages/workbench-ui/src/command/FlowOverlay.tsx` (NEW — presentation overlay)

**Analog:** `packages/workbench-ui/src/command/PressureOverlay.tsx` (77 lines)

**SPDX + JSDoc shell** — copy `PressureOverlay.tsx:1–22` verbatim, swap noun + cite Phase 3 / FLOW-01 / D-01-A.

**Imports + props interface** — `PressureOverlay.tsx:24–39`:

```tsx
import { type FC, useMemo } from 'react';

import { PRESSURE_TYPES } from './pressure.js';
import type { PressureMarker } from './pressure.js';
import type { CommandSnapshot } from './state.js';
import styles from './PressureOverlay.module.css';

export interface PressureOverlayProps {
  readonly snapshot: CommandSnapshot;
  /**
   * Slice E base-building-only fallback. Default true. When false
   * the same data still renders but the dramatic CSS class is
   * replaced with a subdued one.
   */
  readonly pressureDramatization?: boolean;
}
```

Phase 3 mirror — same prop name (`pressureDramatization` per CONTEXT.md D-04-A — single global flag). Same default `true`. New imports: `FLOW_TYPES`, `FlowGauge`, `FlowType` from `./flows.js`. New CSS module path: `./FlowOverlay.module.css`.

**`useMemo` over snapshot — KEY DEVIATION from `PressureOverlay.tsx:45–48`:**

`PressureOverlay.tsx` flat-lists markers and returns null on empty (line 49):

```tsx
const markers = useMemo<readonly PressureMarker[]>(
  () => PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot)),
  [snapshot],
);
if (markers.length === 0) return null;
```

`FlowOverlay` MUST group by kind and MUST NOT return null — per CONTEXT.md D-05-A "all 8 flows are ALWAYS visible — silence is data". RESEARCH.md Pitfall 7 calls this out explicitly:

```tsx
const gaugesByKind = useMemo<ReadonlyMap<FlowType['kind'], readonly FlowGauge[]>>(() => {
  const m = new Map<FlowType['kind'], readonly FlowGauge[]>();
  for (const ft of FLOW_TYPES) {
    m.set(ft.kind, ft.compute(snapshot));
  }
  return m;
}, [snapshot]);
```

**Render shape (`<aside>` + per-row anchor + conditional spread)** — `PressureOverlay.tsx:51–76`:

```tsx
return (
  <aside className={styles.card} aria-label="Pressure markers">
    <header className={styles.header}>Pressure</header>
    <ul className={styles.list}>
      {markers.map((marker, i) => {
        const stableKey = `${marker.kind}-${marker.affectedKey ?? `idx-${String(i)}`}`;
        const sf = marker.sourceField;
        const sfs = marker.sourceFields;
        return (
          <li key={stableKey} className={styles.row}>
            <a
              className={
                pressureDramatization ? styles.pressureMarker : styles.pressureMarkerSubdued
              }
              href={marker.detailLink}
              {...(sf !== undefined ? { 'data-source-field': sf } : {})}
              {...(sfs !== undefined ? { 'data-source-fields': sfs.join(',') } : {})}
            >
              {marker.label} →
            </a>
          </li>
        );
      })}
    </ul>
  </aside>
);
```

Phase 3 mirror — RESEARCH.md Example 4 (lines 446–504) is the exact-shape template. The grouping iterates `FLOW_TYPES` (NOT the flat gauge list) so empty sections render placeholder rows. Conditional spread for `data-source-field`/`data-source-fields` is identical to `PressureOverlay.tsx:66–67`. Class swap uses `styles.flowGauge` / `styles.flowGaugeSubdued`. `aria-label="Resource flows"`, header text `"Flows"`.

**What to copy verbatim:**

- Conditional-spread idiom for `data-source-field` / `data-source-fields` (RESEARCH.md Pattern 3 — required for strict-typed JSX; `attribute={undefined}` is rejected).
- Stable React key formula: `` `${kind}-${affectedKey ?? `idx-${String(i)}`}` `` (`PressureOverlay.tsx:56`).
- Pure-function `useMemo` over snapshot only — no internal state, no fetches, no localStorage. Reload-stable by construction.
- Class-swap on `pressureDramatization` boolean (RESEARCH.md Pattern 5).
- Prop name `pressureDramatization` (CONTEXT.md D-04-A — DO NOT rename to `flowDramatization`).

**What to change:**

- `<aside aria-label="Pressure markers">` → `<aside aria-label="Resource flows">`.
- Header text `Pressure` → `Flows`.
- Iterate `FLOW_TYPES` for grouping (NOT the flat gauge list); render section header always; per-flow body has empty-state placeholder when `gauges.length === 0`.
- Gauge text: `${label} ${value}/${capacity} ${unit}` when capacity defined; `${label} ${value} ${unit}` when capacity undefined (RESEARCH.md Example 4 lines 479–482).
- Empty-state row carries `data-source-field`(s) per `FlowType` (NOT per-gauge — per `ft.sourceField` / `ft.sourceFields`) so the orphan-assertion still has a backing field.

**Pitfalls applicable:**

- **Pitfall 7 (empty-state rows required, not optional):** DO NOT copy `PressureOverlay.tsx:49`'s `if (markers.length === 0) return null;` — this is the deliberate semantic deviation. Render section header + placeholder row.
- **Anti-pattern: Reading `import.meta.env.VITE_*` inside `FlowOverlay.tsx`.** Read it ONCE at `CommandView.tsx:95–97` and pass as prop (already plumbed for PressureOverlay).
- **Anti-pattern: Painting on-canvas legend tooltip / "?" button.** Slice E forbids it (`COMMAND-CENTER-CONTRACT.md:255`).

---

### `packages/workbench-ui/src/command/FlowOverlay.module.css` (NEW — CSS module)

**Analog:** `packages/workbench-ui/src/command/PressureOverlay.module.css` (87 lines)

**Full file copy with class-name + position adjustments.**

**Card positioning** — `PressureOverlay.module.css:11–28`:

```css
.card {
  position: absolute;
  top: 56px; /* clear the top HUD, same vertical band as DispositionOverlay */
  left: 16px;
  min-width: 280px;
  max-width: 360px;
  background: #0a1628;
  border: 1px solid #1f2a44;
  border-radius: 6px;
  padding: 0.75rem 0.9rem;
  color: #cbd5e1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(248, 113, 113, 0.06);
  z-index: 7;
  pointer-events: auto;
}
```

Phase 3 — DEVIATE on positioning to avoid overlapping PressureOverlay (`top: 56px; left: 16px`) and DispositionOverlay (`top: 56px; right: 16px`). Per RESEARCH.md Open Question 2, recommended default:

```css
.card {
  position: absolute;
  bottom: 16px; /* below PressureOverlay's vertical band */
  left: 16px;
  min-width: 280px;
  max-width: 380px;
  max-height: 60vh;
  overflow-y: auto; /* 8 sections × 1–~5 gauges may need scrolling */
  /* ...rest matches PressureOverlay.module.css verbatim... */
}
```

Planner picks final positioning; mention in PLAN.md per RESEARCH.md Open Question 2.

**Header / list / row classes** — `PressureOverlay.module.css:30–49` — copy verbatim (rename `.pressureMarker` to `.flowGauge` etc. is the only delta in inner structure).

**Dramatic + subdued class pair** — `PressureOverlay.module.css:51–87` — copy verbatim, rename:

- `.pressureMarker` → `.flowGauge`
- `.pressureMarkerSubdued` → `.flowGaugeSubdued`

Add new classes for flow-specific structure:

- `.section` (per-flow grouping container)
- `.sectionHeader` (per-flow `<h3>` text)
- `.emptyRow` (placeholder for `gauges.length === 0` — subdued by default per "silence is data")
- `.bar` + `.barFill` (optional thin horizontal bar when `capacity` is defined; planner picks per CONTEXT.md "Claude's Discretion" — recommended thin horizontal bar + readout overlay)
- `.readout` (the `value/capacity unit` text)

**What to copy verbatim:**

- Color palette (`#0a1628`, `#1f2a44`, `#cbd5e1`, `#f87171`/`#fca5a5` for dramatic, `#334155`/`#94a3b8` for subdued).
- `box-shadow` formula, `border-radius`, padding/font-size scale.
- Hover state structure (`background` + `border-color` transition on dramatic; `color` + `border-color` transition on subdued).

**What to change:**

- Position (away from `top: 56px; left: 16px`).
- `.pressureMarker*` → `.flowGauge*` class names.
- Add `.section` / `.sectionHeader` / `.emptyRow` / optional `.bar` + `.barFill` / `.readout`.
- Optional: subdued color for empty-state row to communicate "exists but no data".

**Pitfalls applicable:**

- **Pitfall 5 (CSS-module hashes break raw-HTML snapshots):** all tests use stable selectors; CSS-module class names get hash suffixes at build time — never `container.innerHTML` snapshots.

---

### `packages/workbench-ui/src/command/flows.test.ts` (NEW — vitest unit test)

**Analog:** `packages/workbench-ui/src/command/pressure.test.ts` (367 lines, 18 tests = 9 fires + 9 absent)

**SPDX + JSDoc** — `pressure.test.ts:1–15`. Phase 3 mirror cites FLOW-01 + 8 fires + 8 absent + 1 fixture-assert.

**`makeSnapshot()` helper** — `pressure.test.ts:29–41` — copy verbatim:

```ts
function makeSnapshot(overrides: Partial<CommandSnapshot> = {}): CommandSnapshot {
  return {
    agents: new Map<string, AgentSummaryRow>(),
    tasks: new Map<string, TaskSummary>(),
    gatewayCapacity: [] as readonly GatewayCapacityRow[],
    gatewayUsage: [] as readonly GatewayUsageRow[],
    dispositions: new Map<string, DispositionOverlayRow>(),
    events: [],
    lastEventAt: Date.now(),
    error: null,
    ...overrides,
  };
}
```

**`makeTask()` helper** — `pressure.test.ts:54–62` — copy verbatim. Each test builds the minimal snapshot satisfying or violating the trigger.

**`computeAll()` helper** — analogous to `pressure.test.ts:43–52` `classifyAll()`. Mirror verbatim with `compute` instead of `classify`:

```ts
function computeAll(snapshot: CommandSnapshot): readonly FlowGauge[] {
  return FLOW_TYPES.flatMap((ft) => ft.compute(snapshot));
}
```

**describe / beforeEach / afterEach setup** — `pressure.test.ts:64–71` — copy verbatim with `vi.stubEnv('NODE_ENV', 'development')` in beforeEach, `vi.unstubAllEnvs()` + `vi.useRealTimers()` in afterEach.

**Per-test fire/absent pair pattern** — `pressure.test.ts:75–115` (gateway saturation pair, the canonical example):

```ts
it('gateway saturation — fires when inFlight/currentCap >= 0.8', () => {
  const snap = makeSnapshot({
    gatewayCapacity: [
      {
        model: 'm',
        endpoint: 'e',
        backendKind: 'cf',
        inFlight: 8,
        currentCap: 10,
        seed: 0,
        max: 10,
        minSafe: 0,
        recentP50Ms: null,
      },
    ],
  });
  const markers = classifyAll(snap).filter((m) => m.kind === 'gateway');
  expect(markers.length).toBeGreaterThanOrEqual(1);
  expect(markers[0]?.sourceFields).toEqual(['inFlight', 'currentCap']);
  expect(markers[0]?.detailLink).toBe('#/gateway');
});
```

Phase 3 mirror — 16 tests minimum (8 fire + 8 absent), one pair per FlowType:

- modelPower fires/absent
- tokenFlow fires/absent
- buildPower fires/absent
- podCapacity fires/absent
- artifactBandwidth fires/absent
- authority fires/absent
- trust fires/absent
- attention fires/absent

**FLOW-01 fixture-assertion test** (REQUIREMENT-mandated; no Phase 2 analog, this is new contract):

```ts
it('FLOW-01 — every flow has a non-null source field reference', () => {
  for (const ft of FLOW_TYPES) {
    expect(ft.sourceField ?? ft.sourceFields).toBeDefined();
  }
});
```

**What to copy verbatim:**

- `makeSnapshot()` defaults (esp. `gatewayUsage: []` and `lastEventAt: Date.now()`).
- `vi.stubEnv('NODE_ENV', 'development')` in beforeEach (dev-build assertions on).
- `expect(markers[0]?.sourceFields).toEqual([...])` shape — assert source-field binding is preserved per Prime Directive.
- `affectedKey` shape: `${ns}/${name}` for tasks, `endpoint` for gateway rows, `${ns}/${agentName}` for agents.

**What to change:**

- `classifyAll` → `computeAll`.
- One additional assertion per fire test: `expect(gauges[0]?.value).toBeGreaterThanOrEqual(0)` (or specific value); when capacity defined: `expect(gauges[0]?.capacity).toBe(N)`.
- For tokenFlow specifically: assert `unit === 'tasks'` and `label` matches `/tasks dispatched per model/` per CONTEXT.md D-02-tokenFlow lock.
- Add the FLOW-01 fixture-assertion test (16 → 17 tests minimum).

**Pitfalls applicable:**

- **Pitfall 2 (vitest fake-timers leak):** none of the 8 flows reads `Date.now()`, so default to NO fake timers in `flows.test.ts`. If a future flow needs Date determinism, use `vi.useFakeTimers({ toFake: ['Date'] })` ONLY (selective; never default `vi.useFakeTimers()`).
- **Pitfall 3 (`globalThis.fetch` vs `global.fetch`):** N/A — `flows.test.ts` is pure-function tests on a constructed snapshot; no fetch mocking.

---

### `packages/workbench-ui/src/command/FlowOverlay.test.tsx` (NEW — vitest component test)

**Analog:** `packages/workbench-ui/src/command/PressureOverlay.test.tsx` (185 lines, 4 tests)

**SPDX + JSDoc** — `PressureOverlay.test.tsx:1–20` — copy with noun swap + Phase 3 / FLOW-01 citation.

**Imports + `makeSnapshot()` helper** — `PressureOverlay.test.tsx:22–47` — copy verbatim, replace `PressureOverlay` import with `FlowOverlay`.

**`snapshotShape()` helper** — `PressureOverlay.test.tsx:49–58` — copy verbatim:

```tsx
function snapshotShape(container: HTMLElement): unknown {
  return Array.from(container.querySelectorAll('a')).map((a) => ({
    tag: a.tagName.toLowerCase(),
    href: a.getAttribute('href'),
    singleField: a.getAttribute('data-source-field'),
    multiFields: a.getAttribute('data-source-fields'),
    text: a.textContent,
  }));
}
```

**4 tests** — `PressureOverlay.test.tsx:68–184`:

1. **Test 1 — renders gauges with `data-source-field(s)` attribute and `detailLink` href** — `PressureOverlay.test.tsx:68–88`. Phase 3 mirror: assert `<a data-source-fields="inFlight,currentCap">` exists for the modelPower gauge with `href="#/gateway"`. Plus assert each FLOW_TYPES kind appears as a `<section>` (with header text matching the kind).
2. **Test 2 — reload stability: re-render with same snapshot produces equal selector tree** — `PressureOverlay.test.tsx:90–125`. Phase 3 mirror with `FlowOverlay` + same `snapshotShape()` helper + `expect(second).toEqual(first)` + `expect(second).toMatchSnapshot()`.
3. **Test 3 — `pressureDramatization=true` applies dramatic class** — `PressureOverlay.test.tsx:127–152`. Phase 3 mirror: search for `cls.includes('flowGauge') && !cls.includes('Subdued')`.
4. **Test 4 — `pressureDramatization=false` keeps data but does NOT apply dramatic class** — `PressureOverlay.test.tsx:154–184`. Phase 3 mirror: `cls.includes('flowGaugeSubdued')` is true; data text still legible.

**What to copy verbatim:**

- `makeSnapshot()` defaults (must include `gatewayUsage: []` and `lastEventAt: Date.now()`).
- `snapshotShape()` stable-selector pattern — never `container.innerHTML` (Pitfall 5).
- `vi.stubEnv('NODE_ENV', 'development')` in beforeEach.
- 4-test structure: render + reload + dramatic + subdued.

**What to change:**

- Test 1: assert `<section>` per FlowType kind (8 sections) AND assert `data-source-field(s)` on at least one gauge.
- Test 1 (additional): empty-state row coverage — when a FlowType has no data, the placeholder row carries the FlowType's `sourceField`/`sourceFields`. Use a snapshot with NO gateway rows; assert the modelPower section still renders an empty-state row with `data-source-fields="inFlight,currentCap"`.
- Test 3 / 4: search for `flowGauge` / `flowGaugeSubdued` (NOT `pressureMarker` / `pressureMarkerSubdued`).

**Pitfalls applicable:**

- **Pitfall 5 (CSS-module class hashes break raw-HTML snapshots):** never `innerHTML`. Use stable selectors via `snapshotShape()`.
- **Pitfall 7 (empty-state rows required):** Test 1 must explicitly cover the empty-state path so the planner doesn't accidentally regress to a `null`-return implementation.

---

### `packages/workbench-ui/src/command/source-binding.ts` (MODIFY — add re-export)

**Analog:** Same file. The existing `PressureFieldName` re-export at lines 106–112 is the in-file template:

```ts
/**
 * Re-exported from pressure.ts so PRESSURE_TYPES stays the single
 * source of truth for the pressure kind union (per CONTEXT.md
 * D-CC-04-A). Wave 1 populates PRESSURE_TYPES with all 9 entries; the
 * union resolves automatically.
 */
export type { PressureFieldName } from './pressure.js';
```

**Insertion point:** Immediately after line 112, before the `isDevBuild()` function at line 131. Add ONE block (RESEARCH.md Example 3):

```ts
/**
 * Re-exported from flows.ts so FLOW_TYPES stays the single source of
 * truth for the flow kind union (per CONTEXT.md D-01-A). Wave 1
 * populates FLOW_TYPES with all 8 entries; the union resolves
 * automatically.
 */
export type { FlowFieldName } from './flows.js';
```

**What to copy verbatim:**

- JSDoc shape (4 lines), `export type { ... } from './...js';` syntax (note `.js` extension — required for Node 22 ESM).
- Citation pattern: `(per CONTEXT.md D-NN-A)` — Phase 3 cites D-01-A.

**What to change:**

- Noun (`PRESSURE_TYPES` → `FLOW_TYPES`, `pressure` → `flow`, `9 entries` → `8 entries`, `D-CC-04-A` → `D-01-A`).

**No changes to runtime helpers** — `assertSourceField<T, K>` (line 173), `assertSourceFields<T, K>` (line 220), `useSourceField<K>` (line 195), `useSourceFields<K>` (line 244) are already generic over `K extends string`. RESEARCH.md Finding 4 confirms they accept `FlowFieldName` without modification.

**Pitfalls applicable:**

- **`.js` extension required** in re-export path — Node 22 ESM resolves `./flows.js` to the compiled output (or to `flows.ts` via tsx/vitest). Bare `./flows` will fail at module load.

---

### `packages/workbench-ui/src/command/source-binding.test.ts` (MODIFY — add narrowing test)

**Analog:** Same file. The existing CC-01 generalization tests A–I at lines 263–438 are the in-file template (one describe block per closed-enum).

**Test pattern** — `source-binding.test.ts:263–271` (Test A — AgentSummaryRow.capabilities):

```ts
it('Test A — assertSourceField passes silently for AgentSummaryRow.capabilities', () => {
  const row = makeAgent();
  expect(() => {
    assertSourceField<typeof row, import('./source-binding.js').AgentSummaryFieldName>(
      row,
      'capabilities',
    );
  }).not.toThrow();
});
```

**Phase 3 additions** — extend the existing `describe('source-binding (CC-01 generalization to AgentSummaryRow / TaskSummary / GatewayCapacityRow)', ...)` block (or add a new sibling describe). 1–2 tests minimum:

```ts
it('Test K — assertSourceField narrows correctly for FlowFieldName', () => {
  // Compile-time test: FlowFieldName is the union of FLOW_TYPES['kind'].
  // At least one literal MUST type-check; this is the closed-enum proof.
  const v: import('./source-binding.js').FlowFieldName = 'modelPower';
  expect(useSourceField<import('./source-binding.js').FlowFieldName>(v)).toBe('modelPower');
});

it('Test L — useSourceFields returns comma-joined string for FlowFieldName array', () => {
  const v = useSourceFields<import('./source-binding.js').FlowFieldName>([
    'modelPower',
    'tokenFlow',
  ]);
  expect(v).toBe('modelPower,tokenFlow');
});
```

**What to copy verbatim:**

- `import('./source-binding.js').*FieldName` namespace-qualified type import pattern (lines 263–271, 273–286).
- `as unknown as <DTO>` cast for synthesized orphans.
- `vi.stubEnv('NODE_ENV', 'development')` / `vi.stubEnv('NODE_ENV', 'production')` toggle pattern (lines 287–300).

**What to change:**

- Cast to `FlowFieldName` instead of `AgentSummaryFieldName` / `TaskSummaryFieldName` / `GatewayCapacityFieldName`.
- The DTO under test isn't a single row — it's the closed-enum string union itself. Tests prove the union TYPE-CHECKS and that helpers accept it.

**Pitfalls applicable:**

- None new. Established pattern.

---

### `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` (MODIFY — additive ~2-field delta)

**Analog:** Same file. Current state (151 lines): 3 agents, 6 tasks (research-001..research-006 + fanout-005), 2 gatewayCapacity rows, 1 disposition row.

**Per RESEARCH.md Finding 5 — minimal additive change. ONLY edit task `fanout-005` (lines 79–90):**

Current `fanout-005`:

```json
{
  "name": "fanout-005",
  "namespace": "kagent-system",
  "uid": "u-005",
  "phase": "Dispatched",
  "targetAgent": "executor-03",
  "createdAt": "2026-05-10T10:05:00Z",
  "startedAt": "2026-05-10T10:05:02Z",
  "childCount": 3,
  "artifactCount": 0,
  "suspicious": ["high-fanout"]
}
```

Phase 3 — add TWO fields:

```json
{
  "name": "fanout-005",
  "namespace": "kagent-system",
  "uid": "u-005",
  "phase": "Dispatched",
  "targetAgent": "executor-03",
  "createdAt": "2026-05-10T10:05:00Z",
  "startedAt": "2026-05-10T10:05:02Z",
  "model": "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "podName": "fanout-005-pod",
  "childCount": 3,
  "artifactCount": 0,
  "suspicious": ["high-fanout"]
}
```

**Why these two:**

- `model` fires `tokenFlow` (Dispatched task with `model` set — RESEARCH.md Finding 5 row `tokenFlow`).
- `podName` fires `podCapacity` (Dispatched task with `podName` defined — RESEARCH.md Finding 5 row `podCapacity`).

**Why nothing else needed:** All 6 other flows already fire from existing fixture rows (RESEARCH.md Finding 5 verified). Adding more inflates the cc-reload snapshot.

**What to copy verbatim:**

- Synthetic naming convention (`fanout-005-pod`, `kagent-system/...`) — no real cluster identifiers. RESEARCH.md §Security `Snapshot-fixture leak of secrets` row.

**What to change:**

- ONLY add `model` + `podName` to `fanout-005`. Do NOT remove existing rows. Do NOT add new tasks (would inflate snapshot).

**Pitfalls applicable:**

- **Pitfall 4 (JSON imports):** the fixture is consumed via `import fixture from './__fixtures__/cc-snapshot.json' with { type: 'json' };` (cc-reload.test.tsx:51). Editing the JSON does NOT require import-attribute changes — but every test that DOES import it must use `with { type: 'json' }` or Node 22 throws.
- **Pitfall 1 (snapshot diff overwhelms reviewer):** keep additions truly minimal. RESEARCH.md A1 risks ~30–60 new snapshot lines; adding a 4th task would compound.

---

### `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap` (REGEN — `vitest -u`)

**Analog:** Same file. Currently 204 lines.

**No code change, no manual edit. Regenerate via:**

```bash
pnpm -C packages/workbench-ui test -- cc-reload.test.tsx --run -u
```

**Mechanism (RESEARCH.md Finding 6):**

- The test calls `expect(domSnap2).toMatchSnapshot('dom')` (cc-reload.test.tsx:249) and `expect(layoutSnap2).toMatchSnapshot('layout')` (line 250).
- After FlowOverlay first mounts in CommandView.tsx, `snapshotShape()` (cc-reload.test.tsx:127–141) captures every `[data-source-field],[data-source-fields]` element AND every `<a>`. FlowOverlay adds both.
- First post-mount run FAILS the snapshot match. The `-u` flag updates.

**Commit discipline (RESEARCH.md Pitfall 1, Risk row 1):**

- Land the `<FlowOverlay />` mount in CommandView.tsx as ONE commit. This commit FAILS `cc-reload.test.tsx` — flag the failure in the commit message as the trigger for the next commit.
- Land the `vitest -u` regeneration as a SEPARATE commit containing ONLY the snapshot file diff. Reviewer scrutinizes only the snapshot, not interleaved code+snapshot changes.

**What to copy verbatim:**

- Nothing — auto-generated.

**What to change:**

- Nothing manually. Vitest regenerates.

**Pitfalls applicable:**

- **Pitfall 1 (snapshot diff overwhelms reviewer):** split into two commits as described above.
- **A1 (RESEARCH.md Assumption Log):** snapshot expected to grow ~30–60 new lines. If it grows much larger (200+), planner reduces fixture richness or splits into smaller snapshot cases.

---

### `packages/workbench-ui/src/CommandView.tsx` (MODIFY — 1 import + 1 JSX block)

**Analog:** Same file. Existing `<PressureOverlay />` mount at lines 1410–1413 is the in-file template:

```tsx
<PressureOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />
```

Plus the existing import next to line 53 area:

```ts
// (existing import for PressureOverlay near line 53)
import { PressureOverlay } from './command/PressureOverlay.js';
```

**Phase 3 changes — RESEARCH.md Finding 7 (Example 5, lines 511–530):**

1. Add 1 import line near line 53 (next to the existing `PressureOverlay` import):

```ts
import { FlowOverlay } from './command/FlowOverlay.js';
```

2. Insert the FlowOverlay mount at line 1414 (immediately after the `<PressureOverlay />` block at lines 1410–1413, before the `<div className={styles.hotkeyStrip}>` at line 1415):

```tsx
{
  /* Phase 3 / FLOW-01 — eight C-flow-economy flow gauges. Sibling
    to PressureOverlay; same single global VITE_PRESSURE_DRAMATIZATION
    flag covers both per CONTEXT.md D-04-A. Every gauge carries
    data-source-field(s) per Prime Directive (D7). */
}
<FlowOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />;
```

**What to copy verbatim:**

- `pressureDramatization` prop name (CONTEXT.md D-04-A — DO NOT rename).
- `snapshot` prop wiring (single read from `useCommandSnapshot()`).
- `.js` extension in import path (Node 22 ESM).
- `<PressureOverlay />` mount JSX shape.

**What to change:**

- Component name (`PressureOverlay` → `FlowOverlay`).
- Insertion site is JUST BELOW the existing PressureOverlay mount, NOT replacing it. Phase 3 explicitly ships sibling overlays (CONTEXT.md D-01-A).

**Pitfalls applicable:**

- **Anti-pattern: Reading `import.meta.env.VITE_PRESSURE_DRAMATIZATION` again inside FlowOverlay.** It's already read at lines 95–97 and bound to `pressureDramatization`. Pass the prop down.
- **Pre-commit hook Node-22 requirement** (Pitfall 6): `source ~/.nvm/nvm.sh && nvm use 22` before commit if machine default is Node 23+.

---

### `packages/workbench-ui/src/command/cc-reload.test.tsx` (no code edit)

**Analog:** Same file. Phase 2 / CC-02 reload-stability test (252 lines).

**No source-code changes.** Only the committed `__snapshots__/cc-reload.test.tsx.snap` file is regenerated (see prior section).

**Why this matters for executor:** the planner should NOT touch this file. Any edit would invalidate the Phase 2 contract that cc-reload.test.tsx asserts: "DOM and scene-graph snapshots are deep-equal across mount → unmount → remount with the same fixture." The `<FlowOverlay />` mount in CommandView.tsx is already covered by this test because `snapshotShape()` at line 127 picks up every `[data-source-field],[data-source-fields]` element plus every `<a>` — both of which FlowOverlay produces.

**Existing test infrastructure that the planner can reference (already in place):**

- `vi.stubEnv('NODE_ENV', 'development')` at line 190 — orphan-assertion fires.
- `vi.useFakeTimers({ toFake: ['Date'] })` at line 195 — selective Date freeze (RESEARCH.md Pitfall 2 — never default `vi.useFakeTimers()`).
- `vi.setSystemTime(new Date('2026-05-10T12:00:00Z'))` at line 196 — fixed wallclock.
- `globalThis.fetch` spy via `makeFetchMock()` at lines 161–186 — RESEARCH.md Pitfall 3 (`globalThis.fetch`, NOT `global.fetch`).
- `urlOf()` helper at lines 153–159 — handles `Request | URL | string`.
- `serializableLayout()` helper at lines 111–117 — `Object.fromEntries(map)` for `ReadonlyMap` snapshots (RESEARCH.md Pitfall in Phase 2 SUMMARY).
- JSON import attribute at line 51: `import fixture from './__fixtures__/cc-snapshot.json' with { type: 'json' };` — Pitfall 4.

**Pitfalls applicable (all carry forward, none triggered by Phase 3 directly):**

- Pitfalls 1, 2, 3, 4, 5 — see prior sections.

---

### `docs/FLOW-LEGEND.md` (NEW — developer-facing legend)

**Analog:** No exact analog. Closest references:

- `pressure.ts` lines 6–24 (module-level JSDoc + contract reference) — for the **framing paragraph**.
- `pressure.ts` lines 201–310 (per-entry leading comment style with v0.2 fallback documentation) — for the **per-flow section content**.
- `docs/COMMAND-CENTER-CONTRACT.md` §7 Slice E — for the **constraint citation** ("legend in developer docs, NOT in main UI chrome").
- CONTEXT.md D-02-modelPower..D-02-attention — verbatim source for **per-flow text** (CONTEXT.md is the locked spec).

**Doc shape (per CONTEXT.md D-03-A):**

```markdown
# Flow Legend (developer docs — NOT in main UI chrome)

> Eight `C-flow-economy` resource flows rendered as continuous gauges in
> Command Center's `<FlowOverlay />`. This is the developer-facing source
> of truth for what each flow IS, where its data comes FROM, and how it
> WILL evolve. Per `docs/COMMAND-CENTER-CONTRACT.md` §7 Slice E, this
> legend is NOT replicated as on-canvas chrome (no tooltip, no "?"
> button, no sidebar key). Operators read code + docs.
>
> Visual treatment of all overlays (disposition, pressure, flows) is
> controlled by `VITE_PRESSURE_DRAMATIZATION`. Set `false` for
> base-building-only mode (subdued styling, same data).
>
> Living doc — update when `packages/workbench-ui/src/command/flows.ts`
> adds, removes, or promotes a flow.

## Sources

- `.planning/intel/constraints.md` §C-flow-economy — canonical 8-flow definition
- `docs/COMMAND-CENTER-CONTRACT.md` §7 Slice E — overlay binding contract
- `.planning/phases/03-resource-flow-overlays/03-CONTEXT.md` D-01..D-05 — locked decisions

## At-a-glance

| Flow       | Granularity   | v0.2 source                                                        | Ideal source                                          | Pressure trigger             | Operator action             | Promotion path                                             |
| ---------- | ------------- | ------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------- | --------------------------- | ---------------------------------------------------------- |
| modelPower | perEndpoint   | `GatewayCapacityRow.inFlight + currentCap`                         | (clean — same)                                        | `gateway` (`pressure.ts:80`) | scale gateway / rebalance   | n/a                                                        |
| tokenFlow  | perModelClass | `count(TaskSummary by model)` in phase=Dispatched (`unit='tasks'`) | `GatewayUsageRow.inputTokens+outputTokens` rolling 1m | (no direct trigger today)    | watch model class hot-spots | promote when rolling-window reaches `useCommandSnapshot()` |
| ...        | ...           | ...                                                                | ...                                                   | ...                          | ...                         | ...                                                        |

## Per-flow detail

### modelPower

[2–3 sentence description; exact field path; gauge sample]

### tokenFlow

[2–3 sentence description; exact CONTEXT.md D-02-tokenFlow excerpt; ideal source per Finding 10]

[... 6 more sections ...]
```

**What to copy verbatim:**

- Citation footer style from `pressure.ts:6–24` ("See `<FILE>` `<SECTION>` for ..." pattern).
- Per-flow comment text from CONTEXT.md D-02-modelPower..D-02-attention (CONTEXT.md is the locked spec — copy the prose).
- Cross-link to `pressure.ts` for each flow's pressure trigger (the pressure type that complements the flow).
- Flag note from CONTEXT.md D-04-A: "Visual treatment of all overlays (disposition, pressure, flows) is controlled by `VITE_PRESSURE_DRAMATIZATION`."

**What to change:**

- Markdown not TypeScript JSDoc (different syntax, same content discipline).
- Add the at-a-glance 8-row table per CONTEXT.md D-03-A — the table is the at-a-glance entry point; the per-flow sections are the deep dive.
- Add a "Living doc" footer note.

**Pitfalls applicable:**

- **Anti-pattern: Modifying `docs/COMMAND-CENTER-CONTRACT.md` §6 to enumerate the 8 flows inline.** The contract is binding/load-bearing; the legend is living. Keep them separate. CONTEXT.md OOS bullet, RESEARCH.md §Anti-Patterns.
- **No on-canvas legend tooltip / "?" button (Slice E acceptance, `COMMAND-CENTER-CONTRACT.md:255`).** The legend is markdown only.
- The optional `docs/COMMAND-CENTER-CONTRACT.md` references-link is a SEPARATE commit (RESEARCH.md Open Question 3 — recommended last commit in Phase 3).

---

### `docs/COMMAND-CENTER-CONTRACT.md` (OPTIONAL — separate commit, single line)

**Analog:** Existing references in surrounding sections of the contract (no exact same-shape line in the file today).

**Phase 3 (OPTIONAL) — add ONE line in the references area or footer (after §10 "Guidance for the next implementation agent" near end of file):**

```markdown
See also: `docs/FLOW-LEGEND.md` for the eight `C-flow-economy` flow definitions surfaced via Command Center's `<FlowOverlay />` (Phase 3 / FLOW-01).
```

**Discipline:**

- LAST commit in Phase 3 if at all. RESEARCH.md Open Question 3 recommends include.
- This is NOT a contract revision (CONTEXT.md OOS — the contract enumeration of flows would be a revision; a footer link is discoverability).

**What to copy verbatim:**

- Backtick-style file references (matches existing contract conventions).

**What to change:**

- N/A — single new line.

**Pitfalls applicable:**

- **Don't enumerate flows inline.** Single discoverability link only.

---

## Shared Patterns

### Pattern S1: Closed-enum-from-array (FieldName derivation)

**Source:** `packages/workbench-ui/src/command/pressure.ts` lines 314–319
**Apply to:** `flows.ts` (Phase 3) AND any future overlay module that ships a typed-array of entries with `kind` literals.

```ts
/**
 * Derived from PRESSURE_TYPES['kind'] so the closed-enum stays in
 * one place. Now resolves to the union of all nine kind literals
 * automatically because PRESSURE_TYPES is populated.
 */
export type PressureFieldName = PressureType['kind'];
```

**Phase 3 mirror:** `export type FlowFieldName = FlowType['kind'];` plus the `export type { FlowFieldName } from './flows.js';` re-export at `source-binding.ts:113`.

**Why this is shared:** Hand-typed string-literal unions drift silently when the source array is edited; derived form fails compile when `FLOW_TYPES` and `FlowFieldName` diverge.

---

### Pattern S2: Conditional-spread for optional `data-*` attributes

**Source:** `packages/workbench-ui/src/command/PressureOverlay.tsx` lines 66–67
**Apply to:** ALL DOM render sites in `FlowOverlay.tsx` (gauge rows AND empty-state placeholder rows).

```tsx
{...(sf !== undefined ? { 'data-source-field': sf } : {})}
{...(sfs !== undefined ? { 'data-source-fields': sfs.join(',') } : {})}
```

**Why this is shared:** TypeScript's strict-typed JSX rejects `attribute={undefined}`. The conditional-spread idiom preserves type-strictness when one of two attributes (single OR multi) is set. RESEARCH.md Pattern 3.

---

### Pattern S3: Pure-function `useMemo` over snapshot (no internal state)

**Source:** `packages/workbench-ui/src/command/PressureOverlay.tsx` lines 45–48

```tsx
const markers = useMemo<readonly PressureMarker[]>(
  () => PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot)),
  [snapshot],
);
```

**Apply to:** `FlowOverlay.tsx` (Phase 3) — recomputed only on snapshot change. Reload-stable by construction. NO internal state, NO `localStorage`, NO fetches, NO `useEffect` for derived data.

**Why this is shared:** Reload-stability (CC-02) is the binding contract; `useMemo` over the snapshot prop is the only way to honor it. Anything else introduces UI-only state that survives reload — which Phase 2 explicitly tests against in `cc-reload.test.tsx`.

---

### Pattern S4: Subdued/dramatic CSS class swap

**Source:** `packages/workbench-ui/src/command/PressureOverlay.tsx` lines 62–64 + `PressureOverlay.module.css` lines 51–87

```tsx
className={
  pressureDramatization ? styles.pressureMarker : styles.pressureMarkerSubdued
}
```

**Apply to:** `FlowOverlay.tsx` gauge rows AND empty-state placeholder rows. CSS class swap, NOT data toggle. Per CONTEXT.md D-04-A — single global flag.

**Why this is shared:** Phase 2 locked single-global-flag (`VITE_PRESSURE_DRAMATIZATION`). Splitting per overlay would double env-var surface AND create the meaningless "pressure-dramatic-but-flows-subdued" failure mode. Same flag, same prop name, same default `true`, same class-swap idiom.

---

### Pattern S5: SPDX header on every `.ts` / `.tsx` source file

**Source:** Every `.ts` source file in this repo (e.g., `pressure.ts:1–4`, `PressureOverlay.tsx:1–4`).

```ts
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */
```

**Apply to:** All 5 new `.ts`/`.tsx` files in Phase 3 (`flows.ts`, `FlowOverlay.tsx`, `flows.test.ts`, `FlowOverlay.test.tsx`). Also the new CSS module (`FlowOverlay.module.css`) — Phase 2's `PressureOverlay.module.css:1–9` includes a comment-style SPDX header.

**Why this is shared:** Project convention from `CLAUDE.md` (root). Pre-commit hook may enforce.

---

### Pattern S6: `vi.stubEnv('NODE_ENV', 'development')` in beforeEach for source-binding-aware tests

**Source:** `pressure.test.ts` lines 65–67, `PressureOverlay.test.tsx` lines 61–63, `source-binding.test.ts` lines 50–53.

```ts
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers(); // pressure.test.ts only — defensive
});
```

**Apply to:** `flows.test.ts`, `FlowOverlay.test.tsx`. Ensures dev-build assertions are active in tests.

**Why this is shared:** `isDevBuild()` (`source-binding.ts:131`) reads `NODE_ENV` first; explicit `'development'` ensures the orphan-assertion path is exercised. Production-mode tests opt in via `vi.stubEnv('NODE_ENV', 'production')` per-test (e.g., `source-binding.test.ts:88`).

---

### Pattern S7: Stable selectors in DOM tests (never `container.innerHTML`)

**Source:** `PressureOverlay.test.tsx` lines 49–58 + `cc-reload.test.tsx` lines 127–141.

```tsx
function snapshotShape(container: HTMLElement): unknown {
  return Array.from(container.querySelectorAll('a')).map((a) => ({
    tag: a.tagName.toLowerCase(),
    href: a.getAttribute('href'),
    singleField: a.getAttribute('data-source-field'),
    multiFields: a.getAttribute('data-source-fields'),
    text: a.textContent,
  }));
}
```

**Apply to:** `FlowOverlay.test.tsx` Test 2 (reload stability).

**Why this is shared:** CSS-module class names get build-time hash suffixes (Pitfall 5). Raw HTML-string snapshots fail on every rebuild. Stable selectors (queries + attributes + textContent) survive rebuilds AND survive CSS refactors.

---

## No Analog Found

| File                  | Role                    | Data Flow  | Reason                                                                                                                                                                                                                                                |
| --------------------- | ----------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/FLOW-LEGEND.md` | developer-facing legend | static doc | New documentation surface — no exact analog. Composed from `pressure.ts` JSDoc/inline-comment style + `COMMAND-CENTER-CONTRACT.md` §7 framing + CONTEXT.md D-02 prose. Match quality "partial" rather than "exact"; planner combines three templates. |

All other files have exact-shape analogs in the existing codebase (Phase 1 + Phase 2 patterns).

---

## Metadata

**Analog search scope:**

- `packages/workbench-ui/src/command/` (Phase 1 + 2 source-binding + pressure modules)
- `packages/workbench-ui/src/CommandView.tsx` (mount sites)
- `docs/COMMAND-CENTER-CONTRACT.md` (Slice E binding constraint)

**Files scanned (read fully):**

- `pressure.ts` (319 lines)
- `PressureOverlay.tsx` (77 lines)
- `PressureOverlay.module.css` (87 lines)
- `pressure.test.ts` (367 lines)
- `PressureOverlay.test.tsx` (185 lines)
- `source-binding.ts` (279 lines)
- `source-binding.test.ts` (439 lines)
- `cc-reload.test.tsx` (252 lines)
- `cc-snapshot.json` (151 lines)
- `03-CONTEXT.md` + `03-RESEARCH.md` (full)

**Files scanned (targeted grep):**

- `docs/COMMAND-CENTER-CONTRACT.md` (section header survey)

**Pattern extraction date:** 2026-05-10
