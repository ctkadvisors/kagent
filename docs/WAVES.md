# Sub-Team Wave Plan

**Date:** 2026-05-03
**Status:** Draft, parallel work allocation for v0.1.7 → v1.0
**License:** MIT

> Cross-references: [`ROADMAP.md`](./ROADMAP.md) (release-level high-level), [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) (architecture), [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) (model-gateway boundary).
>
> This document describes how the wave structure decomposes into parallel sub-teams, which packages each sub-team owns, where coordination is required, and how each release is validated.

---

## 1. Sub-team taxonomy

A "sub-team" is one ownership lane responsible for a coherent set of releases. In a small organization (1-3 contributors) the same person rotates through multiple lanes; in a larger org each lane gets a dedicated owner. Either way, the lane is the unit of parallelism.

```
Wave 0  ┌─────────┬───────────┬──────────┬─────────┬───────┐
        │ Secrets │ Isolation │ Gateway  │ Hygiene │ Audit │ Entry
        └─────────┴───────────┴──────────┴─────────┴───────┘
              (5 lanes, ~2-4 weeks parallel)

Wave 1  ┌──────┐
        │ I/O  │ → ┌───────────┐ ┌─────┐
        └──────┘   │ Workspace │ │ CAS │
                   └───────────┘ └─────┘
              (1 serial then 2 parallel, ~4-5 weeks)

Wave 2  ┌──────┐
        │ Caps │ → ┌─────────────┐ ┌───────────┐
        └──────┘   │ Supervision │ │ Workflows │
                   └─────────────┘ └───────────┘
              (1 serial then 2 parallel, ~5 weeks)

Wave 3  ┌────────┬───────────┬───────┬──────────┬──────────┐
        │ Events │ Blackboard│ Cache │ Identity │ Locality │
        └────────┴───────────┴───────┴──────────┴──────────┘
              (5 lanes, ~2-3 weeks parallel)

Wave 4  ┌─────────┐
        │ Tenancy │ → ┌────────┬────────┬────────────┬─────────────┐
        └─────────┘   │ Egress │ Quotas │ Versioning │ KeyRotation │
                      └────────┴────────┴────────────┴─────────────┘
              (1 serial then 4 parallel, ~3 weeks)
```

Critical path (sequential): ~16-20 weeks. Calendar weeks compress further with adequate ownership coverage.

---

## 2. Wave 0 sub-teams (~2-4 weeks)

### 2.1 Sub-team: Secrets

**Releases:** `v0.1.8-secret-hygiene` ✓ DONE
**Owns:** `packages/operator/charts/kagent-operator/templates/`, `packages/operator/src/main.ts` (env-injection block), `packages/operator/src/job-spec.ts` (env construction)
**Reads but doesn't own:** any Helm value defaults

**Deliverables:**
1. Operator builds spawned-Job env using `valueFrom.secretKeyRef`, never inline `value:`, for `KAGENT_LITELLM_API_KEY` and `KAGENT_LANGFUSE_SECRET_KEY`
2. Per-task `Secret` cloned from operator-side source (or `envFrom: secretRef:` shape pinning a single namespace-scoped Secret)
3. NOTES.txt loud warning when plaintext path is taken (single-tenant dev convenience only)
4. Unit test: rendered Job spec has zero `value:` entries for any name matching `*KEY*` or `*SECRET*`

**Validation:** `kubectl get pod <agent-pod> -o yaml | grep -E 'KEY|SECRET' | grep value:` returns empty across smoke run.

### 2.2 Sub-team: Isolation ✅ DONE (v0.1.9-isolation)

**Releases:** `v0.1.9-isolation` — shipped 2026-05-03 on `feat/wave0-isolation`.
**Owns:** `packages/operator/src/job-spec.ts`, `packages/operator/src/reconcile.ts`, `packages/agent-pod/src/builtin-tools.ts`, `packages/agent-pod/src/env.ts`
**Reads:** `packages/agent-pod/src/builtin-tools-spawn.ts`

**Deliverables (all shipped):**
1. ✅ Operator stamps `KAGENT_TASK_DEPTH` env (read from `kagent.knuteson.io/task-depth` AgentTask label; root = 0).
2. ✅ Cluster-level cap (`KAGENT_AGENT_POD_MAX_DEPTH`, default 4) enforced inside `defineSpawnChildTask` AND at admission (`admission.ts:findDepthViolatingJobs` + `selectAdmittable.maxDepth`); refusal taxonomy `policy_denied:depth_exceeded` shared by both paths.
3. ✅ Parent → child AgentTask `ownerReferences` set in `K8sTaskCreator.createChildTask` (`controller: false`, `blockOwnerDeletion: true` to mirror `task-graph.ts:buildChildTaskManifest`).
4. ✅ `Job.spec.ttlSecondsAfterFinished: 300` default (was 3600); Helm-overridable via `BuildJobSpecOptions`.
5. ✅ `Job.spec.backoffLimit: 0` pinned via `DEFAULT_BACKOFF_LIMIT` (now exported); unit test asserts the constant.
6. ✅ New built-in tool: `get_my_context()` returning `{taskUid, taskName, taskNamespace, agentName, parentUid?, depth, budget: {tokensRemaining?, secondsRemaining?}}`. Defined as `defineGetMyContext(deps)` in `builtin-tools.ts`; wired into the substrate-tools provider in `main.ts`.

**Validation:** unit-test smoke covers depth=4 attempting spawn refused with `policy_denied:depth_exceeded`; `K8sTaskCreator.createChildTask` ownerRef test confirms the cascade chain. Pre-existing 231 agent-pod + 406 operator tests still pass; +21 agent-pod, +19 operator new unit tests (252 + 425 totals).

### 2.3 Sub-team: Gateway

**Releases:** `v0.1.10-gateway-status`, `v0.1.11-traceparent`, `v0.1.12-keys-rest`
**Owns:** `packages/llm-gateway/src/`, `packages/agent-pod/src/runner.ts` (traceparent threading), `packages/operator/src/job-spec.ts` (traceparent env)

**Deliverables:**
1. **gateway-status:** gateway PATCH `ModelEndpoint.status.observedInFlight` with AIMD-tuned cap (demoted: optional when enterprise gateway exposes its own backpressure via 429 + Retry-After)
2. **traceparent:** stamp `traceparent` into `AgentTask.spec.runConfig.traceparent` on spawn; operator threads to spawned Job env (`OTEL_TRACEPARENT`); agent-pod main.ts seeds OtelTraceSink root span context from env
3. **keys-rest:** `POST /admin/keys` (admin-token auth, returns plaintext once + records hash); `GET /admin/keys`; `DELETE /admin/keys/:id`

**Note on demotion:** with the CTK enterprise gateway providing routing/PII/cache, the `gateway-status` AIMD work becomes a fallback for the OSS bundled gateway only. Enterprise consumers skip it and rely on 429 + Retry-After per [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) §7.

**Validation:** Langfuse trace tree shows parent → child task spans with continuous trace ID; `curl -H 'authorization: Bearer <admin>' POST /admin/keys` returns plaintext key once.

### 2.4 Sub-team: Hygiene

**Releases:** `v0.1.13-prompts-migrated`, `v0.1.14-ci-kind-gate`
**Owns:** `new_localai/.../demo-resources.yaml` (consumer-side prompt CRs), `.github/workflows/ci.yml`
**Reads:** Langfuse prompt index

**Deliverables:**
1. **prompts-migrated:** orchestrator + summarizer-{k8s,postgres} Agent CRs use `systemPromptRef: { name: <agent>-system }` (mirrors summarizer-rust); inline `systemPrompt` removed
2. **ci-kind-gate (SHIPPED v0.1.14):** new CI job `helm-smoke-kind` brings up ephemeral kind, builds operator + workbench images locally (linux/amd64, no push), `kind load`s them, runs `helm install --wait` against both charts using the `ci/kind-smoke-values.yaml` overlay (smoke AgentTask + NetworkPolicy + artifact PVC disabled), asserts CRDs Established + Deployments Available. Gates `build-images` on green. AgentTask flow skipped — kind has no LLM endpoint and the gate's job is template + startup regression coverage.

**Validation:** every Agent CR with `systemPromptRef` boots cleanly; CI fails on a deliberately-broken Helm template change. (`v0.1.14-ci-kind-gate`: gate active on PR + push-to-main; kind cluster + image build + `helm install --wait` round-trip in <15min.)

