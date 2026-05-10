---
phase: 01-agentdisposition-v0
verified: 2026-05-09T20:00:00Z
status: passed
score: 4/4 success criteria verified
overrides_applied: 0
---

# Phase 1: AgentDisposition prototype (overlay-first) — Verification Report

**Phase Goal (from ROADMAP.md):** Idle agent behavior becomes representable on the
existing substrate WITHOUT introducing a new CRD or reconciler. An overlay (annotation,
ConfigMap, or artifact record) on an existing `Agent` declares idle behavior, attention
budget, and proposal scope. Workbench-api exposes a read projection. Command Center
shows the overlay. Observability uses existing telemetry. The phase deliberately produces
evidence to decide whether to promote to a field on `Agent` or to a sibling CRD in a
future milestone.

**Verified:** 2026-05-09T20:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| #   | Truth                                                                                                                                                                                        | Status     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Operator can attach idle-behavior overlay to existing `Agent` via shipped v0.1 primitives; overlay carries required fields; schema-validate Job rejects gaps.                                | ✓ VERIFIED | `disposition-parser.ts` enforces all five required fields (`readChannels`, `tokensPerDay`, `pollIntervalSeconds`, `mayProposeAgainst`, `maxProposalsPerDay`); Helm-templated Sync-hook Job `disposition-schema-validate.yaml` reproduces the same checks; cluster Job runs `Complete 1/1` with `valid: OK / invalid: correctly rejected`; **NO new CRD / NO admission webhook** confirmed by grep.                                                                                                                                                                                                                     |
| 2   | `proposalScope.mayProposeAgainst` narrows capability-JWT scope at issuance time, never widens; unit test proves rejection emits typed audit event tied back to overlay.                      | ✓ VERIFIED | `narrow-by-overlay.ts` is pure narrowing-only; `narrow-by-overlay.test.ts` Test 2 explicitly asserts "narrowing never widens (empty cap stays empty even when overlay allows everything)" + monotonicity test; `cap-issuer.test.ts:554` asserts `event.type === 'disposition.proposal_rejected'`; cap-issuer wires `narrowByDispositionOverlay` between `resolveAgentClaims` and `narrowClaimsByParent` (line 269).                                                                                                                                                                                                    |
| 3   | Workbench-api exposes `/api/dispositions` projection from existing telemetry; counters reset at daily boundary; over-budget emits substrate audit events; NO new persistence.                | ✓ VERIFIED | `dispositions.ts` route mounted via `router.ts:208`; computes `spentTokensToday` from gateway DTOs + `proposalsToday` from operator-written `kagent.knuteson.io/proposals-today` annotation; emits `disposition.over_budget` audit event at line 285 (exactly-once-per-(agentRef, reason)-per-UTC-day dedup); UTC-midnight rollover verified by Test 18; `dailyBoundaryUtc=2026-05-09T00:00:00Z` returned by live cluster; **no `CREATE TABLE` / `prisma` / etcd primitives** confirmed by grep.                                                                                                                       |
| 4   | Command Center renders disposition overlay alongside flow-economy flows; every rendered field has backing source field; budget remaining + over-budget event count per agent; reload-stable. | ✓ VERIFIED | `DispositionOverlay.tsx` mounted in `CommandView.tsx:1382`; every visible field carries `data-source-field` or comma-joined `data-source-fields` (5 multi-field bindings, 16 source-binding helper invocations); `tokensRemaining` and `proposalsRemaining` computations rendered with both inputs source-bound; conditional `overBudgetEventCountToday` block (line 151) per S.C.4; `DispositionOverlay.test.tsx Test 7` "reload stability: re-render with same snapshot produces equal selector tree"; cluster verification on 2026-05-09 — user visually confirmed three demo overlays rendering in Command Center. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact                                                                                                    | Expected                                   | Status     | Details                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dto/src/disposition-parser.ts`                                                                    | Single-source-of-truth parser              | ✓ VERIFIED | Exists; 5 required-field guards; imported by both operator (`overlay-loader.ts`) and workbench-api (`dispositions.ts`).                                          |
| `packages/dto/src/disposition.ts`                                                                           | DispositionOverlayRow DTO + runtime guard  | ✓ VERIFIED | Exists; exports `DispositionOverlayRow`, `assertIsDispositionOverlayRow`, `DispositionProposalKind`, `DispositionOverBudgetReason`.                              |
| `packages/operator/src/disposition/narrow-by-overlay.ts`                                                    | Pure narrowing function for capability JWT | ✓ VERIFIED | Exists; pure function (no I/O); imported + invoked at `cap-issuer.ts:54, 269`.                                                                                   |
| `packages/operator/src/disposition/proposals-counter.ts`                                                    | Optimistic-CAS annotation writer           | ✓ VERIFIED | Exists; imported at `cap-issuer.ts:58, 380`; writes `kagent.knuteson.io/proposals-today` on the disposition ConfigMap.                                           |
| `packages/operator/src/disposition/proposal-tool-map.ts`                                                    | DISP-02 narrowing source of truth          | ✓ VERIFIED | Exists; carries OBSERVATION-PHASE-ONLY warning per plan.                                                                                                         |
| `packages/operator/src/disposition/overlay-loader.ts`                                                       | K8s list path for overlays                 | ✓ VERIFIED | Exists; production-wired in `reconcile.ts`.                                                                                                                      |
| `packages/operator/charts/kagent-operator/templates/disposition-schema-validate.yaml`                       | Helm-templated ArgoCD Sync-hook Job        | ✓ VERIFIED | Exists; gated by `.Values.dispositionSchemaTest.enabled`; cluster Job `disposition-schema-validate` runs `SuccessCriteriaMet` on homelab (per cluster evidence). |
| `packages/workbench-api/src/routes/dispositions.ts`                                                         | `/api/dispositions` projection route       | ✓ VERIFIED | Exists; mounted on production router at `router.ts:208`; live `GET /api/dispositions` returns 3 demo rows on cluster.                                            |
| `packages/workbench-ui/src/command/DispositionOverlay.tsx`                                                  | React overlay component                    | ✓ VERIFIED | Exists; mounted in `CommandView.tsx:1382`; renders 16 source-binding attributes including 5 multi-field.                                                         |
| `packages/workbench-ui/src/command/source-binding.ts`                                                       | CC-01 source-binding helpers               | ✓ VERIFIED | Exists; exports `assertSourceField`, `useSourceField`, `assertSourceFields`, `useSourceFields`; dev-only assertion fires; production no-op.                      |
| `packages/audit-events/src/event-types.ts`                                                                  | New typed event constants                  | ✓ VERIFIED | `DISPOSITION_PROPOSAL_REJECTED` + `DISPOSITION_OVER_BUDGET` exported; `ALL_EVENT_TYPES.length === 49`; sanity test green (54/54).                                |
| `tests/fixtures/disposition/overlay-valid.yaml` + `overlay-missing-tokens.yaml` + `gateway-usage-rows.json` | Schema-validate seed + DISP-03 fixtures    | ✓ VERIFIED | All three present.                                                                                                                                               |

### Key Link Verification

| From                                   | To                                        | Via                                                                                                         | Status  | Details                                                                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------- |
| Disposition ConfigMap                  | Operator narrowing path                   | `loadDispositionOverlayForAgent` → `narrowByDispositionOverlay`                                             | ✓ WIRED | `reconcile.ts` threads loader; cap-issuer applies narrowing between resolveAgentClaims and narrowClaimsByParent.                                                                                             |
| `narrowByDispositionOverlay` rejection | Substrate audit stream                    | `makeEvent('disposition.proposal_rejected')` → `auditPublisher.publish` → NATS via `dispositionAuditHolder` | ✓ WIRED | `cap-issuer.ts:283` emits typed event; `main.ts` mutable holder pattern wires AuditPublisher post-connect; `cap-issuer.test.ts` covers 12 tests including taskUid propagation, fail-soft on publish failure. |
| Disposition ConfigMap counter          | `/api/dispositions` projection            | `kagent.knuteson.io/proposals-today` annotation read at request time                                        | ✓ WIRED | Operator is sole writer (configmaps:patch, plan 01); workbench-api is reader (configmaps:[get,list,watch], plan 03).                                                                                         |
| Workbench-api projection               | Substrate audit stream                    | `disposition.over_budget` exactly-once-per-(agentRef, reason)-per-UTC-day                                   | ✓ WIRED | `dispositions.ts:285`; in-process Set dedup with `${agentRef}                                                                                                                                                | ${reason} | ${dailyBoundaryUtc}` key; UTC-midnight rollover verified Test 18. |
| `GET /api/dispositions`                | Workbench-ui state                        | `fetchDispositions` → `assertIsDispositionOverlayRow` → `useCommandSnapshot.dispositions` Map               | ✓ WIRED | `state.ts` runs mount-once + agent-SSE + 30s poll refetch; `api.ts:118` enforces shape; `CommandView.tsx:1382` consumes.                                                                                     |
| `DispositionOverlayRow` field          | DOM attribute                             | `useSourceField` / `useSourceFields` → `data-source-field(s)`                                               | ✓ WIRED | 16 attribute writes, 5 multi-field — verified by greps documented in plan 04 SUMMARY (>=10 / >=4 thresholds met).                                                                                            |
| Workbench-api over-budget              | Substrate over-budget event count surface | `overBudgetEventCountToday` field on `DispositionOverlayRow`                                                | ✓ WIRED | Derived from dedup-Set scan; rendered conditionally in UI when `overBudget=true`; ROADMAP S.C.4 satisfied.                                                                                                   |

### Data-Flow Trace (Level 4)

| Artifact                             | Data Variable                                                       | Source                                                                                                                                                    | Produces Real Data | Status                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dispositions.ts` route handler      | `items: DispositionOverlayRow[]`                                    | `coreApi.listConfigMapForAllNamespaces({ labelSelector })` + per-row `gatewayClient.usage` + per-row `kagent.knuteson.io/proposals-today` annotation read | ✓ Yes              | Live cluster verified — `/api/dispositions` returns 3 demo overlays (orchestrator / rc-spectrum-fanout-orchestrator / summarizer-rust) with `dailyBoundaryUtc=2026-05-09T00:00:00Z`. |
| `useCommandSnapshot.dispositions`    | `Map<string, DispositionOverlayRow>`                                | `fetchDispositions()` → `/api/dispositions`                                                                                                               | ✓ Yes              | Mount-once + SSE 'agent' + 30s poll trigger refetch; runtime guard `assertIsDispositionOverlayRow` per row.                                                                          |
| `DispositionOverlay.tsx`             | Per-row overlay rendering                                           | `props.snapshot.dispositions` (consumed via flat-return shape)                                                                                            | ✓ Yes              | Pure render; no internal state; reload-stable by construction (Test 7).                                                                                                              |
| `incrementProposalsToday` (operator) | `kagent.knuteson.io/proposals-today` value on disposition ConfigMap | `coreApi.patchNamespacedConfigMap` with RFC 6902 JSON-Patch test+replace                                                                                  | ✓ Yes              | 17/17 unit tests green; CAS retry up to 3 conflicts then warn-and-return.                                                                                                            |

