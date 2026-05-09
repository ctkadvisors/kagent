---
status: complete
phase: 01-agentdisposition-v0
plan: 02
subsystem: operator
tags: [capability-jwt, disposition, audit-events, operator, reconciler, json-patch, configmap]

# Dependency graph
requires:
  - phase: 01-agentdisposition-v0/01-01
    provides:
      - DispositionOverlay type + parseDispositionConfigMap (in @kagent/dto)
      - PROPOSAL_TOOL_MAP + classifyToolAsProposal (operator side)
      - loadDispositionOverlayForAgent (operator side)
      - DISPOSITION_PROPOSAL_REJECTED audit event type
      - DISPOSITION_PROPOSALS_TODAY_ANNOTATION + _DAY_ANNOTATION constants
      - configmaps:patch verb on operator ClusterRole
provides:
  - narrowByDispositionOverlay pure function (operator/disposition/narrow-by-overlay.ts)
  - ProposalRejection + NarrowResult types
  - incrementProposalsToday + computeNextProposalsTodayPatch + buildProposalsTodayPatchBody + formatUtcDay (operator/disposition/proposals-counter.ts)
  - cap-issuer extended with optional loadDispositionOverlay + auditPublisher + coreApi + now inputs
  - MintCapForTaskResult.dispositionRejections field
  - reconcile.ts production wiring of overlay loader + audit publisher + coreApi into mintCapabilityForTask
  - main.ts dispositionAuditHolder pattern wiring AuditPublisher into the cap-issuer audit emission path
affects:
  [
    01-03-disposition (DISP-03 reads proposals-today annotation),
    01-04-disposition (DISP-04 surfaces narrowed mint state),
  ]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'Per-Agent overlay narrowing applied BEFORE parent-narrowing — overlay = Agent-author intent, parent-bundle = child-of-parent constraint'
    - "Self-proposal terminology only (D6) — overlay narrows what an Agent's JWT may propose against; never widens"
    - 'Optimistic-concurrency CAS via JSON-Patch test+replace on metadata.resourceVersion — proposals-today counter survives parallel mints'
    - 'Fail-open-on-loader-throw at cap-issuer (availability) + fail-closed UPSTREAM at parser/schema-validate Job (correctness) — deliberate split per Codex HIGH counter-stance'
    - 'Mutable audit-holder pattern (dispositionAuditHolder) so deps object can be built before AuditPublisher connect'

key-files:
  created:
    - packages/operator/src/disposition/narrow-by-overlay.ts
    - packages/operator/src/disposition/narrow-by-overlay.test.ts
    - packages/operator/src/disposition/proposals-counter.ts
    - packages/operator/src/disposition/proposals-counter.test.ts
  modified:
    - packages/operator/src/cap-issuer.ts
    - packages/operator/src/cap-issuer.test.ts
    - packages/operator/src/reconcile.ts
    - packages/operator/src/reconcile.test.ts
    - packages/operator/src/main.ts

key-decisions:
  - 'Overlay narrowing happens BETWEEN resolveAgentClaims and parent-narrowing — parent intersection runs against the already-narrowed overlay claims; subset invariants preserved by claimsSubsetViolations defense-in-depth check after both narrowings'
  - 'Fail-open-on-loader-throw at cap-issuer: transient K8s read failure looks identical to overlay-deletion (revocation path), so the cap-issuer cannot tell them apart and chooses availability. Schema-validate Job (DISP-01) + parser/loader filtering are the upstream gates that fail closed for malformed YAML'
  - 'proposals-today annotation uses optimistic-concurrency CAS (JSON-Patch test on metadata.resourceVersion) to survive parallel mints. After 3 conflicts the helper logs warn and returns void — counter exactness sacrificed for system progress (counter is best-effort observation, not a security gate)'
  - 'Counter increment fires AFTER mint completes (post-mint) so the JWT is observable in the substrate even if the patch fails. The helper itself catches and logs patch errors — mint reliability is more important than counter exactness'
  - 'Counter increment SKIPS when the post-narrowing minted JWT carries NO proposal-category tool (avoids inflating proposalsToday with non-proposal mints) and SKIPS when no overlay was loaded (nothing to write to)'
  - 'Audit publish failure is logged-and-continued; rejections are still recorded in MintCapForTaskResult.dispositionRejections so the caller has the data to re-emit if desired'

