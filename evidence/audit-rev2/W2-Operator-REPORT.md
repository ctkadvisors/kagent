# W2-Operator Wave Report

**Branch:** `main`
**Commits landed:** `5e7735e..2b31fdf`
**Date:** 2026-05-07

## Scope completed

Four atomic commits landed and pushed:

| Commit  | HIGH  | Title                                                                                          |
|---------|-------|------------------------------------------------------------------------------------------------|
| cbfa912 | H5    | `chore(operator,agent-pod): set non-zero vitest coverage thresholds (H5)`                       |
| a219b75 | H6    | `fix(operator): wrap informer restarts with safeRestart + backoff and add tests for watch/job-watch (H6)` |
| 6be592f | H17   | `fix(operator/chart): scope kagent-workbench actions to namespaced Role+RoleBinding (H17)`     |
| 2b31fdf | H20   | `fix(operator): require explicit KAGENT_CAP_SIGNING_ALG for SPIRE-managed signing keys (H20)`  |

All commits include the Co-Authored-By trailer and passed pre-commit hooks (lint-staged + recursive typecheck).

## Per-finding details

### H5 — vitest coverage thresholds

**Files changed:**
- `packages/operator/vitest.config.ts`
- `packages/agent-pod/vitest.config.ts`

**Action:** Replaced `0/0/0/0` placeholder thresholds with `lines: 80, functions: 80, branches: 70, statements: 80` in both packages, with inline commentary tying back to CLAUDE.md's ≥85% reconciler / ≥75% glue targets and explicitly forbidding lowering the floor to accommodate today's gaps.

**Coverage status (today):**
- **Operator:** lines 67.17%, functions 61.44%, branches 65.64%, statements 66.41% — falls below the 80/70 floor on all four axes. Hot files dragging the package average: `main.ts` (15.61% lines), `k8s.ts` (16.66% lines), `versioning-controller.ts` (40.67%), `triggers-bootstrap.ts` (40.67%), `events-bootstrap.ts` (69.49%). The reconciler proper (`reconcile.ts` 87.97% lines, `task-graph.ts` 98.71% lines, `cap-ca.ts` 93.67% lines after H20 tests) clears the CLAUDE.md target on its own.
- **agent-pod:** lines 77.75%, functions 80.2%, branches 70.88%, statements 77.18% — falls below on lines and statements. Hot files: `main.ts` (11.11% lines), `k8s-task-creator.ts` (24.7% lines), `blackboard-client.ts` (0% lines).

**Follow-up flagged:** raising `main.ts` and `k8s-task-creator.ts` (in agent-pod) coverage above the floor is a separate task — the threshold itself is the discipline. Because the floor fails today, `npm run test:coverage` exits non-zero in both packages until the gap is closed; CI configurations that gate on coverage will surface this immediately.

---

### H6 — informer restart races + missing tests

**Files changed:**
- `packages/operator/src/informer-restart.ts` (new — `safeRestart` helper)
- `packages/operator/src/watch.ts` (use `safeRestart`)
- `packages/operator/src/job-watch.ts` (use `safeRestart`, per-informer state for Job vs Pod)
- `packages/operator/src/watch.test.ts` (new)
- `packages/operator/src/job-watch.test.ts` (new)

**Shape of fix:**
- New `createRestarter(informer, logger, opts, timer)` factory builds a per-informer restart-state object with: exponential backoff (default 5s → 5min cap; configurable via `RestartOptions.initialDelayMs / backoffFactor / maxDelayMs`), `.then(_, catch)` instead of `void` on the restart's `start()` (so rejection feeds back through `safeRestart` instead of vanishing), idempotency (mid-pending second-error is a no-op), and a `maxConsecutiveFailures` cap (default 12) that fires `onCapReached`.
- `onCapReached` is the M21 hook (W3-Operator scope) — wired but no current consumer flips a readiness probe from it. Documented in commentary.
- `watch.ts` builds one restarter; `job-watch.ts` builds two (Job + Pod) so one informer flapping does not poison the other's backoff.

**Tests added (10):**
- `watch.test.ts`: error → safeRestart fires; repeated `start()` rejections escalate the backoff; cap fires `onCapReached`; second error mid-pending is a no-op.
- `job-watch.test.ts`: same shape × Job/Pod independence; `parentTaskRef` no-regression cases.

