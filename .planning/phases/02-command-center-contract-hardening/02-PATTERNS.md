<!--
  SPDX-License-Identifier: MIT
  Copyright (c) 2026 Chris Knuteson
-->

# Phase 2: Command Center Contract Hardening — Pattern Map

**Mapped:** 2026-05-10
**Files analyzed:** 10 files (8 CREATE, 2 MODIFY, plus CommandView.tsx panel sections)
**Analogs found:** 10 / 10 (all files have direct analogs in Phase 1 code)

---

## File Classification

| New/Modified File                                   | Status | Role        | Data Flow                                      | Closest Analog                                                                       | Match Quality |
| --------------------------------------------------- | ------ | ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ | ------------- |
| `src/command/__fixtures__/cc-snapshot.json`         | CREATE | fixture     | batch (hand-crafted or captured once)          | none in codebase — new fixture pattern                                               | no analog     |
| `src/command/pressure.ts`                           | CREATE | module      | transform (snapshot → PressureMarker[])        | `src/command/source-binding.ts` (closed-enum + classify shape)                       | role-match    |
| `src/command/pressure.test.ts`                      | CREATE | test        | unit                                           | `src/command/source-binding.test.ts`                                                 | exact         |
| `src/command/PressureOverlay.tsx`                   | CREATE | component   | request-response (snapshot → rendered markers) | `src/command/DispositionOverlay.tsx`                                                 | exact         |
| `src/command/PressureOverlay.test.tsx`              | CREATE | test        | snapshot + unit                                | `src/command/DispositionOverlay.test.tsx`                                            | exact         |
| `src/command/PressureOverlay.module.css`            | CREATE | style       | n/a                                            | `src/command/DispositionOverlay.module.css`                                          | exact         |
| `src/command/cc-orphan.test.ts`                     | CREATE | test        | unit                                           | `src/command/source-binding.test.ts` (Tests 2, 3, 8, 9 — orphan-throw + prod no-op)  | exact         |
| `src/command/cc-reload.test.tsx`                    | CREATE | test        | snapshot                                       | `src/command/DispositionOverlay.test.tsx` Test 7 (mount/rerender/deep-equal pattern) | exact         |
| `src/command/source-binding.ts`                     | MODIFY | module      | transform                                      | itself (extend existing `DispositionFieldName` shape)                                | exact         |
| `src/command/source-binding.test.ts`                | MODIFY | test        | unit                                           | itself (extend existing Tests 1–10 shape)                                            | exact         |
| `src/CommandView.tsx` — AgentPanel (~1898)          | MODIFY | component   | CRUD                                           | existing `AgentPanel` function body + `DispositionOverlay.tsx` KV-row pattern        | exact         |
| `src/CommandView.tsx` — TaskPanel (~2000)           | MODIFY | component   | CRUD                                           | existing `TaskPanel` function body + `DispositionOverlay.tsx` KV-row pattern         | exact         |
| `src/CommandView.tsx` — GatewayPanel (~1697)        | MODIFY | component   | CRUD                                           | existing gateway branch (lines 1697–1724) + `DispositionOverlay.tsx` pattern         | exact         |
| `src/CommandView.tsx` — `agentNodes useMemo` (~175) | MODIFY | guard       | event-driven                                   | `source-binding.ts` `isDevBuild()` + `assertSourceField` pattern                     | role-match    |
| `src/CommandView.tsx` — overlay mount site (~1382)  | MODIFY | mount point | request-response                               | existing `<DispositionOverlay />` JSX at line 1382                                   | exact         |

---

## Pattern Assignments

### `src/command/source-binding.ts` (MODIFY — extend with 4 new enum types)

**Analog:** itself — extend, do not replace.

**Existing `DispositionFieldName` shape to mirror** (lines 44–56 — verbatim, this is the exact pattern to copy for each new enum):

```typescript
type DispositionFieldName =
  | 'agentRef'
  | 'namespace'
  | 'agentName'
  | 'configMapName'
  | 'idleBehavior'
  | 'spentTokensToday'
  | 'postsToday'
  | 'proposalsToday'
  | 'overBudget'
  | 'overBudgetReason'
  | 'overBudgetEventCountToday'
  | 'dailyBoundaryUtc';
```

**Phase 2 additions — new closed-enum exports to add after the existing `DispositionFieldName`:**

```typescript
export type AgentSummaryFieldName =
  | 'name'
  | 'namespace'
  | 'model'
  | 'modelClass'
  | 'tools'
  | 'capabilities';

export type TaskSummaryFieldName =
  | 'name'
  | 'namespace'
  | 'uid'
  | 'phase'
  | 'targetAgent'
  | 'targetCapability'
  | 'model'
  | 'createdAt'
  | 'startedAt'
  | 'completedAt'
  | 'podName'
  | 'error'
  | 'suspicious'
  | 'artifactCount'
  | 'childCount'
  | 'aggregatePhase';

export type GatewayCapacityFieldName =
  | 'model'
  | 'endpoint'
  | 'backendKind'
  | 'inFlight'
  | 'currentCap'
  | 'seed'
  | 'max'
  | 'minSafe'
  | 'recentP50Ms'
  | 'crName'
  | 'crNamespace';

// PressureFieldName is re-exported from pressure.ts (keeps single source of truth).
// In source-binding.ts, add: export type { PressureFieldName } from './pressure.js';
```

**Generics migration for existing helpers** — two viable paths (planner chooses):

Option A — widen to generics (simpler; closed-enum still enforced at call site):