patterns-established:
  - 'Pure narrowing function + caller emits audit — separates pure logic from side-effect plumbing for unit-test simplicity'
  - 'JSON-Patch test+replace for optimistic-concurrency annotation writes — pattern for any future per-resource counter on a ConfigMap'
  - 'Optional loader/publisher/coreApi inputs on mint-style functions — pattern for adding cross-cutting concerns without breaking back-compat with existing call sites'

requirements-completed: [DISP-02]

# Metrics
duration: ~2h (planner-led; single worktree session, no checkpoints)
completed: 2026-05-09
---

# Phase 01 Plan 02: Capability JWT Narrowing by Overlay (DISP-02) Summary

**The AgentDisposition overlay's `proposalScope.mayProposeAgainst` narrows the existing capability-JWT scope at proposal-issuance time — narrowing-only, never widening — with one typed `disposition.proposal_rejected` audit event per excluded tool, and the operator owns the proposals-today annotation as the single source of truth for plan 03's projection.**

## Performance

- **Duration:** ~2h (worktree execution; tasks 1-4 atomic commits)
- **Completed:** 2026-05-09
- **Tasks:** 4 / 4
- **Files modified:** 9 (4 created, 5 modified)

## Accomplishments

- Lands DISP-02 (REQ-DISP-02): the overlay's `proposalScope.mayProposeAgainst` narrows capability-JWT scope at issuance time. Self-proposal, never self-promotion (D6) — the overlay narrows; it never widens. Structurally impossible for narrowing to widen, proven by the monotonicity test and the "narrows never widens" invariant.
- Pure `narrowByDispositionOverlay` function (no I/O) returns a fresh narrowed claims object plus a list of `ProposalRejection` records. The caller (cap-issuer) emits one `disposition.proposal_rejected` audit event per rejection.
- `incrementProposalsToday` helper PATCHes the disposition ConfigMap's `kagent.knuteson.io/proposals-today` annotation via optimistic-concurrency CAS (RFC 6902 JSON-Patch `test`+`replace` against `metadata.resourceVersion`) with up to 3 retries on 409 Conflict. This annotation is the single source of truth that workbench-api's dispositions projection (plan 03) reads to compute `proposalsToday`.
- `mintCapabilityForTask` extended with FOUR new optional inputs (back-compat preserved): `loadDispositionOverlay`, `auditPublisher`, `coreApi`, `now`. New optional output `dispositionRejections` exposes the rejection log to callers.
- The narrowing step is inserted **between** `resolveAgentClaims` and `narrowClaimsByParent`. Order matters: overlay rules express Agent-author intent (a per-Agent narrowing rule), not a child-of-parent constraint. The existing `claimsSubsetViolations` defense-in-depth check runs after both narrowings — narrowing produces a subset of input claims, so subset invariants are preserved automatically.
- The proposals-today increment runs AFTER the mint completes (post-mint) so the JWT is observable in the substrate even if the patch fails. Skip conditions: no overlay loaded, post-narrowing tools has NO proposal-category tool (avoids inflating the counter with non-proposal mints), or `coreApi` not wired (test paths).
- Production reconciler wiring: `reconcile.ts` threads `loadDispositionOverlayForAgent`, the disposition audit publisher, `coreApi`, and the clock into `mintCapabilityForTask`. `main.ts` adds a `dispositionAuditHolder` mutable holder so the `ReconcileDeps` object can be built BEFORE the `AuditPublisher` connect — the cap-issuer's audit closure reads through the holder, no-ops while the publisher is unconfigured.
- Fail-open-on-loader-throw at cap-issuer (availability) + fail-closed UPSTREAM at parser/schema-validate Job (correctness). Deliberate split per Codex HIGH counter-stance documented in the plan: revocation semantics require deleting the ConfigMap to allow the next mint to succeed (same code path as a transient K8s read error); a fail-closed cap-issuer would also fail-closed on the revocation path and break operator-driven revocation.

