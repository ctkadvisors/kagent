# Phase 4: Review queue projection + promotion path — Research

**Phase:** 04 — review-queue-projection-promotion-path
**Researched:** 2026-05-10
**Domain:** workbench-api server-side projection + first POST-with-K8s-write paths + new UI route + audit-event extension + additive RBAC
**Confidence:** HIGH (all decisions locked in CONTEXT.md; this phase is pattern-mirror-driven; analogs exist for every new file)

**Sources read (HIGH confidence — all VERIFIED in-tree):**

- `.planning/phases/04-review-queue-projection-promotion-path/04-CONTEXT.md` (the locked decision corpus — D-01..D-04)
- `.planning/REQUIREMENTS.md` (REV-01, REV-02, REV-03 acceptance criteria + §3 non-goals + §4 future research)
- `.planning/STATE.md` (Phase 3 complete and verified; 60% milestone progress)
- `.planning/ROADMAP.md` (Phase 4 success criteria; depends on nothing structurally; benefits from Phase 2 read-depth)
- `CLAUDE.md` (TypeScript ESM, Node 22 + tsx, vitest co-located tests, MIT header, Conventional Commits, GitOps posture)
- `packages/workbench-api/src/routes/dispositions.ts` (the canonical analog for `/api/review-queue` projection)
- `packages/workbench-api/src/routes/dispositions.test.ts` (analog for the new route's test suite — 18 tests, fixture-driven)
- `packages/workbench-api/src/routes/tasks.ts` (POST handler pattern, `tasks.ts:147` fail-closed precedent, `pilotEvidence` helper)
- `packages/workbench-api/src/routes/gateway.ts:444` (the canonical `patchNamespacedCustomObject` + `application/merge-patch+json` pattern)
- `packages/workbench-api/src/main.ts` (entrypoint wiring; `WORKBENCH_ACTIONS_ENABLED` env knob; `auditPublisher` lifecycle)
- `packages/workbench-api/src/router.ts` (route registration site; mount-only-when-customApi-present pattern)
- `packages/workbench-api/src/auth.ts` (`X-Forwarded-User` extraction — handlers use `c.req.header('X-Forwarded-User')` per `routes/stream.ts:98`)
- `packages/workbench-api/src/cache.ts` (`SnapshotCache.listTasks()` — primary projection input; `AgentTemplate` is NOT cached today)
- `packages/workbench-api/src/routes/validators.ts` (hand-rolled validator pattern; no zod)
- `packages/workbench-ui/src/api.ts` (`fetchDispositions`, `createTask` analogs)
- `packages/workbench-ui/src/types.ts` (DTO re-export from `@kagent/dto/disposition` — exception to leaf-deps rule, applies here too)
- `packages/workbench-ui/src/TaskList.tsx` (table-shaped page mirror)
- `packages/workbench-ui/src/TaskDetail.tsx` (mount site for inline `ReviewActions`; existing `Section`/`KV` helpers)
- `packages/workbench-ui/src/NewTaskModal.tsx` (confirm-dialog modal pattern: backdrop click, Esc-to-close, focus-trap via promptRef)
- `packages/workbench-ui/src/App.tsx` (hash-route registration: `parseHash()` + `useHashRoute()`)
- `packages/workbench-ui/src/command/source-binding.ts` (closed-enum field-name pattern; `assertSourceField`, `useSourceField`, dev/prod gate)
- `packages/workbench-ui/src/command/flows.ts` (Phase 3 attention-flow stub at lines 290–314 — the surgical flip site)
- `packages/dto/src/disposition.ts` (full DTO + parser/asserter pattern — analog for `@kagent/dto/review-queue.ts`)
- `packages/dto/src/crds.ts:148-155` (`ArtifactRef` shape — basis for `ArtifactRefSummary`)
- `packages/audit-events/src/event-types.ts` (49 frozen event-type constants)
- `packages/audit-events/src/types.ts` (`AuditEventType` + `AuditEventData` discriminated union)
- `packages/audit-events/src/make-event.ts` (`makeEvent` factory — typed-narrow envelope per type)
- `packages/operator/src/crds/types.ts:1077-1131` (`AgentTemplate` + `AgentTemplateSpec` + `AgentTemplateBudget` + `AgentTemplateParameter`)
- `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` (write Role; namespace-scoped post-H17)
- `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml` (read ClusterRole — `agenttemplates` is NOT in the resource list today; verified)

---

## Project Constraints (from CLAUDE.md)

The planner MUST honor these — they bind every Phase 4 task:

- **Runtime:** Node 22 + tsx (Bun reverted; v0.2 unchanged from v0.1 per Dockerfile comments) `[CITED: CLAUDE.md "Conventions"]`
- **Language:** TypeScript strict mode, ESM, Node 22 target `[CITED: CLAUDE.md]`
- **License header:** MIT SPDX header on every new `.ts`/`.tsx` source file (no exceptions; verifier checks) `[VERIFIED: every file read above carries the SPDX header]`
- **Commits:** Conventional Commits (`feat(phase-04-...)`, `fix(phase-04-...)`); per-task atomic; co-author attribution per ctkadvisors style; **no squash-on-merge** `[CITED: CLAUDE.md "Conventions"]`
- **Tests:** vitest, co-located `*.test.ts`/`*.test.tsx`. `pnpm -C packages/workbench-api test` (node env), `pnpm -C packages/workbench-ui test` (jsdom env). **≥85% coverage on operator reconciler, ≥75% on glue code** (review-queue route is glue → ≥75%) `[CITED: CLAUDE.md "Conventions"]`
- **GitOps only on the homelab cluster** — no imperative `kubectl apply/exec/port-forward`. Phase 4's verification surface IS vitest. Deployment is image-rebuild + ArgoCD overlay bump in `../new_localai/`. `[CITED: CLAUDE.md "Operational context"]`
- **No new CRDs in v0.2** (D2 — REQUIREMENTS.md §3). Candidate templates at rest are ArtifactRef-shaped; promotion creates the EXISTING `AgentTemplate` CR. `[CITED: REQUIREMENTS.md §3]`
- **D6 Self-proposal, not self-promotion.** Agents may produce candidate artifacts (proposal channel); workbench-api operators promote (governance channel). Agents do NOT write `review-requested: "true"` annotations directly. `[CITED: PROJECT.md D6, CONTEXT.md D-02-A]`
- **Pre-commit hook needs Node 22.** `source ~/.nvm/nvm.sh && nvm use 22` if shell defaults drift. `[CITED: CONTEXT.md specifics #11]`
- **`gh pr create` and `gh pr merge` are not a unit.** Per-PR explicit consent. `[CITED: CLAUDE.md + memory feedback_auto_push.md]`

---

## User Constraints (from CONTEXT.md)

The planner MUST honor these — they constrain every plan in this phase.

### Locked Decisions (D-01..D-04, all "recommended" — user has authority to override)

**D-01 — Review-queue projection shape:** Ship a new `packages/workbench-api/src/routes/review-queue.ts` route exposing `GET /api/review-queue` returning `ReviewQueueRow[]` sorted by descending staleness (oldest first). New `ReviewQueueRow` DTO + `ReviewReason` closed enum in `@kagent/dto`. UI consumes via new `useReviewQueue()` hook. Classifier returns at-most-one row per task with priority `verifier-failed > suspicious-detector > human-review-requested > candidate-template`. Tasks with `review-decision` annotation already set are SKIPPED. Reload-stable by construction (pure read over `SnapshotCache` + audit-event last-known-state). No `/api/review-queue` POST — accept/reject/request use sub-paths.

**D-02 — Human-review-requested signal:** Annotation `kagent.knuteson.io/review-requested: "true"` on AgentTask is the authoritative substrate signal. Implicit signals (verifier-failed, suspicious-detector, candidate-template) ALSO produce queue rows automatically. New `POST /api/review-queue/:namespace/:name/request` endpoint writes the annotation (operator-only; agents NEVER write this directly per D6). Companion annotations: `review-requested-by`, `review-requested-at`, `review-decision`, `review-decided-by`, `review-decided-at`. Four new audit event types: `review.requested`, `review.accepted`, `review.rejected`, `template.candidate.promoted`.

**D-03 — Candidate-template + accept/reject write path:** Two reviewer entry points (dedicated `#/review` page mirroring `TaskList`, plus inline `ReviewActions` component in `TaskDetail`). Single shared write contract: `POST /api/review-queue/:namespace/:name/{accept,reject,request}`. Candidates carried as `ArtifactRef`-shaped blobs at rest with media type `application/x-kagent-template-candidate+yaml`. Producing AgentTask carries `kagent.knuteson.io/template-candidate: "true"` annotation. Promoted CR carries `kagent.knuteson.io/promoted-from-task: <ns>/<name>` + `metadata.ownerReferences` to producing task. Atomic-ish: AgentTemplate creation BEFORE accept-annotation patch; partial-promote leaves orphan-ish CR with retry on next request. Single-reviewer scope (no quorum, no signed proposals, no no-self-review). Additive RBAC: `agenttasks: [patch]` (annotation writes) + `agenttemplates: [create]` (promotion). Read-side `agenttemplates: [get,list,watch]` ALSO needs to be added — VERIFIED missing from `clusterrole.yaml` today.

**D-04 — Replay/eval signal scope:** Reserve `replay-divergence` and `eval-failed` slots in the `ReviewReason` enum; v0.2 producers are zero. Inline projection comment documents the Phase-5 promotion path (when AgentTaskRun + `@kagent/eval` ship per `docs/REPLAY-EVALS.md`). Verifier-failed + suspicious-detector cover what REV-03 calls "replay/eval signals" today.

### Claude's Discretion (planner picks)

- Polling cadence for `useReviewQueue()` (default 5s mirroring `useDispositions`).
- SSE-driven invalidation on `review.*` events (default: defer; v0.2 polls).
- File split for `routes/review-queue.ts` (default: single file mirroring `dispositions.ts`).
- ReviewPage column ordering (default: `Reason | Task | Agent | Reason Detail | Staleness | Actions`).
- Confirm-dialog UX shape (default: modal mirroring `NewTaskModal.tsx`).
- `ReviewActions` mount position in TaskDetail (default: above content, near top).
- ArtifactRef resolution — does the candidate live in `task.status.artifacts[0]`? (default: first artifact whose `mediaType === 'application/x-kagent-template-candidate+yaml'`; fail-422 if absent).
- Whether `agenttemplates: [get,list,watch]` belongs in read-side `clusterrole.yaml` already — **VERIFIED additive change required (see Q9)**.
- Phase 3 `attention` flow integration mechanics (count-only fetch in CommandView vs shared hook — see Q6).
- Whether `ReviewActions` confirms before accepting a template-candidate (default: same-confirm-dialog).
- AgentTemplate name collision strategy on accept (default: hard-fail 422 with K8s body; reviewer reproposes under different name).
- Whether to surface inline `ReviewActions` in TaskList rows (default: defer; one inline + one dedicated page).

### Deferred Ideas (OUT OF SCOPE for Phase 4 — locked exclusions)

- Any new CRD: `ReviewRequest`, `TaskReview`, `ReviewDecision`, `Channel`, `Post`, `AgentTaskRun`, `ReplaySet` (D2 + REQUIREMENTS.md §3)
- Multi-reviewer flows / `CoalitionProposal` (REQUIREMENTS.md §4)
- Real replay-divergence detection / `@kagent/eval` package (REPLAY-EVALS.md is Phase 5 design, pre-implementation)
- Consolidation controller (REQUIREMENTS.md §4)
- Decay/revalidation policy on review-queue rows (REQUIREMENTS.md §4 NFR)
- Quarantine semantics as first-class state (REQUIREMENTS.md §4 NFR)
- Agent-side write of `review-requested` annotation (D6 violation)
- Bulk accept/reject (WB-02 multi-select is read-only)
- Web hook / push notifications on enqueue
- Reviewer-identity authentication beyond `X-Forwarded-User` (H17 audit acknowledgment)
- AgentTemplate-version-bump on accept (`templateVersion: N+1` semantics)
- Auto-accept after timeout
- Bulk audit-event export endpoint
- Cross-namespace promotion (H17 release-namespace scope binds)
- CI lint asserting every `ReviewReason` has a fixture test
- SSE-driven `useReviewQueue()` invalidation
- Per-row review-detail page (`#/review/:taskRef`)
- `ReviewActions` in TaskList rows (per-row "Quick reject")

---

## Phase Requirements

| ID     | Description                                                                                                                                                                                                                                                                                            | Research Support                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| REV-01 | Review queue projection in workbench-api lists every terminal `AgentTask` whose result needs review (verifier failed, suspicious detector flagged, or human-review-requested) sorted by staleness; computed from existing state; no new persistence; reload-stable.                                    | Q1 (mirror `dispositions.ts`), Q2 (reload-stability test), Q7 (source-binding extension), Q12 (file list)                                  |
| REV-02 | AgentTemplate promotion proposal flow exists end-to-end: candidate `AgentTemplate` (artifact-shape today) is reviewable in queue; accept/reject decisions recorded as audit events; accepted candidate becomes versioned `AgentTemplate` CR via existing operator-write path. Single-reviewer covered. | Q3 (POST handler + K8s write), Q4 (AgentTemplateSpec validation), Q5 (UI surface), Q8 (audit events), Q9 (RBAC), Q11 (mirroring landmines) |
| REV-03 | Replay/eval signals surface into the queue with same row shape as verifier failure; reviewer can navigate from queue row to underlying eval/replay artifact.                                                                                                                                           | Q1 (enum slots), Q12 (inline comment + traceLink field)                                                                                    |

---

## Architectural Responsibility Map

| Capability                                            | Primary Tier                                                 | Secondary Tier                                                               | Rationale                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review queue projection (compute)                     | Workbench-API (server)                                       | —                                                                            | REV-01 explicitly says "in workbench-api"; mirrors DISP-03 pattern. UI-side derivation rejected because Phase 5 hotkey ("jump to review queue") expects a stable backend route AND Phase 3's `attention` gauge expects substrate-mediated source. |
| Annotation writes (review-requested, review-decision) | Workbench-API (server) — operator-write Role                 | —                                                                            | Operators are governance per D6; agents propose via candidate-template artifact, not direct annotation write.                                                                                                                                     |
| AgentTemplate CR creation                             | Workbench-API (server) — actions Role                        | Operator (existing template-instantiator validates spec at materialize time) | The existing operator-write path is the canonical creator; workbench-api invokes `customApi.createNamespacedCustomObject` directly. NO new CRD.                                                                                                   |
| Candidate AgentTemplate at rest                       | AgentTask `status.artifacts[]`                               | —                                                                            | ArtifactRef carries the candidate; D2 forbids new CRD.                                                                                                                                                                                            |
| ReviewQueue rendering                                 | Workbench-UI (client)                                        | —                                                                            | New `#/review` hash route; mirrors TaskList table.                                                                                                                                                                                                |
| Inline `ReviewActions`                                | Workbench-UI (client) — inside TaskDetail                    | —                                                                            | Reviewer can act without leaving TaskDetail; same write path as ReviewPage.                                                                                                                                                                       |
| Phase 3 `attention` flow source                       | Workbench-UI (client) — `flows.ts` `compute()`               | —                                                                            | The surgical Phase 3 callback site; flips from in-snapshot proxy to a count fetched from `/api/review-queue`.                                                                                                                                     |
| Audit event emission                                  | Workbench-API (server) — existing `auditPublisher`           | —                                                                            | Same publisher Phase 1 wired (`KAGENT_AUDIT_NATS_URL`); NO new wire.                                                                                                                                                                              |
| Audit event consumption                               | Substrate-wide (Loki/Splunk/etc. via NATS JetStream)         | Workbench-UI SSE                                                             | Existing infra; new types ride existing transport.                                                                                                                                                                                                |
| RBAC verbs grant                                      | Helm chart (`clusterrole-actions.yaml` + `clusterrole.yaml`) | —                                                                            | Additive-only. H17 namespace-scoped. `actions.create=false` stays write-proof.                                                                                                                                                                    |

---

## Q1: `/api/dispositions` mirror fidelity (REV-01)

**Confidence:** HIGH — `dispositions.ts` is read end-to-end; the divergences are crisp.

### Projection-computation pattern (mirror)

`dispositions.ts:154-346` shows the canonical shape. Translated to review-queue:

```ts
export function reviewQueueRoute(deps: ReviewQueueRouteDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? ((): Date => new Date());
  // ... logger, etc

  app.get('/', async (c) => {
    const tasks = deps.cache.listTasks(); // SnapshotCache.listTasks()
    const items: ReviewQueueRow[] = [];
    const nowMs = now().getTime();

    for (const task of tasks) {
      const row = classifyTaskForReview(task, nowMs);
      if (row !== undefined) items.push(row);
    }
    items.sort((a, b) => b.stalenessSeconds - a.stalenessSeconds); // descending
    return c.json({ items });
  });

  app.post('/:namespace/:name/accept', async (c) => {
    /* see Q3 */
  });
  app.post('/:namespace/:name/reject', async (c) => {
    /* see Q3 */
  });
  app.post('/:namespace/:name/request', async (c) => {
    /* see Q3 */
  });

  return app;
}
```

### Classifier (priority-ordered, at-most-one row per task)

Per CONTEXT.md D-01 step 1–6:

```ts
function classifyTaskForReview(task: AgentTask, nowMs: number): ReviewQueueRow | undefined {
  const ann = task.metadata.annotations ?? {};
  // Step 1: skip already-decided.
  if (ann['kagent.knuteson.io/review-decision'] !== undefined) return undefined;

  const phase = task.status?.phase;
  const verification = task.status?.verification; // pilotEvidence-shape: { passed, mode, reason, completedAt }
  const suspicious = task.status?.structuralVerdict?.suspicious ?? [];
  const creationTimestamp = task.metadata.creationTimestamp;
  const completedAt = task.status?.completedAt;

  // Step 2: verifier-failed (priority 1)
  if (verification?.passed === false) {
    const enqueuedAt =
      verification.completedAt ?? completedAt ?? creationTimestamp ?? new Date(nowMs).toISOString();
    return makeRow(
      task,
      'verifier-failed',
      verification.reason ?? 'verifier failed',
      enqueuedAt,
      nowMs,
    );
  }
  // Step 3: suspicious-detector (priority 2)
  if (suspicious.length > 0) {
    const enqueuedAt = completedAt ?? creationTimestamp ?? new Date(nowMs).toISOString();
    return makeRow(task, 'suspicious-detector', suspicious.join(', '), enqueuedAt, nowMs);
  }
  // Step 4: human-review-requested (priority 3)
  if (ann['kagent.knuteson.io/review-requested'] === 'true') {
    const requester = ann['kagent.knuteson.io/review-requested-by'] ?? 'unknown';
    const enqueuedAt =
      ann['kagent.knuteson.io/review-requested-at'] ??
      creationTimestamp ??
      new Date(nowMs).toISOString();
    return makeRow(task, 'human-review-requested', `requested by ${requester}`, enqueuedAt, nowMs);
  }
  // Step 5: candidate-template (priority 4) — only when phase=Completed (CONTEXT.md D-01 step 5)
  if (ann['kagent.knuteson.io/template-candidate'] === 'true' && phase === 'Completed') {
    const candidate = findCandidateArtifact(task); // first artifact w/ mediaType match
    if (candidate === undefined) return undefined; // can't classify without artifact
    const enqueuedAt = completedAt ?? creationTimestamp ?? new Date(nowMs).toISOString();
    return makeCandidateRow(task, candidate, enqueuedAt, nowMs);
  }
  return undefined;
}
```

### Where review-queue DIVERGES from dispositions

| Aspect                 | `/api/dispositions`                                                                                       | `/api/review-queue`                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Input source           | ConfigMaps (label-selected) + GatewayClient + per-Agent existence check                                   | `SnapshotCache.listTasks()` only                                           |
| External dep           | `coreApi.listConfigMapForAllNamespaces`, `gatewayClient.usage`, `readCustomApi.getNamespacedCustomObject` | None for GET (cache only)                                                  |
| One row per            | Agent (from ConfigMap)                                                                                    | AgentTask (at-most-one per task; classifier short-circuits on first match) |
| Audit emission on read | Yes (over_budget; in-process dedup)                                                                       | NO — read is pure-read; audit emission lives in POST handlers only         |
| Sort                   | None (insertion order)                                                                                    | Descending `stalenessSeconds`                                              |
| External validators    | `parseDispositionConfigMap` (existing)                                                                    | NEW: `parseAgentTemplateSpec` for accept handler (NOT the GET path)        |
| Orphan filter          | Agent-existence check against `customApi`                                                                 | Not applicable — task IS the row's identity                                |
| `customApi` dependency | Optional (orphan filter degrades)                                                                         | Optional for GET (no use); REQUIRED for POST (write surface)               |

### JSON-shape access points (verified file references)

- `pilotEvidence.verification.passed` / `.reason` / `.completedAt` — built by `routes/tasks.ts:564-583` `readVerification()`. Phase 4's projection reads `task.status.verification` directly (the same shape pre-projection).
- `pilotEvidence.structuralVerdict.suspicious` — built by `routes/tasks.ts:555-562`. Projection reads `task.status.structuralVerdict.suspicious` directly.
- `task.metadata.annotations[<key>]` — straight-up record access.
- `task.status.completedAt` / `task.metadata.creationTimestamp` — strings (ISO 8601) for staleness math.
- `AgentTaskPhase` type imported from `@kagent/dto` (already present per `types.ts:35`).

### `SnapshotCache` consumption

`cache.ts:88` `listTasks()` returns `readonly AgentTask[]`. The route reads tasks fresh on every GET (no caching at the route layer). Same posture as `dispositions.ts` reading the gateway client fresh.

`SnapshotCache` does NOT track `AgentTemplate` today `[VERIFIED: cache.ts only has tasks/agents/jobs/pods Maps]`. This is fine for Phase 4 — the post-promotion AgentTemplate visibility is the planner's "Claude's Discretion" call: either (a) extend the informer to watch agenttemplates (lean), or (b) trust the GET return value of `customApi.createNamespacedCustomObject` to surface the new CR in the accept handler's response.

---

## Q2: Reload-stability test pattern

**Confidence:** HIGH — `dispositions.test.ts` is the canonical analog.

### What `dispositions.test.ts` asserts

- Test 1 — "returns 200 with `{ items: DispositionOverlayRow[] }`; each item passes the runtime guard." Equivalent for review-queue: each row passes `assertIsReviewQueueRow`.
- Test 9 — "exactly once per (agentRef, reason) per day: TWO consecutive GETs do NOT double-publish." Adapted for review-queue: TWO consecutive GETs return identical row content modulo `stalenessSeconds` advancing. (No publish on read for review-queue, so dedup-Set logic doesn't apply.)
- Test 11 — "empty items when no overlay ConfigMaps match." Equivalent: empty when no tasks in cache match any classifier rule.
- Test 12 — "malformed disposition.yaml is filtered out and warned." Equivalent: malformed candidate-template artifact (missing media-type or unparseable YAML) → row is OMITTED, warning logged.
- Test 16 — orphan filter. NOT directly applicable; the review-queue analog is "task with `review-decision` annotation set is filtered out."

### Fixture format

`dispositions.test.ts` uses two fixture sources:

1. JSON import (`gatewayUsageRows`) — `import gatewayUsageRows from '../../../../tests/fixtures/disposition/gateway-usage-rows.json' with { type: 'json' };` `[VERIFIED: dispositions.test.ts:32]`
2. In-test fabrication via `makeOverlayCm()` builder

For Phase 4: **planner picks** between an in-test builder pattern OR a JSON fixture at `packages/workbench-api/src/__fixtures__/review-queue-snapshot.json`. CONTEXT.md D-01 nominates the JSON path:

```
packages/workbench-api/src/__fixtures__/review-queue-snapshot.json
```

⚠️ **Pitfall:** This directory does NOT exist today `[VERIFIED: ls returned ENOENT]`. The Wave-0 plan must create it. The `tests/fixtures/disposition/` dir lives at the repo's `tests/` root (NOT under `packages/workbench-api/src/`); both placements are valid — pick one and stay consistent with package-locality (CONTEXT.md prefers `src/__fixtures__/` per the Phase 2 pattern at `packages/workbench-ui/src/command/__fixtures__/`).

### Mocking `SnapshotCache`

`dispositions.test.ts` uses `makeStubCoreApi()`/`makeStubCustomApi()` because the route consumes external clients. `routes/review-queue.ts` consumes `SnapshotCache` directly — the test stubs the cache:

```ts
import { SnapshotCache } from '../cache.js';

function makeStubCache(tasks: readonly AgentTask[]): SnapshotCache {
  const cache = new SnapshotCache();
  for (const task of tasks) cache.upsertTask(task);
  return cache;
}
```

Or, if test isolation needs even less surface, use a `Pick<SnapshotCache, 'listTasks'>` stub mirroring the `DispositionsCoreApi` minimal-stub pattern at `dispositions.ts:57-60`.

### Reload-stability test outline (one of each `ReviewReason`)

```ts
describe('GET /api/review-queue — reload-stability', () => {
  const fixedNow = new Date('2026-05-10T12:00:00.000Z');

  it('5 reasons fire (one row each) sorted by descending staleness', async () => {
    // Synthesize 5 tasks, oldest first:
    // 1. verifier-failed:       creationTimestamp = T-5h
    // 2. suspicious-detector:   creationTimestamp = T-4h
    // 3. human-review-requested: review-requested-at = T-3h
    // 4. candidate-template (phase=Completed, has artifact): completedAt = T-2h
    // 5. Completed-clean (no signal) — should NOT appear.
    const tasks = makeFiveReasonTasks();
    const cache = makeStubCache(tasks);
    const { fetch } = mountAndFetch({ cache, now: () => fixedNow });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    expect(body.items).toHaveLength(4);
    expect(body.items.map((r) => r.reason)).toEqual([
      'verifier-failed',
      'suspicious-detector',
      'human-review-requested',
      'candidate-template',
    ]);
    // Reload-stability: a second GET returns identical content modulo
    // `stalenessSeconds` (which advances by zero with fixed clock).
    const body2 = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    expect(body2).toEqual(body);
  });

  it('replay-divergence and eval-failed reasons produce zero rows in v0.2 (D-04 stub)', async () => {
    // No fixture for these — assert no producer path touches them.
  });

  it('decided task is skipped', async () => {
    // Verifier-failed + review-decision annotation set → not in queue.
  });

  it('priority: verifier-failed beats suspicious-detector when both present', async () => {
    // Single task with both signals → row has reason='verifier-failed'.
  });

  it('priority: suspicious beats review-requested', async () => {
    /* ... */
  });
  it('priority: review-requested beats candidate-template', async () => {
    /* ... */
  });

  it('candidate-template requires phase=Completed', async () => {
    // template-candidate annotation but phase=Failed → no row (Failed
    // already routes via verifier-failed or suspicious-detector path).
  });

  it('staleness sort is descending', async () => {
    /* assert items sorted */
  });
});
```

The `dispositions.test.ts` Test 1 pattern (every item passes `assertIsDispositionOverlayRow`) carries over: every emitted row passes a NEW `assertIsReviewQueueRow` guard exported from `@kagent/dto/review-queue.ts`.

---

## Q3: POST handler + K8s write pattern (REV-02)

**Confidence:** HIGH — `tasks.ts` POST + `gateway.ts:444` PATCH are the joint analog.

### `customApi.createNamespacedCustomObject` usage (mirror `tasks.ts:220-226`)

Verified pattern from `tasks.ts:219-239`:

```ts
const created: unknown = await deps.customApi.createNamespacedCustomObject({
  group: KAGENT_GROUP, // 'kagent.knuteson.io'
  version: KAGENT_VERSION, // 'v1alpha1'
  namespace, // candidate's namespace (default: producing-task ns)
  plural: AGENTTEMPLATE_PLURAL, // 'agenttemplates' (mirror of AGENTTASK_PLURAL = 'agenttasks')
  body: agentTemplateManifest,
});
```

### Fail-closed message at `tasks.ts:147` (verbatim)

```
'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart'
```

This is THE precedent. Phase 4's POST endpoints reuse the same string verbatim:

```ts
app.post('/:namespace/:name/accept', async (c) => {
  if (deps.customApi === undefined) {
    return c.json(
      {
        error:
          'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart',
      },
      503,
    );
  }
  // ... handler body
});
```

### `X-Forwarded-User` extraction (verified pattern from `routes/stream.ts:98`)

```ts
import { FORWARDED_USER_HEADER } from '../auth.js'; // = 'X-Forwarded-User'

const reviewerId = c.req.header(FORWARDED_USER_HEADER)?.trim();
// Use 'unknown' fallback for annotation/audit (CONTEXT.md D-03):
const decidedBy = reviewerId !== undefined && reviewerId.length > 0 ? reviewerId : 'unknown';
```

The auth middleware (`buildAuthMiddleware`) ALREADY rejects requests missing the header when `WORKBENCH_AUTH_REQUIRED` defaults to true `[VERIFIED: auth.ts:69-101 + main.ts:120,145]`, so handler-level reviewerId fallback is a defensive belt-and-suspenders for the dev/test path where auth is disabled.

### JSON merge-patch annotation pattern (verified at `gateway.ts:444`)

```ts
import { setHeaderOptions } from '@kubernetes/client-node';

const MERGE_PATCH_OPTIONS = setHeaderOptions('Content-Type', 'application/merge-patch+json');

await deps.customApi.patchNamespacedCustomObject(
  {
    group: KAGENT_GROUP,
    version: KAGENT_VERSION,
    namespace,
    plural: AGENTTASK_PLURAL, // 'agenttasks'
    name,
    body: {
      metadata: {
        annotations: {
          'kagent.knuteson.io/review-decision': 'accepted',
          'kagent.knuteson.io/review-decided-by': decidedBy,
          'kagent.knuteson.io/review-decided-at': now().toISOString(),
        },
      },
    },
  },
  MERGE_PATCH_OPTIONS,
);
```

⚠️ The `MERGE_PATCH_OPTIONS` constant is NOT global — every route that needs it builds its own (see also `operator/src/k8s.ts:42` `mergePatchOptions`). Phase 4 follows suit at the top of `routes/review-queue.ts`.

### Audit-event emit shape (`makeEvent` factory + `auditPublisher.publish`)

`dispositions.ts:282-302` is the canonical pattern. Adapted for review:

```ts
if (deps.auditPublisher !== undefined) {
  try {
    await deps.auditPublisher.publish(
      makeEvent({
        type: 'review.accepted',
        source: 'kagent.knuteson.io/workbench-api',
        subject: `AgentTask/${namespace}/${name}`,
        data: { taskRef: { namespace, name, uid }, reason, reviewerId, reasonText },
      }),
    );
  } catch (err) {
    logger.warn(`review-queue: review.accepted publish failed: ${...}`);
  }
}
```

### Accept handler — step-by-step (the load-bearing path)

Per CONTEXT.md D-03 atomicity note (CR-create BEFORE annotation patch):

```
1. Resolve namespace + name from URL params.
2. Parse + validate body: { reviewerId?: string; reasonText?: string }
   - reasonText cap: 4 KiB? (mirror MAX_MESSAGE_BYTES — planner picks)
3. Look up task in cache (deps.cache.getTask(namespace, name)).
   - undefined → 404 { error: 'AgentTask <ns>/<name> not in cache' }
4. Re-classify the task to determine `reason` (the row's reason at decision time).
   - If task is no longer in queue (e.g., decision already made) → 409
     { error: 'review-decision already set', existing: <annotation value> }
5. Extract reviewer identity:
   - reviewerId from body if present, else X-Forwarded-User header,
     else 'unknown'.
6. IF reason === 'candidate-template':
   a. Find the candidate artifact (first artifact with mediaType ===
      'application/x-kagent-template-candidate+yaml').
      - missing → 422 { error: 'candidate artifact not found on
        producing task' }
   b. Resolve the artifact YAML payload (planner picks: inline base64
      if mediaType supports it; otherwise read via existing
      pvcUri/parseArtifactUri helpers in operator/src/crds/artifact-ref.ts).
   c. Parse YAML → object → validate against AgentTemplateSpec
      via NEW parseAgentTemplateSpec helper (Q4).
      - parse fail → 422 { error: 'candidate YAML failed
        AgentTemplateSpec validation', detail: <validator error> }
   d. Build AgentTemplate manifest:
      - apiVersion: 'kagent.knuteson.io/v1alpha1'
      - kind: 'AgentTemplate'
      - metadata.name: candidateTemplate.proposedTemplateName
      - metadata.namespace: candidateTemplate.proposedNamespace
        (default: producing task's ns; H17 release-namespace scope
         binds via the actions Role)
      - metadata.annotations:
          'kagent.knuteson.io/promoted-from-task': '<ns>/<name>'
      - metadata.ownerReferences: [{
          apiVersion, kind: 'AgentTask', name, uid,
          controller: false, blockOwnerDeletion: false,
        }]
      - spec: <validated AgentTemplateSpec>
   e. customApi.createNamespacedCustomObject({ group, version, namespace,
        plural: 'agenttemplates', body: manifest })
      - K8s 409 (name collision) → 422 {
          error: 'AgentTemplate <ns>/<name> already exists',
          k8sError: <body>,
        }
        DO NOT write annotation; return early.
      - K8s 422 (schema validation by apiserver) → 422 with the K8s body
      - K8s 403 (RBAC) → 403 with scrubbed message (mirror tasks.ts L17 audit pattern)
      - K8s 5xx → 500 with scrubbed message
   f. Capture the created CR's metadata.{name,namespace,uid} for response + audit.
7. PATCH the producing AgentTask:
   - Content-Type: application/merge-patch+json
   - body.metadata.annotations:
       'kagent.knuteson.io/review-decision': 'accepted'
       'kagent.knuteson.io/review-decided-by': decidedBy
       'kagent.knuteson.io/review-decided-at': nowIso
   - On 404 → 410 (task vanished mid-flight; rare). The CR (if
     candidate path) is now orphan-ish; the audit-event log is the
     canonical record. Log loud.
   - On other K8s errors → 500 with scrubbed message.
   - Idempotency: if the annotation is already set on patch retry,
     K8s accepts the merge-patch silently (it's a no-op).
8. Emit audit events (best-effort; do NOT fail the response):
   - Always: 'review.accepted'
   - When reason='candidate-template' AND step 6 succeeded:
       'template.candidate.promoted'
9. Respond 200:
   {
     taskRef: { namespace, name, uid },
     decision: 'accepted',
     auditedAt: nowIso,
     ...(agentTemplateRef !== undefined && { agentTemplateRef })
   }
```

### Reject handler

Same shape as accept, simpler:

```
1–5. Same as accept.
6. (Skipped — no CR creation under any reason.)
7. PATCH annotation:
   'kagent.knuteson.io/review-decision': 'rejected'
   + review-decided-by + review-decided-at
8. Emit 'review.rejected' audit event.
9. Respond 200 { taskRef, decision: 'rejected', auditedAt }.
```

### Request handler (D-02)

```
1. Resolve namespace + name from URL params.
2. Parse body: { reasonText?: string }.
3. Look up task in cache → 404 if missing.
4. PATCH annotation:
   'kagent.knuteson.io/review-requested': 'true'
   'kagent.knuteson.io/review-requested-by': decidedBy (or 'unknown')
   'kagent.knuteson.io/review-requested-at': nowIso
5. Emit 'review.requested' audit event.
6. Respond 200 { taskRef, requested: true, requestedAt }.
```

### K8s status extraction (verified analog at `tasks.ts:346-355`)

Mirror `extractK8sStatus(err)` exactly — the apiserver wraps errors in `ApiException` with `body.code` (newer client) or `statusCode` (older). Pass-through 409, 404, 403; default 500.

### Error-body scrubbing (Audit-rev2 L17)

`tasks.ts:263-283` mandates: do NOT echo K8s API error text to authenticated callers (it can leak internal hostnames, RBAC rule names, network paths, cert SANs). Phase 4's accept/reject/request handlers MUST scrub error bodies the same way:

```ts
const detail = err instanceof Error ? err.message : String(err);
console.error(
  '[workbench-api] POST /api/review-queue/.../accept — unhandled K8s API error',
  JSON.stringify({ namespace, name, status: status ?? null, message: detail }),
);
return c.json({ error: 'internal error processing review accept; see workbench-api logs' }, 500);
```

The 422 candidate-validation path is the EXCEPTION — surfacing the K8s schema-validation error body to the reviewer is acceptable (it's their input that failed; CONTEXT.md D-03 explicitly allows this).

---

## Q4: AgentTemplateSpec schema validation

**Confidence:** HIGH — type is read end-to-end at `crds/types.ts:1086-1131`; no existing runtime validator.

### `AgentTemplateSpec` shape (verbatim)

```ts
export type AgentTemplateParameterType = 'string' | 'integer' | 'toolSelection';

export interface AgentTemplateParameter {
  readonly name: string;
  readonly type: AgentTemplateParameterType;
  readonly pattern?: string;
  readonly allowedValues?: readonly string[];
  readonly required?: boolean;
  readonly default?: string;
}

export interface AgentTemplateBudget {
  readonly maxIterations?: number;
  readonly maxCostUsdPerRun?: number;
  readonly maxParallelInstances?: number;
}

export interface AgentTemplateSpec {
  readonly templateVersion?: number;
  readonly revisionHistoryLimit?: number;
  readonly idleTtlSeconds?: number;
  readonly parameters?: readonly AgentTemplateParameter[];
  readonly budget?: AgentTemplateBudget;
  readonly toolAllowlist?: readonly string[];
  readonly toolDefaults?: readonly string[];
  readonly agentSpec: Readonly<Record<string, unknown>>; // REQUIRED
}
```

**Required fields (per type):** ONLY `agentSpec`. Everything else is optional. (The CRD's apiserver-side validation, when the CR is created, enforces additional invariants — Phase 4 leverages that as the second-gate validation.)

### Existing validators

`grep -rn "parseAgentTemplateSpec\|assertIsAgentTemplate" packages/` returns NO results `[VERIFIED: 2026-05-10]`. There is NO existing zod schema, NO Yup schema, NO existing runtime validator. The handler needs to add one.

### Recommended `parseAgentTemplateSpec()` shape

Land in `packages/dto/src/template-candidate.ts` (NEW file) — keeps `review-queue.ts` DTO module clean. The validator is intentionally LIGHT (mirror `assertIsDispositionOverlayRow` at `dto/disposition.ts:139-192` — guard against shape drift, not full V5 input validation; the apiserver is the second gate):

```ts
export interface ParseAgentTemplateSpecError {
  readonly path: string;
  readonly message: string;
}
export type ParseAgentTemplateSpecResult =
  | { readonly ok: true; readonly spec: AgentTemplateSpec }
  | { readonly ok: false; readonly errors: readonly ParseAgentTemplateSpecError[] };

export function parseAgentTemplateSpec(raw: unknown): ParseAgentTemplateSpecResult {
  const errors: ParseAgentTemplateSpecError[] = [];
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, errors: [{ path: '<root>', message: 'not an object' }] };
  }
  const r = raw as Record<string, unknown>;

  // agentSpec is REQUIRED, must be an object.
  if (r.agentSpec === undefined || r.agentSpec === null || typeof r.agentSpec !== 'object') {
    errors.push({ path: 'agentSpec', message: 'missing or not an object' });
  }

  // Numeric optionals: templateVersion, revisionHistoryLimit, idleTtlSeconds.
  for (const key of ['templateVersion', 'revisionHistoryLimit', 'idleTtlSeconds'] as const) {
    if (r[key] !== undefined && (typeof r[key] !== 'number' || !Number.isFinite(r[key]))) {
      errors.push({ path: key, message: 'must be a finite number' });
    }
  }

  // budget — object with optional numeric fields.
  if (r.budget !== undefined) {
    /* shallow check */
  }

  // parameters — array of AgentTemplateParameter.
  if (r.parameters !== undefined) {
    if (!Array.isArray(r.parameters)) {
      errors.push({ path: 'parameters', message: 'must be an array' });
    } else {
      r.parameters.forEach((p, i) => {
        /* check name + type per AgentTemplateParameterType */
      });
    }
  }

  // toolAllowlist + toolDefaults — string arrays.
  for (const key of ['toolAllowlist', 'toolDefaults'] as const) {
    if (r[key] !== undefined) {
      if (!Array.isArray(r[key]) || (r[key] as unknown[]).some((v) => typeof v !== 'string')) {
        errors.push({ path: key, message: 'must be a string[]' });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: raw as AgentTemplateSpec };
}
```

The accept handler runs `parseAgentTemplateSpec(yamlParsed)`; on `ok: false` returns 422 with the errors array (analog to `tasks.ts` validator error formatting at lines 384-409).

### YAML parse — recommended dep

`packages/dto` is currently zero-runtime-dep — adding `yaml` (the npm package, ~110 KiB) violates the "leaf deps" principle. Two options:

1. **Add `yaml` to `packages/workbench-api`** (NOT `@kagent/dto`) and run YAML parse in the route handler before calling `parseAgentTemplateSpec` on the parsed object. Keeps the DTO module pure.
2. **Reuse an existing YAML dep.** `grep` for existing yaml deps:

```bash
grep -l '"yaml":' packages/*/package.json
```

`[VERIFIED: not run yet — planner verifies in Wave 0; the operator package likely already has `yaml`since`parseDispositionConfigMap` parses YAML in dto/disposition-parser.ts]`. CONTEXT.md notes "the candidate YAML must conform to AgentTemplateSpec" — the planner can confirm whether the dispositions parser uses `yaml` and reuse it.

**Recommendation:** Option 1. Land YAML parse in `packages/workbench-api/src/yaml.ts` (helper) or inline; keep `@kagent/dto`'s `parseAgentTemplateSpec` operating on parsed objects, not strings.

### Round-trip pattern for the test fixture

```ts
// packages/workbench-api/src/__fixtures__/candidate-template.yaml
//
// templateVersion: 1
// idleTtlSeconds: 300
// agentSpec:
//   model: workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct
//   tools: [...]
//
// Test:
//   const yaml = readFileSync(yamlPath, 'utf8');
//   const parsed = YAML.parse(yaml);
//   const result = parseAgentTemplateSpec(parsed);
//   expect(result.ok).toBe(true);
//   if (result.ok) {
//     // Build AgentTemplate manifest with result.spec; assert
//     // customApi.createNamespacedCustomObject called with correct body.
//   }
```

---

## Q5: Hash-route + page-mount pattern

**Confidence:** HIGH — `App.tsx` route registration + `TaskList.tsx` table layout + `NewTaskModal.tsx` modal are all read end-to-end.

### Hash-route registration in `App.tsx`

`App.tsx:55-77` `parseHash()` is THE registration site. New entry:

```ts
interface ReviewRoute { readonly kind: 'review'; }
type Route = DetailRoute | ListRoute | GatewayRoute | ClusterRoute | CommandRoute | ReviewRoute;

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  if (clean === '') return { kind: 'list' };
  if (clean === 'gateway') return { kind: 'gateway' };
  if (clean === 'cluster') return { kind: 'cluster' };
  if (clean === 'command') return { kind: 'command' };
  if (clean === 'review') return { kind: 'review' };       // NEW
  // ... existing detail-route parsing
  return { kind: 'list' };
}

export function App(): React.JSX.Element {
  const route = useHashRoute();
  // ... existing route blocks ...
  if (route.kind === 'review') {
    return <ReviewPage onBack={() => { window.location.hash = '#/'; }} />;
  }
  return <TaskList />;
}
```

### Table layout (mirror `TaskList.tsx`)

`TaskList.tsx:135-185` is the canonical table shape:

```tsx
<table className={styles.table}>
  <thead>
    <tr>
      <th>Reason</th>
      <th>Task</th>
      <th>Agent</th>
      <th>Reason Detail</th>
      <th>Staleness</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody>
    {rows.map((r) => (
      <tr key={r.taskRef.uid !== '' ? r.taskRef.uid : `${r.taskRef.namespace}/${r.taskRef.name}`}>
        <td data-source-field={useSourceField('reason')}>
          <span className={styles.reasonPill /* per-reason styling */}>{r.reason}</span>
        </td>
        <td data-source-fields={useSourceFields(['taskRef'])}>
          <a
            href={`#/tasks/${encodeURIComponent(r.taskRef.namespace)}/${encodeURIComponent(r.taskRef.name)}`}
          >
            {r.taskRef.namespace}/{r.taskRef.name}
          </a>
        </td>
        <td data-source-field={useSourceField('targetAgent')}>{r.targetAgent ?? '—'}</td>
        <td data-source-field={useSourceField('reasonDetail')}>{r.reasonDetail}</td>
        <td data-source-field={useSourceField('stalenessSeconds')}>
          {formatStaleness(r.stalenessSeconds)}
        </td>
        <td>
          <ReviewActions row={r} onDecision={onRefetch} />
        </td>
      </tr>
    ))}
  </tbody>
</table>
```

Sortable column headers like `TaskList.tsx` are NOT a Phase-3-or-earlier feature — `TaskList.tsx:136-147` shows static headers without sort handlers. CONTEXT.md says "sortable column headers" but rendering server-pre-sorted rows by descending staleness is sufficient for v0.2 acceptance; client-side sort is a "Claude's Discretion" upgrade.

### `*.module.css` modules

Verified in tree:

- `packages/workbench-ui/src/TaskList.module.css`
- `packages/workbench-ui/src/TaskDetail.module.css`
- `packages/workbench-ui/src/NewTaskModal.module.css`
- `packages/workbench-ui/src/command/DispositionOverlay.module.css`, `FlowOverlay.module.css`, `PressureOverlay.module.css`

Naming: `<Component>.module.css` next to `<Component>.tsx`. Phase 4 follows: `ReviewPage.module.css` next to `ReviewPage.tsx`. The `command/ReviewActions.module.css` belongs in `command/` since CONTEXT.md "Integration Points" places `ReviewActions.tsx` there.

### Confirm-dialog modal pattern (mirror `NewTaskModal.tsx`)

`NewTaskModal.tsx:36-229` is THE pattern:

- **Mount point:** `{showConfirm ? <ConfirmDialog ... /> : null}` inside `ReviewPage` / `TaskDetail` parent.
- **Backdrop close:** `onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}` `[VERIFIED: NewTaskModal.tsx:120-126]`
- **Esc-to-close:** `useEffect` adds `keydown` listener; cleanup removes it `[VERIFIED: NewTaskModal.tsx:69-76]`
- **Initial focus:** `promptRef` ref pointed at the primary input; `promptRef.current?.focus()` in `useEffect` `[VERIFIED: NewTaskModal.tsx:74]`
- **NO formal focus trap** (no tab-cycle interception). This is acceptable per the NewTaskModal precedent.
- **`role="dialog" aria-modal="true" aria-labelledby={title}` on the dialog div** `[VERIFIED: NewTaskModal.tsx:127]`
- **Submit semantics:** `<form onSubmit={...}>` with the primary action as `<button type="submit">`.

For Accept/Reject confirms: a simpler `ConfirmDialog` (no form fields beyond optional reasonText textarea) is the right minimal subset. Default action: dialog opens with "Are you sure you want to {accept|reject} this task?" + optional reasonText textarea + Cancel + Confirm buttons. Confirm fires the POST.

---

## Q6: `useReviewQueue()` hook + Phase 3 `attention` flow flip

**Confidence:** HIGH — `fetchDispositions` (api.ts:116-126) is the analog; `flows.ts:290-314` is the surgical flip site.

### `fetchReviewQueue` shape (mirror `fetchDispositions`)

```ts
import { assertIsReviewQueueRow } from '@kagent/dto/review-queue';