```typescript
export function assertSourceField<T extends object, K extends keyof T & string>(
  row: T,
  field: K,
): void {
  if (!isDevBuild()) return;
  if (!(field in row)) {
    throw new Error(
      `source-binding violation: rendered field '${String(field)}' has no backing ` +
      `source. See COMMAND-CENTER-CONTRACT.md §2 Prime Directive.`
    );
  }
}
export function useSourceField<K extends string>(field: K): K { return field; }
export function assertSourceFields<T extends object, K extends keyof T & string>(
  row: T, fields: readonly K[]
): void { ... }
export function useSourceFields<K extends string>(fields: readonly K[]): string {
  return fields.join(',');
}
```

Option B — per-DTO overloads (safer enum narrowing per call site; more verbose). Either works; planner picks based on how many call sites already exist.

**Data flow:** `source-binding.ts` imports from `@kagent/dto/disposition` (existing); Phase 2 adds NO new imports since the new enum types are pure TypeScript type definitions. `pressure.ts` will import from `source-binding.ts` (via `./source-binding.js`) and export `PressureFieldName` back.

**Import convention** (lines 36–42 — verbatim):

```typescript
import type { DispositionOverlayRow } from '@kagent/dto/disposition';
// (Phase 2 does NOT need new runtime imports for new enum types — they are
// pure type aliases, not values. No new import lines needed for the 3 new
// field-name types.)
```

---

### `src/command/pressure.ts` (CREATE — new module)

**Analog:** `src/command/source-binding.ts` (closed-enum type pattern) + conceptual shape from CONTEXT.md / RESEARCH.md.

**MIT header required** (copy from source-binding.ts lines 1–4):

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */
```

**Imports pattern** — mirrors source-binding.ts's import style (ESM `.js` extension on local imports, `type` keyword for type-only imports):

```typescript
import type { CommandSnapshot } from './state.js';
```

**Core pattern — interface + PRESSURE_TYPES array:**

```typescript
export interface PressureMarker {
  readonly kind: PressureType['kind'];
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly affectedKey?: string; // ns/name of agent or task
  readonly detailLink: string;
  readonly label: string;
}

export interface PressureType {
  readonly kind:
    | 'context'
    | 'gateway'
    | 'policy'
    | 'verifier'
    | 'artifact'
    | 'trace'
    | 'pod'
    | 'quota'
    | 'telemetry';
  readonly sourceField?: string;
  readonly sourceFields?: readonly string[];
  readonly classify: (snapshot: CommandSnapshot) => PressureMarker[];
  readonly detailLink: (marker: PressureMarker) => string;
}

export const PRESSURE_TYPES: readonly PressureType[] = [
  // 9 entries — one per kind
];

// PressureFieldName derived from PRESSURE_TYPES to keep single source of truth:
export type PressureFieldName = (typeof PRESSURE_TYPES)[number]['kind'];
```

**Per-pressure-type source field bindings** (from RESEARCH.md Finding 2):

| Kind        | Source fields in TaskSummary snapshot                          | Classify condition                                                                                                                   | Detail link                       |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `gateway`   | `GatewayCapacityRow.inFlight`, `GatewayCapacityRow.currentCap` | `inFlight / currentCap >= 0.8`                                                                                                       | `#/gateway`                       |
| `artifact`  | `TaskSummary.artifactCount`, `TaskSummary.phase`               | `artifactCount === 0 && phase === 'Completed'`                                                                                       | `#/tasks/<ns>/<name>`             |
| `pod`       | `TaskSummary.phase`, `TaskSummary.podName`                     | `phase === 'Failed' && podName !== undefined`                                                                                        | `#/tasks/<ns>/<name>`             |
| `quota`     | `DispositionOverlayRow.overBudget` (snapshot.dispositions)     | `overBudget === true`                                                                                                                | `#/tasks/<ns>/<most-recent-task>` |
| `telemetry` | `CommandSnapshot.lastEventAt`                                  | `Date.now() - lastEventAt > 30_000`                                                                                                  | `#/cluster`                       |
| `context`   | `TaskSummary.childCount`, `TaskSummary.phase`                  | weak: `childCount !== undefined && childCount >= 2 && phase === 'Dispatched'`                                                        | `#/tasks/<ns>/<name>`             |
| `verifier`  | `TaskSummary.phase`, `TaskSummary.error`                       | `phase === 'Failed' && error?.includes('verifier')` (fallback; ideal is `pilotEvidence.verification.passed === false` on TaskDetail) | `#/tasks/<ns>/<name>`             |
| `trace`     | `TaskSummary.phase`                                            | terminal phase (`'Completed'` or `'Failed'`) — marker fires as "trace link unknown", resolves via TaskDetail                         | `#/tasks/<ns>/<name>`             |
| `policy`    | `TaskSummary.phase`, `TaskSummary.error`                       | `phase === 'Failed' && error?.includes('policy')` (v0.2 best-effort; document as fragile in code comment)                            | `#/tasks/<ns>/<name>`             |

**useMemo wrapping** — classify calls belong in `useMemo` inside `PressureOverlay`, NOT in the module body:

```typescript
// In PressureOverlay.tsx:
const markers = useMemo(() => PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot)), [snapshot]);
```

**Data flow:** `pressure.ts` imports `CommandSnapshot` from `./state.js`. `PressureOverlay.tsx` imports `PRESSURE_TYPES`, `PressureMarker`, `PressureType` from `./pressure.js`. `source-binding.ts` re-exports `PressureFieldName` from `./pressure.js`.

