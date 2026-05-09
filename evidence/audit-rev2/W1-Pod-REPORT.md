# W1-Pod — NH1 + NH2 Fix Report

**Date:** 2026-05-07
**Pod:** W1 (agent-pod / agent-loop scope)
**Audit ref:** `evidence/audit-rev2/C2.md` §3 NH1 + NH2 (HIGHs)
**HEAD at dispatch:** `73deac1`
**Predecessor:** W0-Pod (`evidence/audit-rev2/W0-Pod-REPORT.md`, NB1 fix landed in `78975df`)

---

## 1. Commits made

| SHA | Subject |
|---|---|
| `5f794c0` | `fix(agent-pod): compute budget.tokensRemaining from live RunBudget snapshot (NH1)` |
| `5e7735e` | `fix(agent-loop): cap Retry-After at 30s and make sleep abort-interruptible (NH2)` |

Both pushed to `origin/main` (per user MEMORY auto-push posture).

### Concurrency hygiene

Per W0-Operator's hygiene note: I used `git commit --only -F <msgfile> <pathspec>` for both commits to lock content to my files only. Verified `git log --stat` after each commit; both commits contain ONLY scope-correct files:

* NH1 (`5f794c0`):
  * `packages/agent-pod/src/builtin-tools.ts` — handler fix.
  * `packages/agent-pod/src/builtin-tools.test.ts` — 2 new unit tests.
  * `packages/agent-pod/src/main.test.ts` — 1 new end-to-end regression test (full production wireup).
* NH2 (`5e7735e`):
  * `packages/agent-loop/src/executor.ts` — `pickBackoffMs` cap, `sleepWithAbort` helper, `LLMClientAbortError` import + throw.
  * `packages/agent-loop/src/executor-retry.test.ts` — 6 new regression tests.

Sibling-pod's operator/chart changes (`packages/operator/src/main.ts`, `_helpers.tpl`, `deployment.yaml` from NH3) appeared in the working tree at various points; my `--only` invocations correctly avoided staging them. They were committed by the sibling pod (NH3 = `b529570`) and rebased through cleanly.

No history rewrites; no force-pushes.

---

## 2. NH1 fix detail

**Problem (audit C2 §3 NH1):** `packages/agent-pod/src/builtin-tools.ts:1107-1113` set `budget.tokensRemaining = tokenLimit` (the ceiling), not `tokenLimit - used`. An agent that consumed 49500 tokens of a 50000 cap read `tokensRemaining: 50000` — agent prompt logic like "if tokensRemaining < 5000, hand off" never triggered.

