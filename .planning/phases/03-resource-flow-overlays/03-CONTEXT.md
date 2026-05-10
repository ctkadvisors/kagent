# Phase 3: Resource-flow overlays — Context

**Gathered:** 2026-05-10
**Status:** Ready for planning
**Mode:** discuss-phase, "all recommendations" — Claude proposed 5 gray areas (flow shape, source gaps, legend location, base-only mode, granularity); user accepted the recommended option in each. The user has authority to override any decision below before/during planning.

> **Critical framing.** Phase 3 EXTENDS the per-component source-binding pattern shipped in Phase 1 / DISP-04 and the `pressure.ts` / `PressureOverlay.tsx` module shape generalized in Phase 2 / CC-04 (`packages/workbench-ui/src/command/pressure.ts`, `PressureOverlay.tsx`) to render the eight `C-flow-economy` flows from `docs/intel/constraints.md` §C-flow-economy as **continuous gauges** (not threshold-fired markers) on Command Center. Phase 3 introduces **no new CRD, no new reconciler, no new workbench-api endpoint, and no new substrate-level persistence primitive.** Pressure markers (Phase 2) and flow gauges (Phase 3) are **siblings, not replacements**: pressure says "something tripped"; flows say "how much is flowing right now". Per the Slice E ordering in `docs/COMMAND-CENTER-CONTRACT.md` §7, this phase continues read-side hardening — no write surface (Slice C/D remain deferred).

<domain>
## Phase Boundary

**In scope (Phase 3 delivers):**

1. **FLOW-01 — Eight continuous flow gauges in Command Center, each source-bound.** Add a new `packages/workbench-ui/src/command/flows.ts` module exporting `FLOW_TYPES: readonly FlowType[]` with one entry per `C-flow-economy` flow:
   - **model power** (per gateway endpoint — natural granularity from `GatewayCapacityRow`)
   - **token flow** (per model class — substrate-wide rate, v0.2 fallback proxy)
   - **build power** (per agent — aggregated from `snapshot.tasks` × `targetAgent`)
   - **pod capacity** (per node — from `ClusterNodeRow.managedPodCount` if reachable on snapshot, else substrate-wide fallback)
   - **artifact bandwidth** (substrate-wide — derived from `TaskSummary.artifactCount` deltas / completion rate)
   - **authority** (substrate-wide — denial counts from existing audit-event/error-string fallback)
   - **trust** (substrate-wide — `TaskSummary.suspicious` length + `phase=Failed` + verifier-error string)
   - **attention** (substrate-wide — defers to Phase 4's review queue projection; Phase 3 renders a placeholder gauge labeled "awaiting review queue projection — Phase 4" with `data-source-field` pointing at `phase` + `suspicious` for the v0.2 stub)

   Each `FlowType` declares: `kind`, `granularity`, `sourceField`/`sourceFields` (string union derived from snapshot DTO field names), `compute(snapshot): readonly FlowGauge[]`, and `detailLink(gauge): string`. A new `FlowOverlay.tsx` sibling component to `PressureOverlay.tsx` renders the gauges as continuous bars / readouts, each carrying `data-source-field` (or `data-source-fields`) per the Prime Directive. A test fixture asserts EVERY flow has a non-null source-field reference; a missing source field FAILS the test.

2. **FLOW-02 — Flow legend in developer docs (NOT in main UI chrome).** New `docs/FLOW-LEGEND.md` mapping each of the 8 flows to: substrate source field(s), pressure trigger, operator action, v0.2 fallback (where applicable), and promotion path (where the source is incomplete). Inline module-level comments per `FLOW_TYPES` entry in `flows.ts` mirror Phase 2's `pressure.ts` self-documentation pattern. Living doc — updated as flows evolve. Slice E's "legend in developer docs, not in main UI chrome" constraint from `COMMAND-CENTER-CONTRACT.md` §7 is honored (no on-canvas legend tooltip; no big "?" button on the overlay).

**Out of scope for Phase 3 (locked exclusions):**

- Any new CRD (per D2; Phase 3 is read-side derivation only).
- Any new workbench-api endpoint, including `/api/flows` — flow computation is a UI-side derivation from existing DTO fields, mirroring Phase 2's `/api/pressure`-not-shipped decision. (If the planner finds a flow whose source field is genuinely unreachable in the current snapshot — e.g., per-class token rate that never made it onto `useCommandSnapshot()` — the planner BLOCKS on that flow with options: pick a less-ideal proxy from existing fields, OR document the fallback and ship the gauge in stub form. Default posture: all 8 derived from existing snapshot fields, with v0.2 fallbacks where ideal sources live on TaskDetail or aren't yet aggregated.)
- Any new write action on Command Center (Slice C/D — construction mode and Tool Foundry — remain deferred per `COMMAND-CENTER-CONTRACT.md` §7 ordering).
- Any new substrate-level flow signal (e.g., a CRD `FlowRecord`, a controller that emits flow DTOs, a `FlowTotals` projection on workbench-api). Flows are presentation-layer derivation in v0.2.
- Replacing `PressureOverlay`. Pressure markers (Phase 2's 9 types) and flow gauges (Phase 3's 8 types) are siblings — both mount in CommandView, both honor the same `pressureDramatization` env flag (extended to cover flow gauges per D-03 below), both follow the same source-binding contract.
- Adding `/api/gateway/usage` row data to `useCommandSnapshot()` to fuel the token-flow gauge with real per-request token counts. The token-flow gauge uses a v0.2 task-count × model proxy with a documented promotion path (see D-02-token below). Adding usage rows to the snapshot would expand the snapshot's fetch surface; defer until the proxy is repeatedly insufficient.
- A `ReviewQueueRow` DTO for the attention flow. Phase 4 owns the review queue projection. Phase 3's attention gauge is a stub (`label="awaiting review queue projection — Phase 4"`, `data-source-field="phase,suspicious"`) that flips to the real projection in Phase 4 with no shape change to `flows.ts`.
- Verifier-evidence-on-TaskSummary for the trust flow. The verifier-fail count uses the same TaskSummary-error-string fallback as Phase 2's `verifier` pressure marker (per `pressure.ts` lines 226-254). Promotion to `pilotEvidence.verification.passed` is deferred to a future Workbench-hardening phase that adds pilotEvidence to TaskSummary.
- Per-flow-type dramatization toggles. Single global `pressureDramatization` flag covers BOTH pressure markers AND flow gauges (D-04). Renamed-flag proposal (`VITE_FLOW_DRAMATIZATION` separate from `VITE_PRESSURE_DRAMATIZATION`) is rejected.
- Per-faction aggregation. Granularity is per-flow-natural (per-endpoint / per-agent / per-node / substrate-wide as appropriate per D-05). Per-faction (`kagent-system`) aggregation is deferred to a multi-tenant-experiments phase if/when the substrate gains second-faction workloads.
- Generalizing source-binding to OTHER Workbench surfaces (TaskList, TaskDetail, GatewayPage, ClusterPage). Phase 3 scopes to Command Center specifically, same as Phase 2.
- On-canvas flow legend tooltips. The legend is `docs/FLOW-LEGEND.md` only, per Slice E acceptance criterion in `COMMAND-CENTER-CONTRACT.md` §7. Operators read code + docs; the UI carries the gauges, not their definitions.

