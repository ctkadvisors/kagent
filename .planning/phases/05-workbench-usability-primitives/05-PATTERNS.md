# Phase 5: Workbench usability primitives — Pattern Map

**Mapped:** 2026-05-10
**Files analyzed:** 27 (8 new source + 6 new tests + 3 new CSS + 1 new doc + 9 modified)
**Analogs found:** 25 / 27 (1 = vim-chord state machine has no in-tree analog — closest is CommandView L660-809; 1 = `?targetAgent` URL-param parser is a small additive — closest is the workbench-api server-side filter at `routes/tasks.ts:110`)

---

## File Classification

| New/Modified File                                                     | Role                      | Data Flow                | Closest Analog                                                                                                            | Match Quality                                                            |
| --------------------------------------------------------------------- | ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/workbench-ui/src/hotkeys.ts` (NEW)                          | util/hook                 | event-driven (keyboard)  | `CommandView.tsx:660-809` (keydown handler + `isTextTarget` L662-671)                                                     | partial — single-key dispatch precedent only; chord state machine is NEW |
| `packages/workbench-ui/src/hotkeys.test.ts` (NEW)                     | unit test                 | n/a                      | `command/source-binding.test.ts` (pure-util test shape)                                                                   | role-match                                                               |
| `packages/workbench-ui/src/HotkeyCheatSheet.tsx` (NEW)                | UI component (modal)      | render-only              | `NewTaskModal.tsx` (modal shape) + CommandView's `?` overlay (L727-728)                                                   | exact                                                                    |
| `packages/workbench-ui/src/HotkeyCheatSheet.test.tsx` (NEW)           | snapshot test             | n/a                      | `command/DispositionOverlay.test.tsx` (overlay snapshot)                                                                  | role-match                                                               |
| `packages/workbench-ui/src/HotkeyCheatSheet.module.css` (NEW)         | CSS module                | n/a                      | `NewTaskModal.module.css` (backdrop+dialog)                                                                               | exact                                                                    |
| `packages/workbench-ui/src/ReplayModal.tsx` (NEW)                     | UI component (modal+form) | request-response (POST)  | `NewTaskModal.tsx` (verbatim template)                                                                                    | exact                                                                    |
| `packages/workbench-ui/src/ReplayModal.test.tsx` (NEW)                | integration test          | n/a                      | `ReviewPage.test.tsx` (modal/confirm-dialog test shape)                                                                   | role-match                                                               |
| `packages/workbench-ui/src/ReplayModal.module.css` (NEW)              | CSS module                | n/a                      | `NewTaskModal.module.css`                                                                                                 | exact                                                                    |
| `packages/workbench-ui/src/command/SelectionActions.tsx` (NEW)        | UI component (popover)    | event-driven (clicks)    | `command/FlowOverlay.tsx` (sibling-overlay mount pattern) + `command/ReviewActions.tsx` (returns-null + onClick handlers) | exact (composite)                                                        |
| `packages/workbench-ui/src/command/SelectionActions.test.tsx` (NEW)   | unit test                 | n/a                      | `command/DispositionOverlay.test.tsx`                                                                                     | role-match                                                               |
| `packages/workbench-ui/src/command/SelectionActions.module.css` (NEW) | CSS module                | n/a                      | `command/TaskActionMenu.module.css` (corner-pinned popover)                                                               | role-match                                                               |
| `packages/workbench-ui/src/useAlert.ts` (NEW, optional)               | hook                      | event-driven (state)     | `CommandView.tsx` L738 `setAlertText(...); window.setTimeout(...)` toast pattern                                          | partial — extracted lift                                                 |
| `packages/workbench-ui/src/useAlert.test.ts` (NEW, optional)          | unit test                 | n/a                      | `command/source-binding.test.ts` style                                                                                    | role-match                                                               |
| `packages/workbench-ui/src/TaskDetail.test.tsx` (NEW)                 | integration test          | n/a                      | `ReviewPage.test.tsx`                                                                                                     | role-match                                                               |
| `packages/workbench-ui/src/TaskList.test.tsx` (NEW)                   | integration test          | n/a                      | `ReviewPage.test.tsx`                                                                                                     | role-match                                                               |
| `docs/HOTKEYS.md` (NEW)                                               | documentation             | n/a                      | `docs/FLOW-LEGEND.md` (Phase 3 living doc)                                                                                | exact                                                                    |
| `packages/workbench-ui/src/App.tsx` (MOD)                             | route shell               | event-driven             | self (L100-149) + `NewTaskModal` mount at `TaskList.tsx:113-128`                                                          | exact                                                                    |
| `packages/workbench-ui/src/CommandView.tsx` (MOD)                     | RTS canvas                | event-driven (kbd+mouse) | self (L660-809 keydown; L52-57 overlay imports)                                                                           | exact                                                                    |
| `packages/workbench-ui/src/TaskDetail.tsx` (MOD)                      | UI page                   | request-response         | self (L106 mount-site neighbor)                                                                                           | exact                                                                    |
| `packages/workbench-ui/src/ReviewPage.tsx` (MOD)                      | UI page                   | event-driven (kbd)       | self (L103-114 existing kbd listener)                                                                                     | exact                                                                    |
| `packages/workbench-ui/src/TaskList.tsx` (MOD)                        | UI page                   | request-response         | self (L34-188) + `routes/tasks.ts:110` (existing `targetAgent` query-param shape on the server)                           | exact                                                                    |
| `packages/workbench-ui/src/api.ts` (MOD)                              | API client                | request-response         | self (L138-160 `createTask` + L162-174 `CreateTaskApiError`)                                                              | exact                                                                    |
| `packages/workbench-ui/src/types.ts` (MOD)                            | type DTO                  | n/a                      | `packages/workbench-api/src/types-write.ts:15-37` (server-side mirror)                                                    | exact                                                                    |
| `packages/workbench-api/src/routes/tasks.ts` (MOD)                    | HTTP route                | CRUD (POST extension)    | self (L103-285 happy path) + `routes/review-queue.ts:340-447` (5-step audit pattern from Phase 4)                         | exact (composite)                                                        |
| `packages/workbench-api/src/routes/validators.ts` (MOD)               | pure validator            | transform                | self (`validateCreateTaskBody` L75-257)                                                                                   | exact                                                                    |
| `packages/workbench-api/src/types-write.ts` (MOD)                     | request DTO               | n/a                      | self (L15-37 `CreateTaskRequest`)                                                                                         | exact                                                                    |
| `packages/audit-events/src/event-types.ts` (MOD)                      | shared constant           | n/a                      | self (Phase 4 additions L209-212 + `ALL_EVENT_TYPES` L219-274)                                                            | exact                                                                    |
| `packages/audit-events/src/types.ts` (MOD)                            | shared types              | n/a                      | self (Phase 4 additions `ReviewAcceptedData` L940-960 + union L1114-1120)                                                 | exact                                                                    |
| `docs/COMMAND-CENTER-CONTRACT.md` (MOD)                               | doc                       | n/a                      | self (Phase 3 added `docs/FLOW-LEGEND.md` link as same pattern)                                                           | exact                                                                    |
| `docs/SUBSTRATE-V1.md` §4.3 (MOD)                                     | doc                       | n/a                      | self (Phase 4 added review-queue catalog rows)                                                                            | exact                                                                    |
| `packages/workbench-ui/src/cc-reload.test.tsx` (snapshot regen)       | regen                     | n/a                      | Phase 3/4 LM-8 single-commit regen                                                                                        | exact                                                                    |

---

## Pattern Assignments

### 1. `packages/workbench-ui/src/hotkeys.ts` (util/hook, event-driven)

**Analog:** `packages/workbench-ui/src/CommandView.tsx:660-809`

**Lift-out target — `isTextTarget` guard (CommandView.tsx L662-671):**

```tsx
const isTextTarget = (t: EventTarget | null): boolean => {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
};
```

**This MUST become an exported function in `hotkeys.ts`** and be imported by CommandView (which deletes its local copy), App.tsx's new `useGlobalHotkeys()`, ReviewPage's extended kbd handler, and TaskDetail's new kbd handler. EVERY new keydown handler MUST call `isTextTarget(e.target)` FIRST.

**Single-key dispatch precedent (CommandView.tsx L673-771) — adapt for chord state machine:**

```tsx
const onKeyDown = (e: KeyboardEvent): void => {
  if (isTextTarget(e.target)) return;
  if (!audioReady) setAudioReady(true);
  const k = e.key.toLowerCase();
  // … per-key dispatch with e.preventDefault() where needed …
};
window.addEventListener('keydown', onKeyDown);
return () => window.removeEventListener('keydown', onKeyDown);
```

**NEW pattern — vim-style `g <letter>` chord state machine (NO in-tree analog; document this carefully):**

```ts
// State machine inside useGlobalHotkeys (NEW pattern — Phase 5)
type ChordState = { kind: 'idle' } | { kind: 'awaitingChord'; timer: number };

