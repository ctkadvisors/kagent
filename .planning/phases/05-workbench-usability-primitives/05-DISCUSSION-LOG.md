# Phase 5 — Discussion Log

**Discussion held:** 2026-05-10
**Mode:** discuss-phase, user pre-authorized "recommended" options for all gray areas

This log records the discussion that produced `05-CONTEXT.md`. It is for human reference (audits, retrospectives) and is **not** consumed by downstream agents.

---

## Question 1 — Gray Area Selection

**Question:** Phase 5: Workbench usability primitives. Domain — make operator's daily workflow less friction-bound; RTS feel = usability primitives, not visual chrome. Which gray areas do you want to discuss?

**Options presented (multiSelect):**

1. **Hotkey scheme scope & grammar (WB-01)** — Global app-wide layer vs per-route. Vim-style `g <route>` namespace? How does CommandView's existing grammar interact with new app-wide keys? Cheat sheet surface (`?` in any route)?
2. **Multi-select bulk-inspect actions (WB-02)** — Which bulk actions ship (open-in-tabs / copy-IDs / scroll-to-first-failure)? Where does the action UI live? Cap on tab-storm risk?
3. **Replay-from-context axes & annotation (WB-03)** — Operator-changeable axes: just targetAgent, or also per-task modelClass override (requires schema change)? Entry points (TaskDetail button, Command Center right-click, both)? `replayOf` annotation key + which fields copy verbatim?
4. **RTS-feel-as-usability compliance + COMMAND-CENTER-CONTRACT** — Sound/FX posture for new hotkeys + multi-select actions? Source-binding compliance for new bulk-inspect rendering? Memory rule `workbench RTS = USABILITY not visual chrome` — what NOT to ship?

**User's selection:** "use 'recommended' options going forward"

**Interpretation:** Treat as authority to lock D-01..D-04 with the recommended option for each gray area. NOT authority to expand scope. Mirrors the Phase 4 "follow best 'recommended' suggestions" pattern.

---

## D-01: Hotkey scheme — Recommended option locked

**Recommendation:** Mixed scheme — global vim-style `g <route>` navigation + per-route context hotkeys + unified `?` cheat sheet.

**Rationale presented to user (implicit in recommendation):**

- A pure global Ctrl+<letter> scheme collides with browser shortcuts (Ctrl+T = new tab, Ctrl+R = reload). Vim-style `g <letter>` namespace avoids the collision entirely.
- A pure per-route scheme fails the WB-01 spec text "jump to review queue" requirement — a global hotkey IS the cleanest path from `#/tasks` to `#/review`.
- A mixed scheme matches the spec's two flavors: navigation (global) + per-context operations (per-route).
- Existing CommandView `?` overlay is preserved (it owns `?` inside `#/command`); App-level `?` opens a unified cheat sheet that's a strict superset.

**Resolution:**