### Behavioral Spot-Checks

| Behavior                                                                             | Command                                                                        | Result                                                                                                         | Status |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------ |
| @kagent/audit-events test suite passes                                               | `pnpm --filter @kagent/audit-events exec vitest run`                           | `Test Files 2 passed; Tests 54 passed`                                                                         | ✓ PASS |
| @kagent/dto test suite passes (parser + DTO)                                         | `pnpm --filter @kagent/dto exec vitest run`                                    | `Test Files 4 passed; Tests 63 passed`                                                                         | ✓ PASS |
| @kagent/operator test suite passes (narrowing + cap-issuer + reconcile)              | `pnpm --filter @kagent/operator exec vitest run`                               | `Test Files 53 passed; Tests 1286 passed`                                                                      | ✓ PASS |
| @kagent/workbench-api test suite passes (dispositions route)                         | `pnpm --filter @kagent/workbench-api exec vitest run`                          | `Test Files 13 passed; Tests 174 passed`                                                                       | ✓ PASS |
| @kagent/workbench-ui test suite passes (DispositionOverlay + state + source-binding) | `pnpm --filter @kagent/workbench-ui exec vitest run`                           | `Test Files 4 passed; Tests 32 passed`                                                                         | ✓ PASS |
| Schema-validate Job runs Complete on cluster                                         | `kubectl -n kagent-system get jobs -l phase=01-disposition` (cluster evidence) | `disposition-schema-validate Complete 1/1`; `valid: OK / invalid: correctly rejected`                          | ✓ PASS |
| `/api/dispositions` returns DispositionOverlayRow[] on live pod                      | In-pod node fetch (cluster evidence)                                           | 3 demo rows returned, all pass `assertIsDispositionOverlayRow`                                                 | ✓ PASS |
| Workbench Command Center renders overlay (visual)                                    | User visual verification (cluster evidence)                                    | "it looks the same as before with a few more items" — 3 disposition rows render alongside flow-economy widgets | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan   | Description                                                                                                               | Status      | Evidence                                                                                                                                                                                                                             |
| ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DISP-01     | 01-01-PLAN.md | Sibling-ConfigMap overlay carrier with required fields; schema-validation Job                                             | ✓ SATISFIED | Parser + Helm-templated Job + label/annotation contract; cluster Job runs Complete; 4 fixtures shipped.                                                                                                                              |
| DISP-02     | 01-02-PLAN.md | `mayProposeAgainst` narrows capability-JWT scope at issuance time; typed audit event on rejection (narrows-never-widens)  | ✓ SATISFIED | `narrowByDispositionOverlay` pure fn (11 unit tests, monotonicity proven); cap-issuer integration site (12 disposition tests); typed `disposition.proposal_rejected` event with `agentRef` + `dispositionConfigMapName` + `taskUid`. |
| DISP-03     | 01-03-PLAN.md | `/api/dispositions` projection from existing telemetry; over-budget audit; no new persistence                             | ✓ SATISFIED | Route mounted; computed projection from gateway DTOs + operator-written annotation; in-process exactly-once-per-day dedup; orphan-overlay filter; helm RBAC `configmaps:[get,list,watch]` (read-only).                               |
| DISP-04     | 01-04-PLAN.md | Command Center renders disposition overlay; every field source-bound; budget remaining + over-budget count; reload-stable | ✓ SATISFIED | `DispositionOverlay.tsx` + module CSS + 12 vitest cases incl. reload-stability selector tree; mounted in CommandView; Slice E `VITE_PRESSURE_DRAMATIZATION` gate; user-visual cluster approval.                                      |