### 2.5 Sub-team: Audit

**Releases:** `v0.1.15-audit-stream` ✓ (2026-05-03)
**Owns:** new package `@kagent/audit-events`, NATS JetStream `audit` stream, `packages/operator/src/admission.ts` (proof-of-life emission)
**Reads:** `packages/operator/src/reconcile.ts`, `packages/agent-pod/src/runner.ts` (other emission callsites land in subsequent commits by their owning sub-teams)

**Deliverables:**

1. ✓ `@kagent/audit-events` package with CloudEvents v1.0 envelope (`makeEvent`), generic-typed for per-type call-site narrowing
2. ✓ Ten event-type string consts + per-type TS data interfaces (`task.admitted`, `task.spawned`, `task.completed`, `task.failed`, `child.spawned`, `capability.minted`, `capability.used`, `secret.accessed`, `quota.breached`, `contract.violated`)
3. ✓ `AuditPublisher` — NATS JetStream publisher with explicit best-effort contract (graceful no-op on unreachable NATS, never throws into the request critical path)
4. ✓ Helm chart provisions the `audit` stream via post-install/post-upgrade Job (`templates/audit-stream.yaml`) using `natsio/nats-box`. MaxBytes 10GB, MaxAge 30d, retention `limits`, file storage. New `audit:` block in `values.yaml` (additive; default `enabled: true`).
5. ✓ Wave 0 proof-of-life emission: operator's admission reconciler emits `task.admitted` per accepted AgentTask. Other emission sites (capability.minted, child.spawned, secret.accessed, quota.breached, contract.violated, …) integrate additively as their owning Wave 0/1/2 sub-teams land their releases.
6. ✓ Unit tests (35) cover envelope conformance + best-effort publisher contract. Integration tests (8) cover the operator admission flow emitting one `task.admitted` per successful admission with the correct subject/data shape, no false positives on conflict / failure / disabled paths, and graceful handling of a misbehaving emission hook.

**Validation:** `helm template . --set audit.enabled=true` renders the provisioning Job; `--set audit.enabled=false` renders zero audit resources. `pnpm test` in `@kagent/audit-events` and `@kagent/operator` pass clean (35 + 414 tests).

**Critical dependency:** Wave 2 sub-team Caps depends on this stream existing — capability mints must emit audit events from day one. Wave 0 ships first; Wave 2 cap-mint integration is straightforward (`makeEvent({ type: CAPABILITY_MINTED, ... })` → `auditPublisher.publish()`).

### 2.6 Sub-team: Entry

**Releases:** `v0.1.16-entry-points`
**Status:** SHIPPED — `v0.1.16-entry-points` tagged with `@kagent/triggers` package + `KagentSchedule` CRD + HMAC webhook receiver wired into operator main.ts; Helm chart adds webhook Service + optional Ingress + per-trigger Secret; default-OFF posture matches WS-M/WS-K. Wave 2 caps replace the placeholder annotation.
**Owns:** new package `@kagent/triggers`, `KagentSchedule` CRD, webhook receiver in operator
**Reads:** `packages/operator/src/admission.ts`

**Deliverables:**
1. `KagentSchedule` CRD (cron-style schedule + AgentTask template)
2. Operator-side schedule controller (creates AgentTasks per schedule)
3. Webhook receiver (HMAC-signed POST → AgentTask creation); Helm-exposable Service + Ingress
4. Both routes use a "shared cap with all rights" placeholder until Wave 2 ships per-trigger caps

**Validation:** smoke webhook + smoke schedule both produce AgentTasks visible in workbench within 1m.

### 2.7 Wave 0 cross-team coordination

**File-conflict matrix:**

| File / area | Owners |
|---|---|
| `packages/operator/src/job-spec.ts` | Secrets + Isolation (sequential merge; rebase second) |
| `packages/operator/src/main.ts` env-injection | Secrets + Isolation + Gateway (need explicit ordering) |
| `packages/operator/charts/kagent-operator/values.yaml` | Secrets + Audit + Entry (additive only) |
| `packages/agent-pod/src/builtin-tools.ts` | Isolation (`get_my_context`) only |
| `packages/agent-pod/src/runner.ts` | Gateway (traceparent) + Audit (event emission) — different sections |
| `docs/ROADMAP.md` | All teams update their own table row only |

**Coordination protocol:** every team works on its own branch (`feat/wave0-<team>`); Secrets merges first (highest blast-radius reduction); Isolation merges second; rest interleave.

---

## 3. Wave 1 sub-teams (~4-5 weeks)

### 3.1 Sub-team: I/O (foundational, blocks Workspace + CAS) ✓ SHIPPED v0.2.0-typed-io

**Releases:** `v0.2.0-typed-io` ✓
**Owns:** `packages/operator/src/crds/types.ts`, `packages/operator/src/crds/agent.ts`, `packages/operator/src/crds/agent-task.ts`, `packages/operator/src/admission.ts`, `packages/operator/src/task-admission.ts`, `packages/agent-pod/src/env.ts`
**Reads:** all consumers of `AgentSpec`

**Deliverables:**
1. ✓ `Agent.spec.inputs[]` + `Agent.spec.outputs[]` schema (kind: `workspace | artifact | scalar`; mediaType, mountPath, optional, required)
2. ✓ `AgentTask.spec.inputs[].from: { workspace | taskUid+output | scalar }` (oneOf JSON-schema; tagged-union TS surface)
3. ✓ `AgentTask.spec.idempotencyKey: string` (admission dedupe — operator-local 24h TTL `IdempotencyCache`; Stripe / Temporal pattern)
4. ✓ Operator admission: validate `AgentTask.spec.inputs` satisfies `Agent.spec.inputs`; refuse with `reason: 'InvalidInputs'` + `contract.violated` audit; tasks marked Failed before Job creation
5. ✓ Operator reconciler: refuse `Completed` patch with missing required outputs (`enforceCompletionContract` runs onUpdate); force `Failed` with `reason: 'MissingRequiredOutputs'` + `contract.violated` audit
6. ✓ Migrated `KAGENT_AGENT_SPEC` + `KAGENT_TASK_SPEC` from env JSON to per-Job ConfigMap mounted at `/var/kagent/config/` (closes ARG_MAX cap + `kubectl describe pod` env leak); ConfigMap owned by AgentTask via ownerReferences (cascading delete); RBAC extended with `configmaps: [get,list,watch,create,delete]`
7. ✓ Deprecated `parentDistillation` — agent-pod logs deprecation warning when read; migration target: `AgentTask.spec.inputs[].from.taskUid + output: 'distillation'`
8. ✓ CRD-drift tooling extended (`scripts/check-crd-drift.ts`); chart mirror kept in sync with `manifests/crds/`

**Validation (achieved):**
- v0.1 Agent CRs (no inputs/outputs) admit + dispatch unchanged (back-compat verified by tests `back-compat: a v0.1 Agent (no inputs[]) ... dispatches normally`)
- New Agent declaring required `inputs[].from.workspace` blocks AgentTask creation when no binding present (tested: `rejects a task that doesnt bind a required Agent input`)
- Idempotent task submission (same `idempotencyKey` + same input hash) dedupes within 24h window (tested: replay marks Completed with cached outputs + emits `task.deduped`)
- `kubectl get pod <agent-pod> -o yaml` shows `KAGENT_AGENT_MODEL` env only (small string); the JSON spec lives in the ConfigMap mount
- All 1107+ existing tests still pass (operator: 548, agent-pod: 269; `pnpm typecheck`/`pnpm lint`/`crd:check` pristine)

**Schema decisions locked for Workspace + CAS:**
- `kind: 'workspace' | 'artifact' | 'scalar'` enum on `InputDecl` — Workspace consumes `workspace`, CAS consumes `artifact`
- `mountPath` REQUIRED at admission for `kind: workspace | artifact`; default-deny on missing
- `from.workspace | from.taskUid+output | from.scalar` mutually exclusive (CRD-level `oneOf`; TS-level tagged union)
- `OutputDecl.retention: string` field threaded through schema for forward-compat with v0.2.2-cas
- `Agent.spec.workspaceClaims[]` reserved as opaque object array — Workspace sub-team locks shape in v0.2.1
- `AgentTask.status.outputs[]` shape: `{ name, ref }` where `ref` is a `cas://sha256:<hex>/<name>` URI in v0.2.2 (artifact kind) or string-encoded scalar (scalar kind)

