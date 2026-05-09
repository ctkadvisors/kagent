---
phase: 1
slug: agentdisposition-v0
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-09
revised: 2026-05-09
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: 01-RESEARCH.md "Validation Architecture" + 01-CONTEXT.md "Test posture".

---

## Test Infrastructure

| Property                  | Value                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Framework**             | vitest (per CLAUDE.md; co-located `*.test.ts`)                                                                                     |
| **Config file**           | per-package `vitest.config.ts` / `vite.config.ts` (existing v0.1 pattern); `packages/workbench-ui/` requires Wave 0 confirm-or-add |
| **Quick run command**     | `pnpm --filter <package> test --run` (single package, single shot)                                                                 |
| **Full suite command**    | `pnpm -r test --run` (all packages, root-level vitest)                                                                             |
| **Estimated runtime**     | ~30s for any single package quick run; ~3–5 min full suite                                                                         |
| **K8s-side verification** | Schema-validation Job manifest under `packages/operator/charts/` deployed via ArgoCD; no imperative kubectl                        |

---

## Sampling Rate

- **After every task commit:** Run quick command for the package(s) touched in the task. (`pnpm --filter <package> test --run`)
- **After every plan wave:** Run full suite for affected packages OR root-level when crossing package boundaries.
- **Before `/gsd-verify-work`:** Full suite green AND schema-validation Job ran green against the seed overlay manifest in homelab cluster (or ArgoCD-equivalent target).
- **Max feedback latency:** ≤30s for per-task quick run; ≤5 min for full suite.

---

## Per-Task Verification Map

> Populated by gsd-planner during planning. Each row mirrors the `<verify><automated>` element of the corresponding `<task>` in the cited PLAN.md. "File Exists" = ✅ if the file is created in this phase's Wave 0 (plan 01-01) and is reachable by the time the task runs; ❌ W0 if creation depends on Wave 0 completing first; ⚠️ W1+ if the file is created later in the wave the task belongs to (the previous task in the same plan creates it).

