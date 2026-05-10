# Phase 3: Resource-flow overlays - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-10
**Phase:** 03-resource-flow-overlays
**Areas discussed:** Flow shape (D-01), Source gaps (D-02), Flow legend (D-03), Base-only mode (D-04), Granularity (D-05)

---

## Flow shape — `FlowOverlay` vs extending pressure markers vs hybrid

| Option                                                          | Description                                                                                                                                                                                                                                                                                                       | Selected |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| New `FlowOverlay` with continuous gauges (Recommended)          | Sibling component to PressureOverlay. Each flow renders as a utilization bar/gauge with current value vs capacity. Pressure markers stay separate — flows are 'how much is flowing', pressure markers are 'something tripped'. Same source-binding pattern; same pressureDramatization flag for visual treatment. | ✓        |
| Extend `pressure.ts` — add 'always-on' kind to existing markers | Reuse PressureOverlay shape; flows become markers that always render with current value in the label. Less new code; loses the visual distinction between 'gauge state' and 'something tripped'.                                                                                                                  |          |
| Hybrid — gauge + threshold marker per flow                      | FlowOverlay renders 8 gauges always; threshold breaches additionally fire pressure markers. Two surfaces, more code, but matches RTS resource bars + alerts pattern. May overlap visually with Phase 2's pressure overlay.                                                                                        |          |