## Task Commits

Each task was committed atomically:

1. **Task 1: narrowByDispositionOverlay pure narrowing function** — `47d544d` (feat)
2. **Task 2: proposals-today annotation-writer helper** — `3442829` (feat)
3. **Task 3: cap-issuer wiring (narrow + emit + counter)** — `308de24` (feat)
4. **Task 4: production reconciler wiring** — `967bc97` (feat)

This SUMMARY commit follows immediately after Task 4 in the same worktree branch.

## Files Created/Modified

Created (4):

- `packages/operator/src/disposition/narrow-by-overlay.ts` — pure narrowing function + `ProposalRejection`, `NarrowResult` types (114 lines). MIT header + module JSDoc; no I/O.
- `packages/operator/src/disposition/narrow-by-overlay.test.ts` — 11 unit tests covering narrows-never-widens, monotonicity, exhaustive proposal-kind coverage, input immutability, rejection metadata fidelity (170 lines).
- `packages/operator/src/disposition/proposals-counter.ts` — `incrementProposalsToday`, `computeNextProposalsTodayPatch`, `buildProposalsTodayPatchBody`, `formatUtcDay` exports; optimistic-concurrency CAS retry loop with 409 detection covering `code` / `statusCode` / `response.statusCode` shapes (213 lines).
- `packages/operator/src/disposition/proposals-counter.test.ts` — 17 unit tests covering same-day increment, rollover, missing/malformed annotations, K8s patch call shape, JSON-Patch payload structure, non-409 patch failure handling, CAS retry success after 2 conflicts, CAS retry give-up after 3 conflicts, response.statusCode 409 detection (440 lines).

Modified (5):

- `packages/operator/src/cap-issuer.ts` — imports added (`makeEvent`, `AuditEvent`, `CoreV1Api`, `narrowByDispositionOverlay`, `ProposalRejection`, `DispositionOverlay`, `incrementProposalsToday`, `classifyToolAsProposal`); `MintCapForTaskInput` extended with `loadDispositionOverlay`, `auditPublisher`, `coreApi`, `now`; `MintCapForTaskResult` extended with `dispositionRejections`; `mintCapabilityForTask` body inserts the overlay narrowing step between `resolveAgentClaims` and `narrowClaimsByParent`, emits one `disposition.proposal_rejected` event per rejection, and (post-mint) increments the proposals-today annotation when the surviving JWT carries a proposal-category tool.
- `packages/operator/src/cap-issuer.test.ts` — `vi` added to vitest imports; `DispositionOverlay` and `ProposalKind` type imports added; new `describe('mintCapabilityForTask: AgentDisposition overlay narrowing (DISP-02)')` block with 12 tests (Tests 1, 1b, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11) covering revocation, narrowing emission, monotonicity, defense-in-depth, fail-open loader, taskUid propagation, back-compat, proposals-counter integration.
- `packages/operator/src/reconcile.ts` — imports added (`AuditEvent`, `loadDispositionOverlayForAgent`); `ReconcileDeps` extended with optional `dispositionAuditPublisher`; `mintAndPersistCapabilityIfEnabled` captures `coreApi` into a local const, threads `loadDispositionOverlay`, `auditPublisher`, `coreApi`, `now` into `mintCapabilityForTask`; the existing `createSecretIdempotent` call uses the captured `coreApi` for consistency.
- `packages/operator/src/reconcile.test.ts` — new `describe('reconcileAgentTask — DISP-02 production wiring')` block with 4 tests (Tests 1-4) covering overlay narrows persisted Secret, proposals-counter wiring, audit publisher wiring, back-compat with capCa disabled.
- `packages/operator/src/main.ts` — `dispositionAuditHolder` mutable holder added beside `capabilityAuditHolder`; the deps object's new `dispositionAuditPublisher` field reads through the holder so the cap-issuer's audit closure can be wired BEFORE the AuditPublisher connect; the audit-publisher init block populates the holder with the connected publisher so events flow onto the same audit stream as `capability.minted` / `task.admitted` / etc.

