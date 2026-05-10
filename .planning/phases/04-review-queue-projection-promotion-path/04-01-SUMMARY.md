---
phase: '04'
plan: '01'
subsystem: 'dto, audit-events, workbench-api-fixtures, operator-rbac'
tags: [wave-0, contracts, dto, audit-events, rbac, fixtures]
dependency_graph:
  requires: []
  provides:
    - '@kagent/dto ReviewQueueRow interface + ReviewReason closed-enum + assertIsReviewQueueRow'
    - '@kagent/dto ArtifactRefSummary + AgentTemplateSpec + parseAgentTemplateSpec'
    - '@kagent/audit-events REVIEW_REQUESTED / REVIEW_ACCEPTED / REVIEW_REJECTED / TEMPLATE_CANDIDATE_PROMOTED'
    - 'workbench-api __fixtures__/review-queue-snapshot.json (6 AgentTask scenarios)'
    - 'workbench-api __fixtures__/candidate-template.yaml (valid AgentTemplateSpec)'
    - 'operator clusterrole-actions.yaml: agenttasks [patch] + agenttemplates [create]'
    - 'operator clusterrole.yaml: agenttemplates [get,list,watch] + agenttemplates/status [get]'
  affects:
    - 'packages/dto/src/index.ts (barrel)'
    - 'packages/audit-events/src/index.ts (barrel)'
    - 'packages/audit-events/src/event-types.ts (ALL_EVENT_TYPES: 49->53)'
tech_stack:
  added:
    - 'parseAgentTemplateSpec uses existing yaml workspace dep (no new runtime dep)'
  patterns:
    - 'assertIsReviewQueueRow mirrors assertIsDispositionOverlayRow guard pattern'
    - 'ParseAgentTemplateSpecResult discriminated result (ok:true/false) — fail-closed'
    - 'Inline ReviewReason union in audit-events types (no @kagent/dto dep edge, LM-10)'
    - 'AgentTemplateSpec local re-declaration in @kagent/dto (LM-4, leaf dep)'
key_files:
  created:
    - packages/dto/src/review-queue.ts
    - packages/dto/src/review-queue.test.ts
    - packages/dto/src/template-candidate.ts
    - packages/dto/src/template-candidate.test.ts
    - packages/workbench-api/src/__fixtures__/review-queue-snapshot.json
    - packages/workbench-api/src/__fixtures__/candidate-template.yaml
  modified:
    - packages/dto/src/index.ts
    - packages/audit-events/src/event-types.ts
    - packages/audit-events/src/types.ts
    - packages/audit-events/src/index.ts
    - packages/audit-events/src/make-event.test.ts
    - packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml
    - packages/operator/charts/kagent-workbench/templates/clusterrole.yaml
decisions:
  - 'ReviewReason inline in audit-events types.ts (not imported from @kagent/dto) — keeps @kagent/audit-events a leaf dep (LM-10)'
  - 'AgentTemplateSpec locally declared in @kagent/dto/template-candidate.ts — same LM-4 leaf-dep rationale as ArtifactRef in crds.ts'
  - 'ArtifactRefSummary declared inline in review-queue.ts (not re-exported from crds.ts ArtifactRef) — summary view semantics are explicitly shallower'
  - 'RBAC: agenttemplates/status [get] added to clusterrole.yaml (plan said [get,list,watch] for resource; status subresource gets [get] consistent with agents/status pattern)'
metrics:
  duration: '11m (~689s)'
  completed_date: '2026-05-10'
  tasks_completed: 4
  files_changed: 13
---

# Phase 4 Plan 01: Wave 0 Scaffolding — Cross-Tier Contracts Summary

Wave 0 freezes every cross-tier contract artifact for Phase 4's review-queue + promotion-path slice: the `ReviewQueueRow`/`ReviewReason` DTO + YAML parser for candidate AgentTemplates + four new audit-event union members + fixture data for six classifier scenarios + additive RBAC verb extensions — all as pure data with no route code, no UI, no operator runtime changes.

## Tasks Completed

