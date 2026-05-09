---
status: complete
phase: 01-agentdisposition-v0
plan: 03
subsystem: workbench-api
tags:
  [workbench-api, disposition, dto, audit-events, helm, rbac, hono, vitest, cloudevents, projection]

# Dependency graph
requires:
  - phase: 01-agentdisposition-v0/01-01
    provides:
      - DispositionOverlay type + parseDispositionConfigMap (in @kagent/dto)
      - DISPOSITION_LABEL + DISPOSITION_PROPOSALS_TODAY_ANNOTATION + DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION constants
      - DISPOSITION_OVER_BUDGET audit event type + DispositionOverBudgetData shape
      - tests/fixtures/disposition/gateway-usage-rows.json
  - phase: 01-agentdisposition-v0/01-02
    provides:
      - operator-written kagent.knuteson.io/proposals-today + proposals-today-day annotations (cap-issuer narrowing step)
      - configmaps:patch RBAC on operator ClusterRole (sole writer of the proposals-today annotation)
provides:
  - DispositionOverlayRow shared DTO + assertIsDispositionOverlayRow runtime guard (in @kagent/dto)
  - DispositionProposalKind + DispositionOverBudgetReason DTO types (in @kagent/dto)
  - dispositionsRoute Hono route + DispositionsRouteDeps type (in @kagent/workbench-api)
  - readProposalsTodayAnnotation pure helper exported for re-use
  - DispositionsCoreApi + DispositionsCustomApi narrow K8s client subsets
  - GET /api/dispositions endpoint mounted on the production router
  - AuditPublisher wired into workbench-api for disposition.over_budget emission
  - Helm value api.disposition.dailyBoundaryTimezone (default 'UTC') + WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ env var
  - Read-only configmaps:[get,list,watch] on workbench-api ClusterRole
affects: [01-04-disposition (DISP-04 surfaces DispositionOverlayRow in Command Center)]

# Tech tracking
tech-stack:
  added:
    - '@kagent/audit-events workspace dep on @kagent/workbench-api (was previously implicit via operator)'
  patterns:
    - 'Computed projection from existing telemetry (no new persistence primitive — D2)'
    - 'In-process Set-based dedup with `${agentRef}|${reason}|${dailyBoundaryUtc}` key — exactly-once per (agentRef, reason) per UTC-day'
    - 'overBudgetEventCountToday derived from dedup prefix+suffix filter — no new counter primitive, bounded by len(reasons)'
    - 'Orphan-overlay filter via getNamespacedCustomObject — schema-validate seed ConfigMaps and stale overlays excluded from live rows'
    - 'Annotation-reader pattern (workbench-api READS, operator WRITES) — no NATS consumer added to workbench-api per BLOCKER #2 resolution'
    - 'Shared DTO across substrate-API-UI tier boundary — DispositionOverlayRow lives in @kagent/dto so workbench-api emits and workbench-ui consumes the same type'

key-files:
  created:
    - packages/dto/src/disposition.ts
    - packages/dto/src/disposition.test.ts
    - packages/workbench-api/src/routes/dispositions.ts
    - packages/workbench-api/src/routes/dispositions.test.ts
  modified:
    - packages/dto/src/index.ts
    - packages/workbench-api/package.json
    - packages/workbench-api/src/router.ts
    - packages/workbench-api/src/main.ts
    - packages/operator/charts/kagent-workbench/values.yaml
    - packages/operator/charts/kagent-workbench/templates/deployment.yaml
    - packages/operator/charts/kagent-workbench/templates/clusterrole.yaml
    - pnpm-lock.yaml