## Plan-level verifications

All checks PASSED. Reproducible from the SHAs above:

- `pnpm --filter @kagent/operator test --run -- narrow-by-overlay` — **11 / 11 tests pass**
- `pnpm --filter @kagent/operator test --run -- proposals-counter` — **17 / 17 tests pass**
- `pnpm --filter @kagent/operator test --run -- cap-issuer` — **49 / 49 tests pass** (37 pre-existing + 12 new disposition tests)
- `pnpm --filter @kagent/operator test --run -- reconcile` — **90 / 90 tests pass** (86 pre-existing + 4 new production-wiring tests)
- `pnpm --filter @kagent/operator test --run` (full operator suite) — **1286 / 1286 tests pass**
- `pnpm --filter @kagent/operator typecheck` — **clean** (no errors)
- `pnpm --filter @kagent/operator --filter @kagent/audit-events --filter @kagent/dto test --run` — **all green** (1286 + 54 + 52 = 1392 tests)
- `grep -n "narrowByDispositionOverlay" packages/operator/src/cap-issuer.ts` — matches import (line 49) + call site (line 270)
- `grep -n "incrementProposalsToday" packages/operator/src/cap-issuer.ts` — matches import + call site
- `grep -n "'disposition.proposal_rejected'" packages/operator/src/cap-issuer.ts` — matches the makeEvent call
- `grep -n "loadDispositionOverlayForAgent" packages/operator/src/reconcile.ts` — matches import + call site
- `grep -n "dispositionAuditPublisher" packages/operator/src/reconcile.ts packages/operator/src/main.ts` — matches the dep declaration, mint input, and main.ts holder wiring

## Verification details

### narrowByDispositionOverlay function signature

```typescript
export function narrowByDispositionOverlay(
  claims: CapabilityClaims,
  overlay: DispositionOverlay | null,
): NarrowResult;

export interface NarrowResult {
  readonly narrowed: CapabilityClaims;
  readonly rejections: readonly ProposalRejection[];
}

export interface ProposalRejection {
  readonly tool: string;
  readonly kind: ProposalKind; // 'templates' | 'verifiers' | 'capability-policy'
  readonly agentRef: string;
  readonly agentNamespace: string;
  readonly agentName: string;
  readonly dispositionConfigMapName: string;
  readonly dispositionConfigMapNamespace: string;
  readonly mayProposeAgainst: readonly ProposalKind[];
  readonly reason: 'not_in_mayProposeAgainst';
}
```

Behavior summary:

- `overlay === null` → pass-through (revocation path)
- `claims.tools === undefined` → pass-through
- Otherwise filter `claims.tools`: keep non-proposal tools, keep proposal tools whose kind is in `mayProposeAgainst`, reject the rest
- Output `narrowed.tools` is always a subset of input `claims.tools` (monotonic)
- Other claim categories (`models`, `spawn`, `read`, `write`, `egress`, `tenant`, etc.) pass through unchanged
- Input `claims` object is never mutated

### proposals-counter helper signature + rollover semantics