---

### `src/command/pressure.test.ts` (CREATE — new test)

**Analog:** `src/command/source-binding.test.ts` (verbatim structure: `beforeEach`/`afterEach` `vi.stubEnv`, helper factories, `describe` block, numbered `it` tests).

**Test structure pattern** (lines 1–56 of source-binding.test.ts — exact shape to mirror):

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// No @testing-library imports needed — this is pure TS, no React rendering.
import { PRESSURE_TYPES } from './pressure.js';
import type { CommandSnapshot } from './state.js';

function makeSnapshot(overrides: Partial<CommandSnapshot> = {}): CommandSnapshot { ... }

describe('pressure.ts (CC-04)', () => {
  beforeEach(() => { vi.stubEnv('NODE_ENV', 'development'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  // 9 pairs of tests (present + absent), one per pressure kind:
  it('gateway saturation — fires when inFlight/currentCap >= 0.8', () => { ... });
  it('gateway saturation — does NOT fire when inFlight/currentCap < 0.8', () => { ... });
  // ... repeat for all 9 kinds
});
```

**Data flow:** Pure TypeScript unit test. No React, no DOM, no testing-library. Input: synthesized `CommandSnapshot` objects matching each pressure type's trigger condition. Output: `PressureMarker[]` from `PRESSURE_TYPES[i].classify(snapshot)`.

---

### `src/command/PressureOverlay.tsx` (CREATE — new component)

**Analog:** `src/command/DispositionOverlay.tsx` — verbatim template. Mirror every structural choice.

**Imports pattern** (lines 34–43 of DispositionOverlay.tsx — verbatim shape):

```typescript
import { type FC, useMemo } from 'react';
import { useSourceField, useSourceFields } from './source-binding.js';
import { PRESSURE_TYPES } from './pressure.js';
import type { PressureMarker } from './pressure.js';
import styles from './PressureOverlay.module.css';
```

**Props interface** (mirrors DispositionOverlay lines 45–58 exactly):

```typescript
export interface PressureOverlayProps {
  readonly snapshot: CommandSnapshot; // full snapshot (not just dispositions slice)
  readonly pressureDramatization?: boolean; // default true — same as DispositionOverlay
}
```

**Component structure** (mirrors DispositionOverlay lines 64–191):

```typescript
export const PressureOverlay: FC<PressureOverlayProps> = ({
  snapshot,
  pressureDramatization = true,
}) => {
  const markers = useMemo(
    () => PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot)),
    [snapshot],
  );
  if (markers.length === 0) return null;

  return (
    <aside className={styles.card} aria-label="Pressure markers">
      <header className={styles.header}>Pressure</header>
      <ul className={styles.list}>
        {markers.map((marker, i) => (
          <li key={`${marker.kind}-${marker.affectedKey ?? i}`} className={styles.row}>
            <a
              className={
                pressureDramatization
                  ? styles.pressureMarker
                  : styles.pressureMarkerSubdued
              }
              data-source-field={
                marker.sourceField !== undefined
                  ? useSourceField(marker.sourceField as PressureFieldName)
                  : undefined
              }
              data-source-fields={
                marker.sourceFields !== undefined
                  ? useSourceFields([...marker.sourceFields])
                  : undefined
              }
              href={marker.detailLink}
            >
              {marker.label} →
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
};
```

**Key render conventions from DispositionOverlay:**

- Top-level is `<aside>` with CSS module class, `aria-label`
- Each marker is a `<li>` with `data-source-field` OR `data-source-fields` attribute
- Pressure anchor uses `styles.pressureMarker` (dramatic) vs `styles.pressureMarkerSubdued` (base-building-only) — same CSS token names as DispositionOverlay
- Empty state returns `null` (line 69 of DispositionOverlay)

**Data flow:** Imports `PRESSURE_TYPES` from `./pressure.js`. Receives `snapshot` prop (full `CommandSnapshot`). Classifies via `useMemo`. Renders `PressureMarker[]` as HTML anchors with `data-source-field(s)` attributes.

---

### `src/command/PressureOverlay.test.tsx` (CREATE — new test)

**Analog:** `src/command/DispositionOverlay.test.tsx` — exact 1:1 mirror.

**Header pattern** (lines 1–27 of DispositionOverlay.test.tsx — verbatim license + jsdoc block):

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */
// ... jsdoc listing all tests
```

**Test file imports** (lines 29–33 of DispositionOverlay.test.tsx):

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CommandSnapshot } from './state.js';
import { PressureOverlay } from './PressureOverlay.js';
```

**Helper factory pattern** (lines 35–63 of DispositionOverlay.test.tsx — mirror this shape):

```typescript
function makeSnapshot(overrides?: Partial<CommandSnapshot>): CommandSnapshot {
  return {
    agents: new Map(),
    tasks: new Map(),
    gatewayCapacity: [],
    gatewayUsage: [],
    dispositions: new Map(),
    events: [],
    lastEventAt: Date.now(),
    error: null,
    ...overrides,
  };
}
```

**Test 7 reload-stability pattern** (DispositionOverlay.test.tsx lines 193–228 — exact structure for cc-reload.test.tsx):

```typescript
function snapshotShape(container: HTMLElement): unknown {
  // Use data-source-field(s) selectors, NOT innerHTML (OpenCode LOW #8 —
  // CSS-module hash suffixes invalidate raw innerHTML snapshots per build).
  return Array.from(container.querySelectorAll('[data-source-field],[data-source-fields]')).map(
    (el) => ({
      tag: el.tagName.toLowerCase(),
      singleField: el.getAttribute('data-source-field'),
      multiFields: el.getAttribute('data-source-fields'),
      text: el.textContent,
      href: el.getAttribute('href'),
    }),
  );
}

const { container, rerender } = render(<PressureOverlay snapshot={snapshot} />);
const first = snapshotShape(container);
rerender(<PressureOverlay snapshot={snapshot} />);
const second = snapshotShape(container);
expect(second).toEqual(first);
expect(second).toMatchSnapshot();
```

**pressureDramatization prop testing** (DispositionOverlay.test.tsx Test 5 pattern — lines 151–185):

```typescript
// Pass prop explicitly rather than mocking VITE_PRESSURE_DRAMATIZATION.
// Module-scope const is evaluated once at load; vi.stubEnv won't affect it.
render(<PressureOverlay snapshot={snapshot} pressureDramatization={false} />);
// Assert dramatic class NOT present (class substring check — avoids CSS hash):
let dramaticPresent = false;
container.querySelectorAll('*').forEach((el) => {
  if ((el.getAttribute('class') ?? '').includes('pressureDramatic')) dramaticPresent = true;
});
expect(dramaticPresent).toBe(false);
```

**Data flow:** Imports `PressureOverlay` from `./PressureOverlay.js`. Uses `render`, `screen` from `@testing-library/react`. Uses `vi.stubEnv('NODE_ENV', 'development')` in `beforeEach` (same as all other test files in this directory).

---

### `src/command/PressureOverlay.module.css` (CREATE — new style)

**Analog:** `src/command/DispositionOverlay.module.css` — exact class-name set to mirror.

**Required CSS classes** (copy the DispositionOverlay class names verbatim; the overlay mounting and `pressureDramatization` logic in `CommandView.tsx` and `PressureOverlay.tsx` reference these exact token names):

```css
/* SPDX-License-Identifier: MIT — CSS does not require the license header per CLAUDE.md,
   but the comment is harmless and consistent */

.card {
  /* position: absolute; positioned as sibling of DispositionOverlay */
}
.header {
  /* section label — amber, monospace, uppercase */
}
.list {
  /* ul reset */
}
.row {
  /* li row — column flex */
}
.pressureMarker {
  /* anchor — amber border, dramatic */
}
.pressureMarkerSubdued {
  /* anchor — muted, base-building-only mode */
}
```

Exact values from DispositionOverlay.module.css (lines 15–144):

- `.card`: `position: absolute`, adjust `top`/`left` positioning to not overlap DispositionOverlay (e.g., `top: 56px; left: 16px` instead of `right: 16px`)
- `.pressureMarker` and `.pressureMarkerSubdued`: copy verbatim from DispositionOverlay.module.css lines 106–143

**Note:** The `pressureDramatic` class is NOT needed in PressureOverlay.module.css. PressureOverlay uses the `pressureMarker` vs `pressureMarkerSubdued` toggle (the anchor link itself is the marker — no separate value span that changes color). If a per-marker numeric display is added (like DispositionOverlay's token delta), add `.pressureDramatic` then.

---

### `src/command/cc-orphan.test.ts` (CREATE — canvas-side orphan assertion test)

**Analog:** `src/command/source-binding.test.ts` Tests 2 and 3 (orphan-throw + prod no-op).

**Test structure** (mirrors source-binding.test.ts exactly):

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */
// CC-01: canvas-side orphan assertion test.
// Tests that the agentNodes useMemo in CommandView throws in dev
// when a task's targetAgent is not in snapshot.agents,
// and is a no-op in production.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Import the isDevBuild-equivalent logic OR the orphan-assertion helper
// that will be extracted from CommandView's agentNodes useMemo.
```

**Test scenarios** (from CONTEXT.md D-CC-01-A):

1. Builds a snapshot with one orphan agent key (task references agent key not in `snapshot.agents`) — asserts layout-mapper assertion throws with message referencing `COMMAND-CENTER-CONTRACT.md §2`.
2. Builds a synthesized `AgentSummaryRow` missing the `tools` field — asserts `assertSourceField(row, 'tools')` throws when called in dev.
3. Sets `NODE_ENV=production` via `vi.stubEnv` — asserts both assertions are no-ops.

**Key pattern** — `vi.stubEnv` in `beforeEach`/`afterEach` (lines 65–71 of source-binding.test.ts):

```typescript
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
});
afterEach(() => {
  vi.unstubAllEnvs();
});
```

**Data flow:** Imports `assertSourceField`, `assertSourceFields` from `./source-binding.js`. May also import a to-be-extracted `assertCanvasOrphan` helper from wherever the CC-01 canvas assertion is placed (either `layout.ts` or extracted into `source-binding.ts` as a new export). Pure TypeScript unit test — no React, no DOM.

---

### `src/command/cc-reload.test.tsx` (CREATE — reload-stability test)

**Analog:** `src/command/DispositionOverlay.test.tsx` Test 7 (lines 193–228 — mount/rerender/deep-equal pattern), extended with:

- Full `CommandView` (or at minimum the panel + overlay slice) mount, not just `DispositionOverlay`
- `computeLayout` call for scene-graph snapshot (called directly with `agentNodes` from fixture)
- Unmount + fresh remount (not just `rerender`)

**Mount/unmount/remount pattern** (Test 7 of DispositionOverlay.test.tsx uses `rerender` — CC-02 requires full unmount/remount per CONTEXT.md):

```typescript
// First mount
const { container: c1, unmount } = render(<CommandView onBack={() => {}} />);
const domSnap1 = snapshotShape(c1);
const layoutSnap1 = Object.fromEntries(
  computeLayout(agentNodesFromFixture, { width: 1280, height: 800 }).agents
);
unmount();

// Fresh remount — same fixture, fresh React root
const { container: c2 } = render(<CommandView onBack={() => {}} />);
const domSnap2 = snapshotShape(c2);
const layoutSnap2 = Object.fromEntries(
  computeLayout(agentNodesFromFixture, { width: 1280, height: 800 }).agents
);

expect(domSnap2).toEqual(domSnap1);
expect(layoutSnap2).toEqual(layoutSnap1);
expect(domSnap2).toMatchSnapshot();
expect(layoutSnap2).toMatchSnapshot();
```

**Critical: Map serialization** (RESEARCH.md Assumption A2 — `LayoutResult.agents` is `ReadonlyMap`, not JSON-serializable):

```typescript
// Use Object.fromEntries for stable serialization:
const layoutSnap = Object.fromEntries(layout.agents);
// NOT: JSON.stringify(layout) — Maps serialize to {} with JSON.stringify
```

**Fixture loading** — intercept `fetch` calls to serve `cc-snapshot.json`:

```typescript
import fixture from './__fixtures__/cc-snapshot.json';
// In beforeEach:
vi.spyOn(global, 'fetch').mockImplementation(async (url: string) => {
  if (url.includes('/api/agents')) return { ok: true, json: async () => fixture.agents };
  if (url.includes('/api/tasks')) return { ok: true, json: async () => fixture.tasks };
  if (url.includes('/api/gateway/capacity'))
    return { ok: true, json: async () => fixture.gatewayCapacity };
  if (url.includes('/api/dispositions'))
    return { ok: true, json: async () => fixture.dispositions };
  // SSE subscription — return a no-op cleanup
  return { ok: false, json: async () => ({}) };
});
```

**snapshotShape function** — use stable selectors only (no `innerHTML` per OpenCode LOW #8):

```typescript
function snapshotShape(container: HTMLElement): unknown {
  return {
    panels: Array.from(container.querySelectorAll('[data-source-field],[data-source-fields]')).map(
      (el) => ({
        tag: el.tagName.toLowerCase(),
        singleField: el.getAttribute('data-source-field'),
        multiFields: el.getAttribute('data-source-fields'),
        text: el.textContent,
      }),
    ),
  };
}
```

**Data flow:** Imports `CommandView` from `../../CommandView.js`, `computeLayout` from `./layout.js`, fixture JSON from `./__fixtures__/cc-snapshot.json`. Uses `render`, `unmount` from `@testing-library/react`.

---

### `src/command/__fixtures__/cc-snapshot.json` (CREATE — fixture)

**Analog:** None in codebase. This is the first fixture file in `packages/workbench-ui/src/command/`.

**Structure** (derived from `CommandSnapshot` + API shapes in `src/types.ts`):

```json
{
  "agents": [
    /* AgentSummaryRow[] — at least 3 agents */
  ],
  "tasks": [
    /* TaskSummary[] — at least 6 tasks, mix of phases */
  ],
  "gatewayCapacity": [
    /* GatewayCapacityRow[] — at least 2 rows */
  ],
  "dispositions": [
    /* DispositionOverlayRow[] — at least 1 row with overBudget:true */
  ]
}
```

**Pressure-type coverage requirements** (one triggering scenario per type, per CC-04 test requirements):

- gateway: one `GatewayCapacityRow` with `inFlight / currentCap >= 0.8`
- artifact: one `TaskSummary` with `phase: 'Completed'` and `artifactCount: 0`
- pod: one `TaskSummary` with `phase: 'Failed'` and `podName` defined
- quota: one `DispositionOverlayRow` with `overBudget: true`
- context: one `TaskSummary` with `phase: 'Dispatched'` and `childCount >= 2`
- verifier: one `TaskSummary` with `phase: 'Failed'` and `error` containing `'verifier'`
- trace: one terminal `TaskSummary` (phase `'Completed'`)
- policy: one `TaskSummary` with `phase: 'Failed'` and `error` containing `'policy'`
- telemetry: simulated by fixture not having a `lastEventAt` override (test sets it stale)

**DTO field reference** (from `src/types.ts`):

- `AgentSummaryRow` (lines 191–204): `name`, `namespace`, `model?`, `modelClass?`, `tools?`, `capabilities?`
- `TaskSummary` (lines 48–68): `name`, `namespace`, `uid`, `phase?`, `targetAgent?`, `targetCapability?`, `model?`, `createdAt?`, `startedAt?`, `completedAt?`, `podName?`, `error?`, `suspicious?`, `artifactCount?`, `childCount?`, `aggregatePhase?`
- `GatewayCapacityRow` (lines 248–265): `model`, `endpoint`, `backendKind`, `inFlight`, `currentCap`, `seed`, `max`, `minSafe`, `recentP50Ms: number | null`, `crName?`, `crNamespace?`
- `DispositionOverlayRow`: `agentRef`, `namespace`, `agentName`, `configMapName`, `idleBehavior`, `spentTokensToday`, `postsToday`, `proposalsToday`, `overBudget`, `overBudgetReason?`, `overBudgetEventCountToday`, `dailyBoundaryUtc`

**Capture command** (for future live capture; if no live workbench-api, hand-craft):

```bash
WORKBENCH_API=http://localhost:3001
jq -n \
  --argjson agents    "$(curl -s $WORKBENCH_API/api/agents)" \
  --argjson tasks     "$(curl -s $WORKBENCH_API/api/tasks)" \
  --argjson gateway   "$(curl -s $WORKBENCH_API/api/gateway/capacity)" \
  --argjson dispositions "$(curl -s $WORKBENCH_API/api/dispositions)" \
  '{agents: $agents, tasks: $tasks, gatewayCapacity: $gateway, dispositions: $dispositions}' \
  > packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json
```

---

### `src/CommandView.tsx` — `agentNodes useMemo` extension (CC-01)

**Analog:** `src/command/source-binding.ts` `isDevBuild()` pattern + existing `agentNodes useMemo` at lines 175–201.

**Current code (lines 175–201 — verbatim, this is the exact block to extend):**

```typescript
const agentNodes = useMemo<readonly AgentNode[]>(() => {
  const map = new Map<string, AgentNode>();
  for (const a of snapshot.agents.values()) {
    const key = `${a.namespace}/${a.name}`;
    map.set(key, {
      key,
      namespace: a.namespace,
      name: a.name,
      ...(a.model !== undefined && { model: a.model }),
      ...(a.modelClass !== undefined && { modelClass: a.modelClass }),
      ...(a.tools !== undefined && { tools: a.tools }),
    });
  }
  for (const t of snapshot.tasks.values()) {
    if (t.targetAgent === undefined) continue;
    const key = `${t.namespace}/${t.targetAgent}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        namespace: t.namespace,
        name: t.targetAgent,
        ...(t.model !== undefined && { model: t.model }),
      });
    }
  }
  return Array.from(map.values());
}, [snapshot.agents, snapshot.tasks]);
```

**CC-01 insertion** — add the orphan assertion INSIDE the task loop, BEFORE `map.set`:

```typescript
// CC-01: canvas-side orphan assertion (Phase 2 / CC-01).
// Fires in dev when a task references an agent key not in snapshot.agents.
// No-op in prod. Error directs developer to check SSE connectivity
// before assuming a contract violation (brief reconnect windows may cause
// transient gaps — the assertion is still correct to throw; the message
// is informative).
if (isDevBuild() && !snapshot.agents.has(key)) {
  throw new Error(
    `CC-01 source-binding violation: task '${t.namespace}/${t.name}' references ` +
      `agent key '${key}' not in snapshot.agents. ` +
      `See COMMAND-CENTER-CONTRACT.md §2 Prime Directive. ` +
      `(If this fires during SSE reconnect, check stream connectivity.)`,
  );
}
```

**Import addition** for `isDevBuild` — import from `source-binding.ts`. Note: `isDevBuild` is currently NOT exported (it's module-private). Phase 2 must either (a) export `isDevBuild` from `source-binding.ts` or (b) extract the orphan assertion as a new exported helper `assertCanvasOrphan` in `source-binding.ts`. Option (b) is preferred — it keeps the assertion testable and keeps `isDevBuild` private.

---

### `src/CommandView.tsx` — `AgentPanel` additions (CC-03, ~line 1898)

**Analog:** Existing `AgentPanel` body (lines 1898–1997) + `DispositionOverlay.tsx` KV-row pattern (lines 108–125).

**Current KV-row pattern** (lines 1952–1961 of CommandView.tsx — verbatim, this is the shape to mirror for new fields):

```tsx
<div className={styles.panelKv}>
  <span>Model</span>
  <span>{a?.model ?? a?.modelClass ?? '—'}</span>
