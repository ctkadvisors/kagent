# Phase 5: Workbench usability primitives — Research

**Phase:** 05 — workbench-usability-primitives
**Researched:** 2026-05-10
**Domain:** workbench-ui presentation primitives (app-wide hotkeys, multi-select bulk-inspect popover, replay-from-context modal) + workbench-api additive POST extension (`replayOf`) + 1 new audit event + 1 new docs file
**Confidence:** HIGH — every decision is locked in CONTEXT.md; every new file has an in-tree analog from Phases 1–4; no new substrate primitives; no Context7 / external library lookups required.

**Sources read (HIGH confidence — all VERIFIED in-tree):**

- `.planning/phases/05-workbench-usability-primitives/05-CONTEXT.md` (D-01..D-04 locked decisions + Specific Anchors §1–14 + Deferred §1–22) `[VERIFIED: in-repo]`
- `.planning/REQUIREMENTS.md` (WB-01/02/03 acceptance criteria + §3 non-goals + §4 future research) `[VERIFIED: in-repo]`
- `.planning/STATE.md` (Phase 04 verified complete; current pointer = Phase 05) `[VERIFIED: in-repo]`
- `.planning/ROADMAP.md` (Phase 5 success criteria 1/2/3; depends on Phase 2 read-depth foundation) `[VERIFIED: in-repo]`
- `.planning/PROJECT.md` (D1–D7; §11 bounds test, §15 one-sentence test; D2 no-new-CRDs; D6 self-proposal; D7 COMMAND-CENTER-CONTRACT binding) `[VERIFIED: in-repo]`
- `CLAUDE.md` (Node 22 + tsx; MIT header; Conventional Commits; vitest co-located; pre-commit Node 22; gh-create ≠ gh-merge) `[VERIFIED: in-repo]`
- `docs/COMMAND-CENTER-CONTRACT.md` §2 Prime Directive + §3 Source-of-truth + §4 Action contract + §9 Non-goals `[VERIFIED: in-repo]`
- `docs/HARNESS-LESSONS.md` §4 (`originalUserMessage` required for delegation chains — copied verbatim into replay) `[CITED: CONTEXT.md canonical_refs]`
- `packages/workbench-ui/src/App.tsx` (L1–150 — useHashRoute, parseHash, route mount sites — all 6 routes already defined) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/CommandView.tsx:14-30` (hotkey grammar docblock) + `L660-809` (canonical keydown handler with `isTextTarget` guard at L662-671 + 4 `useEffect` deps `[popover, selection, muted]`) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/TaskDetail.tsx` (L106 ReviewActions mount site; L139-156 traceLink rendering shape; L36-80 component body) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/NewTaskModal.tsx` (L36-229 — full modal: Esc-to-close at L68-76; fetchAgents at L47-66; submit→createTask at L78-117; backdrop/aria-modal/header/form at L119-228) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/ReviewPage.tsx` (L103-114 existing keydown listener; L94-152 page body with confirm dialog; L184-252 row render) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/command/ReviewActions.tsx` (L59-73 inline-component pattern; eligibility check at L60-68; Phase 4 canonical for the Replay button neighbor) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/TaskList.tsx` (L34-188 — no `?targetAgent` filter yet; SSE refetch; phasePill rendering) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/api.ts` (L138-174 — `createTask` body shape + `CreateTaskApiError` subclass) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/command/sound.ts` (L96 `click()`, L138-141 `dispatch()`, L143-149 `agentReady()`, L152-155 `taskComplete()`, L158-172 `taskFailed()`) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/command/camera.ts:81` (`easeCameraTo(cam, offsetX, offsetY, zoom, durationMs, nowMs)` — 6-arg signature) + `L132-145` `centerOnWorld()` `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/command/scene.ts:59-62` (`SelectionState { keys: ReadonlySet<string>, focus: SelectionRef }` shape) `[VERIFIED: in-repo]`
- `packages/workbench-ui/src/command/layout.ts:53-57` (`LayoutResult { gateway, agents: ReadonlyMap, factions }`) `[VERIFIED: in-repo]`
- `packages/workbench-api/src/routes/tasks.ts` (L103-285 POST handler — fail-closed at L144-150; validateCreateTaskBody at L160-179; cache pre-check at L191-197; createNamespacedCustomObject at L220-226; K8s error ladder 409/404/403/500 at L240-284; `extractK8sStatus` + `readCreatedMeta` exported at L349/L377) `[VERIFIED: in-repo]`
- `packages/workbench-api/src/routes/validators.ts` (full file — `validateCreateTaskBody`; K8S_NAME_RE / K8S_NAMESPACE_RE at L62/L65; payload byte cap at L59) `[VERIFIED: in-repo]`
- `packages/workbench-api/src/types-write.ts` (L15-37 `CreateTaskRequest`; L38-48 `CreateTaskResponse`; L50-58 `CreateTaskErrorBody`) `[VERIFIED: in-repo]`
- `packages/workbench-api/src/cache.ts:62-90` (`SnapshotCache.tasks` Map + `getTask(ns, name)` lookup) `[VERIFIED: in-repo]`
- `packages/workbench-api/src/auth.ts` (`FORWARDED_USER_HEADER = 'X-Forwarded-User'` at L41; handlers use `c.req.header(...)` directly per `routes/stream.ts:98`) `[VERIFIED: in-repo]`
- `packages/audit-events/src/event-types.ts` (53 existing constants; ALL_EVENT_TYPES frozen array at L219-274 — Phase 5 grows it to 54) `[VERIFIED: in-repo]`
- `packages/audit-events/src/types.ts` (`AuditEventType` 53-member union at L50-117; `AuditEventData` discriminated union at L1017-1120; Phase 4's `ReviewRequestedData`/`ReviewAcceptedData`/`ReviewRejectedData`/`TemplateCandidatePromotedData` at L918-1010 — direct shape analog for `TaskReplayCreatedData`) `[VERIFIED: in-repo]`
- `packages/workbench-ui/package.json` (`vitest 4.1.4`, `jsdom 27.0.1`, `@testing-library/react 16.3.0`, `react 19.0.0`) `[VERIFIED: in-repo]`
- `packages/workbench-api/package.json` (`hono 4.6.14`, `tsx 4.21.0`, `@kubernetes/client-node 1.4.0`; no dedicated vitest dep listed — inherits from root workspace) `[VERIFIED: in-repo]`
- `.planning/phases/04-review-queue-projection-promotion-path/04-RESEARCH.md` (vitest gotchas, source-binding posture, audit-event additive pattern — Phase 5 mirrors) `[CITED: CONTEXT.md canonical_refs]`
- `.planning/config.json` (`workflow._auto_chain_active: false`; **`nyquist_validation` key absent** — treat as enabled per researcher spec) `[VERIFIED: in-repo]`

---

<user_constraints>

## User Constraints (from CONTEXT.md)

The planner MUST honor these — they bind every Phase 5 task. Copied verbatim from `05-CONTEXT.md`.

### Locked Decisions

**D-01 — Hotkey scheme:** Vim-style `g <letter>` global navigation chord (1500ms timeout, silent on timeout, `Esc` cancels mid-flight) + per-route context hotkeys + App-level `?` cheat sheet superset of CommandView's `?` overlay.

- Global navigation: `g t` → `#/`, `g g` → `#/gateway`, `g c` → `#/command`, `g k` → `#/cluster`, `g r` → `#/review`.
- App-level `?` opens `HotkeyCheatSheet`. Short-circuit when `location.hash === '#/command'` — CommandView's local `?` overlay owns that route's hint UX.
- New files: `packages/workbench-ui/src/hotkeys.ts` (exports `isTextTarget`, `useGlobalHotkeys`, `HOTKEY_CHEAT_SHEET`) + `packages/workbench-ui/src/HotkeyCheatSheet.tsx` (modal overlay mirroring NewTaskModal).
- TaskDetail per-route: `t` opens `traceLink.url` (toast "no trace" if absent); `Esc` already wired via `onBack`.
- ReviewPage per-route: `j`/`k` next/prev row focus; `a`/`r` accept/reject focused row (delegates to existing confirm flow); `Esc` defocuses.
- CommandView per-route: existing RTS grammar untouched. NEW `o` → open detail for current focus (task→TaskDetail; gateway→GatewayPage; agent→silent toast "no Agent detail page in v0.2"; document the limitation in the cheat sheet).
- New file: `docs/HOTKEYS.md` (developer-facing cheat sheet, living doc).
- Discoverability footer link in `docs/COMMAND-CENTER-CONTRACT.md` → `docs/HOTKEYS.md` (single-line; NOT a contract revision; matches Phase 3's `FLOW-LEGEND.md` pattern).

**D-02 — Multi-select bulk-inspect:** Three named read-only actions in a corner-pinned `SelectionActions` popover mounted inside CommandView when `selection.keys.size >= 2`. All actions read-only — bulk-mutate locked off by REQUIREMENTS.md §3.

- New file: `packages/workbench-ui/src/command/SelectionActions.tsx` (mounted alongside `<DispositionOverlay />` / `<FlowOverlay />` / `<PressureOverlay />`).
- Position: fixed bottom-right of `.canvas-wrapper` (`bottom: 12px; right: 12px;`) — NOT anchored to selection centroid.
- Actions: `"Open N in tabs"` (cap 10 — overflow toast "opened first 10 of N selected"); `"Copy N IDs"` (clipboard + textarea fallback on permission denial); `"Scroll to first failure"` (task `phase==='Failed'` | agent `failureCount>0` | gateway `usage.inflight>=capacity` → `easeCameraTo`; no-match toast "no failures in selection").
- TaskList grows `?targetAgent=<name>` query-param filter (small additive change — required dependency for Agent case of "Open all in tabs"). Default: ship the filter in Phase 5; cheap.
- No new `SourceFieldName` enum members — popover is presentation-only over already-source-bound canvas state.

**D-03 — Replay-from-context:** Annotation-only (`kagent.knuteson.io/replay-of` + 4 sibling annotations); operator changes `targetAgent` only (per-task `modelClass` override deferred). Entry point: TaskDetail "Replay" button → `ReplayModal.tsx`. New audit event `task.replay.created`. POST `/api/tasks` extended with optional `replayOf` body field.

- 5 annotations on the NEW AgentTask (none on the original; original is read-only from Phase 5's perspective):
  - `kagent.knuteson.io/replay-of: "<original-ns>/<original-name>"` (required)
  - `kagent.knuteson.io/replay-of-uid: "<original-uid>"` (required — resolved server-side via SnapshotCache)
  - `kagent.knuteson.io/replay-reason: "<≤256 chars>"` (optional; HTML-escaped via React text-node rendering)
  - `kagent.knuteson.io/replay-decided-by: "<X-Forwarded-User>"` (REQUIRED — stricter than Phase 4's optional `review-decided-by`; reasoning per CONTEXT.md anchor #14)
  - `kagent.knuteson.io/replay-decided-at: "<ISO-8601 UTC>"` (required — server-side wall-clock)
- Fields copied verbatim from original → new AgentTask: `spec.payload`, `spec.originalUserMessage`, `spec.runConfig.{timeoutSeconds, maxIterations}`, `spec.expectedTools`. User labels copied; `kagent.knuteson.io/*` labels regenerated.
- Fields NOT copied (intentionally regenerated): `metadata.name` (= `replay-${nanoid8}`), `metadata.namespace` (default release ns), `spec.targetAgent` (operator picks from `/api/agents`), `spec.targetCapability`, `spec.parentTask`, `spec.parentDistillation`, `spec.inputs[]`, `spec.idempotencyKey`, `spec.verifyContract`.
- 5-step server-side handler (in extended `POST /api/tasks`): (1) resolve via `SnapshotCache.tasks.get(...)` → 422 on miss; (2) UID cross-check → 422 on mismatch; (3) build 5 annotations; (4) call existing `customApi.createNamespacedCustomObject` (existing K8s error ladder applies); (5) emit `task.replay.created` audit event.
- No new RBAC verbs (existing `agenttasks: [create]` covers replay).
- New files: `packages/workbench-ui/src/ReplayModal.tsx` (top-level, mirrors NewTaskModal shape); `validateReplayOf` helper alongside `validateCreateTaskBody`.

**D-04 — RTS-feel-as-usability + COMMAND-CENTER-CONTRACT + sound/FX posture:** Sound on every new hotkey + action (reuse `sound.click()` / `sound.taskComplete()` / `sound.taskFailed()`). NO new sound packs, NO new FX types, NO new visual themes, NO painted chrome.

- Sound table (CONTEXT.md D-04): chord-success → `click`; chord-timeout → silent; `?` → `click`; trace-open → `click`; no-trace → silent+toast; j/k → `click`; a/r → `click` (opens confirm); `o` task/gateway → `click`; `o` agent → silent+toast; SelectionActions button → `click`; scroll-to-failure match → `click`; scroll-to-failure no match → silent+toast; ReplayModal 201 → `taskComplete`; ReplayModal 422/503 → `taskFailed`; ReplayModal close → silent.
- FX posture: "Scroll to first failure" reuses `easeCameraTo`. ReplayModal submit success MAY optionally trigger existing `useReplay.start()` ghost-sprite animation (planner picks; not required by spec).
- COMMAND-CENTER-CONTRACT compliance (D7): `SelectionActions` + CommandView `o`-key handler honor Prime Directive — every visible object/action maps back to a substrate source. Other Phase 5 surfaces (HotkeyCheatSheet, ReplayModal, app-level global hotkeys, TaskDetail `t`, ReviewPage `j`/`k`/`a`/`r`) are OUTSIDE Command Center; the Prime Directive applies to data only.

### Claude's Discretion (unlocked — planner picks)

These are intentionally NOT locked because they're implementation details below the gray-area threshold; the planner makes the call:

- **Wave shape:** number of plan waves (Phase 4 was 6 plans; Phase 5 is smaller scope — likely 3–4 plans). Planner picks based on dependency analysis.
- **Wave 0 scaffolding scope:** which fixtures, RBAC, DTO scaffolding go in wave 0 vs later waves. Mirror Phase 4's wave-0 hygiene posture.
- **Where `useAlert` hook lives** — shared `packages/workbench-ui/src/useAlert.ts` util OR inline in each route. Default: shared util if ≥3 callers exist; inline otherwise.
- **Whether to mount `<SelectionActions>` always** (returns null when `selection.keys.size < 2`) OR conditionally render. Default: always-mounted, returns null — matches `ReviewActions` pattern.
- **Whether `cc-reload.test.tsx`'s snapshot needs a regen** for the new `<SelectionActions>` mount. Default: yes, single-commit snapshot regen per Phase 3 / Phase 4 LM-8 pattern.
- **Whether the ReplayModal's "advanced" section** ships in v0.2 or defers. Default: defer to keep modal simple; reveal in follow-up if operators ask.
- **Whether to add a small "Replayed by N" badge** to TaskDetail (showing the inverse `replay-of` chain). Default: defer if cost is non-trivial; ship if cheap.
- **Whether `TaskList`'s `?targetAgent=<name>` filter** is a new feature in v0.2 OR deferred. Default: ship as part of Wave-X "Open all in tabs" since the bulk-inspect action depends on it.
- **HotkeyCheatSheet styling:** match `NewTaskModal` exactly OR design a slightly more compact two-column layout. Default: match `NewTaskModal` shape for consistency.

### Deferred Ideas (OUT OF SCOPE — locked exclusions per CONTEXT.md `<deferred>` block)

These are explicitly **out of scope for Phase 5**. The planner MUST NOT include any of these:

- Command Center right-click → "Replay last task" entry point.
- Per-task `modelClass` / `model` override on AgentTaskSpec (would require schema change — D2).
- Hotkey customization / user-defined remapping.
- Hotkey scheme that varies by operator role / RBAC.
- App-wide notification center / global toast bus.
- Touch / mobile / accessibility audit of the hotkey scheme.
- Bulk-export of multi-select selection (CSV/JSON).
- SSE-driven invalidation of the ReplayModal's `/api/agents` dropdown.
- Agent-side write of the `replay-of` annotation (off the table per D6).
- Per-task `replayOf` chain navigation UI (the inverse chain on TaskDetail).
- Bulk-mutate actions on multi-select (bulk-accept / bulk-reject / bulk-replay / bulk-dispatch) — locked off by REQUIREMENTS.md §3.
- CommandView "Replay button on every Agent sprite hover".
- `AgentWorkflow` replay (replay-of-a-workflow).
- Replay-divergence detection (Phase 5+ design; v0.2 ships only the annotation that makes detection possible).
- Persistent hotkey-usage telemetry.
- Custom hotkey-feedback styling / new sound packs / new FX types.
- New visual theme for the cheat sheet (e.g., "tutorial popup with NPC dialogue").
- Mission overlay extension.
- New flow gauges or pressure types.
- AgentDetail page (does not exist in v0.2; `o` from CommandView on an Agent focus is no-op + toast).
- Replay button on EVERY TaskList row (per-row "Quick replay").
- ReplayModal "Advanced" section (default defer).

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID        | Description                                                                                                                                                                                                                                                                        | Research Support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WB-01** | Hotkey scheme for the most-used Workbench operations (open task detail, open agent detail, navigate to gateway, open trace, dismiss alert, jump to review queue). Documented in a developer-facing keyboard cheat sheet. Hotkeys map to existing actions; no new substrate state.  | New `hotkeys.ts` + `HotkeyCheatSheet.tsx` + extensions to CommandView/TaskDetail/ReviewPage keydown handlers + `docs/HOTKEYS.md`. "Open agent detail" is **partially satisfied** — v0.2 has no AgentDetail route, so `o` on agent focus shows toast "no Agent detail page in v0.2" (limitation documented in cheat sheet per CONTEXT.md anchor #12). All other operations map to existing routes/actions. **§11 bounds:** declared capability = hotkey scheme; bounded drain = zero new persistence; observable state = hash route change; auditable = vitest CI run; revocation = chart-level UI disable.                                                                                                                                      |
| **WB-02** | Multi-select on Command Center sprites for bulk-inspect actions (open all selected detail views in tabs, copy IDs, scroll to first failure). Bulk-mutate actions remain forbidden.                                                                                                 | New `command/SelectionActions.tsx` popover; reads existing `selection.keys` (no new selection grammar); uses existing `layout.agents`/`snapshot.tasks` lookups + existing `easeCameraTo`/`navigator.clipboard.writeText`/`window.open`. Bulk-mutate stays locked off — only the 3 named read-only actions ship. **§11 bounds:** declared capability = 3 read-only bulk-inspect actions on multi-select; bounded drain = ≤10 tabs per click; observable state = camera offset change for scroll-to-failure (substrate-bound camera); auditable = vitest; revocation = stop using buttons (read-only).                                                                                                                                            |
| **WB-03** | Replay-from-context: from any task detail, an operator can re-dispatch the same input under a different model class or a different agent, creating a new AgentTask with a recorded `replayOf` annotation pointing to the original. No new CRD; uses existing AgentTask write path. | New `ReplayModal.tsx` (TaskDetail button); extended `createTask()` accepts optional `replayOf` body; new `validateReplayOf` validator helper; extended POST `/api/tasks` 5-step handler (resolve→UID-check→annotations→create→audit); 1 new audit event `task.replay.created`. **"Different model class"** delivered by switching to a different Agent that carries the desired modelClass (per-task override is future research). **§11 bounds:** declared capability = re-dispatch via annotation; bounded drain = 1 new AgentTask per submit; observable state = annotation chain visible on `metadata.annotations`; auditable = `task.replay.created` event; revocation = chart `actions.create=false` disables the write surface globally. |

This phase has 3 requirements (WB-01, WB-02, WB-03). The planner uses this table to map requirements → plans → tests.

</phase_requirements>

---

## 1. Domain Context

**What's actually being built (code-level):**

Phase 5 is **presentation + annotation work over the v0.1 substrate plus the Phase 1–4 read surfaces**. It is NOT a new substrate primitive. Three deliverables, all in `packages/workbench-ui/` plus a tiny additive extension in `packages/workbench-api/routes/tasks.ts` and one new audit-event constant:

### 1.1 WB-01 — App-wide hotkey scheme

**Mechanism:** A single window-level `keydown` listener registered at the App level (via a `useGlobalHotkeys()` hook). The hook implements a 2-state machine: `idle` → first press of `g` (no modifier, not in text target) starts a 1500ms timeout, transitions to `awaitingChord`. In `awaitingChord`, the next non-modifier keypress either matches a registered chord (dispatch hash change + `sound.click()`) or doesn't (silent return to `idle`). `Esc` or 1500ms expiry returns to `idle` silently.

**No new substrate state.** Every chord ends in `window.location.hash = '#/...'` — the existing route. The "dismiss-alert" requirement is satisfied by existing `Esc` handlers (CommandView L710-715 already wires it).

**Per-route hooks:**

- **TaskDetail:** add a `useEffect` keydown listener that handles `t` (open `traceLink.url` if present; toast "no trace" otherwise). Esc is already wired via `onBack`.
- **ReviewPage:** extend the existing keydown listener at L103-114 with `j`/`k` (row focus state machine), `a`/`r` (open the existing confirm dialog using `openConfirm(focusedRow, 'accept'|'reject')`), `Esc` (defocus). Add `[focusIdx, setFocusIdx]` state at the page level; `j` increments mod `rows.length`, `k` decrements. The focused row gets a `.focused` CSS class.
- **CommandView:** extend the existing keydown handler at L660-809 with one new `else if` for `o`. Reads `selection.focus.kind`/`selection.focus.key`. Task → hash change to `#/tasks/<ns>/<name>` (parse the SelectionRef.key, which is `<ns>/<name>`); gateway → hash change to `#/gateway`; agent → `sound.click()` + setAlertText "no Agent detail page in v0.2; use Command Center for agent state".

### 1.2 WB-02 — Multi-select bulk-inspect popover

**Mechanism:** A new `SelectionActions` React component, props `{ selection, snapshot, layout, cameraRef, wrapperRef }`. Returns `null` when `selection.keys.size < 2` (matches `ReviewActions` always-mounted-returns-null pattern). Otherwise renders a fixed-position popover (`position: absolute; bottom: 12px; right: 12px;`) inside `.canvas-wrapper` with three buttons.

**Selection-key resolution:** `selection.keys` is a `ReadonlySet<string>` of keys. Keys can refer to:

- Agents — via `layout.agents.get(key)` (the canonical layout map at `command/layout.ts:55`)
- Tasks — via `snapshot.tasks.get(key)` (`CommandSnapshot.tasks` map shape)
- The single sentinel `"gateway"` — see `scene.ts:217`'s `selection.keys.has('gateway')` precedent.

The popover's button handlers iterate selection-keys, look up each one, and dispatch the per-kind action.

**No new source-binding fields.** `SelectionActions` only renders button labels with counts (`"Copy 3 IDs"`), not substrate data. The button counts derive from `selection.keys.size`, which is already source-bound via the CommandView selection grammar at the canvas-render sites (covered by `cc-orphan` assertion at CommandView L72-76 from Phase 2).

### 1.3 WB-03 — Replay-from-context

**UI mechanism:** New `ReplayModal.tsx` (top-level, same neighborhood as `NewTaskModal.tsx`). Triggered by a "Replay" button mounted in TaskDetail next to `<ReviewActions>` at L106 (always visible — operators may replay passing tasks to A/B). The modal:

1. Fetches `/api/agents` once on mount (same `fetchAgents()` call as NewTaskModal L47-66).
2. Pre-selects the original task's `detail.targetAgent` in the dropdown (operator overrides to A/B against a different agent).
3. Renders an optional reason textarea (≤256 chars; React's automatic HTML-entity escaping on display).
4. Renders a collapsible `<details>` "Original message" preview reading `detail.originalUserMessage`.
5. Submit → calls `createTask()` with the existing body shape + new optional `replayOf` field.
6. Esc-to-close, backdrop click-to-close (mirrors NewTaskModal L68-76 + L122-126).

**Server-side mechanism:** Extend POST `/api/tasks` at `routes/tasks.ts:143-285`. When `req.replayOf` is present, the existing handler short-circuits at the top:

- **Step 1 (resolve):** `deps.cache.getTask(replayOf.taskRef.namespace, replayOf.taskRef.name)` — if `undefined`, return 422 with `{ error: 'replayOf.taskRef not found in SnapshotCache', fields: [{field: 'replayOf.taskRef', code: 'missing'}] }`.
- **Step 2 (UID cross-check):** if `replayOf.taskRef.uid` was supplied AND `resolved.metadata.uid !== replayOf.taskRef.uid`, return 422 with `{ error: 'replayOf.taskRef UID mismatch — original task may have been renamed or recreated', fields: [{field: 'replayOf.taskRef.uid', code: 'mismatch'}] }`.
- **Step 3 (build annotations):** materialize the 5 `replay-*` annotations into the `manifest.metadata.annotations` (NOTE: today's POST handler at L199-217 does NOT set `metadata.annotations` — replay is the first writer; the existing label-validator at `validators.ts:195` already protects the `kagent.knuteson.io/*` prefix for labels; an analogous guard is needed for annotations if any operator-supplied annotations are ever accepted — currently they're not).
- **Step 4 (call existing customApi):** the EXISTING K8s error ladder at L240-284 applies as-is. No changes to error handling for replay.
- **Step 5 (audit):** emit `task.replay.created` via the existing audit publisher (same pattern as Phase 4 review accept/reject at `routes/review-queue.ts`; both `extractK8sStatus` and `readCreatedMeta` are already exported at `tasks.ts:349/377` from Plan 04-03 helper lifting).

**Field copy:** When `replayOf` is present, the handler synthesizes the manifest body by reading from `resolved` (the cached original AgentTask CR) — copies `resolved.spec.payload`, `resolved.spec.originalUserMessage`, `resolved.spec.runConfig?.{timeoutSeconds,maxIterations}`, `resolved.spec.expectedTools` — and overrides `targetAgent` with `req.targetAgent` from the modal. `metadata.name` is `replay-${nanoid8}` (per CONTEXT.md D-03 — analogous to existing `manual-${nanoid8}` at L100); the existing `defaultGenerateName()` at L92-101 needs a tiny extension OR a new sibling helper to use the `replay-` prefix instead of `manual-`.

**Why fail-fast on SnapshotCache** (CONTEXT.md anchor #13): a K8s 404 would (a) be slower (round-trip vs in-memory Map lookup) and (b) leak the wrong error — the user would see a "create failed" 404 that looks like the new AgentTask's namespace was bad, when the actual fault is a bogus `replayOf.taskRef`. SnapshotCache-resolve-first matches Phase 4's PATCH-pre-flight posture (routes/review-queue.ts) and the existing `tasks.ts` validation order.

---

## 2. Existing Patterns to Reuse (concrete file:line refs)

### 2.1 Canonical keydown-handler template (`packages/workbench-ui/src/CommandView.tsx:660-809`)

**Pattern:**

```tsx
useEffect(
  () => {
    const isTextTarget = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTextTarget(e.target)) return; // FIRST CHECK ALWAYS
      if (!audioReady) setAudioReady(true); // unlock audio gesture
      const k = e.key.toLowerCase();
      /* … key-by-key dispatch … */
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  },
  [
    /* deps */
  ],
);
```

`isTextTarget` MUST be the FIRST check in any new keyboard handler. Phase 5 lifts it into `packages/workbench-ui/src/hotkeys.ts` and imports it everywhere.

### 2.2 Existing `?` overlay pattern (`packages/workbench-ui/src/CommandView.tsx:727-728` + `L2342-2497`)

```tsx
} else if (e.key === '?') {
  setHintsOpen((v) => !v);
}
```

The overlay JSX itself lives near L2342–2497 (a backdrop + card). Phase 5's `HotkeyCheatSheet.tsx` uses the SAME visual shape (`hotkeyOverlay` + `hotkeyCard`) but renders from the `HOTKEY_CHEAT_SHEET` exported const in `hotkeys.ts`. The App-level `?` handler short-circuits when `location.hash === '#/command'` so CommandView's local `?` keeps owning that route.

### 2.3 Canonical modal template (`packages/workbench-ui/src/NewTaskModal.tsx`)

`ReplayModal.tsx` MUST mirror NewTaskModal exactly:

| Behavior                                                      | NewTaskModal location                                                                                    | Replay reuses                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Esc-to-close + focus                                          | L68-76 (`useEffect` with `document.addEventListener('keydown', ...)`; `promptRef.current?.focus()`)      | identical                                              |
| `/api/agents` dropdown                                        | L47-66 (`fetchAgents()` on mount, prefill `targetAgent` to first item)                                   | identical, but prefill = original task's `targetAgent` |
| Submit → createTask                                           | L78-117 (try/catch around `await createTask(...)`; `CreateTaskApiError` field-error mapping at L102-114) | identical, body includes `replayOf`                    |
| Backdrop click closes                                         | L119-126 (`onClick` checks `e.target === e.currentTarget`)                                               | identical                                              |
| `role="dialog" aria-modal="true" aria-labelledby="ntm-title"` | L127                                                                                                     | identical                                              |
| Submit-disabled while in-flight                               | `submitting` state at L41, gates Cancel + Submit buttons                                                 | identical                                              |

### 2.4 Inline TaskDetail panel (`packages/workbench-ui/src/command/ReviewActions.tsx:59-73`)

Phase 4's `ReviewActions` is the canonical UI shape for the Replay button:

```tsx
export function ReviewActions({ task, onDecision }): React.JSX.Element | null {
  const eligible = /* … 4 trigger conditions … */;
  if (!eligible) return null;
  return <ReviewActionsPanel task={task} onDecision={onDecision} />;
}
```

Phase 5's Replay button is **always visible** (no eligibility gate — operators may replay passing tasks to A/B). The button itself is the trigger; clicking opens the `<ReplayModal>` controlled by TaskDetail-local state.

**Mount site:** `packages/workbench-ui/src/TaskDetail.tsx:106` — alongside `<ReviewActions task={detail} onDecision={refetch} />`. New code: `<ReplayButton task={detail} onSubmitted={refetch} />` (or inline the button + modal — planner picks the cleanest split).

### 2.5 Overlay-component mount-site pattern (`packages/workbench-ui/src/CommandView.tsx`)

Existing imports at L52-55 + L57:

```tsx
import { DispositionOverlay } from './command/DispositionOverlay.js';
import { FlowOverlay } from './command/FlowOverlay.js';
import { PressureOverlay } from './command/PressureOverlay.js';
import { Minimap } from './command/Minimap.js';
```

`<SelectionActions />` mounts in the same neighborhood. Same prop-drilling shape (snapshot + selection + layout + cameraRef + wrapperRef). Always-mounted-returns-null pattern keeps render-tree shape stable across selection changes (avoids snapshot-test churn on `cc-reload.test.tsx`).

### 2.6 Phase 4 annotation-write pattern (`packages/workbench-api/src/routes/tasks.ts:103-285`)

Phase 5's replay handler shape mirrors Phase 4's `routes/review-queue.ts` POST handlers:

1. Validate body (`validateCreateTaskBody` + new `validateReplayOf` sub-helper).
2. Resolve original from SnapshotCache (fail-fast 422 if missing — matches Phase 4 review-queue 404 pattern).
3. UID cross-check (fail-fast 422 on mismatch).
4. Build manifest (copied fields + 5 replay-\* annotations + operator-supplied targetAgent).
5. Call `customApi.createNamespacedCustomObject` (existing).
6. Emit audit event.
7. Existing K8s error ladder at L240-284 covers 409/404/403/500.

Key differences from Phase 4 review accept:

- Phase 4 PATCHes the original task; Phase 5 CREATES a new task and leaves the original untouched.
- Phase 4's `template.candidate.promoted` audit fires AFTER CR creation BEFORE annotation PATCH (LM-10 / Plan 04-06 gap closure). Phase 5's `task.replay.created` fires AFTER successful CR creation — no analogous ordering hazard because there's no PATCH-on-original step.

### 2.7 Audit-event additive extension (`packages/audit-events/src/*`)

Three-file additive extension pattern (Phase 4 added 4 events; Phase 5 adds 1):

1. `event-types.ts` — add `export const TASK_REPLAY_CREATED = 'task.replay.created' as const;` and add to `ALL_EVENT_TYPES` frozen array (size 53 → 54).
2. `types.ts` — add `'task.replay.created'` to the `AuditEventType` union, add `TaskReplayCreatedData` interface, add `{ type: 'task.replay.created'; data: TaskReplayCreatedData }` to the `AuditEventData` discriminated union.
3. `make-event.ts` — Phase 4 patterns ride the existing factory; Phase 5 likely does the same (no per-type helper needed unless a future cross-package consumer needs one).

`TaskReplayCreatedData` shape (locked by CONTEXT.md D-03):

```ts
export interface TaskReplayCreatedData {
  readonly newTaskRef: { readonly namespace: string; readonly name: string; readonly uid: string };
  readonly originalTaskRef: {
    readonly namespace: string;
    readonly name: string;
    readonly uid: string;
  };
  readonly decidedBy?: string;
  readonly reason?: string;
}
```

The `decidedBy` field is technically optional in the audit-event interface (because `X-Forwarded-User` might be absent in a non-prod harness), but per CONTEXT.md D-03 the **annotation** `kagent.knuteson.io/replay-decided-by` is REQUIRED — so the server-side handler must either (a) reject the request with 401 when the header is absent (matching `auth.ts` 401 behavior at L101) or (b) emit the audit with `decidedBy: undefined` while still writing the annotation with a fallback value like `"unknown"`. The planner picks; **recommendation:** reject with 401 when header absent, matching Phase 4's `WORKBENCH_ACTIONS_AUTH_REQUIRED` mode.

---

## 3. Implementation Approach (file-by-file breakdown)

### 3.1 New files (8 source + 1 doc + 1 dev-side CSS module-set)

| Path                                                            | Purpose                                                                                    | Analog                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `packages/workbench-ui/src/hotkeys.ts`                          | Exports `isTextTarget`, `useGlobalHotkeys()`, `HOTKEY_CHEAT_SHEET: readonly HotkeyEntry[]` | None — new util, ~150 LOC                                                   |
| `packages/workbench-ui/src/hotkeys.test.ts`                     | Unit tests for chord state machine + `isTextTarget` + navigation dispatch                  | `command/source-binding.test.ts` style                                      |
| `packages/workbench-ui/src/HotkeyCheatSheet.tsx`                | Modal overlay reading `HOTKEY_CHEAT_SHEET`                                                 | `NewTaskModal.tsx` shape                                                    |
| `packages/workbench-ui/src/HotkeyCheatSheet.test.tsx`           | Snapshot test of the rendered key list                                                     | `command/DispositionOverlay.test.tsx` style                                 |
| `packages/workbench-ui/src/HotkeyCheatSheet.module.css`         | Styling (mirror `NewTaskModal.module.css`)                                                 | exists for NewTaskModal                                                     |
| `packages/workbench-ui/src/ReplayModal.tsx`                     | Modal form for replay-from-context                                                         | `NewTaskModal.tsx` shape (≈230 LOC)                                         |
| `packages/workbench-ui/src/ReplayModal.test.tsx`                | Pre-fill, dropdown population, submit body shape, error mapping                            | NewTaskModal lacks a test today; `ReviewPage.test.tsx` is the closest model |
| `packages/workbench-ui/src/ReplayModal.module.css`              | Styling (mirror `NewTaskModal.module.css`)                                                 | exists for NewTaskModal                                                     |
| `packages/workbench-ui/src/command/SelectionActions.tsx`        | Bottom-right popover with 3 read-only action buttons                                       | New file, ~150 LOC; mounts alongside `FlowOverlay.tsx`                      |
| `packages/workbench-ui/src/command/SelectionActions.test.tsx`   | size-trigger, button labels, action handlers, tab-cap, clipboard fallback                  | `command/FlowOverlay.test.tsx` style                                        |
| `packages/workbench-ui/src/command/SelectionActions.module.css` | Styling — fixed bottom-right, button stack                                                 | New                                                                         |
| `docs/HOTKEYS.md`                                               | Developer-facing cheat sheet (living doc)                                                  | `docs/FLOW-LEGEND.md` shape (Phase 3)                                       |

Optional (planner's discretion):

- `packages/workbench-ui/src/useAlert.ts` + `useAlert.test.ts` — shared toast hook, lifted from CommandView's `alertText` pattern. Default: ship if ≥3 callers need it (likely yes — TaskDetail `t`, CommandView `o` agent, SelectionActions clipboard fallback, SelectionActions no-failure-match, SelectionActions tabs-overflow all need toasts).

### 3.2 Extended files (12 source touchpoints)

| Path                                                                                    | Change                                                                                                                                                                                               | Risk                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench-ui/src/App.tsx` (L100-149)                                          | Mount `<HotkeyCheatSheet />` controlled by App-level `[cheatSheetOpen, setCheatSheetOpen]` state; install `useGlobalHotkeys()` hook                                                                  | LOW — additive                                                                                                                                                                                                                                  |
| `packages/workbench-ui/src/CommandView.tsx` (L660-809 + import block + JSX mount sites) | Extend keydown handler with `o` key; lift `isTextTarget` to import from `hotkeys.ts`; mount `<SelectionActions />` alongside existing overlays                                                       | MEDIUM — touches the most complex handler in the repo; vetted by Phase 1/2/3 (LM-8 snapshot regen likely needed)                                                                                                                                |
| `packages/workbench-ui/src/TaskDetail.tsx` (L106 + import block)                        | Add `<ReplayButton>` (or inline button + modal) next to `<ReviewActions>`; add keydown listener for `t` (trace open)                                                                                 | LOW — additive                                                                                                                                                                                                                                  |
| `packages/workbench-ui/src/ReviewPage.tsx` (L103-114)                                   | Extend existing keydown listener with `j`/`k`/`a`/`r`/`Esc` row-focus state machine; add `[focusIdx, setFocusIdx]` state; add `.focused` CSS class to focused row                                    | MEDIUM — listener is currently confirm-dialog-scoped (`if (confirm === null) return;`); the new keys must work even when no confirm dialog is open. Refactor: split into two effects — one for page-level `j`/`k`/`a`/`r`, one for confirm-Esc. |
| `packages/workbench-ui/src/TaskList.tsx` (L34-188)                                      | Add `?targetAgent=<name>` query-param filter — read via `new URLSearchParams(window.location.hash.split('?')[1] ?? '')`, filter `tasks` array by `t.targetAgent === filter` when present             | LOW — additive, ~10 LOC                                                                                                                                                                                                                         |
| `packages/workbench-ui/src/api.ts` (L138-160)                                           | Extend `createTask` body to accept optional `replayOf` field; extend imported `CreateTaskRequest` type to include optional `replayOf`                                                                | LOW — additive interface field                                                                                                                                                                                                                  |
| `packages/workbench-ui/src/types.ts` (L213-224)                                         | Extend `CreateTaskRequest` with optional `readonly replayOf?: { taskRef: { namespace, name, uid? }, reason? }`                                                                                       | LOW — additive                                                                                                                                                                                                                                  |
| `packages/workbench-api/src/routes/tasks.ts` (L143-285)                                 | Extend POST `/api/tasks` handler with 5-step replay path; gated on `req.replayOf !== undefined`; if present, run resolve→UID-check→annotation-build→customApi→audit; share existing K8s error ladder | MEDIUM — adds a new branch through the most-load-bearing write path. Mitigated by Phase 4 helper lifting (`extractK8sStatus`/`readCreatedMeta` already exported).                                                                               |
| `packages/workbench-api/src/routes/tasks.test.ts`                                       | Add tests for the 5-step replay path: SnapshotCache miss → 422; UID mismatch → 422; happy path → 201 with 5 annotations + audit event; missing `X-Forwarded-User` → 401 (per recommendation)         | LOW — additive test block                                                                                                                                                                                                                       |
| `packages/workbench-api/src/routes/validators.ts` (L74-257)                             | Add `validateReplayOf` sub-helper; call it from `validateCreateTaskBody` when `body.replayOf` is present; emit per-field errors with same `ValidationError` shape                                    | LOW — additive                                                                                                                                                                                                                                  |
| `packages/workbench-api/src/routes/validators.test.ts`                                  | Add tests for `replayOf` shape acceptance/rejection (namespace + name RFC1123, reason ≤256 chars no newlines, uid UUID shape when present)                                                           | LOW — additive                                                                                                                                                                                                                                  |
| `packages/workbench-api/src/types-write.ts` (L15-37)                                    | Add `ReplayOfReference` interface + optional `replayOf?: ReplayOfReference` on `CreateTaskRequest`                                                                                                   | LOW — additive                                                                                                                                                                                                                                  |
| `packages/audit-events/src/event-types.ts`                                              | Add `TASK_REPLAY_CREATED` constant; add to `ALL_EVENT_TYPES` frozen array (53 → 54)                                                                                                                  | LOW — additive (Phase 4 added 4)                                                                                                                                                                                                                |
| `packages/audit-events/src/types.ts`                                                    | Add `'task.replay.created'` to `AuditEventType` union; add `TaskReplayCreatedData` interface; add discriminator member to `AuditEventData` union                                                     | LOW — additive                                                                                                                                                                                                                                  |
| `packages/audit-events/src/types.test.ts` (or equivalent)                               | Add type-only cross-check pinning `TaskReplayCreatedData` to the union member                                                                                                                        | LOW — Phase 4 precedent (LM-10)                                                                                                                                                                                                                 |
| `docs/COMMAND-CENTER-CONTRACT.md`                                                       | Add single-line discoverability footer link to `docs/HOTKEYS.md` — NOT a contract revision (mirrors Phase 3's FLOW-LEGEND.md link)                                                                   | LOW — single-line addition                                                                                                                                                                                                                      |
| `docs/SUBSTRATE-V1.md` §4.3                                                             | Add 1 row to the audit-event catalog table for `task.replay.created` (total grows 53 → 54)                                                                                                           | LOW — single row                                                                                                                                                                                                                                |

### 3.3 Open Questions for the Planner

1. **Where does `useAlert` live?** Default: ship a shared `packages/workbench-ui/src/useAlert.ts` util IF ≥3 callers need it. Inspection suggests 5+ callers (CommandView `o` agent, TaskDetail `t` no-trace, SelectionActions clipboard fallback / no-failure / tabs-overflow) → ship the shared util.

2. **Replace `defaultGenerateName()` or add a sibling?** Today's helper at `tasks.ts:92-101` hard-codes the `manual-` prefix. CONTEXT.md D-03 specifies `replay-${nanoid8}` for replays. Cleanest: add a `prefix` parameter to the existing helper OR add a sibling `generateReplayName()`. Recommendation: parameterize the existing helper to accept a prefix (`defaultGenerateName(prefix = 'manual')`) for symmetry.

3. **Does the replay handler require `X-Forwarded-User` (401 on absent) or allow `decidedBy: undefined`?** Per CONTEXT.md anchor #14 the annotation is REQUIRED, but the audit-event data shape allows optional. **Recommendation:** require the header — return 401 when absent (matching `auth.ts:101`). This forces the operator-id annotation to always have a real value and closes the gap Phase 4 left open.

4. **`?targetAgent=<name>` filter on `#/` (TaskList).** Today the hash route is bare `#/` — query-params on hash routes need a small parser (`window.location.hash.split('?')[1]` + `URLSearchParams`). Default per CONTEXT.md `<discretion>`: ship in Phase 5 as part of the bulk-inspect work. ALTERNATIVE: defer the Agent case of "Open all in tabs" → open `#/` (no filter) and the operator filters manually. Recommendation: ship the filter — it's ~10 LOC and unlocks the bulk-inspect Agent case cleanly.

5. **`HotkeyCheatSheet` rendering style.** Match `NewTaskModal` exactly OR a two-column compact layout. Default: match NewTaskModal for consistency.

6. **`cc-reload.test.tsx` snapshot regen.** Phase 5 adds `<SelectionActions />` to CommandView's render tree — even though it returns null when `selection.keys.size < 2` (which is true in cc-reload test fixtures with `gateway` + no agents selected by default), the DOM tree may shift. **Recommendation:** single dedicated commit for snapshot regen, per Phase 3/4 LM-8 pattern. The plan that mounts SelectionActions should EXPECT the snapshot test to fail; the very next commit lands ONLY the regenerated snapshot diff.

7. **TaskList `?targetAgent=` filter — preserve existing scroll/selection?** When the URL changes via `window.open(...)` to a NEW tab, the parent tab is unaffected. So this is moot for the WB-02 use case. But the same filter is potentially useful within the same tab — defer that consideration (CONTEXT.md `<deferred>` lists it implicitly).

8. **Should `ReplayModal` optionally trigger `useReplay.start()` ghost animation on success?** CONTEXT.md D-04 says "MAY trigger; planner picks." Default: defer — keeps the modal cleaner and the visual replay controller stays in its existing dispatch-path lane.

9. **Sound on `?` opening cheat sheet.** CONTEXT.md D-04 table says `sound.click()`. **Edge case:** if the cheat sheet is opened during a chord-in-progress (rare but possible), the chord state must be reset. Recommendation: opening `?` cancels any in-flight chord (sets state back to `idle`).

10. **Existing `?` overlay on `#/command` — does App-level `?` need to be aware of it?** CONTEXT.md D-01 short-circuits the App-level `?` when `location.hash === '#/command'`. **Test obligation:** App.test.tsx must verify the short-circuit. Verify with `hashchange` event simulation + `?` keydown.

---

## 4. Test Strategy

### 4.1 Vitest Gotchas (carried forward from Phases 1–4)

These are documented in Phase 4 RESEARCH.md §"Test posture" + Phase 2/3 summaries:

- **Selective fake timers:** `vi.useFakeTimers({ toFake: ['Date'] })` — NOT a blanket fake (would break `setTimeout` driving the chord). For the chord state machine, the planner MUST use `vi.useFakeTimers()` and `vi.advanceTimersByTime(1500)` carefully, OR use real timers with very short timeouts in test (e.g., set the chord timeout to `1500` in prod, `100` in test via injected param).
- **`globalThis.fetch`, NOT `global.fetch`:** vitest 4.x with jsdom 27.x — stub `globalThis.fetch` for `fetchAgents()` mocks in `ReplayModal.test.tsx`.
- **URL helper:** `urlOf(...)` if any test constructs hashes for navigation testing.
- **`Object.fromEntries(map)` for ReadonlyMap snapshots:** if any test asserts on a `ReadonlyMap` shape (e.g., layout.agents).
- **JSON import attributes:** if a test imports a JSON fixture (e.g., `cc-snapshot.json`), use the `with { type: 'json' }` ESM attribute syntax.
- **Clipboard API in jsdom:** `navigator.clipboard.writeText()` is NOT in jsdom 27.x by default. The SelectionActions test must mock it via `Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn() }, configurable: true })`. Test the permission-denial fallback by `mockRejectedValue(new Error('permission denied'))`.
- **`window.open` in jsdom:** returns `null` by default (or a noop window). The tabs-cap test should `vi.spyOn(window, 'open').mockImplementation(() => null)` and assert call count is `Math.min(selection.keys.size, 10)`.
- **`window.location.hash` setter:** jsdom 27.x supports it. The chord-navigation test sets `window.location.hash = '#/'` then asserts the new value. Alternative: spy on the hash setter via `Object.defineProperty`.
- **React 19 + testing-library 16.3.0:** use `render(<App />)` + `act(...)` patterns; no `useFakeTimers` interaction issues observed in Phase 1–4 tests.

### 4.2 Per-Requirement Tests (Nyquist-validation map)

| Req       | Test file(s)                             | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                      | Observable evidence                                                                                       |
| --------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **WB-01** | `hotkeys.test.ts`                        | `g t/g/c/k/r` dispatches hash change; `g` followed by 1500ms+ silently returns to idle; `Esc` mid-chord cancels; `Ctrl+g` does NOT trigger chord; `isTextTarget` blocks dispatch when focus is INPUT/TEXTAREA/SELECT/contenteditable; `?` opens cheat sheet                                                                                                                                                                                | `window.location.hash` changes after chord; mock `sound.click()` called on success only                   |
| **WB-01** | `HotkeyCheatSheet.test.tsx`              | Snapshot test of the rendered cheat sheet sections (Global navigation / Inside CommandView / Inside TaskDetail / Inside ReviewQueue); Esc-to-close; click-outside-to-close                                                                                                                                                                                                                                                                 | DOM snapshot file committed to git; expected to regen when hotkey list changes (per Phase 4 LM-8 pattern) |
| **WB-01** | `App.test.tsx` (extension)               | `?` opens cheat sheet from `#/`; `?` short-circuited on `#/command`; `g r` navigates to `#/review`; chord timeout discards                                                                                                                                                                                                                                                                                                                 | `screen.getByRole('dialog')` for cheat sheet; hash assertions                                             |
| **WB-01** | `ReviewPage.test.tsx` (extension)        | `j`/`k` move row focus (asserts `.focused` class moves); `a` opens accept confirm with focused row; `r` opens reject confirm; `Esc` defocuses; pressing `j` with empty queue is a no-op                                                                                                                                                                                                                                                    | `data-testid` per row + `getAttribute('class')` includes `focused`                                        |
| **WB-01** | `TaskDetail.test.tsx` (extension or new) | `t` opens `traceLink.url` (mock `window.open`); `t` on task with no trace shows toast via mocked `useAlert`                                                                                                                                                                                                                                                                                                                                | `window.open` call assertion                                                                              |
| **WB-02** | `SelectionActions.test.tsx`              | Returns null when `selection.keys.size < 2`; renders 3 buttons when `size >= 2`; "Open N in tabs" calls `window.open` N times (cap 10); "Copy IDs" calls `navigator.clipboard.writeText` with newline-joined IDs; clipboard-permission rejected → fallback textarea visible; "Scroll to first failure" calls `easeCameraTo` with correct coords for task `phase==='Failed'`; "Scroll to first failure" no match → toast + no camera change | Mock spies on `window.open`, `navigator.clipboard.writeText`, `easeCameraTo`                              |
| **WB-02** | `TaskList.test.tsx` (extension or new)   | `?targetAgent=<name>` filter restricts rendered rows to matching tasks; absent param renders all rows                                                                                                                                                                                                                                                                                                                                      | DOM query for `<tr>` count                                                                                |
| **WB-02** | `cc-reload.test.tsx` snapshot regen      | After `<SelectionActions />` mount lands, `pnpm -C packages/workbench-ui test -u` regenerates the snapshot; expected diff = new always-mounted-returns-null `null` slot OR a benign DOM placeholder                                                                                                                                                                                                                                        | Snapshot diff visible in `cc-reload.test.tsx.snap`                                                        |
| **WB-03** | `validators.test.ts` (extension)         | `validateCreateTaskBody` accepts `replayOf` with valid `taskRef`; rejects missing `taskRef.namespace`/`name`; rejects bad RFC1123 names; rejects `reason` >256 chars; rejects `reason` with newlines; accepts/rejects `taskRef.uid` UUID shape                                                                                                                                                                                             | per-field `ValidationError` assertions                                                                    |
| **WB-03** | `routes/tasks.test.ts` (extension)       | SnapshotCache-miss → 422 with `replayOf.taskRef` field error; UID-mismatch → 422 with `replayOf.taskRef.uid` field error; happy path → 201 with 5 `replay-*` annotations on the created CR; happy path emits `task.replay.created` audit event with `newTaskRef` + `originalTaskRef` populated; missing `X-Forwarded-User` → 401 (if recommendation locked in)                                                                             | mock K8s client; mock audit publisher; assert annotation map + event type                                 |
| **WB-03** | `ReplayModal.test.tsx`                   | Pre-fill from TaskDetail (original `targetAgent` selected by default); dropdown populated from `/api/agents`; reason ≤256 char enforcement; submit calls `createTask` with body shape `{ targetAgent, originalUserMessage, replayOf: { taskRef: {ns, name, uid}, reason? } }`; submit 201 → onClose() + `sound.taskComplete()`; submit 422/503 → error banner + `sound.taskFailed()`; Esc-to-close; backdrop click-to-close                | `fetch` mock + spy on `createTask`                                                                        |
| **WB-03** | `audit-events` extension test            | Type-only cross-check: assigning `{ type: 'task.replay.created', data: { newTaskRef: {...}, originalTaskRef: {...} } }` to `AuditEventData` typechecks; assigning a malformed shape fails                                                                                                                                                                                                                                                  | tsc-level test, vitest can run with `tsc --noEmit`                                                        |

### 4.3 Coverage Targets

Per CLAUDE.md:

- `≥85%` on operator reconciler — not touched by Phase 5 (no operator changes).
- `≥75%` on glue code — applies to `workbench-api/routes/tasks.ts` replay branch, `workbench-ui/{hotkeys,SelectionActions,ReplayModal,HotkeyCheatSheet}.tsx`. The replay handler tests above cover ≥75%; the UI tests above cover ≥75%.

### 4.4 Manual / E2E (out of scope for vitest)

Not in v0.2 scope: touch / mobile / accessibility testing of the hotkey scheme (CONTEXT.md `<deferred>`). The vitest CI run IS the auditable verification surface per CONTEXT.md anchor #6 (§11 bounds-test answer).

---

## 5. Validation Architecture (REQUIRED — drives VALIDATION.md)

> Per researcher spec: "Per-requirement Nyquist sampling validation: what observable evidence proves WB-01, WB-02, WB-03 are correctly implemented; what tests/asserts close the loop."

### 5.1 Test Framework

| Property               | Value                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Framework              | vitest 4.1.4 (jsdom env for workbench-ui; node env for workbench-api / audit-events)                                                                         |
| Config file            | `packages/workbench-ui/vite.config.ts` (vitest config in workspace) + `packages/workbench-api/vitest.config.ts` (verify exists; create in Wave 0 if missing) |
| UI quick run           | `pnpm -C packages/workbench-ui test`                                                                                                                         |
| API quick run          | `pnpm -C packages/workbench-api test`                                                                                                                        |
| Audit-events quick run | `pnpm -C packages/audit-events test`                                                                                                                         |
| Full suite             | `pnpm -r test` (from repo root — runs every package's `vitest run`)                                                                                          |

### 5.2 Phase Requirements → Test Map

| Req ID | Behavior                                                          | Test Type     | Automated Command                                                 | File Exists?                                                 |
| ------ | ----------------------------------------------------------------- | ------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| WB-01  | App-level `g <letter>` chord dispatches hash change               | unit          | `pnpm -C packages/workbench-ui test -t "useGlobalHotkeys"`        | ❌ Wave 0 — `hotkeys.test.ts`                                |
| WB-01  | `isTextTarget` blocks dispatch in INPUT/TEXTAREA                  | unit          | `pnpm -C packages/workbench-ui test -t "isTextTarget"`            | ❌ Wave 0                                                    |
| WB-01  | `?` opens cheat sheet from any non-`#/command` route              | integration   | `pnpm -C packages/workbench-ui test -t "cheat sheet"`             | ❌ Wave 0 — `HotkeyCheatSheet.test.tsx`                      |
| WB-01  | TaskDetail `t` opens trace link                                   | integration   | `pnpm -C packages/workbench-ui test -t "TaskDetail trace"`        | ❌ Wave 0 — extend `TaskDetail.test.tsx` (create if missing) |
| WB-01  | ReviewPage `j`/`k`/`a`/`r` row navigation + accept/reject         | integration   | `pnpm -C packages/workbench-ui test ReviewPage`                   | ✅ exists; extend                                            |
| WB-01  | CommandView `o` opens detail for task focus                       | integration   | `pnpm -C packages/workbench-ui test -t "CommandView open detail"` | partial — CommandView has tests; add `o` case                |
| WB-01  | `docs/HOTKEYS.md` exists with every shipped hotkey                | manual review | grep + diff against `HOTKEY_CHEAT_SHEET`                          | ❌ new doc file                                              |
| WB-02  | `<SelectionActions>` mounts only when `size >= 2`                 | unit          | `pnpm -C packages/workbench-ui test SelectionActions`             | ❌ Wave 0 — `SelectionActions.test.tsx`                      |
| WB-02  | "Open N in tabs" caps at 10 + emits overflow toast                | unit          | `pnpm -C packages/workbench-ui test -t "tabs cap"`                | ❌ Wave 0                                                    |
| WB-02  | "Copy IDs" calls clipboard + falls back to textarea on denial     | unit          | `pnpm -C packages/workbench-ui test -t "copy IDs"`                | ❌ Wave 0                                                    |
| WB-02  | "Scroll to first failure" pans camera                             | unit          | `pnpm -C packages/workbench-ui test -t "scroll to failure"`       | ❌ Wave 0                                                    |
| WB-02  | TaskList `?targetAgent=X` filters rows                            | integration   | `pnpm -C packages/workbench-ui test -t "targetAgent filter"`      | partial — extend `TaskList.test.tsx` (create if missing)     |
| WB-02  | Bulk-mutate actions ARE NOT shipped — verified by absence         | code review   | grep for "bulk-accept", "bulk-reject" in src/                     | manual                                                       |
| WB-03  | `validateCreateTaskBody` accepts/rejects `replayOf` shapes        | unit          | `pnpm -C packages/workbench-api test validators`                  | ✅ exists; extend                                            |
| WB-03  | POST `/api/tasks` 5-step replay: SnapshotCache miss → 422         | unit          | `pnpm -C packages/workbench-api test -t "replay snapshot miss"`   | ✅ extend `routes/tasks.test.ts`                             |
| WB-03  | POST `/api/tasks` 5-step replay: UID mismatch → 422               | unit          | `pnpm -C packages/workbench-api test -t "replay UID mismatch"`    | ✅ extend                                                    |
| WB-03  | POST `/api/tasks` 5-step replay: happy path → 201 + 5 annotations | unit          | `pnpm -C packages/workbench-api test -t "replay happy path"`      | ✅ extend                                                    |
| WB-03  | POST `/api/tasks` 5-step replay emits `task.replay.created`       | unit          | `pnpm -C packages/workbench-api test -t "task.replay.created"`    | ✅ extend                                                    |
| WB-03  | `ReplayModal` pre-fills target Agent from original task           | integration   | `pnpm -C packages/workbench-ui test ReplayModal`                  | ❌ Wave 0 — `ReplayModal.test.tsx`                           |
| WB-03  | `ReplayModal` submit sends `replayOf` body                        | integration   | `pnpm -C packages/workbench-ui test -t "ReplayModal submit"`      | ❌ Wave 0                                                    |
| WB-03  | `audit-events` extended with `task.replay.created`                | type-only     | `pnpm -C packages/audit-events test types`                        | ✅ extend                                                    |
| WB-03  | `docs/SUBSTRATE-V1.md` §4.3 catalog grows 53 → 54                 | manual review | grep                                                              | manual                                                       |

### 5.3 Sampling Rate

- **Per task commit:** `pnpm -C packages/<touched-package> test --changed` (or full package test if --changed isn't reliable; vitest 4.1.4 supports `--changed` via git).
- **Per wave merge:** `pnpm -r test` (full workspace).
- **Phase gate:** `pnpm -r test` green + manual review of `docs/HOTKEYS.md` completeness + grep for forbidden patterns (no `bulk-accept` / `bulk-reject` / new CRD shape / new sound method) before `/gsd-verify-work`.

### 5.4 Wave 0 Gaps

- ❌ `packages/workbench-ui/src/hotkeys.ts` + `hotkeys.test.ts` — new
- ❌ `packages/workbench-ui/src/HotkeyCheatSheet.tsx` + `HotkeyCheatSheet.test.tsx` + `.module.css` — new
- ❌ `packages/workbench-ui/src/ReplayModal.tsx` + `ReplayModal.test.tsx` + `.module.css` — new
- ❌ `packages/workbench-ui/src/command/SelectionActions.tsx` + `SelectionActions.test.tsx` + `.module.css` — new
- ❌ `docs/HOTKEYS.md` — new
- Possibly ❌ `packages/workbench-ui/src/TaskDetail.test.tsx` — verify; create skeleton if missing
- Possibly ❌ `packages/workbench-ui/src/TaskList.test.tsx` — verify; create skeleton if missing
- Possibly ❌ `packages/workbench-ui/src/useAlert.ts` + `useAlert.test.ts` — new IF the planner locks in the shared util (recommendation: yes)
- Framework install: **NONE** — vitest 4.1.4 + jsdom 27.x + testing-library 16.3.0 already installed (verified in `packages/workbench-ui/package.json`)

---

## 6. Risks & Landmines

Places where Phase 5 could regress prior phases. Each risk has a documented mitigation.

### R-01 — `cc-reload.test.tsx` snapshot drift (Phase 2 CC-02 regression risk) — MEDIUM

**What goes wrong:** Mounting `<SelectionActions />` inside CommandView changes the rendered DOM tree even in the empty-selection case. `cc-reload.test.tsx`'s snapshot would fail.

**Mitigation:**

- Always-mounted-returns-null pattern keeps a `null` slot in the JSX (no DOM node when `selection.keys.size < 2`).
- IF the snapshot still drifts (likely — React 19 may render a stable parent element), do a single dedicated commit for snapshot regen per Phase 3/4 LM-8 pattern. The plan that mounts SelectionActions EXPECTS the snapshot test to fail; the very next commit lands ONLY the regenerated snapshot diff. This makes the snapshot churn a reviewable atomic change.

### R-02 — `cc-orphan` assertion firing on `<SelectionActions>` button labels (Phase 2 CC-01 regression risk) — LOW

**What goes wrong:** Phase 2's `cc-orphan` assertion (`CommandView.tsx:72-76`) fires when a rendered Agent/Task node lacks a backing summary row. If `<SelectionActions>` renders button text that LOOKS LIKE a sprite label, the assertion could miss-fire.

**Mitigation:**

- The popover is `position: absolute` outside the canvas hit-grid — the orphan assertion scans canvas-rendered nodes, not DOM overlays. CONTEXT.md D-02 confirms: "no new `data-source-field` attributes required". Verified by reading CommandView L72-76 — the assertion targets canvas elements, not React DOM.

### R-03 — Phase 4's `ReviewActions` Esc handler racing the App-level `?` handler — LOW

**What goes wrong:** When a ReviewPage confirm dialog is open AND the user presses `?`, both the dialog's Esc-to-close AND the App-level `?` handler could fire.

**Mitigation:**

- `?` is not `Escape` — they're distinct keys. The risk is moot. (Verified in `ReviewActions.tsx:103-114`: confirm dialog listens for `Escape`, not `?`.)
- For Esc safety: the App-level handler does NOT register an `Escape` handler. Esc remains the route-component's job (CommandView clears selection; ReviewPage closes confirm; TaskDetail goes back to list).

### R-04 — Phase 4's `useReviewQueue` 5s polling racing the `j`/`k` row-focus state — LOW

**What goes wrong:** When the queue refreshes mid-keystroke, `rows` re-orders and `focusIdx` now points at a different row.

**Mitigation:**

- Track focus by `row.taskRef.uid` (stable across refreshes), NOT by index. On refresh, recompute `focusIdx = rows.findIndex(r => r.taskRef.uid === focusedUid)`; fall back to `0` if not found.
- This is the standard React-list-with-stable-keys pattern. Document it in the ReviewPage extension code comment.

### R-05 — COMMAND-CENTER-CONTRACT.md Prime Directive regression (D7 binding) — MEDIUM

**What goes wrong:** A plan author adds UI-only state to `SelectionActions` or the `o`-key handler — e.g., a "scroll history" array that's not source-bound.

**Mitigation:**

- `SelectionActions` reads ONLY `selection.keys` (already source-bound via the canvas-render sites), `snapshot.tasks`/`layout.agents` (source-bound from `/api/tasks` and `/api/agents`), and emits camera-pan actions on substrate-bound camera state. No UI-only world state.
- The `o`-key handler reads `selection.focus.{kind,key}` (already source-bound) and emits hash changes (no new state).
- The plan-checker / verifier-Job for Phase 5 grep for new `useState` calls in `command/SelectionActions.tsx` — any new state must be transient (popover-open flag is OK) or render-derived. Persistent world state is forbidden.

### R-06 — Phase 2's source-binding enum (CC-01) breakage — LOW

**What goes wrong:** A plan adds a new `SourceFieldName` enum member for `SelectionActions` button labels.

**Mitigation:**

- CONTEXT.md D-02 + D-04 explicitly say: NO new enum members in `source-binding.ts`. Plan-checker greps for new enum additions in this file.

### R-07 — Replay annotation collision with existing operator-managed labels — LOW

**What goes wrong:** The 5 `replay-*` annotations could collide with an existing operator-set annotation on the new AgentTask.

**Mitigation:**

- The new AgentTask is freshly created by the replay handler. The operator's reconciler does NOT touch `metadata.annotations` at creation time (verified by reading `routes/tasks.ts:199-217` — current POST handler doesn't set `metadata.annotations` at all). Phase 5 is the first writer for this CR.
- The `kagent.knuteson.io/*` reserved-prefix guard (`validators.ts:195`) protects against operator-supplied colliding annotations on the request body. The 5 replay annotations are server-generated, never operator-supplied.

### R-08 — `defaultGenerateName()` collision risk on `replay-${nanoid8}` — VERY LOW

**What goes wrong:** Two operators replay the same task within ~5e7^(-1) attempts and both pick the same nanoid8 suffix → K8s returns 409 Conflict.

**Mitigation:**

- Existing pattern at `tasks.ts:92-101` ALREADY uses `crypto.getRandomValues` (not `Math.random`), giving a 36^8 = ~2.8e12 keyspace. The existing 409 path at L245-250 surfaces the conflict cleanly to the user.
- Parameterize `defaultGenerateName()` to accept a prefix; replay calls it with `'replay'`.

### R-09 — Phase 3's `attention` flow gauge breakage — VERY LOW

**What goes wrong:** Phase 3's `attention` flow gauge in `flows.ts:290-314` reads `reviewQueueRowCount` from `CommandSnapshot`. If Phase 5's ReviewPage extension somehow corrupts the snapshot (e.g., row-focus state leaks into snapshot), the gauge breaks.

**Mitigation:**

- Row-focus state lives in `ReviewPage`'s local component state, not in the snapshot. The snapshot is derived from `/api/review-queue` via `useReviewQueue()` and is read-only from the ReviewPage's perspective.
- Verify in code review: `useState` in ReviewPage MUST NOT leak into `CommandSnapshot`.

### R-10 — Pre-commit hook drift (Node 22 requirement) — LOW

**What goes wrong:** A plan author commits with Node 20 in their shell; pre-commit hook bails out.

**Mitigation:**

- Per CONTEXT.md anchor #11: `source ~/.nvm/nvm.sh && nvm use 22` before any commit. The plan should include this in its prerequisites note.

### R-11 — `gh pr create` ≠ `gh pr merge` regression — LOW

**What goes wrong:** A subagent auto-merges a Phase 5 PR.

**Mitigation:**

- Per CLAUDE.md + memory `feedback_auto_push.md`: `gh pr create` and `gh pr merge` are NOT a unit. Per-PR explicit consent. The plan checklists must NOT include `gh pr merge` actions.

### R-12 — Hidden snapshot-test churn from React 19 hash-route change — LOW

**What goes wrong:** Phase 5's hash-route navigation tests trigger React 19 re-renders that change `cc-reload.test.tsx`'s rendered tree.

**Mitigation:**

- The hash-route tests do not run inside the CommandView render tree; they assert against `window.location.hash` directly.
- IF cc-reload.test.tsx breaks for an unrelated reason, single-commit snapshot regen per LM-8.

---

## 7. Architectural Responsibility Map

Phase 5 is a multi-package change. Each capability maps to its standard architectural tier.

| Capability                                                                        | Primary Tier                          | Secondary Tier            | Rationale                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| App-wide hotkey scheme + chord state machine                                      | Browser / Client (workbench-ui)       | —                         | Pure UX — no server interaction; only side effect is `window.location.hash` mutation.                                                        |
| Per-route context hotkeys (TaskDetail `t`, ReviewPage `j/k/a/r`, CommandView `o`) | Browser / Client (workbench-ui)       | —                         | Reads existing route-component state; emits hash changes or existing-flow invocations.                                                       |
| `HotkeyCheatSheet` modal                                                          | Browser / Client (workbench-ui)       | —                         | Renders static const array; no substrate read.                                                                                               |
| `docs/HOTKEYS.md` cheat sheet                                                     | Documentation                         | —                         | Developer reference; not a substrate primitive.                                                                                              |
| Multi-select `SelectionActions` popover                                           | Browser / Client (workbench-ui)       | —                         | Reads existing `SelectionState` + `CommandSnapshot`; no server interaction beyond `window.open` to existing routes.                          |
| TaskList `?targetAgent=` filter                                                   | Browser / Client (workbench-ui)       | —                         | URL-param-driven filter on existing `/api/tasks` data.                                                                                       |
| Replay-from-context UI (ReplayModal)                                              | Browser / Client (workbench-ui)       | —                         | Modal form; calls existing `createTask()` with extended body.                                                                                |
| Replay-from-context server (POST `/api/tasks` extension)                          | API / Backend (workbench-api)         | —                         | Additive 5-step handler branch on existing POST `/api/tasks`. Reads `SnapshotCache`; writes via `customApi.createNamespacedCustomObject`.    |
| `task.replay.created` audit event                                                 | Audit-events package (shared types)   | API / Backend (emit site) | Type lives in `@kagent/audit-events`; emission site is `workbench-api/routes/tasks.ts`.                                                      |
| `validateReplayOf` sub-helper                                                     | API / Backend (workbench-api)         | —                         | Pure validation; no I/O.                                                                                                                     |
| `replay-of` annotation chain on AgentTasks                                        | Database / Storage (K8s etcd via CRD) | —                         | The substrate-observable signal lives on `AgentTask.metadata.annotations`. Workbench API materializes; informer cache reflects; UI consumes. |
| Discoverability footer in COMMAND-CENTER-CONTRACT.md                              | Documentation                         | —                         | Single-line link; not a contract revision.                                                                                                   |
| `docs/SUBSTRATE-V1.md` §4.3 catalog row                                           | Documentation                         | —                         | Audit-event catalog reference.                                                                                                               |

**Why this matters:** Misassignment risk for Phase 5 is LOW because every capability has an obvious tier. The one risk to flag is **putting replay-resolution logic in the UI** — the UI MUST NOT iterate over `/api/tasks` to find the original task; the server's SnapshotCache is the authoritative resolver. The plan must enforce: the UI sends `replayOf.taskRef.{namespace, name, uid?}` and the SERVER resolves.

---

## 8. Standard Stack

All Phase 5 work uses packages already installed and verified in-tree. No new external deps.

### Core

| Library                 | Version                          | Purpose                     | Source                                            |
| ----------------------- | -------------------------------- | --------------------------- | ------------------------------------------------- |
| TypeScript              | strict mode, ESM, Node 22 target | Source language             | `[VERIFIED: tsconfig.build.json + CLAUDE.md]`     |
| React                   | 19.0.0                           | UI framework                | `[VERIFIED: packages/workbench-ui/package.json]`  |
| Hono                    | 4.6.14                           | HTTP router (workbench-api) | `[VERIFIED: packages/workbench-api/package.json]` |
| @kubernetes/client-node | 1.4.0                            | K8s API client              | `[VERIFIED: packages/workbench-api/package.json]` |

### Testing

| Library                   | Version | Purpose                             | Source                                            |
| ------------------------- | ------- | ----------------------------------- | ------------------------------------------------- |
| Vitest                    | 4.1.4   | Test runner                         | `[VERIFIED: packages/workbench-ui/package.json]`  |
| jsdom                     | 27.0.1  | DOM emulator for workbench-ui tests | `[VERIFIED: packages/workbench-ui/package.json]`  |
| @testing-library/react    | 16.3.0  | Component testing                   | `[VERIFIED: packages/workbench-ui/package.json]`  |
| @testing-library/jest-dom | 6.9.1   | DOM matchers                        | `[VERIFIED: packages/workbench-ui/package.json]`  |
| @vitest/coverage-v8       | 4.1.4   | Coverage                            | `[VERIFIED: packages/workbench-ui/package.json]`  |
| tsx                       | 4.21.0  | TS execution (workbench-api dev)    | `[VERIFIED: packages/workbench-api/package.json]` |

### No New Dependencies

Phase 5 ships ZERO new package.json dep changes. Per CLAUDE.md and CONTEXT.md D-04: no new sound packs, no new FX libraries, no new UI frameworks, no new validation libraries (zod is intentionally absent per `validators.ts:8-15`).

---

## 9. Architecture Patterns

### 9.1 System Architecture (data flow)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Operator's browser                                                   │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Window-level keydown listener (App.tsx via useGlobalHotkeys)  │  │
│  │  ┌──────────────┐                                              │  │
│  │  │ chord state  │ idle → awaitingChord → idle (1500ms timeout) │  │
│  │  └──────────────┘                                              │  │
│  │       │                                                        │  │
│  │       ▼ dispatch                                               │  │
│  │  window.location.hash = '#/<route>'  ── existing route         │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  Route components (TaskList / TaskDetail / GatewayPage / ClusterPage /│
│                    CommandView / ReviewPage)                          │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Per-route keydown extensions                                  │  │
│  │  - TaskDetail: t → open traceLink.url                          │  │
│  │  - ReviewPage: j/k/a/r/Esc → row focus + accept/reject flow    │  │
│  │  - CommandView: o → open detail (extends L660-809 handler)     │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  CommandView                                                   │  │
│  │  ┌────────────────────────────────────────────────────────┐    │  │
│  │  │ <SelectionActions selection layout snapshot ...> ──┐   │    │  │
│  │  │  (mounts when selection.keys.size >= 2)            │   │    │  │
│  │  │  ┌─ "Open N in tabs"  ─→ window.open(...) × N      │   │    │  │
│  │  │  ├─ "Copy N IDs"      ─→ navigator.clipboard       │   │    │  │
│  │  │  └─ "Scroll to fail"  ─→ easeCameraTo(cameraRef)   │   │    │  │
│  │  └────────────────────────────────────────────────────┘   │    │  │
│  │                                                            │    │  │
│  │  alongside existing <FlowOverlay/PressureOverlay/Disp...>  │    │  │
│  └────────────────────────────────────────────────────────────┴────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  TaskDetail                                                    │  │
│  │  <ReviewActions task />  <ReplayButton task /> ──┐             │  │
│  │                                                  ▼             │  │
│  │                                          <ReplayModal>         │  │
│  │                                          - fetchAgents()       │  │
│  │                                          - createTask({...replayOf}) ──┐
│  └────────────────────────────────────────────────────────────────┘  │  │
└──────────────────────────────────────────────────────────────────────┘  │
                                                                          │
                                                            HTTP POST    │
                                                                          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  workbench-api (Node 22 + tsx)                                            │
│                                                                          │
│  POST /api/tasks                                                         │
│  ├─ validateCreateTaskBody (extended with validateReplayOf)              │
│  ├─ if (req.replayOf) {                                                  │
│  │    Step 1: SnapshotCache.getTask(ns, name) → 422 on miss              │
│  │    Step 2: UID cross-check → 422 on mismatch                          │
│  │    Step 3: Build 5 replay-* annotations                               │
│  │    Step 4: customApi.createNamespacedCustomObject (existing)          │
│  │    Step 5: emit task.replay.created audit event                       │
│  │  } else { existing happy path }                                       │
│  └─ Response: 201 with createdAt, namespace, name, uid + _links          │
│                                                                          │
│                                                                          ▼
│  K8s API server  →  AgentTask CR with metadata.annotations:              │
│                       kagent.knuteson.io/replay-of: ns/name              │
│                       kagent.knuteson.io/replay-of-uid: uid              │
│                       kagent.knuteson.io/replay-reason: ≤256 chars       │
│                       kagent.knuteson.io/replay-decided-by: user-id      │
│                       kagent.knuteson.io/replay-decided-at: ISO-8601     │
│                                                                          │
│  audit-events publisher  →  NATS JetStream `audit` stream                │
│                              CloudEvent { type: 'task.replay.created' }  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Recommended Project Structure (delta only — additions to existing tree)

```
packages/workbench-ui/src/
├── App.tsx                          # EXTEND: mount HotkeyCheatSheet + useGlobalHotkeys
├── hotkeys.ts                       # NEW: chord state machine + isTextTarget + cheat-sheet const
├── hotkeys.test.ts                  # NEW
├── HotkeyCheatSheet.tsx             # NEW
├── HotkeyCheatSheet.test.tsx        # NEW
├── HotkeyCheatSheet.module.css      # NEW
├── ReplayModal.tsx                  # NEW
├── ReplayModal.test.tsx             # NEW
├── ReplayModal.module.css           # NEW
├── useAlert.ts                      # NEW (if planner adopts shared util)
├── TaskDetail.tsx                   # EXTEND: keydown for `t`; mount Replay button at L106
├── ReviewPage.tsx                   # EXTEND: keydown for j/k/a/r/Esc; focus state
├── TaskList.tsx                     # EXTEND: ?targetAgent=<name> query-param filter
├── api.ts                           # EXTEND: createTask body includes optional replayOf
├── types.ts                         # EXTEND: CreateTaskRequest.replayOf
└── command/
    ├── CommandView.tsx              # EXTEND: keydown for `o`; mount <SelectionActions/>; import isTextTarget from ../hotkeys
    ├── SelectionActions.tsx         # NEW
    ├── SelectionActions.test.tsx    # NEW
    └── SelectionActions.module.css  # NEW

packages/workbench-api/src/
├── routes/
│   ├── tasks.ts                     # EXTEND: 5-step replay branch in POST handler
│   ├── tasks.test.ts                # EXTEND: replay tests
│   ├── validators.ts                # EXTEND: validateReplayOf sub-helper
│   └── validators.test.ts           # EXTEND: replayOf shape tests
└── types-write.ts                   # EXTEND: ReplayOfReference + optional replayOf on CreateTaskRequest

packages/audit-events/src/
├── event-types.ts                   # EXTEND: TASK_REPLAY_CREATED const + ALL_EVENT_TYPES grow 53→54
├── types.ts                         # EXTEND: 'task.replay.created' union + TaskReplayCreatedData
└── types.test.ts                    # EXTEND: type-only cross-check

docs/
├── HOTKEYS.md                       # NEW: developer-facing cheat sheet (living doc)
├── COMMAND-CENTER-CONTRACT.md       # EXTEND: single-line discoverability footer link to HOTKEYS.md
└── SUBSTRATE-V1.md                  # EXTEND: §4.3 catalog row for task.replay.created
```

### 9.3 Pattern 1: Vim-style chord state machine

**What:** Two-state machine with timed transitions for the `g <letter>` namespace.
**When to use:** Any global keybinding where a single letter (g) would collide with a route-local hotkey OR a browser shortcut.

**Example:**

```ts
// hotkeys.ts (illustrative; planner authors actual implementation)
type ChordState = { kind: 'idle' } | { kind: 'awaitingChord'; startedAt: number };

const CHORD_TIMEOUT_MS = 1500;

const NAV_CHORDS: Record<string, string> = {
  t: '#/', // tasks
  g: '#/gateway',
  c: '#/command',
  k: '#/cluster',
  r: '#/review',
};

export function useGlobalHotkeys(opts?: { onOpenCheatSheet: () => void }): void {
  const stateRef = useRef<ChordState>({ kind: 'idle' });
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // ignore modifiers
      const k = e.key.toLowerCase();

      // ? handler
      if (e.key === '?') {
        if (window.location.hash === '#/command') return; // CommandView owns ?
        opts?.onOpenCheatSheet?.();
        sound.click();
        // cancel any in-flight chord
        stateRef.current = { kind: 'idle' };
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        return;
      }

      const state = stateRef.current;
      if (state.kind === 'idle') {
        if (k === 'g') {
          stateRef.current = { kind: 'awaitingChord', startedAt: Date.now() };
          timeoutRef.current = window.setTimeout(() => {
            stateRef.current = { kind: 'idle' };
            timeoutRef.current = null;
            // silent — no toast
          }, CHORD_TIMEOUT_MS);
        }
        return;
      }

      // awaitingChord
      if (e.key === 'Escape') {
        stateRef.current = { kind: 'idle' };
        if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        return;
      }
      const dest = NAV_CHORDS[k];
      if (dest !== undefined) {
        window.location.hash = dest;
        sound.click();
      }
      // any non-match (including unrecognized letters) silently returns to idle
      stateRef.current = { kind: 'idle' };
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, [opts]);
}
```

### 9.4 Pattern 2: 5-step replay handler

**What:** Server-side guard ladder for the replay branch of POST `/api/tasks`.
**When to use:** Whenever a CRD-creation handler needs to validate a reference to an existing CRD instance before writing.

**Example (sketch — planner authors actual implementation):**

```ts
// routes/tasks.ts — extended POST handler
if (req.replayOf !== undefined) {
  // Step 1: resolve
  const resolved = deps.cache.getTask(req.replayOf.taskRef.namespace, req.replayOf.taskRef.name);
  if (resolved === undefined) {
    return c.json(
      {
        error: 'replayOf.taskRef not found in SnapshotCache',
        fields: [{ field: 'replayOf.taskRef', code: 'missing' }],
      },
      422,
    );
  }
  // Step 2: UID cross-check
  if (
    req.replayOf.taskRef.uid !== undefined &&
    resolved.metadata.uid !== req.replayOf.taskRef.uid
  ) {
    return c.json(
      {
        error: 'replayOf.taskRef UID mismatch — original task may have been renamed or recreated',
        fields: [{ field: 'replayOf.taskRef.uid', code: 'mismatch' }],
      },
      422,
    );
  }
  // Step 3: build annotations
  const decidedBy = c.req.header('X-Forwarded-User');
  if (decidedBy === undefined || decidedBy.length === 0) {
    return c.json(
      { error: 'X-Forwarded-User header required for replay (per phase-5 D-03 strictness)' },
      401,
    );
  }
  const annotations = {
    'kagent.knuteson.io/replay-of': `${resolved.metadata.namespace}/${resolved.metadata.name}`,
    'kagent.knuteson.io/replay-of-uid': resolved.metadata.uid ?? '',
    'kagent.knuteson.io/replay-decided-by': decidedBy,
    'kagent.knuteson.io/replay-decided-at': new Date().toISOString(),
    ...(req.replayOf.reason !== undefined && {
      'kagent.knuteson.io/replay-reason': req.replayOf.reason,
    }),
  };
  // Step 4: build manifest (copy fields from resolved + override targetAgent + new name + annotations)
  // Step 5: customApi.createNamespacedCustomObject (existing K8s error ladder applies)
  // Step 6: emit audit event task.replay.created (after successful 201)
}
```

### 9.5 Anti-Patterns to Avoid

- **Anti-pattern:** Resolving the original task via a `fetchTask(ns, name)` from the browser BEFORE submitting. ❌
  - **Why it's bad:** Two-step UI flow (fetch then create) creates a TOCTOU window where the original could be renamed/deleted between fetch and create. The server-side SnapshotCache resolve is atomic with the create — single round-trip.
  - **Do this instead:** UI sends `replayOf.taskRef.{namespace, name, uid?}` once; server resolves + creates atomically.

- **Anti-pattern:** Per-task `modelClass` override on AgentTaskSpec. ❌
  - **Why it's bad:** D2 violation (schema change deferred to future research). The WB-03 "different model class" requirement is delivered by switching to a different Agent that carries the desired modelClass.
  - **Do this instead:** Operator picks a different `targetAgent` from `/api/agents`.

- **Anti-pattern:** Storing chord state in a React state (`useState`) instead of `useRef`. ❌
  - **Why it's bad:** State updates trigger re-renders; the chord is a transient input-handler-internal value. The keydown listener registered in `useEffect` would see stale state if you `useState`-d the chord.
  - **Do this instead:** `useRef` for the chord state; the listener mutates the ref directly.

- **Anti-pattern:** Adding a `bulk-` action that mutates state. ❌
  - **Why it's bad:** REQUIREMENTS.md §3 lock; CONTEXT.md D-02. Bulk-mutate is forbidden until the underlying CRD write path explicitly supports it.
  - **Do this instead:** Multi-select operations are read-only. To mutate, operator opens the detail view and acts per-task.

- **Anti-pattern:** New CRD field, new audit-event channel, new sound, new FX type. ❌
  - **Why it's bad:** Every one violates a specific lock (D2 / CONTEXT.md D-04 / RTS-feel-as-usability rule).
  - **Do this instead:** Reuse `kagent.knuteson.io/<key>` annotation; reuse existing audit publisher; reuse `sound.{click, taskComplete, taskFailed}`; reuse `easeCameraTo`.

- **Anti-pattern:** Rendering operator-supplied `replay-reason` via raw HTML injection. ❌
  - **Why it's bad:** XSS risk. Operator could embed script content in the reason field.
  - **Do this instead:** Render as JSX text node only — React's automatic HTML-entity escaping is the XSS defense. Phase 4's `ReviewActions.tsx` L26-28 documents this rule and Phase 5 inherits it.

---

## 10. Don't Hand-Roll

| Problem                                    | Don't Build       | Use Instead                                                                                            | Why                                                                                                       |
| ------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| URL hash routing                           | New router        | Existing `useHashRoute`/`parseHash` in `App.tsx:60-99`                                                 | Hand-rolled hash router is intentional (App.tsx docblock); adding react-router for 6 routes is gratuitous |
| Modal backdrop / Esc-to-close / aria-modal | New modal lib     | `NewTaskModal` pattern at L119-228                                                                     | Pattern is proven across NewTaskModal + ReviewActions confirm; mirror it exactly                          |
| K8s name validation                        | New regex         | `K8S_NAME_RE` / `K8S_NAMESPACE_RE` at `validators.ts:62/65`                                            | Already proven against RFC1123                                                                            |
| Audit event factory                        | New factory       | `makeEvent` in `packages/audit-events/src/make-event.ts`                                               | Already typed against the discriminated union                                                             |
| `X-Forwarded-User` extraction              | New auth          | `c.req.header('X-Forwarded-User')` per `routes/stream.ts:98`                                           | Existing posture (H17 spoofable acknowledged)                                                             |
| K8s error → HTTP status                    | New error mapper  | `extractK8sStatus` exported at `tasks.ts:349`                                                          | Already proven, lifted in Plan 04-03                                                                      |
| Camera panning                             | New camera lib    | `easeCameraTo(cam, ox, oy, zoom, durationMs, nowMs)` at `camera.ts:81`                                 | Existing tween engine handles all the math                                                                |
| Validation error shape                     | New error type    | `ValidationError` union at `validators.ts:20-37`                                                       | Existing 7-variant union covers all replay validation cases                                               |
| Toast / transient alert                    | New toast lib     | Existing `alertText` + `setTimeout` pattern (CommandView L737-738); optionally lift to `useAlert` hook | Global toast bus is OUT OF SCOPE per CONTEXT.md `<deferred>`                                              |
| Clipboard fallback                         | New clipboard lib | `navigator.clipboard.writeText(...)` + `<textarea readonly>` fallback                                  | Browser-native; ~15 LOC                                                                                   |
| Component test scaffolding                 | New test util     | `@testing-library/react render(...)` + `getByRole/queryByTestId`                                       | Already proven across `ReviewPage.test.tsx` / `DispositionOverlay.test.tsx`                               |

**Key insight:** Every Phase 5 deliverable has a direct in-tree analog or reusable helper from Phases 1–4. Phase 5 is THE PHASE where pattern fidelity matters most — the planner's job is to MIRROR (not invent).

---

## 11. Common Pitfalls

### Pitfall 1: Chord timeout `setTimeout` not cleared on unmount

**What goes wrong:** A pending chord timeout fires after the App unmounts → "Can't perform a React state update on an unmounted component" warning.

**Why it happens:** Forgetting to `clearTimeout(timeoutRef.current)` in the `useEffect` cleanup.

**How to avoid:** The cleanup function returned by the `useEffect` must include `if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);`.

**Warning signs:** Test warnings about state updates on unmounted components; flaky CI runs.

### Pitfall 2: `isTextTarget` not the FIRST check

**What goes wrong:** Operator typing `g` inside a textarea triggers a navigation chord.

**Why it happens:** Adding `isTextTarget` later in the handler instead of as the first guard.

**How to avoid:** Convention from CommandView L662-674 — `isTextTarget` is ALWAYS the first `if` in any keydown handler. Codify it by making `useGlobalHotkeys` itself bail out early.

**Warning signs:** Tests where typing into an input box accidentally triggers a hotkey.

### Pitfall 3: `?targetAgent=<name>` parsed from `window.location.search` instead of hash

**What goes wrong:** The query-param parser reads `window.location.search`, which is empty for hash-routes (`#/?targetAgent=X` puts `?targetAgent=X` INSIDE the hash, not in the search string).

**Why it happens:** Habit; URLSearchParams is usually applied to `location.search`.

**How to avoid:** Parse via `new URLSearchParams(window.location.hash.split('?')[1] ?? '')`.

**Warning signs:** TaskList test fails because the filter is never applied.

### Pitfall 4: Replay annotation collision with K8s admission

**What goes wrong:** The K8s API server rejects the replay manifest because an `kagent.knuteson.io/*` annotation is "reserved" by a validating webhook.

**Why it happens:** A future operator validating webhook (not in v0.2, but theoretically) could lock the `kagent.knuteson.io/*` annotation namespace.

**How to avoid:** Verify in code review: no validating webhook on AgentTasks today. The 5 replay annotations match Phase 4's `review-decision` annotations' prefix-pattern — Phase 4 ships them successfully, so Phase 5 is safe.

**Warning signs:** K8s API returns 422 (Invalid) with admission-webhook error text.

### Pitfall 5: ReplayModal "Original message" preview not properly escaped

**What goes wrong:** Operator's `originalUserMessage` contains script-like text; if rendered without escaping → XSS.

**Why it happens:** Using a raw HTML-injection prop instead of JSX text nodes.

**How to avoid:** Render `detail.originalUserMessage` as a JSX text node only (`{detail.originalUserMessage}` inside a `<pre>` or `<p>`). React's automatic HTML-entity escaping is the defense. Phase 4's `ReviewActions.tsx` L26-28 documents this rule; Phase 5 inherits.

**Warning signs:** Test where prompt = `<script>alert(1)</script>` renders the tag text instead of executing.

### Pitfall 6: `j`/`k` keys colliding with text-input typing in ReviewPage

**What goes wrong:** If a confirm dialog opens with a textarea (it doesn't today, but could), typing `j`/`k` triggers row navigation.

**Why it happens:** Forgetting `isTextTarget` in the new ReviewPage keydown listener.

**How to avoid:** Import `isTextTarget` from `hotkeys.ts` and check it first in the new keydown handler — same as the App-level global handler.

**Warning signs:** Operator types in a future search box on ReviewPage and the focused row moves.

### Pitfall 7: Replay UID-cross-check false negative when `replayOf.taskRef.uid` is absent

**What goes wrong:** Operator opens TaskDetail of an old task; the original task gets renamed/recreated between modal-open and submit; the replay's `taskRef.uid` is stale or absent → replay points at the wrong original.

**Why it happens:** The UI sends `replayOf.taskRef.uid` from the modal-open-time snapshot; the server doesn't error if it matches OR if it's absent.

**How to avoid:** UI ALWAYS sends `taskRef.uid` (from `detail.uid` at modal open time). Server's Step 2 (UID cross-check) protects against rename. Test: UID mismatch → 422.

**Warning signs:** Replay annotation chain shows an unexpected `replay-of` value.

### Pitfall 8: Pre-existing CommandView keydown handler deps drift

**What goes wrong:** Adding `o` to the existing `useEffect` at L673 changes the dependency array `[popover, selection, muted]` (currently L809). If the planner forgets to add new deps for the `o` handler (e.g., a route-change side effect), the handler closes over stale state.

**Why it happens:** Each keydown branch can capture different state.

**How to avoid:** The `o` handler reads `selection.focus.{kind,key}` — already in deps. No new deps needed. Verify in code review.

**Warning signs:** `o` opens a stale TaskDetail (wrong task) after a selection change.

---

## 12. Code Examples (verified from in-tree)

### 12.1 `isTextTarget` lift (from CommandView L662-671 → `hotkeys.ts`)

```ts
// packages/workbench-ui/src/hotkeys.ts
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Returns true when the keydown target is a text input — INPUT, TEXTAREA,
 * SELECT, or any contenteditable element. Every keydown handler in the
 * Workbench MUST call this as its first guard so typing into a form
 * doesn't trigger global hotkeys.
 *
 * Lifted from CommandView.tsx L662-671 in Phase 5 (WB-01).
 */
export function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
```

### 12.2 `validateReplayOf` sub-helper (sketch — extends `validators.ts`)

```ts
// packages/workbench-api/src/routes/validators.ts (additive)
import type { ReplayOfReference } from '../types-write.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REPLAY_REASON_BYTES = 256;

export function validateReplayOf(
  raw: unknown,
  errors: ValidationError[],
): ReplayOfReference | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ code: 'wrong-type', field: 'replayOf', expected: 'object' });
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (r.taskRef === null || typeof r.taskRef !== 'object' || Array.isArray(r.taskRef)) {
    errors.push({ code: 'wrong-type', field: 'replayOf.taskRef', expected: 'object' });
    return undefined;
  }
  const tr = r.taskRef as Record<string, unknown>;
  // namespace + name required, RFC1123 shape
  if (typeof tr.namespace !== 'string' || tr.namespace.length === 0) {
    errors.push({ code: 'missing', field: 'replayOf.taskRef.namespace' });
  } else if (!K8S_NAMESPACE_RE.test(tr.namespace)) {
    errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.namespace' });
  }
  if (typeof tr.name !== 'string' || tr.name.length === 0) {
    errors.push({ code: 'missing', field: 'replayOf.taskRef.name' });
  } else if (!K8S_NAME_RE.test(tr.name)) {
    errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.name' });
  }
  // uid optional, UUID shape if present
  if (tr.uid !== undefined && tr.uid !== null) {
    if (typeof tr.uid !== 'string' || !UUID_RE.test(tr.uid)) {
      errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.uid' });
    }
  }
  // reason optional, ≤256 chars no newlines
  if (r.reason !== undefined && r.reason !== null) {
    if (typeof r.reason !== 'string') {
      errors.push({ code: 'wrong-type', field: 'replayOf.reason', expected: 'string' });
    } else if (Buffer.byteLength(r.reason, 'utf8') > MAX_REPLAY_REASON_BYTES) {
      errors.push({ code: 'too-long', field: 'replayOf.reason', max: MAX_REPLAY_REASON_BYTES });
    } else if (/[\r\n]/.test(r.reason)) {
      errors.push({ code: 'invalid-name', field: 'replayOf.reason' });
    }
  }
  // Construct + return only when no errors specific to replayOf were pushed.
  // (Caller composes with the wider validateCreateTaskBody errors[] accumulator.)
  if (errors.some((e) => e.field.startsWith('replayOf'))) return undefined;
  return {
    taskRef: {
      namespace: tr.namespace as string,
      name: tr.name as string,
      ...(typeof tr.uid === 'string' && { uid: tr.uid }),
    },
    ...(typeof r.reason === 'string' && { reason: r.reason }),
  };
}
```

### 12.3 `task.replay.created` audit event (additive to `types.ts`)

```ts
// packages/audit-events/src/types.ts (additive — Phase 5)
/**
 * Phase 5 — `task.replay.created`. Emitted by workbench-api's POST /api/tasks
 * 5-step replay branch after a successful AgentTask CR creation that carries
 * the `kagent.knuteson.io/replay-of` annotation chain (WB-03).
 *
 * Carries refs to BOTH the new AgentTask (the replay) and the original
 * AgentTask (the source) so audit consumers can reconstruct replay-of-chains
 * without joining sibling events. `decidedBy` is the operator identity from
 * X-Forwarded-User (spoofable per H17, v0.2 posture); `reason` is the
 * operator's optional free-text rationale (HTML-stripped server-side).
 */
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

// Union extension:
// | { readonly type: 'task.replay.created'; readonly data: TaskReplayCreatedData }
```

---

## 13. State of the Art

| Old approach                                                      | Current approach (Phase 5)                                                    | When changed    | Impact                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-route hotkey grammar (CommandView WASD/Tab/Esc only)          | App-wide vim-style chord scheme + per-route hotkeys + unified `?` cheat sheet | Phase 5 / WB-01 | Operator can navigate across 6 routes with 2 keystrokes; trace + review queue 1 keystroke away                                                                                            |
| Single-select on Command Center sprites for inspect               | Multi-select bulk-inspect popover (3 read-only actions, cap-10 tabs)          | Phase 5 / WB-02 | Operator can compare ≥2 tasks/agents/gateways in parallel                                                                                                                                 |
| Manual re-dispatch via NewTaskModal (operator types prompt again) | Annotation-driven replay-from-context modal in TaskDetail                     | Phase 5 / WB-03 | Operator A/Bs against a different Agent in 1 click; lineage observable via `replay-of` annotation chain; audit-event `task.replay.created` makes divergence-detection (Phase 5+) possible |
| Static hotkey hint overlay inside CommandView only                | Living `docs/HOTKEYS.md` (developer-facing) + app-level cheat sheet           | Phase 5 / WB-01 | New operators discover the scheme without reading source                                                                                                                                  |

**Deprecated / outdated:** None. Phase 5 is purely additive over the v0.1 substrate + Phases 1–4. No prior pattern is replaced or removed.

---

## 14. Assumptions Log

> All claims in this research were verified in-tree. The table below lists items the planner should confirm at planning time but where the recommended option is clearly best-fit.

| #   | Claim                                                                                                                                                                                                | Section                   | Risk if Wrong                                                                                                   | Mitigation                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A1  | Replay handler should REQUIRE `X-Forwarded-User` (401 on absent), making `decidedBy` annotation effectively required. CONTEXT.md says annotation is REQUIRED; audit-event interface allows optional. | §3 / §6 R-recommendation  | If accepted as optional: `decidedBy: undefined` slips into audit stream; operator identity gap                  | Planner confirms in plan-time decision. Recommendation: require.                           |
| A2  | `useAlert` shared hook is worth lifting (≥3 callers identified).                                                                                                                                     | §3.3 question 1           | If wrong: small DRY-violation duplication across 5 routes                                                       | Planner decides at plan time; cost is ~10 LOC either way                                   |
| A3  | `defaultGenerateName()` should be parameterized with a `prefix` arg (vs new sibling helper).                                                                                                         | §3.3 question 2           | If wrong: minor API duplication                                                                                 | Planner decides at plan time                                                               |
| A4  | `TaskList` `?targetAgent=<name>` filter ships in Phase 5 (vs deferred).                                                                                                                              | §3.3 question 4           | If deferred: Agent-case of "Open all in tabs" opens unfiltered `#/`, which is operator-confusing but not broken | Planner default per CONTEXT.md: ship the filter                                            |
| A5  | `<SelectionActions>` is always-mounted-returns-null (vs conditionally rendered in JSX).                                                                                                              | §3.3 question 6           | If wrong: snapshot test churn pattern shifts                                                                    | Planner default: always-mounted (matches `ReviewActions`)                                  |
| A6  | `cc-reload.test.tsx` snapshot needs regen for `<SelectionActions>` mount.                                                                                                                            | §3.3 question 6           | If wrong: snapshot test fails CI                                                                                | Planner reserves a dedicated single-commit snapshot regen per LM-8                         |
| A7  | `ReplayModal` does NOT trigger `useReplay` ghost animation on success in v0.2.                                                                                                                       | §3.3 question 8           | If wrong: minor delight missing                                                                                 | Planner defaults to deferred                                                               |
| A8  | `?` cancels in-flight chord state when opening cheat sheet.                                                                                                                                          | §3.3 question 9           | If wrong: edge-case orphan chord state                                                                          | Planner confirms at plan time; code is ~3 LOC                                              |
| A9  | The ReplayModal's "Advanced" section (runConfig overrides, labels editor) ships hidden-by-default OR is fully deferred.                                                                              | CONTEXT.md `<discretion>` | If shipped fully: modal grows by ~80 LOC + 1–2 more tests                                                       | Planner default: defer per CONTEXT.md                                                      |
| A10 | TaskDetail "Replay" button is ALWAYS visible (not eligibility-gated).                                                                                                                                | §2.4 / CONTEXT.md D-03    | If wrong: operators can't A/B passing tasks                                                                     | CONTEXT.md D-03 explicitly says "always visible, not gated on phase"; assumption is locked |

---

## 15. Open Questions for Planner

Resolved at planning time. Cross-referenced to §3.3 and §14 above.

1. **Auth strictness** — Reject with 401 when `X-Forwarded-User` is absent on replay POST? (A1 / §6 R-recommendation). **Recommendation:** YES.

2. **`useAlert` shared util** — Lift to `packages/workbench-ui/src/useAlert.ts`? (A2 / §3.3 #1). **Recommendation:** YES, ≥5 callers identified.

3. **`defaultGenerateName(prefix)` vs sibling helper** — (A3 / §3.3 #2). **Recommendation:** parameterize the existing helper.

4. **`?targetAgent=<name>` filter on TaskList — ship in Phase 5?** (A4 / §3.3 #4). **Recommendation:** YES, ~10 LOC, unlocks Agent-case bulk-inspect.

5. **`<SelectionActions>` always-mounted vs conditional** — (A5 / §3.3 #6). **Recommendation:** always-mounted.

6. **`cc-reload.test.tsx` snapshot regen** — single dedicated commit? (A6 / §3.3 #6). **Recommendation:** YES per Phase 3/4 LM-8.

7. **ReplayModal success delight** — trigger `useReplay.start()`? (A7 / §3.3 #8). **Recommendation:** defer.

8. **Open `?` cancels in-flight chord** — (A8 / §3.3 #9). **Recommendation:** YES, ~3 LOC.

9. **ReplayModal "Advanced" section** — (A9 / CONTEXT.md `<discretion>`). **Recommendation:** defer.

10. **HotkeyCheatSheet layout** — match NewTaskModal vs 2-column? (CONTEXT.md `<discretion>`). **Recommendation:** match NewTaskModal.

11. **TaskDetail "Replayed-by" badge (inverse chain)** — (CONTEXT.md `<discretion>`). **Recommendation:** defer unless cheap. Implementation requires scanning `/api/tasks` for any task whose `metadata.annotations['kagent.knuteson.io/replay-of']` matches the current task's `ns/name` — server-side projection or client-side scan, both non-trivial. Defer.

12. **Wave count** — Phase 4 was 6 plans (5 work + 1 gap closure). Phase 5 is smaller. **Recommendation:** 3 plans + optional 4th gap-closure if code review surfaces issues.
    - **Wave 0 / Plan 01:** Scaffolding — `hotkeys.ts`/.test.ts, `HotkeyCheatSheet.tsx`/.test.tsx, `useAlert.ts`/.test.ts (if adopted), `ReplayModal.tsx`/.test.tsx, `SelectionActions.tsx`/.test.tsx, `docs/HOTKEYS.md` skeleton, audit-events extension + tests, `types-write.ts` `ReplayOfReference`, `validators.ts` `validateReplayOf` + tests. NO mounts yet; pure additions. Vitest CI green on every commit.
    - **Wave 1 / Plan 02:** Wire-up — App.tsx mount HotkeyCheatSheet + useGlobalHotkeys; TaskDetail mount Replay button + `t` handler; ReviewPage `j/k/a/r/Esc`; CommandView mount SelectionActions + `o` handler; TaskList `?targetAgent` filter; api.ts `createTask` extension; routes/tasks.ts 5-step replay branch + tests. Snapshot regen commit if `cc-reload.test.tsx` shifts.
    - **Wave 2 / Plan 03:** Docs + audit — `docs/HOTKEYS.md` filled in with every shipped hotkey; `docs/COMMAND-CENTER-CONTRACT.md` footer link; `docs/SUBSTRATE-V1.md` §4.3 catalog row; verify §11 bounds-test answer + §15 one-sentence in PLAN.md.

13. **Per-task `replayOf` chain inverse-link in TaskDetail** — see #11 above. **Recommendation:** defer.

---

## 16. Environment Availability

> Phase 5 ships substrate-side code (workbench-ui + workbench-api + audit-events). No new external dependencies. Verification runs as vitest. No homelab cluster ops required.

| Dependency                    | Required By                         | Available               | Version | Fallback       |
| ----------------------------- | ----------------------------------- | ----------------------- | ------- | -------------- |
| Node 22                       | Pre-commit hook + workbench-api dev | ✓ (developer's nvm)     | 22.x    | `nvm use 22`   |
| pnpm workspace                | All package builds + tests          | ✓                       | —       | —              |
| vitest 4.1.4                  | Tests                               | ✓ (already in dev-deps) | 4.1.4   | —              |
| jsdom 27.0.1                  | UI tests                            | ✓                       | 27.0.1  | —              |
| @testing-library/react 16.3.0 | UI tests                            | ✓                       | 16.3.0  | —              |
| TypeScript strict mode        | All packages                        | ✓                       | —       | —              |
| MIT SPDX header               | All `.ts`/`.tsx` files              | (convention)            | —       | Verifier scans |
| Conventional Commits          | Commit messages                     | (convention)            | —       | —              |
| Pre-commit hook               | All commits                         | ✓ (assumes installed)   | —       | —              |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.

---

## 17. Validation Architecture (recap)

Required section per researcher spec. See §5 above for full per-requirement test map.

### Test Framework

| Property               | Value                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Framework              | vitest 4.1.4                                                                                         |
| Config files           | `packages/workbench-ui/vite.config.ts`, `packages/workbench-api/vitest.config.ts` (verify in Wave 0) |
| UI quick run           | `pnpm -C packages/workbench-ui test`                                                                 |
| API quick run          | `pnpm -C packages/workbench-api test`                                                                |
| Audit-events quick run | `pnpm -C packages/audit-events test`                                                                 |
| Full suite             | `pnpm -r test` (from repo root)                                                                      |

### Sampling Rate

- **Per task commit:** package-scoped `pnpm -C packages/<touched> test`.
- **Per wave merge:** `pnpm -r test` (full workspace).
- **Phase gate:** `pnpm -r test` green + `docs/HOTKEYS.md` completeness review + grep for forbidden additions (no new sound methods, FX types, source-binding enum members, RBAC verbs, CRD shapes) before `/gsd-verify-work`.

### Wave 0 Gaps (test files to create alongside source files)

See §5.4 — every new source file ships with a co-located `*.test.{ts,tsx}` per CLAUDE.md convention. Extensions to existing test files (ReviewPage.test.tsx, validators.test.ts, tasks.test.ts) are additive blocks.

---

## 18. Security Domain

> No `security_enforcement` flag detected in `.planning/config.json`. Per researcher spec, treat as enabled — include this section.

### Applicable ASVS Categories

| ASVS Category         | Applies                | Standard Control                                                                                                         |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| V2 Authentication     | yes (extends existing) | Existing `X-Forwarded-User` posture from `auth.ts`; H17-acknowledged spoofable in v0.2                                   |
| V3 Session Management | no                     | No new sessions; hash-route navigation is browser-local                                                                  |
| V4 Access Control     | yes (no new verbs)     | Existing `agenttasks: [create]` RBAC covers replay; chart `actions.create=false` is the global revocation                |
| V5 Input Validation   | yes                    | New `validateReplayOf` mirrors `validateCreateTaskBody` pattern (RFC1123, byte caps, no-newlines, UUID shape)            |
| V6 Cryptography       | no                     | No new crypto; existing `crypto.getRandomValues` for nanoid suffix                                                       |
| V7 Error Handling     | yes                    | Server-side errors do NOT echo K8s API messages (Audit-rev2 L17 at `tasks.ts:263-279`); replay branch inherits this rule |
| V12 Files & Resources | no                     | No file uploads                                                                                                          |
| V13 API & Web Service | yes                    | New POST body field validates via existing validator framework; no new endpoint                                          |

### Known Threat Patterns for workbench-ui + workbench-api

| Pattern                                                                   | STRIDE                 | Standard Mitigation (Phase 5)                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XSS in `replay-reason` rendered on TaskDetail / ReviewPage                | Tampering / Disclosure | React JSX text-node escaping (default); ALSO server-side strip newlines + cap 256 bytes                                                                                                                                                 |
| XSS in original task's `originalUserMessage` preview                      | Tampering / Disclosure | React JSX text-node escaping; `<details>` collapsible wrapper                                                                                                                                                                           |
| TOCTOU on `replayOf.taskRef` (rename between modal-open and submit)       | Tampering              | Server-side UID cross-check (Step 2) — 422 on mismatch                                                                                                                                                                                  |
| Operator identity spoofing via `X-Forwarded-User`                         | Spoofing               | H17 acknowledged in v0.2; mitigated by ingress trust + audit-event durable record. NOT addressed in Phase 5 (out of scope)                                                                                                              |
| Replay creates new AgentTask under wrong namespace                        | Elevation of Privilege | Existing `chart.actions.create=false` global revocation; new task inherits same RBAC posture                                                                                                                                            |
| Annotation collision with operator-managed `kagent.knuteson.io/*` keys    | Tampering              | Existing label-validator at `validators.ts:195` rejects operator-supplied `kagent.knuteson.io/*` labels; annotations are server-generated only (operator can supply only `replayOf.reason` which goes into ONE specific annotation key) |
| Open-tabs DoS (operator selects 10000 sprites, clicks "Open all in tabs") | Denial-of-Service      | Hard-cap at 10 tabs per click (CONTEXT.md D-02); overflow → toast, no further tabs                                                                                                                                                      |
| Clipboard leak of substrate IDs (low impact)                              | Disclosure             | Operator-initiated only; IDs are not secrets                                                                                                                                                                                            |
| Hotkey activation during text entry                                       | Tampering              | `isTextTarget` first-check guard (lifted from CommandView L662-671)                                                                                                                                                                     |

---

## 19. Sources

### Primary (HIGH confidence)

- All in-repo files cited at §"Sources read" above — verified directly via `Read` tool.
- `.planning/phases/04-review-queue-projection-promotion-path/04-RESEARCH.md` — Phase 4 research for vitest gotchas + audit-event additive pattern.
- `docs/COMMAND-CENTER-CONTRACT.md` §2 Prime Directive — binding for `SelectionActions` + CommandView `o` handler (D7).
- `docs/HARNESS-LESSONS.md` §4 — `originalUserMessage` required for delegation chains; replay copies verbatim.

### Secondary (MEDIUM confidence)

- `docs/NORTH-STAR-SYSTEM-DESIGN.md` §C-game-loop — replay completes the "Better Future Work" branch (CONTEXT.md canonical_refs).
- `docs/NORTH-STAR-SYSTEM-DESIGN.md` §C-promotion-loop — replay is operator-driven, never agent-self-replay (D6 negative constraint).

### Tertiary (LOW confidence)

None — Phase 5 is sufficiently pattern-mirror-driven that all decisions trace to in-tree analogs.

---

## 20. Metadata

**Confidence breakdown:**

- **User constraints:** HIGH — copied verbatim from CONTEXT.md.
- **Existing patterns:** HIGH — every file:line reference verified directly.
- **Implementation approach:** HIGH — every new file has an in-tree analog; every extension has a documented insertion point.
- **Test strategy:** HIGH — vitest gotchas inherited from Phases 1–4 RESEARCH/SUMMARY docs.
- **Risks & landmines:** HIGH — every risk has a documented mitigation against a specific in-tree precedent.
- **Validation architecture:** HIGH — per-requirement test map covers all 3 WB-\* requirements.

**Research date:** 2026-05-10
**Valid until:** 2026-06-10 (30 days — Phase 5 is well-bounded; v0.2 milestone in progress; nothing fast-moving)

---

_Researched by: gsd-researcher / Phase 5 / WB-01 + WB-02 + WB-03_
_Planner consumes this file. Begin with §"User Constraints" and §"Phase Requirements"; cross-reference §3 for file-by-file work; honor §6 risks; verify §15 open questions at plan time._