**User's choice:** New `FlowOverlay` with continuous gauges (Recommended)
**Notes:** Pressure (binary, fired/didn't) and flow (continuous, gauge-shaped) are operationally distinct concepts. Two siblings keep the contract clean and minimize new pattern surface. Hybrid was rejected to avoid dual-rendering the same threshold information across two sibling overlays.

---

## Source gaps — fallbacks vs adding data to snapshot vs partial coverage

| Option                                                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                             | Selected |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| TaskSummary-style fallbacks + documented promotion paths (Recommended)        | Match Phase 2's pressure.ts pattern: each flow gets a v0.2 fallback derived from existing snapshot fields, with an inline comment naming the 'ideal' source and the future phase that would promote it. Token flow uses task counts + model-class as proxy; trust uses TaskSummary.suspicious + phase=Failed counts; attention defers to Phase 4 (renders 'awaiting review queue projection — Phase 4'); build power aggregates from existing snapshot. | ✓        |
| Add the missing data to the snapshot now                                      | Extend useCommandSnapshot to fetch /api/gateway/usage (rolling window for token flow), and add a small workbench-api review-queue stub for attention. Cleaner data, but EXPANDS substrate primitive surface (D2 says no), and Phase 4 owns the review queue — doing it now creates churn.                                                                                                                                                               |          |
| Ship only the 4 flows with clean DTOs (model power, pod, artifact, authority) | Defer token / trust / build-power / attention to Phase 4+ when their source data lands. Strict reading of FLOW-01 says 'each of the 8' — partial coverage would BLOCK the requirement.                                                                                                                                                                                                                                                                  |          |

**User's choice:** TaskSummary-style fallbacks + documented promotion paths (Recommended)
**Notes:** Phase 2 already validated this pattern (5 of 9 pressure markers ship as v0.2 fallbacks with documented promotion paths). FLOW-01 says "each of the eight" — a 4-of-8 ship would BLOCK the requirement. Pre-empting Phase 4's review queue work would create churn.

---

## Flow legend location — markdown doc vs inline comments vs both

| Option                                                                     | Description                                                                                                                                                                                                                                                                                                | Selected |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| New `docs/FLOW-LEGEND.md` + module-level comment in flows.ts (Recommended) | Mirror Phase 2's pressure.ts pattern (inline source-field comments per type) AND add a developer-facing markdown doc that maps each flow → substrate source → pressure trigger → operator action. Doc is the discoverable surface; module comments stay close to code. Living doc updated as flows evolve. | ✓        |
| Module-level comment only (in flows.ts)                                    | Skip the standalone doc; rely on inline comments per FLOW_TYPES entry like pressure.ts does. Less discoverable but less doc-rot risk.                                                                                                                                                                      |          |
| Both + extend `docs/COMMAND-CENTER-CONTRACT.md` §6 with the 8 flows        | Most thorough; updates the binding contract to include flows explicitly. Highest cost — changes a load-bearing doc and may cause re-review/scope creep.                                                                                                                                                    |          |

**User's choice:** New `docs/FLOW-LEGEND.md` + module-level comment in flows.ts (Recommended)
**Notes:** Modifying COMMAND-CENTER-CONTRACT.md (the binding contract) was rejected to avoid scope creep and conflating "what flows exist today" (living code-derived) with "what the contract requires" (stable architectural). The contract gets a footer link to FLOW-LEGEND.md in a separate doc-update commit, NOT a contract revision.

---

## Base-only mode — single global flag vs separate flag vs always-operational

| Option                                                                 | Description                                                                                                                                                                                                 | Selected |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Same single global flag (Recommended)                                  | Extend `VITE_PRESSURE_DRAMATIZATION=false` to also subdue flow gauges. Same data renders, just with subdued visual treatment. Single switch matches Phase 2's locked decision and minimizes config surface. | ✓        |
| Separate `VITE_FLOW_DRAMATIZATION` flag                                | Independent toggle for flows. More fine-grained, but adds a config surface and breaks Phase 2's 'single global' precedent.                                                                                  |          |
| Flows always render in operational style (no dramatization either way) | Flows are pure operational data — render plain gauges always. Pressure markers are the dramatic surface; flows are the 'truth' underneath.                                                                  |          |

**User's choice:** Same single global flag (Recommended)
**Notes:** Phase 2's CONTEXT.md D-CC-04-A locked single-global-flag with single-source-of-truth for visual mode. Splitting flows out would create a "what does dramatization-on-pressure-but-off-on-flows mean?" failure mode with no operational meaning. The "always operational style" option was rejected because flows ARE part of the dramatization story (red bar at 90% when alarm-on; subdued when boring-day).

---

## Granularity — per-flow natural vs substrate-wide vs per-faction

| Option                                                | Description                                                                                                                                                                                                                                                                                                                                                           | Selected |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Per-flow natural granularity (Recommended)            | Each flow renders at the granularity that makes operational sense: model power = per gateway endpoint; pod capacity = per node; token flow = per model class; build power = per agent; artifact bandwidth/authority/trust/attention = substrate-wide. Matches how the underlying DTOs already aggregate. More gauges total, but each one is operationally meaningful. | ✓        |
| Substrate-wide only (8 gauges total, one per flow)    | Roll everything up to a single number per flow. 8 gauges total, simpler header bar. Loses per-endpoint visibility — e.g., 'gateway saturation 80% overall' hides which model class is hot.                                                                                                                                                                            |          |
| Per-faction (kagent-system, kagent-experiments, etc.) | Match the existing scene-graph faction aggregation in computeLayout. 8 flows × 1-2 factions = ~16 gauges. Operationally meaningful for multi-tenant later, less so for v0.2 single-faction homelab.                                                                                                                                                                   |          |

**User's choice:** Per-flow natural granularity (Recommended)
**Notes:** Pressure markers in Phase 2 are per-instance. Flows are typically aggregate, but the natural aggregation differs per flow type — gateway capacity is per-endpoint because each endpoint has its own pool; build power is per-agent because each agent has its own concurrency budget; pod capacity is per-node because nodes have hard pod-count caps; the rest are substrate-wide because they're about the substrate's overall economy. Per-faction is meaningless in single-faction homelab and is deferred to a multi-tenant phase.

---

## Done check

| Option                  | Description                                                                                                                                                                                                                                        | Selected |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Ready for CONTEXT.md    | Lock the 5 decisions above and write the context. Planner picks remaining choices: file structure (single flows.ts vs split), exact gauge visual (bar/donut/spark), test fixture strategy (extend cc-snapshot.json vs new file), CSS module split. | ✓        |
| Explore more gray areas | I have more concerns. Identify additional gray areas based on what we've discussed so far.                                                                                                                                                         |          |

**User's choice:** Ready for CONTEXT.md
**Notes:** Five decisions locked is sufficient for the planner. Remaining choices (file structure, exact gauge visual, test fixture strategy, CSS module split) are operational details that fall to Claude's Discretion in CONTEXT.md.

---

## Claude's Discretion

The following implementation details were explicitly delegated to the planner:

- Exact file structure for `flows.ts` (single file vs `flows/index.ts` + per-kind modules — default single file mirroring `pressure.ts`).
- Exact JSX layout of `FlowOverlay` (vertical bar / horizontal bar / spark / readout-only when capacity is undefined). Recommended: thin horizontal bar + readout-overlay, mirroring `PressureOverlay`'s row pattern.
- CSS module split (`FlowOverlay.module.css` per section, or share with `PressureOverlay.module.css`). Recommended: separate file per Phase 2's pattern.
- Snapshot fixture additions exact content (planner extends `cc-snapshot.json` with enough rows to fire all 8 flows; current fixture already covers 9 pressure types).
- Whether to add `streamLastEventAt` style snapshot fields for the 4 gap flows now (default: defer per D-02; revisit if a flow's v0.2 fallback is unusable).
- Whether `flows.ts` exports a helper like `getAllGauges(snapshot)` or each consumer iterates `FLOW_TYPES.flatMap(ft => ft.compute(snapshot))` inline (mirror `PressureOverlay.tsx` line 46).
- Exact wording in `docs/FLOW-LEGEND.md` per-flow sections; ASCII gauge sample is welcomed but not required.
- Where to mount `<FlowOverlay />` in CommandView.tsx (default: directly after PressureOverlay).
- Whether to add a CI lint that grep-asserts every entry in `FLOW_TYPES` has a corresponding `## <Flow>` section in `docs/FLOW-LEGEND.md` (default: defer; add when there's a real-world drift).

## Deferred Ideas

The following came up during scope-bounding and are explicitly NOT in Phase 3:

- `/api/flows` workbench-api projection — Phase 2 already rejected the parallel `/api/pressure` for the same reasons.
- `FlowRecord` CRD or substrate-emitted flow DTOs — Future Research per D2.
- Adding `GatewayUsageRow` to the snapshot for real per-request token-flow data — promotion path documented in `flows.ts` comment.
- Adding `pilotEvidence` to `TaskSummary` for real verifier/trust data — defer to a future Workbench-hardening phase.
- Real review-queue projection for the `attention` flow — Phase 4 owns this (REV-01 in REQUIREMENTS.md).
- Adding `ClusterSnapshot` data to the snapshot for real per-node `podCapacity` gauges — defer.
- Per-faction overlay aggregation — defer until the substrate has a second faction (multi-tenant experiments).
- Per-flow-type dramatization toggles — single global flag is the locked decision.
- On-canvas legend tooltip / sidebar key / "?" button on FlowOverlay — Slice E says "legend in developer docs, NOT in main UI chrome".
- CI lint that grep-asserts FLOW_TYPES ↔ FLOW-LEGEND.md sync — defer.
- Generalizing source-binding to OTHER Workbench surfaces (TaskList, TaskDetail, GatewayPage, ClusterPage) — Phase 3 scopes to Command Center only.
- Modifying `docs/COMMAND-CENTER-CONTRACT.md` §6 to enumerate the 8 flows inline — would inflate scope and conflate living/stable docs.