</domain>

<decisions>
## Implementation Decisions (locked for this phase, all recommended options selected — user has authority to override)

### D-01: Flow shape — new `FlowOverlay` with continuous gauges (sibling to `PressureOverlay`)

**Decision (D-01-A): Ship a new `packages/workbench-ui/src/command/flows.ts` module + `FlowOverlay.tsx` sibling component to `PressureOverlay.tsx`. Pressure markers and flow gauges are siblings, not replacements.**

- **Module shape (mirrors `pressure.ts` exactly):**

  ```ts
  export interface FlowGauge {
    readonly kind: FlowType['kind'];
    readonly sourceField?: string; // single source field
    readonly sourceFields?: readonly string[]; // multi-source computed
    readonly affectedKey?: string; // ns/name/endpoint for per-instance gauges
    readonly detailLink: string; // hash-route to relevant detail page
    readonly label: string; // operator-facing readout
    readonly value: number; // numerator (e.g., inFlight, completed count)
    readonly capacity?: number; // denominator (e.g., currentCap) — undefined for ratios/rates without a cap
    readonly unit?: string; // 'inFlight', 'tokens/min', 'pods', 'failures' — for axis label / readout
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
    readonly granularity:
      | 'perEndpoint'
      | 'perModelClass'
      | 'perAgent'
      | 'perNode'
      | 'substrateWide';
    readonly sourceField?: string;
    readonly sourceFields?: readonly string[];
    readonly compute: (snapshot: CommandSnapshot) => readonly FlowGauge[];
    readonly detailLink: (gauge: FlowGauge) => string;
  }

  export const FLOW_TYPES: readonly FlowType[] = [
    /* eight entries */
  ];
  export type FlowFieldName = FlowType['kind']; // closed enum derived from FLOW_TYPES['kind']
  ```

- **Render shape (mirrors `PressureOverlay.tsx`):**
  - Top-level `<aside aria-label="Resource flows">` mounted alongside `<PressureOverlay />` and `<DispositionOverlay />` in CommandView.tsx (current PressureOverlay mount site is the anchor — sibling JSX next to it).
  - Each flow renders as a row containing the label + a value-vs-capacity readout. When `capacity` is defined: render a thin horizontal bar (CSS `width: ${value/capacity * 100}%`) with the readout text overlaid. When `capacity` is undefined (rate-only flows): render the value text + unit only.
  - Each rendered gauge carries `data-source-field` (single) or `data-source-fields` (comma-joined for computed) per the Prime Directive — exactly the same DOM convention as `PressureOverlay`.
  - When `compute()` returns an empty array for a flow, render a "—" stub row (NOT null) so all 8 flows are always visible. Operators need to see "this flow exists but has no current pressure" — that's strictly different from "this flow is missing from the system".
- **Detail links** match Phase 2's hash-route convention: `#/gateway`, `#/cluster`, `#/tasks/<ns>/<name>`. No new routes introduced.
- **Source-binding integration:** `FlowFieldName` is derived from `FLOW_TYPES['kind']` (same trick as `pressure.ts` line 318-319) and exported alongside the existing `DispositionFieldName` / `AgentSummaryFieldName` / `TaskSummaryFieldName` / `GatewayCapacityFieldName` / `PressureFieldName` enums in `source-binding.ts`. Each render site in `FlowOverlay.tsx` uses `useSourceField` / `useSourceFields` exactly the way `PressureOverlay.tsx` does.