// On 'g' (no modifier, not text target):
//   - if state.kind === 'idle' → transition to 'awaitingChord' with window.setTimeout(() => setState({kind:'idle'}), 1500)
// On any other key while state.kind === 'awaitingChord':
//   - clear timer; match against {t, g, c, k, r}; navigate via window.location.hash = '#/<route>'; sound.click()
//   - if no match → silent return to idle
// On 'Escape' while state.kind === 'awaitingChord': clear timer, return to idle (no sound)
// On Ctrl+g / Meta+g: explicit NOT a chord trigger (avoid browser-shortcut collision)
```

Reference for `sound.click()` and hash-route side effect: `App.tsx:107-109` (`window.location.hash = '#/'`) and `CommandView.tsx:707` (`sound.click()`).

**`HOTKEY_CHEAT_SHEET` const-array export shape:**

```ts
// Pattern modeled on FLOW_TYPES (command/flows.ts) — a frozen readonly array
// the component iterates and renders.
export interface HotkeyEntry {
  readonly key: string; // e.g., 'g t', '?', 'j'
  readonly scope: 'global' | 'command' | 'taskdetail' | 'review';
  readonly description: string; // e.g., 'Jump to Tasks list'
}
export const HOTKEY_CHEAT_SHEET: readonly HotkeyEntry[] = [
  /* … */
] as const;
```

---

### 2. `packages/workbench-ui/src/HotkeyCheatSheet.tsx` (UI modal)

**Analog:** `packages/workbench-ui/src/NewTaskModal.tsx` (modal shell) + `CommandView.tsx:727-728` (`?` toggle precedent)

**Modal shell pattern (NewTaskModal.tsx L119-127):**

```tsx
<div
  className={styles.backdrop}
  onClick={(e) => {
    // Clicking the backdrop (but not the dialog itself) closes.
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="ntm-title">
    <div className={styles.header}>
      <h2 id="ntm-title" className={styles.title}>
        New Task
      </h2>
      <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
        ×
      </button>
    </div>
    {/* form content */}
  </div>
</div>
```

**Esc-to-close pattern (NewTaskModal.tsx L68-76):**

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') onClose();
  };
  document.addEventListener('keydown', onKey);
  promptRef.current?.focus();
  return () => document.removeEventListener('keydown', onKey);
}, [onClose]);
```

**HotkeyCheatSheet uses identical shell** — replace title `"New Task"` → `"Keyboard Shortcuts"`; replace `<form>` with grouped sections iterating `HOTKEY_CHEAT_SHEET` filtered by `scope`; render each entry as `<kbd>{key}</kbd> {description}`.

---

### 3. `packages/workbench-ui/src/ReplayModal.tsx` (UI modal+form)

**Analog:** `packages/workbench-ui/src/NewTaskModal.tsx` — **VERBATIM template** (Esc-to-close + dropdown + submit→createTask + error mapping all reused).

**Agent dropdown prefill (NewTaskModal.tsx L47-66):**

```tsx
useEffect(() => {
  const ctrl = new AbortController();
  fetchAgents(ctrl.signal)
    .then((items) => {
      setAgents(items);
      // Pre-select the first agent so the form is one-click-from-submit
      if (items.length > 0 && targetAgent === '') {
        setTargetAgent(items[0]?.name ?? '');
      }
    })
    .catch(() => {
      /* fetch failures non-fatal */
    });
  return () => ctrl.abort();
}, []);
```

**ReplayModal deviation:** initial value of `targetAgent` is the ORIGINAL task's `detail.targetAgent` (passed in via props), so the prefill check becomes `if (items.length > 0 && targetAgent === '') setTargetAgent(props.originalTargetAgent ?? items[0]?.name ?? '')`.

**Submit + error mapping (NewTaskModal.tsx L78-117):**

```tsx
const onSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
  e.preventDefault();
  setError(null);
  setFieldErrors(new Map());
  // … field validation …
  setSubmitting(true);
  try {
    const created = await createTask({
      targetAgent: targetAgent.trim(),
      originalUserMessage,
      // … runConfig …
    });
    onSuccess({ namespace: created.namespace, name: created.name });
  } catch (err: unknown) {
    const apiErr = err as CreateTaskError | undefined;
    if (apiErr?.fields !== undefined && apiErr.fields.length > 0) {
      const m = new Map<string, string>();
      for (const f of apiErr.fields) {
        m.set(f.field, f.detail !== undefined ? `${f.code}: ${f.detail}` : f.code);
      }
      setFieldErrors(m);
      setError(apiErr.error);
    } else {
      setError(apiErr?.error ?? (err instanceof Error ? err.message : String(err)));
    }
  } finally {
    setSubmitting(false);
  }
};
```

**ReplayModal deviation:** the `createTask({...})` call adds the `replayOf` field:

```tsx
const created = await createTask({
  targetAgent: targetAgent.trim(),
  originalUserMessage: props.originalUserMessage, // copied from original task
  replayOf: {
    taskRef: {
      namespace: props.originalTaskRef.namespace,
      name: props.originalTaskRef.name,
      uid: props.originalTaskRef.uid,
    },
    ...(reason.trim().length > 0 && { reason: reason.trim() }),
  },
});
```

**Sound posture on submit (CONTEXT.md D-04 + reference `command/sound.ts:152-155 taskComplete`, `command/sound.ts:158-172 taskFailed`):**

```tsx
// On 201:
sound.taskComplete();
onSuccess({ namespace: created.namespace, name: created.name });
// On 422/503 (in catch):
sound.taskFailed();
```

---

### 4. `packages/workbench-ui/src/command/SelectionActions.tsx` (popover, event-driven)

**Analogs:**

- **Mount pattern:** `packages/workbench-ui/src/command/FlowOverlay.tsx` (sibling-overlay mount alongside DispositionOverlay/PressureOverlay)
- **Returns-null gating:** `packages/workbench-ui/src/command/ReviewActions.tsx:59-73`
- **Corner-pinned positioning:** `packages/workbench-ui/src/command/TaskActionMenu.module.css:12` (`position: absolute`) + `DispositionOverlay.module.css:16-18` (`position: absolute; right: 16px`)

**Returns-null gating (ReviewActions.tsx L59-73):**

```tsx
export function ReviewActions({ task, onDecision }: ReviewActionsProps): React.JSX.Element | null {
  const eligible = /* … 4 trigger conditions … */;
  if (!eligible) return null;
  return <ReviewActionsPanel task={task} onDecision={onDecision} />;
}
```

**SelectionActions deviation:** the gate is `selection.keys.size < 2`. Pattern:

```tsx
export function SelectionActions(props: SelectionActionsProps): React.JSX.Element | null {
  if (props.selection.keys.size < 2) return null;
  return <SelectionActionsPanel {...props} />;
}
```

**Overlay-component mount pattern (CommandView.tsx L52-57):**

```tsx
import { DispositionOverlay } from './command/DispositionOverlay.js';
import { FlowOverlay } from './command/FlowOverlay.js';
import { PressureOverlay } from './command/PressureOverlay.js';
import { Minimap } from './command/Minimap.js';
import { MissionOverlay } from './command/Mission.js';
```

`<SelectionActions />` is added to this import block and rendered in the same JSX neighborhood (in the `.canvas-wrapper` container alongside the other overlays).

**Selection-key resolution (selection.keys is `ReadonlySet<string>` per `scene.ts:59-62`):**

```tsx
// Keys map to one of three kinds:
//   - 'gateway' (sentinel — scene.ts:217 has selection.keys.has('gateway') precedent)
//   - '<ns>/<agent-name>' → layout.agents.get(key) returns AgentPosition (layout.ts:45-51)
//   - '<ns>/<task-name>'  → snapshot.tasks.get(key) returns TaskSummary
// Iterate selection.keys, classify by lookup-existence in each map.
```

**"Scroll to first failure" — uses existing `easeCameraTo` (camera.ts:81):**

```ts
// SIGNATURE: easeCameraTo(cam: Camera, offsetX: number, offsetY: number, zoom: number, durationMs: number, nowMs: number): void
// 6-arg signature — pass cameraRef.current, target screen position from layout, current zoom, ~300ms duration, performance.now().
easeCameraTo(
  cameraRef.current,
  computedOffsetX,
  computedOffsetY,
  cameraRef.current.zoom,
  300,
  performance.now(),
);
sound.click();
```

**Sound posture (CONTEXT.md D-04):** every button click → `sound.click()`. "Scroll to first failure" with no match → silent + toast (no sound).

**Source-binding posture:** NO new `data-source-field` attributes (per CONTEXT.md D-02). The popover is presentation-only over selection-state that's already source-bound at canvas-render sites. The `cc-orphan` assertion at `CommandView.tsx:72-76` scans canvas-rendered nodes; the popover is a DOM overlay outside the canvas hit-grid, so the assertion does not apply.

---

### 5. `packages/workbench-ui/src/App.tsx` (route shell — MODIFIED)

**Self-analog:** L100-149 (current route mount block).

**Where to mount `<HotkeyCheatSheet />` + install `useGlobalHotkeys()`:**

```tsx
// EXISTING pattern (App.tsx L100-101):
export function App(): React.JSX.Element {
  const route = useHashRoute();

  // PHASE 5 ADDITION — install hook + state at the top of App:
  useGlobalHotkeys(); // window-level keydown listener (handles g <route> chord + ?)
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  // useGlobalHotkeys exports a callback registration for '?' handling; wire it via a small ref or pub/sub module-level signal.

  // EXISTING route mount sites at L102-149 stay unchanged.
  // PHASE 5 ADDITION — render HotkeyCheatSheet alongside the route:
  return (
    <>
      {/* existing route switch */}
      {cheatSheetOpen ? <HotkeyCheatSheet onClose={() => setCheatSheetOpen(false)} /> : null}
    </>
  );
}
```

**Reference for state-controlled-modal mount:** `TaskList.tsx:113-128` (existing `[showNewTask, setShowNewTask]` + `{showNewTask ? <NewTaskModal … /> : null}` pattern is the canonical "modal mounted at parent with onClose=close-state" shape).

---

### 6. `packages/workbench-ui/src/CommandView.tsx` (RTS canvas — MODIFIED)

**Self-analog:** L660-809 (canonical keydown handler).

**Extension point for `o` key (insert near L727 alongside existing `?` handler):**

```tsx
} else if (e.key === '?') {
  setHintsOpen((v) => !v);
} else if (k === 'o') {
  // NEW: open detail for current selection focus
  e.preventDefault();
  if (selection.focus.kind === 'task' && selection.focus.key !== null) {
    sound.click();
    // selection.focus.key is '<ns>/<name>'
    const [ns, taskName] = selection.focus.key.split('/');
    if (ns !== undefined && taskName !== undefined) {
      window.location.hash = `#/tasks/${encodeURIComponent(ns)}/${encodeURIComponent(taskName)}`;
    }
  } else if (selection.focus.kind === 'gateway') {
    sound.click();
    window.location.hash = '#/gateway';
  } else if (selection.focus.kind === 'agent') {
    // No AgentDetail page in v0.2; silent + toast (per CONTEXT.md D-04)
    setAlertText('no Agent detail page in v0.2');
    window.setTimeout(() => setAlertText(null), 1_400);
  }
}
```

**Reference for `setAlertText(...) + window.setTimeout(...)` toast pattern (CommandView.tsx L737-738):**

```tsx
setAlertText(`group ${e.key} bound (${String(selection.keys.size)})`);
window.setTimeout(() => setAlertText(null), 1_400);
```

**Lift `isTextTarget`:** delete the local copy at L662-671 and `import { isTextTarget } from './hotkeys.js'` at the top.

**Mount `<SelectionActions />`:** in the JSX render block (alongside `<FlowOverlay />` / `<PressureOverlay />` / `<DispositionOverlay />` inside `.canvas-wrapper`).

---

### 7. `packages/workbench-ui/src/ReviewPage.tsx` (UI page — MODIFIED)

**Self-analog:** L103-114 (existing keydown listener — confirm-dialog-scoped).

**Existing pattern (confirm-dialog-scoped):**

```tsx
useEffect(() => {
  if (confirm === null) return;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      setConfirm(null);
      setDialogError(null);
    }
  };
  document.addEventListener('keydown', onKey);
  confirmButtonRef.current?.focus();
  return () => document.removeEventListener('keydown', onKey);
}, [confirm]);
```

**Phase 5 extension — split into TWO effects** (existing confirm-Esc stays; NEW page-level j/k/a/r/Esc handler added):

```tsx
// NEW Phase 5 — page-level row-focus state machine
const [focusedUid, setFocusedUid] = useState<string | null>(null);

