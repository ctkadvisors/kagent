# Phase 5: Workbench usability primitives — Context

**Gathered:** 2026-05-10
**Status:** Ready for planning
**Mode:** discuss-phase, "use 'recommended' options going forward" — Claude proposed 4 gray areas (hotkey scope & grammar, multi-select bulk-inspect actions, replay-from-context axes & annotation, RTS-feel-as-usability + COMMAND-CENTER-CONTRACT compliance); user pre-authorized recommended option in each. The user has authority to override any decision below before/during planning.

> **Critical framing.** Phase 5 ADDS three Workbench usability primitives — an app-wide hotkey scheme, multi-select bulk-inspect actions on Command Center sprites, and a replay-from-context surface — under the **memory rule** that "Workbench RTS feel = USABILITY, not visual chrome" (`feedback_workbench_rts_ui_aesthetic.md`). **No new CRDs (D2). No new AgentTaskSpec fields. No new persistence.** WB-01 hotkeys map to existing routes and existing actions (no new substrate state). WB-02 multi-select stays read-only — bulk-mutate is locked off by REQUIREMENTS.md §3. WB-03 replay-from-context creates a NEW AgentTask via the existing POST `/api/tasks` write path, carrying a `kagent.knuteson.io/replay-of` annotation pointing to the original task; the lightest substrate primitive per Phase 4's pattern. Phase 5 is presentation + annotation work over the v0.1 substrate plus the Phase 1–4 read surfaces; it is NOT a new substrate primitive.

<domain>
## Phase Boundary

**In scope (Phase 5 delivers):**

