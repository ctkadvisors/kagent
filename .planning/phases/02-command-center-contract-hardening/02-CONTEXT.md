# Phase 2: Command Center contract hardening — Context

**Gathered:** 2026-05-10
**Status:** Ready for planning
**Mode:** discuss-phase, "yolo, best-fit choices" — Claude locked in recommendations across all 4 gray areas with no objection. The user has authority to override any decision below before/during planning.

> **Critical framing.** Phase 2 GENERALIZES the per-component source-binding pattern shipped in Phase 1 / DISP-04 (`packages/workbench-ui/src/command/source-binding.ts`) to the **whole** Command Center: Agent nodes from `/api/agents`, task sprites from `/api/tasks`, gateway rows from `/api/gateway/capacity`, the disposition overlay (already done), and a new pressure overlay covering all 9 pressure types from `COMMAND-CENTER-CONTRACT.md` §6. Phase 2 introduces **no new CRD, no new reconciler, and no new substrate-level persistence primitive.** Read-depth precedes write-depth (per `COMMAND-CENTER-CONTRACT.md` Slice A/B → C/D ordering).

<domain>
## Phase Boundary

**In scope (Phase 2 delivers):**

1. **CC-01 — Whole-view source-binding assertion.** Generalize Phase 1's `assertSourceField`/`assertSourceFields`/`useSourceField`/`useSourceFields` pattern from the disposition slice to all rendered Command Center objects. Add closed-enum field-name types for `AgentSummaryRow`, `TaskSummary`, `GatewayCapacityRow`, and the new `PressureMarker` shape (UI-derived; see CC-04). Every rendered field carries `data-source-field` (or `data-source-fields` for computed values). A canvas-side mapper assertion in the layout pipeline rejects scene nodes whose `key` is not present in the source `Map<string, AgentSummaryRow>` / `Map<string, TaskSummary>`. Fixture-based vitest test asserts the assertion fires for synthesized orphan rows AND no-ops in `NODE_ENV=production`.
2. **CC-02 — Reload-stable rendering test.** Vitest snapshot test seeded with a captured API fixture (`__fixtures__/cc-snapshot.json`: `/api/agents` + `/api/tasks` + `/api/gateway/capacity` + `/api/dispositions`) that renders Command Center, captures **two** snapshots (DOM tree of panels + scene-graph JSON of `computeLayout` output), simulates a cold reload (fresh React root mount), and asserts both snapshots match across reloads. The test enumerates the closed list of presentation-only state allowed to vary across reloads (camera, selection, hover, audio, bookmarks, control groups, dispatch popover, short-lived FX) and fails if anything else differs.
3. **CC-03 — Operational read depth on selection panels.** Inline-expand the existing `AgentPanel` / `TaskPanel` / GatewayPanel (in `packages/workbench-ui/src/CommandView.tsx`) with the missing fields per `COMMAND-CENTER-CONTRACT.md` Slice B:
   - **AgentPanel:** add capabilities row, modelClass-vs-model labeling (when both present), explicit namespace KV, active-task counter, recent-failure counter (1m + 1h windows). All KV rows use the source-binding pattern.
   - **TaskPanel:** add timestamps (createdAt, startedAt, completedAt) where present, suspicious-tags chips, verifier verdict (pulled from snapshot if reachable; else "—" with link to TaskDetail), trace-link button, artifact-count counter, parent/child counters.
   - **GatewayPanel:** keep capacity rows; add the "Open in GatewayPage" deep link (uses existing `#/gateway` route).
   - All panels gain a prominent "Open in detail page" link at the bottom (`#/tasks/<ns>/<name>`, `#/gateway`, `#/cluster`) — no new route anchor support required in Phase 2 unless the planner finds it necessary for read depth (see Deferred).
4. **CC-04 — Pressure overlay (all 9 pressure types) + base-building-only mode.** Render the 9 pressure types from `COMMAND-CENTER-CONTRACT.md` §6 — context pressure, gateway saturation, policy denial, verifier failure, artifact debt, trace gap, pod failure, quota wall, stale telemetry — as Command Center overlays. Each pressure marker carries a `data-source-field` (or `data-source-fields`) attribute pointing at the backing DTO field, plus a `detailLink` to the relevant route (TaskDetail / GatewayPage / ClusterPage / Langfuse). Classification logic lives in a new `packages/workbench-ui/src/command/pressure.ts` module — UI-side derivation, no new workbench-api endpoint, no new DTO. Extend the existing `pressureDramatization` flag (already used by DispositionOverlay) to all 9 pressure types — single global flag, set via `VITE_PRESSURE_DRAMATIZATION=false`, base-building-only mode keeps the same data with subdued visual treatment.

**Out of scope for Phase 2 (locked exclusions):**