**Verifier:** `npm test` 1155 → 1165 passing in operator.

---

### H17 — workbench actions ClusterRole over-scoped

**Files changed:**
- `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` (kind: `ClusterRole` → `Role`, added `metadata.namespace: {{ .Release.Namespace }}`)
- `packages/operator/charts/kagent-workbench/templates/clusterrolebinding-actions.yaml` (kind: `ClusterRoleBinding` → `RoleBinding`; `roleRef.kind: ClusterRole` → `Role`; added `metadata.namespace`)

**Filenames retained** for git history continuity; documented inline that "clusterrole" prefix is a misnomer.

**Render verification:** `helm template packages/operator/charts/kagent-workbench` confirms the actions surface emits namespace-scoped Role + RoleBinding bound to the chart's release namespace. Read surface (`clusterrole.yaml` + `clusterrolebinding.yaml`) is unchanged — still cluster-scoped because nodes/pods/events are needed cluster-wide for the dashboard.

---

### H20 — alg-confusion via PEM length heuristic

**Files changed:**
- `packages/operator/src/cap-ca.ts` (require explicit `KAGENT_CAP_SIGNING_ALG` in the SPIRE branch, fail closed)
- `packages/operator/src/cap-ca.test.ts` (7 new H20 tests + updated 2 existing SPIRE tests)

**Shape of fix:** When `KAGENT_IDENTITY_ENABLED=true` AND a SPIRE-managed signing-key pair is present at `/var/kagent/spire-cap-ca/tls.{key,crt}`, refuse to proceed without an explicit `KAGENT_CAP_SIGNING_ALG` env (`ES256` or `RS256`). The `detectAlgFromPem` heuristic is retained for the chart-Secret path (operator-controlled key generation, so the heuristic is robust there) and unchanged for the back-compat fall-back path when SPIRE files are absent.

**Chart impact:** `packages/operator/charts/kagent-operator/values.yaml` already defaults `capabilities.alg: 'ES256'`, which the deployment template projects as `KAGENT_CAP_SIGNING_ALG=ES256`. Production deployments get the explicit alg out of the box; no chart change needed.

**Tests added/updated:**
- New: ES256 PEM with explicit ES256 env succeeds; RS256 PEM with explicit RS256 env succeeds; missing env in SPIRE branch fails closed; unknown alg (e.g. `HS256`) fails closed; RS256 PEM with mismatched ES256 env fails at materials load (`importPKCS8` rejects); chart-Secret path is unaffected; SPIRE-fallback to chart-Secret does NOT enforce explicit alg (back-compat).
- Updated: existing Wave-3 SPIRE-source tests now thread `KAGENT_CAP_SIGNING_ALG: 'ES256'` to match the new contract.

**Verifier:** `npm test` 1165 → 1172 passing in operator.

---

## Verification commands

```bash
# Operator
cd packages/operator
npm run typecheck   # PASS
npm run lint        # PASS
npm test            # 1172 passing
npm run test:coverage  # FAILS thresholds — see H5 follow-up note above

# Charts
helm template packages/operator/charts/kagent-operator    # OK
helm template packages/operator/charts/kagent-workbench   # OK; actions = Role + RoleBinding
```

---

## Wired-but-dead-code scan (operator scope)

Scan executed per `evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md`. All optional-call sites in `packages/operator/src/` reviewed; none are NEW WBD instances introduced by this wave's changes.

### Existing instances (no change in this wave)

| ID       | Class      | File:line                                     | Status                                                                        |
|----------|------------|----------------------------------------------|-------------------------------------------------------------------------------|
| WBD-OP-1 | WBD        | `agent-workflow-controller.ts:146,517,519`    | Pre-existing. `auditEmit` declared optional; main.ts production wireup at `2485-2496` does not pass the dep. `workflow.started` / `event_subscription_pending` events silently no-op. **Not in W2 scope** — already queued. |
| WBD-OP-2 | DEADBRANCH | `supervision-router.ts:412-418`               | Pre-existing. `if (deps.listChildrenForParent !== undefined)` branch body is a comment-only no-op; falls through to LIST regardless. **Not in W2 scope** — already queued. |