useEffect(() => {
  const onKey = (e: KeyboardEvent): void => {
    if (isTextTarget(e.target)) return;
    if (confirm !== null) return; // confirm dialog owns kbd when open
    const idx = focusedUid !== null ? rows.findIndex((r) => r.taskRef.uid === focusedUid) : -1;
    if (e.key === 'j') {
      const next = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
      const row = rows[next];
      if (row !== undefined) {
        setFocusedUid(row.taskRef.uid);
        sound.click();
      }
    } else if (e.key === 'k') {
      const prev = idx <= 0 ? 0 : idx - 1;
      const row = rows[prev];
      if (row !== undefined) {
        setFocusedUid(row.taskRef.uid);
        sound.click();
      }
    } else if (e.key === 'a' && idx >= 0) {
      const row = rows[idx];
      if (row !== undefined) {
        sound.click();
        openConfirm(row, 'accept');
      }
    } else if (e.key === 'r' && idx >= 0) {
      const row = rows[idx];
      if (row !== undefined) {
        sound.click();
        openConfirm(row, 'reject');
      }
    } else if (e.key === 'Escape') {
      setFocusedUid(null);
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, [confirm, rows, focusedUid]);
```

**Row-focus class (extends the existing render at L196):**

```tsx
<tr
  key={row.taskRef.uid}
  className={focusedUid === row.taskRef.uid ? styles.focused : undefined}
>
```

**Stable-key-by-uid pattern justification (R-04 mitigation, see RESEARCH.md §6):** track focus by `row.taskRef.uid` (stable across 5s polling refreshes), NOT by index. On refresh, `findIndex(r => r.taskRef.uid === focusedUid)` recovers position; falls back to `0` if not found.

---

### 8. `packages/workbench-ui/src/TaskDetail.tsx` (UI page — MODIFIED)

**Self-analog:** L106 (ReviewActions mount-site neighbor).

**Existing mount (TaskDetail.tsx L102-109):**

```tsx
{
  detail !== null ? (
    <>
      {/* Phase 4 / REV-02 / D-03-A: inline review entry point */}
      <ReviewActions task={detail} onDecision={refetch} />
      <DetailBody detail={detail} />
    </>
  ) : null;
}
```

**Phase 5 addition:** sibling `<ReplayButton>` (or inline button + state-driven `<ReplayModal>` mount) added at the same level as `<ReviewActions>`. Planner picks split:

```tsx
<>
  <ReviewActions task={detail} onDecision={refetch} />
  <ReplayButton task={detail} onSubmitted={refetch} /> {/* NEW Phase 5 */}
  <DetailBody detail={detail} />
</>
```

Where `<ReplayButton>` internally manages `[modalOpen, setModalOpen]` and renders `<ReplayModal>` when open (mirroring TaskList's `[showNewTask, setShowNewTask]` pattern at TaskList.tsx:113-128).

**New `t` keydown handler (in addition to existing onBack-wired Esc):**

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent): void => {
    if (isTextTarget(e.target)) return;
    if (e.key === 't' && detail?.traceLink?.url !== undefined) {
      sound.click();
      window.open(detail.traceLink.url, '_blank');
    } else if (e.key === 't') {
      // No trace — silent + toast via useAlert
      alert('no trace for this task');
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, [detail]);
```

**Reference for `traceLink.url` field (TaskDetail.tsx L143-151):**

```tsx
{detail.traceLink?.url !== undefined ? (
  <a href={detail.traceLink.url} target="_blank" rel="noopener noreferrer" …>
    open in {detail.traceLink.provider}
  </a>
) : (
  <code>runId: {detail.traceLink.runId}</code>
)}
```

---

### 9. `packages/workbench-ui/src/TaskList.tsx` (UI page — MODIFIED)

**Self-analog:** L34-188.

**Server-side analog for `?targetAgent` query-param shape (`routes/tasks.ts:110`):**

```ts
const targetAgent = url.searchParams.get('targetAgent') ?? undefined;
// later in the filter:
if (targetAgent !== undefined && t.spec.targetAgent !== targetAgent) return false;
```

**Phase 5 extension — read the same param from the URL hash on the client:**

```tsx
// Hash format: '#/?targetAgent=X' OR '#/' (no filter)
const filterAgent = useMemo(() => {
  const queryPart = window.location.hash.split('?')[1];
  if (queryPart === undefined) return undefined;
  return new URLSearchParams(queryPart).get('targetAgent') ?? undefined;
}, []);

// Apply filter to tasks render:
const visibleTasks =
  filterAgent !== undefined ? tasks.filter((t) => t.targetAgent === filterAgent) : tasks;
```

**Note on hashchange:** the param is read once on mount in v0.2 — the filter is set when the link is opened in a new tab (the WB-02 "Open all in tabs" use case). Re-render on hashchange is NOT required for the v0.2 use case; the parent tab is unaffected by `window.open(...)` and the new tab loads fresh.

---

### 10. `packages/workbench-ui/src/api.ts` (API client — MODIFIED)

**Self-analog:** L138-160 (`createTask`) + L162-174 (`CreateTaskApiError`).

**Existing `createTask` body shape (L138-145):**

```ts
export async function createTask(req: CreateTaskRequest): Promise<CreateTaskResponse> {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  // … 201 path, then throw CreateTaskApiError …
}
```

**Phase 5 extension:** the `CreateTaskRequest` type in `types.ts` grows an optional `replayOf` field. NO change needed to the `createTask()` function body — JSON.stringify carries the new field transparently. ONLY the type changes.

---

### 11. `packages/workbench-api/src/routes/tasks.ts` (HTTP route — MODIFIED)

**Self-analog (happy path):** L143-285 (POST `/api/tasks` handler).
**Cross-route analog (5-step audit pattern):** `packages/workbench-api/src/routes/review-queue.ts:340-447` (Phase 4 accept handler).

**Existing happy path scaffold (tasks.ts L143-285):**

```ts
app.post('/api/tasks', async (c) => {
  if (deps.customApi === undefined) {
    /* 503 */
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    /* 400 */
  }

  const result = validateCreateTaskBody(raw);
  if (!result.valid || result.value === undefined) {
    /* 400 or 422 */
  }
  const req = result.value;

  const namespace = req.namespace ?? deps.defaultNamespace ?? 'default';
  const name = req.name ?? (deps.generateName ?? defaultGenerateName)();

  // Agent existence pre-check (L191-197)
  const agent = deps.cache.getAgent(namespace, req.targetAgent);
  if (agent === undefined && hasNamespaceLoadedAgents(deps.cache, namespace)) {
    /* 404 */
  }

  const manifest: Record<string, unknown> = {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name,
      namespace,
      labels: {
        'kagent.knuteson.io/managed-by': 'kagent-operator',
        'app.kubernetes.io/created-by': 'kagent-workbench-api',
        ...(req.labels ?? {}),
      },
    },
    spec: {
      targetAgent: req.targetAgent,
      originalUserMessage: req.originalUserMessage,
      payload: req.payload ?? {},
      ...(req.runConfig !== undefined && { runConfig: req.runConfig }),
    },
  };

  try {
    const created: unknown = await deps.customApi.createNamespacedCustomObject({
      /* … */
    });
    const meta = readCreatedMeta(created);
    // … response 201 …
  } catch (err: unknown) {
    const status = extractK8sStatus(err);
    if (status === 409) {
      /* 409 */
    }
    if (status === 404) {
      /* 404 */
    }
    if (status === 403) {
      /* 403 */
    }
    // … 500 fallback (no echoing apiserver error text per Audit-rev2 L17) …
  }
});
```

**Phase 5 extension — 5-step replay branch inserted AFTER validate but BEFORE the existing `agent` pre-check** (since replay needs to read the original task FIRST, then synthesize the manifest):

```ts
// AFTER: const req = result.value; (existing L180)
// NEW Phase 5 replay branch:
if (req.replayOf !== undefined) {
  // Step 1 — resolve original via SnapshotCache (fail-fast 422 on miss)
  const original = deps.cache.getTask(req.replayOf.taskRef.namespace, req.replayOf.taskRef.name);
  if (original === undefined) {
    const body: CreateTaskErrorBody = {
      error: 'replayOf.taskRef not found in SnapshotCache',
      fields: [{ field: 'replayOf.taskRef', code: 'missing' }],
    };
    return c.json(body, 422);
  }

  // Step 2 — UID cross-check (fail-fast 422 on mismatch)
  if (
    req.replayOf.taskRef.uid !== undefined &&
    original.metadata.uid !== req.replayOf.taskRef.uid
  ) {
    const body: CreateTaskErrorBody = {
      error: 'replayOf.taskRef UID mismatch — original task may have been renamed or recreated',
      fields: [{ field: 'replayOf.taskRef.uid', code: 'mismatch' as const }], // note: 'mismatch' is a new ValidationError code candidate; planner picks: extend ValidationError union OR reuse 'invalid-name'
    };
    return c.json(body, 422);
  }

  // Step 3 — build 5 replay-* annotations
  const reviewerId = c.req.header('X-Forwarded-User')?.trim();
  if (reviewerId === undefined || reviewerId.length === 0) {
    // Per RESEARCH.md §2.7 recommendation: require header (mirrors auth.ts:101)
    return c.json({ error: 'X-Forwarded-User header required for replay' }, 401);
  }
  const nowIso = new Date().toISOString();
  const annotations: Record<string, string> = {
    'kagent.knuteson.io/replay-of': `${req.replayOf.taskRef.namespace}/${req.replayOf.taskRef.name}`,
    'kagent.knuteson.io/replay-of-uid': original.metadata.uid ?? '',
    'kagent.knuteson.io/replay-decided-by': reviewerId,
    'kagent.knuteson.io/replay-decided-at': nowIso,
    ...(req.replayOf.reason !== undefined &&
      req.replayOf.reason.length > 0 && {
        'kagent.knuteson.io/replay-reason': req.replayOf.reason,
      }),
  };

  // Step 4 — synthesize the manifest from `original` (copy spec.payload, originalUserMessage,
  // runConfig.timeoutSeconds, runConfig.maxIterations, expectedTools) + operator-supplied targetAgent
  const namespace = req.namespace ?? deps.defaultNamespace ?? 'default';
  const name = req.name ?? defaultGenerateName('replay'); // planner: parameterize defaultGenerateName to accept prefix
  const manifest: Record<string, unknown> = {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name,
      namespace,
      labels: {
        'kagent.knuteson.io/managed-by': 'kagent-operator',
        'app.kubernetes.io/created-by': 'kagent-workbench-api',
        // user labels copied from original (per CONTEXT.md D-03 field-copy contract)
        ...filterUserLabels(original.metadata.labels),
      },
      annotations,
    },
    spec: {
      targetAgent: req.targetAgent, // operator override from modal
      originalUserMessage: original.spec.originalUserMessage, // copied verbatim
      payload: original.spec.payload ?? {},
      ...(original.spec.runConfig !== undefined && { runConfig: original.spec.runConfig }),
      ...(original.spec.expectedTools !== undefined && {
        expectedTools: original.spec.expectedTools,
      }),
    },
  };

  // Step 4b — call existing customApi.createNamespacedCustomObject (existing K8s error ladder applies)
  // [SAME try/catch block as the existing happy path; share the K8s error handling]

  // Step 5 — emit task.replay.created (best-effort, per Phase 4 swallow-and-log pattern)
  if (deps.auditPublisher !== undefined) {
    try {
      await deps.auditPublisher.publish(
        makeEvent({
          type: TASK_REPLAY_CREATED,
          source: 'kagent.knuteson.io/workbench-api',
          subject: `AgentTask/${namespace}/${name}`,
          data: {
            newTaskRef: { namespace, name, uid: createdMeta.uid ?? '' },
            originalTaskRef: {
              namespace: req.replayOf.taskRef.namespace,
              name: req.replayOf.taskRef.name,
              uid: original.metadata.uid ?? '',
            },
            decidedBy: reviewerId,
            ...(req.replayOf.reason !== undefined && { reason: req.replayOf.reason }),
          },
        }),
      );
    } catch (auditErr) {
      console.warn(
        `[workbench-api] task.replay.created publish failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
      );
    }
  }
  return c.json(response, 201);
}
// EXISTING non-replay happy path continues below this block.
```

**Phase 4 audit-event emission pattern (review-queue.ts L414-438) — VERBATIM template for Step 5:**

```ts
if (deps.auditPublisher !== undefined) {
  try {
    await deps.auditPublisher.publish(
      makeEvent({
        type: REVIEW_ACCEPTED,
        source: 'kagent.knuteson.io/workbench-api',
        subject: `AgentTask/${namespace}/${name}`,
        data: {
          taskRef,
          reason: row.reason,
          reviewerId,
          reasonText,
        },
      }),
    );
  } catch (auditErr) {
    logWarn(
      `review-queue: review.accepted publish failed: ${
        auditErr instanceof Error ? auditErr.message : String(auditErr)
      }`,
    );
  }
}
```

**Reusable helpers exported from tasks.ts (L349, L377):**

- `extractK8sStatus(err: unknown): number | undefined` — already exported.
- `readCreatedMeta(obj: unknown): CreatedMeta` — already exported.

Use both verbatim in the replay branch; no duplication.

**`defaultGenerateName` parameterization (tasks.ts L92-101):**

```ts
// EXISTING:
function defaultGenerateName(): string {
  // …
  return `manual-${s}`;
}
// PHASE 5 EXTENSION (per RESEARCH.md §3.3 open Q2):
function defaultGenerateName(prefix: 'manual' | 'replay' = 'manual'): string {
  // …
  return `${prefix}-${s}`;
}
```

---

### 12. `packages/workbench-api/src/routes/validators.ts` (validator — MODIFIED)

**Self-analog:** `validateCreateTaskBody` (L75-257) — the per-field shape inspection idiom.

**Existing per-field validation idiom (L84-94):**

```ts
const targetAgent = body.targetAgent;
if (targetAgent === undefined || targetAgent === null) {
  errors.push({ code: 'missing', field: 'targetAgent' });
} else if (typeof targetAgent !== 'string') {
  errors.push({ code: 'wrong-type', field: 'targetAgent', expected: 'string' });
} else if (targetAgent.length === 0) {
  errors.push({ code: 'empty', field: 'targetAgent' });
} else if (!K8S_NAME_RE.test(targetAgent)) {
  errors.push({ code: 'invalid-name', field: 'targetAgent' });
}
```

**Phase 5 extension — `validateReplayOf` sub-helper (called from `validateCreateTaskBody` when `body.replayOf` present):**

```ts
function validateReplayOf(
  raw: unknown,
  errors: ValidationError[],
): CreateTaskRequest['replayOf'] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ code: 'wrong-type', field: 'replayOf', expected: 'object' });
    return undefined;
  }
  const ro = raw as Record<string, unknown>;
  const taskRefRaw = ro.taskRef;
  if (taskRefRaw === undefined || taskRefRaw === null) {
    errors.push({ code: 'missing', field: 'replayOf.taskRef' });
    return undefined;
  }
  if (typeof taskRefRaw !== 'object' || Array.isArray(taskRefRaw)) {
    errors.push({ code: 'wrong-type', field: 'replayOf.taskRef', expected: 'object' });
    return undefined;
  }
  const tr = taskRefRaw as Record<string, unknown>;
  // namespace — required, RFC1123 namespace shape
  if (typeof tr.namespace !== 'string' || tr.namespace.length === 0) {
    errors.push({ code: 'missing', field: 'replayOf.taskRef.namespace' });
  } else if (!K8S_NAMESPACE_RE.test(tr.namespace)) {
    errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.namespace' });
  }
  // name — required, RFC1123 name shape
  if (typeof tr.name !== 'string' || tr.name.length === 0) {
    errors.push({ code: 'missing', field: 'replayOf.taskRef.name' });
  } else if (!K8S_NAME_RE.test(tr.name)) {
    errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.name' });
  }
  // uid — optional, UUID shape when present
  let uid: string | undefined;
  if (tr.uid !== undefined && tr.uid !== null) {
    if (typeof tr.uid !== 'string' || !UUID_RE.test(tr.uid)) {
      errors.push({ code: 'invalid-name', field: 'replayOf.taskRef.uid' });
    } else {
      uid = tr.uid;
    }
  }
  // reason — optional, ≤256 chars, no newlines
  let reason: string | undefined;
  if (ro.reason !== undefined && ro.reason !== null) {
    if (typeof ro.reason !== 'string') {
      errors.push({ code: 'wrong-type', field: 'replayOf.reason', expected: 'string' });
    } else if (ro.reason.length > 256) {
      errors.push({ code: 'too-long', field: 'replayOf.reason', max: 256 });
    } else if (/[\n\r]/.test(ro.reason)) {
      errors.push({ code: 'invalid-name', field: 'replayOf.reason' }); // 'invalid-name' = "doesn't match shape"; reuse
    } else {
      reason = ro.reason;
    }
  }
  if (errors.length > 0) return undefined;
  return {
    taskRef: {
      namespace: tr.namespace as string,
      name: tr.name as string,
      ...(uid !== undefined && { uid }),
    },
    ...(reason !== undefined && { reason }),
  };
}
```

**Call site in `validateCreateTaskBody`** (just before the final `if (errors.length > 0) return …` at L242):

```ts
const replayOf = validateReplayOf(body.replayOf, errors);
// …
return {
  valid: true,
  errors: [],
  value: {
    targetAgent: targetAgent as string,
    originalUserMessage: originalUserMessage as string,
    // … existing fields …
    ...(replayOf !== undefined && { replayOf }),
  },
};
```

**UUID regex (NEW const at top of validators.ts):**

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

---

### 13. `packages/workbench-api/src/types-write.ts` (request DTO — MODIFIED)

**Self-analog:** L15-37 (`CreateTaskRequest`).

**Existing shape (L15-36):**

```ts
export interface CreateTaskRequest {
  readonly targetAgent: string;
  readonly originalUserMessage: string;
  readonly namespace?: string;
  readonly name?: string;
  readonly runConfig?: {
    readonly timeoutSeconds?: number;
    readonly maxIterations?: number;
  };
  readonly labels?: Readonly<Record<string, string>>;
  readonly payload?: unknown;
}
```

**Phase 5 extension — add `ReplayOfReference` interface + optional `replayOf` field:**

```ts
export interface ReplayOfReference {
  readonly taskRef: {
    readonly namespace: string;
    readonly name: string;
    readonly uid?: string;
  };
  readonly reason?: string;
}

