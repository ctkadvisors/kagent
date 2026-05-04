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

### 2.2 Sub-team: Isolation

**Releases:** `v0.1.9-isolation`
**Owns:** `packages/operator/src/job-spec.ts`, `packages/operator/src/reconcile.ts`, `packages/agent-pod/src/builtin-tools.ts`, `packages/agent-pod/src/env.ts`
**Reads:** `packages/agent-pod/src/builtin-tools-spawn.ts`

**Deliverables:**
1. Operator stamps `KAGENT_TASK_DEPTH` env (parent depth + 1; root = 0)
2. Cluster-level cap (`KAGENT_AGENT_POD_MAX_DEPTH`, default 4) enforced inside `defineSpawnChildTask` AND at admission
3. Parent → child AgentTask `ownerReferences` set so cascading delete works
4. `Job.spec.ttlSecondsAfterFinished: 300` default (was 3600); Helm-overridable
5. Assert `Job.spec.backoffLimit: 0` (no double-spawn on retry)
6. New built-in tool: `get_my_context()` returning `{taskUid, agentName, parentUid?, depth, capabilityId?, budget: {tokensRemaining, secondsRemaining}}`

**Validation:** smoke test where root spawns 4 deep → 5th depth refused with `policy_denied:depth_exceeded`; `kubectl delete agenttask <root>` cascades to grandchildren within 30s.

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

### 3.1 Sub-team: I/O (foundational, blocks Workspace + CAS)

**Releases:** `v0.2.0-typed-io`
**Owns:** `packages/operator/src/crds/types.ts`, `packages/operator/src/crds/agent.ts`, `packages/operator/src/crds/agent-task.ts`, `packages/operator/src/admission.ts`, `packages/agent-pod/src/env.ts`
**Reads:** all consumers of `AgentSpec`

**Deliverables:**
1. `Agent.spec.inputs[]` + `Agent.spec.outputs[]` schema (kind: `workspace | artifact | scalar`; mediaType, mountPath, optional, required)
2. `AgentTask.spec.inputs[].from: { workspace | taskUid+output | scalar }`
3. `AgentTask.spec.idempotencyKey: string` (admission dedupe)
4. Operator admission: validate `AgentTask.spec.inputs` satisfies `Agent.spec.inputs`; refuse if missing required
5. Operator status controller: refuse `Completed` patch with missing required outputs; force `Failed` with structured cause
6. Migrate `KAGENT_AGENT_SPEC` + `KAGENT_TASK_SPEC` from env JSON to mounted ConfigMap at `/var/kagent/config/`
7. Deprecate `parentDistillation` (still accepted; new path is typed input)
8. CRD migration tooling for in-place upgrade

**Validation:** existing v0.1 Agent CRs work without changes (deprecation warnings only); a new Agent declaring required `inputs[].from.workspace` blocks AgentTask creation if no Workspace exists; idempotent task submission deduplicates within a 24h window.

### 3.2 Sub-team: Workspace

**Releases:** `v0.2.1-workspaces`
**Owns:** new `packages/workspace-controller`, `Workspace` CRD, init-container helper
**Depends on:** I/O sub-team's `Agent.spec.workspaceClaims[]` schema field

**Deliverables:**
1. `Workspace` CRD with `source.git`, `pvc`, `ttl`, `quota`
2. Workspace controller: provisions PVC, runs init-container clone, marks `status.ready: true`
3. Operator's job-spec reader: when AgentTask binds a Workspace input, mount the PVC at the declared path
4. RWX storage class detection: Helm chart fails closed if no RWX class found (with override flag)
5. Quota enforcement: `Event` emitted on >80%; admission refuses new bindings on >95%
6. GC: Workspace deleted when last referencing task tree completes + ttl

**Validation:** smoke test where 3 sibling agents share a Git-cloned Workspace (single clone, 3 mounts); deleting the root task GCs the Workspace within ttl.

### 3.3 Sub-team: CAS

**Releases:** `v0.2.2-cas`
**Owns:** `packages/agent-pod/src/artifacts.ts`, `packages/agent-pod/src/builtin-tools.ts` (read_artifact addition), new `packages/cas-backend`
**Depends on:** I/O sub-team's `Agent.spec.outputs[]` schema; Workspace sub-team's PVC mount conventions (CAS PVC backend reuses Workspace plumbing)

**Deliverables:**
1. ArtifactRef gains `contentHash: string` (sha256 hex); `uri` shape becomes `cas://sha256:<hex>/<name>`
2. `write_artifact` computes hash on write; stores under hash-prefix path on PVC
3. New built-in tool: `read_artifact(uri: string) → ContentBlock[]`; capability-gated
4. Backend abstraction: PVC backend (v0.2 default) + S3/MinIO backend (v0.3+)
5. Retention policy on Agent.spec.outputs[].retention (default 7d, override per output)
6. Operator GC by reachability: artifacts referenced by no live AgentTask + past retention → deleted