### Other optional-call sites reviewed (not WBD)

All of these were inspected and classified per the taxonomy in `WIRED-BUT-DEAD-CODE-PARADIGM.md`; none meet the "tests inject + production omits + fallback collapses to a sensible-looking value" four-of-four signature.

| File:line                                  | Pattern                                                  | Classification                                                          |
|--------------------------------------------|----------------------------------------------------------|-------------------------------------------------------------------------|
| `cas-gc.ts:263`                            | `deps.now?.() ?? Date.now()`                              | Test-clock injection. Production wireup leaves `deps.now` undefined and the `Date.now()` fallback IS the production behavior. Not WBD. |
| `reconcile.ts:670`                         | `deps.resolveTenantForTask?.(task, agent)`               | Wired in main.ts:1758 (`resolveTenantForTask` always passed). Not WBD. |
| `reconcile.ts:715,725`                     | `deps.emitCapabilityMinted?.()`, `deps.emitKeyrotationCapMintedWithTtl?.()` | Wrapper functions ARE wired in main.ts:1759-1764; the optional-chain is on a `*AuditHolder` mutable holder filled at audit-publisher init time (main.ts:2085-2094). Deferred-binding pattern, not WBD. |
| `main.ts:1760,1763,1766`                   | `capabilityAuditHolder.emitCapabilityMinted?.()` and friends | Same deferred-binding holder pattern. Holder populated at main.ts:2085-2111 once audit publisher initializes. Not WBD. |
| `main.ts:2697,3019,3542`                   | `<timer>.unref?.()`                                       | Conservative null-guard on Node `Timeout.unref`. Not a feature dep. Not WBD. |
| `triggers-bootstrap.ts:183`                | `deps.resolveTriggerSecret?.(id)`                        | Wired in main.ts:2301 from per-trigger env var. Not WBD. |
| `workspace-controller.ts:460,465,481,491`  | `input.lookupPvc?.(...)`, `input.lookupCloneJob?.(...)` | Wired in workspace-controller.ts:825 from informer caches. Not WBD. |
| `informer-restart.ts:166`                  | `logger.onCapReached?.(err, totalAttempts)`              | NEW (H6). Production callers in watch.ts and job-watch.ts both define `onCapReached` non-conditionally. Tests do likewise. Not WBD. |
| `watch.ts:112,118,124,140,150,164`         | `handler.onError?.(err)`                                 | Pre-existing optional logger. main.ts:1134 passes `onError` non-conditionally. Tests likewise. Not WBD. |
| `job-watch.ts:133,136,146,153,167,172,175,179,186,200` | `handler.onError?.(err)`                       | Same. Not WBD. |

### Sibling cases worth noting

- The deferred-binding holder pattern (`*AuditHolder.fn?.()`) appears multiple times in main.ts. While it superficially matches the WBD shape, it's structurally different: the wrapper is wired non-optionally in deps, and the holder field IS populated at runtime once the audit publisher initializes. The optional-chain is a "audit publisher not yet initialized OR audit disabled" guard, not a "production forgot to wire it." This is correct.
- The new `informer-restart.ts` introduces `onStartRejected` (required) and `onCapReached?` (optional). The optional shape is intentional — tests that don't care about the cap can omit it. Production callers (`watch.ts`, `job-watch.ts`) always wire both. If a future caller of `createRestarter` omits `onCapReached`, the cap will silently be reached without operator visibility — the M21 hook itself is the readyz wiring; until then, the loud `console.error` in `onStartRejected` (which fires on every attempt up to the cap) ensures the failure is visible in operator logs.

---

## Summary

| Item                  | Status |
|-----------------------|--------|
| H5 (vitest threshold) | DONE — thresholds set; coverage gap is itself the follow-up. |
| H6 (informer restart) | DONE — safeRestart + tests landed; M21 readyz hook groundwork in place. |
| H17 (actions RBAC)    | DONE — Role + RoleBinding scoped to release namespace. |
| H20 (alg-confusion)   | DONE — explicit alg required for SPIRE branch; chart already supplies it. |
| WBD scan              | DONE — no new WBD instances introduced; pre-existing WBD-OP-1 + WBD-OP-2 unchanged. |
| Push to main          | DONE — `5e7735e..2b31fdf`. |
