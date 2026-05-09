# W0-Pod — NB1 Fix Report

**Date:** 2026-05-07
**Pod:** W0 (agent-pod / agent-loop scope)
**Audit ref:** `evidence/audit-rev2/C2.md` §2 NB1 (BLOCKER)
**Brief ref:** wire `tokenUtilizationSnapshot` so `get_my_context` returns the LIVE token-utilization snapshot, with regression test that exercises the FULL production wireup.

---

## 1. Commits made

| SHA | Subject |
|---|---|
| `78975df` | `fix(agent-pod): wire tokenUtilizationSnapshot to live RunBudget for get_my_context (NB1)` |

Pushed to `origin/main` (per user MEMORY auto-push posture).

### Commit scope

Four files, all in W0 scope (`packages/agent-pod/**` + `packages/agent-loop/**`):

* `packages/agent-loop/src/executor.ts` — `RunInput.onBudgetReady?: (RunBudget) => void`. Fired once after `budget` allocation; hands the LIVE mutable ref back to the caller. try/catch'd so a misbehaving observer cannot fail the run.
* `packages/agent-pod/src/runner.ts` — `RunDeps.onBudgetReady`; forwards verbatim onto `executor.run({ onBudgetReady })`. Imports `RunBudget` from `@kagent/agent-loop`.
* `packages/agent-pod/src/main.ts` — extracted `buildTokenUtilizationBridge(contextWindowTokens)` returning paired `{ onBudgetReady, tokenUtilizationSnapshot }`. The bridge owns a closure-shared mutable holder + a thunk that reads cumulative tokens off the same object the executor mutates each iteration. Both ends are wired in `main()`: thunk → `defineGetMyContext` deps; capture-callback → `runAgentTask` deps.
* `packages/agent-pod/src/main.test.ts` — regression test + helper-shape unit tests (see §2).

No operator / gateway / workbench / chart files were touched.

---

## 2. Tests added

All in `packages/agent-pod/src/main.test.ts` (4 new test cases total).

### 2.1 Regression test — drives the FULL production wireup

`describe('NB1 regression — tokenUtilizationSnapshot wired through production pattern')`
* `it('FULL wireup: get_my_context observes live tokenUtilization.used > 0 + modelWindow set + percentage numeric')`

Mirrors `main.ts`'s wireup verbatim:
1. Calls `buildTokenUtilizationBridge(cfg.contextWindowTokens)` to obtain the paired `onBudgetReady` + `tokenUtilizationSnapshot`.
2. Constructs `defineGetMyContext({ podConfig, tokenUtilizationSnapshot })` BEFORE the run starts — same ordering as `main.ts:373-386`.
3. Runs `runAgentTask(cfg, { llm, spawnTools, onBudgetReady })`. The LLM stub fires a `tool_call` to `get_my_context` on iteration 0 with realistic token usage (input=600, output=350 → cumulative=950), then a final text on iteration 1.
4. Pulls the `tool_call` trace's `tool_output` out of `result.traces` (the literal payload the LLM would have observed) and parses the `tokenUtilization` block.

**Asserts (the EXACT three invariants the brief required):**
* `tokenUtilization.used > 0` after token consumption (specifically === 950).
* `tokenUtilization.modelWindow === 131_072` (the configured `contextWindowTokens`), not `null`.
* `tokenUtilization.percentage` is a number (≈ 0.0072), not `null`.

**Failure mode before fix:** the test would not compile — `RunDeps.onBudgetReady`, `RunInput.onBudgetReady`, and `buildTokenUtilizationBridge` are all NEW. The pre-fix tree had no mechanism to thread the live RunBudget out of the executor; my test is the witness that the mechanism now exists end-to-end.

### 2.2 `buildTokenUtilizationBridge` unit shape

`describe('buildTokenUtilizationBridge (NB1 helper)')` — three cases:
1. `used=0 + modelWindow=null` when `contextWindowTokens` undefined and `onBudgetReady` not yet fired.
2. `modelWindow = configured contextWindowTokens` even before `onBudgetReady` fires (zero-token early-call shape).
3. After `onBudgetReady` fires, the snapshot reads `cumulativeInputTokens + cumulativeOutputTokens` LIVE from the captured ref — including subsequent mutations (mirrors what the executor does between iterations).

---

## 3. Wired-but-dead-code scan findings

Per `WIRED-BUT-DEAD-CODE-PARADIGM.md` Steps 1–3, in agent-pod + agent-loop scope.

### Step 1 — scan results

```bash
grep -nE 'deps\.\w+\?\.\(' packages/agent-pod/src/*.ts packages/agent-loop/src/*.ts | grep -v '\.test\.ts'
```

| File:line | Pattern |
|---|---|
| `packages/agent-pod/src/builtin-tools-spawn.ts:346` | `deps.remainingBudgetSeconds?.()` |
| `packages/agent-pod/src/builtin-tools-spawn.ts:367` | `deps.getTraceparent?.()` |
| `packages/agent-pod/src/builtin-tools-wait.ts:124` | `deps.remainingBudgetSeconds?.()` |
| `packages/agent-pod/src/builtin-tools-wait.ts:207` | `deps.remainingBudgetSeconds?.()` |
| `packages/agent-pod/src/builtin-tools.ts:1108` | `deps.remainingBudgetSeconds?.()` |
| `packages/agent-pod/src/builtin-tools.ts:1125` | `deps.tokenUtilizationSnapshot?.() ?? { used: 0, modelWindow: null }` |