**Fix:** compute `Math.max(0, tokenLimit - snapshot.used)` using `tokenUtilizationSnapshot` (already wired in production via NB1's `buildTokenUtilizationBridge`). Same currency on both sides — `tokenLimit` is `runConfig.tokenLimit`, `snapshot.used` is `cumulativeInputTokens + cumulativeOutputTokens` off the live `RunBudget`. The `Math.max(0, ...)` clamp prevents negative values when gateway-reported usage overshoots the configured cap.

The optional-chain on `deps.tokenUtilizationSnapshot?.()` is preserved for back-compat (existing unit-test callers that don't wire the snapshot still get a well-formed payload — `snapshot.used = 0`, so `tokensRemaining = tokenLimit`, matching the pre-NH1 behavior for callers that haven't migrated).

### Tests added (3 new across 2 files)

**`builtin-tools.test.ts`:**
* `NH1: tokensRemaining decreases as tokens are consumed (live snapshot)` — drives a closure-shared `used` variable through the snapshot dep, asserts `tokensRemaining` falls from 50_000 → 37_500 → 500 as `used` grows.
* `NH1: tokensRemaining clamps to 0 at and past the limit` — asserts `Math.max(0, ...)` clamp at and beyond `tokenLimit`.

**`main.test.ts`:**
* `NH1 regression — budget.tokensRemaining reports remaining (not cap) through production pattern > FULL wireup: tokensRemaining decreases as tokens are consumed across iterations` — drives the FULL production pattern (`buildTokenUtilizationBridge` + `onBudgetReady` + `defineGetMyContext` + `runAgentTask`). LLM stub does 3 iterations; tool_call traces sample `tokensRemaining` at each call. Asserts `5000 → 4050 → 3050` (monotonic decrease) and explicit `not.toBe(5000)` to catch a regression to the cap.

**End-to-end clamp coverage:** intentionally unit-only. The executor's budget-cap check at `executor.ts:831-838` fires AFTER token accounting but BEFORE tool dispatch — so when `tokenLimit=500` and the first chat consumes 950 tokens, `runAgentTask` exits with `status='budget_exceeded'` before `get_my_context` ever runs. The LLM never observes a post-overshoot snapshot in production. Documented in the test file with a comment block where the e2e clamp test would otherwise have lived.

---

## 3. NH2 fix detail

Two distinct sub-issues, fixed atomically.

### NH2-A — `Retry-After` cap

`packages/agent-loop/src/executor.ts` `pickBackoffMs` had:
```ts
return Math.max(0, Math.floor(retryAfterSec * 1000));
```
No upper bound. Gateway returning `Retry-After: 600` slept 10 minutes.

**Fix:** added module-scope `RETRY_AFTER_MAX_MS = 30_000` (comfortably below typical `terminationGracePeriodSeconds` of 60–120s, well above the gateway's default backoff tail of ~3.2s). Now:
```ts
return Math.min(Math.max(0, Math.floor(retryAfterSec * 1000)), RETRY_AFTER_MAX_MS);
```
Sub-30s values pass through unchanged; pathological values clamp.

### NH2-B — Abort-interruptible sleep

`await this.sleep(backoffMs)` followed by `if (llmCtx.abortSignal.aborted)` was the prior shape. The abort check ran AFTER the sleep resolved, so a SIGTERM mid-sleep had to wait for the timer to fire.

**Fix:** added `private async sleepWithAbort(ms, signal)` method. Races the injected `this.sleep(ms)` against an `'abort'` event on the signal. Listener cleanup runs on either resolution path (no leaked listeners after abort). Replaced the call site:
```ts
await this.sleepWithAbort(backoffMs, llmCtx.abortSignal);
if (llmCtx.abortSignal.aborted) {
  const abortErr = new LLMClientAbortError();
  (abortErr as unknown as { cause?: unknown }).cause = err;
  throw abortErr;
}
```

The throw is now `LLMClientAbortError` (with the captured 429 attached as `cause`) — typed for clarity in the failed-trace's error chain. The run loop's outer catch still downgrades to `status='cancelled'` based on `signal.aborted`, regardless of thrown class.

**Test-fake compatibility:** `sleepWithAbort` always invokes `this.sleep(ms)` so existing tests that record per-attempt backoff sequences still observe the call (including `Retry-After: 0 → recordedSleeps: [0]`). When the signal pre-aborts, `this.sleep(ms)` is fired-and-forgotten so the test still sees the invocation but the function returns immediately.

### Tests added (6 new)

* `NH2-A: Retry-After: 600 (10 min) is CAPPED at 30s` — pre-fix `recordedSleeps = [600_000]`, post-fix `[30_000]`. Asserts `llmTraces[1].retry_backoff_ms === 30_000`.
* `NH2-A: Retry-After: 3600 (1 hour) is CAPPED at 30s`.
* `NH2-A: Retry-After at exactly 30s passes through unchanged`.
* `NH2-A: Retry-After under 30s is NOT artificially capped (5s pass-through)`.
* `NH2-B: SIGTERM mid-sleep produces immediate abort throw (sleep does not wait its full duration)` — injects a fake sleep that schedules a 60s timer (long enough that vitest's 5s default would time out), then aborts via `queueMicrotask`. Asserts `elapsedMs < 1000` and the fake's resolve callback never fires.
* `NH2-B: existing 429/backoff tests still pass — abort-aware sleep is back-compat with non-aborting flows` — happy-path smoke regression.

All 9 prior tests in `executor-retry.test.ts` still pass unchanged.

---

## 4. Wired-but-dead-code scan findings

Per `evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md` Steps 1–3, in agent-pod + agent-loop scope, including the new "Sibling patterns" classification (§"Sibling patterns that LOOK like wired-but-dead but aren't").

### Step 1 — scan results

```bash
grep -rnE 'deps\.\w+\?\.\(' packages/agent-pod/src packages/agent-loop/src --include='*.ts' --exclude='*.test.ts'
```

| File:line | Pattern |
|---|---|
| `packages/agent-pod/src/builtin-tools-spawn.ts:346` | `deps.remainingBudgetSeconds?.()` |
| `packages/agent-pod/src/builtin-tools-spawn.ts:367` | `deps.getTraceparent?.()` |
| `packages/agent-pod/src/builtin-tools.ts:1108` | `deps.remainingBudgetSeconds?.()` |
| `packages/agent-pod/src/builtin-tools.ts:1129` | `deps.tokenUtilizationSnapshot?.() ?? { used: 0, modelWindow: null }` |
| `packages/agent-pod/src/builtin-tools-wait.ts:124` | `deps.remainingBudgetSeconds?.()` |
| `packages/agent-pod/src/builtin-tools-wait.ts:207` | `deps.remainingBudgetSeconds?.()` |

```bash
grep -rnE '\?\.\([^)]*\)\s*\?\?\s*[\{\[]' packages/agent-pod/src packages/agent-loop/src --include='*.ts' --exclude='*.test.ts'
```

One hit: `packages/agent-pod/src/builtin-tools.ts:1129` — same `tokenUtilizationSnapshot` line.

### Step 2 — classification per the new taxonomy (WBD / MCALL / CSPREAD / DEADBRANCH)

| File:line | dep | Classification | Rationale |
|---|---|---|---|
| `builtin-tools-spawn.ts:346` | `remainingBudgetSeconds` | **CSPREAD** | `main.ts:355` wires conditionally on `runConfig.timeoutSeconds !== undefined` — feature flag, not bug. |
| `builtin-tools-spawn.ts:367` | `getTraceparent` | **CSPREAD** | `main.ts:356` wires conditionally on `isOtelEnabled(env)` — feature flag, not bug. |
| `builtin-tools.ts:1108` | `remainingBudgetSeconds` | **CSPREAD** | `main.ts:376` wires conditionally on `remainingBudgetSeconds !== undefined`, gated on `spawnEnabled` + per-task timeout. Feature flag, not bug. |
| `builtin-tools.ts:1129` | `tokenUtilizationSnapshot` | **NOT WBD (was, fixed)** | Production wire-up at `main.ts:385` via `buildTokenUtilizationBridge` (W0-Pod's NB1 fix, commit `78975df`). My NH1 change consumes the same snapshot for `tokensRemaining` computation; the fallback `?? { used: 0, modelWindow: null }` is now back-compat for unit tests only. |
| `builtin-tools-wait.ts:124` | `remainingBudgetSeconds` | **CSPREAD** | `main.ts:363`, same conditional pattern as spawn. |
| `builtin-tools-wait.ts:207` | `remainingBudgetSeconds` | **CSPREAD** | `main.ts:368`, same conditional pattern as spawn. |

### Step 3 — confirmed wired-but-dead reports in scope

**No new wired-but-dead sites detected.** My NH1 + NH2 changes did not introduce any new optional-shaped deps, fallbacks, or wiring gaps. The hits in scope all classify as **CSPREAD** (legitimate feature flags wired conditionally based on observable upstream config).

The arbiter has no new follow-ups to queue from this scan.

---

## 5. Verification

* `cd packages/agent-loop && npm run typecheck && npm run lint && npm test`
  → typecheck OK, lint OK, **171 tests pass** (165 baseline + 6 new for NH2).
* `cd packages/agent-pod && npm run typecheck && npm run lint && npm test`
  → typecheck OK, lint OK, **461 tests pass** (458 prior + 3 new for NH1).
* Pre-commit hook (`pnpm lint-staged && pnpm -r typecheck`) passed against both commits.
* `git push origin main` succeeded both times; no merge conflicts; sibling pod's operator/gateway changes propagated through cleanly without entanglement.

---

## 6. Blockers encountered

### B1 — First-cut clamp test in `main.test.ts` failed because executor exits via `budget_exceeded` before tool dispatch

Original plan included an end-to-end clamp test in `main.test.ts` that overshoots `tokenLimit` and asserts the LLM observes `tokensRemaining: 0`. That test failed because the executor's budget-cap check at `executor.ts:831-838` fires AFTER token accounting but BEFORE tool dispatch — when `tokenLimit=500` and the first chat consumes 950, the loop terminates with `status='budget_exceeded'` and `get_my_context` never runs.

Resolution: reduced the e2e clamp to the unit-level (where the handler is exercised directly), preserved the e2e monotonic-decrease test, and documented the rationale in a comment block in `main.test.ts` where the deleted clamp test had been.

This is not a bug — it's the deliberate "budget never enforces; it inspects, then cap-checks" semantics from D-16/D-17 in `executor.ts`.

### B2 — Initial `sleepWithAbort` short-circuited the `Retry-After: 0` test

First-cut implementation skipped the injected `this.sleep(ms)` invocation when `ms <= 0`, which broke the existing test asserting `Retry-After: 0 → recordedSleeps: [0]`. Resolution: always invoke `this.sleep(ms)` so the test fake still records the call; only the wait-for-completion semantics changed.

No other blockers. Full pre-existing test surface stayed green throughout.

---

## 7. Out-of-scope items observed but NOT touched

Per the brief these are explicitly out of scope today:

* W2 surviving HIGHs (H8, H11, H12) — separate task.
* All MEDIUMs / LOWs — later waves.

Sibling agents' work on operator/chart and gateway is visible in the working tree at points but stays unstaged from my commits per the `--only` discipline.