- Any new CRD (per D2; this phase is read-side hardening only).
- Any new workbench-api endpoint, including `/api/pressure` — pressure classification is a UI-side derivation from existing DTO fields. (If the planner finds a pressure type whose source field is genuinely not reachable in the current snapshot — e.g., context utilization that never made it into `pilotEvidence` — the planner BLOCKS on that and either picks an existing field that approximates it OR defers that single pressure type to Phase 3 with a documented reason. The default posture is "all 9 derived from existing fields.")
- Any new write action on Command Center (Slice C/D — construction mode and Tool Foundry — are explicitly NOT in this phase per `COMMAND-CENTER-CONTRACT.md` §7 ordering: Slice A→B→E first; C/D later).
- Any new substrate-level pressure signal (e.g., a CRD `PressureRecord`, a controller that emits pressure DTOs). Pressure is presentation-layer derivation in v0.2.
- Hash-route anchor support (e.g., `#/cluster?node=<name>`) UNLESS the planner finds it necessary to satisfy CC-03's read-depth (default: defer).
- Any UI-only state in Command Center — every world-object/animation/action MUST derive from a substrate source per the Prime Directive. New visualizations that lack a source field FAIL the CC-01 assertion in dev.
- Generalizing source-binding to OTHER Workbench surfaces (TaskList, TaskDetail, GatewayPage, ClusterPage). This phase scopes to Command Center specifically.
- Multi-flag pressure-type config (per-pressure-type dramatization toggles). Single global flag — extend Phase 1's pattern, don't redesign.
- Adding a `traceLink` to `TaskSummary` (today only `TaskDetail` carries it) — TaskPanel reads what's in the snapshot; "trace link" pressure marker uses `traceLink === undefined` as the source via TaskDetail when reachable, else the pressure marker's source field is `phase` + `traceLink absent` (documented in `pressure.ts`). Adding `traceLink` to `TaskSummary` is a clean follow-up but adds workbench-api surface; defer unless planner finds it necessary.

</domain>

<decisions>
## Implementation Decisions (locked for this phase, all "best-fit" — user has authority to override)

### CC-01: Source-binding generalization shape

**Decision (D-CC-01-A): Per-component opt-in extension of Phase 1's pattern, plus a layout-mapper assertion for the canvas side.**

- **React-rendered surfaces (panels, overlays, hover preview):** every rendered field calls one of the per-DTO assertion helpers and emits a `data-source-field` (or `data-source-fields`) DOM attribute. Add new closed-enum types alongside Phase 1's `DispositionFieldName`:
  - `AgentSummaryFieldName` = `'name' | 'namespace' | 'model' | 'modelClass' | 'tools' | 'capabilities'`
  - `TaskSummaryFieldName` = `'name' | 'namespace' | 'uid' | 'phase' | 'targetAgent' | 'targetCapability' | 'model' | 'createdAt' | 'startedAt' | 'completedAt' | 'podName' | 'error' | 'suspicious' | 'artifactCount' | 'childCount' | 'aggregatePhase'`
  - `GatewayCapacityFieldName` = `'model' | 'endpoint' | 'backendKind' | 'inFlight' | 'currentCap' | 'seed' | 'max' | 'minSafe' | 'recentP50Ms' | 'crName' | 'crNamespace'`
  - `PressureFieldName` = a string union that mirrors the documented `sourceField` of each `PressureMarker` entry (computed at module load from `PRESSURE_TYPES` to keep the source-of-truth single).
  - Each closed enum is exported from a new `packages/workbench-ui/src/command/source-binding.ts` (extend the existing file) and used at every render site. Adding a new top-level field requires updating the enum — that's the design.
- **Canvas-rendered surfaces (Agent sprites, task sprites, FX):** add a dev-only assertion at the boundary `Snapshot → SceneGraph` (in `computeLayout` or its caller in CommandView.tsx). Every scene node's `key` MUST exist in the corresponding source map (`snapshot.agents.get(key) !== undefined` for agent nodes; `snapshot.tasks.get(key) !== undefined` for task sprites). Throws in dev with a message naming the orphan key + a pointer to `COMMAND-CENTER-CONTRACT.md` §2. No-op in prod.
- **Same dev-detection logic as Phase 1** (`isDevBuild()` from `source-binding.ts`) — no new env-detection plumbing.
- **Test (CC-01 acceptance):** vitest fixture-based test that:
  1. Builds a snapshot with one orphan agent key (referenced in scene graph but missing from `agents` Map) — asserts the layout-mapper assertion throws.
  2. Builds a synthesized `AgentSummaryRow` missing the `tools` field — asserts `assertSourceField(row, 'tools')` throws when AgentPanel attempts to render it.
  3. Sets `NODE_ENV=production` (via `vi.stubEnv`) — asserts both assertions are no-ops.