**Coverage:** 4/4 declared requirements satisfied. No orphaned requirements (REQUIREMENTS.md §1 maps DISP-01..04 to Phase 1 only; all four declared in plan frontmatters).

### §11 Bounds Test (per docs/NORTH-STAR-SYSTEM-DESIGN.md §11)

| Bounds Element                  | Phase 1 Realization                                                                                                                                                                                                                    | Verified |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------: |
| **Declared capability**         | `DispositionOverlay` schema declares `idleBehavior.readChannels`, `attentionBudget`, `proposalScope.mayProposeAgainst`, `maxProposalsPerDay`. Capability JWT carries the narrowed tool set.                                            |    ✓     |
| **Bounded resource drain**      | `attentionBudget.tokensPerDay` + `attentionBudget.pollIntervalSeconds` + `maxProposalsPerDay`. Counters tracked in `/api/dispositions` projection; over-budget condition emits a substrate event.                                      |    ✓     |
| **Observable state transition** | `kagent.knuteson.io/proposals-today` + `proposals-today-day` annotations on the disposition ConfigMap (operator write); `/api/dispositions` projection (read); Command Center overlay (visual).                                        |    ✓     |
| **Auditable output**            | Two typed audit events: `disposition.proposal_rejected` (operator → NATS audit stream) + `disposition.over_budget` (workbench-api → NATS audit stream). CloudEvents v1.0 envelope.                                                     |    ✓     |
| **Revocation path**             | Delete the disposition ConfigMap → next `loadDispositionOverlayForAgent` returns `null` → narrowing skipped → un-narrowed JWT issued. Operator-driven; no agent involvement. Documented in plan 02 SUMMARY "Revocation path verified". |    ✓     |