**Validation:** identical task input → identical content hash → trace replay on second run (no LLM call); smoke test confirms cache hit ≥ 90% on a deterministic repeat.

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

**Releases:** `v0.3.0-capabilities`
**Owns:** new `packages/capability-issuer`, JWT signing/validation, operator capability admission, agent-pod cap consumer
**Depends on:** Audit (Wave 0) — every cap mint emits an audit event

**Deliverables:**
1. JWT capability bundle schema per [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §3.6
2. Operator CA: cert-manager Issuer for capability JWT signing
3. Capability-issuer controller: mints cap on AgentTask admission; signs; stores `capabilityRef: <jti>` on AgentTask
4. Agent-pod consumer: reads cap via mounted file or env; surfaces relevant claims via `get_my_context`
5. Spawn narrowing: `defineSpawnChildTask` and admission both validate child cap ⊆ parent cap
6. Replace `allowedChildAgents` / `allowedChildTemplates` / `KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS` with cap claims (legacy fields stay readable for one release with deprecation warning)
7. `verify_completion` substrate hook: AgentTask admission can carry `verifyContract: { llmJudgePromptRef? | scriptRef? }` that runs at status patch time and refuses Completed if it fails

**Validation:** an Agent that tries to spawn outside its `cap.claims.spawn` allowlist gets `policy_denied:capability_violation`; cap rotation test confirms expired caps fail closed; audit stream shows `capability.minted` + `capability.used` events.

### 4.2 Sub-team: Supervision

**Releases:** `v0.3.1-supervision`
**Owns:** `packages/operator/src/reconcile.ts` (child-failure routing), new `packages/supervision`
**Depends on:** Caps (supervision strategies are cap-claim-gated for adversarial scenarios)

**Deliverables:**
1. `Agent.spec.supervisionStrategy: one_for_one | one_for_all | rest_for_one | escalate`
2. Operator child-failure handler: routes per strategy
3. Structured contract violations (missing required output, undeclared tool call) trigger supervision response
4. `Agent.spec.maxRestarts` cap; restart counter on AgentTask.status

**Validation:** smoke test where a child fails with each strategy produces the expected sibling outcome; max-restart cap fails-closed instead of looping.

### 4.3 Sub-team: Workflows

**Releases:** `v0.3.2-workflows`
**Owns:** new `packages/agent-workflow-runtime`, `AgentWorkflow` CRD, Restate adapter
**Depends on:** Caps (Workflows carry their own cap)

**Deliverables:**
1. `AgentWorkflow` CRD (image, triggers, capabilityRef)
2. Restate cluster Helm sub-chart
3. Workflow runtime: TS host SDK that calls into Restate, deterministic operations (spawn AgentTask, wait, signal)
4. Triggers: schedule (from Wave 0 Entry), webhook (from Wave 0 Entry), event (from Wave 3 Events)
5. Crash-recovery test: kill workflow pod mid-fan-out, confirm replay reaches same decision point + does NOT re-issue completed effects

**Validation:** researcher orchestrator workflow runs daily, survives a chaos kill, completes with expected outputs.

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

### 5.1 Sub-team: Events

**Releases:** `v0.4.0-events`
**Owns:** new `packages/events`, NATS JetStream stream provisioning, `Agent.spec.publishes/subscribes` schema

**Deliverables:**
1. Typed event schema (CloudEvents shape, JSON-Schema'd payloads)
2. `Agent.spec.publishes/subscribes[]` resolved at admission to NATS subject ACLs
3. Capability-gated topic ACLs (cap claim `publish: [topic]` / `subscribe: [topic]`)
4. Built-in tools: `publish_event(topic, data)`, no `subscribe_event` (subscriptions are reactive — see Triggers integration)
5. Trigger integration: an event subscription can mint an AgentTask via the Wave 0 Entry plumbing

**Validation:** agent A publishes; agent B subscribes; B's AgentTask is minted on each event; cap denies cross-tenant subscribe.

### 5.2 Sub-team: Blackboard

**Releases:** `v0.4.1-blackboard`
**Owns:** new `packages/blackboard`, NATS JetStream KV bucket per task tree, built-in tools

**Deliverables:**
1. NATS JetStream KV bucket per root AgentTask UID (provisioned at root-task admission)
2. Built-in tools: `read_blackboard(key)`, `write_blackboard(key, value)`, `list_blackboard()`
3. CRDT-style append for concurrent writes (last-writer-wins for scalars; `append_blackboard(key, value)` for lists)
4. GC: bucket deleted when root task completes + ttl

**Validation:** 3 sibling agents concurrently write to a shared key; final state is convergent; bucket GC'd on root completion.

### 5.3 Sub-team: Cache

**Releases:** `v0.4.2-cache`
**Owns:** new `packages/cache-controller`, `Agent.spec.caches[]` schema integration

**Deliverables:**
1. `Agent.spec.caches[]: [{name, key: <template>, mountPath}]`
2. Key derivation: `hash(input_artifact_hashes + image_digest + model_name + key_template)`
3. Operator-side: init-container restore-on-boot from CAS; sidecar save-on-success
4. Cache miss = fresh fall-back, no error
5. Cache hit recorded in trace metadata

**Validation:** a `npm install` cache survives across runs; cold start vs warm start latency delta measurable.

### 5.4 Sub-team: Identity

**Releases:** `v0.4.3-identity`
**Owns:** SPIFFE/SPIRE Helm sub-chart, agent-pod SVID consumer, gateway mTLS termination
**Depends on:** Caps (cap signing CA is operationally adjacent to SPIRE CA)

**Deliverables:**
1. SPIRE deployed via sub-chart; per-pod SVID issuance via workload API
2. Agent-pod's LLM client uses SVID for mTLS to gateway (when gateway supports it per [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) §4.3)
3. Per-Agent SVID replaces shared `KAGENT_LITELLM_API_KEY` env var
4. Operator mints capability bundles signed by the same CA cert-manager exposes for SPIRE

**Validation:** `KAGENT_LITELLM_API_KEY` removed from cluster entirely; gateway authenticates by SVID; rotation event in audit stream.

### 5.5 Sub-team: Locality

**Releases:** `v0.4.4-locality`
**Owns:** scheduling-related fields in `packages/operator/src/job-spec.ts`, new `packages/locality-controller`

**Deliverables:**
1. NodeAffinity from Workspace placement (when a PVC is bound to a node, agents that mount it get the node-affinity)
2. Speculative execution: agent running >3× median latency triggers a duplicate spawn; first to finish wins; idempotency key prevents double-effect
3. Pod-pressure circuit breaker: if pending agent-pods exceed threshold, admission queues new tasks instead of admitting

**Validation:** workspace-co-located agents reach <100ms file-read p99; chaos test where a slow agent gets superseded by speculative twin completes within median bound.

### 5.6 Wave 3 cross-team coordination

**Shared:** all five teams are loosely coupled. Coordinate on:
- NATS subject namespacing (Events vs Blackboard) — agree on prefixes (`kagent.events.*` vs `kagent.kv.*`)
- Helm sub-charts (SPIRE vs new infrastructure) — single `infra/` namespace
- Trace attribute keys — coordinate via [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) update PR

---

## 6. Wave 4 sub-teams (~3 weeks)

### 6.1 Sub-team: Tenancy (foundational, blocks all other Wave 4 lanes)

**Releases:** `v0.5.0-tenancy`
**Owns:** `Tenant` CRD, namespace-scoped controllers, capability tenant claim integration
**Depends on:** Caps (tenant is a cap-claim scope)

**Deliverables:**
1. `Tenant` CRD: name, namespace allowlist, capability root, audit subject, default quota
2. Per-tenant Agent visibility (Agents in tenant `acme` invisible to tenant `globex`)
3. Tenant-scoped capability claim: every cap minted under a tenant carries `claims.tenant`
4. `X-Kagent-Tenant` header threading to gateway per [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) §3
5. Tenant migration tooling

**Validation:** two tenants in same cluster cannot see each other's Agents/Tasks; gateway sees the tenant header and routes accordingly.

### 6.2 Sub-team: Egress

**Releases:** `v0.5.1-egress`
**Owns:** `Agent.spec.egress` schema (already defined in SUBSTRATE-V1.md), NetworkPolicy generation, optional Cilium CNP
**Depends on:** Tenancy (tenant default egress)

**Deliverables:**
1. Operator generates `NetworkPolicy` (or `CiliumNetworkPolicy` when Cilium detected) per Agent based on `Agent.spec.egress`
2. Default-deny: Agents with no `egress` declaration get egress-denied policies
3. Cluster operator can override via tenant defaults

**Validation:** `curl` to undeclared domain from agent-pod times out; declared domain succeeds.

### 6.3 Sub-team: Quotas

**Releases:** `v0.5.2-quotas`
**Owns:** quota controllers (org → tenant → agent), pod-pressure circuit breaker (companion to Locality)
**Depends on:** Tenancy

**Deliverables:**
1. K8s `ResourceQuota` per tenant namespace
2. Per-tenant gateway in-flight cap (composes with ModelEndpoint cap)
3. Per-tenant artifact storage cap (CAS quota integration)
4. Quota-breach audit events
5. Pod-pressure circuit breaker (admission queue when pending > threshold)

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