```typescript
export async function incrementProposalsToday(args: {
  readonly coreApi: ProposalsCounterCoreApi;
  readonly overlay: DispositionOverlay;
  readonly now: Date;
  readonly logger?: ProposalsCounterLogger;
}): Promise<void>;

export function computeNextProposalsTodayPatch(args: {
  readonly currentValue: string | undefined;
  readonly currentDay: string | undefined;
  readonly todayDay: string;
}): { readonly nextValue: string; readonly nextDay: string };

export function formatUtcDay(now: Date): string; // YYYY-MM-DD UTC

export function buildProposalsTodayPatchBody(args: {
  readonly resourceVersion: string;
  readonly nextValue: string;
  readonly nextDay: string;
}): unknown;
```

Rollover rules (in `computeNextProposalsTodayPatch`):

- `currentDay === todayDay` AND `currentValue` parses to a non-negative integer → `nextValue = currentValue + 1`
- Otherwise (day mismatch, missing, malformed) baseline is 0 → `nextValue = "1"`
- `nextDay` is always `todayDay` so missed-rollover writes self-correct on the next increment

### Chosen JSON-Patch payload (over `metadata.annotations`, NOT JSON-merge-patch)

```json
[
  { "op": "test", "path": "/metadata/resourceVersion", "value": "<captured-rv>" },
  {
    "op": "replace",
    "path": "/metadata/annotations/kagent.knuteson.io~1proposals-today",
    "value": "<next>"
  },
  {
    "op": "replace",
    "path": "/metadata/annotations/kagent.knuteson.io~1proposals-today-day",
    "value": "YYYY-MM-DD"
  }
]
```

Annotation keys use `~1` to escape `/` per JSON-Pointer (RFC 6901). The `@kubernetes/client-node` v1.x default `Content-Type` for `patchNamespacedConfigMap` is `application/json-patch+json` (RFC 6902, expects an array of ops) — exactly what we send. No header override needed; this mirrors the operator's existing pattern in `job-annotator.ts` (which uses `MERGE_PATCH_OPTIONS` to flip TO merge-patch when needed).

### cap-issuer integration site

The narrowing step is inserted **between `resolveAgentClaims` and `narrowClaimsByParent`**:

```text
resolveAgentClaims(input.agent)                       ← agent's declared base claims
  └─ narrowByDispositionOverlay(claims, overlay)      ← Phase 1 / DISP-02 INSERTION
       (emit disposition.proposal_rejected per rejection)
  └─ narrowClaimsByParent(overlayClaims, parent)      ← v0.3.0 parent intersection
  └─ claimsSubsetViolations(...)                      ← defense-in-depth
  └─ applyTenantClaim(...)                            ← v0.5.0 tenancy
  └─ applyTtlPolicy(...)                              ← v0.5.4 keyrotation
  └─ ca.mint({ ... })                                 ← sign the JWT
  └─ incrementProposalsToday(...)                     ← Phase 1 / DISP-02→DISP-03 BRIDGE
       (post-mint; only when overlay loaded AND
        minted JWT carries surviving proposal-category tool
        AND coreApi wired)
```

Order rationale: overlay rules express Agent-author intent (a per-Agent narrowing rule), not a child-of-parent constraint. Parent-narrowing then intersects the already-narrowed overlay claims against the parent bundle. Subset invariants preserved by the existing `claimsSubsetViolations` check that runs after both narrowings — narrowing produces a subset of input claims.

The proposals-today increment runs AFTER the mint completes so the JWT is observable in the substrate even if the patch fails.

### Audit event payload shape

```typescript
makeEvent({
  type: 'disposition.proposal_rejected',
  source: 'kagent.knuteson.io/operator',
  subject: `Agent/${r.agentNamespace}/${r.agentName}`,
  data: {
    agentRef: 'kagent-system/researcher-01',
    agentNamespace: 'kagent-system',
    agentName: 'researcher-01',
    dispositionConfigMapName: 'researcher-01-disposition',
    dispositionConfigMapNamespace: 'kagent-system',
    excludedTool: 'verifier_register',
    excludedKind: 'verifiers',
    mayProposeAgainst: ['templates'],
    reason: 'not_in_mayProposeAgainst',
    taskUid: '<input.task.metadata.uid>',
  },
});
```

