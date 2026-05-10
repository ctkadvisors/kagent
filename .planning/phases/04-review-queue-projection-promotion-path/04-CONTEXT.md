# Phase 4: Review queue projection + promotion path — Context

**Gathered:** 2026-05-10
**Status:** Ready for planning
**Mode:** discuss-phase, "follow best 'recommended' suggestions" — Claude proposed 4 gray areas (projection shape, human-review-requested signal, candidate-template + accept/reject write path, replay/eval signal scope); user accepted recommended option in each. The user has authority to override any decision below before/during planning.

> **Critical framing.** Phase 4 ADDS the first server-side review surface to workbench-api. Phases 1–3 hardened the read side of Command Center via UI-side derivation (overlays, gauges); Phase 4 introduces a **new `/api/review-queue` projection** (mirroring `/api/dispositions` from DISP-03), the first **annotation-driven write path** (mirroring DISP-02's overlay narrowing pattern), the first **AgentTemplate CR creation from workbench-api** (extending the existing chart actions Role), and a new dedicated `#/review` UI route. **No new CRDs (D2).** Candidate AgentTemplates live as ArtifactRef-shaped blobs at rest; promotion is the explicit governance gate (D3 / D6: signals propose, governance disposes; agents propose, substrate or human governance promotes). The review queue is reload-stable: GET `/api/review-queue` reconstructs the same rows on reconnect; no client-side state drives the queue. Phase 3's `attention` flow stub (D-02-attention) **flips here** — same `FlowGauge` shape, the `compute()` body now reads from the new projection instead of the v0.2 proxy.

<domain>
## Phase Boundary

**In scope (Phase 4 delivers):**

1. **REV-01 — Server-side review queue projection over existing substrate state.**
   - New `packages/workbench-api/src/routes/review-queue.ts` route exposing `GET /api/review-queue` returning `ReviewQueueRow[]` sorted by staleness (oldest first).
   - New `ReviewQueueRow` DTO in `@kagent/dto/review-queue.ts` (re-exported from the workbench-ui types like `DispositionOverlayRow` per Phase 1's pattern). Shape:
     ```ts
     export interface ReviewQueueRow {
       readonly taskRef: {
         readonly namespace: string;
         readonly name: string;
         readonly uid: string;
       };
       readonly reason: ReviewReason; // closed enum, see below
       readonly reasonDetail: string; // structured: failed flag names, error string, or 'human-review-requested by <id>'
       readonly enqueuedAt: string; // earliest signal among contributing audit events / status timestamps
       readonly stalenessSeconds: number; // computed at request time: now - enqueuedAt
       readonly phase: AgentTaskPhase;
       readonly targetAgent?: string;
       readonly model?: string;
       readonly suspicious?: readonly string[]; // copied from pilotEvidence.structuralVerdict.suspicious
       readonly verifierError?: string; // pilotEvidence.verification.reason when passed === false
       readonly traceLink?: string; // Langfuse deep link if known
       readonly artifactCount?: number;
       readonly candidateTemplate?: {
         // present only when reason='candidate-template'
         readonly artifactRef: ArtifactRefSummary;
         readonly proposedTemplateName: string;
         readonly proposedNamespace: string;
       };
       readonly replayDivergence?: {
         // reserved for Phase 5+, zero rows in v0.2
         readonly originalRunId: string;
         readonly divergenceKind: string;
       };
     }
     export type ReviewReason =
       | 'verifier-failed'
       | 'suspicious-detector'
       | 'human-review-requested'
       | 'candidate-template'
       | 'replay-divergence' // Phase 5+ stub; zero v0.2 producers
       | 'eval-failed'; // Phase 5+ stub; zero v0.2 producers
     ```
   - **Sort:** descending by `stalenessSeconds` (oldest first per REV-01).
   - **Pagination:** none in v0.2 (homelab scale; mirror `/api/dispositions`'s no-pagination posture). Add cursor-based later when row count repeatedly exceeds ~50.
   - **Reload-stability:** the route is pure read over `SnapshotCache` + audit-event SSE last-known-state; no server-side mutable queue state. GET twice returns the same shape (modulo `stalenessSeconds` re-computation).
   - **UI consumption:** new `useReviewQueue()` hook in `packages/workbench-ui/src/api.ts` (mirrors `fetchDispositions`). NOT a `useCommandSnapshot()` extension — review queue is its own page with its own polling cadence. Phase 3's `attention` `FlowGauge` flips to call `useReviewQueue()`'s row-count instead of the proxy; `flows.ts` `compute()` body changes ~10 lines, the `FlowGauge` shape stays identical.

2. **REV-02 — AgentTemplate promotion proposal flow (single-reviewer, end-to-end).**
   - **Candidate AgentTemplate carrier:** an `ArtifactRef` produced by an agent task whose result yields a YAML payload conforming to `AgentTemplateSpec`. The producing AgentTask carries an annotation `kagent.knuteson.io/template-candidate: "true"` so the projection finds it via informer scan. Artifact media type: `application/x-kagent-template-candidate+yaml` (new media type, documented in `docs/AGENT-TEMPLATES.md` footer).
   - **Producers in v0.2:** zero required producers ship with this phase. The v0.1 substrate already permits agents whose DISP-02 `proposalScope.mayProposeAgainst: ['templates']` to emit a templates-shaped artifact; Phase 4 wires the **review/promotion side** so when those producers exist the path is real. A vitest fixture-based test demonstrates end-to-end (synthetic candidate artifact → queue row → POST accept → AgentTemplate CR created in fake K8s client) — that is the v0.2 acceptance.
   - **Reviewer write surface:** new `#/review` route in `packages/workbench-ui/src/`. New `ReviewPage.tsx` mirrors `TaskList.tsx` shape; renders `ReviewQueueRow[]` with per-row actions: Accept / Reject / Open Detail. Inline `ReviewActions` component also lands inside `TaskDetail.tsx` for tasks whose `phase=Failed` / `suspicious !== empty` / `review-requested=true` so the operator can act from the detail page without leaving.
   - **POST contracts:**
     - `POST /api/review-queue/:namespace/:name/accept` — body `{ reviewerId?: string; reasonText?: string }`. Server:
       - Writes annotation `kagent.knuteson.io/review-decision: "accepted"` + `review-decided-by` + `review-decided-at` to the AgentTask via PATCH (JSON merge-patch).
       - For `reason='candidate-template'` rows: ALSO creates an `AgentTemplate` CR via `customApi.createNamespacedCustomObject(...)` with rendered YAML; sets `metadata.ownerReferences = [<producing AgentTask>]`; sets `metadata.annotations['kagent.knuteson.io/promoted-from-task'] = '<ns>/<name>'`. If creation fails (409 conflict, validation error), responds 422 with the K8s error body and does NOT write the accept annotation (atomic-ish — annotation-write is the second step so a partial create+failed-annotate leaves the CR but the queue row stays until next request retries).
       - Emits audit event: `review.accepted` (always) + `template.candidate.promoted` (when reason='candidate-template'). New types added to `@kagent/audit-events`.
     - `POST /api/review-queue/:namespace/:name/reject` — body `{ reviewerId?: string; reasonText?: string }`. Server: writes annotation `kagent.knuteson.io/review-decision: "rejected"` + companions. Emits `review.rejected` audit event.
   - **Single-reviewer:** no quorum, no signed proposals, no chain-of-custody. Multi-reviewer is future research per REQUIREMENTS.md §4 (`CoalitionProposal`).
   - **RBAC:** extend `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` with `agenttasks: [patch]` (annotation writes) and `agenttemplates: [create]` (promotion). Both scoped to release namespace per H17 (matches the existing `agenttasks: [create]` posture). An install with `actions.create=false` stays provably review-write-proof — same convention as POST `/api/tasks` (`packages/workbench-api/src/main.ts:89-103`).

3. **REV-03 — Replay/eval signals folded into the same queue (forward-compatible stub).**
   - The `ReviewReason` enum reserves `replay-divergence` and `eval-failed`. **v0.2 producers: zero** for both. The verifier path already produces `verifier-failed` rows and the agent-loop detectors already produce `suspicious-detector` rows — those cover the bulk of what REQUIREMENTS.md REV-03 calls "replay/eval signals" today, but under more honest naming (the verifier's output IS the eval; the detectors ARE the eval).
   - **Why a forward-compatible stub:** `docs/REPLAY-EVALS.md` is **Phase 5 design, pre-implementation** as of 2026-05-10. `AgentTaskRun` and `ReplaySet` CRDs do **not** exist; `@kagent/eval` package does not exist. Trying to ship real replay-divergence detection in v0.2 would either (a) require a new CRD (forbidden by D2) OR (b) require new substrate primitives that are themselves a multi-phase Phase-5+ effort.
   - **Inline projection comment** (from `pressure.ts` / `flows.ts` documentation pattern):
     ```ts
     // REV-03: replay-divergence and eval-failed reasons are reserved for
     // AgentTaskRun + @kagent/eval (docs/REPLAY-EVALS.md, Phase 5 design,
     // pre-implementation as of 2026-05-10). v0.2 producers: zero. Promote
     // when AgentTaskRun ships and the eval reducer emits divergence audit
     // events. Until then verifier-failed + suspicious-detector cover what
     // REQUIREMENTS.md REV-03 calls 'replay/eval signals' today.
     ```
   - **Navigate-to-artifact (REV-03 acceptance):** for `verifier-failed` and `suspicious-detector` rows the queue row's `traceLink` (when present) opens the Langfuse trace; the inline `pilotEvidence.verification.reason` / `pilotEvidence.structuralVerdict.suspicious` fields are visible on TaskDetail. When AgentTaskRun lands, the same row's `traceLink` flips to point at the Run-level tape ArtifactRef — no `ReviewQueueRow` shape change required.

**Out of scope for Phase 4 (locked exclusions):**

- Any new CRD (per D2). `ReviewRequest`, `TaskReview`, `Channel`, `Post` are explicit non-goals (REQUIREMENTS.md §3); `AgentTaskRun` / `ReplaySet` are Phase 5+ design.
- Multi-reviewer flows (quorum, signed proposals, no-self-review, ring-review detection). Future research per REQUIREMENTS.md §4 (`CoalitionProposal` row).
- Real replay-divergence detection. v0.2 ships the enum slot only; producers are Phase 5+ work per `docs/REPLAY-EVALS.md`.
- A consolidation controller proposing hygiene actions automatically. Future research per REQUIREMENTS.md §4 row "Consolidation controller — defer until manual review queue ergonomics prove what hygiene means."
- Decay / revalidation policy on review-queue rows (auto-staleness expiry beyond the staleness sort). Future research per REQUIREMENTS.md §4 NFR row "Decay / revalidation policy."
- Any Workbench/Command Center change beyond mounting the new review-queue projection in Phase 3's `attention` flow `compute()` and adding a deep-link from the AgentPanel/TaskPanel to `#/review`. Slice C (construction mode) and Slice D (Tool Foundry) remain deferred per `COMMAND-CENTER-CONTRACT.md` §7 ordering.
- A new write surface that lets agents WRITE the `kagent.knuteson.io/review-requested` annotation (D6: agents propose, governance promotes). v0.2 writers are workbench-api operators only; agent-side proposal of review-flag is future research.
- Bulk-accept / bulk-reject. Phase 5 / WB-02 multi-select on Command Center sprites is read-only ("bulk-mutate actions remain forbidden until the underlying CRD write path explicitly supports the operation"); review-queue inherits the same posture — single-row accept/reject only.
- `reviewerId` enforcement / authentication. v0.2 trusts `X-Forwarded-User` header same as the existing actions surface; H17 audit acknowledges this is spoofable but scoped to release-namespace only. Real reviewer-identity is future research bound to the same auth-hardening track.
- A web hook / push notification when a row is enqueued. Operators poll `/api/review-queue` (or watch the SSE audit-event stream for `review.requested` / new `task.failed` events). Real push delivery is future work.
- Renaming / deprecating any existing endpoint (`/api/tasks`, `/api/dispositions`, etc.). All Phase 4 additions are additive.

</domain>

<decisions>
## Implementation Decisions (locked for this phase, all "recommended" — user has authority to override)

### D-01: Review-queue projection shape — server-side `/api/review-queue` route + DTO

**Decision (D-01-A): Ship a new `packages/workbench-api/src/routes/review-queue.ts` route exposing `GET /api/review-queue` returning `ReviewQueueRow[]` sorted by descending staleness. New `ReviewQueueRow` DTO in `@kagent/dto`. UI consumes via new `useReviewQueue()` hook.**

- **Module shape (mirrors `routes/dispositions.ts`):**
  - File: `packages/workbench-api/src/routes/review-queue.ts`. Route registered in `router.ts` alongside `dispositions`.
  - Computation: pure projection over `SnapshotCache` + audit-event last-known-state. For each `AgentTask` in cache:
    1. If `metadata.annotations['kagent.knuteson.io/review-decision']` is set → SKIP (already reviewed).
    2. If `pilotEvidence.verification?.passed === false` → emit row with `reason='verifier-failed'`, `reasonDetail=pilotEvidence.verification.reason ?? 'verifier failed'`, `enqueuedAt=pilotEvidence.verification.completedAt ?? task.status.completedAt ?? task.metadata.creationTimestamp`.
    3. Else if `pilotEvidence.structuralVerdict.suspicious.length > 0` → emit row with `reason='suspicious-detector'`, `reasonDetail=suspicious.join(', ')`, `enqueuedAt=task.status.completedAt ?? creationTimestamp`.
    4. Else if `metadata.annotations['kagent.knuteson.io/review-requested'] === 'true'` → emit row with `reason='human-review-requested'`, `reasonDetail='requested by ' + (annotations['kagent.knuteson.io/review-requested-by'] ?? 'unknown')`, `enqueuedAt=annotations['kagent.knuteson.io/review-requested-at'] ?? creationTimestamp`.
    5. Else if `metadata.annotations['kagent.knuteson.io/template-candidate'] === 'true' && task.status.phase === 'Completed'` → emit row with `reason='candidate-template'`, populate `candidateTemplate` from the producing task's first artifact whose `mediaType === 'application/x-kagent-template-candidate+yaml'`.
  6.  Sort by `stalenessSeconds = (now - enqueuedAt) / 1000` descending. Compute at request time.
  - The classifier returns `at most one` row per task (priority: verifier-failed > suspicious > review-requested > candidate-template). A task can't double-enqueue; the most-load-bearing reason wins.
- **DTO shape:** export `ReviewQueueRow` + `ReviewReason` from `@kagent/dto/review-queue.ts`. Re-export from `packages/workbench-ui/src/types.ts` per Phase 1 / DISP-04 pattern (`DispositionOverlayRow`).
- **UI consumption:** new `useReviewQueue()` hook in `packages/workbench-ui/src/api.ts` (mirrors `fetchDispositions`). Polls every 5s by default (mirrors `/api/dispositions`'s polling cadence — UI implementation detail; planner picks). Returns `{ rows, loading, error, refresh }`. NEW `ReviewPage.tsx` consumes this hook directly. Phase 3's `attention` flow gauge `compute()` body changes from `Array.from(snapshot.tasks.values()).filter(t => t.phase === 'Failed' || (t.suspicious?.length ?? 0) > 0).length` to a proxy that reads `reviewQueue.rows.length` from a new shared `useReviewQueue()` hook OR — to avoid lifecycle coupling — Phase 4 adds a tiny `useReviewQueueRowCount()` hook that fetches just the count and `flows.ts` `attention.compute()` consults a snapshot-level proxy that mirrors the same query. Planner picks the cleanest integration; default: a separate count fetch in CommandView paired with a small `flows.ts` interface change to accept the count as a prop on `compute()`. This is the ONLY Phase 3 callback Phase 4 carries.
- **Reload-stability test:** new `review-queue.test.ts` mirrors `dispositions.test.ts`'s shape — fixture in `packages/workbench-api/src/__fixtures__/review-queue-snapshot.json` with one of each reason; reload simulates a fresh fetch and asserts identical row content modulo `stalenessSeconds` advance.
- **No `/api/review-queue` POST.** Accept/reject use namespaced sub-paths (D-03), keeping the GET surface pure-read.

**Reasoning:** REV-01 explicitly says "in workbench-api" — server-side computation. The closest analog is `/api/dispositions` (Phase 1 / DISP-03 — "computed projection over existing telemetry; no new persistence"); mirroring it keeps the read-side architecture coherent. UI-side derivation was rejected because (a) the UI would need to consume the audit-event SSE just to compute staleness correctly, (b) Phase 5's `WB-01` "jump to review queue" hotkey expects a stable backend-mediated route, and (c) Phase 3's `attention` gauge stub explicitly delegates to "Phase 4's review queue projection" — UI-side classification would mean the stub doesn't actually flip to a substrate-mediated source. Folding into `/api/tasks?needsReview=true` was rejected because the projection joins task state + audit events + multiple annotation reads — keeping it on its own route mirrors how `/api/dispositions` handles its multi-source projection without bloating `/api/tasks`.

### D-02: Human-review-requested signal — annotation `kagent.knuteson.io/review-requested` + implicit signals

**Decision (D-02-A): Annotation on AgentTask is the authoritative substrate signal. Implicit signals (verifier-failed, suspicious-detector, candidate-template) ALSO produce queue rows automatically. Workbench-api operators can write the explicit annotation via a new `POST /api/review-queue/:namespace/:name/request` endpoint (NOT agents — D6).**

- **Annotation contract:**
  - Key: `kagent.knuteson.io/review-requested` (string, expected `"true"` or absent).
  - Companion keys: `kagent.knuteson.io/review-requested-by` (operator identity from `X-Forwarded-User`), `kagent.knuteson.io/review-requested-at` (ISO 8601 timestamp).
  - Decision keys (written on accept/reject per D-03): `kagent.knuteson.io/review-decision` (`"accepted" | "rejected"`), `review-decided-by`, `review-decided-at`. The presence of `review-decision` removes the row from the projection (D-01-A step 1).
- **Implicit signals (always produce rows when annotation is absent):** `pilotEvidence.verification.passed === false`, `pilotEvidence.structuralVerdict.suspicious.length > 0`, `metadata.annotations['kagent.knuteson.io/template-candidate'] === 'true' && phase === 'Completed'`.
- **POST contract:** `POST /api/review-queue/:namespace/:name/request` body `{ reasonText?: string }`. Server: PATCH the AgentTask with the `review-requested: "true"` + companion annotations. Emits new audit event `review.requested`. RBAC: requires the new `agenttasks: [patch]` verb in the chart actions Role.
- **Audit events introduced this phase** (added to `@kagent/audit-events/event-types.ts` + types.ts discriminated union):
  - `review.requested` — fires when an operator POSTs the request endpoint. `data: { taskRef, reviewerId?, reasonText? }`.
  - `review.accepted` — fires on accept. `data: { taskRef, reason, reviewerId?, reasonText? }`.
  - `review.rejected` — fires on reject. `data: { taskRef, reason, reviewerId?, reasonText? }`.
  - `template.candidate.promoted` — fires when accept-on-candidate-template creates the AgentTemplate CR. `data: { taskRef, agentTemplateRef: { namespace, name, uid }, reviewerId? }`.
- **Agent-side write of the annotation is OUT OF SCOPE.** Agents whose DISP-02 `proposalScope.mayProposeAgainst: ['templates']` declared can produce a `template-candidate` artifact, which surfaces via the implicit candidate-template signal — that IS the agent's proposal channel (D6). Agents do NOT directly write `review-requested: "true"` in v0.2; that's an operator-only verb.

**Reasoning:** Annotations are the lightest substrate primitive — no CRD, no controller, no schema migration. Implicit signals catch the common cases (verifier failed, detector flagged, candidate produced) without any operator action; the explicit annotation handles the "I want to look at this completed-clean task" case. Splitting "agents may flag for review" into a separate write path was rejected because (a) it violates D6 (agent self-promotion path), (b) it requires a new substrate proposal kind beyond DISP-02's locked `templates | verifiers | capability-policy` enum, and (c) candidate-template is already the agent's review-channel — that proposal kind already routes through this queue via the implicit `template-candidate` annotation on the producing task. A separate "needsReview" CRD was rejected per D2 ("defer CRDs until repeated behavior justifies one"). Pure-implicit (no annotation) was rejected because operators need a way to flag a Completed-clean task (e.g., for spot-audit) and there's no implicit signal that captures intent.

### D-03: Candidate-template + accept/reject write path — `#/review` page + inline TaskDetail panel + sub-path POSTs

**Decision (D-03-A): Two reviewer entry points (dedicated `#/review` page mirroring `TaskList`, plus inline `ReviewActions` in `TaskDetail`). Single shared write contract: `POST /api/review-queue/:namespace/:name/{accept,reject}`. Candidates carried as `ArtifactRef`-shaped blobs at rest; promotion creates the AgentTemplate CR atomically with the accept-write. Single-reviewer scope per REV-02.**

#### Candidate provenance (artifact-shape)

- A "candidate AgentTemplate" is an `ArtifactRef` produced by an agent task (any agent whose DISP-02 `proposalScope` allows `templates`). The producing AgentTask's `metadata.annotations['kagent.knuteson.io/template-candidate'] = 'true'` flags the row. The artifact's media type is `application/x-kagent-template-candidate+yaml` (new media type, document at `docs/AGENT-TEMPLATES.md` footer).
- The candidate YAML must conform to `AgentTemplateSpec` (the existing CRD type at `packages/operator/src/crds/types.ts:1103`). The acceptance handler validates by parsing the YAML and round-tripping through a Zod-style schema (planner picks: `@kagent/dto` may add a small `parseAgentTemplateSpec()` helper). Validation failures → 422 from accept endpoint.
- v0.2 ships **zero required producers**. The candidate path is wired so that when DISP-02-allowed agents start proposing templates the queue catches them. A vitest fixture-based test ("candidate-template happy path") synthesizes a producing task + artifact ref + reviewer accept → asserts AgentTemplate CR creation in a fake `customApi`. That fixture IS the v0.2 acceptance for REV-02.

#### Reviewer write surface (UI)

- New file: `packages/workbench-ui/src/ReviewPage.tsx` + `ReviewPage.module.css`. Hash route: `#/review`. Layout mirrors `TaskList.tsx` — table-shaped, sortable column headers, per-row "Open Detail" link to `#/tasks/<ns>/<name>`. Per-row Accept/Reject buttons with confirm dialog (mirror `NewTaskModal.tsx` modal pattern).
- New file: `packages/workbench-ui/src/command/ReviewActions.tsx` (small inline component) — mounts inside `TaskDetail.tsx` for tasks where `phase === 'Failed'` OR `suspicious.length > 0` OR `annotations['kagent.knuteson.io/review-requested'] === 'true'` OR `annotations['kagent.knuteson.io/template-candidate'] === 'true'`. Same Accept/Reject buttons, same confirm dialog, same audit footprint.
- New `App.tsx` route entry: `#/review` → `<ReviewPage />`.
- Each rendered row carries `data-source-field` per Phase 1/2's source-binding contract — new `ReviewQueueFieldName` closed enum extends `source-binding.ts`. `assertSourceField` calls protect every row field. CC-01-style orphan assertions fire in dev when a row is rendered without backing source data.

#### Reviewer write surface (workbench-api)

- New file: `packages/workbench-api/src/routes/review-queue.ts` registers three routes:
  - `GET /api/review-queue` — pure read (D-01).
  - `POST /api/review-queue/:namespace/:name/accept` — body `{ reviewerId?: string; reasonText?: string }`.
  - `POST /api/review-queue/:namespace/:name/reject` — body `{ reviewerId?: string; reasonText?: string }`.
  - `POST /api/review-queue/:namespace/:name/request` — body `{ reasonText?: string }` (D-02). Writes `review-requested: "true"` annotation.
- **Accept handler (the most load-bearing path):**
  1. Look up the AgentTask in cache. 404 if not found. 409 if `review-decision` annotation already set.
  2. If `reason='candidate-template'`: parse the candidate artifact YAML; validate against `AgentTemplateSpec`; call `customApi.createNamespacedCustomObject(...)` for the new `AgentTemplate` CR. On 409 (name collision) → respond 422 with the K8s error body. On 422 (schema validation) → respond 422. On success → continue to step 3.
  3. PATCH the producing AgentTask with `kagent.knuteson.io/review-decision: "accepted"` + `review-decided-by: <X-Forwarded-User|"unknown">` + `review-decided-at: <now ISO>`. JSON merge-patch.
  4. Emit audit events: `review.accepted` always; `template.candidate.promoted` additionally when reason='candidate-template' (with the new AgentTemplate CR's namespace/name/uid).
  5. Respond 200 with `{ taskRef, decision: 'accepted', auditedAt, agentTemplateRef? }`.
- **Reject handler:** simpler. Look up task → 404 if not found, 409 if already decided. PATCH `review-decision: "rejected"` + companions. Emit `review.rejected` audit event. Respond 200. NO AgentTemplate creation under any reason.
- **Atomicity note:** for `candidate-template` accept, AgentTemplate creation happens BEFORE the accept-annotation write. If the annotation patch fails after CR creation, the CR is orphan-ish (it exists, but the queue row stays until the next request retries the patch — handler is idempotent on the CR side because creation collision returns 409 which the handler treats as success-equivalent on retry). Multi-step transactionality is out of scope; the audit-event log is the canonical record of what happened.

#### Single-reviewer scope (REV-02)

- No quorum, no signed proposals, no chain-of-custody, no no-self-review check, no ring-review detection. Single operator clicks Accept/Reject; that's the decision. Multi-reviewer is future research per REQUIREMENTS.md §4 (`CoalitionProposal`).

#### RBAC contract (chart actions Role)

- Extend `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` rules:
  ```yaml
  - apiGroups: ['kagent.knuteson.io']
    resources: ['agenttasks']
    verbs: ['create', 'patch'] # add 'patch' for annotation writes
  - apiGroups: ['kagent.knuteson.io']
    resources: ['agenttemplates']
    verbs: ['create'] # NEW — for review-accept candidate-template promotion
  - apiGroups: ['kagent.knuteson.io']
    resources: ['modelendpoints']
    verbs: ['patch', 'update'] # unchanged
  ```
- An install with `actions.create=false` stays provably review-write-proof: workbench-api fails-closed on missing customApi/missing role (per `tasks.ts:147` precedent — "write surface disabled (no CustomObjects client configured); set actions.create=true on the chart").
- WS-M's planned `agenttemplates: [get,list,watch]` (read verbs, mentioned in `clusterrole-actions.yaml` comment) — Phase 4 ALSO adds these to the read-side `clusterrole.yaml` so the projection can list candidate templates and the AgentTemplate CRs created via accept become visible to the read side. Planner verifies whether read RBAC already covers this; if not, additive change.

**Reasoning:** Two reviewer entry points (`#/review` + inline) mirror how `TaskList` + `TaskDetail` co-exist — operators have multiple paths to the same action, but the action's write surface is single. Sub-path POSTs (`/accept`, `/reject`) communicate intent more clearly than overloaded annotation-PATCH and let the audit-event emission live in one well-named handler. Carrying candidates as ArtifactRef-shaped blobs honors D2 (no new CRD for the candidate state) — the candidate IS just a yet-unaccepted artifact. The promotion event creates the AgentTemplate CR via the existing operator-write path (which already validates against the `AgentTemplateSpec` schema in the CRD) — no parallel validation pipeline. RBAC split-write-role is the existing convention (H17 audit comment); extending it additively is the least surprising. A merged single-write-role was rejected because it would un-split the read-vs-write separation that H17 audit established.

### D-04: Replay/eval signal scope (REV-03) — forward-compatible stub with documented promotion path

**Decision (D-04-A): Reserve `replay-divergence` and `eval-failed` slots in the `ReviewReason` enum; v0.2 producers are zero. Verifier-fail and suspicious-detector reasons (already shipped via D-01) cover what REQUIREMENTS.md REV-03 calls "replay/eval signals" today.**

- **Enum entries reserved:** `replay-divergence`, `eval-failed`. Both produce zero rows in v0.2 — no producer exists.
- **Inline projection comment** (modeled on Phase 3's `flows.ts` D-02 pattern):
  ```ts
  // REV-03: replay-divergence and eval-failed reasons are reserved for
  // AgentTaskRun + @kagent/eval (docs/REPLAY-EVALS.md, Phase 5 design,
  // pre-implementation as of 2026-05-10). v0.2 producers: zero. Promote
  // when AgentTaskRun ships and the eval reducer emits divergence audit
  // events. Until then verifier-failed + suspicious-detector cover what
  // REQUIREMENTS.md REV-03 calls 'replay/eval signals' today.
  ```
- **Navigate-to-artifact (REV-03 acceptance per ROADMAP.md):** for `verifier-failed` rows: `traceLink` (when present on `pilotEvidence`) + `verifierError` field copied from `pilotEvidence.verification.reason`. For `suspicious-detector` rows: `suspicious[]` field surfaces the detector flag names (e.g., `synthesis_low_yield`, `methodology_fabrication`). The reviewer navigates from queue row → `Open Detail` → TaskDetail page → existing trace-link button → Langfuse. Same navigation works when AgentTaskRun lands; the `traceLink` field flips to point at the Run-level tape ArtifactRef with no `ReviewQueueRow` shape change.
- **Phase-5 promotion path** (inline in route module + `docs/REPLAY-EVALS.md` footer): when `AgentTaskRun` ships, add a step 2.5 to the projection classifier — "if any `AgentTaskRun` for this task has `terminalStatus='replayed-divergence'` (or whatever the eval reducer emits), bump reason to `replay-divergence` with `replayDivergence` populated." The projection module's `compute()` body changes ~15 lines; consumer DTO unchanged.

**Reasoning:** REPLAY-EVALS.md is explicitly Phase 5 substrate primitive design, pre-implementation. `AgentTaskRun` and `ReplaySet` CRDs do NOT exist. Trying to ship real replay-divergence detection in v0.2 would require either (a) a new CRD (D2 violation) or (b) a substrate-internal divergence detector that's its own multi-phase Phase-5+ effort. Phase 3's `attention` gauge already validated this pattern — reserve the slot, ship a stub, document the promotion path in code, flip when the prerequisite lands. This is more honest than pretending REV-03 is fully delivered when its formal substrate (AgentTaskRun) is Phase 5 future-work. The "thin replay-divergence detector over `task-admission.ts` idempotent-replay cache" option was rejected because that cache is a different domain (Stripe-pattern same-input-hash idempotency, not eval-divergence) and conflating them would create the same naming collision REPLAY-EVALS.md §3 explicitly tries to avoid.

### Test posture (carries forward from Phases 1–3)

- Vitest, co-located `*.test.ts` / `*.test.tsx`, run via `pnpm -C packages/workbench-api test` (server side) and `pnpm -C packages/workbench-ui test` (UI side).
- ≥85% coverage on `routes/review-queue.ts` (operator reconciler bar), ≥75% on UI glue code (`ReviewPage.tsx`, `ReviewActions.tsx`, `useReviewQueue` hook).
- **Required tests** (planner formalizes; this is the spec):
  - `routes/review-queue.test.ts` — 5 reason fires (verifier-failed, suspicious-detector, human-review-requested, candidate-template, decided-task-skipped) + 5 absent (no signal cases) + sort-by-staleness assertion = ~12 unit tests minimum.
  - `routes/review-queue.test.ts` — accept happy path (non-template) + accept-promotes-template + accept-collision-409 + reject-happy-path + already-decided-409 + missing-task-404 = ~6 additional handler tests.
  - `routes/review-queue.test.ts` — RBAC fail-closed (no `customApi` → 503 with WORKBENCH_ACTIONS_ENABLED message; mirror `tasks.ts:147` test).
  - `ReviewPage.test.tsx` — render with mocked hook + Accept click → confirm dialog → POST → row removal; same for Reject.
  - `ReviewActions.test.tsx` — mounts in TaskDetail under each of the 4 trigger conditions; not mounted otherwise.
  - `flows.test.ts` (Phase 3 file, additive change) — `attention` gauge `compute()` reads from new review-queue count source; existing 8-flow source-field-asserted test still passes.
- **Reload-stability fixture:** `packages/workbench-api/src/__fixtures__/review-queue-snapshot.json` — one of each reason; mirrors `cc-snapshot.json` shape. Captures from a synthetic SnapshotCache state.
- **Audit-event tests:** extend `packages/audit-events/src/make-event.test.ts` + `event-types.ts` for the 4 new event types (`review.requested`, `review.accepted`, `review.rejected`, `template.candidate.promoted`).
- **No new e2e infrastructure.** No browser automation. The vitest jsdom env (UI) + node env (workbench-api) is sufficient.

### COMMAND-CENTER-CONTRACT.md compliance (D7)

D7 binds Phase 4's UI work — same as Phases 1–3. Every newly rendered row field MUST map back to a substrate source. CC-01's generalized assertion is the enforcement mechanism, extended:

1. New `ReviewQueueFieldName` closed enum in `source-binding.ts` — derived from `ReviewQueueRow`'s field names. Every render site uses `useSourceField` / `useSourceFields` per Phase 2 pattern.
2. `ReviewPage.tsx` and `ReviewActions.tsx` are NOT under Command Center (they're separate routes / panels); the canvas-side mapper assertion (CC-01 Phase 2) does not apply directly. The DOM-side `data-source-field` attributes DO apply — every cell in the `ReviewPage` table carries one.
3. Phase 3's `attention` flow gauge `compute()` now reads from the review-queue count — its `data-source-field` flips from `'phase,suspicious'` (the v0.2 stub) to `'review-queue.rows.length'`. The flow gauge stays mounted in CommandView; the Phase 4 change is purely the source-field upgrade.

### Claude's Discretion (unlocked — planner picks)

- Exact polling cadence for `useReviewQueue()` (default: 5s mirrors `useDispositions`; planner may pick 10s or SSE-driven invalidation if `/api/dispositions` migrates).
- Whether to use SSE-driven invalidation for review-queue rows (subscribe to `review.*` and `task.failed` audit events; auto-refresh on receipt). Default: defer to a follow-up; v0.2 polls.
- File split for `routes/review-queue.ts` (single file vs `review-queue/index.ts` + per-handler modules — planner picks based on file size; default single file mirrors `dispositions.ts`).
- ReviewPage table column ordering / column-set (default: `Reason | Task | Agent | Reason Detail | Staleness | Actions`; planner picks).
- Confirm-dialog UX shape (modal vs inline-popover; default: modal mirrors `NewTaskModal.tsx`).
- Whether `ReviewActions` mounts above or below the existing TaskDetail content (default: above, near the top, so it's visible without scrolling).
- Exact `ArtifactRef` resolution for candidate templates — does the candidate artifact YAML live in `task.status.artifacts[0]`? On a remote object store? (Planner inspects `task.status.artifacts` shape and `pilotEvidence.artifacts`; default: first artifact whose `mediaType` matches the new media-type string, fail-422 if absent.)
- Whether `agenttemplates: [get,list,watch]` belongs in the read-side `clusterrole.yaml` already (planner verifies; additive if not).
- Whether to add a CI lint that grep-asserts every `ReviewReason` enum entry has a corresponding fixture test (default: defer; add when there's a real-world drift).
- Phase 3 `attention` flow integration mechanics (count-only fetch in CommandView vs shared hook — see D-01-A "lifecycle coupling" note; planner picks the cleanest integration).
- Whether `ReviewActions` confirms before accepting a template-candidate (extra safety for write-path beyond annotation; default: same-confirm-dialog as accept-non-template).
- AgentTemplate name collision strategy — if accepting a candidate whose proposed name is taken, suggest an auto-suffixed name? Or hard-fail 422? Default: hard-fail 422 with the K8s error; reviewer reproduces the proposal under a different name.
- Whether to surface the inline `ReviewActions` in TaskList rows (e.g., per-row "Quick reject" button). Default: defer; one entry point (inline in TaskDetail) plus the dedicated `#/review` page is sufficient.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents (researcher, planner, executor, checker) MUST read these before planning or implementing.**

### Project planning corpus (re-steered 2026-05-09 PM)

- `.planning/PROJECT.md` — project bones; D1–D7; load-bearing tests (§11 bounds, §15 one-sentence); D2 "Defer CRDs until repeated behavior justifies one" (no `Tool` / `SteeringEvent` / `TaskReview` / `Channel` / `Post` CRDs); D3 "signals propose, governance disposes"; D6 "self-proposal, not self-promotion"; D7 "COMMAND-CENTER-CONTRACT.md is binding for Workbench/Command Center work"
- `.planning/REQUIREMENTS.md` §1 "Review / consolidation / promotion over existing state — REV" — REV-01 + REV-02 + REV-03 candidate acceptance criteria
- `.planning/REQUIREMENTS.md` §3 explicit non-goals — no `Tool` / `SteeringEvent` / `TaskReview` / `Channel` / `Post` CRD; no consolidation controller; no agent self-write of review state
- `.planning/REQUIREMENTS.md` §4 future research — `CoalitionProposal` (multi-reviewer with quorum), Consolidation controller, Decay/revalidation policy, Quarantine semantics; Phase 4 must NOT pull from these
- `.planning/ROADMAP.md` Phase 4 success criteria (3 items; depends on nothing structurally; benefits from Phase 2's read-depth)
- `.planning/STATE.md` — current pointer + blockers (none blocking Phase 4; Phase 3 complete and verified)

### Phase 1–3 artifacts (REUSE — do not redesign)

- `.planning/phases/01-agentdisposition-v0/01-CONTEXT.md` — DISP-03 `/api/dispositions` projection pattern is THE template for `/api/review-queue`
- `.planning/phases/01-agentdisposition-v0/01-03-PLAN.md` — DISP-03 plan; route registration + audit publisher wiring patterns
- `.planning/phases/01-agentdisposition-v0/01-04-PLAN.md` — Source-binding contract origin (`source-binding.ts`)
- `.planning/phases/02-command-center-contract-hardening/02-CONTEXT.md` — CC-01 generalized source-binding pattern (Phase 4 extends with `ReviewQueueFieldName`); CC-04 audit-event SSE pattern
- `.planning/phases/02-command-center-contract-hardening/02-04-SUMMARY.md` — vitest gotchas (selective fake timers, `globalThis.fetch` not `global`, `urlOf()` URL helper, JSON import attributes)
- `.planning/phases/03-resource-flow-overlays/03-CONTEXT.md` — Phase 3's `attention` flow gauge stub pattern (`flows.ts` D-02-attention) — Phase 4 flips this stub to read from the new projection
- `.planning/phases/03-resource-flow-overlays/03-01-PLAN.md` through `03-03-PLAN.md` — `flows.ts` integration mechanics (`compute()` body changes are surgical)

### Implementation contracts

- `docs/COMMAND-CENTER-CONTRACT.md` — **binding for the Phase 3 `attention` flow stub flip + the deep-link from AgentPanel/TaskPanel to `#/review`.** Phase 4's main UI surfaces (`ReviewPage`, `ReviewActions` in TaskDetail) are NOT inside Command Center, so the Prime Directive's "every world object derives from a substrate source" applies to the data only — the source-binding pattern still applies to row-level rendering.
- `docs/AGENT-TEMPLATES.md` — extend with footer note documenting the `application/x-kagent-template-candidate+yaml` media type and the candidate-template promotion path. Add a small "Promotion via review queue" section pointing at this CONTEXT.md.
- `docs/REPLAY-EVALS.md` — **read for context only**. This is Phase 5 substrate primitive design, pre-implementation. Phase 4's REV-03 stub references it as the promotion target. Add a footer note pointing at this CONTEXT.md `D-04` block so when Phase 5 lands the AgentTaskRun reducer knows to emit `replay-divergence` audit events that the projection picks up.
- `docs/SUBSTRATE-V1.md` §4.3 — audit-event catalog ordering (Phase 4 adds 4 new event types: `review.requested`, `review.accepted`, `review.rejected`, `template.candidate.promoted`). Update the catalog table.
- `CLAUDE.md` (root) — tech stack (TypeScript + Node 22 + tsx + ESM + pnpm workspace), MIT header on every `.ts` file, Conventional Commits (`feat(phase-04-...)` / `fix(phase-04-...)`), GitOps for cluster ops, `gh pr create` and `gh pr merge` are NOT a unit (per-PR explicit consent), pre-commit hook requires Node 22

### Existing Workbench / operator surfaces the planner must work with

- `packages/workbench-api/src/routes/dispositions.ts` — **THE template for `/api/review-queue`.** Same projection pattern (read SnapshotCache, compute over existing state, sort, return). Same audit-publisher wire. Same RBAC posture.
- `packages/workbench-api/src/routes/dispositions.test.ts` — pattern for the new route's test suite (auditPublisher mock, customApi mock, fixture-based assertions)
- `packages/workbench-api/src/routes/tasks.ts` — POST handler pattern (validators, customApi optional, fail-closed when `actions.create=false`); the candidate-template accept handler mirrors this on the AgentTemplate side
- `packages/workbench-api/src/routes/tasks.ts:147` — "write surface disabled (no CustomObjects client configured); set actions.create=true on the chart" — Phase 4's accept/reject endpoints follow the same pattern
- `packages/workbench-api/src/routes/tasks.ts:411-562` — `pilotEvidence` projection helper; the review-queue projection reads `pilotEvidence.verification.passed` and `pilotEvidence.structuralVerdict.suspicious` via the same helpers
- `packages/workbench-api/src/cache.ts` — `SnapshotCache` is the read source for the projection. No changes; just consume.
- `packages/workbench-api/src/router.ts` — register the new route alongside `dispositions`. Audit publisher wire mirrors `dispositions`.
- `packages/workbench-api/src/main.ts:89-103` — `actions.create` chart values flag drives whether write endpoints respond 503; Phase 4's accept/reject inherit this gating.
- `packages/workbench-api/src/auth.ts` — `X-Forwarded-User` header is the reviewer-id source; same auth posture as POST `/api/tasks`
- `packages/workbench-api/src/types-write.ts` — pattern for `CreateTaskErrorBody`, `CreateTaskResponse` shapes; new `AcceptReviewRequestBody`, `AcceptReviewResponse`, `RejectReviewResponse` mirror this
- `packages/workbench-api/src/routes/validators.ts` + `validators.test.ts` — pattern for the new request-body validators (`validateReviewActionBody`)
- `packages/workbench-api/src/sse.ts` — audit-event SSE — Phase 4's new event types (`review.*`, `template.candidate.promoted`) flow through unchanged
- `packages/workbench-api/src/error-scrub.ts` — error-body scrubber for K8s errors; the candidate-template-accept-on-409 path runs through this
- `packages/operator/src/crds/types.ts:1077-1131` — `AgentTemplate`, `AgentTemplateSpec`, `AgentTemplateBudget`, `AgentTemplateParameter` types. The accept handler validates candidate YAML against `AgentTemplateSpec`. NO CRD changes — read-only.
- `packages/operator/src/template-instantiator.ts` — existing AgentTemplate-aware code (annotation conventions like `kagent.knuteson.io/template-ref`, `created-by-task`, `parameter-hash`, `budget-hash`). Phase 4 extends with `kagent.knuteson.io/template-candidate` (on producing AgentTask) + `kagent.knuteson.io/promoted-from-task` (on the new AgentTemplate CR after promotion).
- `packages/operator/src/verifier.ts` — verifier path that produces `pilotEvidence.verification.{passed,mode,reason,completedAt}`; the projection reads these via the existing `pilotEvidence` mapper
- `packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml` — extend additively with `agenttasks: [patch]` + `agenttemplates: [create]` (per D-03). Comment block already documents H17 release-namespace scope and the `actions.create=false` write-proof posture.
- `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml` — read-side cluster role; planner verifies whether `agenttemplates: [get, list, watch]` is already covered for SnapshotCache to ingest the AgentTemplate CRs (the new accept-promoted ones need to be visible to the read side; if missing, additive change).
- `packages/operator/charts/kagent-workbench/values.yaml` — `rbac.actions.create` flag; no schema change.
- `packages/audit-events/src/event-types.ts` — extend with 4 new event-type literals (`review.requested`, `review.accepted`, `review.rejected`, `template.candidate.promoted`)
- `packages/audit-events/src/types.ts` — extend `AuditEventType` union + `AuditEventData` discriminated union with the 4 new types and their `data` shapes
- `packages/audit-events/src/make-event.ts` — extend the `makeEvent` factory if it has per-type construction helpers; otherwise the new types ride the existing factory
- `packages/dto/src/types.ts` — extend with `ReviewQueueRow`, `ReviewReason` enum, `ArtifactRefSummary` (if not already there)
- `packages/dto/src/index.ts` — re-export the new types
- `packages/workbench-ui/src/api.ts` — extend with `fetchReviewQueue`, `acceptReviewQueueRow`, `rejectReviewQueueRow`, `requestReview` functions
- `packages/workbench-ui/src/types.ts` — re-export `ReviewQueueRow`, `ReviewReason` from `@kagent/dto/review-queue` per Phase 1 / DISP-04 pattern
- `packages/workbench-ui/src/App.tsx` — add hash-route entry `#/review` → `<ReviewPage />`. Existing routes: `#/tasks`, `#/gateway`, `#/cluster`, `#/command`.
- `packages/workbench-ui/src/TaskList.tsx` — pattern for `ReviewPage.tsx` (table layout, sortable headers, deep links)
- `packages/workbench-ui/src/TaskDetail.tsx` — `ReviewActions` mounts here for tasks matching the 4 trigger conditions
- `packages/workbench-ui/src/NewTaskModal.tsx` — pattern for the Accept/Reject confirm dialog
- `packages/workbench-ui/src/command/source-binding.ts` — extend with `ReviewQueueFieldName` closed enum (mirror Phase 1–3's pattern)
- `packages/workbench-ui/src/command/source-binding.test.ts` — pattern for the new `ReviewQueueFieldName` orphan-assertion tests
- `packages/workbench-ui/src/command/flows.ts` — Phase 3 file, additive change to `attention` gauge `compute()` body (and possibly `compute()` signature to accept a `reviewQueueRowCount` prop). `FLOW_TYPES['attention']` `data-source-field` flips from `'phase,suspicious'` to `'review-queue.rows.length'`. Inline comment updates: remove the "v0.2 stub uses TaskSummary.phase=Failed + .suspicious as a proxy" line; replace with "Phase 4: source flipped to /api/review-queue rows count."
- `packages/workbench-ui/src/CommandView.tsx` — Phase 3 mount site for `<FlowOverlay />`. Phase 4 may pass a `reviewQueueRowCount` prop or wire `useReviewQueue()` here — planner picks the cleanest integration (D-01 lifecycle-coupling note).

### Domain definition

- `docs/NORTH-STAR-SYSTEM-DESIGN.md` §C-game-loop — `Intent → Work → Evidence → Review → Promotion → Better Future Work`. Phase 4 IS the Review→Promotion step over existing v0.1 substrate.
- `docs/NORTH-STAR-SYSTEM-DESIGN.md` §C-promotion-loop — "Agents propose new capability; never self-promote new authority (self-proposal, not self-promotion)" — bound for Phase 4's accept handler (the operator promotes; the agent only proposes).
- `.planning/intel/constraints.md` §C-game-loop, §C-promotion-loop, §C-feedback-classes (Steering, Review, Learning) — Phase 4 implements the Review feedback class.

### Project conventions

- `CLAUDE.md` (root) — tech stack, MIT header, Conventional Commits, GitOps posture, `gh pr create` ≠ `gh pr merge`, pre-commit Node 22

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **`packages/workbench-api/src/routes/dispositions.ts`** — the canonical template for `/api/review-queue`. Audit publisher wire, `SnapshotCache` consumption, projection-over-existing-state, optional `customApi` for write paths, route registration in `router.ts`. Mirror its file shape.
- **`packages/workbench-api/src/routes/dispositions.test.ts`** — the canonical template for `routes/review-queue.test.ts`. Mock auditPublisher, mock customApi, fixture-driven assertions, RBAC fail-closed test.
- **`packages/workbench-api/src/routes/tasks.ts`** — POST handler pattern (validators, K8s error scrubbing, customApi-optional). Accept/reject handlers mirror this.
- **`packages/workbench-api/src/routes/tasks.ts:411-562`** — `pilotEvidence` projection helper. The review-queue projection consumes the same helper to read `verification.passed` and `structuralVerdict.suspicious` per task.
- **`packages/workbench-api/src/cache.ts`** — `SnapshotCache.tasks` is the projection's primary input. No changes — read-only consumer.
- **`packages/workbench-api/src/sse.ts`** — audit-event SSE; new event types flow through unchanged.
- **`packages/workbench-api/src/router.ts`** — registers all routes; new `review-queue` registration follows the `dispositions` site exactly.
- **`packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml`** — extend additively with `agenttasks: [patch]` + `agenttemplates: [create]`. Existing comment block documents the H17 release-namespace scope and the `actions.create=false` write-proof posture.
- **`packages/audit-events/src/event-types.ts`** — exists with ~25+ event-type literals; add 4 new ones (`review.requested`, `review.accepted`, `review.rejected`, `template.candidate.promoted`). Comment block in the file mandates "Every const here MUST have a corresponding member in `AuditEventType` (types.ts) and in `AuditEventData`'s discriminated union" — additive only.
- **`packages/operator/src/crds/types.ts`** — `AgentTemplate` + `AgentTemplateSpec` types are the validation target for accept-on-candidate-template. No changes — type-only consumer.
- **`packages/operator/src/template-instantiator.ts`** — existing annotation conventions (`kagent.knuteson.io/template-ref`, `created-by-task`, `parameter-hash`, `budget-hash`). Phase 4's promoted AgentTemplate CR carries a new sibling annotation `kagent.knuteson.io/promoted-from-task: <ns>/<name>`.
- **`packages/dto/src/disposition.ts`** — pattern for `ReviewQueueRow` DTO + parser helpers. The disposition module exports `DispositionOverlayRow`, parser, and a `ProposalKind` closed enum — same shape mirrored as `ReviewQueueRow`, `parseReviewQueueRow`, `ReviewReason`.
- **`packages/workbench-ui/src/TaskList.tsx`** — table-layout pattern for `ReviewPage.tsx`. Sortable headers, per-row deep links, error/loading states.
- **`packages/workbench-ui/src/TaskDetail.tsx`** — `ReviewActions` mount site; existing trace-link button + suspicious-tags display patterns.
- **`packages/workbench-ui/src/NewTaskModal.tsx`** — confirm-dialog pattern for Accept/Reject (modal + confirm-text + submit-button + cancel).
- **`packages/workbench-ui/src/api.ts`** — `fetchDispositions` is the canonical pattern for `fetchReviewQueue`; `createTask` is the pattern for `acceptReviewQueueRow` / `rejectReviewQueueRow` / `requestReview`.
- **`packages/workbench-ui/src/command/source-binding.ts`** — extend with `ReviewQueueFieldName`. Generic helpers (`isDevBuild`, `assertSourceField`, `assertSourceFields`, `useSourceField`, `useSourceFields`) reused unchanged.
- **`packages/workbench-ui/src/command/flows.ts`** — Phase 3 file. The `attention` flow `compute()` body is the surgical change site (~10–15 lines).
- **Vitest infrastructure** — `pnpm -C packages/workbench-api test` (node env), `pnpm -C packages/workbench-ui test` (jsdom env). All Phase 2/3 gotchas apply (selective `vi.useFakeTimers({ toFake: ['Date'] })`, `globalThis.fetch` not `global`, `urlOf()` URL helper, Object.fromEntries for ReadonlyMap snapshots, JSON import attributes).

### Established Patterns

- **Server-side projection over existing substrate state** (DISP-03 pattern from `routes/dispositions.ts`) — read `SnapshotCache`, compute, sort, return; no new persistence; reload-stable by construction (pure read).
- **Audit-publisher wire** — every write handler emits an audit event before responding 200; the publisher is optional (handlers no-op the publish call when undefined for testability).
- **Annotation as substrate signal** — `kagent.knuteson.io/<key>: <value>` on AgentTask `metadata.annotations`. Used today for `template-ref`, `created-by-task`, `parameter-hash`, `dispatch-published`. Phase 4 extends with `review-requested`, `review-decision`, `review-decided-by`, `review-decided-at`, `review-requested-by`, `review-requested-at`, `template-candidate`, `promoted-from-task`. Annotations are the lightest substrate primitive — no CRD, no controller, no schema migration.
- **Closed-enum DTO field-name types** — derived from the DTO's field names; `ReviewQueueFieldName` mirror's Phase 2's `AgentSummaryFieldName` / `TaskSummaryFieldName` / `GatewayCapacityFieldName` / `PressureFieldName` / Phase 3's `FlowFieldName`.
- **`data-source-field` / `data-source-fields` DOM attribute** — comma-joined for multi-field; every rendered cell carries one. Phase 4's ReviewPage cells follow the same convention.
- **POST endpoint fail-closed when `actions.create=false`** — `tasks.ts:147` precedent; review-queue accept/reject mirrors it. The chart's RBAC bind/unbind is the deployment-side switch.
- **MIT license header on every `.ts` source file** — every new file gets the SPDX header per Phases 1–3.

### Integration Points

- **`packages/workbench-api/src/router.ts`** — register the new `/api/review-queue` route group alongside `dispositions` (alphabetically ordered).
- **`packages/workbench-api/src/main.ts`** — wire the new route's deps (auditPublisher, customApi, defaultNamespace, langfuseBaseUrl) — same pattern as `dispositions` route registration.
- **`packages/workbench-api/src/cache.ts`** — `SnapshotCache.tasks` consumed by the projection; no new fields. The cache may need to also expose `agentTemplates` Map (read-side) so the post-promotion CR is visible to subsequent GETs without forcing the operator to wait for informer re-sync; planner verifies whether SnapshotCache already covers `agenttemplates`.
- **`packages/audit-events/src/{event-types,types,make-event}.ts`** — extend with 4 new types per D-02-A.
- **`packages/dto/src/{review-queue.ts,index.ts,types.ts}`** — new `review-queue.ts` module exporting `ReviewQueueRow`, `ReviewReason`, parser; re-export from `index.ts`.
- **`packages/operator/charts/kagent-workbench/templates/clusterrole-actions.yaml`** — additive RBAC extension per D-03.
- **`packages/operator/charts/kagent-workbench/templates/clusterrole.yaml`** — verify `agenttemplates: [get, list, watch]` already covered; if not, additive read-side extension.
- **`packages/workbench-ui/src/{App,types,api}.ts`** — extend with `#/review` route + DTO re-exports + fetch helpers.
- **`packages/workbench-ui/src/{ReviewPage,ReviewActions}.tsx`** — new files. ReviewPage at top-level; ReviewActions in `command/` (it's used inside TaskDetail which is at top-level — planner picks; default `command/ReviewActions.tsx` since it shares source-binding pattern with the Command Center components).
- **`packages/workbench-ui/src/TaskDetail.tsx`** — mount `<ReviewActions task={...} />` near the top of the panel.
- **`packages/workbench-ui/src/command/source-binding.ts`** — extend with `ReviewQueueFieldName`.
- **`packages/workbench-ui/src/command/flows.ts`** — surgical change to `attention` gauge `compute()` body.
- **`packages/workbench-ui/src/command/__fixtures__/cc-snapshot.json`** — the Phase 3 reload-stability fixture covers the existing `attention` gauge with `phase=Failed + suspicious` proxy data; Phase 4's flip means the fixture's `attention` count may differ from the new source. Planner verifies; small additive extension to make the new source produce a deterministic count (e.g., synthetic `kagent.knuteson.io/review-decision` annotation on a Failed task to ensure it's NOT in the queue, etc.). Mirror Phase 3's snapshot-update-via-`vitest -u` pattern; one intentional-snapshot-update commit lands in the PR.
- **`packages/workbench-ui/src/command/__snapshots__/cc-reload.test.tsx.snap`** — extended via `vitest -u` after the `attention` source-field flips and the AgentPanel/TaskPanel deep-links to `#/review` are added (if any). Reviewer scrutinizes the diff in a single dedicated commit.

</code_context>

<specifics>

## Specific Ideas / Concrete Phase 4 Anchors

1. **DISP-03's `/api/dispositions` is the canonical template.** The projection-over-existing-state, audit-publisher wire, customApi-optional, fail-closed-when-`actions.create=false`, audit-events-on-write — every Phase 4 backend pattern was already validated by Phase 1. Researcher and planner should treat `routes/dispositions.ts`, `routes/dispositions.test.ts`, and the `routes/tasks.ts` POST handler as the authoritative shape; new code mirrors them.

2. **Phase 1–3's source-binding pattern is the canonical UI template.** Per-component opt-in, closed-enum field-name types, `data-source-field` DOM attributes, dev-only orphan assertions. Phase 4 extends `source-binding.ts` with `ReviewQueueFieldName`; existing helpers reused unchanged.

3. **Phase 3's `attention` flow stub flips here.** This is the only Phase 3 callback. The flip is surgical: ~10–15 lines of `compute()` body change in `flows.ts`, plus a new fetch-or-prop wire in CommandView. The `FlowGauge` shape is unchanged. The `data-source-field` flips from `'phase,suspicious'` to `'review-queue.rows.length'`.

4. **"No new CRDs in v0.2" still applies.** Candidate AgentTemplates live as ArtifactRef-shaped blobs; promotion creates the EXISTING `AgentTemplate` CR via the EXISTING operator-write path. No `ReviewRequest` CRD, no `TaskReview` CRD, no `Channel` / `Post` CRD.

5. **D6 — Self-proposal, not self-promotion.** Agents may produce `template-candidate` artifacts via DISP-02-allowed `proposalScope.mayProposeAgainst: ['templates']`; that IS their proposal channel. Operators (governance) approve/reject; that's the promotion gate. The accept handler creating the AgentTemplate CR IS the promotion event.

6. **§11 bounds test answer for Phase 4 (must appear in PLAN.md):**
   - Declared capability: workbench-api exposes a server-side review queue projection over existing AgentTask/verifier/audit-event state; reviewers accept/reject via two entry points (`#/review` page + inline TaskDetail panel); accepted candidate templates become versioned `AgentTemplate` CRs; replay/eval signal slots are reserved for Phase 5+ promotion.
   - Bounded resource drain: the projection is O(|tasks in cache|) per request; no new persistence; one read-only ArtifactRef parse per accept-on-candidate; new audit-event types ride the existing publisher; new RBAC verbs are scoped to the release namespace per H17.
   - Observable state transition: every accept/reject emits an audit event (`review.accepted` / `review.rejected` / `template.candidate.promoted`); the AgentTask's `review-decision` annotation is the authoritative substrate state; the new AgentTemplate CR (post-promotion) is reachable via `customApi`.
   - Auditable output: vitest CI run is the auditable surface — projection tests (~12 unit tests) + accept/reject handler tests (~6 tests) + audit-event tests (4 new types) + UI tests for ReviewPage and ReviewActions all fail loud on regression. The audit-event log in production carries the canonical record.
   - Revocation path: chart `actions.create=false` disables ALL write endpoints (existing convention from H17); per-handler `customApi === undefined` returns 503 with the documented message; a single chart rollback removes the entire phase's write surface; revoking the new RBAC verbs (`agenttasks: [patch]` + `agenttemplates: [create]`) returns the workbench-api to read-only mode for review actions.

7. **§15 one-sentence test answer for Phase 4 (must appear in PLAN.md):**

   "Surfacing a server-side review queue projection over existing AgentTask/verifier/audit-event state with an explicit single-reviewer accept/reject path that promotes candidate AgentTemplates into versioned CRs gives the substrate a real Review→Promotion step (`C-game-loop`) without expanding substrate primitives — strengthening review and revocation observability in v0.2 and unlocking the AgentTaskRun-based replay-divergence promotion path documented in the projection's Phase 5+ stub for future phases."

8. **The user's "follow best 'recommended' suggestions" is authority to lock D-01..D-04 with the recommended option; it is NOT authority to expand scope.** All 3 candidate requirements (REV-01, REV-02, REV-03) stay in this phase; nothing more, nothing less.

9. **No imperative kubectl against homelab (CLAUDE.md operational context).** Phase 4 ships substrate-side code (workbench-api + UI + audit-events + chart) — no Job manifests, no `kubectl apply/exec/port-forward`. The verification surface IS vitest. The deployment surface (when the planner ships) is the workbench-api Docker image rebuild + workbench-ui Docker image rebuild + `../new_localai/` ArgoCD overlay bump for the chart's `rbac.actions.create=true` posture (which is likely already on, but planner verifies).

10. **`gh pr create` and `gh pr merge` are not a unit.** Phase 4 ships PR(s) for human review; merges are separate explicit consent (per CLAUDE.md and memory `feedback_auto_push.md`).

11. **Pre-commit hook needs Node 22.** Same as Phases 1–3 — `source ~/.nvm/nvm.sh && nvm use 22` before any commit if the machine default has drifted to Node 23+.

</specifics>

<deferred>

## Deferred Ideas (Phase 4 explicitly does NOT do these)

- **`ReviewRequest` / `TaskReview` / `ReviewDecision` CRD.** Off the table this phase per D2. Reconsider IF (a) the annotation-driven decision state is repeatedly insufficient (e.g., we need decision history beyond a single accept/reject) AND (b) the operator explicitly accepts the substrate primitive expansion. Neither holds in v0.2.
- **Multi-reviewer flows / `CoalitionProposal`.** Future research per REQUIREMENTS.md §4. Promotion requires repeated single-reviewer use proving what quorum semantics the operator wants AND explicit acceptance.
- **Real replay-divergence detection / `AgentTaskRun` CRD / `ReplaySet` controller / `@kagent/eval` package.** Future research / Phase 5 design per `docs/REPLAY-EVALS.md`. Phase 4's REV-03 ships the enum slot only; producers are Phase 5+ work.
- **Consolidation controller** (read-only daemon proposing hygiene actions to the queue). Future research per REQUIREMENTS.md §4. Defer until manual review-queue ergonomics prove what hygiene means.
- **Decay / revalidation policy** on review-queue rows (auto-staleness expiry, auto-revalidation). Future research per REQUIREMENTS.md §4 NFR. v0.2's staleness-sort + manual review handles homelab scale.
- **Quarantine semantics** as first-class state for rejected candidates. Future research per REQUIREMENTS.md §4 NFR. v0.2 records rejection as an annotation + audit event; that's sufficient observability.
- **Agent-side write of `kagent.knuteson.io/review-requested`.** Off the table. D6 — agents propose, governance promotes. Agents may produce `template-candidate` artifacts (their proposal channel); operators may set `review-requested` (governance channel). Promoting agent-side review-flag would expand the agent proposal surface beyond DISP-02's locked enum.
- **Bulk accept/reject.** Off the table. WB-02's multi-select on Command Center sprites is read-only. Single-row write only.
- **Web hook / push notification on enqueue.** Off the table. Operators poll `/api/review-queue` or watch the SSE audit-event stream for `review.requested` / `task.failed` / new event types.
- **Reviewer-identity authentication beyond `X-Forwarded-User`.** Off the table. Same auth posture as POST `/api/tasks` per H17 audit acknowledgment.
- **AgentTemplate-version-bump on accept** (`templateVersion: N+1` when accepting a candidate that supersedes an existing template). Off the table this phase. v0.2 always creates a new template; `revisionHistoryLimit` semantics on the AgentTemplate CRD apply but are not driven by Phase 4's accept handler. Reconsider when there's repeated demand for in-place version bumps.
- **Auto-accept after timeout** (e.g., "auto-accept candidates that sit in queue > 7 days"). Off the table. The operator decides; no auto-promotion beyond DISP-02's already-locked narrowing-only-never-widening rule.
- **Bulk-export of audit events** (e.g., `GET /api/audit-events?since=...&kind=review.*`). Off the table. The existing SSE stream is sufficient for v0.2; bulk-export is its own design.
- **Cross-namespace promotion** (accepting a candidate in namespace A creates the AgentTemplate in namespace B). Off the table. H17 release-namespace scope binds the actions Role; cross-namespace dispatch is mentioned as a future feature behind an explicit values flag in the existing chart comment.
- **CI lint that grep-asserts every `ReviewReason` enum entry has a corresponding fixture test.** Default: deferred. Add when there's a real-world drift.
- **SSE-driven invalidation of `useReviewQueue()`.** Default: defer; v0.2 polls every 5s. Promote when polling shows up as a load problem.
- **`#/review/:taskRef` deep-link.** Default: defer. The `Open Detail` button on each row navigates to `#/tasks/<ns>/<name>` which already exists; a per-row review-detail page is over-design for v0.2.
- **`ReviewActions` in TaskList rows** (per-row "Quick reject"). Default: defer. One inline entry point (TaskDetail) plus the dedicated `#/review` page is sufficient.

</deferred>

---

_Phase: 04-review-queue-projection-promotion-path_
_Context gathered: 2026-05-10 — four gray areas presented (projection shape D-01, human-review-requested signal D-02, candidate-template + accept/reject write path D-03, replay/eval signal scope D-04); user accepted recommended option in each. All Phase 1–3 patterns reused without modification._
