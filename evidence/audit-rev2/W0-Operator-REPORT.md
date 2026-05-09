# W0-Operator — BLOCKERs B3 + B4 Report

**Date:** 2026-05-07
**Worker:** W0-Operator
**Scope:** `packages/operator/src/**`, `packages/operator/charts/kagent-operator/**`, `docs/MODEL-ROUTING.md`
**Branch:** `main`
**Pushed to:** `origin/main`

---

## 1. Commits landed

| BLOCKER | SHA | Title |
|---|---|---|
| B3 | `3d71a7b` | `fix(operator): skip verifier-labeled Jobs in onJob handler to avoid clobbering parent AgentTask conditions (B3)` |
| B4 | `73deac1` | `docs(model-routing): retract hot-reload claim and document Helm-rollout pattern (B4)` |

Both commits include the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.

### Concurrency note (FYI for the arbiter)

This worker shared the working-tree index with W1-Operator (NB1), W2-Operator (B5/B7), and W3-Operator (B6) running in parallel against the same `main` worktree. Two earlier B3 commit attempts (e50de94, afde681) were observed taking the wrong staged file set due to index races between concurrent agents. Final B3 commit `3d71a7b` was made with `git commit --only -F <msg> <pathspecs>` to lock the commit content to my four files; verified diff matches intent before push. No history rewrites; no force-push.

---

## 2. B3 — verifier↔job-watch label collision

### Fix shape

- **`packages/operator/src/verifier.ts`** — added exported `isVerifierJob(job)` predicate (pure; reads `metadata.labels[VERIFIER_JOB_LABEL] === 'true'`).
- **`packages/operator/src/main.ts`** — extracted the inline `onJob` body into an exported `routeJobEventToFailureSurface(job, surfaceFailure)` helper. Guard fires the verifier-skip return BEFORE `parentTaskRef(job)` and `detectJobFailure(job)`.
- **`packages/operator/src/job-route.test.ts`** (new, 130 lines) — regression tests:
  - verifier-labeled Failed Job → `surfaceFailure` NOT called.
  - regular dispatch Failed Job → `surfaceFailure` IS called with the parent ref + verdict.
  - orphan Job (no parent-task label) → skipped.
  - non-terminal Job → skipped.
- **`packages/operator/src/verifier.test.ts`** — 4 new `isVerifierJob` predicate cases (true; false on other-string label; false on absent label; false on absent metadata/labels).

### Verification

- `cd packages/operator && npm run typecheck` — green.
- `cd packages/operator && npm run lint` — green.
- `cd packages/operator && npm test` — **46 test files, 1148 tests, all passing.**
- `helm template packages/operator/charts/kagent-operator` — renders cleanly.

---

## 3. B4 — MODEL-ROUTING.md hot-reload doc lie

### Fix shape

- **`docs/MODEL-ROUTING.md §4`** — replaced the false "watches for ConfigMap updates (kubectl-friendly hot-reload)" sentence with the actual contract:
  - Map is stamped onto the operator deployment env as `KAGENT_AGENT_MODEL_CLASSES_JSON`.
  - Operator parses it once at boot via `parseModelClassesEnv` (`packages/operator/src/main.ts:206`).
  - Updates require `helm upgrade` + operator pod rollout. **No ConfigMap watch, no SIGHUP.**
  - In-flight Job pods retain the value baked into their env at spawn time and are unaffected by chart upgrades. (Cross-references `docs/CONTEXT-AWARENESS.md §7` for the same caveat applied to `contextWindowTokens`.)
- **`docs/MODEL-ROUTING.md §Cross-references`** — replaced stale pointers (`packages/operator/src/config/model-classes.ts`, `templates/configmap-model-classes.yaml`) with the actual files (`main.ts:206 parseModelClassesEnv`, `templates/deployment.yaml`).
- Added explicit out-of-scope note that the ConfigMap-watch path is queued as a separate v0.2 task; chart-values shape is forward-compatible.

### Verification

- Doc-only change. No code touched.

---

## 4. Wired-but-dead-code SCAN — operator scope

Scans run per `WIRED-BUT-DEAD-CODE-PARADIGM.md` Step 1:

```
grep -rnE 'deps\.\w+\?\.\(' packages/operator/src --include='*.ts' --exclude='*.test.ts'
grep -rnE '\?\.\([^)]*\)\s*\?\?\s*[\{\[]' packages/operator/src --include='*.ts' --exclude='*.test.ts'
```

Plus broader `\.\w+\?\.\(` scan to catch `input.<name>?.()` and `handler.<name>?.()` shapes.

### Confirmed wired-but-dead findings

#### WBD-OP-1 — `agent-workflow-controller.ts:517,519` (`deps.auditEmit?`)

- **Finding:** AgentWorkflow lifecycle audit emissions (`workflow.started`, `event_subscription_pending`) silently no-op in production.
- **Declaration:** `packages/operator/src/agent-workflow-controller.ts:146` — `readonly auditEmit?: WorkflowAuditEmit;`
- **Production callsite:** `packages/operator/src/main.ts:2485-2496` — `buildAgentWorkflowController({ kc, customApi, coreApi, appsApi, capCa, ... options })` — **no `auditEmit` argument**. The conditional spread at `agent-workflow-controller.ts:945` `...(input.auditEmit !== undefined && { auditEmit: input.auditEmit })` ensures `deps.auditEmit` is `undefined` in production.
- **Test callsite:** `packages/operator/src/agent-workflow-controller.test.ts:107` — `const auditEmit = overrides.auditEmit ?? vi.fn();` — tests inject the dep directly.
- **Fallback value:** `undefined` → `?.` skips. No emission.
- **Impact:** Operators looking for `agent.workflow.started` / `agent.workflow.event_subscription_pending` events on the audit stream see nothing for legitimately-started AgentWorkflows. Cluster-side observability gap on the AgentWorkflow lifecycle.