</div>;
{
  a?.tools && a.tools.length > 0 ? (
    <div className={styles.panelKv}>
      <span>Tools</span>
      <span>{a.tools.join(', ')}</span>
    </div>
  ) : null;
}
```

**Phase 2 additions** — each new KV row adds `data-source-field` attribute (Phase 1's KV rows do NOT have it yet — Phase 2 adds them):

```tsx
{
  /* CC-03: capabilities row */
}
<div
  className={styles.panelKv}
  data-source-field={useSourceField('capabilities' as AgentSummaryFieldName)}
>
  <span>Capabilities</span>
  <span>{a?.capabilities?.join(', ') ?? '—'}</span>
</div>;

{
  /* CC-03: modelClass label when both model and modelClass are present */
}
{
  a?.modelClass !== undefined && a.modelClass !== a?.model ? (
    <div
      className={styles.panelKv}
      data-source-field={useSourceField('modelClass' as AgentSummaryFieldName)}
    >
      <span>Model class</span>
      <span>{a.modelClass}</span>
    </div>
  ) : null;
}

{
  /* CC-03: active-task counter (computed from snapshot.tasks) */
}
<div
  className={styles.panelKv}
  data-source-fields={useSourceFields(['phase', 'targetAgent'] as TaskSummaryFieldName[])}