| #   | Commit    | Description                                                                                   |
| --- | --------- | --------------------------------------------------------------------------------------------- |
| 1   | `ab3f73e` | feat(phase-04-w0-dto): add ReviewQueueRow DTO + AgentTemplateSpec parser                      |
| 2   | `a9ed2e1` | feat(phase-04-w0-audit-events): extend audit-event union with 4 review-queue types            |
| 3   | `5fb16fb` | feat(phase-04-w0-fixtures): add review-queue-snapshot.json + candidate-template.yaml fixtures |
| 4   | `435e031` | feat(phase-04-w0-rbac): additive RBAC verb extensions for review-queue + promotion            |

## What Was Built

### Task 1 — DTO contracts (`@kagent/dto`)

**`packages/dto/src/review-queue.ts`** (new, ~210 lines):

- `ReviewQueueRow` interface — full shape with all 14 fields per CONTEXT.md D-01-A; all optional fields properly typed as `X | undefined`
- `ReviewReason` type — closed 6-member union (`verifier-failed`, `suspicious-detector`, `human-review-requested`, `candidate-template`, `replay-divergence`, `eval-failed`) with inline D-04 Phase-5 comment
- `ArtifactRefSummary` sub-interface — shallow summary view of artifact refs for the `candidateTemplate` sub-object
- `assertIsReviewQueueRow(value: unknown): asserts value is ReviewQueueRow` — runtime guard mirroring `assertIsDispositionOverlayRow` pattern; checks taskRef.namespace/name/uid, reason (all 6 known values), reasonDetail, enqueuedAt, stalenessSeconds, phase, and all optional fields with type enforcement

**`packages/dto/src/review-queue.test.ts`** (new, ~205 lines):

- 30+ vitest tests covering: valid row passes, minimal required-only row, candidate-template row, all 6 reasons, 15+ failure paths (missing fields, wrong types, unknown reason, nested object validation)

**`packages/dto/src/template-candidate.ts`** (new, ~220 lines):

- `AgentTemplateSpec` locally declared (LM-4 decision; mirrors `operator/src/crds/types.ts:1103-1117`)
- `AgentTemplateParameter`, `AgentTemplateBudget` supporting interfaces
- `ParseAgentTemplateSpecResult = { ok: true, spec } | { ok: false, error }` — fail-closed discriminated result
- `parseAgentTemplateSpec(yaml: string)` — 8-step validation: YAML parse, non-null object root, agentSpec required, templateVersion integer check, parameters array + type validation, budget object check, toolAllowlist/toolDefaults string array checks

**`packages/dto/src/template-candidate.test.ts`** (new, ~205 lines):

- 25+ vitest tests: valid YAML round-trips (minimal + full), all failure paths (malformed YAML, null root, array root, missing agentSpec, agentSpec wrong type, templateVersion float/zero, unknown parameter type, budget wrong type, toolAllowlist wrong type)

**`packages/dto/src/index.ts`** (modified):

- Barrel re-exports for all new types: `ReviewQueueRow`, `ReviewReason`, `ArtifactRefSummary`, `assertIsReviewQueueRow`, `AgentTemplateSpec`, `AgentTemplateBudget`, `AgentTemplateParameter`, `AgentTemplateParameterType`, `ParseAgentTemplateSpecResult`, `parseAgentTemplateSpec`

### Task 2 — Audit-event union (`@kagent/audit-events`)

**`packages/audit-events/src/event-types.ts`** (modified):

- 4 new const literals: `REVIEW_REQUESTED`, `REVIEW_ACCEPTED`, `REVIEW_REJECTED`, `TEMPLATE_CANDIDATE_PROMOTED`
- `ALL_EVENT_TYPES` grows from 49 to 53 entries

**`packages/audit-events/src/types.ts`** (modified):

- `AuditEventType` union extended with 4 new string literals
- 4 new data interfaces: `ReviewRequestedData`, `ReviewAcceptedData`, `ReviewRejectedData`, `TemplateCandidatePromotedData`
- `AuditEventData` discriminated union extended with 4 new variants
- `ReviewReason` inline union (not imported from `@kagent/dto`) in `ReviewAcceptedData`/`ReviewRejectedData` — preserves leaf dep boundary (LM-10)

**`packages/audit-events/src/index.ts`** (modified):

- Barrel re-exports for all 4 new type interfaces and constants

**`packages/audit-events/src/make-event.test.ts`** (modified):

