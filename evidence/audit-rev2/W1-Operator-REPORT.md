# W1-Operator — HIGHs NH3 + NH4 Report

**Date:** 2026-05-07
**Worker:** W1-Operator
**Scope:** `packages/operator/src/**`, `packages/operator/charts/kagent-operator/**`
**Branch:** `main`
**Pushed to:** `origin/main`

---

## 1. Commits landed

| HIGH | SHA | Title |
|---|---|---|
| NH3 | `b529570` | `fix(operator/chart): fail Helm install when contextSafetyThreshold or contextPressureThreshold is out of range (NH3)` |
| NH4 | `0c72387` | `fix(operator): validate contextWindowTokens upper bound in parseModelClassesEnv (NH4)` |

Both commits include the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.

### Concurrency note (per W0-Operator's caveat)

This worker shared the working-tree index with W1-Pod (and possibly others) running in parallel against the same `main` worktree. Concurrent agent-pod and agent-loop edits were observed in the worktree during both commits. Both commits used `git commit --only -F <msgfile> <pathspecs>` to lock commit content; `git diff --staged` was verified pre-push. No history rewrites; no force-push.

The pre-commit hook (`simple-git-hooks` -> `pnpm lint-staged && pnpm -r typecheck`) requires Node 22; ambient shell node was 23.11.1 which fails the engines guard. Worked around by sourcing `~/.nvm/versions/node/v22.22.0/bin` for the commit invocations. No `--no-verify`.

---

## 2. NH3 — Helm chart-level threshold validation

### Fix shape

- **`packages/operator/charts/kagent-operator/templates/_helpers.tpl`** — added `kagent-operator.validateValues` template. When `agentPod.contextSafetyThreshold` is not a number in `(0, 1]` OR `agentPod.contextPressureThreshold` is not a number in `(0, 1)`, `helm install` / `helm template` halts with a clear, actionable message referencing `docs/CONTEXT-AWARENESS.md §4.1` and `evidence/audit-rev2/C1.md NH1`.
- **`packages/operator/charts/kagent-operator/templates/deployment.yaml`** — included the validator at the top so every render exercises the guard.

### Verification (helm template)

| Input | Expected | Result |
|---|---|---|
| default values (0.95 / 0.7) | renders | OK |
| `contextSafetyThreshold: 0` | fails loudly | OK |
| `contextSafetyThreshold: 1.5` | fails loudly | OK |
| `contextSafetyThreshold: -0.5` | fails loudly | OK |
| `contextSafetyThreshold: "0.95"` (quoted string) | fails (must be a number) | OK |
| `contextSafetyThreshold: null` | fails | OK |
| `contextSafetyThreshold: 1.0` (boundary) | renders | OK |
| `contextPressureThreshold: 0` | fails loudly | OK |
| `contextPressureThreshold: 1.0` | fails loudly (>=1 silently disables) | OK |
| `contextPressureThreshold: 1.5` | fails loudly | OK |
| `ci/kind-smoke-values.yaml` overlay | renders | OK |

### Rationale for chart-only scope

Per the dispatch's CLEAN HANDLING note, the agent-pod-side WARN log in `parseContextSafetyThreshold` / `parseContextPressureThreshold` (when the env value parses to outside the legal range) is a follow-up for W1-Pod or W3-Pod. The operator-chart guard catches the misconfig BEFORE the env is stamped onto a pod, so under the chart-controlled deployment path the agent-pod never sees an OOR value. The follow-up is needed for defense-in-depth (e.g. an operator who manually overrides the env on a Job manifest, or a future non-chart deploy mechanism).

---

## 3. NH4 — `contextWindowTokens` upper-bound validation

### Fix shape