### §15 One-Sentence Test (per docs/NORTH-STAR-SYSTEM-DESIGN.md §15)

> "Phase 1 lets the substrate turn an Agent author's idle-behavior intent into bounded
> resource drain (token + proposal budget), observable state transition (counters in
> `/api/dispositions` + Command Center overlay), and auditable narrowing
> (`disposition.proposal_rejected` / `disposition.over_budget` typed events) — with a
> single-CR-deletion revocation path — without introducing a new CRD, reconciler, or
> admission webhook."

✓ Fits in one sentence. Captures clearer authority (narrowed JWT scope), resource
accounting (tokensPerDay / maxProposalsPerDay), observability (projection + overlay),
review (audit events), and revocation (CR deletion).

### Anti-Patterns Found

None within phase scope.

| File | Pattern | Severity | Impact |
| ---- | ------- | -------- | ------ |

(No blockers; no warnings; no info items in disposition surface.)

**Notable observations (informational, NOT gaps):**

- `proposal-tool-map.ts` carries an OBSERVATION-PHASE-ONLY warning by design (plan
  01 D-DISP-01-D). This is intentional — production deployments must NOT narrow until
  v0.3 wires propose-specific tool names. The plan documents this clearly; the source
  comment is load-bearing, not a stub.
- `postsToday` is locked to TypeScript literal `0` in DTO + UI (plan 03 D-DISP-03-B,
  plan 04 D-DISP-04-F). Posts/Channels graduate from Future Research before this widens.
  Intentional, not a stub.