key-decisions:
  - 'DispositionOverlayRow lives in @kagent/dto (not @kagent/workbench-api) so workbench-ui (DISP-04) imports the SAME type — single source of truth across the tier boundary.'
  - 'parseDispositionConfigMap was NOT relocated — already lives in @kagent/dto from plan 01. The dispositions route imports from @kagent/dto directly; no parser duplication.'
  - 'postsToday is locked to TypeScript literal `0` (not `number`) so a regression that wires a non-zero source surfaces at type-check time. NOT-IMPLEMENTED-IN-V0.2 documented in JSDoc; widens to `number` once Posts/Channels graduate from Future Research.'
  - 'In-process Set dedup is acceptable for v0.2 observation phase per CONTEXT.md research Q11 #5. Restart loses dedup state — over-budget events MAY re-emit once per (agentRef, reason) after a workbench-api pod restart on the same UTC day. Acceptable trade-off; documented in DTO JSDoc + this summary.'
  - 'overBudgetEventCountToday is derived by scanning the dedup Set with a `${agentRef}|...|${dailyBoundaryUtc}` prefix+suffix filter. No new counter primitive; the count auto-resets at UTC midnight because yesterday-keyed entries are filtered out.'
  - 'Orphan-overlay filter (Agent existence check via getNamespacedCustomObject) is REQUIRED — the schema-validate seed ConfigMap deployed in plan 01 and any stale overlays must NOT render as live Command Center rows. Failure to verify Agent existence (readCustomApi unavailable) is treated as fail-closed: the row is omitted rather than rendered unverified.'
  - 'AuditPublisher wired in main.ts is best-effort; a missing KAGENT_AUDIT_NATS_URL or unreachable NATS does NOT block the read endpoint. The dispositions route handles `auditPublisher === undefined` by skipping emission while still computing the projection.'
  - "Daily-boundary timezone is plumbed end-to-end (Helm value api.disposition.dailyBoundaryTimezone → env var WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ → DispositionsRouteDeps.disposition.dailyBoundaryTimezone) but only 'UTC' is honored in code; non-UTC values log ONE warning at router build time and fall back to UTC. Forward-compat hook for IANA names without a code change today."
  - 'Workbench-api ClusterRole gains configmaps:[get,list,watch] only — explicitly NO write verbs. The operator chart owns configmaps:patch (granted in plan 01) for the proposals-today annotation; the split keeps the substrate-poor invariant honest.'
  - 'Test 18 — UTC-midnight rollover boundary case verified: timestamps 1ms apart but in different UTC days produce distinct dedup keys, distinct dailyBoundaryUtc values, and a fresh over-budget audit event on the new day. Defends against off-by-one rollover bugs.'

patterns-established:
  - 'Computed projection over existing telemetry — pattern for any future "show me X today" UI surface that should NOT add a new database table.'
  - 'Annotation-reader vs annotation-writer split — pattern for any per-Agent counter where the operator owns the write and a read-only consumer (workbench-api / metric scraper) reads the annotation.'
  - 'In-process dedup for at-most-once audit emission — pattern for any "over-budget" / "threshold breached" event class where a flood would drown the audit warehouse.'
  - 'Shared DTO across @kagent/dto + @kagent/workbench-api + @kagent/workbench-ui — pattern for any read-side type that crosses the substrate-API-UI boundary.'

requirements-completed: [DISP-03]

# Metrics
duration: ~30m (single worktree session, no checkpoints, three task commits)
completed: 2026-05-09
---

# Phase 01 Plan 03: Dispositions Projection Route + Over-Budget Audit (DISP-03) Summary

**`GET /api/dispositions` is a computed projection over existing v0.1 telemetry — gateway token-usage DTOs (spentTokensToday) plus the operator-written `kagent.knuteson.io/proposals-today` annotation (proposalsToday) — exposing per-Agent budget remaining, an over-budget event count, and emitting `disposition.over_budget` substrate audit events exactly once per (agentRef, reason) per UTC-day-window. Zero new persistence primitive, zero new CRD, zero new NATS consumer in workbench-api.**

## Performance

- **Duration:** ~30m (single worktree session)
- **Completed:** 2026-05-09
- **Tasks:** 3 / 3
- **Files modified:** 12 (4 created, 8 modified) — `packages/dto`, `packages/workbench-api`, and `packages/operator/charts/kagent-workbench`

## Accomplishments