#### WBD-OP-2 — `supervision-router.ts:412-418` (`deps.listChildrenForParent` block in `fetchParentTask`)

- **Finding:** Already documented as M2 in `evidence/audit-rev2/C1.md`. The `if (deps.listChildrenForParent !== undefined) { ... }` block at `supervision-router.ts:412-418` is a no-op comment block — the body holds only an explanatory comment about why it cannot use the dep here, then falls through to the unbounded LIST regardless. Production main.ts:1712 DOES wire `listChildrenForParent`, but `fetchParentTask` cannot use it (siblings-by-parent-UID reader can't return the parent itself), so the wiring is unused on this code path.
- **Declaration:** `packages/operator/src/supervision-router.ts:130`
- **Production callsite:** `packages/operator/src/main.ts:1712` — wired to `listChildrenForParent` closure at `main.ts:1423`.
- **Effective behavior:** every supervision dispatch fans out to a full `listNamespacedCustomObject` LIST (linear scan) because the cache reader can't resolve the parent UID under its current shape.
- **Impact:** Linear-scan LIST per supervision reconcile in clusters with many AgentTasks. Not a feature regression (it was always doing the LIST), but the conditional makes the code look faster than it is. Already queued as M2.

### Hits classified as NOT wired-but-dead (for the record)

| Site | Disposition |
|---|---|
| `triggers-bootstrap.ts:183 deps.resolveTriggerSecret?.(id)` | WIRED — `main.ts:2232` plumbs env-var-keyed reader. |
| `reconcile.ts:670 deps.resolveTenantForTask?` | WIRED — `main.ts:1689`. |
| `reconcile.ts:715 deps.emitCapabilityMinted?` and `:725 deps.emitKeyrotationCapMintedWithTtl?` | CONDITIONAL by-design. Production passes a thunk that itself dereferences a holder (`capabilityAuditHolder.emit*?`) populated only when `KAGENT_AUDIT_NATS_URL` is set. This is the documented "audit best-effort" pattern from `docs/WAVES.md` — when audit is disabled the emission no-ops; when enabled it emits. NOT the wired-but-dead paradigm (which requires the production wireup to omit a dep tests inject). |
| `main.ts:1691,1694,1697 capabilityAuditHolder.emit*?` | Same as above — inner thunks of the audit-best-effort pattern. |
| `agent-workflow-controller.ts:495 input.lookupDeployment?` | WIRED inside the controller itself at `agent-workflow-controller.ts:1015`. |
| `workspace-controller.ts:460,465,481,491 input.lookupPvc/lookupCloneJob?` | WIRED inside the controller itself at `workspace-controller.ts:825`. |
| `cas-gc.ts:263 deps.now?.()` | Clock injection — `Date.now()` fallback is correct production behavior. Not a feature dependency; not the paradigm shape. |
| `main.ts:2628,2950,3473 timer.unref?.()` | Node API existence check (`Timeout.unref` always present in v22+). Defensive, not feature plumbing. |
| `watch.ts:97,103,109,113 + job-watch.ts:117,120,123,130,133,136 handler.onError?` | Caller-shaped optional. Production main.ts always provides `onError`. |

### Step 2 summary

- **2 confirmed wired-but-dead sites** in operator scope (WBD-OP-1, WBD-OP-2).
- **WBD-OP-2 was already known** (M2 in C1.md). NEW finding for the arbiter to triage: **WBD-OP-1** (`auditEmit` in AgentWorkflow controller).
- WBD-OP-1 is a low-severity observability gap (operators relying on AgentWorkflow audit events get silence); not a security-shape (no capability bypass, no auth bypass), so does NOT need BLOCKER-shape escalation per the paradigm doc's high-shape list.

Per the paradigm doc's discipline ("do NOT fix in this wave; the arbiter will queue them as new tasks"), no fix is included in this PR.

---

## 5. Out of scope (untouched)

- B5 (workbench-api `MIN_SAFE_MIN`) — landed by W2-Operator as `67124d9`.
- B6 (workbench chart fail-open) — landed by W3-Operator as `eeb6b5d`.
- B7 (llm-gateway bundled-Postgres) — landed by W2-Operator as `6000ac6`.
- NH3/NH4 — W1-Operator scope.
- NB1 (agent-pod tokenUtilizationSnapshot) — landed by W1-Operator as `78975df`.
- All H/M findings — W2/W3-Operator scope.

No `agent-pod`, `agent-loop`, `llm-gateway`, `workbench-api`, or `kagent-workbench` chart files were modified by W0-Operator.

---

## 6. Net delta vs C1.md

- **B3:** `STILL OPEN` → **CLOSED.** `routeJobEventToFailureSurface` guards `isVerifierJob(job)` BEFORE `parentTaskRef`/`detectJobFailure`. Verifier verdicts can no longer route through `surfaceFailure` and clobber parent AgentTask conditions. Regression test in place.
- **B4:** `STILL OPEN` → **CLOSED.** `docs/MODEL-ROUTING.md §4` no longer claims hot-reload semantics. The Helm-rollout pattern is documented explicitly with a forward pointer to the v0.2 ConfigMap-watch task.

No other audit-rev2 line items were touched by this worker.
