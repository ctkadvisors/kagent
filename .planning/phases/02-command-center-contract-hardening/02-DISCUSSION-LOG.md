# Phase 2: Command Center contract hardening — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `02-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-05-10
**Phase:** 02-command-center-contract-hardening
**Mode:** discuss-phase, auto / "yolo, best fit choices"
**Areas discussed:** source-binding generalization shape (CC-01); reload-stability test fidelity (CC-02); pressure overlay scope and sourcing (CC-04); selection panel depth strategy (CC-03)

---

## Source-binding generalization shape (CC-01)

| Option                                           | Description                                                                                                                                                                       | Selected |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Per-component opt-in (extend Phase 1 pattern)    | Every render site calls an assertion + emits `data-source-field`. Closed-enum field-name types narrow the call site. Mapper assertion in `computeLayout` for canvas-side orphans. | ✓        |
| Per-mapper assertion (Snapshot→SceneGraph layer) | A single mapper layer enforces every output node has a backing source ref. Render sites stay generic.                                                                             |          |
| Dev-mode DOM-mutation observer                   | Global scanner walks the DOM in dev and shouts on any element under `data-rendered-node` lacking `data-source-field`.                                                             |          |

**User's choice:** "yolo, best fit choices" → per-component opt-in (matches Phase 1 pattern; per-rendered-field cost is known; mapper assertion fills the canvas-side gap).
**Notes:** Phase 1 already validated this pattern by shipping `source-binding.ts` and the DispositionOverlay. Phase 2 EXTENDS the file with new closed-enum types (`AgentSummaryFieldName`, `TaskSummaryFieldName`, `GatewayCapacityFieldName`, `PressureFieldName`) and reuses the runtime helpers. The DOM-mutation-observer option was attractive but interacts badly with React's reconciler in dev.

---

## Reload-stability test fidelity (CC-02)

| Option                         | Description                                                                                                 | Selected |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------- |
| DOM snapshot only              | Vitest snapshot of the React tree (panels). Misses canvas-side orphans because canvas is opaque to vitest.  |          |
| Scene-graph JSON snapshot only | Serialize `computeLayout` output to JSON. Captures canvas-rendered structure but doesn't touch React.       |          |
| Both (DOM + scene-graph)       | Two snapshots per test: panel DOM + scene-graph JSON. Costlier but actually proves the contract end-to-end. | ✓        |

**User's choice:** "yolo, best fit choices" → both. DOM-only misses canvas; scene-graph-only misses panel rendering bugs.
**Notes:** Fixture lives at `packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json` capturing `/api/agents` + `/api/tasks` + `/api/gateway/capacity` + `/api/dispositions`. Closed list of presentation-only state allowed to vary across reloads is enumerated in CONTEXT.md (camera, selection, hover, audio, bookmarks, control groups, popover, FX); anything else differing across reloads fails the test.

---

## Pressure overlay scope and sourcing (CC-04)

| Option                                                              | Description                                                                                                                          | Selected |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| All 9 pressure types with whatever fields exist today               | UI-side derivation in `pressure.ts`; some weak sources (e.g., stale telemetry from SSE heartbeat). No new API surface.               | ✓        |
| Subset that has clean substrate sources (5–6 types, defer the rest) | Ship strong-source pressure types; defer the weakly-sourced ones to Phase 3.                                                         |          |
| Add a `/api/pressure` workbench-api projection                      | Centralize classification server-side; UI consumes typed `PressureMarker` DTOs. Cleaner per Prime Directive but expands API surface. |          |

**User's choice:** "yolo, best fit choices" → all 9, UI-side derivation in `pressure.ts`. No `/api/pressure`.
**Notes:** The contract demands all 9 pressure types in CC-04's success criteria. UI-side derivation keeps pressure classification close to the visualization. The two genuinely UI-derived signals (stale telemetry from SSE heartbeat; quota wall via SSE audit-event consumption) are still grounded in substrate-emitted state observed by the UI — the source-field reference points to the SSE stream's last-message-at OR the audit-event kind, both of which ARE substrate sources per the Prime Directive. Single global `pressureDramatization` flag covers all 9 types (extends Phase 1's flag).

---

## Selection panel depth strategy (CC-03)

| Option                                          | Description                                                                                                                                                                | Selected |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Inline-expand (more KV rows in existing panels) | Add missing fields directly to AgentPanel/TaskPanel/GatewayPanel as more KV rows. Each new row uses the source-binding pattern. Plus prominent "Open in detail page" link. | ✓        |
| Embed mini-detail components                    | Reuse fragments from existing TaskDetail/GatewayPage/ClusterPage as collapsible sections inside the panel.                                                                 |          |
| Minimal panels + deep links to detail routes    | Keep panels minimal, add anchor-supported deep links (`#/cluster?node=foo`).                                                                                               |          |

**User's choice:** "yolo, best fit choices" → inline-expand. Mini-detail would create a duplicate rendering surface; minimal+links is too thin per the contract's "every click answers what object is this" criterion.
**Notes:** AgentPanel gains capabilities, modelClass-vs-model labeling, namespace KV, active-task counter, recent-failure counter. TaskPanel gains timestamps, suspicious-tags chips, verifier verdict (with TaskDetail fallback), trace-link button (with TaskDetail fallback), artifact-count, parent/child counters. GatewayPanel gains "Open in GatewayPage" link. No new routes, no anchor support, no embedded mini-detail components in this phase.

---

## Claude's Discretion (planner picks)

- Exact file split for `pressure.ts` (could grow to `pressure/` subdir if file exceeds ~400 lines).
- Whether the layout-mapper assertion lives in `computeLayout` itself or at its caller in CommandView (test ergonomics decide).
- Snapshot fixture date and exact agent/task/gateway count (planner captures from a live dev workbench-api).
- Whether to add `traceLink` to `TaskSummary` to remove the "trace link unknown" fallback (default: defer).
- Whether `localStorage`-backed bookmark persistence is added (default: RESET on reload).
- Whether a CI lint that greps for `data-source-field` coverage on rendered panel elements is added (default: defer).
- Whether hash-route anchor support is needed for any deep links (default: defer).
- Whether `state.streamLastEventAt` already exists on the snapshot or needs a small addition to `useCommandSnapshot` (planner inspects).

## Deferred Ideas

- `/api/pressure` workbench-api projection — off the table this phase; reconsider only on repeated UI-side bugs AND explicit operator acceptance.
- `PressureRecord` CRD or substrate-emitted pressure DTOs — Future Research per `D2`.
- Hash-route anchor support (`#/cluster?node=<name>`) — deferred unless planner finds it necessary for read depth.
- Adding `traceLink` to `TaskSummary` — deferred; TaskDetail link is the fallback.
- Embedded mini-detail components inside selection panels — off the table this phase.
- Per-pressure-type dramatization toggles — off the table; single global flag.
- Generalizing source-binding to OTHER Workbench surfaces (TaskList, TaskDetail, GatewayPage, ClusterPage) — deferred to a future Workbench hardening phase.
- localStorage-backed bookmark persistence — deferred; bookmarks RESET on reload in v0.2.
- CI lint for `data-source-field` attribute coverage — deferred; vitest orphan-assertion test catches the in-use cases.
- Construction mode (Slice C) and Tool Foundry (Slice D) — explicitly later phases per `COMMAND-CENTER-CONTRACT.md` §7 ordering.
- Adding `streamLastEventAt` to a workbench-api response DTO — deferred; UI-side derivation is sufficient for v0.2.
