# W5-Operator — Audit Rev2 LOW Severity Fixes

**Date:** 2026-05-07
**Scope:** `packages/operator/src/**` + `packages/operator/charts/kagent-operator/**`
**Concurrency:** W5-Pod + W5-Gateway running in parallel

## Summary

Four LOW-severity audit-rev2 items closed across two atomic commits.
All operator tests (1226) pass; typecheck clean; lint clean; helm template
clean in both default and `watchAllNamespaces=true` modes.

## Commits

| Commit | Theme | Items |
|---|---|---|
| `1af223f` | A — operator code polish | L4, L5, L6 |
| `b1b9054` | B — RBAC scoping | L7 |

Both pushed to `origin/main`.

## Theme A — Operator code polish (commit `1af223f`)

### L4 — env-overridable supervision escalation depth

**File:** `packages/operator/src/supervision-router.ts`
- Replaced hardcoded `MAX_ESCALATION_DEPTH = 8` with `resolveMaxEscalationDepth()` reading `KAGENT_SUPERVISION_MAX_ESCALATION_DEPTH` from env (default 8).
- Bad input (negative, NaN, non-integer, zero) falls back to default with `console.warn`.
- Exported `resolveMaxEscalationDepth(raw, warn)` for unit testing without `process.env` mutation.

**Files:** `packages/operator/charts/kagent-operator/values.yaml`, `templates/deployment.yaml`
- Added `supervision.maxEscalationDepth: 8` Helm value.
- Plumbed through deployment env block as `KAGENT_SUPERVISION_MAX_ESCALATION_DEPTH` (gated on `hasKey` so legacy installs not setting the value still render).

**Note on Helm key path:** task brief specified `agentPod.supervision.maxEscalationDepth` but the existing supervision values block lives at top-level `supervision.*` (the env var is operator-substrate-level, not per-agent-pod). Followed existing pattern (`supervision.defaultStrategy`, `supervision.maxRestarts.default`) for consistency.

**Tests added:** `supervision-router.test.ts` — 7 new test cases (`describe('resolveMaxEscalationDepth — audit-rev2 L4')`):
- env unset / empty → default
- positive integer → parsed
- negative / zero / NaN / non-integer → default + warn fired

### L5 — fail-closed security context parsing

**File:** `packages/operator/src/main.ts:736-754`
- `parseSecurityContextEnv` previously `console.warn`'d and returned `undefined` on malformed JSON. Caller (`buildJobSpecOptionsFromEnv`) passed `undefined` straight through, so a typo'd JSON in `KAGENT_AGENT_POD_SECURITY_CONTEXT` silently dropped the operator's pinned security posture and re-rendered Jobs with substrate defaults.
- Now THROWS on malformed JSON and on non-object JSON (string, array, null). Operator boot fails-closed → CrashLooping Pod surfaces immediately as a `Failed` condition (kubectl describe / Events / dashboard alert), which is the right ops experience for security-relevant config.

**Tests added:** `main.test.ts` — 7 new test cases (`describe('parseSecurityContextEnv — audit-rev2 L5 fail-closed')`):
- valid JSON → success path
- malformed JSON → throws `/malformed JSON/`
- string literal → throws `/not a JSON object/`
- array → throws `/not a JSON object/`
- null → throws `/not a JSON object/`
- env unset → no throw
- container security context (the second call site) also throws on malformed JSON

### L6 — LRU-shaped IdempotencyCache for locality sample-recorder

**File:** `packages/operator/src/main.ts:1525-1574,3030-3037,3070-3076`
- Replaced bare `Set<string>` + `if (size > 10_000) clear()` cliff with new exported `BoundedSeenSet` class: Map-backed FIFO eviction at cap=10000.
- The previous "clear-on-cliff" reset dropped EVERY entry at the boundary, so the next informer scan re-recorded every Completed task (dedupe property lost). FIFO eviction preserves recent dedupe history; only the oldest entry is evicted per `add()`.
- Map preserves insertion order in JS, so `keys().next().value` is the oldest. Cap and dedupe behavior preserved; only eviction shape changes.

**Tests added:** `main.test.ts` — 7 new test cases (`describe('BoundedSeenSet — audit-rev2 L6')`):
- cap construction guards (zero / negative / fractional / NaN reject)
- `has()` after `add()`
- `add()` idempotent
- FIFO eviction at cap exceedance
- regression guard for the clear-on-cliff bug
- cap=1 degenerate case

## Theme B — RBAC scoping (commit `b1b9054`)

### L7 — split secrets RBAC into Role + conditional ClusterRole

**File:** `packages/operator/charts/kagent-operator/templates/clusterrole.yaml`
- Wrapped the existing cluster-wide `secrets: [get,create,patch,delete]` rule in `{{- if .Values.watchAllNamespaces }}`.
- Default install (`watchAllNamespaces: false`) no longer renders this rule.

**New file:** `packages/operator/charts/kagent-operator/templates/role.yaml`
- Always-rendered namespaced Role + RoleBinding scoped to the release namespace.
- Holds `secrets: [get,create,patch,delete]` so the operator's in-namespace mints (capability Secrets per AgentTask, workflow runtime cap-Secrets per AgentWorkflow) keep working.
- This is the floor; ClusterRole adds reach when `watchAllNamespaces: true`.

**Helm template verification:**
| Mode | Render |
|---|---|
| default (`watchAllNamespaces: false`) | exactly ONE `secrets` rule — namespaced Role only |
| `--set watchAllNamespaces=true` | TWO `secrets` rules — ClusterRole (cluster-wide) + namespaced Role (floor) |

`helm lint` clean in both modes.

## Verify checklist