| Task ID  | Plan | Wave | Requirement | Secure Behavior                                                                                                                                                 | Test Type                       | Automated Command                                                                                                                                                                                                       | File Exists   | Status                         |
| -------- | ---- | ---- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------ |
| 01-01-T1 | 01   | 1    | DISP-01     | Two new audit-event types (`disposition.proposal_rejected`, `disposition.over_budget`) cleanly join existing union; ALL_EVENT_TYPES.length 47→49                | unit                            | `pnpm --filter @kagent/audit-events test --run`                                                                                                                                                                         | ✅ W0         | ⬜ pending                     |
| 01-01-T2 | 01   | 1    | DISP-01     | parseDispositionConfigMap fails closed on YAML parse + missing required fields; PROPOSAL_TOOL_MAP exists; parser lives in @kagent/dto (single source of truth)  | unit                            | `pnpm --filter @kagent/dto test --run -- disposition-parser` AND `pnpm --filter @kagent/operator test --run -- disposition`                                                                                             | ✅ W0         | ⬜ pending                     |
| 01-01-T3 | 01   | 1    | DISP-01     | Operator ClusterRole grants configmaps:patch (DISP-03 prerequisite); Helm-renderable                                                                            | rendering                       | `helm template packages/operator/charts/kagent-operator --show-only templates/clusterrole.yaml \| grep -A2 configmaps \| grep patch`                                                                                    | ✅ W0         | ⬜ pending                     |
| 01-01-T4 | 01   | 1    | DISP-01     | Reusable test fixtures present and consistent (overlay-valid, overlay-missing-tokens, gateway-usage-rows.json sums to 45000 for researcher-01)                  | file-presence + node check      | `test -f tests/fixtures/disposition/overlay-valid.yaml && node -e "..." (sum check)`                                                                                                                                    | ✅ W0         | ⬜ pending                     |
| 01-01-T5 | 01   | 1    | DISP-01     | @kagent/workbench-ui has working vitest+jsdom infra; `pnpm test --run` exits 0 even with zero tests (Wave 0 setup-only — `--passWithNoTests` permissible HERE)  | infra-smoke                     | `pnpm --filter @kagent/workbench-ui test --run --passWithNoTests`                                                                                                                                                       | ✅ W0         | ⬜ pending                     |
| 01-01-T6 | 01   | 1    | DISP-01     | Helm template renders the schema-validate Job only when enabled; 2 seed ConfigMaps + ArgoCD hook annotations + non-root pod security context all present        | rendering + lint                | `helm template packages/operator/charts/kagent-operator --set dispositionSchemaTest.enabled=true \| grep "kind: Job"` AND `helm lint packages/operator/charts/kagent-operator --set dispositionSchemaTest.enabled=true` | ✅ W0         | ⬜ pending                     |
| 01-01-T7 | 01   | 1    | DISP-01     | Schema-validation Job runs green in homelab cluster (.status.succeeded == 1; logs contain valid:OK + invalid:correctly-rejected)                                | manual + GitOps                 | `kubectl get -n kagent-system job/disposition-schema-validate -o jsonpath='{.status.succeeded}'` returns `1`                                                                                                            | n/a (cluster) | ⬜ pending (manual checkpoint) |
| 01-02-T1 | 02   | 2    | DISP-02     | narrowByDispositionOverlay narrows-never-widens; pure function; 11 unit tests pass                                                                              | unit (pure)                     | `pnpm --filter @kagent/operator test --run -- narrow-by-overlay`                                                                                                                                                        | ✅ W0         | ⬜ pending                     |
| 01-02-T2 | 02   | 2    | DISP-02     | proposals-counter pure helper + K8s-patch wrapper; rollover semantics; 7 tests pass                                                                             | unit (pure + mocked K8s)        | `pnpm --filter @kagent/operator test --run -- proposals-counter`                                                                                                                                                        | ✅ W0         | ⬜ pending                     |
| 01-02-T3 | 02   | 2    | DISP-02     | mintCapabilityForTask wires overlay-narrowing + audit emission + proposals-today annotation patch; 11 new disposition tests pass; existing tests still pass     | unit (cap-issuer integration)   | `pnpm --filter @kagent/operator test --run -- cap-issuer`                                                                                                                                                               | ✅ W0         | ⬜ pending                     |
| 01-03-T1 | 03   | 3    | DISP-03     | DispositionOverlayRow shared DTO in @kagent/dto incl. overBudgetEventCountToday; postsToday: 0 literal type; runtime guard exists                               | unit (type + runtime guard)     | `pnpm --filter @kagent/dto test --run -- disposition`                                                                                                                                                                   | ✅ W0         | ⬜ pending                     |
| 01-03-T2 | 03   | 3    | DISP-03     | /api/dispositions route computes the projection from gateway DTOs + ConfigMap annotations; over_budget exactly-once-per-(agentRef,reason)-per-UTC-day; 18 tests | unit (mocked coreApi + gateway) | `pnpm --filter @kagent/workbench-api test --run -- dispositions`                                                                                                                                                        | ✅ W0         | ⬜ pending                     |
| 01-03-T3 | 03   | 3    | DISP-03     | Route mounted in router.ts; AuditPublisher wired conditionally; Helm value+env var plumbed end-to-end in `packages/operator/charts/kagent-workbench/`           | full package + helm lint        | `pnpm --filter @kagent/workbench-api test --run && helm lint packages/operator/charts/kagent-workbench`                                                                                                                 | ✅ W0         | ⬜ pending                     |
| 01-04-T1 | 04   | 4    | DISP-04     | fetchDispositions + state hook wiring; api.test.ts + state.test.ts (7 tests covering fetch, validate, Map keying, SSE refetch, mount-time refetch, periodic)    | unit                            | `pnpm --filter @kagent/workbench-ui test --run -- api.test state.test`                                                                                                                                                  | ✅ W0         | ⬜ pending                     |
| 01-04-T2 | 04   | 4    | DISP-04     | source-binding helpers (single + multi-field) enforce D7 Prime Directive in dev; no-op in prod; 10 tests                                                        | unit                            | `pnpm --filter @kagent/workbench-ui test --run -- source-binding`                                                                                                                                                       | ✅ W0         | ⬜ pending                     |
| 01-04-T3 | 04   | 4    | DISP-04     | DispositionOverlay component + reload-stability snapshot-shape test + base-building-only mode + multi-field assertions fire + count rendering; 12 tests         | unit + snapshot                 | `pnpm --filter @kagent/workbench-ui test --run -- DispositionOverlay`                                                                                                                                                   | ✅ W0         | ⬜ pending                     |
| 01-04-T4 | 04   | 4    | DISP-04     | DispositionOverlay mounted in CommandView; production build green                                                                                               | typecheck + build               | `pnpm --filter @kagent/workbench-ui typecheck && pnpm --filter @kagent/workbench-ui build`                                                                                                                              | ✅ W0         | ⬜ pending                     |
| 01-04-T5 | 04   | 4    | DISP-04     | Manual: end-to-end overlay rendering against a running workbench; reload-stability + data-source-field(s) attributes + VITE_PRESSURE_DRAMATIZATION toggle       | manual                          | n/a (visual checkpoint per task <how-to-verify> steps)                                                                                                                                                                  | n/a (browser) | ⬜ pending (manual checkpoint) |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

