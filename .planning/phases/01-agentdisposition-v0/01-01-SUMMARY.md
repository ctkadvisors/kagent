---
status: complete
phase: 01-agentdisposition-v0
plan: 01
subsystem: infra
tags: [kubernetes, configmap, helm, argocd, audit-events, vitest, jsdom, rbac, disposition]

# Dependency graph
requires:
  - phase: v0.1 (legacy, in docs/ROADMAP.md)
    provides: operator chart, ClusterRole, audit-events package, dto package, workbench-ui package, K3s+ArgoCD substrate
provides:
  - DISP-01 sibling-ConfigMap overlay carrier (label kagent.knuteson.io/agent-disposition=true, annotation kagent.knuteson.io/agent-ref)
  - parseDispositionConfigMap (in @kagent/dto) — single-source-of-truth parser reused by operator + workbench-api
  - loadDispositionOverlays + loadDispositionOverlayForAgent (operator-side K8s-list path)
  - PROPOSAL_TOOL_MAP + classifyToolAsProposal — DISP-02 capability narrowing source of truth
  - disposition-schema-validate Helm-templated ArgoCD-deployable Job manifest (gated by .Values.dispositionSchemaTest.enabled)
  - DISPOSITION_PROPOSAL_REJECTED + DISPOSITION_OVER_BUDGET audit event types (ALL_EVENT_TYPES.length: 47 → 49)
  - configmaps:patch verb on operator ClusterRole (unblocks DISP-03 proposals-today annotation)
  - @kagent/workbench-ui vitest + jsdom infrastructure (unblocks DISP-04)
  - tests/fixtures/disposition/* — overlay-valid.yaml, overlay-missing-tokens.yaml, gateway-usage-rows.json
affects: [01-02-disposition (DISP-02), 01-03-disposition (DISP-03), 01-04-disposition (DISP-04)]

# Tech tracking
tech-stack:
  added:
    - js-yaml@4 (npm-installed by schema-validate Job at runtime; not bundled)
    - vitest + @vitest/ui + jsdom + @testing-library/react (workbench-ui devDeps)
  patterns:
    - "Overlay carrier as labeled+annotated sibling ConfigMap (no new CRD)"
    - "Schema validation as ArgoCD Sync hook Job (no admission webhook)"
    - "Cross-package shared parser: dto exports parseDispositionConfigMap, operator imports it"
    - "ALL_EVENT_TYPES sanity test ensures discriminated-union completeness in audit-events"
    - "PROPOSAL_TOOL_MAP carries OBSERVATION-PHASE-ONLY warning in source comments + summary"

key-files:
  created:
    - packages/dto/src/disposition-parser.ts
    - packages/dto/src/disposition-parser.test.ts
    - packages/operator/src/disposition/proposal-tool-map.ts
    - packages/operator/src/disposition/proposal-tool-map.test.ts
    - packages/operator/src/disposition/overlay-loader.ts
    - packages/operator/src/disposition/overlay-loader.test.ts
    - packages/operator/charts/kagent-operator/templates/disposition-schema-validate.yaml
    - packages/workbench-ui/vitest.config.ts
    - packages/workbench-ui/tsconfig.eslint.json
    - tests/fixtures/disposition/overlay-valid.yaml
    - tests/fixtures/disposition/overlay-missing-tokens.yaml
    - tests/fixtures/disposition/gateway-usage-rows.json
  modified:
    - packages/audit-events/src/event-types.ts
    - packages/audit-events/src/types.ts
    - packages/audit-events/src/make-event.test.ts
    - packages/dto/src/index.ts
    - packages/dto/package.json
    - packages/operator/charts/kagent-operator/templates/clusterrole.yaml
    - packages/operator/charts/kagent-operator/values.yaml
    - packages/workbench-ui/package.json

key-decisions:
  - "ConfigMap label+annotation pair (kagent.knuteson.io/agent-disposition=true + kagent.knuteson.io/agent-ref=ns/name) is the canonical overlay-attachment contract; no new CRD."
  - "Schema validation runs as an ArgoCD Sync-hook Job, not an admission webhook — keeps the substrate operator-poor."
  - "parseDispositionConfigMap lives in @kagent/dto so workbench-api and operator share one parser; no duplicate validation logic."
  - "PROPOSAL_TOOL_MAP v0.1 mapping (templates→write_artifact, verifiers→verifier_register, capability-policy→capability_policy_propose) is OBSERVATION-PHASE ONLY — narrowing in production blocks legitimate work; documented in source comments."
  - "Disposition annotation names locked: kagent.knuteson.io/proposals-today (count) + kagent.knuteson.io/proposals-today-day (UTC day window). Earlier-draft proposals-today-reset-at MUST NOT appear anywhere."
  - "Operator ClusterRole gains configmaps verbs [get,list,watch,create,delete,patch] so DISP-03 can write the proposals-today annotation."

patterns-established:
  - "Disposition overlay = sibling ConfigMap (label+annotation), not CRD subresource — pattern for future overlay carriers."
  - "Helm-templated, ArgoCD-deployable Job for schema validation — pattern for future GitOps-only verification."
  - "Cross-package single-source parser exported from @kagent/dto — pattern for any K8s-shape DTO shared between operator and API surface."

requirements-completed: [DISP-01]

# Metrics
duration: ~6h (planner-led; spans worktree execution + main merge + cluster verification)
completed: 2026-05-09
---

# Phase 01 Plan 01: AgentDisposition Wave 0 + DISP-01 Summary

**ConfigMap-shaped agent disposition overlay carrier with Helm-templated ArgoCD-deployable schema-validate Job, shared @kagent/dto parser, PROPOSAL_TOOL_MAP, two new audit event types, configmaps:patch RBAC, and workbench-ui vitest infrastructure — the unblocker for DISP-02..04.**

## Performance

- **Duration:** ~6h (worktree execution + main merge + cluster verification)
- **Completed:** 2026-05-09T19:27Z
- **Tasks:** 7 / 7
- **Files modified:** 20 (12 created, 8 modified) per plan `files_modified` list

## Accomplishments

- Lands DISP-01 (REQ-DISP-01): sibling-ConfigMap overlay carrier representable on shipped v0.1 substrate primitives, no new CRD / reconciler / admission webhook.
- Ships a Helm-templated, ArgoCD-deployable `disposition-schema-validate` Job (Sync hook) that rejects overlays missing `idleBehavior.attentionBudget.tokensPerDay` (and the rest of the required schema) with non-zero exit.
- Establishes `parseDispositionConfigMap` in `@kagent/dto` as the single-source-of-truth parser reused by operator (`overlay-loader.ts`) and (later) workbench-api.
- Lands `PROPOSAL_TOOL_MAP` as the contract DISP-02 narrows capability claims against — with a prominent OBSERVATION-PHASE-ONLY warning in source.
- Adds `DISPOSITION_PROPOSAL_REJECTED` and `DISPOSITION_OVER_BUDGET` to `@kagent/audit-events`; `ALL_EVENT_TYPES.length` updated to 49; sanity tests pass.
- Grants operator ClusterRole the `configmaps:patch` verb so DISP-03's proposals-today annotation pattern is RBAC-feasible.
- Stands up vitest + jsdom + @testing-library/react in `@kagent/workbench-ui` so DISP-04's `DispositionOverlay.test.tsx` has a place to run.
- Captures cluster verification: `disposition-schema-validate` Job runs Complete (1/1) on homelab K3s after Argo flips `dispositionSchemaTest.enabled=true`.

## Task Commits

Each task was committed atomically (in worktree, then merged into main; merge SHA: `88cfd60`):

1. **Task 1: Extend @kagent/audit-events with disposition.\* event types** — `aed806d` (feat)
2. **Task 2: PROPOSAL_TOOL_MAP + disposition overlay-loader primitives** — `f443221` (feat)
3. **Task 3: configmaps:patch RBAC for operator ClusterRole** — `fceb070` (feat)
4. **Task 4: Reusable disposition test fixtures** — `c5e49ab` (test)
5. **Task 5: vitest + jsdom infra for @kagent/workbench-ui** — `db5a302` (chore)
6. **Task 6: disposition-schema-validate Job manifest (DISP-01)** — `5c3ca8e` (feat)
7. **Task 7: cluster verification + plan close** — see Cluster verification section below; SUMMARY committed atomically by this docs commit.

**Worktree → main merge:** `88cfd60` (chore: merge executor worktree — wave 1 plan 01-01 tasks 1-6)

**Plan metadata:** this docs commit (added at end of this plan; see `git log -1` after commit).

## Files Created/Modified

Created (12):

- `packages/dto/src/disposition-parser.ts` — `DispositionOverlay` type + `parseDispositionConfigMap(cm)` (the shared parser)
- `packages/dto/src/disposition-parser.test.ts` — parser unit tests (valid + missing-required-field paths)
- `packages/operator/src/disposition/proposal-tool-map.ts` — `PROPOSAL_TOOL_MAP`, `PROPOSAL_KINDS`, `classifyToolAsProposal`
- `packages/operator/src/disposition/proposal-tool-map.test.ts` — kind-set, tool-mapping, classifier tests
- `packages/operator/src/disposition/overlay-loader.ts` — `loadDispositionOverlays` + `loadDispositionOverlayForAgent` (K8s list path)
- `packages/operator/src/disposition/overlay-loader.test.ts` — loader tests using fixture overlays
- `packages/operator/charts/kagent-operator/templates/disposition-schema-validate.yaml` — Helm-templated ArgoCD Sync-hook Job
- `packages/workbench-ui/vitest.config.ts` — jsdom environment config
- `packages/workbench-ui/tsconfig.eslint.json` — ESLint TS config
- `tests/fixtures/disposition/overlay-valid.yaml` — canonical seed overlay (consumed by Job + DISP-02 + DISP-03)
- `tests/fixtures/disposition/overlay-missing-tokens.yaml` — negative-path fixture
- `tests/fixtures/disposition/gateway-usage-rows.json` — `GatewayUsageRow[]` for DISP-03 spentTokensToday projection

Modified (8):

- `packages/audit-events/src/event-types.ts` — added `DISPOSITION_PROPOSAL_REJECTED`, `DISPOSITION_OVER_BUDGET`; `ALL_EVENT_TYPES.length` is now 49
- `packages/audit-events/src/types.ts` — extended `AuditEventType` union + `AuditEventData` discriminated union
- `packages/audit-events/src/make-event.test.ts` — sanity test count bumped to 49
- `packages/dto/src/index.ts` — re-exports parser + label/annotation constants
- `packages/dto/package.json` — wiring
- `packages/operator/charts/kagent-operator/templates/clusterrole.yaml` — configmaps verbs `[get,list,watch,create,delete,patch]`
- `packages/operator/charts/kagent-operator/values.yaml` — `dispositionSchemaTest.enabled` flag (default false)
- `packages/workbench-ui/package.json` — vitest + jsdom + @testing-library/react devDeps

## Plan-level verifications

The pre-checkpoint executor reported (and tests are reproducible from the SHAs above):

- `packages/audit-events`: **54 / 54 tests pass** (includes sanity test against `ALL_EVENT_TYPES.length === 49`)
- `packages/dto`: **52 / 52 tests pass** (includes new `disposition-parser.test.ts`)
- `packages/operator`: **1242 / 1242 tests pass** (includes new `proposal-tool-map.test.ts`, `overlay-loader.test.ts`)
- `packages/workbench-ui`: `pnpm --filter @kagent/workbench-ui test --run --passWithNoTests` **exits 0** (vitest infra wired, no specs yet — DISP-04 will add them)
- `helm lint packages/operator/charts/kagent-operator` — **clean**
- `helm template ... --set dispositionSchemaTest.enabled=true | grep 'kind: Job'` — Job rendered when flag on; absent when flag off (gating works)
- `helm template ... --set dispositionSchemaTest.enabled=true | grep -c "tokensPerDay"` — returns 4 (see Notes / deviations item (c) below)

## Cluster verification (Task 7)

After merging the chart to main, the orchestrator pushed companion changes through ArgoCD on the homelab K3s cluster:

- **kagent main:** `88cfd60` (chart with Job template + js-yaml validator) — pushed.
- **new_localai main:** `217fad3` (kustomized canonical Application sets `helm.values.dispositionSchemaTest.enabled=true`); doc-copy mirror at `7e8f93b` per kustomization convention.
- **Argo apps refreshed:** `homelab-apps` + `kagent` hard-refreshed.

Resulting cluster state:

```text
$ kubectl -n kagent-system get jobs -l phase=01-disposition
disposition-schema-validate   Complete   1/1   7s    22s

$ kubectl -n kagent-system get job disposition-schema-validate \
    -o jsonpath='{.status.succeeded}/{.status.conditions[0].type}'
1/SuccessCriteriaMet

$ kubectl -n kagent-system logs job/disposition-schema-validate
[disposition-schema-validate] installing js-yaml@4 from npm registry…
valid: OK
invalid: correctly rejected (idleBehavior.attentionBudget.tokensPerDay must be a positive number)
disposition-schema-validate: OK
```

Pod completed in 7s; Pod `restartPolicy=Never` honored; no retries needed. The negative-path assertion (`invalid: correctly rejected`) confirms the schema-validate Job rejects overlays missing `idleBehavior.attentionBudget.tokensPerDay` with a non-zero exit at the validator level (the Job aggregates valid+invalid checks and exits 0 only when BOTH are correct — so a regression in either path fails the Job).

## Decisions Made

- **D-DISP-01-A:** Overlay carrier is a labeled+annotated sibling ConfigMap, not a new CRD or admission webhook — preserves substrate-poor v0.1 invariants.
- **D-DISP-01-B:** Schema validation is a Helm-templated ArgoCD Sync-hook Job, gated behind `.Values.dispositionSchemaTest.enabled` so production overlays don't carry test fixtures.
- **D-DISP-01-C:** `parseDispositionConfigMap` lives in `@kagent/dto` (not `@kagent/operator`) so workbench-api can import the same parser without taking an operator dep.
- **D-DISP-01-D:** PROPOSAL_TOOL_MAP v0.1 mapping is OBSERVATION-ONLY, documented in source. Production deployments must NOT narrow `mayProposeAgainst` until v0.3 wires propose-specific tool names.
- **D-DISP-01-E:** Annotation names locked: `proposals-today` + `proposals-today-day`. The earlier-draft `proposals-today-reset-at` is retired and must not reappear.

## Deviations from Plan

### Notes / handling

**1. [Note] Worktree → main merge timing.** Plan 01-01 was originally executed in a parallel worktree. Tasks 1-6 commits were merged to main early (commit `88cfd60`) so that the just-pushed chart with the new Job template was reachable from the live ArgoCD repo URL — without that merge, ArgoCD would not see the chart and the Task 7 cluster verification could not run. This is consistent with the plan's "GitOps verification only" rule.

**2. [Note] Two-copy mirror commits in `new_localai`.** The Argo flip (`dispositionSchemaTest.enabled=true`) was committed in two places per `new_localai`'s `kustomization.yaml` header convention:

- Canonical (kustomized): `k8s-kustomized/overlays/production/kagent/application.yaml` — commit `217fad3`
- Doc-copy mirror: `k8s/argocd-apps/kagent-app.yaml` — commit `7e8f93b`

Both commits push to `new_localai/main`; ArgoCD reads the canonical kustomized path.

**3. [Rule 1 - Verification adjustment] `helm template ... | grep -c "tokensPerDay"` returns 4, not the plan's "expected 1".** The plan's acceptance check assumed only the seed valid CM would carry `tokensPerDay`. In the actual rendered template the inline validator references `tokensPerDay` in 3 distinct error messages plus the seed valid CM carries it once → grep counts 4. The semantic invariant the plan was trying to assert — _the invalid-overlay test ConfigMap does NOT contain `tokensPerDay`_ — does hold (verified by reading the rendered template). Updating the plan's grep target to a more specific anchor was deferred (the cluster Job's runtime assertion `invalid: correctly rejected (idleBehavior.attentionBudget.tokensPerDay must be a positive number)` is the authoritative semantic check anyway). DISP-02..04 plans should not copy that grep verbatim.

**4. [Note] Unrelated pre-existing operator pod CrashLoopBackOff (`EADDRINUSE :8081`).** The operator deployment was already in CrashLoopBackOff before this plan started — its readiness/health server tries to bind :8081, which is occupied. This is unrelated to plan 01-01 and did not block the disposition-schema-validate Sync-hook Job from running successfully (Sync hooks run as standalone Pods, not inside the operator). Filing as out-of-scope for this plan; should be tracked separately.

---

**Total deviations:** 0 auto-fixed bugs; 4 notes (worktree→main merge timing, two-copy mirror convention, grep-count semantic adjustment, unrelated pre-existing operator pod).
**Impact on plan:** None of the deviations change DISP-01 surface area. Plan delivered exactly the artifacts in `must_haves.artifacts`.

## Issues Encountered

- ArgoCD `kagent` app needed a hard refresh after `217fad3` because the helm-values flip is cached in Argo's repo-server; refresh resolved.
- Initial cluster image-pull lag while `js-yaml@4` was npm-installed by the Job at runtime (Job mounts npm cache between runs to mitigate; first run was the 7s observed).

## User Setup Required

None - no external service configuration required for plan 01-01. Operator chart values flag `dispositionSchemaTest.enabled` is the only knob; it is set at the ArgoCD Application layer in `new_localai` (commits `217fad3` + `7e8f93b`).

## Next Phase Readiness

DISP-02 (Wave 2) is unblocked:

- `PROPOSAL_TOOL_MAP` constant + `classifyToolAsProposal` helper available at `packages/operator/src/disposition/proposal-tool-map.ts`.
- `loadDispositionOverlayForAgent` lets the cap-mint pipeline pull the overlay by Agent ref.
- `parseDispositionConfigMap` validated; DISP-02 can rely on the parsed shape.

DISP-03 (Wave 2) is unblocked:

- `configmaps:patch` verb on operator ClusterRole — required for the proposals-today annotation write pattern.
- `DISPOSITION_OVER_BUDGET` audit event type ready to emit.
- `tests/fixtures/disposition/gateway-usage-rows.json` fixture ready for spentTokensToday projection unit test.

DISP-04 (Wave 2) is unblocked:

- `@kagent/workbench-ui` vitest + jsdom + @testing-library/react infrastructure ready.
- `DispositionOverlay.test.tsx` will run against the fixture overlays.

No blockers carried forward.

## Self-Check: PASSED

- All 6 task commits exist in `git log` on main: aed806d, f443221, fceb070, c5e49ab, db5a302, 5c3ca8e.
- Merge commit 88cfd60 brings them into main.
- Cluster verification evidence (kubectl outputs + new_localai SHAs 217fad3 / 7e8f93b) embedded above.
- All `must_haves.artifacts` paths exist on main (verified by the executor pre-checkpoint and visible in the merged tree).
- `ALL_EVENT_TYPES.length === 49` invariant holds (audit-events test 54/54 pass).
- No edits to STATE.md or ROADMAP.md in this commit (orchestrator owns those).

---

_Phase: 01-agentdisposition-v0_
_Plan: 01_
_Completed: 2026-05-09_