The CloudEvents v1.0 envelope (`specversion`, `id`, `time`, `datacontenttype`) is stamped by `makeEvent`. Subject convention: `Agent/<ns>/<name>` (the overlay narrows an Agent's authority; the AgentTask is incidental — recorded in `data.taskUid` for forensic correlation).

### Fail-open-on-loader-throw behavior

If `input.loadDispositionOverlay(ns, name)` throws, the cap-issuer:

1. Catches the exception
2. Logs `cap-issuer: loadDispositionOverlay threw, falling back to no overlay: <message>` via `console.warn`
3. Treats as `overlay = null` — no narrowing applied; the mint proceeds with the un-narrowed `agentClaims`
4. Records no rejections; emits no audit events

Reasoning: revocation semantics require deleting the disposition ConfigMap to allow the next mint to succeed (same code path as a transient K8s read error). A fail-closed cap-issuer would also fail-closed on the revocation path and break operator-driven revocation. The schema-validate Job (DISP-01) is the upstream gate that rejects malformed YAML at GitOps-sync time before the overlay reaches the cluster; the parser/loader boundary additionally filters malformed ConfigMaps from `loadDispositionOverlays` results — these are the fail-closed-for-correctness layers. If post-Phase-1 evidence shows malformed YAML can land in-cluster despite the schema-validate Job, this is a v0.3+ tightening (switch cap-issuer loader to fail-closed with a typed `disposition.loader_failed` event), explicitly out of scope for v0.2.

### Fail-soft-on-patch-error behavior

If `incrementProposalsToday` encounters a non-409 patch failure (network, 403 RBAC, 503 apiserver):

1. The helper catches the exception
2. Logs `proposals-counter: increment failed for <agentRef>: <message>` via the injected logger
3. Returns `void` — the mint result is unaffected

Reasoning: mint reliability outweighs counter exactness. The counter is best-effort observation, not a security gate. The `disposition.over_budget` audit event (plan 03) provides the eventual-consistency over-budget signal; the workbench-api projection's gateway-token path is an independent fallback indicator. CAS retry covers the lost-update class; transient errors fall through to the warn-and-return path.

### Production reconciler wiring

`reconcile.ts` `mintAndPersistCapabilityIfEnabled` now passes the following into `mintCapabilityForTask`:

```typescript
loadDispositionOverlay: (agentNamespace, agentName) =>
  loadDispositionOverlayForAgent(coreApi, agentNamespace, agentName),
...(deps.dispositionAuditPublisher !== undefined && {
  auditPublisher: deps.dispositionAuditPublisher,
}),
coreApi, // captured non-undefined local
...(deps.now !== undefined && { now: deps.now }),
```

`main.ts` wires the `dispositionAuditPublisher` via the established mutable-holder pattern:

```typescript
const dispositionAuditHolder: { publisher?: AuditPublisher } = {};
// ...
dispositionAuditPublisher: {
  publish: async (event) => {
    await dispositionAuditHolder.publisher?.publish(event);
  },
},
// ...
// Inside the audit-publisher init block (after AuditPublisher.connect):
dispositionAuditHolder.publisher = publisher;
```

The deps object is built before the AuditPublisher connects; while the holder is empty, `publish` is a no-op. Once NATS is reachable, the holder is populated and disposition events flow onto the same audit stream as `capability.minted` / `task.admitted` / etc. Best-effort contract: a NATS outage does NOT block the JWT mint.

### Revocation path verified

Test: `mintCapabilityForTask` with `loadDispositionOverlay: () => Promise.resolve(null)` → mint succeeds with un-narrowed claims, no rejections, no audit events emitted, no annotation patch issued. `kubectl delete configmap researcher-01-disposition` causes the next `loadDispositionOverlayForAgent` call to return `null` (no overlays in the namespace match the agentRef join key) → narrowing is skipped → next mint produces the un-narrowed JWT. Operator-driven revocation; no agent involvement.

### Annotation-writer pattern decision record

The operator is the **SOLE writer** of `kagent.knuteson.io/proposals-today` and `kagent.knuteson.io/proposals-today-day`. Workbench-api (plan 03) only **reads** them. No NATS consumer added to workbench-api. Rationale: keeps the projection an O(1) read on the same ConfigMap that already carries the spec; cleaner, fewer moving parts; rollover semantics are explicit (read-side day-mismatch resets to 0) rather than depending on NATS consumer position-tracking. The configmaps:patch RBAC granted in plan 01 task 3 is the prerequisite that makes this annotation-writer pattern possible.

## Decisions Made

- **D-DISP-02-A:** Insertion point — narrowing happens BETWEEN `resolveAgentClaims` and `narrowClaimsByParent`. Per-Agent narrowing (overlay) before child-of-parent narrowing (parent bundle).
- **D-DISP-02-B:** Fail-open at cap-issuer loader boundary; fail-closed at parser/schema-validate Job (deliberate split per Codex HIGH counter-stance — preserves revocation semantics while keeping malformed YAML out of the cluster).
- **D-DISP-02-C:** proposals-today is operator-written, workbench-api-read. No NATS consumer in workbench-api.
- **D-DISP-02-D:** Optimistic-concurrency CAS via JSON-Patch test+replace on `metadata.resourceVersion`; up to 3 retries on 409 conflict before logging warn and returning. Counter exactness sacrificed for system progress.
- **D-DISP-02-E:** Counter increment SKIPS when post-narrowing tools has NO proposal-category tool (avoids inflating proposalsToday with non-proposal mints).
- **D-DISP-02-F:** Subject convention for `disposition.proposal_rejected` events is `Agent/<ns>/<name>` (the overlay narrows an Agent's authority; AgentTask is recorded in `data.taskUid` for forensic correlation).

## Deviations from Plan

None. Plan executed exactly as written.

The plan's worked example for the `incrementProposalsToday` patch-body shape included a comment about needing to set `Content-Type` to `application/json-patch+json`. Investigation confirmed this is the K8s SDK 1.x **default** for `patchNamespacedConfigMap`, so no `setHeaderOptions` override was needed — the body is sent as JSON-Patch by default. (The merge-patch override is only needed when flipping AWAY from the JSON-Patch default, as in `job-annotator.ts`.) Documented in the source comment at `proposals-counter.ts:197-200`. This is consistent with the plan's intent, not a deviation.

## Issues Encountered

1. **Pre-commit lint enforcement caught two lint issues in Task 2 and Task 3** — both straightforward fixes (unused `V1ConfigMap` import after `as` cast removal, unsafe-`any` from `expect.objectContaining` mock-call match). Fixed in-place; tests re-run; commits succeeded on the second attempt. Resolution time: ~30 seconds each.

2. **The plan's grep acceptance criterion `grep -c "promote\|promotion" cap-issuer.ts` returns 1, not 0.** The pre-existing string `promote` at line 224 of `cap-issuer.ts` is in the doc comment for `narrowClaimsByParent` and describes glob pattern propagation, NOT disposition-related self-promotion. The plan's acceptance criterion explicitly says "if any pre-existing match, document in commit message" — done in Task 3's commit message. This is a documentation match, not a code match.

3. **No homelab cluster verification in this plan.** Plan 02 is a pure code change (no Helm chart updates, no new Job manifests, no new RBAC). The configmaps:patch RBAC was granted in plan 01; the schema-validate Job was deployed in plan 01. DISP-02 is exercised at runtime when the operator pod processes an AgentTask whose Agent has an attached disposition overlay — verifiable via the live `disposition.proposal_rejected` audit stream once a real overlay is deployed alongside an Agent. Cluster verification is out of scope for plan 02 (the orchestrator owns post-merge cluster validation if any).

## User Setup Required

None. Plan 02 is pure code; no external service configuration needed.

## Next Phase Readiness

DISP-03 (Wave 2 plan 03) is unblocked:

- The operator now writes `kagent.knuteson.io/proposals-today` + `kagent.knuteson.io/proposals-today-day` annotations on the disposition ConfigMap. workbench-api's dispositions projection can READ these annotations to compute `proposalsToday` (no NATS consumer needed).
- `disposition.proposal_rejected` audit events are flowing onto the audit stream — workbench-api's projection can OPTIONALLY tail this stream as a verification path (not required since the annotation is the source of truth).

DISP-04 (Wave 2 plan 04) is unblocked:

- The cap-issuer's narrowed mint output (`MintCapForTaskResult.dispositionRejections`, `claims.tools` post-narrowing) is observable in the substrate and can be surfaced in the Command Center disposition overlay alongside spentTokensToday and proposalsToday. The annotation-writer pattern means a single GET on the ConfigMap returns both the spec AND the current counters in one round-trip.

No blockers carried forward.

## Self-Check: PASSED

Verifying the SUMMARY's load-bearing claims:

- All 4 task commits exist in `git log` on the worktree branch:
  - `47d544d feat(phase-01-disp): add narrowByDispositionOverlay pure narrowing function (DISP-02)` — FOUND
  - `3442829 feat(phase-01-disp): add proposals-today annotation-writer helper (DISP-02 bridge to DISP-03)` — FOUND
  - `308de24 feat(phase-01-disp): wire AgentDisposition overlay narrowing into cap-issuer (DISP-02)` — FOUND
  - `967bc97 feat(phase-01-disp): wire AgentDisposition narrowing into reconciler mint path` — FOUND
- All 4 created files exist:
  - `packages/operator/src/disposition/narrow-by-overlay.ts` — FOUND
  - `packages/operator/src/disposition/narrow-by-overlay.test.ts` — FOUND
  - `packages/operator/src/disposition/proposals-counter.ts` — FOUND
  - `packages/operator/src/disposition/proposals-counter.test.ts` — FOUND
- All 5 modified files exist on disk and reflect the documented changes:
  - `packages/operator/src/cap-issuer.ts` — FOUND (with disposition imports, MintCapForTaskInput extensions, narrowing step in body)
  - `packages/operator/src/cap-issuer.test.ts` — FOUND (with 12 new disposition tests)
  - `packages/operator/src/reconcile.ts` — FOUND (with loadDispositionOverlayForAgent import + dispositionAuditPublisher dep + production wiring)
  - `packages/operator/src/reconcile.test.ts` — FOUND (with 4 new production-wiring tests)
  - `packages/operator/src/main.ts` — FOUND (with dispositionAuditHolder + audit-publisher init wiring)
- `pnpm --filter @kagent/operator test --run` exits 0 with **1286 / 1286** tests passing (verified at 15:48:51).
- `pnpm --filter @kagent/audit-events test --run` exits 0 with **54 / 54** tests passing.
- `pnpm --filter @kagent/dto test --run` exits 0 with **52 / 52** tests passing.
- `pnpm --filter @kagent/operator typecheck` exits 0 (no errors).
- No edits to STATE.md or ROADMAP.md (orchestrator owns those).
- No new admission webhook (`grep -rn "kind: ValidatingWebhookConfiguration\|kind: MutatingWebhookConfiguration" packages/operator/charts/`) — none added.
- No new CRD (`grep -rn "kind: CustomResourceDefinition" packages/operator/charts/`) — none added.
- No new persistence primitive — annotation writes on the existing ConfigMap carrier are NOT a new primitive; `configmaps:patch` RBAC was granted in plan 01 task 3.

---

_Phase: 01-agentdisposition-v0_
_Plan: 02_
_Completed: 2026-05-09_
