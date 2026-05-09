# W3-Operator — MEDIUMs Wave Report

**Date:** 2026-05-07
**Worker:** W3-Operator
**Scope:** `packages/operator/src/**`, `packages/operator/charts/kagent-operator/**`, `docs/WAVES.md`
**Branch:** `main`
**Pushed to:** `origin/main`

---

## 1. Commits landed

| ID | SHA | Title |
|---|---|---|
| M2 | `51e5152` | `fix(operator): use informer-cache lookup for supervision parent/uid resolution (M2)` |
| M3 + M13 | `65ef511` | `fix(operator): retry verifier completion via exponential backoff + transient-error handling (M3, M13)` |
| M4 | `f01e205` | `fix(operator): seed IdempotencyCache from informer first sync (M4)` |
| M5 | `a0a5ad2` | `fix(operator/chart): use mustToJson for modelClasses to fail at helm install (M5)` |
| M21 | `1ae2718` | `feat(operator): emit substrate.informer_error and reflect informer freshness in /healthz (M21)` |
| WBD-OP-1 | `60e278f` | `fix(operator): wire auditEmit to AgentWorkflow controller from main (WBD-OP-1, task #29)` |
| M22 | `a42a2cb` | `fix(operator): thread resolved agent name into verifier+supervision audit hooks (M22)` |
| M1 | `bafcd0e` | `docs(waves, agent-crd): clarify supervisionStrategy=restart records intent only (M1)` |

All 8 commits include the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer. All pushed to `origin/main`.

---

## 2. Per-fix detail

### M2 — informer-cache for supervision parent/uid resolution

- `supervision-router.ts` — added `getTaskByUid?: (uid) => AgentTask | undefined` to `SupervisionRouterDeps`. Replaced the dead-branch comment-only `if (deps.listChildrenForParent !== undefined) { /* can't use here */ }` block at `fetchParentTask` with a real cache-hit branch. `fetchTaskByUid` does the same.
- `main.ts` — wires `getTaskByUid` (the same closure already feeding `reconcileParentFromChildEvent`) into `supervisionRouterDeps`.
- 2 new regression tests in `supervision-router.test.ts` (`uses deps.getTaskByUid` + `falls back to LIST when getTaskByUid misses`).
- Unbounded namespaced LIST per supervision reconcile is now bypassed when the informer has the task; cold-cache fallback preserves correctness.

### M3 — verifier poll-loop exponential backoff

- `verifier.ts` — `runScriptVerifier`'s poll loop now uses `pollInterval = Math.min(pollInterval * 2, pollCap)` (500ms → 1s → 2s → 4s → cap 5s) instead of the prior flat 500ms tick. New `jobPollIntervalCapMs` deps option for tests.
- A 60s wall-clock verifier now issues ≤16 reads vs. ~120 under the prior cadence.
- Considered the Job-watch route (operator already runs `jobPodInformer`); ruled out for v0.3.x — verifier Jobs carry the `kagent.knuteson.io/verifier=true` label which the existing job-watch handler skips for B3-collision reasons. Backoff is the lower-risk path.
- 1 new regression test asserting backoff observable via `mockImplementation(...)` call counts.

### M13 — verifier transient-retry on Langfuse + gateway

- `verifier.ts` — added `retryTransient(attempts, baseDelayMs, op)` helper. `runLlmJudgeVerifier` wraps both the Langfuse fetcher invocation AND the gateway POST in 3-attempt retry on 502/503/504. Permanent 4xx, network errors, timeouts, parse errors continue to fail-fast with their existing reason tags.
- `main.ts:buildLangfusePromptFetcherForOperator` — stamps `status` on the thrown Error for HTTP failures (so `retryTransient` can classify) AND a structured `kagentLangfuseReason: 'wrong_prompt_type'` marker on non-text-prompt responses.
- `verifier.ts:isWrongPromptTypeError` — exported predicate the dispatcher uses to surface `langfuse_wrong_prompt_type` instead of the generic `langfuse_fetch_failed`.
- 4 new regression tests covering Langfuse retry success, gateway retry success, wrong-prompt-type structured reason, persistent-503 fail-after-3.

### M4 — seed IdempotencyCache from informer first sync

- `task-admission.ts` — added `IdempotencyCache.seed(key, hash, taskUid, outputs): boolean` (idempotent — returns `false` when an entry already exists). Updated the class JSDoc to explicitly document the process-local-only persistence gap.
- `main.ts` — added `seedIdempotencyCacheFromInformer(cache, tasks)`. Boot path calls it right after `informer.start()` returns so every Completed AgentTask in the cluster's apiserver re-populates the cache before watch events land. Capability-only tasks (no `spec.targetAgent` resolved on the spec) are skipped — the regular reconcile path re-resolves on replay.
- 5 new regression tests across `task-admission.test.ts` + `main.test.ts`.
- Closes the operator-restart double-dispatch race for the common single-leader case.