```bash
grep -rnE '\?\.\([^)]*\)\s*\?\?\s*[\{\[]' packages/agent-pod/src packages/agent-loop/src --include='*.ts' --exclude='*.test.ts'
```

Returned ONE hit: `packages/agent-pod/src/builtin-tools.ts:1125` — same `tokenUtilizationSnapshot` line. (No other fallback-to-literal patterns in scope.)

### Step 2 — classification

| File:line | dep | Production wire site | Test wire site | Classification |
|---|---|---|---|---|
| `builtin-tools-spawn.ts:346` | `deps.remainingBudgetSeconds` | `main.ts:355` (conditional spread under `runConfig.timeoutSeconds !== undefined`) | `builtin-tools-spawn.test.ts` injects directly | **NOT wired-but-dead.** Production wires when timeout is set; the optional fallback is the legitimate "no timeout configured" path. Documented in `main.ts:325-331`. |
| `builtin-tools-spawn.ts:367` | `deps.getTraceparent` | `main.ts:356` (conditional spread under `isOtelEnabled(env)`) | `builtin-tools-spawn.test.ts` injects directly | **NOT wired-but-dead.** Production wires when OTel is on; the optional fallback is the legitimate "OTel disabled, no traceparent to propagate" path. Documented in `main.ts:332-336`. |
| `builtin-tools-wait.ts:124` | `deps.remainingBudgetSeconds` | `main.ts:363` (same conditional as spawn) | `builtin-tools-wait.test.ts` injects directly | **NOT wired-but-dead.** Same pattern as spawn — production wires conditionally; fallback is legitimate. |
| `builtin-tools-wait.ts:207` | `deps.remainingBudgetSeconds` | `main.ts:368` (same conditional as spawn) | `builtin-tools-wait.test.ts` injects directly | **NOT wired-but-dead.** Same as above. |
| `builtin-tools.ts:1108` | `deps.remainingBudgetSeconds` (in `defineGetMyContext`) | `main.ts:376` (same conditional spread, gated on spawnEnabled + timeout set) | `builtin-tools.test.ts:932-941` injects directly | **NOT wired-but-dead.** Production wires it conditionally; fallback is legitimate. |
| `builtin-tools.ts:1125` | `deps.tokenUtilizationSnapshot` | **WAS** absent at `main.ts:359-363` (NB1) — **NOW** wired at `main.ts:385` via `buildTokenUtilizationBridge` | `builtin-tools.test.ts:981-1046` injects directly | **PREVIOUSLY wired-but-dead (NB1); FIXED in commit `78975df`.** |

### Step 3 — confirmed wired-but-dead reports

**No new wired-but-dead sites detected** beyond NB1 itself, which is now fixed. The five other optional-call sites have legitimate "feature off" semantics (OTel disabled, no per-task timeout configured) where the production wireup correctly conditional-spreads the dep based on the upstream input being present.

The arbiter has no follow-ups to queue from this scan.

---

## 4. Verification

* `cd packages/agent-loop && npm run typecheck && npm run lint && npm test`
  → typecheck OK, lint OK, **165 tests pass**.
* `cd packages/agent-pod && npm run typecheck && npm run lint && npm test`
  → typecheck OK, lint OK, **458 tests pass** (4 new cases added; existing 454 untouched).
* Pre-commit hook (`pnpm lint-staged && pnpm -r typecheck`) passed against the commit.
* `git push origin main` succeeded (no merge conflicts; the staged operator/llm-gateway changes from sibling pods stayed unstaged + untouched).

---

## 5. Blockers encountered

### B1 — Pre-commit hook rejected first commit attempt under Node v23

`pnpm` enforces the repo's `engines.node: ">=22.0.0 <23.0.0"`. The shell session was on Node 23. Resolved by chaining `source ~/.nvm/nvm.sh && nvm use 22.22 && git commit ...` so the hook ran under the supported Node major.

### B2 — Initial commit accidentally took unrelated staged operator files

The repo's index had pre-staged operator changes from a sibling pod's session (`packages/operator/src/{main.ts,verifier.ts,verifier.test.ts,job-route.test.ts}`). My `git restore --staged` was issued but the index continued to show those files, and the first `git commit` consumed them under the NB1 message. Resolved by `git reset --soft HEAD~1`, full `git reset HEAD` to clear the index, then `git add` only the four NB1 files. The wrong commit was never pushed (it was caught locally before the push step), so no upstream cleanup was needed.

The actual NB1 commit (`78975df`, on origin/main) contains exactly the four files in scope: `executor.ts`, `runner.ts`, `main.ts`, `main.test.ts`.

No other blockers. Test surface stayed clean throughout — the wireup mechanism (callback chain → live mutable budget → thunk → tool output) works exactly as the audit prescribed.