- `ALL_EVENT_TYPES.length` assertion bumped 49 → 53 in catalog test
- Catalog array updated to include the 4 new event type strings
- 6 new round-trip tests: `review.requested` (x2, with and without optional fields), `review.accepted` (x2, for verifier-failed and candidate-template reasons), `review.rejected` (x1), `template.candidate.promoted` (x2, with and without optional uid)

### Task 3 — Workbench-API fixtures

**`packages/workbench-api/src/__fixtures__/review-queue-snapshot.json`** (new, 6 AgentTask objects):

1. `researcher-verifier-fail-01` — `phase: Failed`, `verification.passed: false`, `verification.reason: verifier_returned_non_json`
2. `researcher-suspicious-01` — `phase: Completed`, `suspicious: [hallucination-pattern, unexpected-tool-use]`, no verifier failure
3. `researcher-review-requested-01` — `phase: Completed`, explicit `review-requested: true` annotation + companion keys
4. `researcher-template-candidate-01` — `phase: Completed`, `template-candidate: true` annotation, artifact with `application/x-kagent-template-candidate+yaml` mediaType
5. `researcher-already-decided-01` — `review-decision: accepted` annotation set; MUST be skipped by W1 classifier
6. `researcher-priority-conflict-01` — both `verification.passed: false` AND `suspicious: [unexpected-tool-use]`; verifier-failed wins per D-01-A priority

**`packages/workbench-api/src/__fixtures__/candidate-template.yaml`** (new):

- Valid `AgentTemplateSpec`: `agentSpec` (with model, systemPrompt, tools, llmParams), `templateVersion: 1`, `revisionHistoryLimit: 3`, 2 parameters (topic:string, maxSources:integer), `budget.maxIterations: 10`, `toolAllowlist: [http]`
- Verified: `parseAgentTemplateSpec(yaml)` returns `{ ok: true, spec }` with all fields correctly parsed

### Task 4 — RBAC manifests

**`packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml`** (modified — ADDITIVE ONLY):

- `agenttasks` verbs: `['create']` → `['create', 'patch']` — `patch` needed for annotation writes (review-decision, review-requested, etc.)
- NEW rule: `agenttemplates: ['create']` — for candidate-template accept-path promotion
- Comment block updated to reflect Phase 4 landing

**`packages/operator/charts/kagent-workbench/templates/clusterrole.yaml`** (modified — ADDITIVE ONLY):

- `agenttemplates` added to kagent.knuteson.io resources list with `[get, list, watch]`
- `agenttemplates/status` added to status subresources with `[get]`
- Verified missing before this commit (RESEARCH.md Q9)

## Verification

- `pnpm -C packages/dto run test -- --run`: **6 test files, 122 tests passed**
- `pnpm -C packages/audit-events run test -- --run`: **2 test files, 61 tests passed**
- `pnpm -w typecheck`: **all 27 packages pass** (run by pre-commit hook on every commit)
- `helm template packages/operator/charts/kagent-workbench | grep -A 5 agenttemplates`: rendered output contains new RBAC verbs in both clusterrole.yaml and clusterrole-actions.yaml

## Deviations from Plan

None — plan executed exactly as written. All 13 deliverable items in the plan shipped in 4 commits per the mandated atomic-commit boundaries.

The one minor deviation was a lint error caught by the pre-commit hook in the first commit attempt: `@typescript-eslint/restrict-template-expressions` errors in `template-candidate.ts` where a template literal used `doc['templateVersion']` directly. Fixed inline before the commit landed. No behavior change.

## Known Stubs

The following are INTENTIONAL stubs per the plan's D-04 constraint:

- `ReviewReason` members `replay-divergence` and `eval-failed` are reserved enum slots with zero v0.2 producers. The inline `// REV-03: ...` comment documents the Phase 5+ promotion path. These slots exist so the DTO shape is forward-compatible without a SemVer-major bump when AgentTaskRun + `@kagent/eval` ship.

## Threat Flags

No new network endpoints, auth paths, or file access patterns introduced. This plan is data-only (types + fixtures + YAML manifests). The RBAC changes are additive — they extend the existing `clusterrole-actions.yaml` write surface (which is already behind `actions.create=false` toggle) and the existing `clusterrole.yaml` read surface.

## Self-Check: PASSED

All 13 files exist. All 4 commits verified. 183 total tests passing.