- `g <letter>` chord (1500ms timeout) for the 5 navigation routes (`t/g/c/k/r`)
- `?` opens unified cheat sheet from any route (short-circuits to CommandView's local overlay when inside `#/command`)
- Per-route context keys: TaskDetail `t` (open trace), ReviewPage `j/k/a/r` (queue ops), CommandView `o` (open detail for focus)
- `Esc` is the universal "dismiss alert" — re-uses existing per-route handlers
- `isTextTarget` guard lifted from CommandView L662-671 into a shared `hotkeys.ts` util
- New file `docs/HOTKEYS.md` is the developer-facing cheat sheet (living doc); discoverability footer link in `docs/COMMAND-CENTER-CONTRACT.md`

**Rejected alternatives:**

- Single Ctrl+<letter> scheme — browser shortcut collision
- Per-route only — fails "jump to review queue" cleanliness
- Configurable / user-remappable — future research

---

## D-02: Multi-select bulk-inspect — Recommended option locked

**Recommendation:** Three named actions in a bottom-right `SelectionActions` popover; cap tabs at 10; all actions read-only.

**Rationale presented to user (implicit in recommendation):**

- The three actions named in REQUIREMENTS.md WB-02 spec ("open all selected detail views in tabs", "copy IDs", "scroll to first failure") are exactly the v0.2 scope.
- Corner-pinned popover (vs centroid-anchored) is simpler, doesn't fight with marquee feedback, and matches the existing `TaskActionMenu.tsx` precedent.
- 10-tab cap prevents pop-up-blocker storms while staying useful for the homelab-scale demand.
- Bulk-mutate stays forbidden per REQUIREMENTS.md §3 lock.

**Resolution:**

- New `packages/workbench-ui/src/command/SelectionActions.tsx` component
- Mount inside CommandView alongside existing overlays
- Trigger when `selection.keys.size >= 2`
- Bottom-right corner position
- Three stacked buttons: "Open N in tabs" / "Copy N IDs" / "Scroll to first failure"
- "Open all in tabs" caps at 10; for Agent keys, requires extending TaskList with `?targetAgent=<name>` query-param filter (small additive change; planner picks)
- "Copy IDs" graceful clipboard-permission-denied fallback with inline textarea
- "Scroll to first failure" reuses existing `easeCameraTo`; defines failure per-kind (Task: phase=Failed; Agent: failureCount>0; Gateway: inflight>=capacity)
- Source-binding: presentation-only over already-source-bound data; no new `SourceFieldName` enum members
- `sound.click()` on every button + every action

**Rejected alternatives:**

- Selection-centroid anchor — fights with marquee
- Bulk-mutate actions — locked off by REQUIREMENTS.md §3
- Sortable / customizable popover — over-design

---

## D-03: Replay-from-context — Recommended option locked

**Recommendation:** Annotation-only; switch `targetAgent` only (no per-task modelClass override); TaskDetail button entry point; new `task.replay.created` audit event.

**Rationale presented to user (implicit in recommendation):**

- Adding per-task `modelClass` / `model` fields to `AgentTaskSpec` would require a CRD schema change — deferred to future research per D2 ("Defer CRDs until repeated behavior justifies one"; spec-additions are treated the same in v0.2).
- "Different model class" from the WB-03 spec text is delivered by switching to a different Agent that has that modelClass — Agents already carry `modelClass` at the AgentSpec level.
- Annotation-only write path matches Phase 4's pattern (lightest substrate primitive).
- TaskDetail button is the primary surface; Command Center right-click is deferred to a follow-up to keep v0.2 scope contained.
- New audit-event type rides the existing publisher additively per Phase 4.

**Resolution:**

- 5 annotations on the NEW AgentTask: `replay-of` / `replay-of-uid` / `replay-reason` / `replay-decided-by` / `replay-decided-at` (all under `kagent.knuteson.io/*` prefix)
- Operator changes `targetAgent` ONLY
- Fields copied verbatim from original: payload, originalUserMessage, runConfig.timeoutSeconds, runConfig.maxIterations, expectedTools, user labels
- Fields NOT copied: metadata.name (regenerated `replay-${nanoid8}`), parentTask, parentDistillation, inputs[], idempotencyKey, operator-managed annotations
- Entry point: TaskDetail "Replay" button → new `ReplayModal.tsx`
- POST `/api/tasks` extended with optional `replayOf?: { taskRef, reason? }` body field
- Server-side 5-step handler: validate → SnapshotCache resolve → UID cross-check → createNamespacedCustomObject → audit
- New audit event `task.replay.created` in `@kagent/audit-events`
- No new RBAC verbs needed (existing `agenttasks: [create]` covers it)
- No new CRD schema change

**Rejected alternatives:**

- Per-task `modelClass` override on AgentTaskSpec — future research per D2
- Replay creates AgentWorkflow — future research
- Replay button on every entry point (TaskList row, CommandView right-click, ReviewPage row) — defer; ship TaskDetail button only
- `replay-decided-by` optional — Phase 5 makes it REQUIRED (stricter than Phase 4's `review-decided-by`) because cross-task lineage matters more for replay

---

## D-04: RTS-feel-as-usability + COMMAND-CENTER-CONTRACT — Recommended option locked

**Recommendation:** Sound on every new hotkey/action via existing `sound.{click,taskComplete,taskFailed}` library. FX kept minimal & substrate-bound. No painted chrome, no new sound packs, no new visual themes. All new UI surfaces honor COMMAND-CENTER-CONTRACT Prime Directive.

**Rationale presented to user (implicit in recommendation):**

- Memory rule `feedback_workbench_rts_ui_aesthetic.md` — "RTS feel = usability primitives (hotkeys, multi-select, dispatch, replay, audit-trace shortcut, FX), NOT visual reskins."
- D7 — `docs/COMMAND-CENTER-CONTRACT.md` is binding for Workbench/Command Center work.
- Reusing the existing sound engine + camera-ease + FxLayer means zero new code in those modules.
- Silent failure on chord-timeout / no-trace-found avoids alert fatigue.

**Resolution:**

- Sound table (locked):
  - `g <letter>` success → `sound.click()`
  - `g <letter>` timeout → silent
  - `?` opens cheat sheet → `sound.click()`
  - TaskDetail `t` with trace → `sound.click()`; without trace → silent + toast
  - ReviewPage j/k/a/r → `sound.click()`
  - CommandView `o` on task → `sound.click()`; on agent → silent + toast (no AgentDetail in v0.2)
  - SelectionActions buttons → `sound.click()`
  - ReplayModal submit 201 → `sound.taskComplete()`; 4xx/5xx → `sound.taskFailed()`
- FX: reuse existing `easeCameraTo` only; no new FX types; ReplayModal MAY optionally trigger `useReplay.start()` ghost-sprite animation on success (cheap delight, not required)
- COMMAND-CENTER-CONTRACT: SelectionActions and `o`-key handler are presentation-only over already-source-bound data; non-CommandView surfaces (HotkeyCheatSheet, ReplayModal, global hotkeys, TaskDetail t, ReviewPage j/k/a/r) honor the Prime Directive's data-only application
- NOT shipped: new sound packs, new FX types, painted chrome, sprite-skinned GUI, new visual themes, MissionOverlay extension, new flow gauges or pressure types

**Rejected alternatives:**

- New sound pack for Phase 5 actions — over-design
- New FX types — over-design
- Sprite-skinned cheat sheet ("tutorial popup with NPC dialogue") — violates memory rule
- Mission overlay extension — Phase 1's MissionOverlay grammar stays unchanged

---

## Claude's Discretion (unlocked — planner picks)

Documented in CONTEXT.md `<decisions>` Claude's Discretion section. Items the planner decides:

- Wave shape (3–4 plans likely; planner picks)
- Wave 0 scaffolding scope (fixtures, RBAC, DTO scaffolding)
- Where `useAlert` hook lives (shared util vs inline)
- Whether `<SelectionActions>` is always-mounted or conditionally rendered
- Whether `cc-reload.test.tsx.snap` needs a regen for the new mount
- Whether the ReplayModal's "advanced" section ships in v0.2
- Whether to add a "Replayed by N" badge to TaskDetail
- Whether `TaskList`'s `?targetAgent=<name>` filter ships in v0.2 (default: yes, small additive)
- HotkeyCheatSheet styling: match `NewTaskModal` vs slightly more compact two-column

---

## Deferred Ideas

Captured in CONTEXT.md `<deferred>` section. Highlights:

- Command Center right-click → "Replay last task"
- Per-task `modelClass` override on AgentTaskSpec (future research per D2)
- Hotkey customization / user-defined remapping
- App-wide notification center / global toast bus
- Mobile / touch / accessibility audit of hotkey scheme
- Bulk-mutate actions on multi-select (locked off by REQUIREMENTS.md §3)
- Replay button on every entry point
- `AgentWorkflow` replay
- Replay-divergence detection (Phase 5+ design per `docs/REPLAY-EVALS.md`)
- AgentDetail page (Phase 6+ item)
- Persistent hotkey-usage telemetry
- Replay-modal "Advanced" section (default: defer minimal modal)
- `?targetAgent=<name>` filter on TaskList — required dep for "Open all in tabs" Agent case (default: ship)

---

## Scope Creep Watch

None caught during this discussion. The "use 'recommended' options" pre-authorization is interpreted strictly as scope-preserving — all 3 candidate requirements (WB-01, WB-02, WB-03) stay in this phase; nothing more, nothing less.

---

_Phase: 05-workbench-usability-primitives_
_Discussion: 2026-05-10 via discuss-phase, pre-authorized recommended options_