### M5 — `mustToJson` for `agent.modelClasses`

- `templates/deployment.yaml` — replaced `toJson` with `mustToJson` on the `KAGENT_AGENT_MODEL_CLASSES_JSON` env projection. Helm-side typos that produce non-serializable values (function refs, circular structures) now fail at `helm template` / `helm install` instead of CrashLoopBackoff'ing the operator pod at boot.
- Default render: `helm template packages/operator/charts/kagent-operator` continues to render cleanly.
- Negative test (`--set 'agent.modelClasses.broken={"physical":[null]}'`) renders cleanly because `[null]` is valid JSON; the substantive benefit of `mustToJson` is for sprig-side non-serializable inputs (defense in depth).

### M21 — substrate.informer_error + /healthz + metric counter

- New file `substrate-health.ts`:
  - `createInformerHealth()` — per-informer freshness tracker.
  - `decideHealthz()` — pure decision function (200/503).
  - `renderMetricsText()` — Prometheus text-format snapshot, exposes `kagent_operator_informer_errors_total` counter.
  - `startSubstrateHealthServer()` — `node:http` server bound to `KAGENT_HEALTHZ_PORT` (default 8081). Best-effort; bind failures log + return undefined.
- `main.ts` — threads `informerHealth` through `buildHandler` (optional dep so tests can omit), wires AgentTask + Job + Pod informer onAdd/onUpdate/onDelete + onError into the tracker. Boots health server before primary informers; closes it on shutdown.
- `onError` paths emit a structured stdout line tagged `[kagent-operator/substrate.informer_error]` (forward-compat shape; same pattern as `[kagent-operator/blackboard.gc]` already uses since the audit-events catalog is out-of-scope for this wave).
- Chart wiring: `values.yaml` adds `substrateHealth.{port,freshnessMaxMs}` block; `deployment.yaml` stamps `KAGENT_HEALTHZ_PORT` + `KAGENT_INFORMER_FRESHNESS_MAX_MS` and exposes a `healthz` containerPort.
- 8 new unit tests in `substrate-health.test.ts`.
- LivenessProbe `httpGet` wiring deferred to a follow-up (the surface itself is non-breaking).

### WBD-OP-1 — auditEmit wired to AgentWorkflow controller

- `main.ts` — added `workflowAuditHolder` mutable holder (matching the capability/supervision/verifier/parent-children-aggregated patterns), populated in the audit-publisher init block. Threads `auditEmit: (type, payload) => workflowAuditHolder.emit?.(type, payload)` into `buildAgentWorkflowController({...})` at the production callsite (formerly the `main.ts:2485-2496` callsite the W0-Operator scan flagged).
- The closure maps the controller's loose `(type, payload)` signature onto the typed `AuditEvent` discriminated union for all 5 workflow event types (`started`, `step.completed`, `completed`, `failed`, `event_subscription_pending`). Some Restate-runtime fields (invocationId, handler, stepCount) are stamped as empty strings / 0 — operator-side controller doesn't have them at deployment-creation time. Wave 3 Workflows lights the runtime-side full-data emissions up.
- 1 regression test in `agent-workflow-controller.test.ts` drives the production-shape `auditEmit` thunk via the mutable holder pattern and asserts `workflow.started` flows through.

### M22 — resolved agent name in verifier + supervision audit hooks

- `verifier.ts` — added `resolveAgentName?: (task) => Promise<string | undefined>` to `VerifierDispatchDeps`. New `resolveAgentNameSafely` helper. `dispatchVerification` resolves the name ONCE at the top so all three audits (`emitStarted` / `emitCompleted` / `emitFailed`) stamp the same value.
- `supervision-router.ts` — same `resolveAgentName` dep added; `emitInfraSafe` consults it for capability-targeted infra faults.
- `main.ts` — added shared `resolveAgentNameForTask` closure (walks `spec.targetAgent` → `capabilityRegistry.resolveCapability(spec.targetCapability)`) and threaded it into both the verifier reconciler and the supervision router.
- Best-effort: resolver throws fall back to the legacy `task.spec.targetAgent ?? ''` shape so audit consumers see the same back-compat string the prior code emitted.
- 4 new regression tests across `verifier.test.ts` + `supervision-router.test.ts`.

### M1 — supervisionStrategy=restart documentation

- `docs/WAVES.md` §4.2 — added an explicit warning callout that `restart` records intent only (does not re-spawn the Job).
- `packages/operator/src/crds/types.ts` — same warning added to the `Agent.spec.supervisionStrategy` JSDoc.

---

## 3. Verification