- **`packages/operator/src/main.ts`**:
  - Exported `CONTEXT_WINDOW_TOKENS_MIN = 1000` and `CONTEXT_WINDOW_TOKENS_MAX = 2_097_152` (2^21) — covers GPT-3.5's 4K floor down to a 1K test slack and a hypothetical 2M ceiling (already larger than any production model as of 2026-05-07: Gemini 1.5 Pro is 1M, Claude 3 Opus is 200K, GPT-4o is 128K).
  - Three distinct warn-log shapes in `parseModelClassesEnv`: above-MAX (silent-disable trapdoor), below-MIN (over-trip trapdoor), and the existing catch-all for non-integer / non-numeric / NaN. The above-MAX message names the safety-net consequence so an operator scanning logs sees the specific reason rather than a generic message.
  - Out-of-range values drop the field with a structured warn-log; the rest of the entry survives so the class remains usable (just without context-awareness — same posture as v0.1.8 pre-context-window).

- **`packages/operator/src/main.test.ts`** — 7 new regression tests under the existing `parseModelClassesEnv` describe-block:
  - `999_999_999_999` -> dropped + above-MAX warn (smoking-gun case from the audit).
  - `1_500_000_000` -> dropped + above-MAX warn.
  - `200_000` -> passes through (legit Claude 3 Opus window).
  - `999` -> dropped + below-MIN warn.
  - `2_097_152` -> passes through (boundary, exact MAX).
  - `1000` -> passes through (boundary, exact MIN).
  - mixed-map test: rest of entry survives when contextWindowTokens is rejected (graceful-degradation contract).
  - Added `vi` to the vitest import to spy/restore `console.warn`.

### Pre-existing test compatibility

Pre-existing tests for `contextWindowTokens: 0`, `-1`, `131072.5`, `'131072'` (string), and `null` continue to pass — they fall into the catch-all branch with the updated warn-log copy that now also names the legal range `[1000, 2_097_152]`. The expected-shape assertions (`toEqual`) are unaffected.

---

## 4. Verification

| Check | Result |
|---|---|
| `pnpm -r typecheck` (via pre-commit hook on both commits) | green |
| `pnpm --filter @kagent/operator lint` | green |
| `pnpm --filter @kagent/operator test` | **46 files, 1155 tests passing** (was 1148 before NH4; +7 new tests) |
| `helm template packages/operator/charts/kagent-operator` (default values) | renders cleanly |
| Explicit OOR-fail tests for NH3 | all 7 cases match the table above |

---

## 5. Wired-but-dead-code SCAN — operator scope (post-fix re-run)

Step 1 grep per `WIRED-BUT-DEAD-CODE-PARADIGM.md`:

```
grep -rnE 'deps\.\w+\?\.\(' packages/operator/src --include='*.ts' --exclude='*.test.ts'
grep -rnE '\?\.\([^)]*\)\s*\?\?\s*[\{\[]' packages/operator/src --include='*.ts' --exclude='*.test.ts'
```

Plus the broader `\.\w+\?\.\(` scan to catch `input.<name>?.()` and `handler.<name>?.()` shapes.

### Findings

| Site | Classification | Status |
|---|---|---|
| `agent-workflow-controller.ts:517,519` `deps.auditEmit?` | WBD (wired-but-dead) | **Already filed by W0-Operator as WBD-OP-1.** No new sites observed. |
| `supervision-router.ts:412-418` `deps.listChildrenForParent` block | DEADBRANCH | **Already filed by W0-Operator as WBD-OP-2 (= M2 in C1.md).** No new sites observed. |
| `triggers-bootstrap.ts:183 deps.resolveTriggerSecret?.(id)` | WIRED | `main.ts:2232` plumbs env-var-keyed reader. Not a bug. |
| `reconcile.ts:670 deps.resolveTenantForTask?` | WIRED | `main.ts:1689`. Not a bug. |
| `reconcile.ts:715,725 deps.emitCapabilityMinted?` / `deps.emitKeyrotationCapMintedWithTtl?` | CSPREAD by-design | Production passes a thunk that dereferences a holder populated only when `KAGENT_AUDIT_NATS_URL` is set (audit-best-effort pattern, `docs/WAVES.md`). Not a bug. |
| `cas-gc.ts:263 deps.now?.()` | Clock injection (not paradigm) | `Date.now()` fallback is correct production behavior. Not a bug. |
| `main.ts:1760,1763,1766 capabilityAuditHolder.emit*?` / `parentChildrenAggregatedAuditHolder.emit?` | CSPREAD by-design | Inner thunks of the audit-best-effort pattern. Not a bug. |
| `main.ts:2697,3019,3542 timer.unref?.()` | Node API existence check | `Timeout.unref` always present in v22+. Defensive, not feature plumbing. Not a bug. |
| `watch.ts:97,103,109,113 + job-watch.ts:117,120,123,130,133,136 handler.onError?` | Caller-shaped optional | Production `main.ts` always provides `onError`. Not a bug. |
| `workspace-controller.ts:460,465,481,491 input.lookupPvc?` / `input.lookupCloneJob?` | WIRED | Inside the controller itself at `workspace-controller.ts:825`. Not a bug. |
| `agent-workflow-controller.ts:495 input.lookupDeployment?` | WIRED | Inside the controller itself at `agent-workflow-controller.ts:1015`. Not a bug. |