**Reasoning:** Pressure (binary, fired/didn't) and flow (continuous, gauge-shaped) are operationally distinct concepts — collapsing them into a single overlay would force operators to mentally separate "this gauge is at 80%" from "this marker tripped at 80%" by reading the same DOM. Two siblings keep the contract clean: pressure markers fire at threshold (Phase 2's contract), flow gauges always show the current ratio (Phase 3's contract). Same module shape, same DOM conventions, same source-binding pattern — minimal new pattern surface for executors / future contributors. The "Hybrid (gauge + threshold marker)" option was rejected because it would dual-render the same threshold information across two sibling overlays — visually redundant in v0.2's homelab scale.

### D-02: Source gaps — TaskSummary-style fallbacks + documented promotion paths

**Decision (D-02-A): Each of the 4 flows without a clean snapshot DTO source today gets a v0.2 fallback derived from existing snapshot fields, with an inline `flows.ts` comment naming the ideal source and the future phase that would promote it. Mirrors Phase 2's `pressure.ts` `// Ideal source is X; v0.2 fallback uses Y` pattern (see `pressure.ts` lines 201-310).**

Per-flow source bindings (planner refines exact field paths during research; the bindings below are the locked contract):

- **D-02-modelPower** — Source: `GatewayCapacityRow.inFlight` + `GatewayCapacityRow.currentCap` per row. Granularity: per gateway endpoint. Gauge: `value=inFlight`, `capacity=currentCap`, `unit='in flight'`. Detail link: `#/gateway`. **Clean source — no fallback needed.**
- **D-02-tokenFlow** — Ideal source: `GatewayUsageRow.inputTokens + outputTokens` summed over a rolling 1m window per `GatewayUsageRow.model` (lives on `/api/gateway/usage`, NOT on the snapshot today). v0.2 fallback: per-`TaskSummary.model` count of tasks in `phase='Dispatched'` × a documented "tokens per task" estimate (or just the count, with `unit='tasks'` and `label='tasks dispatched per model'` to be honest about the fallback). Comment in `flows.ts`: `// Ideal source: GatewayUsageRow.inputTokens+outputTokens via /api/gateway/usage rolling window. v0.2 fallback: count of TaskSummary by model in phase=Dispatched. Promote when /api/gateway/usage rows land on useCommandSnapshot().` Detail link: `#/gateway`.
- **D-02-buildPower** — Source: aggregated from existing snapshot — for each agent, count `Array.from(snapshot.tasks.values()).filter(t => t.targetAgent === agent.name && t.phase === 'Dispatched').length` and compare against `agent.capabilities.length` (or a documented per-agent budget proxy if capabilities count is wrong). Granularity: per agent. Gauge: `value=inFlightCount`, `capacity=undefined` (open-ended unless `pilotEvidence.policy.maxConcurrentChildren` reaches the snapshot — defer to a future phase per Finding 2 of Phase 2's pressure module). Comment: `// Ideal capacity: pilotEvidence.policy.maxConcurrentChildren on TaskDetail. v0.2: open-ended count without capacity bar. Promote when pilotEvidence reaches snapshot.` Detail link: `#/tasks?agent=<name>` (or planner picks the cleanest existing route).
- **D-02-podCapacity** — Source: if `useCommandSnapshot()` exposes cluster snapshot data (it doesn't today — `ClusterSnapshot` lives on `/api/cluster/snapshot`, not on the command snapshot), use `ClusterNodeRow.managedPodCount` per node vs `ClusterNodeRow.capacity['pods']`. v0.2 fallback: substrate-wide count of `Array.from(snapshot.tasks.values()).filter(t => t.podName !== undefined && (t.phase === 'Dispatched' || t.phase === 'Pending')).length` against an undefined capacity (open-ended gauge with `unit='pods'`). Comment: `// Ideal source: ClusterNodeRow.managedPodCount / ClusterNodeRow.capacity['pods'] via /api/cluster/snapshot. v0.2: substrate-wide active-pod count, no capacity bar. Promote when cluster snapshot joins useCommandSnapshot().` Detail link: `#/cluster`.
- **D-02-artifactBandwidth** — Source: substrate-wide rate from `Array.from(snapshot.tasks.values()).filter(t => t.phase === 'Completed').reduce((sum, t) => sum + (t.artifactCount ?? 0), 0)` against an open-ended capacity. Granularity: substrate-wide. Gauge: `value=totalArtifacts`, `capacity=undefined`, `unit='artifacts'`. Detail link: `#/cluster`. (No fallback comment — the source is already on `TaskSummary.artifactCount`.)
- **D-02-authority** — Source: substrate-wide count of `TaskSummary.error?.toLowerCase().includes('policy') && t.phase === 'Failed'` — same heuristic as Phase 2's `policy` pressure marker (`pressure.ts` lines 281-310). Granularity: substrate-wide. Gauge: `value=denialCount`, `capacity=undefined`, `unit='denials'`. Detail link: `#/tasks` (filtered to failed). Comment: `// Ideal source: structured 'policy_denied' audit event. v0.2 fallback: TaskSummary error-string match (same as pressure.ts policy marker). Promote when audit-event surface lands.`
- **D-02-trust** — Source: substrate-wide count of `Array.from(snapshot.tasks.values()).filter(t => (t.suspicious?.length ?? 0) > 0 || (t.phase === 'Failed' && t.error?.toLowerCase().includes('verifier'))).length`. Same heuristic as Phase 2's `verifier` pressure marker + `TaskSummary.suspicious`. Granularity: substrate-wide. Gauge: `value=trustEventCount`, `capacity=undefined`, `unit='events'`. Detail link: `#/tasks` (filtered). Comment: `// Ideal source: pilotEvidence.verification.passed on TaskDetail. v0.2 fallback: TaskSummary.suspicious + error-string match. Promote when pilotEvidence reaches TaskSummary.`
- **D-02-attention** — v0.2 stub: substrate-wide count of `Array.from(snapshot.tasks.values()).filter(t => t.phase === 'Failed' || (t.suspicious?.length ?? 0) > 0).length` as a proxy for "items needing review". Gauge: `value=needsReviewProxyCount`, `capacity=undefined`, `unit='items'`, `label='awaiting review queue projection — Phase 4'`. Detail link: `#/tasks` (filtered). Comment: `// Phase 4 owns the real review queue projection. v0.2 stub uses TaskSummary.phase=Failed + .suspicious as a proxy. Stub flips to the real projection in Phase 4 with no shape change to flows.ts (FlowGauge stays the same; only the compute() body changes).` data-source-field: `'phase,suspicious'`.

**Reasoning:** Phase 2 already validated this pattern (pressure.ts lines 200-310 ship 5 of 9 markers as v0.2 fallbacks with documented promotion paths). The same pattern keeps flows shippable now while making the promotion path explicit in code, not in some external roadmap. The "ship only 4 flows with clean DTOs" option was rejected because FLOW-01 explicitly says "each of the eight" — a 4-of-8 ship would BLOCK requirements coverage. The "add the missing data to the snapshot now" option was rejected because (a) it expands substrate primitive surface contrary to D2, and (b) Phase 4 owns the review queue projection — pre-empting it creates churn.

### D-03: Flow legend — `docs/FLOW-LEGEND.md` + module-level comments in `flows.ts`

**Decision (D-03-A): Two surfaces — `docs/FLOW-LEGEND.md` (developer-facing, discoverable, externally linkable) AND inline `flows.ts` per-`FLOW_TYPES`-entry comments (close to code, hard to drift). Mirrors Phase 2's `pressure.ts` self-documentation, plus a sibling external doc.**

- **`docs/FLOW-LEGEND.md` shape:**
  - Title + one-paragraph framing (cite `intel/constraints.md` §C-flow-economy + `COMMAND-CENTER-CONTRACT.md` Slice E + this CONTEXT.md).
  - 8-row table: `Flow | Granularity | v0.2 source | Ideal source | Pressure trigger (link to pressure.ts) | Operator action | Promotion path`.
  - One section per flow with: 2-3 sentence description, the exact field path(s), the fallback derivation expression (copy-paste from `flows.ts`), the Phase 4+ promotion plan, and a sample screenshot/ASCII of the gauge (planner picks).
  - Footer: "Living doc — update when `flows.ts` adds/removes/promotes a flow."
- **`flows.ts` inline comments:** every `FLOW_TYPES` entry gets a 4-8 line leading comment per the `pressure.ts` pattern. Planner copies the comment verbatim from this CONTEXT.md `D-02-*` block where applicable, then refines with file path / line number after implementation.
- **NOT in scope:** no on-canvas legend, no UI tooltip, no sidebar key, no "?" button on the FlowOverlay. Slice E says "legend in developer docs, NOT in main UI chrome" — the contract is honored.
- **Discoverability:** `docs/FLOW-LEGEND.md` is added to `docs/COMMAND-CENTER-CONTRACT.md` references section (§9 or footer) so future contributors land on it from the binding contract. The contract itself is NOT modified to add the 8 flows inline — that would be a contract revision and is out of Phase 3 scope.

**Reasoning:** Phase 2's `pressure.ts` ships with high-quality inline comments per type (lines 76-310) and that's where the source-of-truth lives — but the comments are only readable by someone reading the TS file. A standalone markdown doc gives operators / new engineers / `/gsd-*` tools a discoverable surface. Both together mean the doc and the code can't drift silently — a PR that changes `flows.ts` without touching `FLOW-LEGEND.md` is a code-review smell (and a future CI lint could catch this; deferred). The "extend `COMMAND-CENTER-CONTRACT.md` §6 with the 8 flows" option was rejected because the contract is binding and load-bearing — modifying it inflates Phase 3 scope and conflates "what flows exist today" (living code-derived doc) with "what the contract requires" (stable architectural doc).

### D-04: Base-only mode — single global `pressureDramatization` flag covers flows too

**Decision (D-04-A): Extend the existing `VITE_PRESSURE_DRAMATIZATION` flag (already used by `DispositionOverlay` and `PressureOverlay`) to cover `FlowOverlay`. Single global flag, single switch, no new env var.**

- **Flag name stays `VITE_PRESSURE_DRAMATIZATION`** — NOT renamed to `VITE_OVERLAY_DRAMATIZATION` or similar. Phase 2's CONTEXT.md D-CC-04-A locked "Single global flag", and the flag name reflects the original Slice E scope. Renaming would churn three components (DispositionOverlay, PressureOverlay, FlowOverlay) plus tests, plus the workbench-ui Helm overlay in `../new_localai/`. Single-global-flag-named-pressure is the smallest correct call.
- **`FlowOverlay` reads `pressureDramatization` prop** — same prop name as `PressureOverlay`, default `true`, plumbed from `import.meta.env.VITE_PRESSURE_DRAMATIZATION !== 'false'` in CommandView.tsx (existing wire — extend the existing prop down).
- **Subdued visual treatment:** when `pressureDramatization=false`, flow gauges render with subdued CSS (gray bar / no color saturation / no glow / no animation). Same data, different paint — base-building-only mode keeps every gauge readable, just without the "alarm" feel. Mirrors `pressure.ts`'s `pressureMarkerSubdued` CSS class pattern (`PressureOverlay.tsx` line 63).
- **Documentation:** `docs/FLOW-LEGEND.md` notes the flag at the top: "Visual treatment of all overlays (disposition, pressure, flows) is controlled by `VITE_PRESSURE_DRAMATIZATION`. Set `false` for base-building-only mode."

**Reasoning:** Phase 2 explicitly locked single-global-flag, single-source-of-truth for visual mode. Splitting flows out to a separate flag would (a) double the operator's mental model, (b) double the env-var surface in the workbench-ui Helm overlay, (c) create a "what does dramatization-on-pressure-but-off-on-flows mean?" failure mode that has no operational meaning. The "always operational style" option was rejected because flows ARE part of the dramatization story — when you dial up the alarm feel, you want the gauges to react too (red bar at 90%); when you dial it down for boring-day operations, you want them subdued. Single flag covers both moods.

### D-05: Granularity — per-flow natural granularity (mixed; not uniform)

**Decision (D-05-A): Each flow renders at the granularity that makes operational sense for its underlying DTO. NOT uniform substrate-wide; NOT uniform per-faction.**

Per-flow granularity bindings:

| Flow              | Granularity                                                                                                        | Number of gauges (homelab today) |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| modelPower        | perEndpoint (one per `GatewayCapacityRow`)                                                                         | ~4-8                             |
| tokenFlow         | perModelClass (one per distinct `TaskSummary.model` in v0.2 fallback; per `GatewayUsageRow.model` after promotion) | ~3-5                             |
| buildPower        | perAgent (one per `AgentSummaryRow`)                                                                               | ~3-10                            |
| podCapacity       | perNode if cluster snapshot reaches command snapshot; substrateWide v0.2 fallback (one gauge)                      | 1 (today)                        |
| artifactBandwidth | substrateWide                                                                                                      | 1                                |
| authority         | substrateWide                                                                                                      | 1                                |
| trust             | substrateWide                                                                                                      | 1                                |
| attention         | substrateWide (Phase 4 may promote to perAgent if review-queue projection segments by agent)                       | 1                                |

- **Total gauges in v0.2 homelab:** ~13-25 depending on cluster shape. Operators can scan the column at a glance; per-instance gauges link out to detail pages for drill-down.
- **Layout:** `FlowOverlay` renders gauges grouped by flow kind — one section per flow (with the flow name as section header) — gauges stacked within each section. CSS module follows `PressureOverlay.module.css` shape; planner picks exact width/spacing (Claude's discretion).
- **Empty-state rows:** when a flow has no gauges to render (e.g., zero `GatewayCapacityRow` items because gateway is offline), render a single placeholder row with `value=0`, `capacity=undefined`, `label='no <flow> source data'`, `data-source-field=<flow's primary source>`. All 8 flows are ALWAYS visible — silence is also data.
- **Per-faction option** is deferred. If/when the substrate gains a second faction (currently only `kagent-system` workloads in homelab), revisit per-faction overlays as a follow-up phase.

**Reasoning:** Pressure markers in Phase 2 are per-instance (one per failed task, one per saturated gateway). Flows are typically aggregate, but the natural aggregation differs per flow type — gateway capacity is per-endpoint because each endpoint has its own pool; build power is per-agent because each agent has its own concurrency budget; pod capacity is per-node because nodes have hard pod-count caps; the rest are substrate-wide because they're about the substrate's overall economy. Forcing all 8 flows to substrate-wide loses operational signal (which model class is hot? which agent is saturating?). Forcing all 8 to per-faction is meaningless in single-faction homelab. The per-flow-natural compromise matches how operators actually read the data and matches how the underlying DTOs already aggregate.

### Test posture (carries forward from Phase 1 + Phase 2)

- Vitest, co-located `*.test.ts` / `*.test.tsx`, run via `pnpm -C packages/workbench-ui test`. Same env (jsdom) and same conventions.
- ≥85% coverage on new files: `flows.ts`, `FlowOverlay.tsx`. Phase 1 set the bar at 85% on `source-binding.ts`; Phase 2 hit it on `pressure.ts`.
- ≥75% coverage on glue code: CommandView FlowOverlay mount + any extension to `source-binding.ts` (new `FlowFieldName` enum).
- **Required tests** (planner formalizes; this is the spec):
  - `flows.test.ts` — 8 `compute()` fires (one per flow with a fixture that exercises the flow) + 8 `compute()` empty-state cases (one per flow with absent data) = 16 unit tests minimum.
  - `flows.test.ts` — fixture assertion: `for (const ft of FLOW_TYPES) { expect(ft.sourceField ?? ft.sourceFields).toBeDefined(); }` — proves FLOW-01's "non-null source field reference" requirement.
  - `FlowOverlay.test.tsx` — render + `data-source-field` / `data-source-fields` DOM-attribute coverage on every gauge; subdued mode swap-test (mirror `PressureOverlay.test.tsx`).
  - **Extend `cc-snapshot.json` fixture** with sufficient data to fire all 8 flows. The fixture already covers all 9 pressure types; adding flow-fire scenarios layers cleanly. Planner picks the exact additions.
  - **Extend `cc-reload.test.tsx`** snapshot — re-run with the extended fixture so the existing reload-stability snapshot captures the new FlowOverlay output. The existing test will fail on first run after the new component mounts; planner runs `vitest -u` to update the snapshot deliberately, then commits.
- Snapshot tests use captured fixtures under `packages/workbench-ui/src/command/__fixtures__/`. Snapshots committed to git; updates require explicit `vitest -u` and reviewer attention.
- No new e2e infrastructure. No browser automation. The vitest jsdom env is sufficient.

### COMMAND-CENTER-CONTRACT.md compliance (D7)

D7 binds Phase 3's UI work — same as Phases 1 and 2. Every newly rendered gauge MUST map back to a substrate source. Phase 2's CC-01 generalized assertion is the enforcement mechanism, and Phase 3 uses it without modification:

1. The dev-only orphan assertion (CC-01, Phase 2) — already throws on any rendered field that doesn't carry `data-source-field` and a key that resolves on the snapshot. New `FlowFieldName` enum extends the closed-enum coverage.
2. The reload-stability test (CC-02, Phase 2) — the extended snapshot proves no UI-only state survives reload after the FlowOverlay lands.
3. The `data-source-field` DOM-attribute coverage on `FlowOverlay` rendered elements — same convention as `PressureOverlay` and `DispositionOverlay`.

### Claude's Discretion (unlocked — planner picks)

- Exact file structure for `flows.ts` (single file vs `flows/index.ts` + per-kind modules — planner picks based on file size; default single file, mirrors `pressure.ts`).
- Exact JSX layout of `FlowOverlay` (vertical bar / horizontal bar / spark / readout-only when capacity is undefined). Recommended: thin horizontal bar + readout-overlay, mirroring `PressureOverlay`'s row pattern.
- CSS module split (`FlowOverlay.module.css` per section, or share with `PressureOverlay.module.css`). Recommended: separate file per Phase 2's pattern; planner can refactor if duplication becomes painful.
- Snapshot fixture additions exact content (planner extends `cc-snapshot.json` with enough rows to fire all 8 flows; current fixture already covers 9 pressure types).
- Whether to add `streamLastEventAt` style snapshot fields for the 4 gap flows now (default: defer per D-02; revisit if a flow's v0.2 fallback is unusable).
- Whether `flows.ts` exports a helper like `getAllGauges(snapshot): readonly FlowGauge[]` for shared consumers, or each consumer iterates `FLOW_TYPES.flatMap(ft => ft.compute(snapshot))` inline (mirror `PressureOverlay.tsx` line 46).
- Exact wording in `docs/FLOW-LEGEND.md` per-flow sections; ASCII gauge sample is welcomed but not required.
- Where to mount `<FlowOverlay />` in CommandView.tsx — alongside `<PressureOverlay />` is the natural sibling site; planner picks the JSX position (default: directly after PressureOverlay).
- Whether to add a CI lint that grep-asserts every entry in `FLOW_TYPES` has a corresponding `## <Flow>` section in `docs/FLOW-LEGEND.md` (default: defer; add when there's a real-world drift).

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents (researcher, planner, executor, checker) MUST read these before planning or implementing.**

### Project planning corpus (re-steered 2026-05-09 PM)

- `.planning/PROJECT.md` — project bones; D1–D7; load-bearing tests (§11 bounds, §15 one-sentence); D7 "COMMAND-CENTER-CONTRACT.md is binding for Workbench/Command Center work"
- `.planning/REQUIREMENTS.md` §1 "Resource flows visible — FLOW" — FLOW-01 + FLOW-02 candidate acceptance criteria (lines 49-52)
- `.planning/REQUIREMENTS.md` §3 explicit non-goals — no UI-only world state, no fictional flows, no painted/sprite-skinned chrome
- `.planning/REQUIREMENTS.md` §4 future research — so we don't accidentally pull from it (no `/api/flows`, no `FlowRecord` CRD, no flow-aware reconciler)
- `.planning/ROADMAP.md` Phase 3 success criteria (2 items; depends on Phase 2)
- `.planning/STATE.md` — current pointer + blockers (Phase 2 complete; no blockers for Phase 3)

### Binding implementation contract (D7)

- `docs/COMMAND-CENTER-CONTRACT.md` — **binding for Phase 3.** Critical sections:
  - §2 Prime Directive (every world object derives from substrate source; UI MUST NOT maintain independent strategic state)
  - §3 Source-of-truth map (per-RTS-concept allowed/forbidden behaviors)
  - §6 Pressure systems (the 9 pressure types — siblings, not duplicates of, the 8 flows)
  - §7 Slice E (pressure overlay + flow gauges; "legend in developer docs, NOT in main UI chrome" is the binding constraint for D-03)
  - §9 Non-goals (no separate game simulation; no UI-only capability grants; no fictional resources)

### Domain definition (the eight flows)

- `.planning/intel/constraints.md` §C-flow-economy (lines 40-58) — **the canonical definition of the 8 flows.** Every entry in `FLOW_TYPES` maps 1:1 to an entry in this section. Cite by name (`model power`, `token flow`, `build power`, `pod capacity`, `artifact bandwidth`, `authority`, `trust`, `attention`).
- `docs/NORTH-STAR-SYSTEM-DESIGN.md` §4 (Flow economy) — the upstream "why" that drove the constraint. Provides the language the operator-facing legend (`docs/FLOW-LEGEND.md`) should use.

### Phase 1 + Phase 2 artifacts (REUSE — do not redesign)

- `.planning/phases/01-agentdisposition-v0/01-CONTEXT.md` — Phase 1 context; explains the source-binding pattern Phase 3 reuses
- `.planning/phases/01-agentdisposition-v0/01-04-PLAN.md` — DISP-04 + CC-01 (disposition slice) implementation; the source-binding.ts module shipped here
- `.planning/phases/02-command-center-contract-hardening/02-CONTEXT.md` — Phase 2 context; the closed-enum source-binding generalization, single-global-flag decision, snapshot-fixture pattern
- `.planning/phases/02-command-center-contract-hardening/02-03-PLAN.md` — Wave-2 plan with PressureOverlay JSX + module CSS shape
- `.planning/phases/02-command-center-contract-hardening/02-04-PLAN.md` — Wave-3 plan with cc-reload.test.tsx pattern (Phase 3 EXTENDS this snapshot)
- `.planning/phases/02-command-center-contract-hardening/02-04-SUMMARY.md` — vitest gotchas (selective fake timers, `globalThis.fetch` not `global`, `urlOf()` URL helper, Object.fromEntries for ReadonlyMap snapshots, JSON import attributes)
- `packages/workbench-ui/src/command/source-binding.ts` — Phase 1 + 2's per-component opt-in pattern. Phase 3 EXTENDS this file with `FlowFieldName` and reuses `isDevBuild()`, `assertSourceField`, `assertSourceFields`, `useSourceField`, `useSourceFields`.
- `packages/workbench-ui/src/command/source-binding.test.ts` — pattern for the new `FlowFieldName` orphan-assertion tests
- `packages/workbench-ui/src/command/pressure.ts` — **the template for `flows.ts`.** Same module shape (interface + closed-enum + array of typed entries + helper for hash routes). Read it first; copy its conventions verbatim; only deviate where flow semantics genuinely differ from pressure semantics.
- `packages/workbench-ui/src/command/pressure.test.ts` — 18-test pattern (9 fires + 9 absent) — the template for `flows.test.ts` (16 minimum: 8 fires + 8 absent).
- `packages/workbench-ui/src/command/PressureOverlay.tsx` — **the template for `FlowOverlay.tsx`.** Same render shape (`<aside>` + per-row anchor + `data-source-field`/`data-source-fields` + `pressureDramatization` prop).
- `packages/workbench-ui/src/command/PressureOverlay.test.tsx` — pattern for vitest snapshot + source-binding tests on the new overlay
- `packages/workbench-ui/src/command/PressureOverlay.module.css` — pattern for the CSS module (subdued vs dramatic class pair); `FlowOverlay.module.css` mirrors it.
- `packages/workbench-ui/src/command/cc-reload.test.tsx` — Phase 3 EXTENDS this snapshot to capture `FlowOverlay` output across the reload cycle
- `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` — Phase 3 EXTENDS this fixture with rows that fire all 8 flows (already covers 9 pressure types — additive change)
- `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap` — committed snapshot file; Phase 3 will trigger an intentional snapshot update on first FlowOverlay mount; reviewer scrutinizes the diff

### Existing Workbench surfaces the planner must work with

- `packages/workbench-ui/src/CommandView.tsx` — main CommandView component (~2300 lines). Phase 3 mounts `<FlowOverlay snapshot={...} pressureDramatization={...} />` alongside `<PressureOverlay />` (current PressureOverlay mount is the anchor — planner picks JSX site).
- `packages/workbench-ui/src/command/state.ts` — `useCommandSnapshot()` hook; `CommandSnapshot` shape is the source for flow `compute()` functions. Phase 3 makes NO changes to the snapshot shape (per D-02 fallback strategy).
- `packages/workbench-ui/src/types.ts` — `AgentSummaryRow`, `TaskSummary`, `TaskDetail`, `GatewayCapacityRow`, `GatewayUsageRow`, `ClusterSnapshot`. Closed-enum field-name types in `source-binding.ts` mirror these.
- `packages/dto/src/types.ts` — substrate-side DTO source-of-truth.
- `packages/workbench-api/src/routes/agents.ts`, `tasks.ts`, `gateway.ts`, `cluster.ts`, `dispositions.ts`, `stream.ts` — read-side endpoints the snapshot consumes; planner reads to confirm field paths haven't drifted since Phase 2 captured the cc-snapshot.json fixture.
- `packages/workbench-ui/src/App.tsx` — hash-route table (`#/tasks`, `#/gateway`, `#/cluster`, `#/command`). Detail-page deep links from Phase 3's gauges use these.

### Project conventions

- `CLAUDE.md` (root) — tech stack (TypeScript + Node 22 + tsx + ESM + pnpm workspace), MIT header on every `.ts` file, Conventional Commits (`feat(phase-03-...)` / `fix(phase-03-...)`), GitOps for cluster ops, `gh pr create` and `gh pr merge` are NOT a unit (per-PR explicit consent), pre-commit hook requires Node 22 (`source ~/.nvm/nvm.sh && nvm use 22` if default is newer).

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **`packages/workbench-ui/src/command/pressure.ts`** — the canonical template for `flows.ts`. 319 lines, 9 entries in a `PRESSURE_TYPES` array, each with `kind` / `sourceField` (or `sourceFields`) / `classify` / `detailLink`. Phase 3's `flows.ts` mirrors this shape exactly with `FlowType` / `FLOW_TYPES` / `compute` (instead of `classify`).
- **`packages/workbench-ui/src/command/PressureOverlay.tsx`** — 77 lines. The canonical template for `FlowOverlay.tsx`. Same `useMemo` over snapshot, same `<aside>` shell, same `data-source-field` / `data-source-fields` DOM convention, same `pressureDramatization` prop.
- **`packages/workbench-ui/src/command/source-binding.ts`** — already has `isDevBuild()`, `assertSourceField`, `assertSourceFields`, `useSourceField`, `useSourceFields`, plus closed-enum types `DispositionFieldName` / `AgentSummaryFieldName` / `TaskSummaryFieldName` / `GatewayCapacityFieldName` / `PressureFieldName`. Phase 3 ADDS `FlowFieldName` (derived from `FLOW_TYPES['kind']` mirror of the `PressureFieldName` trick at `pressure.ts:319`) and reuses the runtime helpers unchanged.
- **`packages/workbench-ui/src/command/state.ts`** (`useCommandSnapshot()`) — single source for `agents`, `tasks`, `gatewayCapacity`, `dispositions` Maps + `lastEventAt`. Phase 3 makes NO snapshot-shape changes (per D-02). All 8 flow `compute()` functions read from these Maps.
- **`packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json`** — Phase 2's canonical fixture (3 agents, mixed-phase tasks, gateway rows, dispositions, all 9 pressure types fire). Phase 3 EXTENDS this with rows that exercise the 8 flows (additive — no breaking changes; existing pressure tests stay green).
- **`packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap`** — Phase 2's reload-stability snapshot. Phase 3's first run after FlowOverlay mounts will diff this snapshot intentionally; planner runs `vitest -u` and the diff lands in a single commit reviewer can scrutinize.
- **`packages/workbench-ui/src/CommandView.tsx`** — `pressureDramatization` flag already plumbed (Phase 2 line 83 reference); FlowOverlay reads the same prop.
- **`packages/workbench-ui/src/command/PressureOverlay.module.css`** — pattern for the CSS module (`pressureMarker` / `pressureMarkerSubdued` class pair); `FlowOverlay.module.css` mirrors with `flowGauge` / `flowGaugeSubdued`.
- **Vitest infrastructure** — `pnpm -C packages/workbench-ui test`; jsdom env; `@testing-library/react`. All Phase 2's gotchas apply (selective `vi.useFakeTimers({ toFake: ['Date'] })`, `globalThis.fetch` not `global`, `urlOf()` URL helper, Object.fromEntries for Map snapshots, JSON import attributes).

### Established Patterns

- **Per-component opt-in source-binding** — every render site declares its source field via `useSourceField` / `useSourceFields`. Closed-enum types narrow the call signature. The TypeScript type system is the primary defense; the runtime assertion is a dev-only safety net (Phase 1 + 2 pattern).
- **Closed-enum `FieldName` types derived from typed source arrays** — `PressureFieldName = PressureType['kind']` at `pressure.ts:319`. Phase 3 mirrors with `FlowFieldName = FlowType['kind']` so the union stays in lockstep with the array contents (single source of truth).
- **`data-source-field` / `data-source-fields` DOM attribute** — comma-joined for multi-field. Phase 1 + 2 established this; Phase 3 keeps it (FlowOverlay's gauges carry the same attributes).
- **Module-level documentation pattern** — `pressure.ts` opens with a JSDoc block citing the contract section + the design decision; each entry in `PRESSURE_TYPES` has a 4-8 line leading comment naming the source field, the threshold/computation, and (for v0.2 fallbacks) the ideal source + promotion path. `flows.ts` mirrors this verbatim.
- **`pressureDramatization` prop convention** — boolean prop, default `true`, conditional CSS class swap. `FlowOverlay` follows.
- **`<aside>` + `<ul>/<li>` + `<a>` per row** — the PressureOverlay shape: top-level region, list of items, anchor per item with hash-route detail link. Mirror in FlowOverlay.
- **Sibling overlay mount** — DispositionOverlay (Phase 1) + PressureOverlay (Phase 2) + FlowOverlay (Phase 3) are sibling components mounted in CommandView, NOT nested, NOT consolidated.
- **Snapshot test fixtures** — `cc-snapshot.json` is the canonical input shape; both `cc-reload.test.tsx` and per-component tests import the same JSON. Phase 3 extends additively.
- **MIT license header on every `.ts` source file** — every new file gets the SPDX header per Phase 1's pattern.

### Integration Points

- **`packages/workbench-ui/src/CommandView.tsx`** — new `<FlowOverlay snapshot={snapshot} pressureDramatization={pressureDramatization} />` mounts alongside `<PressureOverlay />` (currently next to `<DispositionOverlay />` near line 1380; planner confirms the exact JSX site).
- **`packages/workbench-ui/src/command/source-binding.ts`** — extended (not replaced). New `FlowFieldName` exported.
- **`packages/workbench-ui/src/command/state.ts`** — UNCHANGED. No new snapshot fields per D-02. Future phases may add `streamLastEventAt`-style additions for the gap flows; Phase 3 does not.
- **`packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json`** — extended additively to fire all 8 flows + keep all 9 pressure types firing.
- **`packages/workbench-ui/src/command/cc-reload.test.tsx`** — extended snapshot via `vitest -u` after FlowOverlay first mounts; reviewed diff committed in a single PR.
- **No backend changes.** All Phase 3 work is in `packages/workbench-ui/` + `docs/FLOW-LEGEND.md`. No `packages/workbench-api/` PR. No CRD changes. No operator changes. No `../new_localai/` overlay changes (the existing `VITE_PRESSURE_DRAMATIZATION` env var is already plumbed; Phase 3 reuses it).

</code_context>

<specifics>

## Specific Ideas / Concrete Phase 3 Anchors

1. **Phase 2's pressure module shape is the template.** The user has validated the per-entry-typed-array + per-entry-typed-comments + closed-enum-from-array pattern by approving the Phase 2 plan and execution. Phase 3 GENERALIZES the same pattern from "binary markers" to "continuous gauges" — it does NOT redesign. Researcher and planner should treat `packages/workbench-ui/src/command/pressure.ts` and `PressureOverlay.tsx` and `pressure.test.ts` and `PressureOverlay.test.tsx` as the authoritative shape; `flows.ts` / `FlowOverlay.tsx` / `flows.test.ts` / `FlowOverlay.test.tsx` mirror them.

2. **"Read-depth precedes write-depth" is still load-bearing.** Phase 3 is read-side ONLY. Slice C (construction mode), Slice D (Tool Foundry), and any new write surface remain explicitly out of this phase per `COMMAND-CENTER-CONTRACT.md` §7.

3. **"No new CRDs in v0.2" still applies.** Flows are presentation-layer derivation, not substrate state. A `/api/flows` endpoint or a `FlowRecord` CRD would expand the substrate's primitive surface — explicitly off the table. Same exception bar as Phase 2: a new endpoint would require BOTH (a) a clear repeated UI-side computation that warrants centralization AND (b) explicit operator acceptance. Neither holds in v0.2.

4. **§11 bounds test answer for Phase 3 (must appear in PLAN.md):**
   - Declared capability: Command Center renders all 8 `C-flow-economy` flows as continuous gauges with proven backing source fields, reload-stable, base-building-only mode supported via the existing global flag.
   - Bounded resource drain: dev-only assertions stay no-op in prod (Phase 2's mechanism, unchanged); flow `compute()` is O(snapshot size) per render and runs only on snapshot change; no new persistence; no new API surface; snapshot fixture is committed once and re-used across reload tests; no new env vars added.
   - Observable state transition: orphan assertion (Phase 2 mechanism) catches any rendered gauge that lacks a backing source field; the cc-reload snapshot diff is reviewable; `data-source-field` DOM attributes are readable from devtools / scrapeable by future CI lint.
   - Auditable output: vitest CI run is the auditable surface — `flows.test.ts` (16 tests min — 8 fires + 8 absent), `FlowOverlay.test.tsx`, extended `cc-reload.test.tsx` snapshot, `source-binding.test.ts` updates for `FlowFieldName` all fail loud on regression.
   - Revocation path: `NODE_ENV=production` disables the orphan assertions (mechanism unchanged from Phase 2); `VITE_PRESSURE_DRAMATIZATION=false` subdues all overlays (now including flows); ALL Phase 3 changes are pure UI-package code (`packages/workbench-ui/`) + a developer doc (`docs/FLOW-LEGEND.md`) so a single revert removes the entire phase.

5. **§15 one-sentence test answer for Phase 3 (must appear in PLAN.md):**

   "Rendering the eight `C-flow-economy` flows as continuous source-bound gauges in Command Center, alongside Phase 2's pressure markers, gives operators legible resource economy state without expanding substrate primitives — strengthening observability of supply-vs-demand pressure in v0.2 and unlocking the promotion-to-real-source path documented in flows.ts comments for future phases."

6. **The user's "all recommendations" choice across all 5 gray areas is authority to lock D-01..D-05 with the recommended option; it is NOT authority to expand scope.** Both candidate requirements (FLOW-01, FLOW-02) stay in this phase; nothing more, nothing less.

7. **No imperative kubectl against homelab (CLAUDE.md operational context).** Phase 3 is pure UI work + a developer doc — no Job manifests, no cluster verification, no Helm changes, no GitOps overlay bumps. The verification surface IS vitest. The deployment surface (when the planner ships) is the workbench-ui Docker image rebuild + ArgoCD overlay bump in `../new_localai/`.

8. **`gh pr create` and `gh pr merge` are not a unit.** Phase 3 ships a PR for human review; the merge is a separate explicit consent from the operator (per CLAUDE.md and memory `feedback_auto_push.md`).

9. **Pre-commit hook needs Node 22.** Same as Phases 1 and 2 — `source ~/.nvm/nvm.sh && nvm use 22` before any commit if the machine default has drifted to Node 23+. Documented in Phases 01-04 + 02-{01..04} SUMMARY.md files.

</specifics>

<deferred>

## Deferred Ideas (Phase 3 explicitly does NOT do these)

- **`/api/flows` workbench-api projection.** Off the table this phase. Reconsider IF (a) UI-side classification of a single flow is repeatedly buggy in ways that point to needing centralization AND (b) operator explicitly accepts the API surface expansion. Neither condition holds in v0.2.
- **`FlowRecord` CRD or substrate-emitted flow DTOs.** Future Research per `D2`. Promotion requires repeated behavior across ≥2 deployments AND explicit acceptance.
- **Adding `GatewayUsageRow` data to `useCommandSnapshot()` for real per-request token-flow gauges.** Default: deferred. Phase 3's `tokenFlow` gauge uses task-count × model-class as proxy with `unit='tasks'` and an honest fallback label. Promotion path (in `flows.ts` comment): add `/api/gateway/usage` rolling window to the snapshot when this proxy is repeatedly insufficient.
- **Adding `pilotEvidence` to `TaskSummary` for real `trust` and `verifier` data.** Default: deferred. Phase 3's `trust` gauge uses `TaskSummary.suspicious` + verifier-error-string fallback (same as Phase 2's `verifier` pressure marker). Promotion path: extend `TaskSummary` with a minimal `pilotEvidence` subset when needed across multiple consumers.
- **Real review-queue projection for `attention` flow.** Phase 4 owns this work (REV-01 in REQUIREMENTS.md). Phase 3 ships a stub gauge with `label='awaiting review queue projection — Phase 4'`. The stub flips to the real projection in Phase 4 by changing only the `compute()` body — `FlowGauge` shape stays the same.
- **Adding `ClusterSnapshot` data to `useCommandSnapshot()` for real per-node `podCapacity` gauges.** Default: deferred. Phase 3's `podCapacity` gauge uses substrate-wide active-pod count with no capacity bar. Promotion path: join cluster snapshot into command snapshot when needed.
- **Per-faction overlay aggregation.** Default: deferred. Single-faction homelab has no per-faction signal today. Revisit when the substrate gains a second faction (multi-tenant experiments).
- **Per-flow-type dramatization toggles.** Off the table. Single global `pressureDramatization` flag covers BOTH pressure markers AND flow gauges. Renamed-flag proposal (`VITE_FLOW_DRAMATIZATION` separate from `VITE_PRESSURE_DRAMATIZATION`) is rejected.
- **On-canvas legend tooltip / sidebar key / "?" button on FlowOverlay.** Off the table per Slice E acceptance criterion ("legend in developer docs, NOT in main UI chrome"). The legend is `docs/FLOW-LEGEND.md` only.
- **CI lint that grep-asserts every `FLOW_TYPES` entry has a corresponding `## <Flow>` section in `docs/FLOW-LEGEND.md`.** Default: deferred. Add when a real-world drift slips through review.
- **Generalizing source-binding to OTHER Workbench surfaces** (TaskList, TaskDetail, GatewayPage, ClusterPage). Deferred to a future Workbench hardening phase. Phase 3 scopes to Command Center only, same as Phase 2.
- **Modifying `docs/COMMAND-CENTER-CONTRACT.md` §6 to enumerate the 8 flows inline.** Off the table. The contract is binding and load-bearing; modifying it inflates Phase 3 scope and conflates "what flows exist today" (living code-derived doc) with "what the contract requires" (stable architectural doc). The contract gets a footer link to `docs/FLOW-LEGEND.md` in a separate doc-update commit, NOT a contract revision.
- **`flows/index.ts` + per-kind sub-modules.** Default: single `flows.ts` file mirroring `pressure.ts`. Split only if the file grows past ~400 lines (mirror Phase 2's "Claude's Discretion" bullet).

</deferred>

---

_Phase: 03-resource-flow-overlays_
_Context gathered: 2026-05-10 — five gray areas presented (flow shape D-01, source gaps D-02, legend location D-03, base-only mode D-04, granularity D-05); user accepted the recommended option in each. All Phase 2 patterns reused without modification._