1. **WB-01 — App-wide hotkey scheme + per-route context hotkeys + unified cheat sheet.**
   - Global window-level keyboard handler (mounted at `App.tsx` level) implementing a vim-style `g <route>` navigation namespace:
     - `g t` → `#/` (tasks list)
     - `g g` → `#/gateway`
     - `g c` → `#/command` (Command Center)
     - `g k` → `#/cluster`
     - `g r` → `#/review` (Phase 4's reviewer entry point)
   - Unified hotkey cheat sheet overlay accessible via `?` from ANY route. New file `packages/workbench-ui/src/HotkeyCheatSheet.tsx` (top-level — mirrors `App.tsx`'s residence). CommandView's existing in-canvas `?` hint overlay remains, but the App-level cheat sheet is a strict superset (renders both "Global navigation" + "Inside Command Center" + "Inside Task Detail" + "Inside Review Queue" sections).
   - Per-route context hotkeys:
     - **TaskDetail (`#/tasks/:ns/:name`):** `t` → open `traceLink.url` in a new tab (when present); `Esc` → back to list (already wired via existing onBack).
     - **ReviewPage (`#/review`):** `j` / `k` → next / previous queue row; `a` / `r` → accept / reject the focused row (delegates to existing `ReviewActions` flow with confirm); `Esc` → defocus row.
     - **CommandView (`#/command`):** existing RTS grammar untouched (WASD/Tab/Esc/N/M/?/F5–F8/Ctrl+1..9). NEW: `o` → open detail for current focus (TaskDetail for a task focus, no-op + click sound for an Agent focus until Phase 6+ AgentDetail lands; document the limitation in the cheat sheet).
   - **`isTextTarget` guard** (already in CommandView at L662–671) lifted into a shared helper `packages/workbench-ui/src/hotkeys.ts` so every keydown handler ignores keystrokes when an input/textarea/select/contenteditable target has focus. App-level global handler MUST use it.
   - **No global SHIFT/CTRL/META modifiers required for navigation hotkeys** — `g <letter>` is the vim-style chord. Two-key timeout: 1500ms (after `g` is pressed, the next key has 1500ms to fire the navigation; otherwise the `g` is forgotten silently — no toast/alert).
   - **Dismiss-alert** semantics (from WB-01 spec text): re-uses existing `Esc` handlers. CommandView's `Esc` already clears selection / cancels popover. TaskDetail / ReviewPage `Esc` returns to list. No new key.
   - **Open-trace** semantics (from WB-01 spec text): TaskDetail's `t` opens `traceLink.url` if present; otherwise plays `sound.click()` + sets a transient toast "no trace for this task" via the existing `alertText` pattern (lifted into a shared `useAlert` hook).
   - **Jump-to-review-queue** semantics: `g r` from any route.
   - **Developer-facing cheat sheet** documented in `docs/HOTKEYS.md` (new file). Living doc updated as keys evolve. Add a discoverability footer link in `docs/COMMAND-CENTER-CONTRACT.md` pointing at `docs/HOTKEYS.md` (single-line link, NOT a contract revision — same pattern as Phase 3's `docs/FLOW-LEGEND.md` discoverability footer).

2. **WB-02 — Multi-select bulk-inspect actions on Command Center sprites.**
   - **Trigger condition:** Command Center selection contains ≥ 2 keys (i.e., `selection.keys.size >= 2`). Multi-select is already supported by CommandView's marquee + Shift+click + Ctrl+1..9 control-group recall (L405/L990/L1018 patterns). NEW: a `SelectionActions` popover renders when this trigger fires.
   - **Three bulk-inspect actions ship in v0.2 (named in REQUIREMENTS.md WB-02 spec):**
     - **"Open all in tabs"** — opens at most 10 browser tabs (cap to prevent pop-up-blocker storms). For each selected key:
       - Task selection → `window.open(#/tasks/<ns>/<name>, '_blank')`.
       - Agent selection → `window.open(#/?targetAgent=<name>, '_blank')` — the existing TaskList page is filterable today via its existing route shape; if no `?targetAgent=` query param exists yet, planner picks the cleanest path (either extend TaskList with a query-param filter — a few lines — OR defer agent-filter for follow-up and use `#/`). RECOMMENDED: extend TaskList with `?targetAgent=<name>` query-param filter as a small additive change.
       - Gateway selection → `window.open(#/gateway, '_blank')`.
       - If `selection.keys.size > 10`: open the first 10 and emit a transient toast "opened first 10 of N selected".
     - **"Copy IDs to clipboard"** — newline-joined `<namespace>/<name>` strings for all selected keys; calls `navigator.clipboard.writeText(...)`. On success, emit toast "copied N IDs to clipboard". On failure (no clipboard permission), emit toast "clipboard unavailable — paste manually:" and put the IDs in an inline `<textarea>` for manual selection (graceful degradation; existing `alertText` is too short — extend the popover to host the fallback textarea inline).
     - **"Scroll to first failure"** — pans the CommandView camera (via existing `easeCameraTo` helper) to the screen-space position of the first selected sprite whose backing summary indicates failure:
       - Task → `phase === 'Failed'`.
       - Agent → existing `AgentSummaryRow.failureCount > 0`.
       - Gateway → existing `GatewayCapacityRow.usage.inflight >= capacity` (gateway saturation, from Phase 2's CC-04 pressure overlay source field).
       - If no selected sprite matches: emit toast "no failures in selection", no camera change.
   - **UI surface:** new `packages/workbench-ui/src/command/SelectionActions.tsx` component, mounted inside `CommandView.tsx` as a fixed-position popover anchored to the **bottom-right corner of the canvas wrapper** (not anchored to the selection centroid — corner-pinned is simpler, doesn't fight with marquee feedback, and matches the existing `TaskActionMenu.tsx` precedent). Three buttons stacked vertically; each button shows the action label + selection count (e.g., "Copy 3 IDs"); clicking fires the action.
   - **Bulk-mutate stays forbidden** per REQUIREMENTS.md §3 lock: "Bulk-mutate actions remain forbidden until the underlying CRD write path explicitly supports the operation." The popover ships ONLY the three read-only actions above; no bulk-accept / bulk-reject / bulk-replay / bulk-dispatch / bulk-anything-write.
   - **Source-binding posture:** `SelectionActions.tsx` is presentation-only over already-source-bound canvas state — no new `data-source-field` attributes required (the underlying `AgentSummaryRow` / `TaskSummary` / `GatewayCapacityRow` are source-bound at their canvas-render sites; the popover just iterates over `selection.keys` and looks up data from `snapshot`). `cc-orphan` assertion at L72-76 in CommandView already covers the underlying render paths. No new `SourceFieldName` enum members needed.

3. **WB-03 — Replay-from-context: re-dispatch a task under a different agent via annotation.**
   - **Operator-changeable axes:** `targetAgent` ONLY. Per-task `modelClass` override is OUT OF SCOPE (would require AgentTaskSpec schema change; deferred to future research per D2). "Different model class" from the WB-03 spec text is delivered by switching to a different Agent that has the desired modelClass — Agents already carry `modelClass` at the AgentSpec level (`packages/operator/src/crds/types.ts:82-95`).
   - **`replayOf` annotation contract on the NEW AgentTask:**
     - `kagent.knuteson.io/replay-of: "<original-namespace>/<original-name>"` — primary link.
     - `kagent.knuteson.io/replay-of-uid: "<original-uid>"` — UID anchor (survives rename of the original; mirrors Phase 4's `promoted-from-task` annotation pair-pattern at `template-instantiator.ts:annotation conventions`).
     - `kagent.knuteson.io/replay-reason: "<≤256 chars>"` — optional operator note (free-text; HTML-escaped on display).
     - `kagent.knuteson.io/replay-decided-by: "<X-Forwarded-User>"` — reviewer identity (matches Phase 4's `review-decided-by` pattern; H17 acknowledges `X-Forwarded-User` is spoofable in v0.2).
     - `kagent.knuteson.io/replay-decided-at: "<ISO-8601 timestamp>"` — server-side wall-clock at creation.
   - **Fields copied verbatim from the original AgentTask → new AgentTask:**
     - `spec.payload` (substrate-opaque; copied byte-for-byte).
     - `spec.originalUserMessage` (per HARNESS-LESSONS §4: required for delegation chains; replays inherit the same constraint).
     - `spec.runConfig.timeoutSeconds` (when present; operator can override in the modal).
     - `spec.runConfig.maxIterations` (when present; operator can override).
     - `spec.expectedTools` (when present; copied — same tool category set unless operator explicitly clears).
   - **Fields NOT copied (intentionally regenerated):**
     - `metadata.name` — new task gets `replay-${nanoid8}` per the existing `manual-${nanoid8}` pattern in `routes/tasks.ts`.
     - `metadata.namespace` — defaults to workbench-api's release namespace (operator can pick another in the modal if the chart's release-namespace scope permits, same as `POST /api/tasks` today).
     - `spec.targetAgent` — operator picks from `/api/agents` catalog in the modal (default = original's `targetAgent`, but the modal's dropdown is the primary affordance to change).
     - `spec.parentTask`, `spec.parentDistillation`, `spec.inputs[]`, `spec.idempotencyKey` — NOT carried. A replay is a fresh top-level task, not a child task; carrying `parentTask` would create a misleading delegation edge. `idempotencyKey` is intentionally regenerated so the replay actually runs (the original may have been deduped).
   - **Entry points (v0.2 ships ONE; right-click is future research):**
     - **TaskDetail "Replay" button (primary)** — new file `packages/workbench-ui/src/ReplayModal.tsx` (top-level, mirrors `NewTaskModal.tsx` shape). Mounted from TaskDetail next to ReviewActions. Trigger conditions: ANY task (replay is not restricted to failed tasks — operators may replay a passing task under a different agent to A/B). Modal fields:
       - **Target Agent** — dropdown from `/api/agents` (pre-selected to original's `targetAgent`; operator changes to A/B against a different agent).
       - **Reason** — optional textarea (≤256 chars; HTML-escaped server-side and on display).
       - **Original message (read-only preview)** — collapsible `<details>` showing `spec.originalUserMessage` so operator confirms what's being replayed.
       - Submit → calls existing `createTask()` with the body shape below.
     - **Command Center right-click → "Replay last task"** — DEFERRED to a follow-up phase. v0.2 ships TaskDetail button only. (Document this in CONTEXT.md `<deferred>` so the planner doesn't accidentally include it.)
   - **POST `/api/tasks` request body extension:**
     - New optional field on `CreateTaskRequest` (`packages/workbench-api/src/types-write.ts`):
       ```ts
       readonly replayOf?: {
         readonly taskRef: {
           readonly namespace: string;
           readonly name: string;
           readonly uid?: string;
         };
         readonly reason?: string; // ≤256 chars, server-side validated
       };
       ```
     - When `replayOf` is present, the server-side handler:
       1. Validates the reference: looks up `SnapshotCache.tasks` for `${namespace}/${name}` — fail-fast 422 if not found (avoid falling through to K8s and getting a confusing 404).
       2. Materializes the 5 annotations listed above on the new AgentTask.
       3. Emits a new audit event `task.replay.created` with `data: { newTaskRef, originalTaskRef, reason? }`.
       4. Falls through to the existing `customApi.createNamespacedCustomObject` write path — same RBAC posture as a regular `POST /api/tasks`. **No new RBAC verbs needed** (the existing `agenttasks: [create]` covers it).
   - **Audit event posture:** new event-type literal `task.replay.created` added to `@kagent/audit-events`. Mirrors Phase 4's pattern of additive type extensions (`packages/audit-events/src/event-types.ts` + `types.ts` + `make-event.ts`). Comment block in `event-types.ts` already mandates "every const here MUST have a corresponding member in `AuditEventType` and `AuditEventData` discriminated union" — additive only.
   - **Source-binding posture:** the new modal renders existing `TaskDetail` data — no new source-binding fields. The ReplayModal's "Original message" preview is read-only data already source-bound via the existing TaskDetail render path.
   - **Validation rules (server-side, in a new `validateReplayOf` helper alongside the existing `validateCreateTaskBody`):**
     - `replayOf.taskRef.namespace` + `name` — both required when `replayOf` is present, both RFC1123 label shape.
     - `replayOf.reason` — optional; if present, ≤256 chars, no HTML / no newlines (single line; UI shows in a small badge).
     - `replayOf.taskRef.uid` — optional; if present, used for SnapshotCache lookup as a secondary check (fail-fast 422 if `taskRef.namespace/name` resolves to a different UID, signaling the original was renamed or recreated).

**Out of scope for Phase 5 (locked exclusions):**

- Any new CRD or CRD schema change (per D2). `AgentTaskSpec` is unchanged — only annotations are added.
- Per-task `modelClass` / `model` override at the AgentTask level. Future research per D2; the WB-03 "different model class" requirement is delivered by switching to a different Agent that has that class.
- Bulk-mutate actions on multi-select. Locked off by REQUIREMENTS.md §3 (`COMMAND-CENTER-CONTRACT.md` §9 + Phase 4's REV-02 single-row write posture inherited).
- Command Center right-click → "Replay last task". Deferred to a follow-up phase. v0.2 ships TaskDetail button only.
- App-wide notification center / toast bus. Each route's existing transient alert pattern (CommandView's `alertText`, modal-local error states) is reused; a unified `useAlert` hook MAY be lifted into a shared util if multiple routes need it for the new hotkey-feedback paths, but a global toast bus is NOT in scope.
- Hotkey customization / user-defined remapping. Hotkeys are hard-coded in v0.2; a config-driven remapper is future research.
- Hotkey scheme that varies by operator role / RBAC. v0.2 ships ONE hotkey scheme for all operators.
- Touch / mobile / accessibility audit of the hotkey scheme. v0.2 is desktop-first (matching the Command Center's posture); accessibility hardening is future work.
- Bulk-export of multi-select selection (e.g., download as CSV/JSON). Copy-to-clipboard covers the v0.2 demand.
- SSE-driven invalidation of the replay modal's `/api/agents` dropdown. v0.2 fetches once on mount; promote when the catalog churn justifies it.
- Agent-side write of the `replay-of` annotation (i.e., agents replaying themselves). Off the table per D6 — agents propose, operators promote. Replay-from-context is operator-only.
- Per-task `replayOf` chain navigation UI (e.g., "this task was replayed by X, which was replayed by Y"). v0.2 ships the annotation only; surfacing the chain on TaskDetail is small follow-up work — the planner MAY include it if cheap, but it's not required for WB-03 acceptance.
- Painted / sprite-skinned chrome of any kind. Memory rule `feedback_workbench_rts_ui_aesthetic.md` — RTS feel = USABILITY, not visual chrome. No new backgrounds, no new sprite skins, no new visual themes.
- New sound packs. Reuse `sound.{click, dispatch, agentReady, taskComplete, taskFailed, klaxon}` from `packages/workbench-ui/src/command/sound.ts`. No new sound files, no new mixing layers.
- New FX types. Reuse existing `FxLayer` events from `packages/workbench-ui/src/command/fx.ts`. No new FX, no new particle types.
- Mission overlay extension. Phase 1's `MissionOverlay` grammar stays unchanged.
- New flow gauges or pressure types. Phase 2's `PressureOverlay` and Phase 3's `FlowOverlay` are not touched.

</domain>

<decisions>

## Implementation Decisions (locked for this phase, all "recommended" — user has authority to override)

### D-01: Hotkey scheme — global vim-style `g <route>` navigation + per-route context hotkeys + unified `?` cheat sheet

**Locked option:** Mixed scheme — global navigation hotkeys (`g t/g/c/k/r`) + per-route context hotkeys + App-level `?` cheat sheet superset of CommandView's `?` overlay.

#### App-level global handler (mounted at `App.tsx`)

- New file `packages/workbench-ui/src/hotkeys.ts` exporting:
  - `isTextTarget(target: EventTarget | null): boolean` — lifted from CommandView L662–671.
  - `useGlobalHotkeys(): void` — React hook that registers a single window-level `keydown` listener; handles the `g <route>` chord with a 1500ms timeout.
  - `HOTKEY_CHEAT_SHEET: readonly HotkeyEntry[]` — exported const array of `{ key, modifier?, scope, description }` entries that `HotkeyCheatSheet.tsx` renders.
- The `g` chord:
  - First press of `g` (without modifier) starts a 1500ms timer.
  - Within 1500ms, a follow-up keypress dispatches to the matching route:
    - `t` → `window.location.hash = '#/'`
    - `g` → `window.location.hash = '#/gateway'`
    - `c` → `window.location.hash = '#/command'`
    - `k` → `window.location.hash = '#/cluster'`
    - `r` → `window.location.hash = '#/review'`
  - Timer expires silently (no toast, no alert) if no follow-up key in 1500ms. Pressing `Esc` between `g` and the follow-up cancels the chord.
  - `sound.click()` fires on a successful navigation; no sound on chord-timeout (silent failure to avoid alert fatigue).
- `?` (no modifier) opens the cheat sheet overlay from ANY route. Inside CommandView, `?` continues to toggle the existing in-canvas hint overlay (CommandView's local handler runs first; the App-level handler checks `isTextTarget` AND a "is CommandView's local hint open" flag exposed via a shared module-level signal — simpler alternative: the App-level `?` handler short-circuits when `location.hash === '#/command'` since CommandView owns `?` there). RECOMMENDED: App-level `?` handler short-circuits when `location.hash === '#/command'`; CommandView's existing `?` continues to own that route's hint UX.

#### Per-route context hotkeys

- **TaskDetail (`#/tasks/:ns/:name`):**
  - `t` → opens `detail.traceLink.url` in a new tab (when present); otherwise toast "no trace for this task" via the lifted `useAlert` hook.
  - Existing `Esc` → back to list (already wired via `onBack`).
- **ReviewPage (`#/review`):**
  - `j` / `k` → next / previous queue row (focus moves; the focused row gets a `.focused` CSS class).
  - `a` → accept focused row (opens existing accept-confirm flow).
  - `r` → reject focused row (opens existing reject-confirm flow).
  - `Esc` → defocus row (sets focus to null).
- **CommandView (`#/command`):**
  - Existing RTS grammar untouched.
  - NEW: `o` → open detail for current focus (`selection.focus.kind === 'task'` → `window.location.hash = '#/tasks/<ns>/<name>'`; `selection.focus.kind === 'agent'` → `sound.click()` + toast "no Agent detail page in v0.2" — document the limitation in the cheat sheet; `selection.focus.kind === 'gateway'` → `window.location.hash = '#/gateway'`).

#### Cheat sheet (`HotkeyCheatSheet.tsx`)

- New top-level file `packages/workbench-ui/src/HotkeyCheatSheet.tsx`.
- Renders a modal overlay (mirroring `NewTaskModal.tsx` shape — backdrop, card, Esc-to-close).
- Sections: "Global navigation", "Inside Command Center", "Inside Task Detail", "Inside Review Queue".
- Reads `HOTKEY_CHEAT_SHEET` from `hotkeys.ts`; renders one `<kbd>` per entry.
- Mounted from `App.tsx` controlled by a `[cheatSheetOpen, setCheatSheetOpen]` state, set by the global `?` handler.

#### Developer-facing cheat sheet (`docs/HOTKEYS.md`)

- New file. Lists every hotkey, scope, and action.
- Living doc. Updated whenever a hotkey is added/removed.
- Discoverability footer link added to `docs/COMMAND-CENTER-CONTRACT.md` (single-line link, NOT a contract revision — same pattern as Phase 3's `FLOW-LEGEND.md` link).

#### Rejected alternatives

- "Single global ctrl+<letter> scheme" — collides with browser shortcuts (Ctrl+T = new tab, Ctrl+R = reload). Vim-style `g <letter>` namespace avoids the collision entirely.
- "Per-route only, no global" — fails the WB-01 spec "jump to review queue" requirement (a global hotkey IS the cleanest path from `#/tasks` to `#/review`).
- "Configurable / user-remappable hotkeys" — deferred to future research; v0.2 ships hard-coded scheme.

### D-02: Multi-select bulk-inspect — 3 named actions in a bottom-right `SelectionActions` popover; cap tabs at 10

**Locked option:** Three named actions ("Open all in tabs", "Copy IDs", "Scroll to first failure") rendered in a corner-pinned popover that mounts inside CommandView when `selection.keys.size >= 2`. All actions read-only.

#### `SelectionActions.tsx` shape

- New file `packages/workbench-ui/src/command/SelectionActions.tsx`.
- Props: `{ selection: SelectionState; snapshot: CommandSnapshot; layout: LayoutResult | null; cameraRef: MutableRefObject<Camera>; wrapperRef: RefObject<HTMLDivElement> }`.
- Renders a fixed-position popover anchored to `.canvas-wrapper`'s bottom-right corner (CSS: `position: absolute; bottom: 12px; right: 12px;`).
- Three buttons stacked vertically:
  - "Open N in tabs" (where N = `Math.min(selection.keys.size, 10)`).
  - "Copy N IDs".
  - "Scroll to first failure".
- Each button: `onClick` fires `sound.click()` + the action handler.
- Mount site: inside `CommandView.tsx`, alongside the existing `<Minimap />` / `<DispositionOverlay />` / `<FlowOverlay />` / `<PressureOverlay />`. The mount-site precedent is Phase 1–3's overlay-component pattern.

#### Action handlers

- **"Open all in tabs"** — iterate over `selection.keys` (capped at 10); for each key:
  - Resolve the key to its kind via the existing `layout.agents` / `snapshot.tasks` / gateway lookup pattern.
  - `window.open(<hash>, '_blank')` with the per-kind hash route.
  - For Agent keys: `#/?targetAgent=<name>` — REQUIRES TaskList to grow a `?targetAgent=<name>` query-param filter (small additive change in `TaskList.tsx` — read the query param, filter the rendered rows; default = no filter when param absent). The planner picks the cleanest implementation.
  - If `selection.keys.size > 10`: open first 10, fire `sound.click()`, toast "opened first 10 of N selected" via the lifted `useAlert` hook.
- **"Copy IDs"** — `navigator.clipboard.writeText(ids.join('\n'))` where `ids = selection.keys.toArray()`. On promise resolve: toast "copied N IDs". On promise reject (no permission): toast "clipboard unavailable — paste manually:" and reveal an inline `<textarea readonly>` populated with the IDs so the operator can select/copy by hand.
- **"Scroll to first failure"** — iterate selection in selection-order:
  - Task key → first `phase === 'Failed'` (per `TaskSummary.phase`).
  - Agent key → first agent with `failureCount > 0` (per existing `AgentSummaryRow.failureCount`).
  - Gateway key → first gateway with `usage.inflight >= capacity` (per Phase 2's `GatewayCapacityRow` + CC-04 pressure source field).
  - If a match is found: call `easeCameraTo(cameraRef.current, layout.<kind>.get(key).x, layout.<kind>.get(key).y, wrapperRect)` — uses the existing camera-ease helper from `command/camera.ts`. Fire `sound.click()`.
  - If no match: toast "no failures in selection", no camera change.

#### Source-binding posture

- `SelectionActions.tsx` is presentation-only over already-source-bound data. NO new `data-source-field` attributes required.
- The existing `cc-orphan` assertion at `CommandView.tsx:72-76` already covers the underlying render paths for `AgentSummaryRow` / `TaskSummary` / `GatewayCapacityRow`. The popover's button-label text (e.g., "Open 3 in tabs") doesn't render substrate data — only count.
- NO new `SourceFieldName` enum members in `source-binding.ts`.

#### Rejected alternatives

- "Popover anchored to selection centroid" — fights with marquee feedback; corner-pinned is simpler.
- "Bulk-mutate actions (bulk-accept / bulk-reject / bulk-replay / bulk-dispatch)" — locked off by REQUIREMENTS.md §3. v0.2 read-only multi-select stays read-only.
- "Sortable action list / customizable popover" — over-design for v0.2. Three actions, hard-coded order.

### D-03: Replay-from-context — annotation-only (`kagent.knuteson.io/replay-of`); `targetAgent` change; TaskDetail button; new audit event

**Locked option:** No CRD schema change. New AgentTask carries `replay-of` + `replay-of-uid` + `replay-reason` + `replay-decided-by` + `replay-decided-at` annotations. Operator changes `targetAgent` only (per-task modelClass override is deferred). Entry point: TaskDetail "Replay" button → `ReplayModal.tsx`. New audit event `task.replay.created`.

#### Annotation contract (on the NEW AgentTask)

| Key                                    | Value shape                       | Required | Source                                               |
| -------------------------------------- | --------------------------------- | -------- | ---------------------------------------------------- |
| `kagent.knuteson.io/replay-of`         | `"<original-ns>/<original-name>"` | yes      | computed server-side from `req.replayOf.taskRef`     |
| `kagent.knuteson.io/replay-of-uid`     | `"<original-uid>"`                | yes      | resolved server-side via SnapshotCache lookup        |
| `kagent.knuteson.io/replay-reason`     | `"<≤256 chars>"`                  | no       | `req.replayOf.reason` (validated, HTML-escaped)      |
| `kagent.knuteson.io/replay-decided-by` | `"<X-Forwarded-User>"`            | yes      | request header (matches Phase 4 reviewer-id pattern) |
| `kagent.knuteson.io/replay-decided-at` | `"<ISO-8601 UTC>"`                | yes      | server-side wall-clock                               |

All five annotations live on `metadata.annotations` of the new AgentTask. None on the original — the original AgentTask is read-only from Phase 5's perspective (no patch). Same lightest-substrate-primitive posture as Phase 4 (annotation-driven write).

#### Field-copy contract (original → new AgentTask)

| Field                                      | Copied?                      | Notes                                                                              |
| ------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------- |
| `spec.payload`                             | yes                          | byte-for-byte (substrate-opaque)                                                   |
| `spec.originalUserMessage`                 | yes                          | per HARNESS-LESSONS §4                                                             |
| `spec.runConfig.timeoutSeconds`            | yes                          | operator can override in modal                                                     |
| `spec.runConfig.maxIterations`             | yes                          | operator can override in modal                                                     |
| `spec.expectedTools`                       | yes                          | operator can clear (advanced)                                                      |
| `spec.targetAgent`                         | NO                           | operator picks from `/api/agents` dropdown                                         |
| `spec.targetCapability`                    | NO                           | replay surface is agent-targeted only in v0.2                                      |
| `spec.parentTask`                          | NO                           | replay is a fresh top-level task                                                   |
| `spec.parentDistillation`                  | NO                           | implied by no `parentTask`                                                         |
| `spec.inputs[]`                            | NO                           | replay re-runs from the original prompt; downstream input bindings regenerate      |
| `spec.idempotencyKey`                      | NO                           | regenerated so the replay actually runs (original may have been deduped)           |
| `spec.verifyContract`                      | NO                           | inherited from target Agent at admission time (per existing path)                  |
| `metadata.name`                            | NO                           | new name: `replay-${nanoid8}` (per existing `manual-${nanoid8}` pattern)           |
| `metadata.namespace`                       | NO                           | default = release namespace; operator can pick in modal (existing pattern)         |
| `metadata.labels` (`kagent.knuteson.io/*`) | NO                           | operator-managed labels — protected by validator                                   |
| `metadata.labels` (user labels)            | yes                          | copied verbatim; operator can edit in advanced modal section (default hidden)      |
| `metadata.annotations`                     | NO (except for replay-of-\*) | a fresh annotation set; the 5 replay-\* annotations are the only ones materialized |

#### Server-side handler shape

- Extend `validateCreateTaskBody` in `packages/workbench-api/src/routes/validators.ts`:
  - When `body.replayOf` is present:
    - Validate `replayOf.taskRef.namespace` + `replayOf.taskRef.name` (both RFC1123 label shape).
    - Validate `replayOf.reason` (≤256 chars; no newlines; HTML-stripped).
    - Validate `replayOf.taskRef.uid` if present (matches `<8>-<4>-<4>-<4>-<12>` UUID shape).
- Extend the POST `/api/tasks` handler in `packages/workbench-api/src/routes/tasks.ts`:
  - When `req.replayOf` is present:
    - **Step 1 (resolve):** `SnapshotCache.tasks.get('${replayOf.taskRef.namespace}/${replayOf.taskRef.name}')` — if absent, respond 422 with `{ error: 'replayOf.taskRef not found in SnapshotCache', fields: [...] }`.
    - **Step 2 (uid cross-check):** if `replayOf.taskRef.uid` is present AND `resolved.metadata.uid !== replayOf.taskRef.uid` — respond 422 with `{ error: 'replayOf.taskRef UID mismatch — original task may have been renamed or recreated', fields: [...] }`.
    - **Step 3 (build annotations):** materialize the 5 `replay-*` annotations.
    - **Step 4 (call existing customApi.createNamespacedCustomObject):** with the synthesized AgentTask body (copied fields + replay-\* annotations + operator-supplied `targetAgent` + payload).
    - **Step 5 (audit):** emit `task.replay.created` audit event via the existing audit publisher.
- Annotation collision posture: the 5 `replay-*` annotations live in the `kagent.knuteson.io/*` reserved namespace; the existing label-validator rejects operator-supplied keys in this prefix (already in place from `POST /api/tasks` today) — replay's server-side handler is the ONLY writer of these annotations.

#### Audit event `task.replay.created`

- New event-type literal added to `packages/audit-events/src/event-types.ts`.
- Data shape:
  ```ts
  export interface TaskReplayCreatedData {
    readonly newTaskRef: {
      readonly namespace: string;
      readonly name: string;
      readonly uid: string;
    };
    readonly originalTaskRef: {
      readonly namespace: string;
      readonly name: string;
      readonly uid: string;
    };
    readonly decidedBy?: string;
    readonly reason?: string;
  }
  ```
- Extends `AuditEventType` union + `AuditEventData` discriminated union in `types.ts`.
- Rides the existing `makeEvent` factory.

#### `ReplayModal.tsx` UI surface

- New file `packages/workbench-ui/src/ReplayModal.tsx` (top-level, mirrors `NewTaskModal.tsx`).
- Trigger: a "Replay" button next to ReviewActions in `TaskDetail.tsx` (always visible, not gated on phase — operators may replay passing tasks to A/B against different agents).
- Form fields:
  - **Target Agent** — dropdown from `/api/agents` (pre-selected to original's `targetAgent`; required).
  - **Reason** — optional textarea (≤256 chars).
  - **Original message (read-only preview)** — collapsible `<details>` showing `spec.originalUserMessage`.
  - **(advanced section, hidden by default)** runConfig overrides + labels editor.
- Submit → calls `createTask()` with body shape including `replayOf: { taskRef: { namespace, name, uid }, reason? }`.
- onSuccess: `onClose()` + optional visual ghost-replay via existing `useReplay` controller's `start()` (small delight; not required by spec but cheap to wire).
- Esc-to-close, Click-outside-to-close (same as `NewTaskModal`).

#### Rejected alternatives

- "Per-task `modelClass` override field on `AgentTaskSpec`" — schema change; deferred to future research per D2.
- "Operator-side replay creates the task without the workbench-api intermediating" — fails the H17 release-namespace scope (must go through the same write surface as `POST /api/tasks`).
- "Replay button on EVERY entry point (TaskDetail, TaskList row, Command Center right-click, ReviewPage row)" — over-scope for v0.2. Ship TaskDetail button only; the others are cheap to add in a follow-up if demand justifies.
- "Replay creates an `AgentWorkflow` instead of an `AgentTask`" — replay-of-a-workflow is future research; v0.2's replay is task-scope only.

### D-04: RTS-feel-as-usability compliance + COMMAND-CENTER-CONTRACT + sound/FX posture

**Locked option:** Sound on every new hotkey + action (reusing existing `sound.{click,taskComplete,taskFailed}` library). FX kept minimal & substrate-bound (reuse existing FxLayer + camera-ease; no new FX types). No painted chrome, no new sound packs, no new visual themes. All new UI surfaces honor the `COMMAND-CENTER-CONTRACT.md` Prime Directive: every visible object/action maps back to a substrate source (or is presentation-only over already-source-bound data).

#### Sound posture (for new hotkeys + multi-select + replay)

| Trigger                                             | Sound                        |
| --------------------------------------------------- | ---------------------------- |
| `g <letter>` chord successful navigation            | `sound.click()`              |
| `g <letter>` chord timeout (no follow-up in 1500ms) | silent (avoid alert fatigue) |
| `?` opens cheat sheet                               | `sound.click()`              |
| TaskDetail `t` opens trace                          | `sound.click()`              |
| TaskDetail `t` with no trace                        | silent + toast "no trace"    |
| ReviewPage `j` / `k` row navigation                 | `sound.click()`              |
| ReviewPage `a` / `r` accept/reject (opens confirm)  | `sound.click()`              |
| CommandView `o` open detail                         | `sound.click()`              |
| CommandView `o` on agent (no AgentDetail in v0.2)   | silent + toast               |
| SelectionActions button click                       | `sound.click()`              |
| "Scroll to first failure" finds a match             | `sound.click()`              |
| "Scroll to first failure" no match                  | silent + toast               |
| ReplayModal submit → 201                            | `sound.taskComplete()`       |
| ReplayModal submit → 422 / 503                      | `sound.taskFailed()`         |
| ReplayModal close (no submit)                       | silent                       |

All sounds reuse the existing `sound` engine at `packages/workbench-ui/src/command/sound.ts`. No new methods, no new sound packs.

#### FX posture

- "Scroll to first failure" → reuses `easeCameraTo` from `command/camera.ts`. No new camera ease, no new screen-shake.
- "Open detail" / `g <route>` navigation → no FX (instant hash change).
- ReplayModal submit success → MAY trigger the existing `useReplay` ghost-sprite animation against the NEW task's targetAgent (small visual confirmation that the replay landed). Single-line wire from `ReplayModal.onSuccess` → existing `useReplay.start(detail, agentPos, gatewayPos)` call. NOT required by spec; cheap to add. Planner picks.
- No new FX types in `command/fx.ts`. No new particle systems, no new colors, no new sprites.

#### COMMAND-CENTER-CONTRACT compliance (D7)

- All Command-Center-scoped Phase 5 surfaces (`SelectionActions.tsx`, the `o`-key handler in CommandView) honor the Prime Directive: every visible object/action maps back to a substrate source.
  - `SelectionActions` button labels ("Open 3 in tabs") render a count derived from `selection.keys.size`, which is already source-bound via the CommandView selection grammar.
  - "Scroll to first failure" pans the camera to a substrate object's screen position — pure presentation over source-bound data.
  - The `o`-key opens a hash route — no new UI-only world state.
- New non-Command-Center surfaces (`HotkeyCheatSheet.tsx`, `ReplayModal.tsx`, app-level global hotkeys, TaskDetail `t`, ReviewPage `j`/`k`/`a`/`r`) are OUTSIDE Command Center; the Prime Directive applies to data only (these surfaces consume already-source-bound data from `/api/agents`, `/api/tasks`, `/api/review-queue` — no new world state).

#### RTS-feel-as-usability rule (`feedback_workbench_rts_ui_aesthetic.md`)

- Hotkeys, multi-select bulk-inspect, replay-from-context — all USABILITY primitives. ✓
- No painted backgrounds, no sprite-skinned GUI elements, no new visual themes, no faction-color reskins. ✓
- No "make the cheat sheet look like a tutorial popup with NPC dialogue" — the cheat sheet is a clean monospace key-list. ✓
- No mission overlay extension. Phase 1's MissionOverlay stays unchanged. ✓

### Test posture (carries forward from Phases 1–4)

- **Vitest gotchas:** selective fake timers (`vi.useFakeTimers({ toFake: ['Date'] })`), `globalThis.fetch` not `global`, `urlOf()` URL helper, `Object.fromEntries` for ReadonlyMap snapshots, JSON import attributes. All Phase 2/3 lessons apply to new test files.
- **Unit tests:**
  - `hotkeys.test.ts` — chord timeout, navigation dispatch, `isTextTarget` guard, modifier collisions (Ctrl+g should NOT trigger `g` chord), `Esc` cancels chord mid-flight.
  - `SelectionActions.test.tsx` — popover mount when `size >= 2`, button labels reflect count, action handlers fire, tab-cap kicks in at >10, clipboard-fallback shows textarea on permission denial.
  - `ReplayModal.test.tsx` — pre-fill from TaskDetail, dropdown population from `/api/agents`, validation (≤256 char reason), submit calls `createTask` with the `replayOf` body shape.
  - `validators.test.ts` extension — `validateCreateTaskBody` accepts/rejects `replayOf` shapes per the contract.
  - `routes/tasks.test.ts` extension — 5-step replay handler path: SnapshotCache miss → 422; UID mismatch → 422; happy path → 201 with annotations + audit event.
  - `App.test.tsx` extension — `?` opens cheat sheet from non-CommandView routes; `g r` navigates; chord timeout discards.
- **Snapshot tests:** `HotkeyCheatSheet.test.tsx` renders the canonical key list (snapshot); regen on every hotkey-list change is intentional and reviewed.
- **Coverage:** the workbench-api routes/tasks.ts extension keeps coverage ≥75% per CLAUDE.md glue-code threshold; the new UI files target the same.

### COMMAND-CENTER-CONTRACT.md compliance (D7)

- Hotkey scheme: navigation hotkeys map to hash routes (existing substrate surfaces). No new world state.
- Multi-select bulk-inspect: read-only over substrate-bound data. Locked-off bulk-mutate per REQUIREMENTS.md §3.
- Replay-from-context: creates a substrate object (new AgentTask CR) via the existing POST `/api/tasks` write path. Inherits chart `actions.create=false` revocation. Annotation-only — no new substrate primitives.
- Cheat sheet: presentation-only static content. No substrate data.

### Claude's Discretion (unlocked — planner picks)

The following are intentionally NOT locked because they're implementation details below the gray-area threshold; the planner makes the call:

- Wave shape: number of plan waves (Phase 4 was 6 plans; Phase 5 is smaller scope — likely 3–4 plans). The planner picks based on dependency analysis.
- Wave 0 scaffolding scope: which fixtures, RBAC, DTO scaffolding go in wave 0 vs later waves. Mirror Phase 4's wave-0 hygiene posture.
- Where `useAlert` hook lives (a new `packages/workbench-ui/src/useAlert.ts` shared util OR inline in each route). Default: shared util if ≥3 callers exist; inline otherwise.
- Whether to mount `<SelectionActions>` always (returns null when `selection.keys.size < 2`) OR conditionally render. Default: always-mounted, returns null — matches the `ReviewActions` pattern.
- Whether `cc-reload.test.tsx`'s snapshot needs a regen for the new `<SelectionActions>` mount. Default: yes, single-commit snapshot regen per Phase 3 / Phase 4 LM-8 pattern.
- Whether the ReplayModal's "advanced" section ships in v0.2 or defers. Default: defer to keep modal simple; reveal in follow-up if operators ask.
- Whether to add a small "Replayed by N" badge to TaskDetail (showing the inverse `replay-of` chain). Default: defer if cost is non-trivial; ship if cheap.
- Whether `TaskList`'s `?targetAgent=<name>` filter is a new feature in v0.2 OR deferred. Default: ship as part of Wave-X "Open all in tabs" since the bulk-inspect action depends on it.
- HotkeyCheatSheet styling: match `NewTaskModal` exactly OR design a slightly more compact two-column layout. Default: match `NewTaskModal` shape for consistency.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents (researcher, planner, executor, checker) MUST read these before planning or implementing.**

### Project planning corpus (re-steered 2026-05-09 PM)

- `.planning/PROJECT.md` — project bones; D1–D7; load-bearing tests (§11 bounds, §15 one-sentence); D2 "Defer CRDs until repeated behavior justifies one"; D6 "self-proposal, not self-promotion" (relevant: replay-from-context is OPERATOR-driven, not agent-driven); D7 "COMMAND-CENTER-CONTRACT.md is binding for Workbench/Command Center work"
- `.planning/REQUIREMENTS.md` §1 "Workbench usability hardening — WB" — WB-01 + WB-02 + WB-03 candidate acceptance criteria
- `.planning/REQUIREMENTS.md` §3 explicit non-goals — "Bulk-mutate actions remain forbidden until the underlying CRD write path explicitly supports the operation"; "Workbench painted/sprite-skinned chrome"; "UI-only world state"
- `.planning/REQUIREMENTS.md` §4 future research — per-task `modelClass` override is implicit future research (not currently named, but covered by D2 "defer schema changes"); per-route hotkey customization is future research
- `.planning/ROADMAP.md` Phase 5 success criteria (3 items; depends on Phase 2 for Command Center read-depth foundation)
- `.planning/STATE.md` — current pointer + blockers (none; Phase 4 verified)

### Phase 1–4 artifacts (REUSE — do not redesign)

- `.planning/phases/01-agentdisposition-v0/01-CONTEXT.md` — DISP-03 `/api/dispositions` projection pattern (relevant: not directly reused in Phase 5 but the additive-DTO + audit-event extension pattern is)
- `.planning/phases/02-command-center-contract-hardening/02-CONTEXT.md` — CC-01 source-binding pattern (relevant: Phase 5 ADDS NO new source-binding field names; all new render paths read already-source-bound data)
- `.planning/phases/02-command-center-contract-hardening/02-04-SUMMARY.md` — vitest gotchas
- `.planning/phases/03-resource-flow-overlays/03-CONTEXT.md` — Phase 3's overlay-component mount-site pattern (relevant: `<SelectionActions />` mounts alongside `<FlowOverlay />` / `<PressureOverlay />` / `<DispositionOverlay />` in CommandView using the same precedent)
- `.planning/phases/03-resource-flow-overlays/03-03-PLAN.md` — `docs/FLOW-LEGEND.md` discoverability footer link in `docs/COMMAND-CENTER-CONTRACT.md` — Phase 5 mirrors this with `docs/HOTKEYS.md` footer link
- `.planning/phases/04-review-queue-projection-promotion-path/04-CONTEXT.md` — Phase 4's `ReviewActions` inline TaskDetail panel pattern (Phase 5's `Replay` button in TaskDetail mirrors this), annotation-driven write path pattern (Phase 5's `replay-of` annotations follow the same `kagent.knuteson.io/*` prefix convention)
- `.planning/phases/04-review-queue-projection-promotion-path/04-03-PLAN.md` — annotation-driven write flow (PATCH-then-customApi vs customApi-then-PATCH ordering); Phase 5's `POST /api/tasks` replay path is similar but creation-only, no PATCH on the original
- `.planning/phases/04-review-queue-projection-promotion-path/04-06-PLAN.md` — wave-5 gap closure pattern (e.g., type-only cross-check pinning, error-detail surfacing); Phase 5 should anticipate similar gap-closure needs at code-review time

### Implementation contracts

- `docs/COMMAND-CENTER-CONTRACT.md` — **binding for the SelectionActions popover + the CommandView `o`-key handler.** Phase 5's main UI surfaces (HotkeyCheatSheet, ReplayModal, app-level global hotkeys) are NOT inside Command Center, so the Prime Directive applies to data only. Add a discoverability footer link to `docs/HOTKEYS.md` (single-line, NOT a contract revision).
- `docs/HOTKEYS.md` — NEW file. Developer-facing keyboard cheat sheet. Lists every hotkey, scope, action. Living doc. WB-01 acceptance ties to this file's existence + completeness.
- `docs/SUBSTRATE-V1.md` §4.3 — audit-event catalog ordering (Phase 5 adds 1 new event type: `task.replay.created`). Update the catalog table.
- `docs/HARNESS-LESSONS.md` §4 — `originalUserMessage` is required at the protocol level for delegation chains. Replay-from-context COPIES this verbatim from the original task.
- `CLAUDE.md` (root) — tech stack (TypeScript + Node 22 + tsx + ESM + pnpm workspace), MIT header on every `.ts` file, Conventional Commits (`feat(phase-05-...)` / `fix(phase-05-...)`), GitOps for cluster ops, `gh pr create` and `gh pr merge` are NOT a unit, pre-commit hook requires Node 22

### Existing Workbench / operator surfaces the planner must work with

- `packages/workbench-ui/src/CommandView.tsx:14-30` — existing hotkey grammar docblock; Phase 5 ADDS `o` (open detail) only; everything else untouched
- `packages/workbench-ui/src/CommandView.tsx:660-809` — existing keydown handler shape; the `isTextTarget` guard (L662-671) is the helper to lift into `hotkeys.ts`
- `packages/workbench-ui/src/CommandView.tsx:1438` — existing `.hotkeyStrip` styling (the bottom strip showing hotkey hints) — Phase 5 cheat sheet references the same `<kbd>` look
- `packages/workbench-ui/src/CommandView.tsx:2342-2497` — existing `?` overlay (`hotkeyOverlay` + `hotkeyCard`) — Phase 5's App-level cheat sheet uses a similar visual shape but renders the superset list
- `packages/workbench-ui/src/CommandView.tsx:405,990,1018` — existing marquee + Shift+click + selection-merge logic; Phase 5 doesn't change this — `SelectionActions` reads `selection` as input
- `packages/workbench-ui/src/App.tsx:60-99` — `useHashRoute` hook + `parseHash`; Phase 5 ADDS no new routes (the global hotkeys navigate to existing routes); Phase 5 ADDS `[cheatSheetOpen, setCheatSheetOpen]` state at the App level
- `packages/workbench-ui/src/TaskDetail.tsx:106` — existing `<ReviewActions>` mount site; Phase 5 ADDS `<ReplayButton>` (or inline button) next to it
- `packages/workbench-ui/src/TaskDetail.tsx:139-156` — existing `traceLink` rendering; Phase 5's `t` hotkey opens `traceLink.url` from this data
- `packages/workbench-ui/src/NewTaskModal.tsx` — THE template for `ReplayModal.tsx`. Same Esc-to-close, same `/api/agents` dropdown, same submit flow, same `CreateTaskApiError` handling
- `packages/workbench-ui/src/api.ts:138-167` — `createTask` + `CreateTaskApiError` shapes; Phase 5 extends `createTask` to accept the `replayOf` field optionally (additive)
- `packages/workbench-ui/src/ReviewPage.tsx:111` — existing `keydown` listener; Phase 5 extends with `j` / `k` / `a` / `r` / `Esc` handlers (focus-aware)
- `packages/workbench-ui/src/command/sound.ts:96` — `sound.click()` (re-used everywhere Phase 5 fires audio feedback)
- `packages/workbench-ui/src/command/sound.ts:152-164` — `sound.taskComplete()` / `sound.taskFailed()` for ReplayModal submit success/fail
- `packages/workbench-ui/src/command/camera.ts:easeCameraTo` — existing camera-ease helper for "Scroll to first failure"
- `packages/workbench-ui/src/command/Mission.tsx` — Phase 1's MissionOverlay — DO NOT EXTEND. Phase 5's cheat sheet is a separate top-level component
- `packages/workbench-ui/src/command/Replay.tsx` — existing VISUAL replay (ghost sprite animation) — DO NOT confuse with WB-03 replay-from-context. The visual `useReplay` controller MAY optionally fire on ReplayModal submit success, but that's secondary delight, not the spec.
- `packages/workbench-api/src/routes/tasks.ts` — POST handler; Phase 5 extends with `replayOf` body field + 5-step server-side handler (validate → resolve → UID-check → create → audit)
- `packages/workbench-api/src/types-write.ts:15-37` — `CreateTaskRequest` shape; Phase 5 ADDS optional `readonly replayOf?: ReplayOfReference` field
- `packages/workbench-api/src/routes/validators.ts` — `validateCreateTaskBody`; Phase 5 extends with `validateReplayOf` sub-helper
- `packages/workbench-api/src/cache.ts` — `SnapshotCache.tasks` consumed by the new server-side `replayOf` resolver (step 1); no schema change
- `packages/workbench-api/src/auth.ts` — `X-Forwarded-User` source for `replay-decided-by` annotation (same H17-acknowledged-spoofable posture as Phase 4)
- `packages/audit-events/src/event-types.ts` — extend with 1 new event-type literal: `task.replay.created`
- `packages/audit-events/src/types.ts` — extend `AuditEventType` union + `AuditEventData` discriminated union with the new type and its `data` shape (`TaskReplayCreatedData`)
- `packages/audit-events/src/make-event.ts` — extend with a `taskReplayCreated` helper if the factory pattern has per-type helpers; otherwise the new type rides the existing factory
- `packages/dto/src/index.ts` — re-export the new `task.replay.created` event-type literal if Phase 5 promotes it to `@kagent/dto` (Phase 4 pattern: review-queue DTOs ARE in `@kagent/dto`; replay event-type can stay local in `@kagent/audit-events` since UI doesn't render the event payload, just the resulting AgentTask)
- `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` — NO new RBAC verbs needed (existing `agenttasks: [create]` covers replay)
- `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml` — NO changes (existing read-side RBAC unchanged)

### Domain definition

- `docs/NORTH-STAR-SYSTEM-DESIGN.md` §C-game-loop — `Intent → Work → Evidence → Review → Promotion → Better Future Work`. Phase 5's replay-from-context completes the loop's "Better Future Work" branch by letting operators re-intent on the same work with a different agent.
- `docs/NORTH-STAR-SYSTEM-DESIGN.md` §C-promotion-loop — "Agents propose new capability; never self-promote new authority" — relevant to Phase 5 as a NEGATIVE constraint: replay is operator-driven, never agent-self-replay. D6.
- `feedback_workbench_rts_ui_aesthetic.md` (auto-memory) — "RTS feel = usability primitives (hotkeys, multi-select, dispatch, replay, audit-trace shortcut, FX), NOT visual reskins" — Phase 5 IS the literal implementation of this rule.

### Project conventions

- `CLAUDE.md` (root) — tech stack, MIT header, Conventional Commits, GitOps posture, `gh pr create` ≠ `gh pr merge`, pre-commit Node 22

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **`packages/workbench-ui/src/CommandView.tsx:660-809`** — the canonical example of a keydown handler with `isTextTarget` guard. Phase 5 lifts the guard into a shared `hotkeys.ts` util.
- **`packages/workbench-ui/src/CommandView.tsx:2342-2497`** — existing `?` overlay pattern (`hotkeyOverlay` + `hotkeyCard`). Phase 5's App-level cheat sheet uses the same visual shape but renders from `hotkeys.ts` constants.
- **`packages/workbench-ui/src/NewTaskModal.tsx`** — THE template for `ReplayModal.tsx`. Esc-to-close, `/api/agents` dropdown, `createTask()` submit, `CreateTaskApiError` handling — all reusable patterns.
- **`packages/workbench-ui/src/ReviewPage.tsx:103-114`** — existing keydown listener with Esc handling; Phase 5 extends with `j`/`k`/`a`/`r`. Pattern is `document.addEventListener('keydown', onKey)` in a `useEffect`.
- **`packages/workbench-ui/src/command/sound.ts:96,152,158`** — `sound.click()` / `sound.taskComplete()` / `sound.taskFailed()` — Phase 5 reuses these for hotkey + action audio feedback. No new sound methods.
- **`packages/workbench-ui/src/command/camera.ts:easeCameraTo`** — existing camera-ease helper. "Scroll to first failure" reuses it directly.
- **`packages/workbench-ui/src/command/Replay.tsx`** — existing VISUAL ghost-sprite replay. Phase 5 may OPTIONALLY trigger `useReplay.start()` on ReplayModal submit success as delight. NOT the WB-03 mechanism.
- **`packages/workbench-api/src/routes/tasks.ts`** — POST handler with validator + customApi + audit event + RBAC fail-closed. Phase 5 extends with `replayOf` body field + 5-step replay handler. Same fail-closed posture for `customApi === undefined`.
- **`packages/workbench-api/src/routes/validators.ts`** — `validateCreateTaskBody`. Phase 5 adds `validateReplayOf` sub-helper.
- **`packages/workbench-api/src/cache.ts`** — `SnapshotCache.tasks` Map<string, AgentTaskCR> — consumed by the replay handler's step-1 resolve.
- **`packages/workbench-api/src/auth.ts`** — `X-Forwarded-User` extractor for `replay-decided-by` annotation.
- **`packages/audit-events/src/event-types.ts`** — exists with 25+ event types; add 1 new (`task.replay.created`). Additive only.
- **`packages/workbench-ui/src/api.ts:138-167`** — `createTask` + `CreateTaskApiError`. Phase 5 extends `createTask` request body to accept optional `replayOf` field.
- **Vitest infrastructure** — `pnpm -C packages/workbench-api test` (node env), `pnpm -C packages/workbench-ui test` (jsdom env). Same Phase 2/3/4 gotchas.

### Established Patterns

- **Annotation as substrate signal** — `kagent.knuteson.io/<key>: <value>` on AgentTask `metadata.annotations`. Phase 4 added `review-decision`, `review-decided-by`, `review-decided-at`, `template-candidate`, `promoted-from-task`. Phase 5 ADDS `replay-of`, `replay-of-uid`, `replay-reason`, `replay-decided-by`, `replay-decided-at`. Pattern: server-side handler materializes; UI surfaces consume.
- **POST endpoint fail-closed when `actions.create=false`** — Phase 5's replay handler inherits the existing `tasks.ts:147` fail-closed posture. No new chart values flag.
- **Closed-enum field-name types in `source-binding.ts`** — Phase 5 ADDS NO new enum members. All new render paths read already-source-bound data; `SelectionActions` is presentation-only.
- **Audit-event additive extension** — new event types are added to `event-types.ts` + `types.ts` + (optionally) `make-event.ts`. Per the comment block, every const must have matching members in `AuditEventType` + `AuditEventData`.
- **MIT license header on every `.ts` source file** — every new file gets the SPDX header per Phases 1–4.
- **Vim-style chord hotkeys** — NEW pattern in Phase 5. `g <letter>` with 1500ms timeout. Mirrors how vim itself handles two-key chords.
- **Modal-as-form** — Phase 1's `DispositionOverlay` modal, Phase 4's accept/reject confirms in `ReviewActions`, Phase 5's `ReplayModal` — all share the backdrop + card + Esc-to-close shape from `NewTaskModal.tsx`.

### Integration Points

- **`packages/workbench-ui/src/App.tsx`** — mount `<HotkeyCheatSheet />` controlled by App-level state; install `useGlobalHotkeys()` hook
- **`packages/workbench-ui/src/CommandView.tsx`** — mount `<SelectionActions />` alongside existing overlays; extend keydown handler with `o` key
- **`packages/workbench-ui/src/TaskDetail.tsx`** — add "Replay" button next to `<ReviewActions>` mount; extend keydown handler with `t` key
- **`packages/workbench-ui/src/ReviewPage.tsx`** — extend keydown handler with `j` / `k` / `a` / `r` keys; add row-focus state + `.focused` CSS class
- **`packages/workbench-ui/src/TaskList.tsx`** — (D-02 dependency) extend with `?targetAgent=<name>` query-param filter for the "Open all in tabs" bulk action's Agent case
- **`packages/workbench-ui/src/api.ts`** — extend `createTask` body type with optional `replayOf` field; no new fetch functions
- **`packages/workbench-ui/src/{hotkeys,HotkeyCheatSheet,ReplayModal}.ts(x)`** — three new top-level files
- **`packages/workbench-ui/src/command/SelectionActions.tsx`** — new file inside the `command/` subdir (same neighborhood as the other overlays)
- **`packages/workbench-api/src/routes/{tasks,validators}.ts`** — extend with `replayOf` validator + 5-step replay handler
- **`packages/workbench-api/src/types-write.ts`** — add `ReplayOfReference` type + optional `replayOf` on `CreateTaskRequest`
- **`packages/audit-events/src/{event-types,types,make-event}.ts`** — add `task.replay.created` event type + data shape
- **`docs/HOTKEYS.md`** — new file
- **`docs/COMMAND-CENTER-CONTRACT.md`** — add discoverability footer link to `docs/HOTKEYS.md` (single line)
- **`docs/SUBSTRATE-V1.md` §4.3** — update audit-event catalog table with 1 new entry (`task.replay.created`)

</code_context>

<specifics>

## Specific Ideas / Concrete Phase 5 Anchors

1. **Phase 4's `ReviewActions` inline pattern is the canonical UI template for the Replay button in TaskDetail.** Same mount site (next to evidence rows in TaskDetail), same `onDecision` callback to refetch, same Esc-to-close on the popped modal. Don't reinvent.

2. **Phase 1–3's overlay-component pattern is the canonical template for `SelectionActions`.** Mount inside CommandView alongside `<DispositionOverlay />` / `<FlowOverlay />` / `<PressureOverlay />`. Same prop-drilling pattern (snapshot + layout + selection + cameraRef + wrapperRef). Returns null when `selection.keys.size < 2`.

3. **`CommandView.tsx:660-809` is the canonical keydown-handler template.** The `isTextTarget` guard MUST be the FIRST check in any new keyboard handler. Lift the helper into `packages/workbench-ui/src/hotkeys.ts` and import from there.

4. **No new CRDs in v0.2 still applies.** Replay-from-context creates a new AgentTask via the EXISTING POST `/api/tasks` write path. Annotations are the lightest substrate primitive. AgentTaskSpec is unchanged.

5. **D6 — Self-proposal, not self-promotion.** Replay is OPERATOR-driven, not agent-driven. The server-side handler verifies the `X-Forwarded-User` header (same H17-acknowledged-spoofable posture as Phase 4). Agents do NOT have a write surface to materialize `replay-of` annotations.

6. **§11 bounds test answer for Phase 5 (must appear in PLAN.md):**
   - Declared capability: workbench-ui ships (a) an app-wide hotkey scheme spanning all 6 routes with a unified `?` cheat sheet, (b) multi-select bulk-inspect actions (open-in-tabs / copy-IDs / scroll-to-first-failure) on Command Center sprites, and (c) a replay-from-context surface in TaskDetail that re-dispatches a task's input under a different agent via POST `/api/tasks` with `kagent.knuteson.io/replay-of` annotations.
   - Bounded resource drain: zero new persistence; zero new CRDs/schema changes; bulk-inspect opens at most 10 tabs per click (pop-up-blocker safety); replay creates exactly one new AgentTask per submit; no new audit-event channels, just one new event type riding the existing publisher; no new RBAC verbs.
   - Observable state transition: the `replay-of` annotation chain on AgentTasks is the substrate-side visible signal; `task.replay.created` audit events flow through the existing publisher; hotkey-driven hash-route changes are observable in the URL.
   - Auditable output: vitest CI run is the auditable surface — hotkey tests (chord timing, isTextTarget guard, navigation), SelectionActions tests (count badges, tab-cap, clipboard fallback), ReplayModal tests (pre-fill, submit shape), validators tests (replayOf shape acceptance/rejection), routes/tasks tests (5-step server handler), App tests (cheat sheet route handling). Audit-event log in production carries the canonical record of every replay.
   - Revocation path: chart `actions.create=false` disables ALL write endpoints (existing convention from H17) — replay-from-context inherits that gate; hotkey scheme is presentation-only and can be globally disabled via a future `VITE_HOTKEYS=false` flag (NOT in v0.2 scope; mention as a future toggle); bulk-inspect actions are read-only so revocation is implicit (just stop using them); a single chart rollback removes the entire phase's write surface.

7. **§15 one-sentence test answer for Phase 5 (must appear in PLAN.md):**

   "Shipping an app-wide hotkey scheme + multi-select bulk-inspect + an annotation-driven replay-from-context surface reduces operator friction across all six Workbench routes without expanding substrate primitives or adding new CRDs — strengthening the substrate's observability (faster trace-link traversal, faster cross-task comparison) and authority hygiene (replay actions inherit the existing `actions.create=false` revocation gate; `replay-of` annotation chains make A/B and lineage observable in the existing audit-event surface)."

8. **The user's "use 'recommended' options going forward" is authority to lock D-01..D-04 with the recommended option; it is NOT authority to expand scope.** All 3 candidate requirements (WB-01, WB-02, WB-03) stay in this phase; nothing more, nothing less. Specifically:
   - NO Command Center right-click → "Replay last task" (deferred).
   - NO bulk-mutate actions (locked off by REQUIREMENTS.md §3).
   - NO per-task `modelClass` override (future research per D2).
   - NO new sound packs / FX types / visual themes (RTS-feel-as-usability rule).
   - NO new CRDs or schema changes.

9. **No imperative kubectl against homelab (CLAUDE.md operational context).** Phase 5 ships substrate-side code (workbench-api + UI + audit-events) — no Job manifests, no `kubectl apply/exec/port-forward`. Verification IS vitest. Deployment is workbench-api Docker image rebuild + workbench-ui Docker image rebuild + (already-on) chart `rbac.actions.create=true`.

10. **`gh pr create` and `gh pr merge` are not a unit.** Phase 5 ships PR(s) for human review; merges are separate explicit consent per CLAUDE.md and memory `feedback_auto_push.md`.

11. **Pre-commit hook needs Node 22.** Same as Phases 1–4 — `source ~/.nvm/nvm.sh && nvm use 22` before any commit.

12. **The `o`-key in CommandView has a v0.2 limitation: no AgentDetail page exists yet.** Per Phase 1's MissionOverlay-equivalent observability story, AgentDetail is a future-research item or a Phase 6+ workstream. The cheat sheet MUST document this limitation explicitly. When the focus is an Agent, `o` plays `sound.click()` and shows a toast "no Agent detail page in v0.2; use Command Center for agent state".

13. **The replay handler's step-1 SnapshotCache resolve is the fail-fast gate.** Reasoning: relying on K8s to return 404 for a missing `replayOf.taskRef` would (a) be slower (a K8s API round-trip vs an in-memory Map lookup), (b) potentially leak the wrong error (the user sees the SECONDARY 404 from customApi.createNamespacedCustomObject instead of the PRIMARY "your replayOf reference is bogus" error). The SnapshotCache-resolve-first pattern matches Phase 4's PATCH-pre-flight posture and the existing `tasks.ts` validation order.

14. **The replay annotation set is intentionally STRICTER than Phase 4's review annotations.** Phase 4 made `review-decided-by` optional (the operator could opt out by not setting `X-Forwarded-User`). Phase 5 makes `replay-decided-by` REQUIRED. Reasoning: replay is a more-load-bearing audit signal (it creates a new substrate object; cross-task lineage matters for replay-divergence detection in Phase 5+ design). Forcing the operator-id annotation closes a gap that Phase 4 left open. The H17 spoofable posture still applies.

</specifics>

<deferred>

## Deferred Ideas (Phase 5 explicitly does NOT do these)

- **Command Center right-click → "Replay last task" entry point.** Defer to follow-up. v0.2 ships TaskDetail button only. Reconsider when there's repeated demand from operators who live inside Command Center and don't want to context-switch to TaskDetail.
- **Per-task `modelClass` / `model` override on AgentTaskSpec.** Future research per D2. WB-03's "different model class" is delivered by switching to a different Agent that has that class. Reconsider when there's repeated demand for fine-grained model A/B that doesn't fit the per-Agent model class story.
- **Hotkey customization / user-defined remapping.** Future research. v0.2 ships ONE hard-coded scheme. Promote when there's repeated demand from operators who fight the scheme.
- **Hotkey scheme that varies by operator role / RBAC.** Future research. v0.2 ships ONE scheme for all operators.
- **App-wide notification center / global toast bus.** Each route's existing transient alert pattern is reused; a unified `useAlert` hook MAY be lifted into a shared util if multiple routes need it for the new hotkey-feedback paths, but a global toast bus is over-design for v0.2.
- **Touch / mobile / accessibility audit of the hotkey scheme.** v0.2 is desktop-first. ARIA landmarks, screen-reader announcements, focus-trap inside HotkeyCheatSheet modal, keyboard-navigability of all SelectionActions buttons — defer to a follow-up accessibility-hardening phase.
- **Bulk-export of multi-select selection** (e.g., download as CSV/JSON). Copy-to-clipboard covers v0.2 demand. Bulk-export is its own feature.
- **SSE-driven invalidation of the ReplayModal's `/api/agents` dropdown.** v0.2 fetches once on mount; same posture as `NewTaskModal`. Promote when catalog churn shows up.
- **Agent-side write of the `replay-of` annotation.** Off the table per D6 — agents propose, operators promote. Replay-from-context is operator-only.
- **Per-task `replayOf` chain navigation UI** (e.g., "this task was replayed by X, which was replayed by Y"). v0.2 ships the annotation only. Surfacing the inverse chain on TaskDetail is small follow-up work the planner MAY include if cheap. Default: defer.
- **Bulk-mutate actions on multi-select** (bulk-accept / bulk-reject / bulk-replay / bulk-dispatch). Locked off by REQUIREMENTS.md §3.
- **CommandView "Replay button on every Agent sprite hover".** Off the table. The ReplayButton in `command/Replay.tsx` is the VISUAL ghost replay; the WB-03 replay is in TaskDetail.
- **`AgentWorkflow` replay** (replay-of-a-workflow instead of replay-of-a-task). Future research. v0.2's replay is task-scope only.
- **Replay-divergence detection** (comparing the new task's outcome to the original's; flagging divergence as a review-queue row). That's Phase 5+ design per `docs/REPLAY-EVALS.md` and Phase 4's REV-03 reserved enum slot (`replay-divergence`). v0.2 ships the `replay-of` annotation that makes divergence-detection POSSIBLE; Phase 5 does NOT ship the detector.
- **Persistent hotkey-usage telemetry** (e.g., "operators press `g r` 50× per day"). Future research. v0.2 ships no telemetry surface for hotkey adoption.
- **Custom hotkey-feedback styling** (custom toast colors, custom sound packs, custom FX). Off the table per RTS-feel-as-usability rule.
- **A new visual theme for the cheat sheet** (e.g., "tutorial popup with NPC dialogue", "game manual styling"). Off the table per memory `feedback_workbench_rts_ui_aesthetic.md`. The cheat sheet is a clean monospace key-list.
- **Mission overlay extension** (e.g., a new "Phase 5 mission" tour). Phase 1's MissionOverlay stays unchanged.
- **New flow gauges or pressure types.** Phase 2's PressureOverlay and Phase 3's FlowOverlay are not touched.
- **AgentDetail page.** No Agent-scoped detail route exists in v0.2; `o` from CommandView on an Agent focus is a no-op + toast. AgentDetail is a future research / Phase 6+ item.
- **Replay button on EVERY TaskList row** (per-row "Quick replay"). Default: defer. One inline entry point (TaskDetail button) is sufficient.
- **Replay-modal "Advanced" section ship vs defer.** Default: defer; ship minimal modal (target agent + reason + read-only preview). Reveal in follow-up if operators ask for runConfig overrides at replay time.
- **`?targetAgent=<name>` filter on TaskList.** Required dependency for "Open all in tabs" → Agent case. Planner picks: ship in Wave-X alongside SelectionActions OR defer the Agent-case of "Open all in tabs" to a follow-up. Default: ship the filter; it's a small additive change.

</deferred>

---

_Phase: 05-workbench-usability-primitives_
_Context gathered: 2026-05-10 via discuss-phase, "use 'recommended' options" mode_