**Reasoning:** Per-component opt-in matches the pattern shipped in Phase 1, so adding a new rendered field has a known cost. A DOM-mutation observer would be more bulletproof but adds a global dev-only side-effect that interacts badly with React's reconciler. The mapper-side assertion handles the canvas case (where `data-source-field` attributes can't exist) by enforcing the invariant one layer up. Together, they cover both rendering surfaces.

### CC-02: Reload-stability test fidelity

**Decision (D-CC-02-A): BOTH a DOM snapshot (panels + overlays) AND a scene-graph JSON snapshot (`computeLayout` output) per reload-stability test.**

- **Fixture:** `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` — captured from a real workbench-api response set: `/api/agents`, `/api/tasks`, `/api/gateway/capacity`, `/api/dispositions`. ~3 agents, ~6 tasks (mix of phases), ~2 gateway endpoints, ~1 disposition overlay, at least one over-budget pressure case. Captured once via a curl + jq pipeline against a live workbench-api in dev mode (planner picks the exact snapshot date; ship it under git).
- **Test shape:** vitest test that:
  1. Loads the fixture into a mock workbench-api client (intercepts `fetch` calls).
  2. Renders `<CommandView />` to a React testing-library root.
  3. Captures `screen.getByRole('complementary')` (the `<aside class={panel}>`) DOM as snapshot #1.
  4. Captures `JSON.stringify(layoutRef.current)` (or equivalent — the planner picks the exact accessor) as snapshot #2.
  5. Unmounts. Re-renders with the SAME fixture, fresh React root.
  6. Captures both again. Asserts snapshots are deep-equal.
- **Closed list of presentation-only state allowed to vary across reloads** (everything else MUST survive the reload test, OR be derived from API state):
  - `camera` (pan/zoom position) — survives only if user picked a non-default bookmark/recall; otherwise resets to centered HQ.
  - `selection.keys` and `selection.focus` — RESET on reload (selection is presentation state).
  - `hoveredAgentKey` — RESET (transient pointer state).
  - `muted` / `thrumMuted` / `audioReady` — RESET (re-prompted by audio-enable hint).
  - `bookmarks` — survives ONLY if the planner adds localStorage persistence (default: RESET; bookmark loss across reload is acceptable for v0.2).
  - `controlGroups` — RESET (per-session muscle memory, not strategic state).
  - `popover` (DispatchPopover) — RESET (transient).
  - `taskActionMenu` — RESET (transient).
  - `alertText` — RESET.
  - `hintsOpen` — RESET (defaults to closed; hotkey hint overlay is opt-in per session).
  - `replay` (per-agent ghost-task playback) — RESET; replay is per-session interaction, not substrate state.
  - Short-lived FX (anything keyed by an event id with TTL < 1s) — RESET.
  - **Forbidden to vary:** any rendered Agent / Task / Gateway / disposition / pressure field that isn't in the list above. Test fails if any of these differ across reloads given identical fixture data.

**Reasoning:** DOM-only snapshot misses canvas-side orphans; scene-graph-only snapshot misses panel-rendering bugs. Both together prove the contract end-to-end. The presentation-state list is closed and explicit so future PRs that add new state get caught by the test.

### CC-03: Selection panel depth strategy

**Decision (D-CC-03-A): Inline-expand the existing AgentPanel / TaskPanel / GatewayPanel with the missing Slice-B fields. No mini-detail components. Prominent "Open in detail page" link at the bottom of each panel.**

- **AgentPanel additions** (extend `packages/workbench-ui/src/CommandView.tsx:1898`):
  - Capabilities KV row (`data-source-field={useSourceField('capabilities')}`); display as comma-joined pills, "—" if empty.
  - Model row already exists; add modelClass label when `a.modelClass !== undefined && a.modelClass !== a.model`.
  - Active-task counter (computed from `inFlight.length`, derived from `snapshot.tasks` + `agentKey` — uses `useSourceFields(['phase', 'targetAgent'])` since the count derives from BOTH fields on every task in the snapshot).
  - Recent-failure counter (1m window): same source-fields shape.
  - Recent-failure counter (1h window): same.
  - Bottom: existing "Open in detail" — but Agents don't have a dedicated detail page; the link is "Open in /tasks?agent=<name>" with query-string filter (or the planner picks the cleanest existing route).