>
  <span>In flight</span>
  <span>{inFlight.length}</span>
</div>;
```

**Link pattern** (lines 1970–1975 of CommandView.tsx — verbatim hash-route pattern):

```tsx
href={`#/tasks/${encodeURIComponent(t.namespace)}/${encodeURIComponent(t.name)}`}
```

---

### `src/CommandView.tsx` — `TaskPanel` additions (CC-03, ~line 2000)

**Analog:** Existing `TaskPanel` body (lines 2000–2041) + same KV-row pattern as AgentPanel.

**Current KV-row pattern** (lines 2019–2031 of CommandView.tsx — verbatim):

```tsx
<div className={styles.panelKv}>
  <span>Phase</span>
  <span className={phaseClass(t.phase)}>{t.phase ?? '?'}</span>
</div>
<div className={styles.panelKv}>
  <span>Agent</span>
  <span>{t.targetAgent ?? '—'}</span>
</div>
```

**Phase 2 additions pattern** (mirror existing shape, add `data-source-field`):

```tsx
{
  /* CC-03: timestamps — only render defined fields */
}
{
  t.createdAt !== undefined ? (
    <div
      className={styles.panelKv}
      data-source-field={useSourceField('createdAt' as TaskSummaryFieldName)}
    >
      <span>Created</span>
      <span>{new Date(t.createdAt).toLocaleString()}</span>
    </div>
  ) : null;
}