- `cd packages/operator && npm run typecheck` → **green**.
- `cd packages/operator && npm run lint` → **green**.
- `cd packages/operator && npm test` → **49 test files, 1199 tests, all passing.** (Up from 1148 at wave start: +51 net new regression tests.)
- `helm template packages/operator/charts/kagent-operator` → renders cleanly.
- `helm template packages/operator/charts/kagent-operator --set 'agent.modelClasses.broken={"physical":[null]}'` → renders cleanly (input is valid JSON; `mustToJson` gains kick in only for sprig-side non-serializable values).

No agent-pod, agent-loop, llm-gateway, workbench-api, or kagent-workbench chart files modified by W3-Operator (out of scope per the brief).

---

## 4. Wired-but-dead-code SCAN — operator scope (post-fix)

Scans run per `WIRED-BUT-DEAD-CODE-PARADIGM.md` Step 1:

```
grep -rnE 'deps\.\w+\?\.\(' packages/operator/src --include='*.ts' --exclude='*.test.ts'
grep -rnE '\.\w+\?\.\(' packages/operator/src --include='*.ts' --exclude='*.test.ts'
grep -rnE '\?\.\([^)]*\)\s*\?\?\s*[\{\[]' packages/operator/src --include='*.ts' --exclude='*.test.ts'
```

### Confirmed wired-but-dead findings

**None.** Both prior W0-Operator findings are now resolved:

- **WBD-OP-1** (`agent-workflow-controller.ts:517,519` — `deps.auditEmit?`) — RESOLVED. Production main.ts now passes `auditEmit` via the `workflowAuditHolder` pattern (commit `60e278f`). Regression test asserts the full production wireup.
- **WBD-OP-2** (= M2 in C1.md) — RESOLVED. `supervision-router.ts:412-418` dead-branch comment block replaced with a real `getTaskByUid` cache-hit path (commit `51e5152`).

### Hits classified as NOT wired-but-dead (for the record)

| Site | Disposition |
|---|---|
| `triggers-bootstrap.ts:183 deps.resolveTriggerSecret?` | WIRED — `main.ts:2232` plumbs env-var-keyed reader. |
| `reconcile.ts:670 deps.resolveTenantForTask?` | WIRED — `main.ts:1689`. |
| `reconcile.ts:715,725 deps.emitCapabilityMinted? / deps.emitKeyrotationCapMintedWithTtl?` | CONDITIONAL by-design (audit-best-effort pattern). |
| `main.ts:1863,1866,1869,2869 *AuditHolder.emit?` | Same audit-best-effort holder pattern. |
| `main.ts:1067,1081,1143 health?.recordEvent / .recordError` | NEW (M21) — health is wired in production at `main.ts:2014` + tests can omit it. Inverse of WBD: production wires; tests omit. |
| `cas-gc.ts:263 deps.now?` | Clock injection; `Date.now()` fallback is correct production behavior. |
| `main.ts:3003,3325,3848 timer.unref?` | Node API existence check. |
| `informer-restart.ts:166 logger.onCapReached?` | Caller-shaped (logger.onCapReached is implemented in production). |
| `watch.ts + job-watch.ts handler.onError?` | Caller-shaped optional; production main.ts always provides `onError`. |
| `agent-workflow-controller.ts:495 input.lookupDeployment?` | WIRED inside the controller's own informer-cache integration. |
| `workspace-controller.ts:460,465,481,491 input.lookupPvc/lookupCloneJob?` | WIRED inside the controller itself. |

### Step 2 summary

- **0 confirmed wired-but-dead sites** in operator scope after this wave.
- Both prior findings (WBD-OP-1, WBD-OP-2) closed.
- No new findings to escalate to the arbiter.

---

## 5. Out of scope (untouched per brief)

- agent-pod / agent-loop / llm-gateway / workbench-api / kagent-workbench chart fixes
- Operator-side env-JSON cap (file as follow-up if W2-Pod hasn't picked it up)
- All LOWs (Wave 5)

---

## 6. Net delta vs C1.md

| ID | Status (start) | Status (end) |
|---|---|---|
| M1 | STILL OPEN | **CLOSED** (doc-only, WAVES + CRD JSDoc) |
| M2 | STILL OPEN | **CLOSED** (informer-cache, dead-branch eliminated) |
| M3 | STILL OPEN | **CLOSED** (exponential backoff) |
| M4 | STILL OPEN | **CLOSED** (informer first-sync seed) |
| M5 | STILL OPEN | **CLOSED** (mustToJson) |
| M13 | (new in wave brief) | **CLOSED** (transient retry + structured wrong-prompt-type reason) |
| M21 | STILL OPEN | **CLOSED** (substrate-health module + chart wiring) |
| M22 | (new in wave brief) | **CLOSED** (resolveAgentName threaded) |
| WBD-OP-1 | OPEN (W0-Operator scan) | **CLOSED** (workflowAuditHolder wired) |
| WBD-OP-2 (= M2) | OPEN (W0-Operator scan) | **CLOSED** (M2 fix) |

No other audit-rev2 line items were touched by W3-Operator.