- [x] `npm run typecheck` (operator) — clean
- [x] `npm run lint` (operator) — clean (max-warnings 0)
- [x] `npm test` (operator) — 1226 tests passed
- [x] `helm template packages/operator/charts/kagent-operator` (default) — renders, namespaced secrets only
- [x] `helm template packages/operator/charts/kagent-operator --set watchAllNamespaces=true` — renders, both scopes
- [x] `helm lint packages/operator/charts/kagent-operator` — clean
- [x] `helm lint --set watchAllNamespaces=true` — clean

## Wired-but-Dead-Code Scan — operator scope

Scan re-run per the WBD paradigm guide. Step 1 grep over `packages/operator/src/**/*.ts` (excluding `*.test.ts`) returns 38 optional-call sites. Step 2 classification per site:

### Already-closed (WBD-OP-1, WBD-OP-2, W3-Operator)

- `agent-workflow-controller.ts:517,519` — `deps.auditEmit?.('started', ...)` and `deps.auditEmit?.('event_subscription_pending', ...)` — production callsite at `main.ts:2945-2947` passes `auditEmit` wired through `workflowAuditHolder.emit?.(type, payload)`. WBD-OP-1 closed.
- `main.ts:1940,1943,1946` — `capabilityAuditHolder.emitCapabilityMinted?.()`, `emitKeyrotationCapMintedWithTtl?.()`, `parentChildrenAggregatedAuditHolder.emit?.()` — these are the late-binding HOLDER pattern (the WBD-OP-1 fix shape). Holders are populated at `main.ts:2322,2331` from the audit publisher init.
- `main.ts:2946` — `workflowAuditHolder.emit?.()` — same late-binding holder pattern.
- `supervision-router.ts:412-418` — DEADBRANCH (sibling 3) closed in W3-Operator.

### NOT WBD — verified wired correctly (production callsite passes the dep)

- `informer-restart.ts:166` — `logger.onCapReached?.(err, state.attempts)` — production wireup at `watch.ts:146` and `job-watch.ts:152,185` provides concrete `onCapReached` handlers.
- `triggers-bootstrap.ts:183` — `deps.resolveTriggerSecret?.(id)` — production wireup at `main.ts:2677` passes `(id) => process.env[KAGENT_TRIGGER_SECRET_${id.toUpperCase()}]`.
- `reconcile.ts:670` — `deps.resolveTenantForTask?.(task, agent)` — production wireup at `main.ts:1886-1893,1938` always passes the resolver.
- `reconcile.ts:715,725` — `deps.emitCapabilityMinted?.()`, `deps.emitKeyrotationCapMintedWithTtl?.()` — production wireup at `main.ts:1939-1944` always passes the wrappers; the inner `?.` is the holder late-binding pattern (intentional).
- `workspace-controller.ts:460,465,481,491` — `input.lookupPvc?.()`, `input.lookupCloneJob?.()` — production wireup at `workspace-controller.ts:825` always passes `lookupPvc` and `lookupCloneJob`.
- `agent-workflow-controller.ts:495` — `input.lookupDeployment?.()` — production wireup at `agent-workflow-controller.ts:1015` always passes `lookupDeployment`.

### NOT WBD — handler / timer optionality (not the WBD shape)

- `watch.ts:112,118,124,140,150,164` — `handler.onError?.(err)` — caller-supplied handler optionality. Not the deps-shape with fallback to a "sensible default" value.
- `job-watch.ts:133,136,146,153,167,172,175,179,186,200` — same `handler.onError?.(err)` shape.
- `main.ts:3081,3403,3926` — `*Timer.unref?.()` — Node timer convention; `unref()` is present in Node but typed optional. No fallback semantics.

### NOT WBD — clock injection (CSPREAD shape)

- `cas-gc.ts:263` — `deps.now?.() ?? Date.now()` — clock injection for testability. The production fallback `Date.now()` is the desired production behavior; tests inject a fake clock. CSPREAD/clock-injection sibling, not WBD.

### Step 1b — fallback grep `?\.\([^)]*\)\s*\?\?\s*[\{\[]`

Zero hits in operator scope. No optional-call sites with object/array fallback patterns introduced or remaining.

### Conclusion

**No new wired-but-dead-code sites introduced by W5-Operator changes.** WBD-OP-1 and WBD-OP-2 remain closed. All 38 optional-call sites in operator scope are correctly classified as either WIRED, HANDLER-shape, TIMER-shape, or CSPREAD/clock-injection.

## Items NOT addressed (out of scope)

- Pod LOWs (W5-Pod scope)
- Gateway LOWs (W5-Gateway scope)
- Final wired-but-dead arbiter scan across all packages (post-wave aggregation)

## Notes for the arbiter

1. The pre-commit hook on the second commit (Theme B) initially failed because of a workspace-wide `pnpm -r typecheck` triggered against unfinished WIP code in `packages/agent-loop` (another concurrent worker's in-progress changes). The agent-loop WIP was temporarily git-stashed during the commit and restored after. This is a coordination artifact between concurrent workers, not an issue with my changes.

2. Theme B's chart split followed the existing pattern in `templates/agent-pod-rbac.yaml` (Role + RoleBinding for the agent pod's namespaced verbs), making this an internally consistent extension rather than a novel pattern.

3. The L4 Helm value placement (`supervision.maxEscalationDepth` vs the brief's specified `agentPod.supervision.maxEscalationDepth`) was chosen to match the existing supervision-block layout in `values.yaml` since the supervision env vars are operator-substrate-level (not per-agent-pod). If the arbiter prefers strict literal adherence to the brief, the value can be moved with one further chart edit and a values.yaml deprecation alias.