- **TaskPanel additions** (extend `packages/workbench-ui/src/CommandView.tsx:2000`):
  - Timestamps section (createdAt, startedAt, completedAt) — only render fields that are defined on the snapshot. Each timestamp is a KV row with `data-source-field`.
  - Suspicious-tags chips: render if `t.suspicious !== undefined && t.suspicious.length > 0` (`data-source-field={useSourceField('suspicious')}`).
  - Verifier verdict: `TaskSummary` doesn't carry verifier directly — pull from `pilotEvidence.verification` IF the snapshot has it; else "—" with link to TaskDetail. Document this gap in `pressure.ts` as the source-field reference for verifier-failure pressure.
  - Trace-link button: `TaskSummary.traceLink` does NOT exist today (only on `TaskDetail`). Render "Open trace →" linking to `#/tasks/<ns>/<name>` (which itself opens TaskDetail with the trace link). Document the gap.
  - Artifact-count: `data-source-field={useSourceField('artifactCount')}`, display "0" when undefined.
  - Parent/child counters: `data-source-field={useSourceField('childCount')}` and the `pilotEvidence.taskGraph.parentTask` proxy via TaskDetail link.
  - Bottom: existing "Open detail →" link is fine.
- **GatewayPanel additions** (extend the existing `selection.kind === 'gateway'` branch at CommandView.tsx:1697):
  - Add per-row source-field attributes on inFlight/currentCap (`data-source-fields`).
  - Add "Open in GatewayPage →" link at the bottom (existing `#/gateway` route).
- **No new routes, no anchor support, no embedded mini-detail components.** Detail pages stay the long-form read; panels carry the operational read depth needed to answer "what is this?" without leaving Command Center.

**Reasoning:** Inline expansion is the smallest shape change that delivers Slice B's intent. Mini-detail components would create a duplicate rendering surface (and force CC-01 assertions across two layers per field). Minimal-panel + deep-links is too thin per the contract's "every click answers what object is this" criterion.

### CC-04: Pressure overlay scope and sourcing

**Decision (D-CC-04-A): Ship all 9 pressure types in Phase 2, derived from existing DTO fields (UI-side classification in `packages/workbench-ui/src/command/pressure.ts`). No `/api/pressure` endpoint. No new substrate state. Single global `pressureDramatization` flag covers all types.**

- **Module:** `packages/workbench-ui/src/command/pressure.ts` exports a `PRESSURE_TYPES` array shaped as:
  ```ts
  interface PressureType {
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
    readonly sourceField: string; // for source-binding assertion + data-source-field attribute
    readonly sourceFields?: readonly string[]; // when computed from multiple
    readonly classify: (snapshot: CommandSnapshot) => PressureMarker[];
    readonly detailLink: (marker: PressureMarker) => string;
  }
  ```
- **Per-pressure-type source field bindings** (planner refines exact field paths during research):
  - **context pressure** → `pilotEvidence.policy.maxConcurrentChildren` + `pilotEvidence.taskGraph.inFlightCount` ratio (or `pilotEvidence.runConfig.maxIterations` + iteration count if reachable). Detail link: `#/tasks/<ns>/<name>` for the impacted task.
  - **gateway saturation** → `GatewayCapacityRow.inFlight` / `GatewayCapacityRow.currentCap` ≥ 0.8. Detail link: `#/gateway`.
  - **policy denial** → audit-event stream consumed by SSE (existing); marker surfaces on the impacted Agent. Detail link: `#/cluster` or `#/tasks/<ns>/<name>` if the audit event references a task.
  - **verifier failure** → `pilotEvidence.verification.passed === false` (only available via TaskDetail; for the TaskSummary-only snapshot, fall back to `phase === 'Failed' && error` containing "verifier"). Detail link: `#/tasks/<ns>/<name>`.
  - **artifact debt** → `TaskSummary.artifactCount === 0 && phase === 'Completed'` for tasks expected to produce artifacts. Detail link: `#/tasks/<ns>/<name>`.
  - **trace gap** → `TaskSummary.phase` is terminal AND TaskDetail's `traceLink === undefined` (proxied via TaskDetail; for TaskSummary-only, the marker is "trace link unknown" with a link to TaskDetail). Detail link: `#/tasks/<ns>/<name>`.
  - **pod failure** → `TaskSummary.error !== undefined && phase === 'Failed'` AND `containerStatuses` (when reachable via TaskDetail) shows non-zero exit. For TaskSummary-only: `phase === 'Failed' && podName !== undefined`. Detail link: `#/tasks/<ns>/<name>`.
  - **quota wall** → workbench-api doesn't currently emit a clean quota DTO into Command Center's snapshot. Source field: `disposition.over_budget` audit event (consumed by SSE) OR `dispositions[].overBudget === true`. Detail link: `#/tasks/<ns>/<name>` for the impacted agent's most recent task.
  - **stale telemetry** → SSE heartbeat staleness. Source field: `state.streamLastEventAt` (UI-derived from the SSE stream's last-message timestamp — which IS a substrate observation: the substrate's last emission). When `now - streamLastEventAt > 30s`, marker fires globally. Detail link: `#/cluster`.