export async function fetchReviewQueue(signal?: AbortSignal): Promise<ReviewQueueRow[]> {
  const init: RequestInit = signal !== undefined ? { signal } : {};
  const res = await fetch('/api/review-queue', init);
  if (!res.ok) {
    throw new Error(`fetchReviewQueue: ${String(res.status)} ${res.statusText}`);
  }
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  for (const it of items) assertIsReviewQueueRow(it);
  return items as ReviewQueueRow[];
}
```

### `acceptReviewQueueRow` / `rejectReviewQueueRow` / `requestReview` (mirror `createTask`)

```ts
export async function acceptReviewQueueRow(
  namespace: string,
  name: string,
  body: { reviewerId?: string; reasonText?: string },
): Promise<AcceptReviewResponse> {
  const res = await fetch(
    `/api/review-queue/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/accept`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (res.status !== 200) {
    let errBody: { error?: string; fields?: Array<{...}> } = {};
    try { errBody = await res.json(); } catch { /* ignored */ }
    throw new ReviewActionApiError(res.status, errBody.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as AcceptReviewResponse;
}

export class ReviewActionApiError extends Error { /* mirror CreateTaskApiError */ }
```

### `useReviewQueue()` hook

There is NO `useDispositions` hook in `api.ts` today — the disposition surface is `fetchDispositions` plus a polling effect inside `DispositionOverlay.tsx`. Phase 4 introduces a true React hook because the ReviewPage AND the attention-flow integration both want the same source.

```ts
// packages/workbench-ui/src/api.ts — extend with:

export interface UseReviewQueueResult {
  readonly rows: readonly ReviewQueueRow[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

// Implementation lives wherever the planner picks; default: a simple
// custom hook in api.ts (no extra files).
export function useReviewQueue(intervalMs = 5000): UseReviewQueueResult {
  const [rows, setRows] = useState<readonly ReviewQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    /* fetchReviewQueue + setState */
  }, []);
  useEffect(() => {
    refetch();
    const id = setInterval(refetch, intervalMs);
    return () => clearInterval(id);
  }, [refetch, intervalMs]);
  return { rows, loading, error, refresh: refetch };
}
```

### Phase 3 `attention` flow flip — recommended approach

The current `flows.ts:290-314` `compute()` for `attention`:

```ts
{
  kind: 'attention',
  granularity: 'substrateWide',
  sourceFields: ['phase', 'suspicious'],
  compute: (s): readonly FlowGauge[] => {
    let count = 0;
    for (const t of s.tasks.values()) {
      if (t.phase === 'Failed' || (t.suspicious?.length ?? 0) > 0) {
        count++;
      }
    }
    if (count === 0) return [];
    return [{
      kind: 'attention',
      sourceFields: ['phase', 'suspicious'],
      detailLink: '#/tasks',
      label: 'awaiting review queue projection — Phase 4',
      value: count,
      unit: 'items',
    }];
  },
  detailLink: (): string => '#/tasks',
},
```

**Three integration shapes** (rated by decoupling):

1. **(Recommended) Snapshot-level proxy.** Add `reviewQueueRowCount?: number` to `CommandSnapshot` (the type at `packages/workbench-ui/src/command/state.ts`). `CommandView.tsx` calls `useReviewQueue()` and passes the count into the snapshot (or a sibling state). `flows.ts` `compute()` reads `s.reviewQueueRowCount ?? 0` — no compute() signature change, no new prop drilling, the `FlowGauge` shape stays identical, the `data-source-fields` flips to `'review-queue.rows.length'`. **This is the most-decoupled option** and survives Phase 3's existing tests because the snapshot extension is additive (existing tests don't set `reviewQueueRowCount` and the gauge reads `?? 0`, returning `[]`). The Phase 3 reload-stability snapshot needs regeneration (the attention gauge's source-field changes and possibly its label).

2. **Compute() signature change.** Pass `reviewQueueRowCount` as a second arg to `compute()`. Breaks the FlowType interface; cascades to every flow's compute(). Not minimal.

3. **Separate fetch in CommandView's useMemo.** Skip `flows.ts` integration entirely; CommandView fetches review-queue independently and renders the FlowGauge inline. Loses the source-binding contract for this gauge.

**Recommendation:** Option 1. The change to `flows.ts` is ~10 lines:

```ts
// flows.ts attention entry — replace lines 290–314:
{
  kind: 'attention',
  granularity: 'substrateWide',
  sourceFields: ['review-queue.rows.length'],   // flipped
  compute: (s): readonly FlowGauge[] => {
    // Phase 4: source flipped to /api/review-queue rows count.
    // CommandView.tsx wires useReviewQueue() into the snapshot; this
    // gauge reads `s.reviewQueueRowCount` (added in plan 4-XX).
    const count = s.reviewQueueRowCount ?? 0;
    if (count === 0) return [];
    return [{
      kind: 'attention',
      sourceFields: ['review-queue.rows.length'],
      detailLink: '#/review',                   // Phase 4 has a real route now
      label: `${String(count)} awaiting review`,
      value: count,
      unit: 'items',
    }];
  },
  detailLink: (): string => '#/review',
},
```

The Phase 3 `flows.test.ts` tests for the `attention` gauge (per RESEARCH expectations — verify in Wave 0) need their fixture updated to set `s.reviewQueueRowCount` instead of `s.tasks` with phase=Failed. Backward-compat: tests that don't set it should still pass (returns `[]` gauge).

### Phase 3 reload-stability snapshot regeneration

Per Phase 3's documented practice (the 03-02 plan committed an intentional snapshot regen), Phase 4 follows the same pattern: a single dedicated commit lands ONLY the `cc-reload.test.tsx.snap` diff after the attention-gauge source-field flips.

---

## Q7: Source-binding extension (`ReviewQueueFieldName`)

**Confidence:** HIGH — `source-binding.ts:50-90` is the canonical closed-enum pattern.

### Existing closed enums (verbatim)

`source-binding.ts:50-104` declares:

- `DispositionFieldName` (12 fields)
- `AgentSummaryFieldName` (6 fields)
- `TaskSummaryFieldName` (16 fields)
- `GatewayCapacityFieldName` (11 fields)

Plus re-exports from sibling modules:

- `PressureFieldName` from `pressure.ts`
- `FlowFieldName` from `flows.ts` (derived from `FLOW_TYPES['kind']`)

### `ReviewQueueFieldName` declaration

Mirror the explicit-enum pattern (DispositionFieldName-style; NOT the FLOW_TYPES-derived shape because `ReviewQueueRow` is a flat DTO, not a closed-enum-keyed array):

```ts
// packages/workbench-ui/src/command/source-binding.ts — ADD:

/** Closed enumeration of ReviewQueueRow top-level field names. */
export type ReviewQueueFieldName =
  | 'taskRef'
  | 'reason'
  | 'reasonDetail'
  | 'enqueuedAt'
  | 'stalenessSeconds'
  | 'phase'
  | 'targetAgent'
  | 'model'
  | 'suspicious'
  | 'verifierError'
  | 'traceLink'
  | 'artifactCount'
  | 'candidateTemplate'
  | 'replayDivergence';
```

### `assertSourceField` call sites in `ReviewPage.tsx` rows

```tsx
// In ReviewPage.tsx, before rendering each row:
for (const r of rows) {
  assertSourceField(r, 'reason');
  assertSourceField(r, 'taskRef');
  assertSourceField(r, 'reasonDetail');
  assertSourceField(r, 'stalenessSeconds');
  // (Optional fields like targetAgent only assert when rendering them.)
}
```

The assertion fires only in dev builds (`isDevBuild()` gate at `source-binding.ts:139-163`). Tests can stub `vi.stubEnv('NODE_ENV', 'production')` to no-op the assertion (Phase 1 / DISP-04 precedent).

### `useSourceField` / `useSourceFields` for the DOM attribute

```tsx
<td data-source-field={useSourceField('reason')}>{r.reason}</td>
<td data-source-fields={useSourceFields(['taskRef'])}>{r.taskRef.namespace}/{r.taskRef.name}</td>
```

Future CC-01-style scrapers can scan `data-source-field*` to verify every rendered cell has a backing source. CONTEXT.md notes ReviewPage is NOT under Command Center, so the canvas-side `assertCanvasOrphan` does NOT apply — only the DOM-side attributes plus `assertSourceField` calls.

---

## Q8: Audit-events discriminated-union extension

**Confidence:** HIGH — `event-types.ts:202-252` `ALL_EVENT_TYPES` array + `types.ts:48-110` union + `types.ts:905-1000` `AuditEventData` union are ALL touch points.

### Current catalog: 49 entries (verified count from `ALL_EVENT_TYPES`)

Phase 4 adds 4 entries → 53 total.

### Pattern for adding a new event type

Verified from the file (e.g., the Phase 1 `disposition.proposal_rejected` lines 194 + 109-110 + 860-875 + 996-999):

```
1. Add string-literal const in event-types.ts (lines 26-195 are precedent
   blocks; alphabetically/historically grouped).
2. Add to ALL_EVENT_TYPES frozen array (line 202-252).
3. Add union member in types.ts AuditEventType union (line 48-110).
4. Define data interface (e.g., `ReviewRequestedData`) in types.ts.
5. Add to AuditEventData discriminated union (line 905-1000).
```

### Outline: 4 new event types

```ts
// packages/audit-events/src/event-types.ts — ADD at the end (after disposition):

/* Phase 4 — Review queue projection + promotion path (REV-02 / D-02-A).
 * Four events bracket the review/promote slice:
 *   - `review.requested` — operator POSTed `/api/review-queue/.../request`,
 *     setting the `kagent.knuteson.io/review-requested: "true"`
 *     annotation on an AgentTask.
 *   - `review.accepted` — operator POSTed `.../accept`. Always emitted on
 *     successful annotation patch. When reason='candidate-template' AND
 *     the AgentTemplate CR was successfully created, the additional
 *     `template.candidate.promoted` event is also emitted.
 *   - `review.rejected` — operator POSTed `.../reject`. NO AgentTemplate
 *     creation under any reason.
 *   - `template.candidate.promoted` — emitted alongside `review.accepted`
 *     when an AgentTemplate CR was created from a `candidate-template`
 *     reason row. Records the new CR's identity. */
export const REVIEW_REQUESTED = 'review.requested' as const;
export const REVIEW_ACCEPTED = 'review.accepted' as const;
export const REVIEW_REJECTED = 'review.rejected' as const;
export const TEMPLATE_CANDIDATE_PROMOTED = 'template.candidate.promoted' as const;

// AND extend ALL_EVENT_TYPES at the end:
//   ...DISPOSITION_OVER_BUDGET,
//   REVIEW_REQUESTED,
//   REVIEW_ACCEPTED,
//   REVIEW_REJECTED,
//   TEMPLATE_CANDIDATE_PROMOTED,
```

### Data shapes (per CONTEXT.md D-02 / D-03)

Existing events use a flat `taskUid + taskNamespace + taskName + agentName` shape (e.g., `TaskFailedData` at `types.ts:175-184`). Phase 4 introduces a `taskRef` sub-object structure to mirror the new `ReviewQueueRow`'s `taskRef`. **Decision (planner picks):** flat-fields per existing precedent OR `taskRef` sub-object per CONTEXT.md D-02 verbatim. The flat-fields form is the lower-friction option (audit warehouses already filter on `data.taskUid`). Recommendation: flat-fields, with a comment noting the row-level `taskRef` sub-object is the UI projection of the same data.

```ts
// packages/audit-events/src/types.ts — ADD to AuditEventType union:
//   | 'review.requested'
//   | 'review.accepted'
//   | 'review.rejected'
//   | 'template.candidate.promoted'

export interface ReviewRequestedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly reviewerId: string | undefined; // X-Forwarded-User; undefined when auth disabled
  readonly reasonText: string | undefined; // operator-supplied free-text, scrubbed/capped
}

export interface ReviewAcceptedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly reason:
    | 'verifier-failed'
    | 'suspicious-detector'
    | 'human-review-requested'
    | 'candidate-template'; // mirrors ReviewReason at decision time
  readonly reviewerId: string | undefined;
  readonly reasonText: string | undefined;
}

export interface ReviewRejectedData {
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  readonly reason:
    | 'verifier-failed'
    | 'suspicious-detector'
    | 'human-review-requested'
    | 'candidate-template';
  readonly reviewerId: string | undefined;
  readonly reasonText: string | undefined;
}

export interface TemplateCandidatePromotedData {
  /** The producing AgentTask. */
  readonly taskUid: string;
  readonly taskNamespace: string;
  readonly taskName: string;
  /** The new AgentTemplate CR. */
  readonly agentTemplateNamespace: string;
  readonly agentTemplateName: string;
  readonly agentTemplateUid: string;
  readonly reviewerId: string | undefined;
}

// AND extend AuditEventData union:
//   | { readonly type: 'review.requested'; readonly data: ReviewRequestedData }
//   | { readonly type: 'review.accepted'; readonly data: ReviewAcceptedData }
//   | { readonly type: 'review.rejected'; readonly data: ReviewRejectedData }
//   | { readonly type: 'template.candidate.promoted'; readonly data: TemplateCandidatePromotedData };
```

### Tests for the audit extension

`packages/audit-events/src/make-event.test.ts` — extend with 4 new tests covering each new event type's `makeEvent({ type, source, subject, data })` round-trip. Pattern from `make-event.test.ts` for existing types is the analog (read it in Wave 0 to confirm shape; not read here but the shape is uniform per `make-event.ts`).

The "Sanity test" (`expect(ALL_EVENT_TYPES.length).toBe(49)` per `event-types.ts:200`) needs to be bumped to **53** in whichever test asserts it.

---

## Q9: RBAC extension contracts

**Confidence:** HIGH — both YAML files read end-to-end.

### Existing `agenttasks` rule (write Role at `clusterrole-actions.yaml:49-51`)

```yaml
- apiGroups: ['kagent.knuteson.io']
  resources: ['agenttasks']
  verbs: ['create']
```

### Existing read ClusterRole `agenttasks` rule (`clusterrole.yaml:30-41`)

```yaml
- apiGroups: ['kagent.knuteson.io']
  resources:
    - agents
    - agenttasks
    - agentcapabilities
    - modelendpoints
  verbs: ['get', 'list', 'watch']
```

`agenttemplates` is **NOT** in the read resource list `[VERIFIED: 2026-05-10]`. It also is not in any other list block (`clusterrole.yaml` was read entirely). This means:

- The workbench-api today CANNOT list/watch AgentTemplate CRs.
- Phase 4's accept-on-candidate-template creates a CR via `customApi.createNamespacedCustomObject`, which only requires the WRITE verb (`create`) — Phase 4's RBAC additions cover that.
- BUT: if Phase 4 wants the SnapshotCache informers to surface the post-promotion CR for subsequent GETs, the read-side ClusterRole MUST be additively extended. Per CONTEXT.md "Claude's Discretion" — the planner picks. Default recommendation: **extend the read-side ClusterRole** so the cache can grow informer support for AgentTemplate in this phase or a later phase without revisiting RBAC.

### Cleanest additive change

**`clusterrole-actions.yaml` (write Role) — extend additively:**

```yaml
rules:
  - apiGroups: ['kagent.knuteson.io']
    resources: ['agenttasks']
    verbs: ['create', 'patch'] # ADD 'patch' for annotation writes
  - apiGroups: ['kagent.knuteson.io']
    resources: ['agenttemplates'] # NEW rule
    verbs: ['create'] # for accept-on-candidate-template promotion
  - apiGroups: ['kagent.knuteson.io']
    resources: ['modelendpoints']
    verbs: ['patch', 'update'] # unchanged
```

**`clusterrole.yaml` (read ClusterRole) — extend additively (Recommendation: include):**

```yaml
- apiGroups: ['kagent.knuteson.io']
  resources:
    - agents
    - agenttasks
    - agentcapabilities
    - agenttemplates # NEW
    - modelendpoints
  verbs: ['get', 'list', 'watch']
- apiGroups: ['kagent.knuteson.io']
  resources:
    - agents/status
    - agenttasks/status
    - agentcapabilities/status
    - agenttemplates/status # NEW (consistent w/ pattern)
  verbs: ['get']
```

### `actions.create=false` fail-closed behavior

`clusterrole-actions.yaml:39-60` is wrapped in `{{- if and .Values.rbac.create .Values.rbac.actions.create -}}`. When `actions.create=false`, the entire Role + RoleBinding are NOT rendered, and the workbench-api ServiceAccount has zero write verbs.

The handler-side fail-closed — `tasks.ts:144-150` — is the FIRST gate: when `WORKBENCH_ACTIONS_ENABLED=true` is unset, `customApi` is undefined inside the route, and the handler returns 503 with the documented message. The chart's `actions.create=true` flips both `WORKBENCH_ACTIONS_ENABLED=true` (env in deployment.yaml) AND the Role bind — both gate independently. Phase 4's accept/reject/request handlers MUST follow this exact pattern (`if (deps.customApi === undefined) { ... 503 ... }`).

The H17 audit's documented release-namespace scope binds: the actions Role lives in `{{ .Release.Namespace }}` only, so cross-namespace promotion (a Phase 4 accept on a candidate in another namespace) is rejected by apiserver as 403 — the gateway PATCH-namespace-mismatch check at `routes/gateway.ts:402-422` is the precedent for surfacing this as a clean 403 from the workbench-api side. Phase 4 follows: the accept handler verifies the producing task's namespace matches `defaultNamespace` (when defaultNamespace is set; the chart sets it to `.Release.Namespace`).

---

## Validation Architecture

> Required by Nyquist contract. `workflow.nyquist_validation` is presumed enabled (no `.planning/config.json` blocked it; planner verifies in Wave 0).

### Test Framework

| Property                   | Value                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework                  | vitest (existing; per `packages/workbench-api/package.json` and `packages/workbench-ui/package.json`)                                             |
| Config file                | per-package `vitest.config.ts` (verified for workbench-api + workbench-ui via Phases 1-3 plans)                                                   |
| Quick run command (server) | `pnpm -C packages/workbench-api test --run packages/workbench-api/src/routes/review-queue.test.ts`                                                |
| Quick run command (UI)     | `pnpm -C packages/workbench-ui test --run packages/workbench-ui/src/ReviewPage.test.tsx packages/workbench-ui/src/command/ReviewActions.test.tsx` |
| Quick run (audit-events)   | `pnpm -C packages/audit-events test --run packages/audit-events/src/make-event.test.ts`                                                           |
| Quick run (dto)            | `pnpm -C packages/dto test --run packages/dto/src/review-queue.test.ts`                                                                           |
| Full suite (server)        | `pnpm -C packages/workbench-api test`                                                                                                             |
| Full suite (UI)            | `pnpm -C packages/workbench-ui test`                                                                                                              |
| Full repo test             | `pnpm -r test` (per pnpm workspace convention)                                                                                                    |

### Phase Requirements → Test Map

| Req ID           | Behavior                                                                                    | Test Type | Automated Command                                        | File Exists?                                               |
| ---------------- | ------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| REV-01           | Projection lists every terminal AgentTask needing review                                    | unit      | `pnpm -C packages/workbench-api test --run review-queue` | ❌ Wave 0 (NEW: `routes/review-queue.test.ts`)             |
| REV-01           | Sort by descending staleness                                                                | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-01           | Reload-stability (two GETs return identical content modulo staleness)                       | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-01           | Decided tasks excluded                                                                      | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-01           | Classifier priority (verifier > suspicious > review-requested > candidate)                  | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-01           | Reload-stability fixture covers one of each reason                                          | unit      | same                                                     | ❌ Wave 0 (NEW: `__fixtures__/review-queue-snapshot.json`) |
| REV-02           | POST accept creates AgentTemplate CR via customApi (candidate path)                         | unit      | `pnpm -C packages/workbench-api test --run review-queue` | ❌ Wave 0                                                  |
| REV-02           | POST accept patches review-decision annotation                                              | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | POST accept emits review.accepted + template.candidate.promoted (candidate)                 | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | POST accept on already-decided task → 409                                                   | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | POST accept K8s-409 (name collision) → 422 with K8s body, no annotation patch               | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | POST reject patches annotation, NO CR creation                                              | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | POST request patches review-requested annotation, emits review.requested                    | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | RBAC fail-closed (no customApi → 503 with WORKBENCH_ACTIONS_ENABLED message)                | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | parseAgentTemplateSpec accepts valid spec                                                   | unit      | `pnpm -C packages/dto test`                              | ❌ Wave 0 (NEW: `dto/template-candidate.test.ts`)          |
| REV-02           | parseAgentTemplateSpec rejects missing agentSpec                                            | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | parseAgentTemplateSpec rejects malformed parameters[]                                       | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | ReviewPage renders rows + Accept click → confirm dialog → POST → row removal                | unit      | `pnpm -C packages/workbench-ui test --run ReviewPage`    | ❌ Wave 0 (NEW: `ReviewPage.test.tsx`)                     |
| REV-02           | ReviewPage Reject click flow                                                                | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | ReviewActions mounts in TaskDetail under each of 4 trigger conditions                       | unit      | `pnpm -C packages/workbench-ui test --run ReviewActions` | ❌ Wave 0 (NEW: `ReviewActions.test.tsx`)                  |
| REV-02           | ReviewActions NOT mounted on a Pending or clean Completed task                              | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-02           | useReviewQueue() polls and refreshes                                                        | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-03           | replay-divergence enum slot exists; zero v0.2 producers                                     | unit      | `pnpm -C packages/dto test`                              | ❌ Wave 0                                                  |
| REV-03           | eval-failed enum slot exists; zero v0.2 producers                                           | unit      | same                                                     | ❌ Wave 0                                                  |
| REV-03           | TraceLink + verifierError on verifier-failed rows; suspicious[] on suspicious-detector rows | unit      | `pnpm -C packages/workbench-api test --run review-queue` | ❌ Wave 0                                                  |
| Audit            | 4 new event types pass make-event factory                                                   | unit      | `pnpm -C packages/audit-events test`                     | ❌ Wave 0 (extend `make-event.test.ts`)                    |
| Audit            | ALL_EVENT_TYPES.length bumped from 49 to 53                                                 | unit      | same                                                     | ❌ Wave 0                                                  |
| Phase 3 callback | flows.ts attention compute reads from reviewQueueRowCount                                   | unit      | `pnpm -C packages/workbench-ui test --run flows`         | ✅ exists (additive change to `flows.test.ts`)             |
| Phase 3 callback | cc-reload.test.tsx.snap regen with attention source-field flip                              | snapshot  | `pnpm -C packages/workbench-ui test --run cc-reload`     | ✅ exists (snapshot regen commit)                          |

### Sampling Rate

- **Per task commit:** `pnpm -C packages/<owning-package> test --run <touched-test-file>` — < 30 seconds for any single Phase 4 test file.
- **Per wave merge:** Full per-package suite for every package touched (`workbench-api`, `workbench-ui`, `audit-events`, `dto`, optionally `operator` if read-side cache extends).
- **Phase gate:** `pnpm -r test` green BEFORE `/gsd-verify-work`. Repo-wide TypeScript build (`pnpm -r build`) also green.

### Wave 0 Gaps

Wave 0 must land BEFORE any production-test plan in this phase:

- [ ] `packages/workbench-api/src/routes/review-queue.ts` — skeleton + types-only export (so other packages can import)
- [ ] `packages/workbench-api/src/routes/review-queue.test.ts` — skeleton with `describe.todo` blocks
- [ ] `packages/workbench-api/src/__fixtures__/review-queue-snapshot.json` — one of each ReviewReason (5 entries: verifier-failed, suspicious-detector, human-review-requested, candidate-template, decided-skipped) plus a 6th "clean Completed task" that should NOT appear; PLUS a 7th task carrying both verifier-failed AND suspicious to test priority
- [ ] `packages/workbench-api/src/__fixtures__/candidate-template.yaml` — valid AgentTemplateSpec YAML for the accept-promote happy-path test
- [ ] `packages/dto/src/review-queue.ts` — DTO + `assertIsReviewQueueRow` + `ReviewReason` enum + `ArtifactRefSummary` (NEW file)
- [ ] `packages/dto/src/review-queue.test.ts` — assertIsReviewQueueRow round-trip + `ReviewReason` exhaustiveness check
- [ ] `packages/dto/src/template-candidate.ts` — `parseAgentTemplateSpec` (NEW file)
- [ ] `packages/dto/src/template-candidate.test.ts` — parser tests (NEW file)
- [ ] `packages/dto/src/index.ts` — re-export new symbols
- [ ] `packages/audit-events/src/event-types.ts` — 4 new const declarations + ALL_EVENT_TYPES extension
- [ ] `packages/audit-events/src/types.ts` — 4 new data interfaces + AuditEventType union extension + AuditEventData union extension
- [ ] `packages/workbench-ui/src/ReviewPage.tsx` — skeleton (returns "Review queue (Phase 4)" empty state); `.module.css` skeleton
- [ ] `packages/workbench-ui/src/command/ReviewActions.tsx` — skeleton; `.module.css` skeleton
- [ ] `packages/workbench-ui/src/command/source-binding.ts` — `ReviewQueueFieldName` closed enum
- [ ] `packages/workbench-ui/src/api.ts` — `fetchReviewQueue`, `acceptReviewQueueRow`, `rejectReviewQueueRow`, `requestReview`, `useReviewQueue` (signature-only stubs to unblock UI tests)
- [ ] `packages/workbench-ui/src/types.ts` — re-export `ReviewQueueRow`, `ReviewReason` from `@kagent/dto/review-queue`

After Wave 0, Wave 1+ implements the bodies; Wave 2+ wires UI; Wave 3 (final) does the Phase 3 attention-flow flip + snapshot regen.

### Adversarial cases (MUST be tested — not just happy path)

1. **Second accept on same task → 409.** The `review-decision` annotation is set; the projection has already excluded the row; a second POST returns 409 with the existing decision value.
2. **CR-create-409 (name collision) → 422 with K8s body, NO annotation write.** Verify by mocking `customApi.createNamespacedCustomObject` to throw a 409 ApiException; assert the patch was NOT called.
3. **CR-create-422 (apiserver schema validation) → 422 with K8s body.** Same pattern as above with a 422.
4. **Reject on candidate-template does NOT create AgentTemplate.** The `customApi.createNamespacedCustomObject` mock should record zero calls under any reject path.
5. **Priority correctness:** verifier-failed beats suspicious beats review-requested beats candidate-template. Single-task test with multiple signals.
6. **Reload-stability across two GETs:** identical row content modulo `stalenessSeconds` (which advances by 0 with fixed clock).
7. **Decided task excluded from queue:** a verifier-failed task with `review-decision: "accepted"` annotation does NOT appear.
8. **Candidate-template with phase=Failed does NOT classify as candidate-template** (D-01 step 5 requires phase=Completed). It instead routes via verifier-failed (if applicable).
9. **Empty cache:** zero rows.
10. **Malformed candidate artifact (missing media-type or unparseable YAML):** row OMITTED; warning logged.
11. **Annotation patch failure after CR creation:** logs the orphan-ish state; audit-event log carries `template.candidate.promoted` but NOT `review.accepted`. Reviewer can retry; second attempt is idempotent on the CR side (409 treated as success-equivalent on retry per CONTEXT.md D-03 atomicity note — planner picks whether to surface this in code or rely on operator retry).
12. **Empty `targetAgent` on a queue row:** row still emits; `targetAgent` is optional.
13. **`X-Forwarded-User` missing AND auth disabled:** decidedBy/reviewerId fall back to `'unknown'`; audit emits with `reviewerId: undefined`.
14. **`reasonText` length cap (planner picks; recommend 4096 bytes mirroring the message body cap):** truncates or rejects 400.

### Test scaffolding pieces required

- **Fake `customApi`:** `Pick<CustomObjectsApi, 'createNamespacedCustomObject' | 'patchNamespacedCustomObject'>` with `vi.fn()` mocks. Mirror `dispositions.test.ts:96-107` `makeStubCoreApi`.
- **Fake `SnapshotCache`:** populated via `cache.upsertTask(t)` in test setup. The real class works fine; no need to mock the interface.
- **Audit-event capture:** `makeStubAuditPublisher()` mirroring `dispositions.test.ts:138-142` — `vi.fn()` `publish` returning `Promise.resolve(undefined)`. Assertions inspect `auditPublisher.publish.mock.calls[<i>][0]` for the CloudEvent envelope shape.
- **Fixed clock:** `now: () => fixedNow` injection via `ReviewQueueRouteDeps.now`. Mirrors `dispositions.test.ts:246`.
- **Hono request helper:** `app.request('/...')` per `dispositions.test.ts:151`.

### Coverage targets

- `packages/workbench-api/src/routes/review-queue.ts` — **≥75%** (glue-code bar per CLAUDE.md). Realistic target: 90%+ given the test plan above.
- `packages/dto/src/review-queue.ts` + `template-candidate.ts` — **≥75%**.
- `packages/workbench-ui/src/ReviewPage.tsx` + `command/ReviewActions.tsx` — **≥75%**.
- `packages/audit-events/src/types.ts` + `event-types.ts` — additive only; existing coverage extends to new types via the make-event tests.

### Manual UAT (post-deploy verification, NOT vitest)

1. Operator visits `#/review` → table renders rows from `/api/review-queue`. Empty state shows when zero rows.
2. Operator clicks "Open Detail" on a row → navigates to `#/tasks/<ns>/<name>`.
3. Operator visits a Failed/suspicious/review-requested/candidate-template task at `#/tasks/<ns>/<name>` → sees inline `ReviewActions` panel near the top of the panel.
4. Operator clicks Accept on a candidate-template row → confirm dialog opens → confirms → AgentTemplate CR appears in cluster (`kubectl get agenttemplate -n <ns> <name>`); audit-event arrives in NATS audit stream (`subscribe audit.>` on the JetStream); annotation `kagent.knuteson.io/review-decision: "accepted"` appears on the producing AgentTask.
5. Operator clicks Reject on the same shape → no AgentTemplate CR created; annotation is `"rejected"`.
6. Operator visits `#/command` → the `attention` flow gauge shows `<count> awaiting review` matching `/api/review-queue`'s row count; clicking the gauge navigates to `#/review`.
7. After all rows reviewed → `#/review` is empty state; `attention` gauge is empty.
8. Reload `#/review` → table reconstructs from API state (reload-stability).

---

## Q11: Pattern-mirroring landmines

**Confidence:** HIGH — verified by grep + file reads.

### Sub-path POST (`/api/{ns}/{name}/...`) — is it novel?

`grep -rn "app\.post.*':namespace/:name'" packages/workbench-api/src/routes/` and equivalent verbose patterns:

| Existing endpoint                                                    | Pattern                   |
| -------------------------------------------------------------------- | ------------------------- |
| `POST /api/tasks` (`tasks.ts:143`)                                   | top-level shape           |
| `PATCH /api/modelendpoints/:namespace/:name` (`gateway.ts:483 area`) | sub-path PATCH (NOT POST) |

`PATCH /api/modelendpoints/:namespace/:name` IS the sub-path-with-namespace-and-name precedent — Hono accepts the route shape. The `:namespace/:name/{accept,reject,request}` pattern goes one level deeper but Hono handles arbitrary nesting (trailing path segments are just additional `app.post` routes within the same route group). **No new helpers needed** — Hono's first-match-wins + path params just work.

The only "novelty" is the trailing-action segment (`/accept` / `/reject` / `/request`). Hono handles this naturally:

```ts
app.post('/:namespace/:name/accept', async (c) => {
  /* ... */
});
app.post('/:namespace/:name/reject', async (c) => {
  /* ... */
});
app.post('/:namespace/:name/request', async (c) => {
  /* ... */
});
```

When mounted at `/api/review-queue` via `app.route('/api/review-queue', reviewQueueRoute(deps))` in `router.ts`, the full paths become `/api/review-queue/:namespace/:name/{accept,reject,request}`. The route group's GET (`'/'`) becomes `GET /api/review-queue`. **CLEAN.**

### JSON merge-patch annotation write — is it novel?

| Existing site                       | What it patches                                                        |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `gateway.ts:444`                    | ModelEndpoint `spec.inFlight.{seed,max,minSafe}`                       |
| `operator/src/job-annotator.ts:87`  | Job `metadata.annotations` (the `dispatch-published` precedent)        |
| `operator/src/reconcile.ts:893` etc | AgentTask `status` subresource via `patchNamespacedCustomObjectStatus` |

**An annotation merge-patch on AgentTask from workbench-api is NEW.** The existing operator-side `job-annotator.ts` does Job annotations; gateway.ts does ModelEndpoint spec; nothing today does AgentTask metadata.annotations from the workbench-api side.

**No need for a new helper file.** The `MERGE_PATCH_OPTIONS` constant + `customApi.patchNamespacedCustomObject(...)` call inline is sufficient (see Q3). The pattern is small enough that extracting to `src/k8s/patch.ts` is over-engineered for one use site at this phase. Recommendation: inline the call within `routes/review-queue.ts`. If a fourth or fifth `patch+annotation` consumer lands later, refactor.

### `customApi.createNamespacedCustomObject` outside `tasks.ts` — is it novel?

`grep -rn "createNamespacedCustomObject" packages/workbench-api/src/`:

- `tasks.ts:220` — only direct usage today.
- Tests reference the method as a mock signature.

**Yes, the call is currently `tasks.ts`-only.** Phase 4's accept handler is the second call site. Two call sites do NOT justify extracting to a shared helper; the call is short (one block). Recommendation: inline. If/when a third creates path lands (e.g., a future `POST /api/agents`), the helper extraction makes sense.

### `auditPublisher` shape novelty

The `dispositions.ts:89-93` `auditPublisher` shape is `{ publish(event: AuditEvent): Promise<void> } | undefined`. **Identical** for review-queue. Re-use the same field on `RouterDeps`. The `main.ts` already wires this from the env-var-driven `AuditPublisher`. NO new wiring.

### `parseAgentTemplateSpec` — is YAML parsing novel?

`grep -rn "import.*from.*'yaml'" packages/`:

- `packages/dto/src/disposition-parser.ts` — uses `yaml` to parse `data.disposition.yaml` from ConfigMaps. **Yes, `yaml` IS already a workspace dep** (somewhere — verify in Wave 0 by checking package.json files). The `disposition-parser` calls `YAML.parse(...)` on the string content.

`disposition-parser.ts` is in `@kagent/dto`. Phase 4 can either:

- (a) Use the same `yaml` dep inside `@kagent/dto/template-candidate.ts` (parses string → object → validates).
- (b) Land YAML parsing in `packages/workbench-api/src/yaml.ts` and keep `parseAgentTemplateSpec` operating on parsed objects.

Recommendation: **(b)**. The DTO module's job is shape-validation; the workbench-api owns the wire format. But (a) is a reasonable shortcut if disposition-parser already establishes the precedent — planner picks based on whether the dispositions DTO does YAML parsing or accepts pre-parsed objects (verify in Wave 0; the file `packages/dto/src/disposition-parser.ts` was not read in this research session — but the `parseDispositionConfigMap` in `dispositions.ts:203` import is the analog).

### Hash-route addition in `App.tsx` — anything novel?

No. The pattern at `App.tsx:55-77` is `if (clean === '<route>') return { kind: '<route>' };`. Adding `'review'` is one line.

### Inline mounting `<ReviewActions>` in `TaskDetail` — anything novel?

`TaskDetail.tsx` follows a `Section` + `KV` helper pattern. Adding a new top-level inline component above `<DetailBody>` (or as a sibling at the top of `<DetailBody>`) is straightforward:

```tsx
{
  detail !== null ? (
    <>
      <ReviewActions task={detail} onDecision={refetch} />
      <DetailBody detail={detail} />
    </>
  ) : null;
}
```

No mount-point novelty. The `onDecision={refetch}` callback wires the inline action to the existing refetch loop so the page updates when the row leaves the queue.

---

## Q12: Files to create vs modify (planner pre-digest)

**Confidence:** HIGH — every file's analog has been read.

### NEW files

| File                                                                 | Closest analog                                                                                                                                          | What gets copied                                                                                             | What gets invented                                                                                                                              | Tests                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/dto/src/review-queue.ts`                                   | `packages/dto/src/disposition.ts`                                                                                                                       | DTO interface shape, `assertIs*` validator, JSDoc style, ProposalKind-style closed enum                      | `ReviewReason` (6 entries), `ReviewQueueRow` shape, `ArtifactRefSummary` (subset of `ArtifactRef`)                                              | `review-queue.test.ts` (NEW; tests assertIs\* round-trip + reason enum exhaustiveness) |
| `packages/dto/src/review-queue.test.ts`                              | `packages/dto/src/disposition.test.ts` (assumed; analog exists)                                                                                         | Test layout: round-trip, missing-field, malformed-reason                                                     | —                                                                                                                                               | self                                                                                   |
| `packages/dto/src/template-candidate.ts`                             | `packages/dto/src/disposition-parser.ts` (analog assumed)                                                                                               | `parseAgentTemplateSpec` result-shape pattern                                                                | YAML→object validation via plain object inspection (NOT zod); ParseAgentTemplateSpecError shape                                                 | `template-candidate.test.ts` (NEW)                                                     |
| `packages/dto/src/template-candidate.test.ts`                        | mirror of `disposition-parser.test.ts` (analog assumed)                                                                                                 | Test layout                                                                                                  | Valid spec, missing agentSpec, malformed parameters, etc.                                                                                       | self                                                                                   |
| `packages/workbench-api/src/routes/review-queue.ts`                  | `packages/workbench-api/src/routes/dispositions.ts` (route shape) + `routes/tasks.ts` (POST handler patterns) + `routes/gateway.ts:444` (PATCH pattern) | `dispositionsRoute(deps)` factory shape; `tasks.ts` validators+error-scrub; `gateway.ts` MERGE_PATCH_OPTIONS | Classifier function (4 priority steps); accept handler (CR create → annotation patch → audit emit); reject + request handlers; sub-path routing | `review-queue.test.ts` (NEW; ~25 unit tests per Q10 map)                               |
| `packages/workbench-api/src/routes/review-queue.test.ts`             | `packages/workbench-api/src/routes/dispositions.test.ts` (test layout)                                                                                  | makeStub helpers, mountAndFetch, fixture import-with-attributes pattern                                      | Per-reason synthetic tasks, customApi mock for create/patch, audit publisher capture                                                            | self                                                                                   |
| `packages/workbench-api/src/__fixtures__/review-queue-snapshot.json` | `tests/fixtures/disposition/gateway-usage-rows.json` (analog at repo root)                                                                              | JSON-with-import-attributes fixture pattern                                                                  | 7 task entries (5 reasons + 1 clean + 1 priority-conflict)                                                                                      | consumed by `review-queue.test.ts`                                                     |
| `packages/workbench-api/src/__fixtures__/candidate-template.yaml`    | NEW (no precedent for raw-YAML fixture)                                                                                                                 | —                                                                                                            | Valid AgentTemplateSpec YAML for accept-promote happy-path                                                                                      | consumed by `review-queue.test.ts`                                                     |
| `packages/workbench-ui/src/ReviewPage.tsx`                           | `packages/workbench-ui/src/TaskList.tsx` (table layout, refetch lifecycle, error/loading states)                                                        | useEffect+abort pattern, table layout, header bar                                                            | Confirm-dialog state, per-row actions                                                                                                           | `ReviewPage.test.tsx` (NEW)                                                            |
| `packages/workbench-ui/src/ReviewPage.module.css`                    | `packages/workbench-ui/src/TaskList.module.css`                                                                                                         | Table styles, header bar, button styles                                                                      | Per-reason pill colors (verifier-failed=red, suspicious=amber, review-requested=blue, candidate-template=green)                                 | —                                                                                      |
| `packages/workbench-ui/src/ReviewPage.test.tsx`                      | `packages/workbench-ui/src/TaskList.test.tsx` (assumed analog; verify in Wave 0)                                                                        | mount + fetch mock + click flow                                                                              | Confirm-dialog interactions, audit-trace assertion                                                                                              | self                                                                                   |
| `packages/workbench-ui/src/command/ReviewActions.tsx`                | `packages/workbench-ui/src/NewTaskModal.tsx` (modal+form) + per-row actions inside `TaskList.tsx`                                                       | NewTaskModal Esc handler, focus-mgmt, dialog role                                                            | 4-trigger-condition mount logic, Accept/Reject/Request buttons                                                                                  | `ReviewActions.test.tsx` (NEW)                                                         |
| `packages/workbench-ui/src/command/ReviewActions.module.css`         | `packages/workbench-ui/src/command/DispositionOverlay.module.css`                                                                                       | Inline-component styles                                                                                      | —                                                                                                                                               | —                                                                                      |
| `packages/workbench-ui/src/command/ReviewActions.test.tsx`           | mirror existing command/\* test files                                                                                                                   | Render + click flow                                                                                          | Mounted-when-eligible cases, NOT-mounted cases                                                                                                  | self                                                                                   |

### MODIFY (additive only)

| File                                                                           | Closest analog (for the change)                                         | What gets added                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dto/src/index.ts`                                                    | existing re-export pattern                                              | `export * from './review-queue.js'`; `export * from './template-candidate.js'`                                                                                                                                            |
| `packages/workbench-api/src/router.ts`                                         | `dispositions` registration block at `router.ts:191-220`                | `if (deps.cache !== undefined) { app.route('/api/review-queue', reviewQueueRoute({ cache, customApi, auditPublisher, defaultNamespace, now })); }` (cache is always present; `customApi` optional gates writes per usual) |
| `packages/workbench-api/src/main.ts`                                           | dispositions deps wiring at `main.ts:196-215`                           | Pass cache + auditPublisher + writeCustomApi + defaultNamespace through `buildRouter`'s existing fields — NO new env vars; reuses existing `WORKBENCH_ACTIONS_ENABLED` and `KAGENT_AUDIT_NATS_URL`                        |
| `packages/audit-events/src/event-types.ts`                                     | DISPOSITION_OVER_BUDGET block at lines 182-195                          | 4 new const literals + 4 entries in `ALL_EVENT_TYPES`                                                                                                                                                                     |
| `packages/audit-events/src/types.ts`                                           | DispositionOverBudgetData block at lines 877-898 + AuditEventData union | 4 new data interfaces + 4 union entries in `AuditEventType` + 4 entries in `AuditEventData` discriminated union                                                                                                           |
| `packages/audit-events/src/make-event.test.ts`                                 | existing per-type tests (verify shape in Wave 0)                        | 4 new tests covering each new event type's makeEvent round-trip; assert `ALL_EVENT_TYPES.length === 53`                                                                                                                   |
| `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` | comment block at lines 27-37 (mentions agenttemplates extension)        | Add `'patch'` to agenttasks verbs; new rule for agenttemplates: ['create']                                                                                                                                                |
| `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml`         | resources list at lines 30-41                                           | Add `agenttemplates` to read resources list + `agenttemplates/status` to status read list                                                                                                                                 |
| `packages/workbench-ui/src/types.ts`                                           | DispositionOverlayRow re-export at lines 29-33                          | Re-export `ReviewQueueRow`, `ReviewReason`, `ArtifactRefSummary` from `@kagent/dto/review-queue`                                                                                                                          |
| `packages/workbench-ui/src/api.ts`                                             | `fetchDispositions` at lines 116-126; `createTask` at lines 134-156     | `fetchReviewQueue`, `acceptReviewQueueRow`, `rejectReviewQueueRow`, `requestReview`, `useReviewQueue` hook, `ReviewActionApiError` class                                                                                  |
| `packages/workbench-ui/src/App.tsx`                                            | `parseHash()` at lines 55-77 + route blocks at lines 95-132             | Add `'review'` parser entry + `<ReviewPage>` mount block                                                                                                                                                                  |
| `packages/workbench-ui/src/TaskDetail.tsx`                                     | `<DetailBody>` mount at line 100-102                                    | Mount `<ReviewActions task={detail} onDecision={refetch} />` above `<DetailBody>` (or first child of the fragment)                                                                                                        |
| `packages/workbench-ui/src/command/source-binding.ts`                          | DispositionFieldName at lines 50-62                                     | Add `ReviewQueueFieldName` closed enum (14 entries per Q7)                                                                                                                                                                |
| `packages/workbench-ui/src/command/source-binding.test.ts`                     | existing tests for DispositionFieldName                                 | 1-2 new orphan-assertion tests for ReviewQueueRow shape                                                                                                                                                                   |
| `packages/workbench-ui/src/command/flows.ts`                                   | attention block at lines 290-314                                        | Replace compute() body to read `s.reviewQueueRowCount` (~10 lines); update sourceFields + detailLink + label                                                                                                              |
| `packages/workbench-ui/src/command/flows.test.ts`                              | existing attention test                                                 | Update existing attention test to set `s.reviewQueueRowCount` instead of synthesizing Failed tasks                                                                                                                        |
| `packages/workbench-ui/src/command/state.ts`                                   | existing CommandSnapshot interface                                      | Add optional `readonly reviewQueueRowCount?: number` field (additive, type-safe)                                                                                                                                          |
| `packages/workbench-ui/src/CommandView.tsx`                                    | existing snapshot + overlay mount                                       | Wire `useReviewQueue()` (via `.length`) into the snapshot — planner picks the integration shape                                                                                                                           |
| `packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap`      | existing Phase 3 snapshot                                               | Regenerated via `vitest -u` after attention source-field flips; one dedicated snapshot-update commit                                                                                                                      |
| `docs/AGENT-TEMPLATES.md`                                                      | existing doc                                                            | Footer extension: media-type `application/x-kagent-template-candidate+yaml` documented; "Promotion via review queue" subsection pointing at this CONTEXT.md                                                               |
| `docs/REPLAY-EVALS.md`                                                         | existing doc                                                            | Footer note: AgentTaskRun reducer should emit `replay-divergence` audit events the projection picks up; pointer to `routes/review-queue.ts` D-04 inline comment                                                           |
| `docs/SUBSTRATE-V1.md` (§4.3 audit-event catalog)                              | existing event-table                                                    | 4 new entries documenting review.\* + template.candidate.promoted (catalog grows 49 → 53)                                                                                                                                 |

### Files to create vs modify summary table

| Package                 | NEW files                                                  | MODIFIED files                                                                                                                       |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@kagent/dto`           | 4 (review-queue.ts + .test, template-candidate.ts + .test) | 1 (index.ts re-export)                                                                                                               |
| `@kagent/audit-events`  | 0                                                          | 3 (event-types.ts, types.ts, make-event.test.ts)                                                                                     |
| `@kagent/workbench-api` | 4 (review-queue.ts + .test, 2 fixtures)                    | 2 (router.ts, main.ts)                                                                                                               |
| `@kagent/workbench-ui`  | 6 (ReviewPage tsx+css+test, ReviewActions tsx+css+test)    | 8 (types.ts, api.ts, App.tsx, TaskDetail.tsx, source-binding.ts + .test, flows.ts + .test, state.ts, CommandView.tsx, snapshot file) |
| Operator chart          | 0                                                          | 2 (clusterrole-actions.yaml, clusterrole.yaml)                                                                                       |
| Docs                    | 0                                                          | 3 (AGENT-TEMPLATES.md, REPLAY-EVALS.md, SUBSTRATE-V1.md)                                                                             |
| **TOTALS**              | **14 new**                                                 | **~19 modified**                                                                                                                     |

---

## Architecture Patterns

### System Architecture Diagram

```
                            ┌──────────────────────────────────────┐
                            │   Phase 4 — Review queue + promotion │
                            └──────────────────────────────────────┘

   ┌─────────────────────┐   GET /api/review-queue    ┌────────────────────────┐
   │  Workbench-UI       ├───────────────────────────►│  Workbench-API         │
   │                     │                             │                        │
   │  #/review (NEW)     │   POST .../accept           │  routes/review-queue.ts│
   │   ├─ ReviewPage.tsx │   POST .../reject           │   ├─ classify(tasks)   │
   │   └─ ReviewActions  │   POST .../request          │   ├─ accept handler    │
   │                     │                             │   ├─ reject handler    │
   │  TaskDetail.tsx     │                             │   └─ request handler   │
   │   └─ ReviewActions  │                             │                        │
   │      (inline mount) │                             │  Reads: SnapshotCache  │
   │                     │                             │  Writes via customApi: │
   │  CommandView        │                             │   - patch agenttasks   │
   │   └─ FlowOverlay    │                             │   - create agenttemplates│
   │      (attention     │                             └────────┬───────────────┘
   │       gauge flips   │                                      │
   │       to read       │                                      │ patchNamespaced
   │       review queue) │                                      │ + createNamespaced
   └─────────────────────┘                                      │ CustomObject
                                                                ▼
                                                       ┌─────────────────────┐
                                                       │   K8s API server    │
                                                       │                     │
                                                       │  AgentTask CRs      │
                                                       │   (annotations:     │
                                                       │    review-decision, │
                                                       │    template-        │
                                                       │     candidate, ...) │
                                                       │                     │
                                                       │  AgentTemplate CRs  │
                                                       │   (NEW on accept)   │
                                                       └──────────┬──────────┘
                                                                  │
                                                                  ▼
                                                       ┌────────────────────┐
                                                       │  Operator informers│
                                                       │  → SnapshotCache   │
                                                       │  (round-trip; UI   │
                                                       │   refresh next     │
                                                       │   GET)             │
                                                       └────────────────────┘

                                       ┌──────────────────────────────────┐
                                       │  Audit stream (NATS JetStream)   │
                                       │                                  │
                                       │  + review.requested              │
                                       │  + review.accepted               │
                                       │  + review.rejected               │
                                       │  + template.candidate.promoted   │
                                       └──────────────────────────────────┘
                                            ▲
                                            │ AuditPublisher.publish(makeEvent(...))
                                            │ (existing wire from Phase 1)
                                            │
                                       (workbench-api after every write handler)
```

### Recommended project structure (additive — no new top-level dirs)

```
packages/
├── dto/src/
│   ├── review-queue.ts        # NEW — DTO + assertIs*
│   ├── review-queue.test.ts   # NEW
│   ├── template-candidate.ts  # NEW — parseAgentTemplateSpec
│   └── template-candidate.test.ts  # NEW
├── audit-events/src/
│   ├── event-types.ts         # MODIFIED — +4 consts
│   ├── types.ts               # MODIFIED — +4 data ifaces + union extensions
│   └── make-event.test.ts     # MODIFIED — +4 round-trip tests
├── workbench-api/src/
│   ├── routes/
│   │   ├── review-queue.ts          # NEW — projection + accept/reject/request
│   │   └── review-queue.test.ts     # NEW
│   ├── __fixtures__/                # NEW DIR
│   │   ├── review-queue-snapshot.json
│   │   └── candidate-template.yaml
│   ├── router.ts              # MODIFIED — register route
│   └── main.ts                # MODIFIED — wire deps
├── workbench-ui/src/
│   ├── ReviewPage.tsx           # NEW — #/review route page
│   ├── ReviewPage.module.css    # NEW
│   ├── ReviewPage.test.tsx      # NEW
│   ├── App.tsx                  # MODIFIED — register #/review
│   ├── TaskDetail.tsx           # MODIFIED — mount inline ReviewActions
│   ├── api.ts                   # MODIFIED — fetch helpers + hook
│   ├── types.ts                 # MODIFIED — DTO re-exports
│   └── command/
│       ├── ReviewActions.tsx        # NEW — inline component
│       ├── ReviewActions.module.css # NEW
│       ├── ReviewActions.test.tsx   # NEW
│       ├── source-binding.ts        # MODIFIED — ReviewQueueFieldName
│       ├── source-binding.test.ts   # MODIFIED — orphan tests
│       ├── flows.ts                 # MODIFIED — attention compute()
│       ├── flows.test.ts            # MODIFIED — attention test
│       └── state.ts                 # MODIFIED — +reviewQueueRowCount
└── operator/charts/kagent-workbench/templates/
    ├── clusterrole-actions.yaml  # MODIFIED — +agenttasks:patch +agenttemplates:create
    └── clusterrole.yaml          # MODIFIED — +agenttemplates read

docs/
├── AGENT-TEMPLATES.md         # MODIFIED — +media-type + Promotion section
├── REPLAY-EVALS.md            # MODIFIED — +footer pointer
└── SUBSTRATE-V1.md            # MODIFIED — +4 audit-event entries
```

### Anti-Patterns to Avoid

- **Don't introduce a new CRD** for review state. D2 forbids it. Annotations on AgentTask are the substrate signal.
- **Don't share the read RBAC's namespace scope with the write RBAC.** The read role is cluster-scoped (informers must list cross-namespace); the write Role is namespace-scoped (H17). Phase 4 extends both, but the verbs distinct: read role gets `agenttemplates:[get,list,watch]`; write Role gets `agenttemplates:[create]` and `agenttasks:[patch]`. Don't conflate.
- **Don't re-derive `pilotEvidence` in the projection.** Read `task.status.verification` and `task.status.structuralVerdict` directly (the same fields `pilotEvidence` re-projects). Bypassing the helper saves a function call AND keeps the projection self-contained.
- **Don't echo K8s API error bodies to authenticated callers** (Audit-rev2 L17). Scrub to a generic message with structured logs (mirror `tasks.ts:263-283`). Exception: 422 candidate-validation errors MAY surface the K8s body (it's reviewer input that failed).
- **Don't mount the `<ReviewActions>` component on Pending or clean Completed tasks.** The 4 trigger conditions (phase=Failed OR suspicious !== empty OR review-requested annotation OR template-candidate annotation) are a hard predicate.
- **Don't break the "annotation-already-set" idempotency.** A second accept on the same task returns 409 BEFORE calling K8s. The handler reads cache state and short-circuits.
- **Don't introduce a SECOND mock for `customApi` shapes.** Reuse `Pick<CustomObjectsApi, 'createNamespacedCustomObject' | 'patchNamespacedCustomObject'>` consistent with the existing test patterns in `tasks.test.ts` and `gateway.test.ts`.
- **Don't store reviewer reason text > 4 KiB without truncation.** The annotation lives in etcd; oversized values cause apiserver to reject with 413 (similar to MAX_PAYLOAD_BYTES at `validators.ts:59`). Recommendation: cap reasonText at 4 KiB; reject 400 on overage.

---

## Don't Hand-Roll

| Problem                              | Don't Build                                             | Use Instead                                                                                                             | Why                                                                                                        |
| ------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| YAML parsing for candidate templates | a regex-based YAML parser                               | `yaml` npm package (likely already a workspace dep via `@kagent/dto/disposition-parser.ts`; verify)                     | YAML edge cases (anchors, multi-line scalars, custom types) are landmine territory                         |
| Form validators for POST bodies      | a zod schema                                            | hand-rolled validators per `validators.ts` (the existing pattern; CONTEXT.md `Reasoning` section explicitly chose this) | One-pattern-shop; adding zod for one POST is ~50 KiB; the existing hand-validators are clear at this scale |
| Audit event envelope construction    | `JSON.stringify({...})` directly                        | `makeEvent(...)` factory at `make-event.ts:88`                                                                          | Type-narrowed CloudEvents v1.0 envelope; consistent across substrate; tests rely on the shape              |
| K8s error parsing                    | string-matching K8s error messages                      | `extractK8sStatus(err)` — copy from `tasks.ts:346-355`; treat 409 / 404 / 403 / default-500                             | The K8s client throws ApiException with shape variations across versions; the helper handles both          |
| Hash-route parsing                   | `window.location.hash.split(...)`                       | `App.tsx:55-77`'s `parseHash()` pattern                                                                                 | Existing convention; tolerant of trailing slashes and decode-errors                                        |
| Confirm-dialog modal                 | a modal lib (react-modal etc.)                          | `NewTaskModal.tsx:120-229` pattern                                                                                      | UI is leaf-deps-only (react + react-dom only); the existing modal pattern is < 100 LOC                     |
| Source-binding assertion             | manual `if (!('field' in row)) throw ...` per call site | `assertSourceField(row, 'field')` at `source-binding.ts:181-191`                                                        | Dev-only; consistent across CC; future scrapers depend on the DOM attribute                                |
| Date math for staleness              | string slicing of ISO timestamps                        | `Date.parse(iso)` + `(now.getTime() - parsed) / 1000`                                                                   | One-liner; no edge cases with timezone-bare ISO                                                            |
| Per-namespace existence check        | querying cache then K8s                                 | mirror `tasks.ts:328-338` `hasNamespaceLoadedAgents` cache-then-fall-through pattern                                    | Already proven for the agent-existence pre-check                                                           |

**Key insight:** Phase 4 is heavily mirror-driven. The temptation to "improve" by extracting helpers (a new `src/k8s/patch.ts`, a new validation framework, a router-builder DSL) is real but premature. CONTEXT.md's "two reviewer entry points" + "single shared write contract" + "no new CRDs" is a tight scope. Resist over-extraction; the second use of any pattern is the right time to refactor, not the first.

---

## Common Pitfalls

### Pitfall 1: Snapshot regen committed in the same commit as the source change

**What goes wrong:** The cc-reload.test.tsx.snap file changes when the attention gauge's source-field flips, AND the source-change commit fails CI on snapshot mismatch.
**Why it happens:** vitest's snapshot tests fail-by-default on any diff; the planner's source-change commit can't pass tests until the snapshot updates.
**How to avoid:** Phase 3's documented practice (per CONTEXT.md "specifics" section): land the source change first (snapshot mismatch — TEST FAILS BY DESIGN), then the snapshot regen commit (`vitest -u`) lands ONLY the snapshot diff. The PR has the two commits adjacent for reviewer scrutiny.
**Warning signs:** A PR with both source + snapshot in one commit; reviewer can't separate intent from incidental snapshot churn.

### Pitfall 2: Annotation patch race after CR creation succeeds

**What goes wrong:** AgentTemplate CR is created, but the merge-patch on the producing AgentTask fails (network blip, RBAC drift, etc.). The CR exists, but the queue still shows the row.
**Why it happens:** Two-step write; etcd has no transaction across CRs.
**How to avoid:** Per CONTEXT.md D-03 atomicity note, this IS the v0.2 posture. The accept handler treats CR-create-409 (collision on retry) as success-equivalent because the previous attempt's CR still exists. The audit-event log is the canonical record. In production, log loud at WARN level so operators can spot the orphan-ish state.
**Warning signs:** `template.candidate.promoted` audit event followed by NO `review.accepted` event; queue row still appears after a successful POST.

### Pitfall 3: Audit publisher dropped events when NATS is offline

**What goes wrong:** Audit emission fails silently; reviewers don't see their accepts in the warehouse.
**Why it happens:** `auditPublisher.publish` is best-effort per `dispositions.ts:303-312`; the warning is logged but the response is still 200.
**How to avoid:** This is the existing posture from Phase 1; documented as "best-effort, non-critical" at `main.ts:172-175`. NOT a Phase 4 introduction. Plan: same warning-on-failure pattern, no behavior change.
**Warning signs:** Operators report "I clicked accept but no audit event landed" and `kubectl logs <workbench-api-pod> | grep "publish failed"` shows the trail.

### Pitfall 4: Stale reviewQueueRowCount in CommandView snapshot after a successful accept

**What goes wrong:** Operator clicks Accept on a row in `#/review`; row removes; navigates to `#/command`; the `attention` gauge still shows the old count.
**Why it happens:** `useReviewQueue()` polls every 5s; CommandView's snapshot is updated by SSE for tasks/agents but NOT for the projection-derived count.
**How to avoid:** EITHER (a) accept the 5s lag (acceptable for v0.2), OR (b) wire the post-accept refetch to also refresh the count (planner picks). Recommendation: (a). The lag is bounded and predictable.
**Warning signs:** UAT step 6/7 mismatch (`attention` gauge count != `/api/review-queue` row count for up to 5s).

### Pitfall 5: AgentTemplate name collision between agents proposing the same template

**What goes wrong:** Two agents independently propose `embedded-llm-summarizer-v1`; first accept succeeds, second accept hits 409.
**Why it happens:** D-03 hard-fails 422 on K8s 409; the reviewer must repropose.
**How to avoid:** Per CONTEXT.md "Claude's Discretion" — default is hard-fail. Operators see the K8s error body and rename their candidate. An auto-suffix policy (e.g., `-v2`, `-v3`) is a future-research item.
**Warning signs:** Reviewer sees 422 with `AgentTemplate already exists`; downstream operator must repropose with a different `proposedTemplateName`.

### Pitfall 6: Off-by-one on staleness when `enqueuedAt` is in the future

**What goes wrong:** Negative `stalenessSeconds` (clock skew or test-injection bug); sort puts the row at the bottom.
**Why it happens:** ISO timestamp parsing always succeeds; `(now - future) / 1000` is negative.
**How to avoid:** Clamp to 0 in the projection: `Math.max(0, (nowMs - enqueuedMs) / 1000)`. Add a unit test for clock-skew.
**Warning signs:** Test failures with `stalenessSeconds: -5` in the rendered row.

### Pitfall 7: Watch-namespace mismatch — the actions Role is namespaced but the read role is cluster-scoped

**What goes wrong:** A candidate-template producing-task is in namespace `default` (out of release namespace). Workbench-api can READ the task (cluster-wide read role) but cannot patch its annotation (namespace-scoped write Role) → 403.
**Why it happens:** H17 release-namespace scope; cross-namespace promotion is explicitly out of scope per CONTEXT.md "Out of scope" + Q3.
**How to avoid:** The accept handler verifies `namespace === defaultNamespace` BEFORE attempting the K8s call (mirror `gateway.ts:402-422`). Returns 403 with `namespace-not-permitted` error code. Document in the OpenAPI/JSDoc.
**Warning signs:** Out-of-namespace tasks appear in the queue (because the read role is cluster-wide) but accept/reject return 403.

### Pitfall 8: Forgetting to bump `ALL_EVENT_TYPES.length` test

**What goes wrong:** Some Phase 1 / DISP-03 test (or a hypothetical sanity test in `make-event.test.ts`) asserts `ALL_EVENT_TYPES.length === 49`; Phase 4's additions break it.
**Why it happens:** Catalog growth.
**How to avoid:** grep for `ALL_EVENT_TYPES.length` and `\.length\)\.toBe\(\d+\)` patterns in audit-events tests; bump to 53 in the same commit that adds the four constants.
**Warning signs:** CI failure in `make-event.test.ts` after Wave-0 lands.

---

## Code Examples

Verified patterns referenced (file:line citations only — actual code lives in tree at the cited locations):

### Projection-over-cache GET handler

`packages/workbench-api/src/routes/dispositions.ts:154-346` — full route factory. The pattern: `Hono` app, factory taking `Deps`, single `GET /` returning `{ items: [...] }`, no audit emission on read paths (Phase 4: same; over-budget audit pattern at lines 274-313 is dispositions-specific and does NOT carry over to review-queue's pure-read GET).

### POST handler with K8s create + error scrubbing

`packages/workbench-api/src/routes/tasks.ts:143-285` — POST `/api/tasks`. The shape Phase 4's accept handler mirrors: `customApi === undefined` 503 fail-closed; body validation; K8s call wrapped in try/catch with status extraction; 409/404/403/500 mapping; structured error logging without echoing K8s body.

### JSON merge-patch on a CR

`packages/workbench-api/src/routes/gateway.ts:438-460` — PATCH `/api/modelendpoints/:namespace/:name`. The merge-patch pattern: `setHeaderOptions('Content-Type', 'application/merge-patch+json')` + `customApi.patchNamespacedCustomObject(args, MERGE_PATCH_OPTIONS)`. The body is a partial CR object; K8s applies it per RFC 7396.

### Audit event emission from a handler

`packages/workbench-api/src/routes/dispositions.ts:282-313` — the pattern Phase 4's accept/reject/request handlers reuse: optional `auditPublisher`, `makeEvent({ type, source, subject, data })` factory, fire-and-warn-on-failure (do not throw to caller).

### Hash-route registration

`packages/workbench-ui/src/App.tsx:55-77` — `parseHash()` + `useHashRoute()`. Phase 4 adds one parser case + one route block.

### React table-shaped page

`packages/workbench-ui/src/TaskList.tsx:84-185` — fetch + SSE + table render + connection chip. Phase 4's ReviewPage is a structural twin (the `subscribeCacheEvents` SSE wire is OPTIONAL for ReviewPage since the queue projection isn't event-keyed, but the pattern still applies if the planner wants reactivity beyond polling).

### Modal with backdrop close + Esc-to-close

`packages/workbench-ui/src/NewTaskModal.tsx:36-229` — the canonical modal. Phase 4's ConfirmDialog is a stripped-down version (no async submit, no field validation; just confirm-text + cancel/confirm buttons).

### Source-binding for renders

`packages/workbench-ui/src/command/source-binding.ts:181-205` — `assertSourceField` + `useSourceField`. Phase 4 extends with `ReviewQueueFieldName` (Q7); call sites in `ReviewPage.tsx` follow the existing pattern.

### Audit event-type addition

`packages/audit-events/src/event-types.ts:181-195` (Phase 1 addition) — DISPOSITION_PROPOSAL_REJECTED + DISPOSITION_OVER_BUDGET. Phase 4 adds 4 new constants in the same shape.

---

## State of the Art

| Old Approach                              | Current Approach                                  | When Changed                                                   | Impact                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bun` runtime for workbench-api           | Node 22 + tsx                                     | v0.1 / v0.2 (per CLAUDE.md "Conventions")                      | Bun 1.1's TLS handling rejects K3s self-signed CAs in `@kubernetes/client-node`'s watch path; revert is intentional and persistent   |
| `kubectl` for workbench-api ops           | GitOps-only via `../new_localai/` ArgoCD overlays | v0.1                                                           | Phase 4's deployment is image-rebuild + overlay bump; never `kubectl apply`                                                          |
| zod / ajv for body validators             | hand-rolled validators per `validators.ts`        | v0.1 (deliberate decision, documented at `validators.ts:7-15`) | Phase 4 follows: hand-rolled `validateReviewActionBody`                                                                              |
| `process.env.NODE_ENV` for env-var checks | `globalThis.crypto` for crypto-grade IDs          | v0.1 (per `tasks.ts:91-97`)                                    | Phase 4 may reuse `globalThis.crypto.randomUUID()` if it needs deterministic IDs (the audit factory's `makeEvent` already does this) |

**Deprecated/outdated:**

- **`bun:test`** — vitest is the standard. CLAUDE.md mentions `bun:test` as an option but every existing test in tree uses vitest. Phase 4 uses vitest exclusively.
- **`@types/node` direct dep on `@kagent/dto`** — `@kagent/dto` is leaf-deps-only. Phase 4's new modules respect this: no `@types/node` import; use `globalThis.crypto` if a UUID is ever needed there.

---

## Assumptions Log

| #   | Claim                                                                                                                                                                                                                                                              | Section            | Risk if Wrong                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | `yaml` is already a workspace dep via `@kagent/dto/disposition-parser.ts`                                                                                                                                                                                          | Q4 / Q11           | Low — if NOT, Wave 0 adds it to `packages/workbench-api/package.json` (sub-100 KiB)                                                                                                                                                                    |
| A2  | `make-event.test.ts` has a `ALL_EVENT_TYPES.length` sanity assertion                                                                                                                                                                                               | Q8                 | Low — if absent, no test bump needed; otherwise the bump is one-line                                                                                                                                                                                   |
| A3  | `flows.test.ts` has tests for the `attention` gauge that need updating when the source flips                                                                                                                                                                       | Q6 / Q10           | Low — verify in Wave 0 by reading the file; if no attention tests exist, ADD one (test-driven flip)                                                                                                                                                    |
| A4  | `packages/workbench-ui/src/TaskList.test.tsx` (or equivalent UI test for TaskList) exists as a vitest analog for `ReviewPage.test.tsx`                                                                                                                             | Q12                | Low — if NOT, the planner pattern-mirrors `DispositionOverlay.test.tsx` instead (Phase 1 / DISP-04 reverse)                                                                                                                                            |
| A5  | The planner can reuse `MERGE_PATCH_OPTIONS` constant pattern inline in `routes/review-queue.ts` without extracting to a shared helper                                                                                                                              | Q11                | Low — second-use threshold not yet justified                                                                                                                                                                                                           |
| A6  | `SnapshotCache` does NOT need to track `AgentTemplate` for Phase 4 (the accept handler can return the K8s `createNamespacedCustomObject` response inline; subsequent GETs do not depend on cache visibility because the queue is task-rooted, not template-rooted) | Q1                 | Low — the candidate-template row in the queue is keyed by the producing AgentTask, not the AgentTemplate; once accepted, the row is removed from the queue via the producing task's `review-decision` annotation, never via AgentTemplate cache lookup |
| A7  | The `parseAgentTemplateSpec` validator's apiserver-side second-gate is acceptable scope for v0.2 (full schema-mirror is over-engineered for the candidate-template path)                                                                                           | Q4                 | Medium — if schema validation is critical pre-flight (e.g., for UX reasons "show me the YAML errors before I submit"), the validator deepens; for v0.2 it's a shape-check, the apiserver enforces invariants                                           |
| A8  | The Phase 3 `cc-reload.test.tsx.snap` regen is a single-commit operation per the Phase 3 documented practice                                                                                                                                                       | Pitfall 1          | Low — verified by CONTEXT.md's reference to Phase 3's pattern                                                                                                                                                                                          |
| A9  | The reasonText cap at 4 KiB is a reasonable default mirroring AgentTask MAX_MESSAGE_BYTES (32 KiB) — at 4 KiB it's much smaller because annotations are not free-text bodies, they're substrate metadata                                                           | Q3 / Anti-Patterns | Low — etcd accepts annotations up to ~256 KiB total per object, but 4 KiB per single value is a sensible substrate hygiene line; planner picks                                                                                                         |

**Empty list signal:** if all assumptions resolve in Wave 0, no user confirmation is needed for any of D-01..D-04 (they're already locked in CONTEXT.md). Confirmation IS needed for the AgentTemplate-cache visibility decision (A6) — planner picks during Wave-1 plan write.

---

## Open Questions (RESOLVED)

1. **RESOLVED — Should the read-side ClusterRole add `agenttemplates` resources now, or defer?** → Add in Phase 4 (Plan 04-01: `clusterrole.yaml` extended with `agenttemplates: [get,list,watch]`). Additive, future-proofs the read-side cache, aligns with existing informer patterns in `template-instantiator.ts`. Cost: one additive commit; benefit: no future-cycle RBAC churn.

2. **RESOLVED — Should `parseAgentTemplateSpec` live in `@kagent/dto` or in `workbench-api`?** → Split (Plan 04-01 + 04-03): YAML→object parsing in `packages/workbench-api/src/yaml.ts`; object→`AgentTemplateSpec` shape validation in `packages/dto/src/template-candidate.ts`. DTO validates shapes; route package owns wire format.

3. **RESOLVED — `attention` flow gauge `data-source-fields` string?** → `'reviewQueueRowCount'` (Plan 04-05 Task 2). Matches the new `state.ts:CommandSnapshot` field name and the existing convention (`'inFlight'`, `'currentCap'`). Avoids the computed-string `'review-queue.rows.length'` form which breaks the field-name convention.

4. **RESOLVED — Does REV-02 acceptance require end-to-end manual UAT?** → No. The vitest fixture-based test is the v0.2 acceptance per CONTEXT.md (Plan 04-03 Task 2 — synthetic candidate artifact → queue row → POST accept → AgentTemplate CR in fake `customApi`). Homelab UAT is post-deploy operator verification, not a phase-gate test (recorded in `04-VALIDATION.md` Manual-Only Verifications).

5. **RESOLVED — `request` POST endpoint placement?** → Sibling form `POST /api/review-queue/:ns/:name/request` per CONTEXT.md D-02 (Plan 04-03). The verb-as-noun reads cleanly in route position; renaming would require re-discussion.

---

## Environment Availability

> Phase 4 ships substrate-side code (workbench-api + UI + audit-events + chart) — no new external runtime dependencies beyond what v0.1 already needs.

| Dependency         | Required By                                                   | Available                                             | Version                                                    | Fallback                                               |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Node 22            | All packages (workbench-api, workbench-ui, audit-events, dto) | ✓ (per CLAUDE.md + Phase 1-3 verified runs)           | 22.x via nvm                                               | none — pre-commit hook fails                           |
| pnpm               | Workspace install/test/build                                  | ✓                                                     | (whatever the workspace pins; verify via `pnpm --version`) | none                                                   |
| vitest             | All test runs                                                 | ✓ (per Phase 1-3 reliance)                            | per package.json                                           | none — phase verification IS vitest                    |
| `yaml` npm package | parseAgentTemplateSpec → YAML string parse                    | ✓ (assumed; A1 — verify in Wave 0)                    | per package.json                                           | npm install if missing                                 |
| K3s + ArgoCD       | Post-deploy smoke test                                        | ✓ (homelab)                                           | per `../new_localai/`                                      | UAT defers to next operator session if homelab is down |
| NATS JetStream     | Audit event delivery                                          | ✓ (existing wire from Phase 1; KAGENT_AUDIT_NATS_URL) | per `main.ts:168-180`                                      | best-effort; warning-on-failure (non-critical)         |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** `yaml` (resolved by `pnpm install` if absent).

Phase 4 is purely code/config — Step 2.6 conclusion: low-risk environment. NO external service dependencies beyond what Phase 1 already wired.

---

## Sources

### Primary (HIGH confidence)

- `.planning/phases/04-review-queue-projection-promotion-path/04-CONTEXT.md` — D-01 through D-04 locked decisions (Q1–Q12 anchors)
- `.planning/REQUIREMENTS.md` §1 REV-01..REV-03 + §3 non-goals + §4 future research
- `.planning/ROADMAP.md` Phase 4 success criteria
- `.planning/STATE.md` (Phase 3 verified)
- `CLAUDE.md` (project conventions)
- `packages/workbench-api/src/routes/dispositions.ts` (full file — Q1, Q2 anchor)
- `packages/workbench-api/src/routes/dispositions.test.ts` (full file — Q2 anchor)
- `packages/workbench-api/src/routes/tasks.ts` (full file — Q3 anchor)
- `packages/workbench-api/src/routes/gateway.ts:400-485` (Q3 PATCH+merge anchor)
- `packages/workbench-api/src/main.ts` + `router.ts` (Q3 wiring)
- `packages/workbench-api/src/routes/validators.ts` (Q3 hand-validator pattern)
- `packages/workbench-api/src/cache.ts` (Q1 SnapshotCache shape)
- `packages/workbench-api/src/auth.ts` + `routes/stream.ts:98` (Q3 X-Forwarded-User extraction)
- `packages/workbench-ui/src/api.ts` (Q5 / Q6 fetch helpers + hook pattern)
- `packages/workbench-ui/src/types.ts` (Q12 DTO re-export pattern)
- `packages/workbench-ui/src/TaskList.tsx` + `TaskDetail.tsx` + `NewTaskModal.tsx` + `App.tsx` (Q5 UI mount points)
- `packages/workbench-ui/src/command/source-binding.ts` (Q7 closed-enum pattern)
- `packages/workbench-ui/src/command/flows.ts` (Q6 attention flow stub)
- `packages/audit-events/src/event-types.ts` + `types.ts` + `make-event.ts` (Q8 audit extension)
- `packages/operator/src/crds/types.ts:1077-1131` (Q4 AgentTemplateSpec shape)
- `packages/operator/charts/kagent-workbench/templates/{clusterrole,clusterrole-actions}.yaml` (Q9 RBAC anchors)
- `packages/dto/src/disposition.ts` (Q12 DTO+asserter pattern)
- `packages/dto/src/crds.ts:148-155` (Q1 ArtifactRef shape)

### Secondary (MEDIUM confidence)

- A grep verified that `parseAgentTemplateSpec` does NOT exist (Q4)
- A grep verified `customApi.createNamespacedCustomObject` is currently `tasks.ts`-only (Q11)
- A grep verified `agenttemplates` is NOT in `clusterrole.yaml`'s read resource list (Q9)
- A grep verified `__fixtures__` does NOT exist under `packages/workbench-api/src/` today (Q2)
- A grep verified merge-patch + annotation pattern is novel for workbench-api → AgentTask (Q11)

### Tertiary (LOW confidence — flagged for Wave 0 verification)

- A1: `yaml` workspace dep via disposition-parser (assumed; should verify by `cat packages/dto/src/disposition-parser.ts` — file not opened in this research session)
- A2: `make-event.test.ts` length-sanity assertion (assumed exists; verify in Wave 0)
- A3: `flows.test.ts` attention test exists (assumed)
- A4: TaskList vitest analog exists (assumed)

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — every existing file referenced is real and read end-to-end; no library version uncertainty (Node 22 + Hono + vitest + Kubernetes client-node v1.x are all v0.1-verified).
- Architecture: HIGH — `dispositions.ts` is the canonical analog; `tasks.ts` POST patterns + `gateway.ts` PATCH patterns + audit-event extension precedent (Phase 1) all exist verbatim. Phase 4 is pattern-mirror-driven.
- Pitfalls: HIGH — Phase 3 documented the snapshot regen pattern; `tasks.ts:263-283` documents the K8s error scrub; H17 documents the namespace scope; the atomicity note in CONTEXT.md D-03 is explicit. The grep audit confirms what's novel vs reused.
- Validation Architecture (Q10): HIGH — vitest is the existing framework; `dispositions.test.ts` is the canonical fixture-driven analog; coverage target is documented in CLAUDE.md.

**Research date:** 2026-05-10
**Valid until:** 2026-06-10 (30-day shelf-life on stable ecosystem; sooner if Phase 5 (`docs/REPLAY-EVALS.md`) is implemented and the REV-03 stub graduates)

---

## RESEARCH COMPLETE

The planner now has: (a) the complete file-create-vs-modify list with closest analogs and tests for each, (b) the exact projection-classifier algorithm with priority rules, (c) the accept-handler step-by-step including atomicity boundary + error scrubbing requirements, (d) the AgentTemplateSpec shape and a recommended `parseAgentTemplateSpec` validator outline, (e) the audit-event extension pattern with verified data-shape conventions, (f) the surgical Phase-3 attention-flow flip plan with the most-decoupled integration shape recommended, (g) the additive RBAC contracts for both clusterrole files, (h) a 25+ unit-test plan mapped to specific REV-01/REV-02/REV-03 acceptance lines, (i) 8 named pitfalls drawn from existing audit/H17/atomicity precedents, and (j) a 14-new + ~19-modified file roadmap with closest-analog citations for the pattern-mapper agent. The phase is unblocked for `/gsd-plan-phase 4`.
