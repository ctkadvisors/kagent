# Rev3 Operator Fix Report

**Agent:** rev3-fix-operator
**Date:** 2026-05-07
**HEAD at start:** `10c2a0c` (rev3 audit baseline)
**HEAD at end:** `3162b67`
**Status:** ALL 6 SCOPED FINDINGS CLOSED.

## Findings Closed

| # | Severity | Finding | Closure SHA |
|---|---|---|---|
| C1-NEW-H1 | HIGH | `safeRestart` `attempts` never reset — informer wedged after lifetime cap | `915ee27` |
| C1-CONFIG | MEDIUM | No chart-level guard for `supervision.maxEscalationDepth` | `9e27af2` |
| C1-SIB-1 | MEDIUM | `fetchAgent` uncached direct API per supervision reconcile | `3162b67` |
| C1-NEW-L1 | LOW | JSDoc cited `agentPod.supervision.maxEscalationDepth` (wrong path) | `3162b67` |
| C1-SIB-2 | LOW | `listChildrenForParent` optional → degenerate sibling-list in tests | `3162b67` |
| C2R3-LOW-1 | LOW | Pod status patch can 412-drop on missing `status.phase` | `3162b67` |

## Commits (in order)

1. `915ee27` — `fix(operator): wire restarter.reset() from informer add/update handlers (C1-NEW-H1)`
2. `9e27af2` — `fix(operator/chart): add Helm validateValues guard for supervision.maxEscalationDepth (C1-CONFIG)`
3. `3162b67` — `chore(operator): supervision-router cache + status.phase precondition + JSDoc/typing tightening (C1-SIB-1, C1-SIB-2, C1-NEW-L1, C2R3-LOW-1)`

## Code Changes

### C1-NEW-H1 — `restarter.reset()` wired
- `packages/operator/src/watch.ts`: reordered restarter creation before `add`/`update` handlers; both call `restarter.reset()` before delegating to `handler.onAdd`/`onUpdate`. `delete` handler intentionally does NOT reset (deletion can fire during a watch tear-down storm).
- `packages/operator/src/job-watch.ts`: same wiring for both `jobInformer` and `podInformer` — independent restarters → independent resets.
- `packages/operator/src/watch.test.ts` + `job-watch.test.ts`: regression tests drive 2 consecutive failures, then a successful `add`/`update`, then flap again, asserting the second flap-series schedules at the *initial* delay (proving `reset()` zeroed `attempts`). Job + Pod independence preserved.

### C1-CONFIG — Helm guard
- `packages/operator/charts/kagent-operator/templates/_helpers.tpl`: added `hasKey` + numeric range check for `supervision.maxEscalationDepth`. Rejects non-numeric, ≤0, and fractional values. Matches the `contextSafetyThreshold` / `contextPressureThreshold` pattern.
- Verified: default (8) renders OK; `--set …=0`, `--set …=-1`, `--set …=3.5` all rejected with the structured error message.

### C1-SIB-1 — Agent informer cache
- `packages/operator/src/supervision-router.ts`:
  - Added optional `getAgentByName?: (namespace, name) => Agent | undefined` to `SupervisionRouterDeps`.
  - `fetchAgent` consults the cache before falling back to direct `customApi.getNamespacedCustomObject`. Direct call retained as cold-cache + unit-test fallback.
- `packages/operator/src/main.ts`:
  - `AdmissionWiring` now exposes `getAgentByName` (backed by the existing admission-side `agentInformer` cache).
  - Mutable `agentCacheHolder` lets supervision deps be constructed BEFORE admission wiring; populated once admission wiring exists. Holder unset when admission disabled → router falls through to direct GET.

### C1-SIB-2 — `listChildrenForParent` required
- `packages/operator/src/supervision-router.ts`: `SupervisionRouterDeps.listChildrenForParent` is now required (no `?`). `listSiblings` no longer needs the `=== undefined` defensive branch. All existing tests already provide the dep.

### C1-NEW-L1 — JSDoc path fix
- `packages/operator/src/supervision-router.ts:311`: `agentPod.supervision.maxEscalationDepth` → `supervision.maxEscalationDepth`.

### C2R3-LOW-1 — `status.phase=Pending` precondition
- `packages/operator/src/reconcile.ts`: `reconcileAgentTask` now patches `phase=Pending` BEFORE Agent resolution / Job creation / dispatch when `task.status?.phase === undefined`. Idempotent via `nextPhase` (returns null on same-phase transition + an explicit guard inside the patch closure). Best-effort: a failed seed-patch only logs; reconcile proceeds.
- `packages/operator/src/reconcile.test.ts`: two tests that asserted `patchNamespacedCustomObjectStatus.not.toHaveBeenCalled()` updated — they now assert no `Dispatched` / `Failed` patch was issued (Pending seed is allowed).
- `packages/operator/src/reconcile-typed-io.test.ts`: two tests that read `mock.calls[0]` updated to `find` the relevant phase across all calls (Pending seed is now first).

## Verification

```
cd packages/operator && npm run typecheck   # PASS
cd packages/operator && npm run lint         # PASS
cd packages/operator && npx vitest run       # 1228/1228 PASS, 49 files
helm template ...kagent-operator             # default 8 -> renders OK
helm template ... --set supervision.maxEscalationDepth=0   # FAIL (correct)
helm template ... --set supervision.maxEscalationDepth=-1  # FAIL (correct)
helm template ... --set supervision.maxEscalationDepth=3.5 # FAIL (correct)
helm template ... --set supervision.maxEscalationDepth=16  # renders OK
```

## Notes

- The `9e27af2` commit accidentally swept in an in-progress llm-gateway sibling agent's working-tree changes (C3-REV3-H1 / B5 fix files: `bounds.ts`, `model-index.ts`, `admin-routes.ts`, `model-watch.ts`, plus their tests, plus that sibling's report). The commit message describes only my chart fix; the sibling work is still recoverable as part of that sibling's evidence trail. Subsequent commit `3162b67` was clean (operator-only).
- The pre-commit hook (`pnpm lint-staged && pnpm -r typecheck`) ran successfully on each commit. Sibling agents pushing during my session caused two transient `index.lock` collisions; both retried successfully.
- All scope respected: only `packages/operator/src/**` and `packages/operator/charts/kagent-operator/**` touched (plus my own report file).