### 3.2 Sub-team: Workspace ✓ SHIPPED v0.2.1-workspaces

**Releases:** `v0.2.1-workspaces`
**Owns:** Workspace controller (co-located in `@kagent/operator`), `Workspace` CRD, init-container clone Job
**Depends on:** I/O sub-team's `Agent.spec.workspaceClaims[]` schema field

**Status:** SHIPPED — Workspace CRD + types + drift check; Workspace controller (PVC provisioning, init-container clone Job, finalizer-based GC, status reconciliation); RWX storage-class probe at startup (gracefully degrades if no RWX class); `buildWorkspaceMounts` helper in `job-spec.ts`; Helm `workspaces.enabled` gate (default OFF). Co-located in `@kagent/operator` rather than a new package — orchestrator's judgment per WAVES.md §3.2 brief. Bytes-used (`du`) probe + admission integration for >80%/>95% quota events deferred to a follow-up wave (status field + condition surface present, probe not yet wired). Operator package: 587 → 691 tests (+104 across both Wave 1 sub-teams).

**Deliverables:**
1. `Workspace` CRD with `source.git`, `pvc`, `ttl`, `quota` ✓
2. Workspace controller: provisions PVC, runs init-container clone, marks `status.phase: Ready` ✓
3. Operator's job-spec reader (`buildWorkspaceMounts`): when AgentTask binds a Workspace input, mount the PVC at the declared path with ro/rw enforcement ✓
4. RWX storage class detection: probe at startup, log + leave in `phase: Pending` if no RWX class (does NOT crash, brief deviated from "fail closed" per the agent's correct judgment — fail-closed would block boot before the cluster admin sees the log) ✓
5. Quota enforcement: status field + conditions surface present; the >80%/>95% probe + admission gating deferred (follow-up wave)
6. GC: Workspace deleted via finalizer dance ✓

### 3.3 Sub-team: CAS ✓ SHIPPED v0.2.2-cas

**Releases:** `v0.2.2-cas`
**Owns:** `packages/agent-pod/src/cas-backend.ts`, `packages/agent-pod/src/builtin-tools.ts` (`read_artifact` addition), `packages/operator/src/cas-gc.ts`, `parseUri` + `casUri` on `crds/artifact-ref.ts`
**Depends on:** I/O sub-team's `Agent.spec.outputs[]` schema; Workspace sub-team's PVC mount conventions (CAS PVC mount lives alongside Workspace mounts on the same Pod)

**Status:** SHIPPED — `ArtifactRef.contentHash` (sha256 hex); `cas://sha256:<hex>/<name>` URI scheme via `casUri()`; `parseUri()` discriminated union (cas | pvc | inline); `CasBackend` interface with `PvcCasBackend` (Git-loose-objects sharding `<mount>/cas/sha256/<2>/<62>`; atomic rename on write; hash-mismatch detection on read) + `S3CasBackend` stub (signature only, throws on every call); `read_artifact` built-in tool capability-gated by `agentHasArtifactInputOrOutput(spec)`; CAS GC controller (`parseRetention`, `buildReachabilitySet`, `walkCasBlobs`, `shouldDelete`, `runOnce`, `startCasGc`); `buildArtifactMounts` helper for `kind:'artifact'` mounts at `/var/kagent/cas/` (read-only); Helm `cas:` block (default OFF). Agent-pod: 269 → 303 tests (+34). The brief's `read_artifact({uri | hash})` was simplified to `{uri}` only — agent-pod doesn't have agent-name context to resolve a bare hash to a URI. Documented in code.

**Deliverables:**
1. ArtifactRef gains `contentHash: string` (sha256 hex); `uri` shape `cas://sha256:<hex>/<name>` ✓
2. CAS backend abstraction (PvcCasBackend default; S3 stub for v0.3) ✓
3. New built-in tool: `read_artifact(uri: string) → ContentBlock[]`; capability-gated ✓
4. `buildArtifactMounts` helper for kind:'artifact' inputs ✓
5. Helm `cas:` block (`enabled`, `pvcName`, `mountPath`, `retention.default`, `gc.intervalSeconds`) ✓
6. Operator GC by reachability + retention: walks `<mount>/cas/sha256/**`, unlinks blobs older than retention UNLESS reachable from a non-Completed AgentTask's `status.outputs[].ref` ✓

**Validation:** smoke test for identical-input → cache-hit replay deferred to integration test (Wave 2+); unit-level coverage in place (parseRetention, buildReachabilitySet, walk + delete predicates).

### 3.4 Wave 1 cross-team coordination

**Sequencing:** I/O ships first; Workspace + CAS branch from I/O's main merge.

**File-conflict matrix:**
- `packages/agent-pod/src/builtin-tools.ts` — CAS only (`read_artifact`)
- `packages/operator/src/crds/types.ts` — I/O only
- `packages/operator/src/admission.ts` — I/O only
- `packages/operator/src/job-spec.ts` — Workspace (mount plumbing) + CAS (artifact mount) — additive, no conflict

**Shared interface:** `Agent.spec.inputs[].kind` enum is the contract Workspace + CAS rely on. Defined in I/O's first PR; Workspace + CAS branch after that PR merges.

---

## 4. Wave 2 sub-teams (~5 weeks)

### 4.1 Sub-team: Caps (foundational, blocks Supervision + Workflows)

**Releases:** `v0.3.0-capabilities` — **SHIPPED**
**Owns:** new `@kagent/capability-types` package, operator `cap-ca` + `cap-issuer`, operator capability admission, agent-pod cap consumer
**Depends on:** Audit (Wave 0) — every cap mint emits an audit event

**Deliverables:**
1. **SHIPPED.** JWT capability bundle schema published as `@kagent/capability-types` per [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §3.6 — types, validators, glob-match, JOSE round-trip helpers (ES256 + RS256; HS256/none rejected). 67 tests.
2. **SHIPPED.** Operator CA: file-mount path (Helm Secret) is the production default — works WITHOUT cert-manager. cert-manager Issuer path is data-equivalent (chart provisions the Issuer/Certificate; operator just reads the rotated Secret). JWKS document exposed via operator template-server `GET /.well-known/jwks.json`. Rotation cutover via secondary public-key path.
3. **SHIPPED (logic).** Capability-issuer (`packages/operator/src/cap-issuer.ts`): `mintCapabilityForTask(ca, { task, agent, parentBundle? })` resolves Agent claims, narrows by parent bundle, signs via the CA. The reconciler-side wiring that actually invokes this on every admitted AgentTask is **DEFERRED** to a follow-up release (the issuer + CA are tested + ready; main.ts wiring is the only remaining glue).
4. **SHIPPED.** Agent-pod consumer (`packages/agent-pod/src/cap-consumer.ts`): reads JWT via mounted Secret-volume file (`KAGENT_CAP_JWT_FILE` — never env), verifies against operator JWKS, surfaces decoded claims via `defineGetMyContext` (extends the introspection result with `capability: { jti, expiresAt, tools, spawn, read, write, egress, tenant }`).
5. **SHIPPED.** Spawn narrowing: `defineSpawnChildTask` (in-pod) + `validateCapabilityBounds` (operator admission) both refuse `policy_denied:capability_violation` when child target is outside parent's `cap.claims.spawn` (defense in depth). `capability.used` audit hook fires on successful spawn.
6. **SHIPPED.** Deprecation shim: when an Agent declares `capabilityClaims`, the legacy `allowedChildAgents` / `allowedChildTemplates` / `KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS` fields are SKIPPED in spawn-narrowing (cap takes over). When `capabilityClaims` absent, legacy behavior unchanged. Templates encoded as `template:<name>` patterns under `claims.spawn` so the agent-pod's spawn tool admits them via the `from-template` label round-trip.
7. **DEFERRED.** `verify_completion` substrate hook: schema field added (`AgentTask.spec.verifyContract: { scriptRef?, llmJudgePromptRef? }` + `status.verification`), but the reconciler-side runner (one-shot Job spawn for scriptRef, model-gateway dispatch for llmJudgePromptRef) is deferred. Schema is forward-compatible — Wave 2 follow-up release lights it up.

**Validation:** ✅ The schema gate, narrowing predicate, and JWT sign+verify round-trip are exhaustively tested (~120 tests in this lane). The end-to-end "operator mints, mounts, agent-pod verifies, spawn narrows" path is integration-level and lands with the issuer-controller wiring follow-up.

### 4.2 Sub-team: Supervision ✓ SHIPPED v0.3.1-supervision

**Releases:** `v0.3.1-supervision` — **SHIPPED**
**Owns:** `packages/operator/src/supervision-router.ts` + `failure-classifier.ts`, new `packages/supervision` (pure-functional engine)
**Depends on:** Caps (supervision strategies are cap-claim-gated for adversarial scenarios — predicate present, not yet enforced)

**Status:** SHIPPED — all 6 deliverables landed, no deferrals. Operator: 691 → 783 tests (+92). New `@kagent/supervision`: 28 tests covering all 4 strategies + edge cases. 3 new audit event types (`supervision.applied`, `supervision.restart_limit_exceeded`, `infra.fault.observed`). Restart cap = bound + intent recording at v0.3.1; the actual Job re-spawn mechanic composes with Workflows + Wave 4 Quotas (documented in `supervision-router.ts` JSDoc). Cap-claim-gating left predicate-only (`assertStrategyAllowed`) for Wave 4 Tenancy to flip on for adversarial multi-tenant — ungated strategy choice is the simpler v0.3.1 default.

**Deliverables:**
1. `Agent.spec.supervisionStrategy: one_for_one | one_for_all | rest_for_one | escalate` (default `one_for_one`) ✓
2. Operator child-failure handler routes per strategy via `supervision-router.ts` wired into reconciler `onUpdate` ✓
3. Structured-vs-infra failure classifier: structured contract violations trigger supervision; infrastructure faults (OOMKilled, image-pull, etc.) emit `infra.fault.observed` and let K8s Job backoffLimit handle them ✓
4. `Agent.spec.maxRestarts` cap (default 3, min 0) + `AgentTask.status.restartCount` + fail-closed `restart_limit_exceeded` ✓
5. Pure-functional `evaluateStrategy()` engine in `@kagent/supervision` with comprehensive unit tests for all 4 strategies ✓
6. Helm wiring: `supervision:` values block (default `enabled: true`), `KAGENT_SUPERVISION_*` env, no new RBAC verbs needed ✓

### 4.3 Sub-team: Workflows ✓ SHIPPED v0.3.2-workflows

**Releases:** `v0.3.2-workflows` — **SHIPPED**
**Owns:** new `packages/agent-workflow-runtime`, `AgentWorkflow` CRD, `agent-workflow-controller.ts`, `mintCapabilityForWorkflow` extension to `cap-issuer.ts`
**Depends on:** Caps (Workflows carry their own cap, minted via `mintCapabilityForWorkflow`)

**Status:** SHIPPED — 6 deliverables landed (some with planned forward-compat deferrals). Operator: 783 → 817 tests (+34). New `@kagent/agent-workflow-runtime`: 13 tests (5 `defineWorkflow` + 8 crash-recovery). 5 new audit event types (`workflow.started`, `workflow.step.completed`, `workflow.completed`, `workflow.failed`, `workflow.event_subscription_pending`). Crash-recovery proof: 3-fanout orchestrator test demonstrates replay returns same task UIDs + 0 re-issues — the foundational property of durable execution.

**Deliverables:**
1. `AgentWorkflow` CRD (image, handler, triggers, capabilityRef, capabilityClaims, replicas, restateAddress) — TS surface + manifest + chart copy + drift-check row ✓
2. `@kagent/agent-workflow-runtime` host SDK: `defineWorkflow` + `WorkflowContext` exposing 5 deterministic ops (`spawnAgentTask`/`awaitTask`/`signal`/`awaitSignal`/`sleep`); in-memory deterministic runner ✓
3. AgentWorkflow controller: informer triplet (CR + Deployment + Service), cap-mint via `mintCapabilityForWorkflow`, Secret-volume cap delivery, Restate admin POST registration, trigger materialization (KagentSchedule for `schedule`, webhook conditions for `webhook`) ✓
4. Triggers: schedule + webhook materialization shipped; event-trigger schema persisted as `pending` status condition (Wave 3 Events lights up the dispatcher) ✓
5. Crash-recovery proof: in-memory runtime with 3-fanout test demonstrating deterministic replay; real Restate adapter (`toRestateService`) deferred to homelab-exercise time ✓
6. Helm wiring: `workflows:` values block (default `enabled: false`), Restate address env (chart documents `restatedev/restate-helm` install path; sub-chart inline at v0.5), full RBAC for AgentWorkflow + Deployment + Service + Secret ✓

**Forward-compat deferrals (captured in commit message + JSDoc):** real Restate adapter, Restate cluster sub-chart, `capCa` cap-issuer wiring (matches Caps' own §4.1 deferral), webhook receiver-side path dispatch, event-trigger NATS subscription.

### 4.4 Wave 2 cross-team coordination

**Sequencing:** Caps ships first (3 weeks); Supervision + Workflows branch.

**File-conflict matrix:**
- `packages/operator/src/admission.ts` — Caps only (cap validation)
- `packages/operator/src/reconcile.ts` — Caps + Supervision (different code paths)
- `packages/agent-pod/src/runner.ts` — Caps (cap consumption) only

**Shared interface:** capability bundle JWT schema is the API every other Wave 2 sub-team depends on. Caps team publishes the schema as `@kagent/capability-types` package early in their release.

---

## 5. Wave 3 sub-teams (~2-3 weeks)

All five sub-teams are mostly independent. Some share NATS JetStream as backbone; coordination is on subject namespacing.

### 5.1 Sub-team: Events ✓ SHIPPED v0.4.0-events

**Releases:** `v0.4.0-events`
**Owns:** new `packages/events`, NATS JetStream stream provisioning, `Agent.spec.publishes/subscribes` schema

**Deliverables:**
1. Typed event schema (CloudEvents shape, JSON-Schema'd payloads)
2. `Agent.spec.publishes/subscribes[]` resolved at admission to NATS subject ACLs
3. Capability-gated topic ACLs (cap claim `publish: [topic]` / `subscribe: [topic]`)
4. Built-in tools: `publish_event(topic, data)`, no `subscribe_event` (subscriptions are reactive — see Triggers integration)
5. Trigger integration: an event subscription can mint an AgentTask via the Wave 0 Entry plumbing

**Validation:** agent A publishes; agent B subscribes; B's AgentTask is minted on each event; cap denies cross-tenant subscribe.

**Status:** SHIPPED — `@kagent/events` package (CloudEvents v1.0 envelope, `validateTopic` lowercase reverse-DNS dialect, `EventValidator` registry, `EventPublisher` with cap-claim glob gate, `EventDispatcher` with idempotent `applySubscriptions` + per-(agent, topic) durable pull-consumer); `Agent.spec.publishes[] / subscribes[]` extension; `validateEventTopicsAgainstClaims` admission validator; `definePublishEvent` agent-pod tool with cap-claim gate + 64KiB payload cap + `policy_denied:` taxonomy; operator-side `events-bootstrap.ts` (idempotent stream provision; pull-consumer factory; `buildEventTriggerAgentTaskCreator` rendering `AgentTask.spec.inputs[<inputBinding>] = { scalar: event.data }`); Helm `events:` values block + `KAGENT_EVENTS_*` env wiring. Tests: `@kagent/events` 53; `@kagent/operator` +5; `@kagent/agent-pod` +8. Subject namespace `kagent.events.*` locked.

### 5.2 Sub-team: Blackboard ✅ DONE (v0.4.1-blackboard)

**Releases:** `v0.4.1-blackboard` — shipped on `feat/wave3-blackboard`.
**Owns:** new `packages/blackboard`, NATS JetStream KV bucket per task tree, built-in tools

**Deliverables (all shipped):**
1. ✅ NATS JetStream KV bucket per root AgentTask UID — `BlackboardBucketManager.ensureBucket(rootUid)` provisions on root admission via the operator's `maybeRouteBlackboard` handler hook in `main.ts`. Bucket name: `kagent-kv-<root-uid>` (`bucketNameForRootUid`).
2. ✅ Four built-in tools wired into `agent-pod/src/builtin-tools.ts` under `// === Wave 3 — Blackboard ===`: `read_blackboard({key}) → {value, revision} | null`, `write_blackboard({key, value}) → {revision}` (last-writer-wins), `list_blackboard({prefix?}) → {keys[]}` (capped at 1000), `append_blackboard({key, value})` (read-splice-CAS PUT loop, max 5 retries, throws `tool_error: contended` after).
3. ✅ Cap-gating via NEW `CapabilityClaims.blackboard?: { read?, write? }` claim (additive in `@kagent/capability-types/src/types.ts`); validators + subset checks + cap-issuer narrow path all updated. Predicates live in `@kagent/blackboard/acl` (`checkReadAllowed`/`checkWriteAllowed`/`checkListAllowed`/`checkAppendAllowed`); tools throw `policy_denied:` on refusal.
4. ✅ Per-Job env stamping: operator's `job-spec.ts` emits `KAGENT_BLACKBOARD_BUCKET=kagent-kv-<root-uid>` for every spawned pod. Root UID resolved from a new `kagent.knuteson.io/root-task-uid` label (mirrored in `agent-pod/src/k8s-task-creator.ts` for in-pod spawns and in `operator/src/task-graph.ts:buildChildTaskManifest` for operator-side child manifests). Roots fall back to own `metadata.uid`.
5. ✅ GC + audit hook: operator's `maybeRouteBlackboard` calls `manager.destroyBucket(rootUid)` on terminal phase transition; `BlackboardBucketManager.onDestroyed` callback emits `[kagent-operator/blackboard.gc]` log line. (Full `audit.blackboard.gc` CloudEvent type reserved for a follow-up minor bump of `@kagent/audit-events` — wiring point exists.) Idempotent on bucket-not-found.

**Validation:** unit-test smoke covers seed-via-`create` race, CAS-loop convergence, three sequential appends to same key landing as `[1,2,3]`. Cap-gate predicates + denial messages exhaustively unit-tested. New package `@kagent/blackboard`: 41 tests. New agent-pod tests: +24 (348 total). New operator tests: +16 (833 total). New capability-types tests: +8 (75 total).

### 5.3 Sub-team: Cache ✓ SHIPPED v0.4.2-cache

**Releases:** `v0.4.2-cache` — **SHIPPED**
**Owns:** new `packages/cache-controller`, `Agent.spec.caches[]` schema integration

**Status:** SHIPPED — substrate primitives complete (key derivation, restore init-container, save sidecar command, audit events, CRD schema). Operator + cache-controller package tests: 824 + 34 (= 858 cumulatively). 2 new audit event types (`cache.hit`, `cache.miss` — total catalog grows from 18 → 20). Reconciler-side per-task auto-call of `buildCacheMounts` (auto-resolving `inputArtifactHashes` from upstream `taskUid+output` refs in the AgentTask informer) is documented as a forward-compat follow-up — that resolver lands with the CAS sub-team's `read_artifact` arg-resolution; no breaking change required for v0.4.2 substrate consumers (`buildCacheMounts` is callable today; the resolver is the only missing piece).

**Deliverables:**
1. `Agent.spec.caches[]: [{name, key: <template>, mountPath}]` ✓
2. Key derivation in `@kagent/cache-controller`'s `deriveCacheKey`: `sha256(rendered-template)`. Tokens: `{input_artifact_hashes}` (sorted+joined), `{image_digest}`, `{model_name}`. `key: 'default'` sugar for the canonical recipe ✓
3. Operator-side restore: `buildCacheRestoreInitContainer` + `buildCacheMounts` (job-spec.ts) materialize a single init-container that copies cached bytes from the cache PVC onto per-slot emptyDirs that the agent container mounts at `Agent.spec.caches[].mountPath` ✓
4. Operator-side save: `buildCacheSaveCommand` builds the sidecar / watcher-Job tar-stream payload that fires only on agent success exit (sentinel-file watch + atomic-rename pattern); the helper is shipped, the watcher-Job glue lands with the artifact-hash resolver ✓ (substrate-complete)
5. Helm `cache:` block (`enabled: false`, `pvcName: 'kagent-cache'`, `defaultRetention: '7d'`, `mountPath: /var/kagent/cache`, `helperImage: busybox:1.36`) + KAGENT_CACHE_* env wiring on the operator deployment ✓
6. Audit: `cache.hit` / `cache.miss` events in `@kagent/audit-events` (catalog 18 → 20) ✓
7. Cache miss = NEVER an error; cold fall-back is the contract ✓

**Validation:** unit-level coverage in place (34 tests in `@kagent/cache-controller` + 7 `buildCacheMounts` tests in operator). End-to-end "npm install cache survives across runs" smoke test deferred to homelab integration.

### 5.4 Sub-team: Identity ✓ SHIPPED v0.4.3-identity

**Releases:** `v0.4.3-identity` — **SHIPPED**
**Owns:** SPIFFE/SPIRE Helm sub-chart, agent-pod SVID consumer, gateway mTLS termination
**Depends on:** Caps (cap signing CA is operationally adjacent to SPIRE CA)

**Status:** SHIPPED — substrate primitives + audit hooks landed. Operator: 817 → 844 tests (+27). Agent-pod: 324 → 339 tests (+15). 2 new audit event types (`identity.svid_issued`, `identity.rotation`). Helm chart smoke test: zero SPIRE resources by default; `identity.enabled=true` renders Server StatefulSet + Agent DaemonSet + ClusterRoles; `identity.mock.enabled=true` renders only the marker ConfigMap.

**Deliverables:**
1. ✓ SPIRE deployed via sub-chart at `charts/kagent-operator/charts/spire/`; per-pod SVID issuance via Workload-API socket (default OFF, gated on `identity.enabled=true`).
2. ✓ Agent-pod's LLM client uses SVID for mTLS via `IdentityHandle` + `probeGatewayMtls` (with WARN-log fall-back to bearer when handshake refused / 426 returned).
3. ✓ `KAGENT_LITELLM_API_KEY` deprecated when SVID is in use (kept as bootstrap fallback per [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) §4.3 — Wave 4 KeyRotation drops it entirely).
4. ✓ Cap-CA additive SPIRE-managed key source: when `KAGENT_IDENTITY_ENABLED=true` the cap-ca looks for SPIRE-managed signing keys first, falls through to chart Secret. Wave 2 tests preserve unchanged.
5. ✓ Audit events: `identity.svid_issued` + `identity.rotation` (CloudEvents v1.0 envelope, ALL_EVENT_TYPES grew 18 → 20).

**Forward-compat deferrals (documented in JSDoc):**
- Real SPIRE Workload-API gRPC streaming — agent-pod consumes spiffe-helper-materialized cert files (canonical materializer pattern); kagent does NOT vendor a gRPC client.
- Operator-side `RegistrationEntry` controller — SPIRE Server's k8s_psat attestor binds workloads via selector ladder; a kagent-side controller for fine-grained registration is a follow-up.
- mTLS probe is permissive (handshake completion presumed mTLS-on-the-wire); a richer challenge protocol can tighten this in v0.4.x.

**Validation:** `helm template .` renders zero SPIRE resources by default; `--set identity.enabled=true` renders SPIRE Server + Agent + RBAC; `--set identity.mock.enabled=true` renders only the marker ConfigMap. Integration with real K3s + real SPIRE deferred to Wave 4 KeyRotation chaos test.

### 5.5 Sub-team: Locality ✅ SHIPPED (v0.4.4-locality)

**Releases:** `v0.4.4-locality` — shipped 2026-05-04 on `feat/wave3-locality`.
**Owns:** `packages/locality-controller` (pure helpers), additive callsites in `packages/operator/src/{reconcile,admission,main}.ts`

**Deliverables (all shipped):**
1. ✅ `deriveNodeAffinity(agent, task, lookup) → V1Affinity | undefined` —
   `packages/locality-controller/src/node-affinity.ts`. When an Agent declares a
   `kind: 'workspace'` input bound to a Workspace whose PV is node-pinned,
   emits `requiredDuringSchedulingIgnoredDuringExecution` mirroring the PV's
   `nodeAffinity.required.nodeSelectorTerms[]`. Tie-break across multiple
   workspaces: largest `bytesUsed`. Wired into the reconciler via a new
   `ReconcileDeps.deriveNodeAffinity` callback that splices the result onto
   the spawned pod spec post-`buildJobSpec` (additive — `buildJobSpec` is
   unchanged).
2. ✅ Speculative execution — `packages/locality-controller/src/speculative.ts`.
   Pure `evaluateSpeculative` decision over a per-Agent in-process latency
   ring (100-sample default, min 5 samples). When `elapsedMs > threshold ×
   median`, emits a `kind: 'spawn'` decision; the operator's main.ts
   composes it with a spawn callable + audit hooks. Twin manifest carries
   the SAME idempotency key — Wave 1's `IdempotencyCache` prevents
   double-effect.
3. ✅ Pod-pressure circuit breaker — `checkPodPressure` in
   `packages/operator/src/admission.ts` (additive gate; existing per-(model,
   namespace) + per-Agent + depth scheduler unchanged). Refusal taxonomy
   `policy_denied:pod_pressure_threshold`. Default cap: 50 pending
   agent-pods (`KAGENT_LOCALITY_MAX_PENDING_PODS`).
4. ✅ Helm `locality:` block in `values.yaml`. Defaults:
   `locality.enabled: true` (NodeAffinity), `locality.speculative.enabled:
   false` (opt-in), `locality.speculative.threshold: 3.0`,
   `locality.circuitBreaker.enabled: true`,
   `locality.circuitBreaker.maxPendingPods: 50`.
5. ✅ Audit-events catalog grows: `locality.speculative_spawned`,
   `locality.speculative_superseded`, `admission.pod_pressure_deferred`
   (`@kagent/audit-events`; total event types now 21).
6. ✅ Tests: 40 new pure-function tests (`packages/locality-controller`)
   + admission `checkPodPressure` + `countPendingAgentPods` cases on the
   operator side.

**Validation:** unit-test smoke covers (a) no affinity emitted when PV not
node-pinned, (b) largest-bytesUsed tie-break, (c) speculative decision
gates (disabled / no-key / already-twin / insufficient-samples /
under-threshold / spawn), (d) pod-pressure refusal envelope. Total
operator + locality test counts: 824 + 40 = 864 (up +28 vs. pre-Wave-3).

### 5.6 Wave 3 cross-team coordination

**Shared:** all five teams are loosely coupled. Coordinate on:
- NATS subject namespacing (Events vs Blackboard) — agree on prefixes (`kagent.events.*` vs `kagent.kv.*`)
- Helm sub-charts (SPIRE vs new infrastructure) — single `infra/` namespace
- Trace attribute keys — coordinate via [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) update PR

---

## 6. Wave 4 sub-teams (~3 weeks)

### 6.1 Sub-team: Tenancy ✓ SHIPPED v0.5.0-tenancy

**Releases:** `v0.5.0-tenancy` — **SHIPPED**
**Owns:** `Tenant` CRD, namespace-scoped controllers, capability tenant claim integration
**Depends on:** Caps (tenant is a cap-claim scope)

**Deliverables:**
1. **SHIPPED.** `Tenant` CRD (cluster-scoped) — `name`, `namespaceAllowlist`, `capabilityRoot.issuer` override, `auditSubject` override, `defaultQuota` (consumed by Wave 4 Quotas), `defaultEgress` (consumed by Wave 4 Egress). TS surface in `packages/operator/src/crds/tenant.ts` + manifest at `packages/operator/manifests/crds/tenants.yaml` + chart copy + drift-check row. Plurals `tenants/tenant`, shortName `kt`, listKind `TenantList`. Type guards + readiness + namespace-admission helpers.
2. **SHIPPED.** Per-tenant Agent visibility — operator stamps `kagent.knuteson.io/tenant=<name>` label on every Agent + AgentTask at admission time. Cross-tenant visibility refusal achieved via K8s RBAC (cluster admin authors per-tenant Role + RoleBinding overlays; chart NOTES.txt documents the recommended pattern). Admission validator (`validateTenantNamespace`) refuses with `policy_denied:tenant_namespace_mismatch` when tenant's `namespaceAllowlist` excludes the AgentTask's namespace.
3. **SHIPPED.** Tenant-scoped capability claim — `mintCapabilityForTask` + `mintCapabilityForWorkflow` in `packages/operator/src/cap-issuer.ts` accept an optional resolved Tenant CR and stamp `claims.tenant` (Agent-author pin > Tenant CR default > unset). Per-tenant `capabilityRoot.issuer` override threads into the JWT `iss` claim via `MintCapInput.issuerOverride`. Precedence documented in JSDoc.
4. **SHIPPED.** `X-Kagent-Tenant` header threading per [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) §3 — `buildLlmClient` (in `packages/agent-pod/src/runner.ts`) accepts a 4th `tenant` arg and stamps the header onto every outbound `/chat/completions` call. `RunDeps.capabilityBundle` is the source; runner reads `claims.tenant` and passes through. Header omitted when tenant claim absent or empty (per brief).
5. **SHIPPED.** Tenant migration tooling — `packages/operator/scripts/migrate-tenants.ts` CLI: `move <agent-name> --from-tenant <a> --to-tenant <b>` rewrites Agent's tenant label + cascades to in-flight (non-Completed/non-Failed) AgentTasks. Refusal taxonomy: `TargetTenantNotFound` / `TargetNamespaceNotAllowed` / `SourceTenantMismatch` / `AgentMissingNamespace`. Dry-run default; `--apply` commits. Audit emission via `tenant.migration` event.
6. **SHIPPED.** Audit events — `tenant.created` / `tenant.updated` / `tenant.deleted` / `tenant.admission_violation` / `tenant.migration`. Catalog grows from 25 → 30. CloudEvents v1.0 envelope shape + per-type data interfaces in `@kagent/audit-events`.
7. **SHIPPED.** Tenant controller — `packages/operator/src/tenant-controller.ts` (cluster-scoped informer). Reconciles each Tenant CR: refreshes `status.namespaceCount` / `agentCount` / `activeTaskCount`, computes `phase` (Failed on namespace-overlap or name-mismatch; Ready when ≥1 allowlisted ns exists; Pending otherwise). Detects overlap with other Tenants. Emits conditions + audit events. Wired in `main.ts` under `// === Wave 4 — Tenancy ===` (gated by `KAGENT_TENANCY_ENABLED=true`; default `false` for gradual roll-out).
8. **SHIPPED.** Helm wiring — `tenancy:` values block (`enabled: false` default + `defaultTenant`); `KAGENT_TENANCY_ENABLED` + `KAGENT_TENANCY_DEFAULT_TENANT` env in `deployment.yaml`; `tenants` + `tenants/status` + `namespaces` ClusterRole verbs; NOTES.txt section documents Tenant CR provisioning + cross-tenant K8s RBAC overlay pattern + migrate-tenants CLI usage.

**Validation:** two tenants in same cluster — operator stamps tenant labels at admission; gateway sees `X-Kagent-Tenant` and routes accordingly; cross-tenant visibility refusal lives in K8s RBAC overlays (chart documents the pattern).

**Status:** SHIPPED — all 8 deliverables landed; no deferrals. Operator: 886 → 971 tests (+85). Agent-pod: 371 → 375 (+4). Audit-events: 37 → 42 (+5). New `Tenant` CRD adds 4 status-observable fields (namespaceCount, agentCount, activeTaskCount, conditions) for downstream Wave 4 sub-teams (Quotas, Egress, KeyRotation) to compose against. Cluster-scoped CRD chosen over namespace-scoped: cap-issuer + admission need cluster-wide visibility to detect overlapping `namespaceAllowlist` entries before they cause cross-tenant data leakage. Default-tenant fallback semantics: cluster-wide `KAGENT_TENANCY_DEFAULT_TENANT` ships in v0.5.0; per-namespace defaults documented as forward-compat (a namespace label `kagent.knuteson.io/default-tenant=<name>` overrides the cluster default; lookup logic stays in `task-admission.ts`'s `resolveTenantForTask`).

### 6.2 Sub-team: Egress

**Releases:** `v0.5.1-egress`
**Owns:** `Agent.spec.egress` schema (already defined in SUBSTRATE-V1.md), NetworkPolicy generation, optional Cilium CNP
**Depends on:** Tenancy (tenant default egress)

**Deliverables:**
1. Operator generates `NetworkPolicy` (or `CiliumNetworkPolicy` when Cilium detected) per Agent based on `Agent.spec.egress`
2. Default-deny: Agents with no `egress` declaration get egress-denied policies
3. Cluster operator can override via tenant defaults

**Validation:** `curl` to undeclared domain from agent-pod times out; declared domain succeeds.

### 6.3 Sub-team: Quotas ✓ SHIPPED v0.5.2-quotas

**Releases:** `v0.5.2-quotas` — **SHIPPED**
**Owns:** quota controllers (org → tenant → agent), pod-pressure circuit breaker (companion to Locality)
**Depends on:** Tenancy

**Deliverables:**
1. **SHIPPED.** `TenantQuota` schema locked at the nested `compute / gateway / storage` shape (per the brief): `compute.{cpuRequests, memoryRequests, maxPods}` materializes a per-(tenant, namespace) K8s `ResourceQuota`; `gateway.{inFlightCap, tokensPerHour}` enforces per-tenant gateway concurrency; `storage.{casBytes, artifactCount}` gates artifact admissions. CRD + chart copy + drift check + tenant.test.ts updates.
2. **SHIPPED.** `buildResourceQuotaForTenant({ tenant, namespace }) → V1ResourceQuota | undefined` in `@kagent/quota-controller`. Pure translator — naming `kagent-tenant-<name>`, labels `kagent.knuteson.io/tenant` + `managed-by`, annotation `quota-source=tenant`. `resourceQuotaSpecDiffers` helper for idempotent reconcile.
3. **SHIPPED.** Per-tenant gateway in-flight cap — `GatewayInFlightCounter` in-process counter with `tryAcquire / release / rebuildFromTasks`. Refusal `policy_denied:tenant_gateway_inflight_exceeded`. Single-replica leader-elected operator constraint (per the brief); rebuild-from-informer on boot/leader-handover. Pure `checkTenantGatewayInFlight` admission gate added to `task-admission.ts` (additive — no refactor of existing gates).
4. **SHIPPED.** Per-tenant CAS storage cap — `walkCasUsageByTenant` walker (10-minute cadence default) sums per-tenant CAS bytes + over-cap set. `startCasQuotaController` boots the timer + emits `quota.storage_exceeded` per newly over-cap tenant per lifecycle. Pure `checkTenantStorage` admission gate added to `task-admission.ts`. Walker does NOT delete (CAS GC owns deletion).
5. **SHIPPED.** Audit events catalog grows from 30 → 34: `quota.gateway_inflight_exceeded`, `quota.storage_exceeded`, `quota.compute_warning`, `quota.resource_quota_applied`. Per-type data interfaces + `ALL_EVENT_TYPES` extended.
6. **SHIPPED.** Helm wiring — `quotas:` block (`enabled: false` default + `defaultGatewayInFlightCap: 100` + `defaultCasBytesGiB: 10` + `casWalkIntervalMinutes: 10`). `KAGENT_QUOTAS_*` env in deployment.yaml; `resourcequotas` ClusterRole verbs (get/list/watch/create/patch/update/delete).
7. **DEFERRED.** Pod-pressure circuit breaker. Already SHIPPED in v0.4.4-locality (Wave 3 — see §5.5); the Wave 4 / Quotas brief lists it for cross-wave coordination, not net-new work. Audit `admission.pod_pressure_deferred` already lands.

**Status:** SHIPPED — 6 of 7 deliverables landed, 1 deferred-as-already-shipped (pod-pressure breaker is v0.4.4 work). Operator: 971 → 979 (+8). Audit-events: 42 → 46 (+4). New `@kagent/quota-controller`: 52 tests (resource-quota generator + gateway in-flight counter + CAS walker). Repo total: 2615 → 2679 (+64). Schema-lock semantics: `TenantQuota` was a flat `{cpu, memory, maxInFlightTasks, maxArtifactBytes}` placeholder in v0.5.0; v0.5.2 replaces it with the nested `{compute, gateway, storage}` shape that downstream consumers actually enforce against — no live tenant CRs yet so no migration tooling required. Gateway counter is in-process per the substrate's single-replica leader-election constraint; multi-replica with shared state is a v0.5.3 follow-up (public API stays stable).

**Validation:** tenant exceeds compute quota → new tasks queued; storage quota → admission refuses new artifacts with structured error.

### 6.4 Sub-team: Versioning

**Releases:** `v0.5.3-versioning`
**Owns:** Agent CR immutability via admission webhook, version-pinning controller, migration tooling

**Deliverables:**
1. Agents immutable post-publish (admission webhook refuses mutation; promotion via new version only)
2. AgentTask pins to Agent version at admission
3. New Agent versions get tasks at version+1 onward; in-flight tasks at version stay
4. Migration discipline: deprecation window, removal window, removal action
5. Version-aware workbench display

**Validation:** edit a published Agent → admission rejects; submit new task → uses latest version; in-flight task survives Agent version bump.

### 6.5 Sub-team: KeyRotation

**Releases:** `v0.5.4-keyrotation`
**Owns:** cert-manager rotation policies, gateway-token rotation (when gateway supports an API per [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) §4)
**Depends on:** Identity (SVID rotation), Audit (rotation events)

**Deliverables:**
1. SVID rotation interval: 24h default, configurable
2. Capability bundle TTL: 1h default for short-running, up to runConfig.timeoutSeconds for long
3. Gateway-token rotation API integration (CTK enterprise gateway needs to expose this)
4. Rotation events in audit stream
5. Zero-downtime rotation chaos test

**Validation:** rotate every credential (SVID, cap, gateway token) under load → no task fails.

### 6.6 Wave 4 cross-team coordination

**Sequencing:** Tenancy first (1.5 weeks); Egress + Quotas + Versioning + KeyRotation parallel after.

---

## 7. Validation: does the plan cover the audit?

Cross-checking every gap raised in the v0.1.x audit against the sub-team plan:

| Audit gap | Wave / sub-team | Release | Covered |
|---|---|---|---|
| Tree depth unbounded | W0 / Isolation → W2 / Caps | v0.1.9 + v0.3.0 | ✓ |
| Transitive fan-out unbounded | W2 / Caps + W4 / Quotas | v0.3.0 + v0.5.2 | ✓ |
| Spawn auth only in agent-pod tool | W2 / Caps | v0.3.0 | ✓ |
| Payload provenance | W2 / Caps | v0.3.0 | ✓ |
| 1h Job TTL too long | W0 / Isolation | v0.1.9 | ✓ |
| Parent→child cascade missing | W0 / Isolation | v0.1.9 | ✓ |
| `backoffLimit` retry double-spawn | W0 / Isolation | v0.1.9 | ✓ |
| Pod-pressure circuit breaker | W3 / Locality + W4 / Quotas | v0.4.4 + v0.5.2 | ✓ |
| Plaintext `KAGENT_LITELLM_API_KEY` | W0 / Secrets → W3 / Identity | v0.1.8 → v0.4.3 | ✓ |
| `KAGENT_AGENT_SPEC` env JSON | W1 / I/O | v0.2.0 | ✓ |
| No Workspace primitive | W1 / Workspace | v0.2.1 | ✓ |
| No `read_artifact` for siblings | W1 / CAS | v0.2.2 | ✓ |
| `get_my_context` introspection | W0 / Isolation | v0.1.9 | ✓ |
| `verify_completion` hook | W2 / Caps | v0.3.0 | ✓ |
| Multi-tenancy | W4 / Tenancy | v0.5.0 | ✓ |
| Egress controls | W4 / Egress | v0.5.1 | ✓ |
| Audit / SOC2 | W0 / Audit | v0.1.15 | ✓ |
| Secret rotation | W4 / KeyRotation | v0.5.4 | ✓ |
| Webhook + scheduler | W0 / Entry | v0.1.16 | ✓ |
| Spec versioning + migration | W4 / Versioning | v0.5.3 | ✓ |
| Idempotency keys | W1 / I/O | v0.2.0 | ✓ |
| Quota / retention on storage | W1 / Workspace + CAS, W4 / Quotas | v0.2.1 + v0.2.2 + v0.5.2 | ✓ |
| Cross-stage tracecontext | W0 / Gateway | v0.1.11 | ✓ |
| Trace propagation through gateway | W3 / Identity (mTLS) + GATEWAY-CONTRACT §6 | v0.4.3 + gateway team | ✓ |

**Result:** every gap from the v0.1.x audit + every concern raised in the conversation maps to exactly one wave/sub-team. No orphans.

---

## 8. Validation: substrate primitive coverage

Cross-checking every primitive in [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) is delivered by some release:

| Primitive | Delivered in |
|---|---|
| **Agent** | exists in v0.1; extended in v0.2.0 (typed I/O), v0.3.0 (caps), v0.5.3 (immutability) |
| **AgentTask** | exists in v0.1; extended in v0.1.9, v0.2.0, v0.3.0 |
| **AgentWorkflow** | new in v0.3.2 |
| **Workspace** | new in v0.2.1 |
| **Artifact** | exists in v0.1; extended in v0.2.2 (content-addressing) |
| **Capability** | new in v0.3.0 |
| **Event** | new in v0.4.0 |

| Cross-cutting concern | Delivered in |
|---|---|
| **Identity** | foundation in v0.1.8 → v0.3.0 (cap-as-id) → v0.4.3 (SPIFFE) → v0.5.4 (rotation) |
| **Quota** | foundation in v0.2.1 (storage) + v0.2.2 (retention) → v0.5.2 (hierarchical) |
| **Audit** | foundation in v0.1.15 → ongoing emission additions per release |

**Result:** every primitive + every concern has a delivery release. No primitive ships unbacked by a sub-team.

---

## 9. Validation: dependency satisfaction

Critical dependency edges, verified for ordering:

| Dependency | Required before | Status |
|---|---|---|
| Audit stream exists | Cap mints (cap.minted events) | W0 ships before W2 ✓ |
| Caps exist | Tenancy (tenant claim) | W2 ships before W4 ✓ |
| Caps exist | Workflows (workflow has its own cap) | Same wave; serial within wave ✓ |
| Typed I/O exists | Workspace (workspaceClaims schema) | Same wave; W1 serial-then-parallel ✓ |
| Typed I/O exists | CAS (outputs schema) | Same wave; W1 serial-then-parallel ✓ |
| Workspace exists | CAS (PVC mount conventions) | Loose dep; CAS adapts to whatever lands first ✓ |
| Identity (SPIFFE) exists | KeyRotation | W3 ships before W4 ✓ |
| Tenancy exists | Egress / Quotas / KeyRotation | Same wave; W4 serial-then-parallel ✓ |
| Caps exist | Capability-aware Workflow scheduling | Same wave; W2 sequence ✓ |
| Caps exist | Capability-aware Event ACLs | W2 ships before W3 ✓ |

**Result:** no dependency cycles; no dep edge inverted.

---

## 10. Validation: file-conflict surface

Files that are touched by multiple sub-teams within a wave:

| File | Sub-teams | Risk | Mitigation |
|---|---|---|---|
| `packages/operator/src/main.ts` (env block) | W0 Secrets, W0 Isolation, W0 Gateway | medium | sequential merge, Secrets first |
| `packages/operator/src/job-spec.ts` (env + volumes) | W0 Secrets, W0 Isolation, W1 Workspace, W1 CAS | medium | additive blocks, well-commented sections |
| `packages/operator/src/admission.ts` | W0 Audit, W1 I/O, W2 Caps, W4 Versioning | medium | each sub-team owns a distinct rule; rebase discipline |
| `packages/operator/src/reconcile.ts` | W0 Isolation, W2 Caps, W2 Supervision | medium | each owns a distinct controller path |
| `packages/agent-pod/src/runner.ts` | W0 Gateway, W0 Audit, W2 Caps | medium | clear sections (init / loop / teardown) |
| `packages/agent-pod/src/builtin-tools.ts` | W0 Isolation, W1 CAS, W3 Blackboard | low | tools are independent definitions |
| `docs/ROADMAP.md` | every team | high | each updates own row only; wave summary table is single-author per wave |
| Helm charts | W0 Secrets, W0 Audit, W0 Entry, W3 Identity | medium | additive only; each sub-team adds a new values key |

**Result:** all conflicts are mitigable via branch-and-rebase discipline. No fundamental architectural overlap.

---

## 11. Validation: critical path

Sequential dependencies that gate the next wave:

```
W0 Audit (3d) ─┐
               ├→ W2 Caps (3w) ─┬→ W2 Supervision (1.5w) ──┐
                                ├→ W2 Workflows (2.5w)   ──┤
                                ├→ W3 Events (1w)         ──┤
                                ├→ W3 Blackboard (1w)     ──┤
                                ├→ W3 Cache (1w)          ──┼→ W4 Tenancy (1.5w) ──→ W4 rest (parallel, 1w)
                                ├→ W3 Identity (1.5w) ────┤
                                └→ W3 Locality (3d)       ──┘

W1 I/O (2w) ─┬→ W1 Workspace (1.5w) ──┐
              └→ W1 CAS (2w)           ─┴→ (composed with caps for full integration)
```

**Critical path (longest sequential chain):**
W0 Audit → W2 Caps → W3 Identity → W4 Tenancy → W4 KeyRotation
= 3d + 3w + 1.5w + 1.5w + 4d = ~7 weeks of pure sequential dependencies.

**Wall-clock estimate (with full parallelism):** ~16-20 weeks.
**Wall-clock estimate (single-owner serial):** ~22-26 weeks.
**Wall-clock estimate (2-3 owners, mixed parallel):** ~18-22 weeks.

**Result:** plan is feasible at 1-3 owners. Adding owners beyond 3 hits diminishing returns (Wave 3 maxes out at 5 parallel lanes; everything else is dep-gated).

---

## 12. Validation: external boundaries

Components that depend on action by parties outside the kagent repo:

| External party | Required action | Blocks | Mitigation if delayed |
|---|---|---|---|
| Enterprise gateway team | Implement `traceparent` + OTLP child spans per GATEWAY-CONTRACT §6 | W3 Identity full benefits | Trace tree shows opaque gateway leaf; degraded but functional |
| Enterprise gateway team | Implement 429 + Retry-After per §7 | W0 Gateway-status demoted | ModelEndpoint cap as fallback (works today) |
| Enterprise gateway team | Implement idempotency per §9 | End-to-end at-most-once | CAS provides run-level idempotency without gateway help |
| Enterprise gateway team | Implement PII modes per §8 | Per-Agent PII overrides | Default policy applied gateway-side |
| `new_localai` ops | Kata RuntimeClass install on K3s nodes | `sandboxProfile: strict` | Sandbox claim defaults to `default` until ready |
| `new_localai` ops | RWX storage class (Longhorn) | W1 Workspace | Helm chart fails closed with override flag |

**Result:** every external dependency has a graceful fallback. No release in this plan is blocked on an external party.

---

## 13. Self-validation summary

The plan covers:
- ✓ All 22 audit gaps from prior conversation
- ✓ All 7 substrate primitives (Agent, AgentTask, AgentWorkflow, Workspace, Artifact, Capability, Event)
- ✓ All 3 cross-cutting concerns (Identity, Quota, Audit)
- ✓ All 24 release tags (v0.1.7 → v0.5.4) have a sub-team owner
- ✓ All cross-team file conflicts surfaced with mitigation
- ✓ All cross-wave dependency edges respected
- ✓ All external dependencies have fallback paths

The plan does NOT cover (intentional):
- ❌ Streaming response support (out of scope per SUBSTRATE-V1.md §8)
- ❌ Built-in agent SDK alternatives (Strands/Mastra eval) — application choice
- ❌ Untrusted code-exec sandbox per tool call — only if a workload demands
- ❌ Write-enabled Workbench actions — application UX layer
- ❌ Cluster-wide policy engines (OPA/Kyverno are companions)

---

## 14. First moves

Per [`ROADMAP.md`](./ROADMAP.md), Wave 0 is in flight. The atomic next steps:

1. **Spin up sub-team Secrets** → ship `v0.1.8-secret-hygiene` (~1 day). Highest blast-radius reduction; sets the secretRef precedent every later release leans on.
2. **Spin up sub-team Audit** → ship `v0.1.15-audit-stream` (~3 days). Foundation that Caps (Wave 2) requires — schedule it early in Wave 0 so it lands before mid-wave.
3. **Spin up sub-team Isolation** → ship `v0.1.9-isolation` (~2 days). Pure substrate hygiene; unblocks `get_my_context` for any agent that wants it.

Three sub-teams in parallel; each ~1 week of work with overlap. Wave 0 closes in ~3 weeks.

After Wave 0 closes, **draft a `WAVES-PROGRESS.md` snapshot** showing actuals vs estimates. Recalibrate Wave 1 effort estimates based on Wave 0 reality. Repeat per wave.