**Coverage check:** Every task above has an `<automated>` command (or is an explicit manual checkpoint with documented manual steps). No 3-consecutive-task gap in automated coverage. Nyquist requirement satisfied.

---

## Wave 0 Requirements

Setup-before-implementation prerequisites — ALL DELIVERED IN PLAN 01-01:

- [x] **Confirm vitest infrastructure in `packages/workbench-ui/`** — research flagged uncertainty (`vite.config.ts` present, `vitest.config.ts` not found; may be inline). DELIVERED in 01-01-T5: vitest + jsdom + @testing-library installed; vitest.config.ts created; `pnpm --filter @kagent/workbench-ui test --run --passWithNoTests` exits 0.
- [x] **Define `PROPOSAL_TOOL_MAP`** — per research open question 1, no "proposal" concept exists in v0.1 code. DELIVERED in 01-01-T2: PROPOSAL_TOOL_MAP exists in `packages/operator/src/disposition/proposal-tool-map.ts` (ProposalKind / PROPOSAL_KINDS re-exported from @kagent/dto for single source of truth) with v0.1 minimal mapping (templates→write_artifact; verifiers→verifier_register; capability-policy→capability_policy_propose).
- [x] **Confirm operator ClusterRole RBAC for ConfigMap patch** — per research open question 3, the operator must be able to PATCH the disposition ConfigMap to write `proposals-today` annotation. DELIVERED in 01-01-T3: `configmaps: patch` verb added to existing rule.
- [x] **Add new audit event types** — per research finding 3, `disposition.proposal_rejected` and `disposition.over_budget` must be added to `packages/audit-events/src/event-types.ts`, `types.ts`, and the discriminated union; existing `ALL_EVENT_TYPES.length` sanity tests need updating from 47 to 49. DELIVERED in 01-01-T1.
- [x] **Test fixture: seed overlay ConfigMap** — `tests/fixtures/disposition/overlay-valid.yaml` (and `overlay-missing-tokens.yaml`), used by schema-validation Job + capability-JWT scope unit tests + projection integration tests. DELIVERED in 01-01-T4.
- [x] **Test fixture: gateway DTO sample** — captured `GatewayUsageRow[]` for `spentTokensToday` projection unit test. DELIVERED in 01-01-T4 as `tests/fixtures/disposition/gateway-usage-rows.json` (sum-for-researcher-01 = 45000 tokens).
- [x] **Disposition parser single source of truth** — added by plan-checker WARNING #4 resolution. DELIVERED in 01-01-T2: parser + types + label/annotation constants live in `packages/dto/src/disposition-parser.ts` and are re-exported via `@kagent/dto`; both `@kagent/operator` (cap-issuer) and `@kagent/workbench-api` (dispositions projection) import from `@kagent/dto`.

`wave_0_complete: true` is set in this file's frontmatter once 01-01-PLAN.md ships green (Tasks 1–5 cover all six bullet items above; Tasks 6–7 deliver DISP-01 itself).

---

## Manual-Only Verifications