{
  /* CC-03: suspicious-tags chips */
}
{
  t.suspicious !== undefined && t.suspicious.length > 0 ? (
    <div
      className={styles.panelKv}
      data-source-field={useSourceField('suspicious' as TaskSummaryFieldName)}
    >
      <span>Suspicious</span>
      <span>{t.suspicious.join(', ')}</span>
    </div>
  ) : null;
}

{
  /* CC-03: artifactCount */
}
<div
  className={styles.panelKv}
  data-source-field={useSourceField('artifactCount' as TaskSummaryFieldName)}
>
  <span>Artifacts</span>
  <span>{t.artifactCount ?? 0}</span>
</div>;
```

---

### `src/CommandView.tsx` — `GatewayPanel` additions (CC-03, ~line 1697)

**Analog:** Existing gateway branch (lines 1697–1724 of CommandView.tsx — verbatim).

**Current render** (lines 1703–1721 — verbatim):

```tsx
{snapshot.gatewayCapacity.map((row) => {
  const pct = row.currentCap > 0 ? row.inFlight / row.currentCap : 0;
  return (
    <li key={row.endpoint} className={styles.panelRow}>
      <div className={styles.panelRowLabel}>{row.model}</div>
      <div className={styles.panelRowMeta}>
        {row.inFlight} / {row.currentCap} in flight
      </div>
      <div className={styles.gauge}>
        <div className={styles.gaugeFill} style={{ width: `${...}%` }} />
      </div>
    </li>
  );
})}
```

**Phase 2 additions** — add `data-source-fields` to the inFlight/currentCap row, add "Open in GatewayPage" link:

```tsx
<div
  className={styles.panelRowMeta}
  data-source-fields={useSourceFields(['inFlight', 'currentCap'] as GatewayCapacityFieldName[])}
