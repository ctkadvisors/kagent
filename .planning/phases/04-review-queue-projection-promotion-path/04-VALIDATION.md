---
phase: 04
slug: review-queue-projection-promotion-path
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-10
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `04-RESEARCH.md` `## Validation Architecture`. The planner is expected to fill the
> Per-Task Verification Map and the Wave 0 Requirements as plan files are written.

---

## Test Infrastructure

| Property               | Value                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Framework**          | vitest (workbench-api, workbench-ui, dto, audit-events); operator chart manifests checked via `helm template` + `yq` |
| **Config file**        | `vitest.config.ts` per package (existing)                                                                            |
| **Quick run command**  | `pnpm -C packages/workbench-api test --run --reporter=verbose` (per-task scope)                                      |
| **Full suite command** | `pnpm -w test --run`                                                                                                 |
| **Estimated runtime**  | ~30s per package quick run; ~3min full suite                                                                         |

---

## Sampling Rate

- **After every task commit:** Run the package's quick test command (`pnpm -C packages/<pkg> test --run`)
- **After every plan wave:** Run `pnpm -w test --run` + `pnpm -w build` + `pnpm -w typecheck`
- **Before `/gsd-verify-work`:** Full suite + a manual fixture-driven UAT (see Manual-Only Verifications)
- **Max feedback latency:** 60 seconds (per-package quick run)

---

## Per-Task Verification Map

> The planner fills this table as PLAN.md files are produced. Each row maps a task to the test that proves
> the secure behavior holds. Wave 0 tasks add fixture/skeleton infrastructure; later waves add the verifying tests.