| Behavior                                                                            | Requirement | Why Manual                                                                                                                       | Test Instructions                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema-validation Job runs green against seed overlay in homelab cluster            | DISP-01     | GitOps deploys to homelab; verification ships as Job; Job results read via `kubectl get jobs -n kagent-system` (no kubectl exec) | 1. Commit overlay set in `../new_localai/<overlay>/` enabling `dispositionSchemaTest.enabled=true`. 2. ArgoCD syncs. 3. Schema-validation Job runs. 4. `kubectl get jobs -n kagent-system -l phase=01-disposition` should show `Completed`. 5. Job logs (via centralized logging or Job artifact) show schema-validation pass. (See 01-01-T7.)                            |
| Command Center renders disposition overlay end-to-end against running workbench-api | DISP-04     | Requires running cluster with seed overlay; reload-stability is partly UX                                                        | 1. Open Workbench UI in browser. 2. Navigate to Command Center. 3. Verify disposition overlay renders for seeded Agent. 4. Hard reload page (Cmd+Shift+R). 5. Overlay reconstructs from API state with no client-side gaps. 6. Mock over-budget condition (e.g., set tiny token cap, run a chatty Agent) → pressure visual appears within one poll cycle. (See 01-04-T5.) |

---

## Validation Sign-Off

- [x] All tasks have automated verify command OR documented Wave 0 dependency (per-task map above)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all six items above
- [x] No watch-mode flags (`--watch` forbidden in CI; `--run` mandatory) — confirmed across all task `<automated>` commands
- [x] Feedback latency target: ≤30s per-task / ≤5 min full
- [x] Schema-validation Job manifest GitOps-deployable (no imperative kubectl)
- [x] `nyquist_compliant: true` set in frontmatter (per-task map populated)
- [x] `wave_0_complete: true` set in frontmatter (Wave 0 plan 01-01 covers all six setup tasks)

**Approval:** approved 2026-05-09 PM (post plan-checker BLOCKER #1 + #2 + #3 + WARNING #4 + #5 + #6 + #7 resolutions)

---

## Nyquist Dimension Coverage

| Dimension                                                         | How Phase 1 covers it                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Schema (overlay shape)                                         | Schema-validation Job manifest (01-01-T6/T7) + parser unit tests (01-01-T2)                                                                                                                                                      |
| 2. Authority (capability-JWT scope narrowing)                     | Unit tests on `cap-issuer.ts` narrowing logic (01-02-T1, 01-02-T3); typed audit event on rejection (01-02-T3)                                                                                                                    |
| 3. Resource accounting (token / proposal counters)                | Unit tests on projection daily-boundary logic (01-03-T2); integration test for over-budget audit emission (01-03-T2 Tests 6–10); proposals-counter rollover semantics (01-02-T2)                                                 |
| 4. Observability (workbench-api projection + audit events)        | Integration tests on `/dispositions` endpoint shape (01-03-T2); existing audit-event sanity tests extended (01-01-T1); cap-issuer audit emission tests (01-02-T3)                                                                |
| 5. UI (Command Center overlay)                                    | Snapshot tests for reload stability (01-04-T3 Test 7); dev-only assertion test for source-field backing (01-04-T2; CC-01 pattern, Phase 1 slice for the disposition fields)                                                      |
| 6. Revocation (overlay deletion → fall-through to base JWT scope) | Integration test: loadDispositionOverlay returning null → mint proceeds without narrowing AND without proposals-today increment (01-02-T3 Tests 1, 11); deleting the ConfigMap removes the row from /api/dispositions (01-03-T2) |
| 7. GitOps deployability                                           | Sample seed overlay manifest at `tests/fixtures/disposition/overlay-valid.yaml` consumed by the Helm-templated schema-validate Job (01-01-T4 + 01-01-T6); cluster-side checkpoint (01-01-T7)                                     |
| 8. Failure injection (over-budget exactly-once-per-day)           | Unit test mocking telemetry above threshold across multiple polls within a day; assert exactly one audit event emitted (01-03-T2 Tests 9, 10)                                                                                    |

---

_Validation strategy generated 2026-05-09 PM from RESEARCH.md "Validation Architecture" section. Per-task map populated 2026-05-09 PM (revision 1) by gsd-planner per plan-checker BLOCKER #1 resolution._