>
  {row.inFlight} / {row.currentCap} in flight
</div>
```

```tsx
{
  /* CC-03: bottom link — existing #/gateway route */
}
<a className={styles.taskLinkBtn} href="#/gateway">
  Open in GatewayPage →
</a>;
```

**recentP50Ms null handling** (RESEARCH.md Pitfall 3):

```tsx
{
  /* recentP50Ms is number|null (not undefined) — guard with != null */
}
{
  row.recentP50Ms != null ? (
    <div
      className={styles.panelKv}
      data-source-field={useSourceField('recentP50Ms' as GatewayCapacityFieldName)}
    >
      <span>P50</span>
      <span>{row.recentP50Ms}ms</span>
    </div>
  ) : null;
}
```

---

### `src/CommandView.tsx` — PressureOverlay mount site (~line 1382)

**Analog:** Existing `<DispositionOverlay />` mount (lines 1382–1385 of CommandView.tsx — verbatim):

```tsx
<DispositionOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />
```

**Phase 2 addition** — mount `<PressureOverlay />` immediately after:

```tsx
{
  /* Phase 2 / CC-04 — nine-type pressure overlay. Derives all markers
    from existing CommandSnapshot fields; no new endpoint. Same
    pressureDramatization flag as DispositionOverlay. */
}
<PressureOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />;
```

**Import addition** (mirrors line 52 of CommandView.tsx):

```typescript
import { PressureOverlay } from './command/PressureOverlay.js';
```

---

## Shared Patterns

### MIT License Header

**Source:** Every `.ts`/`.tsx` file in `packages/workbench-ui/src/command/`
**Apply to:** All 8 CREATE files (`pressure.ts`, `PressureOverlay.tsx`, `PressureOverlay.test.tsx`, `cc-orphan.test.ts`, `cc-reload.test.tsx`) plus CSS files if desired

```typescript
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */
```

### isDevBuild() Pattern

**Source:** `src/command/source-binding.ts` lines 75–99
**Apply to:** Any new dev-only guard (`assertCanvasOrphan`, any new assertion helper)
**Key:** `vi.stubEnv('NODE_ENV', 'production')` in tests disables it (step 1 of priority check fires first)

### data-source-field / data-source-fields DOM Attributes

**Source:** `src/command/DispositionOverlay.tsx` lines 110–125, 159–172
**Apply to:** Every rendered KV row in AgentPanel, TaskPanel, GatewayPanel additions; every `<li>` in PressureOverlay
**Convention:** Single field → `data-source-field={useSourceField('fieldName')}`. Computed from multiple → `data-source-fields={useSourceFields(['field1', 'field2'])}`. Comma-joined, no spaces.

### pressureDramatization Prop

**Source:** `src/CommandView.tsx` lines 83–85 (module-scope const) + `DispositionOverlay.tsx` lines 57, 66, 114–117
**Apply to:** `PressureOverlay` props interface + all conditional class applications inside it
**Testing:** Never mock via `vi.stubEnv` — pass `pressureDramatization={false}` as explicit prop to component (per DispositionOverlay.test.tsx Test 5 pattern)

### vi.stubEnv beforeEach/afterEach Pattern

**Source:** `src/command/source-binding.test.ts` lines 50–56, `src/command/DispositionOverlay.test.tsx` lines 65–71
**Apply to:** `pressure.test.ts`, `cc-orphan.test.ts`, `cc-reload.test.tsx`, `PressureOverlay.test.tsx`

```typescript
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
});
afterEach(() => {
  vi.unstubAllEnvs();
});
```

### CSS-Hash-Safe Snapshot Pattern

**Source:** `src/command/DispositionOverlay.test.tsx` lines 203–219 (`snapshotShape` function)
**Apply to:** `cc-reload.test.tsx`, `PressureOverlay.test.tsx`
**Anti-pattern:** Raw `innerHTML` — DO NOT use. CSS-module class names contain build-time hash suffixes that change per build.
**Correct:** Select by `data-source-field(s)` attributes + `textContent` only.

### ESM Import Extensions

**Source:** All imports in `src/command/` directory (e.g., `'./source-binding.js'`, `'./DispositionOverlay.js'`, `'./state.js'`)
**Apply to:** All new file imports. Use `.js` extension on local imports (ESM convention, even for `.ts` source files — TypeScript resolves them). Use bare specifiers for npm packages (`'react'`, `'vitest'`).

### Conventional Commits Scope

**Source:** `CLAUDE.md` — `feat(phase-02-...)` / `fix(phase-02-...)` per task
**Apply to:** All Phase 2 commits. Example scopes: `feat(phase-02-source-binding)`, `feat(phase-02-pressure)`, `feat(phase-02-panels)`, `feat(phase-02-overlay)`.

---

## No Analog Found

| File                            | Role    | Data Flow | Reason                                                                                                                                                                                                                                                               |
| ------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__fixtures__/cc-snapshot.json` | fixture | batch     | No JSON fixtures exist in `packages/workbench-ui/src/` — this is the first. The `__snapshots__/` directory contains vitest-generated `.snap` files (not hand-crafted). The DTO shapes in `src/types.ts` serve as the structural reference instead of an analog file. |