- **Assertion (CC-01 ties in here):** every `PressureMarker` returned from `classify()` carries the `sourceField` (or `sourceFields`) string. The DOM-rendering layer asserts the source field IS a known key on the relevant DTO. Synthesized orphan markers (whose `sourceField` doesn't resolve) trip the dev assertion.
- **Visual treatment:** extend the existing `DispositionOverlay`'s `pressureDramatization` flag — single global flag for all 9 types. Subdued mode renders the same markers + same data, just without the dramatic styling.
- **Test (CC-04 acceptance):** vitest fixture test asserting each of the 9 pressure types fires when its source data is present in the fixture, and does NOT fire when absent. Fixture builds 9 minimal scenarios (one per pressure type).

**Reasoning:** A `/api/pressure` endpoint would expand the substrate's primitive surface for what's currently a UI-side derivation. The contract explicitly puts pressure in the UI layer (§6 candidate pressure types are "real signals" already exposed through existing DTOs). UI-side derivation also keeps pressure classification close to the visualization, which is where it changes most often. The two genuinely UI-derived signals (stale telemetry from SSE heartbeat, quota wall via audit-event SSE) are still grounded in substrate-emitted state observed by the UI — the source-field reference points to the SSE stream's last-message-at OR the audit-event kind, both of which ARE substrate sources per the Prime Directive.

### Test posture (carries forward from Phase 1)

- Vitest, co-located `*.test.ts` / `*.test.tsx`, run via `pnpm -C packages/workbench-ui test`.
- ≥85% coverage on `source-binding.ts` (extended) and `pressure.ts` (new).
- ≥75% coverage on glue code (CommandView panel additions, layout-mapper assertion).
- Snapshot tests use captured fixtures under `packages/workbench-ui/src/command/__fixtures__/`. Snapshots committed to git; updates require explicit `vitest -u` and reviewer attention.
- No new e2e infrastructure. No browser automation. The vitest jsdom env is sufficient for the React tree; the canvas/scene-graph layer tests via the JSON-serializable `computeLayout` output.

### COMMAND-CENTER-CONTRACT.md compliance (D7)

D7 binds Phase 2's UI work — same as Phase 1. Every newly rendered field/marker MUST map back to a substrate source. CC-01's generalized assertion is the enforcement mechanism. The Prime Directive is verified at code level by:

1. The dev-only orphan assertion (CC-01).
2. The reload-stability test (CC-02) — proves no UI-only state survives reload.
3. The `data-source-field` DOM-attribute coverage (a follow-up grep can find any rendered element under `<aside class={panel}>` lacking the attribute; the planner may add this as a CI lint, optional).

### Claude's Discretion (unlocked — planner picks)

- Exact file split for `pressure.ts` (could become `pressure/index.ts` + per-kind modules if the file grows past ~400 lines).
- Whether the layout-mapper assertion lives in `computeLayout` or in CommandView's snapshot→layout pipeline call site (planner picks based on test ergonomics).
- Snapshot fixture date and exact agent/task/gateway count (planner captures from a live dev workbench-api).
- Whether to add `traceLink` to `TaskSummary` to remove the "trace link unknown" fallback (default: defer; revisit if the panel feels broken without it).
- Whether `localStorage`-backed bookmarks survive reload (default: RESET; revisit if user feedback wants persistence).
- Whether to add a CI lint that greps for `data-source-field` coverage on rendered panel elements (default: defer).
- Whether `hash-route` anchor support (e.g., `#/cluster?node=<name>`) is needed for any of the deep links (default: defer; revisit if a panel field genuinely needs an anchor target).
- Whether `state.streamLastEventAt` already exists on the snapshot or needs a small addition to `useCommandSnapshot` (planner inspects `state.ts`; small UI-internal addition is fine, no API change).

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents (researcher, planner, executor, checker) MUST read these before planning or implementing.**

### Project planning corpus (re-steered 2026-05-09 PM)

- `.planning/PROJECT.md` — project bones; D1–D7; load-bearing tests (§11 bounds, §15 one-sentence); D7 "COMMAND-CENTER-CONTRACT.md is binding for Workbench/Command Center work"
- `.planning/REQUIREMENTS.md` §1 "Command Center contract hardening — CC" — CC-01..04 candidate acceptance criteria
- `.planning/REQUIREMENTS.md` §3 explicit non-goals — UI-only world state forbidden, painted/sprite-skinned chrome forbidden
- `.planning/REQUIREMENTS.md` §4 future research — so we don't accidentally pull from it (no `/api/pressure`, no `PressureRecord` CRD, no Tool Foundry write surface)
- `.planning/ROADMAP.md` Phase 2 success criteria (4 items; depends on Phase 1)
- `.planning/STATE.md` — current pointer + blockers (none blocking Phase 2)

### Binding implementation contract (D7)

- `docs/COMMAND-CENTER-CONTRACT.md` — **binding for Phase 2.** Critical sections:
  - §2 Prime Directive (every world object derives from substrate source; UI MUST NOT maintain independent strategic state)
  - §3 Source-of-truth map (per-RTS-concept allowed/forbidden behaviors)
  - §4 Action contract (write surface — out of scope this phase, but sets the bound)
  - §6 Pressure systems (the 9 pressure types + base-building-only fallback)
  - §7 Slice A (contract hardening), Slice B (operational read depth), Slice E (pressure overlay) — Phase 2 implements all three
  - §9 Non-goals (no separate game simulation; no UI-only capability grants)

### Phase 1 artifacts (REUSE — do not redesign)

- `.planning/phases/01-agentdisposition-v0/01-CONTEXT.md` — Phase 1 context; explains the source-binding pattern Phase 2 generalizes
- `.planning/phases/01-agentdisposition-v0/01-04-PLAN.md` — DISP-04 + CC-01 (disposition slice) implementation plan; the source-binding.ts module shipped here
- `packages/workbench-ui/src/command/source-binding.ts` — Phase 1's per-component opt-in pattern. Phase 2 EXTENDS this file with new closed-enum field-name types and reuses `isDevBuild()`, `assertSourceField`, `assertSourceFields`, `useSourceField`, `useSourceFields`.
- `packages/workbench-ui/src/command/source-binding.test.ts` — pattern for the new orphan-assertion tests
- `packages/workbench-ui/src/command/DispositionOverlay.tsx` — pattern for emitting `data-source-field` / `data-source-fields` attributes on rendered elements
- `packages/workbench-ui/src/command/DispositionOverlay.test.tsx` — pattern for vitest snapshot + source-binding tests

### Source documents (candidate inputs after re-steering)

- `docs/NORTH-STAR-SYSTEM-DESIGN.md` — workflow substrate north star; gives the "why" for pressure-as-substrate-signal
- `docs/PROTO-SOCIETY-DESIGN.md` — proto-society north star; **read with awareness that its CRD-shaped primitives are Future Research, not v0.2 commitments**

### Existing Workbench surfaces the planner must work with

- `packages/workbench-ui/src/CommandView.tsx` — main CommandView component (~2300 lines). Phase 2 extends `AgentPanel` (line 1898), `TaskPanel` (line 2000), `SelectionPanel` gateway branch (line 1697), and adds the pressure overlay component.
- `packages/workbench-ui/src/command/state.ts` — `useCommandSnapshot()` hook; the snapshot shape is the source for layout-mapper assertion and pressure classification
- `packages/workbench-ui/src/command/layout.ts` — `computeLayout()`; canvas-side mapper assertion lands here or in its caller
- `packages/workbench-ui/src/command/scene.ts` — `drawScene()`; canvas rendering; selection grammar
- `packages/workbench-ui/src/command/DispositionOverlay.tsx` — sibling overlay pattern for the new pressure overlay
- `packages/workbench-ui/src/types.ts` — `AgentSummaryRow`, `TaskSummary`, `TaskDetail`, `GatewayCapacityRow`, `GatewayUsageRow`, `ClusterSnapshot`. Closed-enum field-name types in source-binding.ts mirror these.
- `packages/workbench-ui/src/api.ts` — `fetchAgents`, `fetchTasks`, `fetchGatewayCapacity` calls. Snapshot fixture for CC-02 captures the responses.
- `packages/workbench-ui/src/App.tsx` — hash-route table (`#/tasks`, `#/gateway`, `#/cluster`, `#/command`). Detail-page deep links from Phase 2's panels use these.
- `packages/dto/src/types.ts` — `TaskSummary`, `TaskDetail`, `AgentSummary`, `TaskPilotEvidence`, `GatewayCapacityRow`. Source-of-truth for the DTO shapes.

### Project conventions

- `CLAUDE.md` (root) — tech stack (TypeScript + Node 22 + tsx + ESM + pnpm workspace), MIT header on every `.ts` file, Conventional Commits (`feat(phase-02-...)` / `fix(phase-02-...)`), GitOps for cluster ops, `gh pr create` and `gh pr merge` are NOT a unit (per-PR explicit consent), don't host new image-gen workloads on Jetson, `*.knuteson.io` hostname check before claiming subdomains.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **`packages/workbench-ui/src/command/source-binding.ts`** — Phase 1's per-component opt-in pattern. Already has `isDevBuild()`, `assertSourceField`, `assertSourceFields`, `useSourceField`, `useSourceFields`, `DispositionFieldName`. Phase 2 ADDS new closed-enum types (`AgentSummaryFieldName`, `TaskSummaryFieldName`, `GatewayCapacityFieldName`, `PressureFieldName`) and reuses everything else.
- **`packages/workbench-ui/src/command/DispositionOverlay.tsx`** — sibling overlay pattern. New pressure overlay component follows the same shape: SVG/HTML markers positioned over the canvas, `data-source-field`/`data-source-fields` attributes, conditional `pressureDramatization` styling.
- **`packages/workbench-ui/src/command/state.ts`** (`useCommandSnapshot()`) — single source for `agents`, `tasks`, `gatewayCapacity`, `dispositions` Maps. Pressure classification and layout-mapper assertion both consume this.
- **`packages/workbench-ui/src/command/layout.ts`** (`computeLayout()`) — input is the snapshot Maps; output is positioned scene nodes. Canvas-side mapper assertion lands here or at its caller.
- **`packages/workbench-ui/src/command/__snapshots__/`** — already exists (vitest snapshot output dir). New CC-02 snapshot files land here.
- **`packages/workbench-ui/src/CommandView.tsx`** — `pressureDramatization` flag already implemented (line 83); extend to cover all 9 pressure types.
- **Vitest infrastructure** — `pnpm -C packages/workbench-ui test`; jsdom env; `@testing-library/react` available for DOM assertions.

### Established Patterns

- **Per-component opt-in source-binding** — every render site declares its source field. Closed-enum types narrow the call signature. The TypeScript type system is the primary defense; the runtime assertion is a dev-only safety net.
- **`data-source-field` / `data-source-fields` DOM attribute** — comma-joined for multi-field. Phase 1 already established this; Phase 2 keeps it.
- **`isDevBuild()` env detection** — `NODE_ENV=production` first, then Vite's `import.meta.env.PROD`/`DEV`, with a safe-default of dev. Tests stub via `vi.stubEnv('NODE_ENV', 'production')`.
- **Per-component `pressureDramatization` prop** — DispositionOverlay reads it; new pressure overlay follows the same shape.
- **Snapshot Maps in `useCommandSnapshot()`** — `Map<string, AgentSummaryRow>` keyed by `${namespace}/${name}`. The layout-mapper assertion uses `.get(key) !== undefined` as its check.
- **MIT license header on every `.ts` source file** — every new file gets the SPDX header per Phase 1's pattern.

### Integration Points

- **`packages/workbench-ui/src/CommandView.tsx`** — the new pressure overlay component mounts alongside `<DispositionOverlay />` (currently mounted around line 1380). The existing `pressureDramatization` flag is already in scope.
- **`packages/workbench-ui/src/command/source-binding.ts`** — extended (not replaced). New closed-enum exports added; `assertSourceField` / `assertSourceFields` are generic over the field-name type union, so adding new types doesn't change the runtime helpers.
- **`packages/workbench-ui/src/command/layout.ts`** — `computeLayout()` (or its caller) gains a dev-only orphan assertion before returning the layout result.
- **`packages/workbench-ui/src/command/state.ts`** — `useCommandSnapshot()` MAY gain a `streamLastEventAt` field for the stale-telemetry pressure type. Small UI-internal addition; no workbench-api change.
- **No backend changes.** All Phase 2 work is in `packages/workbench-ui/`. No `packages/workbench-api/` PR. No CRD changes. No operator changes.

</code_context>

<specifics>
## Specific Ideas / Concrete Phase 2 Anchors

1. **Phase 1's source-binding shape is the template.** The user has already validated the per-component opt-in pattern by approving the Phase 1 plan and execution. Phase 2 GENERALIZES — it does not redesign. Researcher and planner should treat `packages/workbench-ui/src/command/source-binding.ts` and the DispositionOverlay tests as the authoritative shape; new code mirrors them.

2. **"Read-depth precedes write-depth" is a load-bearing rule.** Phase 2 is read-side ONLY. Slice C (construction mode), Slice D (Tool Foundry), and any new write surface are explicitly out of this phase. The contract orders the slices A→B→E first; later slices are future work.

3. **"No new CRDs in v0.2" applies here too.** Pressure is presentation-layer derivation, not substrate state. A `/api/pressure` endpoint would expand the substrate's primitive surface — explicitly off the table. The exception bar: a new endpoint would require BOTH (a) a clear repeated UI-side computation that warrants centralization AND (b) explicit operator acceptance. Neither holds in v0.2.

4. **§11 bounds test answer for Phase 2 (must appear in PLAN.md):**
   - Declared capability: Command Center can render Agent / Task / Gateway / disposition / pressure objects with proven backing source fields, reload-stable, and operator can answer "what object is this?" at every selection.
   - Bounded resource drain: dev-only assertions are no-op in prod (zero runtime cost); pressure classification is O(snapshot size) per render and runs only on snapshot change; no new persistence; no new API surface; snapshot fixture is committed once and re-used across reload tests.
   - Observable state transition: orphan assertion throws in dev with a referenceable error pointing at `COMMAND-CENTER-CONTRACT.md` §2; scene-graph snapshot diff is inspectable; `data-source-field` DOM attributes are readable from devtools / scrapeable by future CI lint.
   - Auditable output: vitest CI run is the auditable surface — orphan-assertion test, reload-stability test, per-pressure-type test all fail loud on regression.
   - Revocation path: `NODE_ENV=production` disables the orphan assertions (tests stub this explicitly); `VITE_PRESSURE_DRAMATIZATION=false` disables visual treatment for all 9 pressure types; ALL Phase 2 changes are pure UI-package code (`packages/workbench-ui/`) so a single revert removes the entire phase.

5. **§15 one-sentence test answer for Phase 2 (must appear in PLAN.md):**

   "Generalizing source-binding from the disposition slice to the whole Command Center, plus reload-stable rendering and operational read depth on selection panels, makes the existing Command Center provably faithful to substrate state and gives operators legible failure pressure — strengthening observability and review without expanding substrate primitives."

6. **The user's "yolo, best fit choices" is authority to pick recommendations across all 4 gray areas; it is NOT authority to expand scope.** All 4 candidate requirements (CC-01..04) stay in this phase; nothing more, nothing less.

7. **No imperative kubectl against homelab (CLAUDE.md operational context).** Phase 2 is pure UI work — no Job manifests, no cluster verification, no Helm changes. The verification surface IS vitest. The deployment surface (when the planner ships) is the workbench-ui Docker image rebuild + ArgoCD overlay bump in `../new_localai/`.

8. **`gh pr create` and `gh pr merge` are not a unit.** Phase 2 ships a PR for human review; the merge is a separate explicit consent from the operator (per CLAUDE.md and memory `feedback_auto_push.md`).

</specifics>

<deferred>
## Deferred Ideas (Phase 2 explicitly does NOT do these)

- **`/api/pressure` workbench-api projection.** Off the table this phase. Reconsider IF (a) UI-side classification of a single pressure type is repeatedly buggy in ways that point to needing centralization AND (b) operator explicitly accepts the API surface expansion. Neither condition holds in v0.2.
- **`PressureRecord` CRD or substrate-emitted pressure DTOs.** Future Research per `D2`. Promotion requires repeated behavior across ≥2 deployments AND explicit acceptance.
- **Hash-route anchor support** (`#/cluster?node=<name>`, `#/gateway?endpoint=<name>`). Default: deferred. Revisit IF Phase 2's deep-link integration tests show a panel field genuinely needs an anchor target. Otherwise, "Open in detail page" lands the operator on the page and the page's own UI handles intra-page navigation.
- **Adding `traceLink` to `TaskSummary`.** Default: deferred. Trace-link pressure marker fallback (`phase` terminal AND `traceLink === undefined`) is acceptable for v0.2 because the marker links to TaskDetail which carries the real link. Revisit if the panel feels broken without it.
- **Embedded mini-detail components inside selection panels.** Off the table this phase. Inline-expand with KV rows is the chosen shape. Reconsider IF a panel grows past ~30 KV rows and needs collapsible sections (unlikely for v0.2).
- **Per-pressure-type dramatization toggles.** Off the table. Single global `pressureDramatization` flag is sufficient.
- **Generalizing source-binding to OTHER Workbench surfaces** (TaskList, TaskDetail, GatewayPage, ClusterPage). Deferred to a future Workbench hardening phase. Phase 2 scopes to Command Center only.
- **localStorage-backed bookmark persistence across reload.** Deferred. Bookmarks RESET on reload in Phase 2; revisit if user feedback wants persistence.
- **CI lint that greps for `data-source-field` attribute coverage on rendered panel elements.** Deferred. The vitest orphan-assertion test catches the in-use cases; a CI lint catches the not-yet-used ones. Add when there's a real-world miss.
- **Construction mode (Slice C) and Tool Foundry (Slice D).** Explicitly later phases per `COMMAND-CENTER-CONTRACT.md` §7 ordering.
- **Adding `streamLastEventAt` to a workbench-api response DTO.** Deferred. Stale-telemetry pressure derives the value UI-side from the SSE stream's last-message timestamp (which IS a substrate observation). Promote to a DTO field only if multiple consumers need it.

</deferred>

---

_Phase: 02-command-center-contract-hardening_
_Context gathered: 2026-05-10 in auto mode after operator's "yolo, best fit choices" directive on all 4 gray areas (source-binding generalization shape; reload-stability test fidelity; pressure overlay scope and sourcing; selection panel depth strategy)._