export interface CreateTaskRequest {
  // … existing fields …
  readonly replayOf?: ReplayOfReference;
}
```

---

### 14. `packages/audit-events/src/event-types.ts` (event-type constants — MODIFIED)

**Self-analog:** Phase 4 additions at L209-212 + ALL_EVENT_TYPES array L219-274.

**Existing Phase 4 pattern (L197-212):**

```ts
/* Phase 4 — Review queue projection + promotion path (REV-01 / REV-02).
 * Four events cover the review lifecycle:
 *   - `review.requested` — …
 *   - `review.accepted` — …
 *   - `review.rejected` — …
 *   - `template.candidate.promoted` — …
 */
export const REVIEW_REQUESTED = 'review.requested' as const;
export const REVIEW_ACCEPTED = 'review.accepted' as const;
export const REVIEW_REJECTED = 'review.rejected' as const;
export const TEMPLATE_CANDIDATE_PROMOTED = 'template.candidate.promoted' as const;
```

**Phase 5 extension — add 1 new const + 1 new entry in `ALL_EVENT_TYPES`:**

```ts
/* Phase 5 — Workbench replay-from-context (WB-03).
 * One event: emitted on POST /api/tasks when the request body carries
 * `replayOf` AND the K8s CR creation succeeds. The new AgentTask carries
 * 5 replay-* annotations (replay-of, replay-of-uid, replay-reason,
 * replay-decided-by, replay-decided-at) — this event is the audit record
 * of the operator action.
 */