- In-process Set dedup for `disposition.over_budget` will lose state on workbench-api
  pod restart (re-emit-once-per-(agentRef, reason) on next projection). Documented
  trade-off; acceptable for v0.2 observation phase per plan 03 D-DISP-03-C; v0.3+
  promotion candidate to persisted dedup.
- Pre-existing `EADDRINUSE :8081` operator pod CrashLoop (plan 01 deviation #4) is
  unrelated to phase scope; Sync-hook Jobs run as standalone Pods and were not blocked.
  Should be tracked separately as out-of-scope for Phase 1.

### Human Verification Required

None outstanding. End-to-end visual verification on homelab cluster was completed by
the user on 2026-05-09 ("it looks the same as before with a few more items" — three
disposition rows render alongside flow-economy widgets in Command Center; DOM source-
binding attributes intact and inspector-visible per CC-01 §2 contract).

### Cluster-Side Evidence (already collected)

- Tag `v0.2.0-disp-rc.1` deployed to homelab K3s (`d40d8f6` after CI fixes).
- Pods at `v0.2.0-disp-rc.1`: kagent-workbench api+ui (2/2 Running); kagent-operator
  (rolling).
- `Job/disposition-schema-validate`: `SuccessCriteriaMet`, `succeeded=1`, log shows
  `valid: OK / invalid: correctly rejected (idleBehavior.attentionBudget.tokensPerDay
must be a positive number)`.
- 3 demo overlays in cluster: `kagent-system/orchestrator-disposition`,
  `kagent-rc-spectrum/rc-spectrum-fanout-orchestrator-disposition`,
  `kagent-system/summarizer-rust-disposition`.
- `GET /api/dispositions` returns `DispositionOverlayRow[]` live, all rows pass
  `assertIsDispositionOverlayRow` boundary check, `dailyBoundaryUtc=2026-05-09T00:00:00Z`.
- User visual approval of Command Center rendering.

### Test Counts (re-run by verifier on 2026-05-09T20:00Z)

| Package               | Documented in SUMMARY | Re-run    | Status    |
| --------------------- | --------------------- | --------- | --------- |
| @kagent/audit-events  | 54/54                 | 54/54     | ✓ MATCHES |
| @kagent/dto           | 63/63                 | 63/63     | ✓ MATCHES |
| @kagent/operator      | 1286/1286             | 1286/1286 | ✓ MATCHES |
| @kagent/workbench-api | 174/174               | 174/174   | ✓ MATCHES |
| @kagent/workbench-ui  | 32/32                 | 32/32     | ✓ MATCHES |

### Substrate-Poor Invariants Honored

| Invariant                                                                                                                     | Verified |
| ----------------------------------------------------------------------------------------------------------------------------- | :------: |
| No new CRD added (`grep "kind: CustomResourceDefinition" packages/operator/charts/`)                                          |    ✓     |
| No new admission webhook (`grep "kind: ValidatingWebhookConfiguration\|MutatingWebhookConfiguration"`)                        |    ✓     |
| No new persistence primitive (`grep "CREATE TABLE\|prisma\|mongoose\|etcd\|BoltDB"`)                                          |    ✓     |
| No new reconciler (overlay narrowing inlined into existing cap-issuer; no new controller pod)                                 |    ✓     |
| No new NATS consumer in workbench-api (operator-written annotation is the read source; per D-DISP-03-C)                       |    ✓     |
| No `promote` / `promotion` / `MobProposal` / `CoalitionProposal` tokens in disposition surface (D6 self-proposal terminology) |    ✓     |
| No write surface added to UI (`grep -c "fetch.*method.*POST\|PATCH\|PUT"` returns 0 NEW)                                      |    ✓     |

### Gaps Summary

No gaps. All four ROADMAP success criteria (= the four DISP requirements) are
satisfied end-to-end. The phase deliberately produces evidence to decide whether to
promote AgentDisposition to a CRD field on `Agent` or to a sibling CRD in a future
milestone; the ~7-day observation window now begins per the promotion-gate clause in
ROADMAP.md.

---

_Verified: 2026-05-09T20:00:00Z_
_Verifier: Claude (gsd-verifier)_