---

## Anti-Patterns to Avoid

| Anti-Pattern                                                                    | Why                                                                                                 | What to Use Instead                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Mutating `computeLayout` with assertions                                        | `layout.ts` is a pure spatial function — keep it pure                                               | CC-01 assertion belongs in `agentNodes useMemo` caller in `CommandView.tsx`                    |
| `innerHTML` in snapshot tests                                                   | CSS-module class names have build-time hash suffixes                                                | `data-source-field(s)` attribute selectors + `textContent`                                     |
| `vi.stubEnv('VITE_PRESSURE_DRAMATIZATION', 'false')`                            | Module-scope const evaluated once at load; Vite inlines `import.meta.env` at build time             | Pass `pressureDramatization={false}` as explicit prop to component                             |
| `JSON.stringify(layoutResult)` directly                                         | `LayoutResult.agents` is a `ReadonlyMap` — serializes to `{}`                                       | `Object.fromEntries(layout.agents)` for snapshot stability                                     |
| `row.recentP50Ms !== undefined` guard for GatewayCapacityRow                    | `recentP50Ms` is `number \| null` (not optional) — workbench-api maps SQL NULL as JSON `null`       | Use `row.recentP50Ms != null` (double-equals)                                                  |
| `data-source-field="inFlightCount"` on AgentPanel counter                       | `inFlightCount` is not on `AgentSummaryRow`; it's on `TaskDetail`                                   | `data-source-fields="phase,targetAgent"` (the two TaskSummary fields the counter derives from) |
| New per-pressure-type `VITE_PRESSURE_*` env vars                                | Single global flag is the locked decision                                                           | `VITE_PRESSURE_DRAMATIZATION` covers all 9 types                                               |
| New `/api/pressure` endpoint                                                    | Explicitly out of scope — locked exclusion                                                          | UI-side classification in `pressure.ts`                                                        |
| Fetching `TaskDetail` inside `pressure.ts` classify functions                   | `CommandSnapshot` is the only data available at classification time                                 | Use `TaskSummary` fields + `snapshot.lastEventAt`; document fallbacks in code comments         |
| `agentRef`-keyed loop addition to `agentNodes useMemo` without careful handling | Current code handles task-references-absent-agent gracefully in prod; assertion must not break this | In prod (`!isDevBuild()`), the fallback synthetic node creation continues as-is                |

---

## Metadata

**Analog search scope:** `packages/workbench-ui/src/command/`, `packages/workbench-ui/src/CommandView.tsx`, `packages/workbench-ui/src/types.ts`, `packages/workbench-ui/src/command/state.ts`, `packages/workbench-ui/src/command/layout.ts`
**Files scanned:** 12 (source-binding.ts, DispositionOverlay.tsx, DispositionOverlay.test.tsx, DispositionOverlay.module.css, source-binding.test.ts, CommandView.tsx, state.ts, layout.ts, types.ts, App.tsx, **snapshots**/DispositionOverlay.test.tsx.snap, vitest.config.ts)
**Pattern extraction date:** 2026-05-10
**Confidence:** HIGH — all analogs verified from actual source files; Phase 1 code is the exact template for Phase 2

---

## PATTERN MAPPING COMPLETE