export const TASK_REPLAY_CREATED = 'task.replay.created' as const;

// In ALL_EVENT_TYPES (L219-274), append at the end:
export const ALL_EVENT_TYPES = Object.freeze([
  // … existing 53 entries …
  REVIEW_REQUESTED,
  REVIEW_ACCEPTED,
  REVIEW_REJECTED,
  TEMPLATE_CANDIDATE_PROMOTED,
  /* Phase 5 — Workbench replay-from-context. */
  TASK_REPLAY_CREATED,
] as const);
```

**Sanity check:** the comment at types.ts L48 reads `Count: 53 (49 existing + 4 Phase 4 review-queue events)`. Phase 5 grows this to 54; update the comment.

---

### 15. `packages/audit-events/src/types.ts` (event-data types — MODIFIED)

**Self-analog:** Phase 4 additions — `ReviewAcceptedData` (L940-960), `TemplateCandidatePromotedData` (L995-1010), discriminated-union members (L1114-1120).

**Phase 4 `ReviewAcceptedData` shape (L940-960) — closest analog to `TaskReplayCreatedData`:**

```ts
export interface ReviewAcceptedData {
  readonly taskRef: {
    readonly namespace: string;
    readonly name: string;
    readonly uid: string;
  };
  readonly reason: /* inline union */;
  readonly reviewerId: string | undefined;
  readonly reasonText: string | undefined;
}
```

**Phase 4 `TemplateCandidatePromotedData` (L995-1010) — closest analog for the dual-ref (new + original) shape:**

```ts
export interface TemplateCandidatePromotedData {
  readonly taskRef: {
    readonly namespace: string;
    readonly name: string;
    readonly uid: string;
  };
  readonly agentTemplateRef: {
    readonly namespace: string;
    readonly name: string;
    readonly uid: string | undefined;
  };
  readonly reviewerId: string | undefined;
}
```

**Phase 5 — `TaskReplayCreatedData` (locked by CONTEXT.md D-03):**

```ts
/**
 * Phase 5 — `task.replay.created`. Emitted on every successful POST
 * /api/tasks where the request body carries `replayOf`. The new
 * AgentTask carries 5 replay-* annotations; this event is the audit
 * record of the replay operation, joining the new task to the original.
 *
 * Fires AFTER successful AgentTask CR creation. Audit-event emission
 * is best-effort (swallow-and-log per Phase 4 dispositions.ts:282-302).
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
```

**Union extensions:**

```ts
// AuditEventType union (L50-117) — append:
| 'task.replay.created'

// AuditEventData discriminated union (L1017-1120) — append:
| { readonly type: 'task.replay.created'; readonly data: TaskReplayCreatedData }
```

---

## Shared Patterns

### Authentication / Operator Identity

**Source:** `packages/workbench-api/src/auth.ts:41` + `routes/review-queue.ts:92-93,708-725`

**Apply to:** the POST `/api/tasks` replay-branch handler.

```ts
const FORWARDED_USER_HEADER = 'X-Forwarded-User';
// Inside the route handler:
const reviewerId = c.req.header(FORWARDED_USER_HEADER)?.trim();
if (reviewerId === undefined || reviewerId.length === 0) {
  return c.json({ error: 'X-Forwarded-User header required' }, 401);
}
```

Per RESEARCH.md §2.7: replay requires the header (return 401 when absent). Stricter than Phase 4's optional `review-decided-by`, matching `auth.ts:101` posture.

### Error Handling (K8s ladder)

**Source:** `packages/workbench-api/src/routes/tasks.ts:240-284` (existing happy path) + exported helper `extractK8sStatus` (L349).

**Apply to:** the replay-branch try/catch around `customApi.createNamespacedCustomObject`. Reuse the existing 409/404/403/500 ladder verbatim — no new error shapes for replay (the failure modes are the same).

### Audit-event Emission (best-effort)

**Source:** `packages/workbench-api/src/routes/review-queue.ts:414-438`.

**Apply to:** Step 5 of the replay branch.

```ts
if (deps.auditPublisher !== undefined) {
  try {
    await deps.auditPublisher.publish(
      makeEvent({
        /* … */
      }),
    );
  } catch (auditErr) {
    logWarn(
      `task.replay.created publish failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
    );
  }
}
```

Audit failure NEVER blocks the 201 response (Phase 4 swallow-and-log pattern).

### Modal Shell (Esc-to-close + backdrop-click-to-close + aria)

**Source:** `packages/workbench-ui/src/NewTaskModal.tsx:68-76,119-127`.

**Apply to:** `ReplayModal.tsx`, `HotkeyCheatSheet.tsx`.

### Returns-null UI Gating

**Source:** `packages/workbench-ui/src/command/ReviewActions.tsx:59-73`.

**Apply to:** `SelectionActions.tsx` (gate: `selection.keys.size < 2`).

### `isTextTarget` keydown guard

**Source:** `packages/workbench-ui/src/CommandView.tsx:662-671` (to be lifted into `hotkeys.ts`).

**Apply to:** EVERY new or extended keydown handler — App-level `useGlobalHotkeys()`, ReviewPage's new j/k/a/r/Esc, TaskDetail's new `t`, CommandView's extended `o`. Always FIRST check in the handler.

### Sound posture (reuse `command/sound.ts` only)

**Source:** `packages/workbench-ui/src/command/sound.ts`:

- `sound.click()` (L96) — every successful nav / button / kbd action.
- `sound.taskComplete()` (L152-155) — ReplayModal 201.
- `sound.taskFailed()` (L158-172) — ReplayModal 422/503.

**Apply to:** every new hotkey + button + modal submit per CONTEXT.md D-04 sound table. NO new sound packs, NO new sound methods.

### Living-doc footer link

**Source:** Phase 3 `docs/FLOW-LEGEND.md` discoverability link in `docs/COMMAND-CENTER-CONTRACT.md`.

**Apply to:** `docs/COMMAND-CENTER-CONTRACT.md` — single-line footer link to `docs/HOTKEYS.md`. NOT a contract revision.

### SnapshotCache lookup (fail-fast 422)

**Source:** `packages/workbench-api/src/cache.ts:84` (`getTask(namespace, name): AgentTask | undefined`).

**Apply to:** Step 1 of the replay branch. Fail-fast 422 on miss matches Phase 4's PATCH-pre-flight 404 pattern.

---

## No Analog Found

Files with no close in-tree analog (planner should use RESEARCH.md patterns AND treat the closest analog as guidance only):

| File                                                         | Role | Data Flow    | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench-ui/src/hotkeys.ts` (chord state machine) | hook | event-driven | The vim-style `g <letter>` two-key chord with a 1500ms timeout has NO in-tree precedent. CommandView's keydown handler at L660-809 is single-key dispatch only — every key path commits an action immediately on press. The closest pattern primitive is `window.setTimeout(() => setAlertText(null), 1_400)` at CommandView.tsx:738 for the "transient state with timer cleanup" idea, but the state machine itself is new. **Documented as NEW pattern** in §1 above; the planner should treat the chord machine as Phase 5's signature implementation work and target ≥75% coverage on `hotkeys.test.ts` specifically. |

---

## Metadata

**Analog search scope:**

- `packages/workbench-ui/src/**` (modal, overlay, route component, keydown handler, sound, camera, layout, scene)
- `packages/workbench-ui/src/command/**` (FlowOverlay, DispositionOverlay, ReviewActions, TaskActionMenu, sound, camera, scene, layout)
- `packages/workbench-api/src/routes/**` (tasks.ts happy path; review-queue.ts 5-step Phase 4 pattern)
- `packages/workbench-api/src/{cache,auth,types-write}.ts`
- `packages/audit-events/src/{event-types,types}.ts`
- `docs/{COMMAND-CENTER-CONTRACT,FLOW-LEGEND,SUBSTRATE-V1}.md`

**Files scanned (read):** 13 core analogs (NewTaskModal, App, CommandView, TaskDetail, ReviewPage, ReviewActions, TaskList, FlowOverlay, api.ts, tasks.ts, validators.ts, types-write.ts, event-types.ts, types.ts) + 4 reference-only files (cache.ts, auth.ts, sound.ts, camera.ts, scene.ts, layout.ts, review-queue.ts).

**Files grepped:** TaskActionMenu.module.css, DispositionOverlay.module.css, cache.ts, auth.ts, review-queue.ts (for FORWARDED_USER + audit emission + getTask shape).

**Pattern extraction date:** 2026-05-10

---

## PATTERN MAPPING COMPLETE

**Phase:** 05 — workbench-usability-primitives
**Files classified:** 27
**Analogs found:** 25 / 27 (1 NEW pattern documented for vim-chord state machine; 1 small additive for `?targetAgent` URL-param)

### Coverage

- Files with exact analog: 22
- Files with role-match analog: 4 (test scaffolds + chord-state-machine partial)
- Files with no analog: 1 (vim-chord state machine — closest reference is CommandView L660-809 single-key dispatch + transient-state-with-setTimeout idiom at L738)

### Key Patterns Identified

- **All new modals copy `NewTaskModal.tsx` verbatim** — Esc-to-close at L68-76, backdrop-click-closes at L119-126, fetchAgents prefill at L47-66, submit→createTask→CreateTaskApiError mapping at L78-117, aria-modal/aria-labelledby at L127.
- **All new keydown handlers MUST call lifted `isTextTarget` FIRST** — pattern at CommandView L662-671 is moved verbatim into `hotkeys.ts` and imported everywhere; existing CommandView local copy is deleted.
- **SelectionActions mounts as a returns-null sibling overlay** — combines FlowOverlay.tsx's mount-site pattern (CommandView L52-57 imports + same `.canvas-wrapper` JSX neighborhood) with ReviewActions.tsx L59-73's eligibility-gate-returns-null shape.
- **POST /api/tasks replay branch is a 5-step extension before the existing happy path** — Phase 4's `routes/review-queue.ts:340-447` accept-handler is the closest analog (5-step structure: validate → resolve → uid-check → patch/create → audit). Replay reuses `extractK8sStatus`/`readCreatedMeta` (exported from tasks.ts at L349/L377 by Plan 04-03 helper lifting) and the existing 409/404/403/500 error ladder verbatim.
- **Audit-event additive extension is mechanical** — `event-types.ts` adds 1 const + 1 array entry; `types.ts` adds 1 interface + 1 union member + 1 discriminator. Phase 4's 4-event addition is the verbatim template.
- **All sounds reuse `command/sound.ts`** — `click()` (L96) / `taskComplete()` (L152-155) / `taskFailed()` (L158-172). NO new sound methods, NO new sound packs.
- **`?targetAgent=<name>` filter on TaskList mirrors the server-side filter at `routes/tasks.ts:110`** — same param name, same exact-match semantics, ~10 LOC additive on the client.

### File Created

`/Users/chrisknuteson/Projects/ctkadvisors/active/kagent/.planning/phases/05-workbench-usability-primitives/05-PATTERNS.md`

### Ready for Planning

Pattern mapping complete. Planner can now reference analog patterns in PLAN.md files. The vim-chord state machine in `hotkeys.ts` is the single new pattern; everything else is verbatim or near-verbatim copy from Phase 1–4 precedents.