| Task ID  | Plan  | Wave | Requirement | Threat Ref | Secure Behavior                                                                                                                                                                | Test Type  | Automated Command                                                                                          | File Exists       | Status     |
| -------- | ----- | ---- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------- | ----------------- | ---------- |
| 04-01-01 | 04-01 | 0    | REV-01      | —          | DTO + fixture skeleton compiles (`ReviewQueueRow` + `ReviewReason` exported, type-check clean)                                                                                 | unit       | `pnpm -C packages/dto test --run`                                                                          | ✅ W0 (this task) | ⬜ pending |
| 04-01-01 | 04-01 | 0    | REV-03      | —          | `ReviewReason` enum exports `replay-divergence` and `eval-failed` slots; zero v0.2 producers; inline comment block referencing `docs/REPLAY-EVALS.md`                          | type-check | `pnpm -C packages/dto typecheck && grep -q replay-divergence packages/dto/src/review-queue.ts`             | ✅ W0 (this task) | ⬜ pending |
| 04-01-02 | 04-01 | 0    | REV-02      | —          | `audit-events` discriminated union extended with `review.requested` / `review.accepted` / `review.rejected` / `template.candidate.promoted`; `ALL_EVENT_TYPES.length` 49→53    | unit       | `pnpm -C packages/audit-events test --run`                                                                 | ✅ W0 (this task) | ⬜ pending |
| 04-01-03 | 04-01 | 0    | REV-02      | T-04-W2-06 | Helm chart RBAC: `clusterrole-actions.yaml` includes `agenttasks: [create,patch]` + `agenttemplates: [create]`; `clusterrole.yaml` includes `agenttemplates: [get,list,watch]` | manifest   | `helm template packages/operator/charts/kagent-workbench \| yq '..\|select(has("rules"))'`                 | ✅ W0 (this task) | ⬜ pending |
| 04-02-01 | 04-02 | 1    | REV-01      | —          | `GET /api/review-queue` returns rows sorted by descending staleness                                                                                                            | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W1             | ⬜ pending |
| 04-02-01 | 04-02 | 1    | REV-01      | —          | Classifier priority: verifier-failed > suspicious > human-review-requested > candidate-template                                                                                | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W1             | ⬜ pending |
| 04-02-01 | 04-02 | 1    | REV-03      | —          | `traceLink` populated when present on `verifier-failed` / `suspicious-detector` rows; navigates to Langfuse                                                                    | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W1             | ⬜ pending |
| 04-02-02 | 04-02 | 1    | REV-01      | —          | Reload-stability: two GETs return identical rows modulo `stalenessSeconds`                                                                                                     | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W1             | ⬜ pending |
| 04-02-02 | 04-02 | 1    | REV-01      | —          | Tasks with `review-decision` annotation are excluded from queue                                                                                                                | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W1             | ⬜ pending |
| 04-03-01 | 04-03 | 2    | REV-02      | T-04-W2-04 | Missing `customApi` (actions.create=false) → 503 fail-closed (mirror `tasks.ts:147` pattern)                                                                                   | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W2             | ⬜ pending |
| 04-03-02 | 04-03 | 2    | REV-02      | —          | `POST .../accept` on `verifier-failed` row writes accept annotation + emits `review.accepted` audit event                                                                      | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W2             | ⬜ pending |
| 04-03-02 | 04-03 | 2    | REV-02      | —          | `POST .../accept` on `candidate-template` row creates AgentTemplate CR via fake `customApi` + emits `template.candidate.promoted`                                              | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W2             | ⬜ pending |
| 04-03-02 | 04-03 | 2    | REV-02      | —          | `POST .../reject` writes reject annotation + emits `review.rejected`; never creates AgentTemplate                                                                              | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W2             | ⬜ pending |
| 04-03-02 | 04-03 | 2    | REV-02      | T-04-W2-07 | Second accept on already-decided task → 409                                                                                                                                    | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W2             | ⬜ pending |
| 04-03-02 | 04-03 | 2    | REV-02      | —          | CR create 409 → 422 with K8s body; no annotation written                                                                                                                       | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W2             | ⬜ pending |
| 04-03-02 | 04-03 | 2    | REV-02      | —          | `POST .../request` writes `review-requested: "true"` annotation + emits `review.requested`                                                                                     | unit       | `pnpm -C packages/workbench-api test --run review-queue`                                                   | ✅ W2             | ⬜ pending |
| 04-04-02 | 04-04 | 3    | REV-02      | —          | `ReviewPage` renders rows with Accept / Reject / Open Detail per row; per-row `assertSourceField` calls fire in dev                                                            | unit       | `pnpm -C packages/workbench-ui test --run ReviewPage`                                                      | ✅ W3             | ⬜ pending |
| 04-04-02 | 04-04 | 3    | REV-01      | —          | Confirm-dialog mirrors `NewTaskModal` pattern (focus-trap, escape-to-close)                                                                                                    | unit       | `pnpm -C packages/workbench-ui test --run ReviewPage`                                                      | ✅ W3             | ⬜ pending |
| 04-04-03 | 04-04 | 3    | REV-02      | —          | `ReviewActions` mounts inline in `TaskDetail` for Failed / suspicious / review-requested / candidate-template tasks                                                            | unit       | `pnpm -C packages/workbench-ui test --run TaskDetail`                                                      | ✅ W3             | ⬜ pending |
| 04-05-02 | 04-05 | 4    | REV-01      | —          | Phase 3 attention `FlowGauge` reads `reviewQueueRowCount` from `CommandSnapshot` (proxy flip; `?? 0` keeps existing tests green)                                               | unit       | `pnpm -C packages/workbench-ui test --run flows`                                                           | ✅ W4             | ⬜ pending |
| 04-05-04 | 04-05 | 4    | REV-01      | —          | `cc-reload.test.tsx.snap` regenerated in dedicated commit (data-source-field flips `phase,suspicious` → `reviewQueueRowCount`)                                                 | unit       | `pnpm -C packages/workbench-ui test --run cc-reload`                                                       | ✅ W4             | ⬜ pending |
| 04-05-05 | 04-05 | 4    | REV-03      | —          | `docs/REPLAY-EVALS.md` references the `replay-divergence` / `eval-failed` ReviewReason slots; `docs/AGENT-TEMPLATES.md` footer documents promotion path                        | doc-grep   | `grep -q "replay-divergence" docs/REPLAY-EVALS.md && grep -q "promoted-from-task" docs/AGENT-TEMPLATES.md` | ✅ W4             | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