**Net summary:** zero new wired-but-dead findings beyond W0-Operator's tally. WBD-OP-1 (`auditEmit`) and WBD-OP-2 (`listChildrenForParent` deadbranch) remain the only confirmed sites in operator scope.

---

## 6. Follow-up sub-tasks (filed for the arbiter)

### NH3 follow-up — agent-pod WARN log on threshold OOR

**Scope:** agent-pod (W1-Pod / W3-Pod).

**File:line:** `packages/agent-pod/src/runner.ts:904-908` (`parseContextSafetyThreshold`) and `packages/agent-pod/src/runner.ts:318` (`parseContextPressureThreshold`).

**Issue:** Both parsers silently fall through to defaults (`0.95` / `0.7`) when the env value parses to outside `(0, 1]` / `(0, 1)`. The operator-chart guard now catches this BEFORE the env is stamped onto the pod, but defense-in-depth requires a WARN log in the agent-pod itself for the cases where the env is set non-chart-mediated (e.g. manual Job manifest override, future non-chart deploy mechanism).

**Suggested fix shape:** Add a `console.warn(`[kagent-agent-pod] KAGENT_CONTEXT_SAFETY_THRESHOLD=<value> is outside (0, 1] — falling back to default 0.95`)` (and the symmetric pressure-threshold variant) inside the `parsed === undefined` branch of both helpers. Test by setting the env to `"0"`, `"1.5"`, `"-0.5"` and asserting the warn fires + the executor uses the default.

### NH4 follow-up — agent-pod-side `parseContextWindowTokens` upper bound

**Scope:** agent-pod (W1-Pod / W3-Pod).

**File:line:** `packages/agent-pod/src/env.ts:446` (per audit's PT2 reference).

**Issue:** The agent-pod's `parseContextWindowTokens` applies the same `<= 0` and non-integer guards as `parseModelClassesEnv`, but does NOT enforce the upper bound. Defense-in-depth mirror of NH4 — same constants `CONTEXT_WINDOW_TOKENS_MIN=1000` / `CONTEXT_WINDOW_TOKENS_MAX=2_097_152` should be applied. The operator-chart-mediated path can never produce an OOR value (we filter at parse time in `parseModelClassesEnv`), but the agent-pod guard catches the non-chart-mediated case (manual override).

---

## 7. Out of scope (untouched)

- W2-surviving HIGHs (H5, H6, H17, H20) — separate task.
- All MEDIUMs / LOWs — later waves.
- agent-pod, agent-loop, llm-gateway, workbench-api, workbench-ui, kagent-workbench chart — not touched.

No `agent-pod`, `agent-loop`, `llm-gateway`, `workbench-api`, or `kagent-workbench` chart files were modified by W1-Operator.

---

## 8. Net delta vs W0-Operator's baseline

- **NH3:** STILL OPEN -> **CLOSED** (operator chart scope). Helm-render-time guard rejects out-of-range thresholds with structured failure message. agent-pod-side WARN log filed as follow-up.
- **NH4:** STILL OPEN -> **CLOSED** (operator scope). `parseModelClassesEnv` extends the existing graceful-degradation path with `[1000, 2_097_152]` bounds; out-of-range values drop the field with a structured warn-log; the rest of the entry survives. 7 regression tests added.

No other audit-rev2 line items were touched by this worker.

---

## 9. Blockers

None.
