---
phase: 1
slug: agentdisposition-v0
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-09
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

> Populated by gsd-planner during planning. Initial sketch from research:

| Task ID          | Plan | Wave | Requirement | Secure Behavior                                                                                                        | Test Type            | Automated Command                                                                 | File Exists | Status     |
| ---------------- | ---- | ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- | ----------- | ---------- |
| (TBD by planner) | 01   | 1    | DISP-01     | overlay carrier accepted only with all required fields                                                                 | unit + Job           | `pnpm --filter operator test --run -- disposition` + ArgoCD schema-validation Job | ❌ W0       | ⬜ pending |
| (TBD by planner) | 01   | 1    | DISP-02     | overlay narrows JWT scope; never widens; rejection emits typed audit event                                             | unit + integration   | `pnpm --filter operator test --run -- cap-issuer`                                 | ❌ W0       | ⬜ pending |
| (TBD by planner) | 02   | 2    | DISP-03     | spentTokensToday/proposalsToday computed from existing telemetry; over-budget audit event emitted exactly-once-per-day | unit + integration   | `pnpm --filter workbench-api test --run -- dispositions`                          | ❌ W0       | ⬜ pending |
| (TBD by planner) | 03   | 3    | DISP-04     | Command Center overlay reload-stable; every field has substrate source                                                 | snapshot + assertion | `pnpm --filter workbench-ui test --run -- DispositionOverlay`                     | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

Setup-before-implementation prerequisites:

- [ ] **Confirm vitest infrastructure in `packages/workbench-ui/`** — research flagged uncertainty (`vite.config.ts` present, `vitest.config.ts` not found; may be inline). If missing, install vitest + jsdom for the UI package (existing v0.1 packages already use vitest; replicate config).
- [ ] **Define `PROPOSAL_TOOL_MAP`** — per research open question 1, no "proposal" concept exists in v0.1 code. Create the constant (likely in `packages/operator/src/disposition/proposal-tool-map.ts` or similar) mapping tool-claim patterns to `mayProposeAgainst` kinds (`templates`, `verifiers`, `capability-policy`). This is design work that gates DISP-02; it must be locked before tests for DISP-02 can be authored.
- [ ] **Confirm operator ClusterRole RBAC for ConfigMap patch** — per research open question 3, the operator must be able to PATCH the disposition ConfigMap to write `proposals-today` annotation. If `clusterrole.yaml` lacks `configmaps: patch`, add it as a Wave 0 manifest update.
- [ ] **Add new audit event types** — per research finding 3, `disposition.proposal_rejected` and `disposition.over_budget` must be added to `packages/audit-events/src/event-types.ts`, `types.ts`, and the discriminated union; existing `ALL_EVENT_TYPES.length` sanity tests need updating from 47 to 49.
- [ ] **Test fixture: seed overlay ConfigMap** — `tests/fixtures/disposition-overlay.yaml` (or equivalent) with all required fields, used by schema-validation Job + capability-JWT scope unit tests + projection integration tests.
- [ ] **Test fixture: gateway DTO sample** — captured `GatewayUsageRow[]` for `spentTokensToday` projection unit test.

---

## Manual-Only Verifications

| Behavior                                                                            | Requirement | Why Manual                                                                                                                       | Test Instructions                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema-validation Job runs green against seed overlay in homelab cluster            | DISP-01     | GitOps deploys to homelab; verification ships as Job; Job results read via `kubectl get jobs -n kagent-system` (no kubectl exec) | 1. Commit seed overlay manifest under `../new_localai/<overlay>/`. 2. ArgoCD syncs. 3. Schema-validation Job runs. 4. `kubectl get jobs -n kagent-system -l phase=01-disposition` should show `Completed`. 5. Job logs (via centralized logging or Job artifact) show schema-validation pass.                                                             |
| Command Center renders disposition overlay end-to-end against running workbench-api | DISP-04     | Requires running cluster with seed overlay; reload-stability is partly UX                                                        | 1. Open Workbench UI in browser. 2. Navigate to Command Center. 3. Verify disposition overlay renders for seeded Agent. 4. Hard reload page (Cmd+Shift+R). 5. Overlay reconstructs from API state with no client-side gaps. 6. Mock over-budget condition (e.g., set tiny token cap, run a chatty Agent) → pressure visual appears within one poll cycle. |

---

## Validation Sign-Off

- [ ] All tasks have automated verify command OR documented Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all six items above
- [ ] No watch-mode flags (`--watch` forbidden in CI; `--run` mandatory)
- [ ] Feedback latency target: ≤30s per-task / ≤5 min full
- [ ] Schema-validation Job manifest GitOps-deployable (no imperative kubectl)
- [ ] `nyquist_compliant: true` set in frontmatter once planner populates per-task map

**Approval:** pending (awaiting gsd-planner population of per-task map)

---

## Nyquist Dimension Coverage

| Dimension                                                         | How Phase 1 covers it                                                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1. Schema (overlay shape)                                         | Schema-validation Job manifest                                                                                         |
| 2. Authority (capability-JWT scope narrowing)                     | Unit tests on `cap-issuer.ts` narrowing logic; typed audit event on rejection                                          |
| 3. Resource accounting (token / proposal counters)                | Unit tests on projection daily-boundary logic; integration test for over-budget audit emission                         |
| 4. Observability (workbench-api projection + audit events)        | Integration tests on `/dispositions` endpoint shape; existing audit-event sanity tests extended                        |
| 5. UI (Command Center overlay)                                    | Snapshot tests for reload stability; dev-only assertion test for source-field backing (CC-01 pattern, Phase 1 slice)   |
| 6. Revocation (overlay deletion → fall-through to base JWT scope) | Integration test: delete overlay carrier, re-issue same proposal → existing JWT scope is now the only gate             |
| 7. GitOps deployability                                           | Sample seed overlay manifest in `evidence/v0.2-phase-01/` committed as part of phase verification                      |
| 8. Failure injection (over-budget exactly-once-per-day)           | Unit test mocking telemetry above threshold across multiple polls within a day; assert exactly one audit event emitted |

---

_Validation strategy generated 2026-05-09 PM from RESEARCH.md "Validation Architecture" section. Per-task map populated by gsd-planner._