> Plan/Task IDs are filled (post-planning sync 2026-05-10). Each row references a concrete
> `<task>` in the named PLAN.md; threat refs reference the matching `<threat_model>` entry.

---

## Wave 0 Requirements

> The fixture-driven test approach in CONTEXT.md REV-02 ("the v0.2 acceptance for REV-02" is the
> fixture test) means Wave 0 must seed the fixture file + skeleton test files before later waves.

- [ ] `packages/dto/src/review-queue.ts` — `ReviewQueueRow` + `ReviewReason` exports
- [ ] `packages/dto/src/template-candidate.ts` — `parseAgentTemplateSpec()` shape validator
- [ ] `packages/audit-events/src/event-types.ts` + `types.ts` — 4 new event types in the discriminated union
- [ ] `packages/workbench-api/src/__fixtures__/review-queue-snapshot.json` — one of each `ReviewReason` (verifier-failed, suspicious-detector, human-review-requested, candidate-template) + the `replay-divergence` / `eval-failed` slots commented as "no v0.2 producers"
- [ ] `packages/workbench-api/src/routes/review-queue.test.ts` — skeleton with reload-stability scaffold (mirror `dispositions.test.ts`)
- [ ] `packages/workbench-ui/src/source-binding.ts` — `ReviewQueueFieldName` closed enum extension
- [ ] Existing vitest infrastructure covers framework needs — no new framework install required

---

## Manual-Only Verifications

| Behavior                                                                                                | Requirement | Why Manual                                                                                                | Test Instructions                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator clicks Accept on a `candidate-template` row in `#/review`; AgentTemplate CR appears in cluster | REV-02      | End-to-end with real K8s apiserver — fake client can't validate apiserver-side schema enforcement         | 1) Deploy chart with `actions.create=true`. 2) Create an `AgentTask` with annotations `template-candidate=true` and a `application/x-kagent-template-candidate+yaml` artifact. 3) Open `#/review`, click Accept. 4) `kubectl get agenttemplate -n <ns>` shows new CR with `ownerReferences` and `promoted-from-task` annotation. |
| Operator clicks Reject on same row; no AgentTemplate created                                            | REV-02      | Confirms reject path is purely annotation-write                                                           | 1) Same setup. 2) Click Reject. 3) `kubectl get agenttemplate -n <ns>` returns no rows. 4) `kubectl get agenttask -n <ns> -o yaml` shows `review-decision=rejected`.                                                                                                                                                             |
| `#/review` deep-link works from AgentPanel/TaskPanel                                                    | REV-01      | UX flow confirmation                                                                                      | 1) Open Command Center. 2) Click "Open review" link from AgentPanel. 3) URL becomes `#/review`; queue page renders.                                                                                                                                                                                                              |
| Phase 3 `attention` flow gauge reflects review-queue row count after flip                               | REV-01      | Cross-phase regression check; tests cover the mechanic but operator-visible UX is best confirmed manually | 1) Trigger a verifier failure. 2) Wait ≤5s. 3) Command Center attention gauge increments by 1 — same value as `#/review` row count.                                                                                                                                                                                              |
| Cross-namespace candidate accept rejected as 403                                                        | REV-02      | Apiserver RBAC enforcement; fake-client tests assert handler intent but real RBAC is K8s policy           | 1) Deploy chart with `defaultNamespace=foo`. 2) Create candidate AgentTask in namespace `bar`. 3) `POST /api/review-queue/bar/<name>/accept` → 403.                                                                                                                                                                              |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (verified by gsd-plan-checker)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (Plan 04-01 carries DTO + audit-events + RBAC + fixtures)
- [x] No watch-mode flags
- [x] Feedback latency < 60s (per-package `pnpm -C packages/<pkg> test --run` ≤ 30s)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-10 (gsd-plan-checker — VERIFICATION PASSED)