- Lands DISP-03 (REQ-DISP-03): `/api/dispositions` exposes per-Agent budget remaining + over-budget event count from existing telemetry. Honors D2 (no new persistence): spentTokensToday is summed from gateway DTOs; proposalsToday is read from the operator-written ConfigMap annotation; postsToday is reserved at literal `0`.
- Single source of truth across the tier boundary: `DispositionOverlayRow` lives in `@kagent/dto`. Workbench-api emits it (here); workbench-ui will consume it (DISP-04). The runtime guard `assertIsDispositionOverlayRow` defends the UI side against schema drift.
- Exactly-once-per-(agentRef, reason)-per-UTC-day-window emission verified by Tests 9 + 10 + 18. The dedup Set's keys are `${agentRef}|${reason}|${dailyBoundaryUtc}`; UTC midnight rollover produces a distinct key and re-arms emission.
- Orphan-overlay filter implemented: schema-validate seed ConfigMaps (deployed in plan 01) and stale overlays whose `agent-ref` resolves to a missing Agent are excluded from `items`. Verified by Test 16.
- `overBudgetEventCountToday` (per ROADMAP success criterion 4) is derived by scanning the dedup Set with a today-only prefix+suffix filter — no new counter primitive, bounded by `[0, 2]`, auto-resets at UTC midnight.
- AuditPublisher wired into workbench-api via `KAGENT_AUDIT_NATS_URL` (same env-var convention as the operator); best-effort connect, graceful no-op on outage.
- Helm chart updates: read-only `configmaps:[get,list,watch]` RBAC on workbench-api ClusterRole (split from the operator chart's `configmaps:patch`); `api.disposition.dailyBoundaryTimezone` Helm value + `WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ` env var plumbed end-to-end.
- Test posture: 11 tests on the DTO, 22 tests on the route + helper. Full workbench-api suite green at 174/174 tests; full @kagent/dto suite at 63/63; @kagent/audit-events untouched at 54/54.

## Task Commits

Each task was committed atomically on the worktree branch `worktree-agent-ac8a3ace930a5cb57`:

1. **Task 1: DispositionOverlayRow shared DTO** — `9f47bc8` (feat)
2. **Task 2: /api/dispositions projection route + over_budget exactly-once-per-day emission** — `5900207` (feat)
3. **Task 3: Mount route + Helm value + read-only configmaps RBAC** — `a62bfa9` (feat)

This SUMMARY commit follows immediately after Task 3 in the same worktree branch.

## Files Created/Modified

Created (4):

- `packages/dto/src/disposition.ts` — DispositionOverlayRow type + DispositionProposalKind + DispositionOverBudgetReason + assertIsDispositionOverlayRow runtime guard. MIT header + module JSDoc tying the DTO to the substrate-API-UI tier boundary.
- `packages/dto/src/disposition.test.ts` — 11 vitest cases covering shape acceptance, missing-field guard failures, type-level invariants (postsToday literal, overBudgetReason union, overBudgetEventCountToday required-not-optional).
- `packages/workbench-api/src/routes/dispositions.ts` — `dispositionsRoute` Hono route + `DispositionsRouteDeps` interface + `DispositionsCoreApi` / `DispositionsCustomApi` narrow K8s client subsets + exported `readProposalsTodayAnnotation` helper. ~390 lines.
- `packages/workbench-api/src/routes/dispositions.test.ts` — 22 vitest cases. Inline fixture builders for V1ConfigMap + GatewayClient + CustomObjectsApi + AuditPublisher stubs.

Modified (8):

- `packages/dto/src/index.ts` — re-exports DispositionOverlayRow / DispositionProposalKind / DispositionOverBudgetReason / assertIsDispositionOverlayRow.
- `packages/workbench-api/package.json` — adds `@kagent/audit-events: workspace:*` dependency (was previously implicit via the operator package; explicit dep avoids isolated-install brittleness).
- `packages/workbench-api/src/router.ts` — extends RouterDeps with optional `auditPublisher` and `disposition.{ dailyBoundaryTimezone, watchNamespaces }`. Mounts `/api/dispositions` when `coreApi` is wired; logs ONE warning at build time when `dailyBoundaryTimezone` is non-UTC.
- `packages/workbench-api/src/main.ts` — constructs AuditPublisher when `KAGENT_AUDIT_NATS_URL` is set; reads `WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ` and `KAGENT_WATCH_NAMESPACES`; threads them into buildRouter; closes the publisher on shutdown.
- `packages/operator/charts/kagent-workbench/values.yaml` — adds `api.disposition.dailyBoundaryTimezone: 'UTC'`.
- `packages/operator/charts/kagent-workbench/templates/deployment.yaml` — adds `WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ` env var.
- `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml` — adds READ-ONLY `configmaps:[get,list,watch]` rule.
- `pnpm-lock.yaml` — refreshed for the new workspace dep.

## Plan-level verifications

All checks PASSED. Reproducible from the SHAs above:

- `pnpm --filter @kagent/dto exec vitest run src/disposition.test.ts` — **11 / 11 tests pass**
- `pnpm --filter @kagent/dto exec vitest run` (full @kagent/dto suite) — **63 / 63 tests pass**
- `pnpm --filter @kagent/workbench-api exec vitest run src/routes/dispositions.test.ts` — **22 / 22 tests pass**
- `pnpm --filter @kagent/workbench-api exec vitest run` (full @kagent/workbench-api suite) — **174 / 174 tests pass** (152 pre-existing + 22 new)
- `pnpm --filter @kagent/audit-events exec vitest run` (regression check, untouched) — **54 / 54 tests pass**
- `pnpm --filter @kagent/dto typecheck` — **clean** (no errors)
- `pnpm --filter @kagent/workbench-api typecheck` — **clean** (no errors)
- `helm lint packages/operator/charts/kagent-workbench` — **0 charts failed** (1 INFO about a recommended icon, unrelated)
- `helm template kagent-workbench packages/operator/charts/kagent-workbench | grep WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ` — env var renders with `value: "UTC"`
- `helm template kagent-workbench packages/operator/charts/kagent-workbench | grep -A 1 "resources: \['configmaps'\]"` — verbs render as `['get', 'list', 'watch']` with no write verbs
- `grep -n "postsToday: 0" packages/dto/src/disposition.ts packages/workbench-api/src/routes/dispositions.ts` — matches in BOTH files (literal `0`, not number)
- `grep -n "overBudgetEventCountToday" packages/dto/src/disposition.ts` — matches at 3 lines (declaration + runtime-guard check + error string), satisfying the >=2 acceptance criterion
- `grep -c "proposals-today-reset-at" packages/workbench-api/src/routes/dispositions.ts packages/workbench-api/src/routes/dispositions.test.ts` — 0 matches in BOTH files (deprecated annotation name purged)
- `grep -rn "kind: CustomResourceDefinition\|kind: ValidatingWebhookConfiguration\|kind: MutatingWebhookConfiguration" packages/operator/charts/kagent-workbench/templates/` — none (no new CRD, no admission webhook)
- `grep -rEn "CREATE TABLE|prisma|mongoose|etcd|BoltDB" packages/workbench-api/src/routes/dispositions.ts packages/dto/src/disposition.ts` — none (no new persistence)
- `grep -rn "promote\|promotion\|self-promote" packages/dto/src/disposition.ts packages/workbench-api/src/routes/dispositions.ts packages/workbench-api/src/routes/dispositions.test.ts packages/dto/src/disposition.test.ts` — none (D6 self-proposal terminology honored)

## Verification details

### DispositionOverlayRow type signature (verbatim)

```typescript
export type DispositionProposalKind = 'templates' | 'verifiers' | 'capability-policy';
export type DispositionOverBudgetReason = 'tokens_exceeded' | 'proposals_exceeded' | 'both';

export interface DispositionOverlayRow {
  readonly agentRef: string; // "namespace/name"
  readonly namespace: string;
  readonly agentName: string;
  readonly configMapName: string;
  readonly idleBehavior: {
    readonly readChannels: readonly string[];
    readonly attentionBudget: {
      readonly tokensPerDay: number;
      readonly pollIntervalSeconds: number;
    };
    readonly proposalScope: {
      readonly mayProposeAgainst: readonly DispositionProposalKind[];
      readonly maxProposalsPerDay: number;
    };
  };
  readonly spentTokensToday: number; // sum across gateway usage rows
  readonly postsToday: 0; // literal — Posts/Channels are Future Research
  readonly proposalsToday: number; // read from kagent.knuteson.io/proposals-today
  readonly overBudget: boolean;
  readonly overBudgetReason?: DispositionOverBudgetReason;
  readonly overBudgetEventCountToday: number; // dedup-scan count, [0, 2]
  readonly dailyBoundaryUtc: string; // ISO 8601, UTC midnight by default
}
```

### Projection algorithm (3-step)

1. **List** ConfigMaps with the `kagent.knuteson.io/agent-disposition=true` label. Cluster-wide via `listConfigMapForAllNamespaces({ labelSelector })` when `watchNamespaces` is empty/undefined; per-namespace via `listNamespacedConfigMap` otherwise. K8s client v1.x object-form signatures; no `.body` envelope.
2. **Parse** each ConfigMap via `parseDispositionConfigMap` from `@kagent/dto` (single source of truth — same parser the operator's overlay-loader uses). Malformed ConfigMaps are filtered out and logged via the injected `logger.warn` (Test 12).
3. **Compute** per-row counters:
   - **`spentTokensToday`**: sum of `inputTokens + outputTokens` across `gatewayClient.usage({ agentName, since: dailyBoundaryUtc, limit: 1000 })`. Null gateway → 0; gateway error → log + 0 (T-03-02 fail-soft).
   - **`proposalsToday`**: `readProposalsTodayAnnotation(cm, todayDay)` — reads the operator-written `kagent.knuteson.io/proposals-today` value when the sibling `proposals-today-day` matches today's UTC day; otherwise 0 (rollover) or sanitized to 0 (T-03-01 mitigation).
   - **`overBudget`** = `spentTokensToday > tokensPerDay || proposalsToday > maxProposalsPerDay`.
   - **`overBudgetReason`**: `'both'` when both, otherwise the one tripped, otherwise undefined.
   - **`dailyBoundaryUtc`** = ISO 8601 of UTC midnight of `now()`.
   - **`overBudgetEventCountToday`** = count of dedup keys matching `${overlay.agentRef}|...|${dailyBoundaryUtc}`.
   - **`postsToday`** = literal `0`.

### Agent-existence filtering for orphan overlays

The plan 01 schema-validate Job ships a seed ConfigMap (`kagent.knuteson.io/agent-disposition=true` labeled) for the negative-path test. That ConfigMap parses successfully but its `agent-ref` (`kagent-system/broken-agent`) does NOT correspond to a real Agent CR. Without an Agent-existence check, the seed would render in the Command Center Dispositions panel as a "live" row.

The route invokes `getNamespacedCustomObject({ group: 'kagent.knuteson.io', version: 'v1alpha1', plural: 'agents', namespace, name })` for every parsed overlay before producing the row. A 404 (or any other failure) → row excluded with a structured warning. When `readCustomApi` is undefined, the route fail-closes (returns empty `items`) rather than rendering unverified rows.

This addresses ROADMAP success criterion 3 (no UI-only state — every rendered row corresponds to a real Agent in the substrate) and prevents schema-validation seed manifests + stale overlays from polluting Command Center.

### Exactly-once-per-day-per-reason dedup

Dedup key: `${agentRef}|${reason}|${dailyBoundaryUtc}`.

- First over-budget condition observation: key absent → `dedup.add(key)` → publish event.
- Subsequent same-day same-(agentRef, reason) observations: key present → skip publish.
- UTC midnight rollover: `dailyBoundaryUtc` advances to the new day's midnight ISO 8601 → fresh key → fresh publish.
- Both reasons (`'both'`): two distinct keys (`...|tokens_exceeded|...` + `...|proposals_exceeded|...`) → two publishes.

**Restart-loss limitation:** The dedup Set is in-process. A workbench-api pod restart loses dedup state, so an over-budget condition that survived the restart will re-emit ONCE per (agentRef, reason) on the next projection request post-restart. **Acceptable per CONTEXT.md research Q11 #5** ("audit best-effort; observation phase semantics; restart loses state but the observation window is small"). For v0.3+ a persisted dedup (operator-written annotation, or NATS KV bucket) would close this gap; explicitly out of scope for v0.2.

### Helm value + env-var path

```
api:
  disposition:
    dailyBoundaryTimezone: 'UTC'   # values.yaml
                |
                v (deployment.yaml)
            env:
              - name: WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ
                value: "UTC"
                |
                v (main.ts)
            disposition: { dailyBoundaryTimezone: 'UTC' }
                |
                v (router.ts: warn if non-UTC; v0.2 only honors UTC)
            DispositionsRouteDeps.disposition.dailyBoundaryTimezone
```

Forward-compat hook: any IANA timezone name passes typing. v0.2 code only honors `'UTC'` and falls back to UTC with a warning for everything else.

### Workbench chart RBAC + deployment env var path

- `templates/clusterrole.yaml` adds:
  ```yaml
  - apiGroups: ['']
    resources: ['configmaps']
    verbs: ['get', 'list', 'watch']
  ```
  No write verbs. The operator chart owns `configmaps:patch` (granted in plan 01); the split keeps the substrate-poor invariant honest.
- `templates/deployment.yaml` adds:
  ```yaml
  - name: WORKBENCH_DISPOSITION_DAILY_BOUNDARY_TZ
    value: { { .Values.api.disposition.dailyBoundaryTimezone | default "UTC" | quote } }
  ```

### Package dependency added for @kagent/audit-events

`packages/workbench-api/package.json` now lists `@kagent/audit-events: workspace:*` as a runtime dependency. Previously the workbench-api did not consume audit-events directly; this plan introduces the `disposition.over_budget` emission so the dep becomes load-bearing.

### parseDispositionConfigMap location

The parser was NOT relocated. It already lives in `@kagent/dto/src/disposition-parser.ts` (created in plan 01). Both the operator (`overlay-loader.ts` → cap-issuer narrowing) and the workbench-api (this plan) import the SAME parser from `@kagent/dto`, preserving the single-source-of-truth invariant.

### Open observations to feed the post-phase promotion-gate evidence packet

Phase 1's closure produces an evidence packet about whether to promote AgentDisposition from "overlay on a ConfigMap" to a CRD field on `Agent` or a sibling CRD. Plan 03 contributes the following observations:

1. **Which counter fields are queried.** When workbench-ui (DISP-04) lights up Command Center reads, log the GET /api/dispositions request rate. If the rate is sustained (e.g., >1 req/s per Agent over a 7-day window), the projection's O(N_overlays) per-request cost becomes load-bearing and an informer-cached read (or a CRD-status field) is empirically justified.
2. **How often over-budget conditions fire.** Audit warehouse query: `SELECT data.agentRef, count(*) FROM audit WHERE type = 'disposition.over_budget' GROUP BY data.agentRef`. A high count (>10/day per Agent) is empirical evidence that the budgets are too tight; a count of 0 indicates over-provisioning. Both signals feed the post-phase decision on default budget values.
3. **Restart-loss observability.** Track workbench-api pod restart events via the existing kubelet event stream. Cross-reference with the audit stream's `disposition.over_budget` events: a re-emission within 1 minute of a restart on the same UTC day is the dedup-loss signal. If the rate is non-trivial, persisted dedup becomes a v0.3+ requirement.
4. **Orphan-overlay rate.** The route's `dispositions: skipping orphan overlay for missing Agent` warning frequency. A non-zero rate during normal operation indicates stale overlays; plan 01's schema-validate Job seed contributes 1 expected orphan (the `broken-agent` test fixture). Anything beyond that is empirical evidence for a Phase 1.5 sweep that GC's stale overlays via an operator reconciler.
5. **Daily-boundary timezone configuration.** Track whether any deployment overrides `api.disposition.dailyBoundaryTimezone` away from `'UTC'`. If any deployment does so (and reads the resulting warning), it's empirical evidence that v0.3+ should implement the IANA branch.

These observations are emitted via existing telemetry (audit stream + Kubernetes events + workbench-api logs); no new instrumentation is required.

## Decisions Made

- **D-DISP-03-A:** DispositionOverlayRow lives in `@kagent/dto`. Single source of truth across substrate-API-UI tier boundary.
- **D-DISP-03-B:** postsToday locked to TypeScript literal `0` in v0.2 (Posts/Channels are Future Research). NOT-IMPLEMENTED-IN-V0.2 documented in JSDoc.
- **D-DISP-03-C:** In-process Set dedup acceptable for v0.2 observation phase. Restart-loss limitation documented; persisted dedup deferred to v0.3+.
- **D-DISP-03-D:** overBudgetEventCountToday derived from dedup prefix+suffix scan — no new counter primitive. Bounded by `[0, 2]`.
- **D-DISP-03-E:** Orphan-overlay filter via `getNamespacedCustomObject` is REQUIRED. Schema-validate seed ConfigMaps and stale overlays MUST NOT render as live Command Center rows. Fail-closed on missing readCustomApi.
- **D-DISP-03-F:** workbench-api ClusterRole gains `configmaps:[get,list,watch]` only — explicitly NO write verbs. The operator chart owns `configmaps:patch`.
- **D-DISP-03-G:** Daily-boundary timezone is plumbed end-to-end (Helm value → env var → DispositionsRouteDeps) but only `'UTC'` is honored in v0.2. Non-UTC values log a warning at router build time and fall back to UTC.
- **D-DISP-03-H:** AuditPublisher uses the same `KAGENT_AUDIT_NATS_URL` env var as the operator — shared substrate audit stream. Source field is `kagent.knuteson.io/workbench-api`.

## Deviations from Plan

None. Plan executed exactly as written.

The only minor adjustments worth noting:

1. **Linter feedback fixed inline.** Two pre-commit ESLint errors were caught and fixed in-place before the commits landed:
   - Task 1: `String(reason)` flagged by `@typescript-eslint/no-base-to-string` because `reason` was `unknown` at that point. Replaced with `typeof reason === 'string' ? reason : JSON.stringify(reason)`.
   - Task 2: vitest mock implementation marked `async` but had no `await` (`@typescript-eslint/require-await`). Switched to a non-async function returning `Promise.resolve(...)`.
   - These are linter-driven micro-fixes, not deviations.
2. **Prettier reformatted some object returns** during the pre-commit lint-staged hook (e.g., removing `as unknown as` casts that were no longer needed once a return-type annotation was inferable). The semantics are unchanged.

## Issues Encountered

1. **`pnpm install` was needed before the first commit.** The fresh worktree had no `node_modules`; the lint-staged pre-commit hook depends on resolved workspace deps. One-time setup, not a recurring issue.
2. **The `@kubernetes/client-node` v1.x signature for `listConfigMapForAllNamespaces` was confirmed to be object-form** (`{ labelSelector }`) returning `Promise<V1ConfigMapList>` directly (no `.body`) — same idiom the operator's `overlay-loader.ts` already uses for `listNamespacedConfigMap`. The route's body uses both signatures (cluster-wide vs per-namespace) consistently.
3. **No homelab cluster verification in this plan.** Plan 03 lands a chart change (RBAC + env var) but no functional change requires post-merge cluster validation beyond a chart re-deploy. Cluster verification (a smoke test of `GET /api/dispositions` returning an item for `researcher-01-disposition` after deployment) is out of scope for the executor; the orchestrator owns post-merge cluster validation if any.

## User Setup Required

None for plan 03's code changes.

For deployment-time plumbing (out of scope for the executor):

- `KAGENT_AUDIT_NATS_URL` must be set on the workbench-api pod for `disposition.over_budget` events to publish. The operator chart already wires this for the operator pod; the workbench chart will need a corresponding `audit.enabled` knob in a follow-up plan if we want the events emitted from the homelab cluster. (Today the events flow only when `KAGENT_AUDIT_NATS_URL` is set in the workbench's pod env; absent this, the projection still computes correctly and the audit emission no-ops.)

## Next Phase Readiness

DISP-04 (Wave 4 plan 04) is unblocked:

- `DispositionOverlayRow` is exported from `@kagent/dto`. Workbench-ui imports the same type — no DTO duplication risk.
- `assertIsDispositionOverlayRow` is the UI's runtime defense against schema drift on the API response.
- `GET /api/dispositions` returns `{ items: DispositionOverlayRow[] }` with substantive fields populated from real telemetry on a homelab deployment.
- The orphan-overlay filter ensures that Command Center never renders schema-validate seed ConfigMaps or stale overlays — DISP-04's vitest snapshot tests can rely on this.

No blockers carried forward.

## Self-Check

Verified the SUMMARY's load-bearing claims:

- All 3 task commits exist in `git log` on the worktree branch:
  - `9f47bc8 feat(phase-01-disp): add DispositionOverlayRow shared DTO (DISP-03)` — FOUND
  - `5900207 feat(phase-01-disp): add /api/dispositions projection route + over_budget exactly-once-per-day emission (DISP-03)` — FOUND
  - `a62bfa9 feat(phase-01-disp): mount /api/dispositions in workbench-api + Helm value (DISP-03)` — FOUND
- All 4 created files exist on disk:
  - `packages/dto/src/disposition.ts` — FOUND
  - `packages/dto/src/disposition.test.ts` — FOUND
  - `packages/workbench-api/src/routes/dispositions.ts` — FOUND
  - `packages/workbench-api/src/routes/dispositions.test.ts` — FOUND
- All 8 modified files exist on disk and reflect the documented changes:
  - `packages/dto/src/index.ts` — FOUND (re-exports added)
  - `packages/workbench-api/package.json` — FOUND (`@kagent/audit-events` dep added)
  - `packages/workbench-api/src/router.ts` — FOUND (mount + RouterDeps extension)
  - `packages/workbench-api/src/main.ts` — FOUND (AuditPublisher + env wiring)
  - `packages/operator/charts/kagent-workbench/values.yaml` — FOUND (`api.disposition.dailyBoundaryTimezone`)
  - `packages/operator/charts/kagent-workbench/templates/deployment.yaml` — FOUND (env var)
  - `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml` — FOUND (read-only configmaps rule)
  - `pnpm-lock.yaml` — FOUND (workspace dep refresh)
- `pnpm --filter @kagent/dto exec vitest run` exits 0 with **63 / 63** tests passing.
- `pnpm --filter @kagent/workbench-api exec vitest run` exits 0 with **174 / 174** tests passing.
- `pnpm --filter @kagent/audit-events exec vitest run` exits 0 with **54 / 54** tests passing (regression check; untouched).
- `pnpm --filter @kagent/dto typecheck` exits 0 (no errors).
- `pnpm --filter @kagent/workbench-api typecheck` exits 0 (no errors).
- `helm lint packages/operator/charts/kagent-workbench` exits 0 (1 INFO about a recommended icon, unrelated).
- `helm template kagent-workbench packages/operator/charts/kagent-workbench` renders the new env var and the read-only configmaps rule cleanly.
- No edits to STATE.md or ROADMAP.md (orchestrator owns those).
- No new admission webhook (`grep -rn "kind: ValidatingWebhookConfiguration\|kind: MutatingWebhookConfiguration" packages/operator/charts/kagent-workbench/templates/`) — none added.
- No new CRD (`grep -rn "kind: CustomResourceDefinition" packages/operator/charts/kagent-workbench/templates/`) — none added.
- No new persistence primitive (`grep -rEn "CREATE TABLE|prisma|mongoose|etcd|BoltDB" packages/workbench-api/src/routes/dispositions.ts packages/dto/src/disposition.ts`) — none.
- No occurrences of `promote` / `promotion` / `self-promote` in any new file (D6 self-proposal terminology honored).

## Self-Check: PASSED

---

_Phase: 01-agentdisposition-v0_
_Plan: 03_
_Completed: 2026-05-09_
