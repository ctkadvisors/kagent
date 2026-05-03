# LLM Gateway Bundle — Design

**Date:** 2026-05-03
**Status:** Design (pre-implementation)
**Tag (proposed):** `v0.1.4-llm-gateway` (when shipped)
**Supersedes:** Task #5 on the post-WS-M priority list ("LiteLLM Proxy Helm deploy")

---

## 1. Problem

The kagent substrate has no LLM-side admission control. When 50 AgentTasks land, the operator creates 50 Jobs, K8s schedules 50 pods, and all 50 hit the same LiteLLM/LM Studio/Jetson Ollama endpoint at once. Local backends (Jetson Ollama on a 4B model) serialize internally and degrade hard under contention. Cloud rate limits (Cloudflare AI Gateway, OpenRouter free tier, Bedrock per-key) return 429s with no graceful queueing. The substrate scales agent concurrency past the LLM backend's capacity and faceplants.

Today's stopgaps don't help:
- `Agent.spec.maxConcurrentChildren` (default 10) caps children of *one parent task* — useless across parents or across Agents.
- Job `backoffLimit` + `activeDeadlineSeconds` handle failure/timeout, not concurrency.
- `AgentTemplate.spec.budget.maxParallelInstances` exists in the type at `packages/operator/src/crds/types.ts:329` but is never read anywhere — dead field.
- LiteLLM Proxy was the planned answer (task #5, Phase 4 deferred) but is Python, vendored, and would still need a layer above it to do the queueing work.

The `archived/ai-gateway` project already implements ~80% of what we need — OpenAI-compatible HTTP service, providers for Ollama/LocalAI/Groq/Exo/Bedrock/OpenAI/Anthropic, rate-limiting, usage tracking, K8s deployment manifests. It's MIT-clean, TypeScript (matches the stack), and the AWS surface (CDK/Lambda/DynamoDB) is bypassable via existing `DATA_STORE_TYPE=postgres` switch.

---

## 2. Decision summary

| Question | Decision |
|---|---|
| Replace LiteLLM Proxy or augment? | **Replace.** Gateway is the only chokepoint. LiteLLM Proxy work removed from roadmap. |
| Build from scratch or import existing? | **Import** `archived/ai-gateway`. Strip CDK/Lambda/DynamoDB/CloudFront. Keep providers, router, rate limiter. Run as Node http server in a Pod (matching `template-server.ts` pattern). |
| Where does the queue live? | **Framework, not gateway.** Operator owns admission control via Job-suspend (RBAC already shipped in `v0.1.1`). Gateway returns 429 only as last-resort safety. |
| Cap layers? | **Two.** Backend cap (per-endpoint or per-model, mirrored on gateway + framework) + per-Agent cap (opt-in, default off). Per-Agent fairness/weighted-fair-share deferred until evidence demands it. |
| Cap auto-detection? | **AIMD self-tuning** within configured `seed`/`max` bounds. Backend signals (Ollama `/api/ps`, Cloudflare `x-ratelimit-*` headers) consumed when present. |
| Coupling to kagent? | **Framework-agnostic.** Gateway is a generic OpenAI-compatible HTTP service. Kagent context (task UID, agent name) flows through `X-Kagent-*` headers for usage attribution + tracing — gateway never reads kagent CRDs. |
| Deployment? | **Optional bundle.** Helm sub-chart in `packages/llm-gateway/charts/`. `kagent-operator/values.yaml` gets `llmGateway.enabled: false` default; agent-pods fall back to direct backend URLs (today's behavior) when the bundle isn't deployed. |
| Existing homelab gateway? | **Confirmed dead-letter — safe to remove.** It's a separate codebase from `archived/ai-gateway` (pulled from `git.knuteson.io/homelab/ai-gateway.git`), running 15 days in `ai-services` ns. Currently broken (trying to discover models at `ollama.ai-services.svc` which no longer exists — Chris repurposed Jetson1 to bare-metal inference and never cleaned up the in-cluster ollama Service it pointed to). Consumer audit (`kubectl get deployment -o yaml | grep ai-gateway`) on `openwebui`, `mcpo-control-panel`, `hermes-agent`, `codegen-service`, `doc-ingester` returned **zero references**. Removal is GitOps-only: delete the Argo Application in `new_localai/k8s-kustomized/base/argocd/applications/ai-gateway.yaml` + remove the entry from the kustomization. |

---

## 3. Architecture

```
                  AgentTask (Pending)
                        │
             ┌──────────▼──────────┐
             │     Operator        │
             │ (admission control) │  ◄── reads ModelEndpoint CRDs for caps
             │                     │  ◄── reads gateway /capacity for live counts
             └──────────┬──────────┘
                        │ creates Job (suspend=true initially)
                        │ un-suspends when capacity available
                        ▼
                  ┌──────────┐
                  │ Job/Pod  │ (agent-pod)
                  │          │
                  └─────┬────┘
                        │ POST /v1/chat/completions
                        │ + X-Kagent-Task-UID, X-Kagent-Agent headers
                        ▼
              ┌────────────────────┐
              │   LLM Gateway      │ (Pod, optional bundle)
              │                    │
              │  • API key auth    │
              │  • Per-model cap   │  ◄── hard ceiling, AIMD-tuned
              │  • Provider router │
              │  • Usage tracking  │
              │  • OTEL spans      │
              └────────┬───────────┘
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
   Ollama          Cloudflare        OpenRouter
   (Jetson)        AI Gateway        (free tier)
```

### 3.1 Components

| Component | New / Changed | Location |
|---|---|---|
| `@kagent/llm-gateway` package | NEW (imported + adapted from `archived/ai-gateway`) | `packages/llm-gateway/` |
| Helm sub-chart | NEW | `packages/llm-gateway/charts/llm-gateway/` |
| `ModelEndpoint` CRD | NEW | `packages/operator/charts/kagent-operator/crds/modelendpoint.yaml` |
| Operator admission reconciler | NEW | `packages/operator/src/admission.ts` |
| `Agent.spec.maxInFlightTasks` field | NEW (additive) | CRD + dto + operator types |
| Postgres connection (BYO) | NEW — DSN from Secret reference | `gateway.database.dsnSecretRef: { name, key }` Helm value (required when gateway enabled) |
| Postgres deployment (optional, opinionated default for homelab) | NEW (sub-chart, off by default for cloud-deployers) | `gateway.database.bundled: true \| false` — see §3.7 |
| Existing `litellmBaseUrl` operator value | Renamed to `llmEndpointBaseUrl` | backward-compat alias kept for one minor |

### 3.2 Data flow

1. **AgentTask created** → operator builds Job spec but stamps `spec.suspend=true` initially.
2. **Admission reconciler** runs every K8s event for AgentTasks/Jobs: looks up the target Agent's model, finds the `ModelEndpoint` for it, counts live un-suspended Jobs targeting that model, un-suspends a Pending Job if capacity allows.
3. **Job un-suspends → Pod starts → agent-pod calls** `LLM_GATEWAY_BASE_URL` (operator-injected env) instead of a direct backend URL. Adds `X-Kagent-Task-UID` + `X-Kagent-Agent` headers.
4. **Gateway** validates API key, checks its own per-model in-flight counter (atomic increment), routes to provider, decrements on response, records usage row keyed by `X-Kagent-*` headers + model + tokens + latency + cost.
5. **Gateway returns 429** if framework math is off (last-resort) → agent-pod gets a structured error → bubbles up as `policy_denied: rate_limit` (matches existing tool-error shape).

### 3.3 The `ModelEndpoint` CRD

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: ModelEndpoint
metadata:
  name: nemotron-jetson
  namespace: kagent-system
spec:
  # Model name as it appears in Agent.spec.model (full LiteLLM-style id).
  model: "nemotron-3-nano:4b"
  # Backend kind drives which signal-reader the gateway uses.
  backendKind: ollama   # ollama | cloudflare | openrouter | bedrock | openai | anthropic | localai | groq | exo
  # Backend address — provider-agnostic at the kagent layer (gateway resolves).
  backendUrl: "http://192.168.68.73:11434"
  # AIMD bounds. seed = starting concurrency; max = ceiling.
  inFlight:
    seed: 1
    max: 4
  # Optional: hard floor (never go below) — useful for cloud APIs with known concurrency budgets.
  minSafe: 1
status:
  observedInFlight: 1   # gateway-reported live cap (post-AIMD)
  lastSampledAt: "2026-05-03T18:30:00Z"
  recentErrorRate: 0.02
```

The operator reads `spec` to know what to queue against. The gateway reads the SAME CR (RBAC: `modelendpoints: [get, list, watch]`) and writes back `status` as it converges. No duplicated config.

### 3.4 The `Agent.spec.maxInFlightTasks` field

Optional, default `undefined` = no per-Agent cap. When set, admission reconciler counts live Jobs whose label `kagent.knuteson.io/agent=<name>` matches and refuses to un-suspend additional Jobs above N.

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: Agent
metadata:
  name: researcher
spec:
  model: "nemotron-3-nano:4b"
  maxInFlightTasks: 3        # opt-in; absent = unlimited at this layer
  # ...
```

### 3.5 AIMD inside the gateway

```
on success_response:
   if (consecutive_clean_window_seconds >= 60) and (current_cap < endpoint.max):
     current_cap += 1
on 429_or_latency_spike:
   current_cap = max(endpoint.minSafe, floor(current_cap / 2))
```

Latency spike threshold = 2× rolling p50 over a 5-minute window.

The gateway publishes `current_cap` back to `ModelEndpoint.status.observedInFlight` so the operator's admission reconciler always queues against the *actual* capacity, not the static seed. The bookkeeping is a single Redis-style counter per (model, endpoint) — but since we're keeping infra minimal, in-memory in the gateway Pod is fine for v1 (loss on restart = ~10 min reconvergence, acceptable). Postgres is for usage rows + API keys, not in-flight counters.

### 3.6 Gateway HTTP surface (subset)

| Method | Path | Purpose | Reused from `archived/ai-gateway` |
|---|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compat completions | Yes (`lambda/router/`) |
| POST | `/v1/chat/completions` (SSE) | Streaming | Yes (`lambda/streaming/`) |
| GET | `/v1/models` | Model listing | Yes |
| GET | `/admin/capacity` | Live in-flight per (model, endpoint) | NEW (~50 LoC) |
| GET | `/admin/usage?taskUid=...` | Usage by kagent task | NEW (~50 LoC) |
| GET | `/healthz` | Liveness | Yes |
| GET | `/readyz` | Readiness (Postgres reachable) | NEW (~20 LoC) |

Authorizer + tenant logic from the existing project drops in unchanged. The data layer reads from a Postgres DSN — provided externally (see §3.7); the gateway never instantiates its own DB.

### 3.7 Database — BYO via DSN, optional bundled deploy

The gateway needs a Postgres for two things: (1) API keys + tenant config, (2) usage rows. It does **NOT** care where that Postgres lives. The Helm chart exposes:

```yaml
gateway:
  database:
    # REQUIRED: where to find the DSN. The Secret must contain a libpq-style
    # connection string (postgres://user:pass@host:port/db?sslmode=require).
    dsnSecretRef:
      name: kagent-llm-gateway-db
      key: dsn
    # OPTIONAL: when true, deploy an in-cluster Postgres StatefulSet + PVC
    # AND auto-create the kagent-llm-gateway-db Secret pointing at it.
    # Default: false (cloud-deployers should point at RDS / Cloud SQL /
    # Aurora / Neon / Supabase / whatever managed Postgres they prefer).
    bundled: false
    # When bundled=true, these knobs configure the in-cluster Postgres.
    # When bundled=false, they are ignored.
    bundledConfig:
      storageClass: longhorn   # PVC storage class
      storageSize: 10Gi
      version: '16'            # postgres image tag
      resources:
        requests: { cpu: 100m, memory: 256Mi }
        limits:   { cpu: 500m, memory: 512Mi }
```

**Why this shape:**

- **Cloud-portable.** AWS deployer points `dsnSecretRef` at a Secret holding their RDS DSN. GCP at Cloud SQL. Vercel-style at Neon/Supabase. Homelab at the bundled in-cluster Pod. Same code, same chart, three operational stories.
- **Bundled is opt-in convenience for homelab.** When `bundled: true`, the chart adds a small Postgres StatefulSet + PVC + auto-generated DSN Secret. The bundled Postgres uses the [Bitnami chart pattern](https://github.com/bitnami/charts/tree/main/bitnami/postgresql) as a sub-dependency to avoid hand-rolling StatefulSet + init scripts; we set sensible defaults but expose `bundledConfig` for tuning.
- **Migrations** (`migrations/` from the archived project) run as a Helm post-install/post-upgrade Job that reads the same DSN Secret. Works against bundled OR external Postgres identically.
- **Connection pooling.** Single gateway replica → ≤10 connections; we don't ship PgBouncer in v1. When the gateway scales horizontally (deferred per §6), a PgBouncer sub-chart joins the same `bundled` switch.
- **Schema migration safety.** The migration Job idempotency is on the `archived/ai-gateway` migration runner (it tracks applied versions in a `schema_migrations` table); upgrades are safe against either Postgres flavor.

The kagent operator never touches Postgres — it talks only to the gateway's HTTP surface. Postgres is the gateway's private state.

---

## 4. What we KEEP from `archived/ai-gateway`

- `lambda/providers/` — all 8 provider implementations (ollama, localai, groq, exo, bedrock, openai, anthropic, mock)
- `lambda/router/server.ts` — Express-ish HTTP router (already Node, just needs deAWS-ifying)
- `lambda/authorizer/` — API key validation
- `lambda/shared/rate-limit.ts` — sliding window + token bucket (we'll wire it to in-memory or Redis-light replacement; DynamoDB adapter is dropped)
- `k8s/base/router/`, `k8s/base/admin-api/` — base K8s manifests (will be re-shaped into Helm templates)
- `migrations/` — Postgres schema
- `admin-ui/` — optional; deploy as separate chart, default off

## 5. What we DROP

- `bin/ai-gateway.ts`, `lib/`, `cdk.json`, `cdk.out/` — CDK stacks (NetworkingStack, DataStack, ApiComputeStack, ObservabilityStack, AdminStack)
- `lambda/secrets-rotation/` — replace with K8s Secrets + cert-manager rotation if needed
- DynamoDB / ElastiCache / CloudFront / WAF / Kinesis Firehose / Cognito surface
- LocalStack scripts

---

## 6. Decisions deferred (revisit only when evidence demands)

- **Weighted fair-share scheduling across Agents.** v1 ships per-Agent hard cap (opt-in). When you have evidence one tenant is starving others, design the scheduler then.
- **Bundled Postgres HA / multi-region.** When `gateway.database.bundled: true`, the in-cluster Postgres ships as a single StatefulSet replica + PVC. HA is the deployer's problem when they choose `bundled: false` and point at managed Postgres. We do not ship a clustered bundled option in v1.
- **Gateway horizontal scaling.** Single replica for v1. The in-flight counter is in-memory, so HPA would need either Redis or a leader-election pattern. Defer until throughput proves we need it.
- **Per-API-key tenant isolation in the kagent context.** Kagent gets one API key minted at deploy time. Multi-tenant kagent (different teams sharing a cluster) is a v0.2 design.
- **Bedrock Guardrails / PII filtering.** Already on the `archived/ai-gateway` deferred list. Defer.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| `archived/ai-gateway` code is stale (not maintained since archive) | Treat as one-time import; vendored copy lives under `packages/llm-gateway/`, no upstream tracking after fork. The MIT license permits this. |
| Existing homelab gateway has consumers we don't know about | **Audited 2026-05-03 — zero references.** It's dead-letter from a prior epoch where Jetson1 was in-cluster Ollama; Chris went bare-metal and never cleaned up. Removal is just deleting the Argo Application. |
| In-memory in-flight counter loses state on Pod restart | AIMD reconverges in ~10 min. For v1, acceptable. Document the behavior. |
| Postgres adds an in-cluster dependency that wasn't there before | **Two-axis opt-out.** (1) Whole gateway optional via `llmGateway.enabled=false` — direct-backend path remains default. (2) When the gateway IS enabled, Postgres deployment shape is BYO: `gateway.database.bundled: false` (the cloud default) means deployers point at RDS / Cloud SQL / Aurora / Neon / Supabase via Secret-ref; `bundled: true` is opt-in convenience for homelab. Gateway never assumes which. |
| Gateway becomes single point of failure | Single replica is intentional v1 trade-off; HA path documented in §6. |
| Operator admission reconciler races (un-suspends 2 Jobs targeting last capacity slot) | Use K8s optimistic concurrency on Job patch; second un-suspend gets 409, reconciler re-queues. Same pattern WS-I uses. |

---

## 8. Test plan

- **Unit:** `packages/llm-gateway/src/router.test.ts` — provider routing, AIMD math, in-flight counter atomicity.
- **Unit:** `packages/operator/src/admission.test.ts` — capacity calculation, Job suspend/un-suspend transitions, racing un-suspends.
- **Integration:** `helm template` smoke for the new sub-chart.
- **End-to-end:** `helm install` the bundle, point at a fake provider, fire 100 concurrent AgentTasks targeting a model with `inFlight.max=2`, assert no more than 2 un-suspended Jobs at any time and all 100 eventually complete.

## 9. Acceptance

- [ ] `pnpm install && pnpm test` green for the new package.
- [ ] `helm template kagent-operator --set llmGateway.enabled=true --set llmGateway.database.bundled=true` renders cleanly with sub-chart CRDs + bundled Postgres StatefulSet + gateway Deployment + auto-generated DSN Secret.
- [ ] `helm template kagent-operator --set llmGateway.enabled=true --set llmGateway.database.bundled=false --set llmGateway.database.dsnSecretRef.name=external-pg --set llmGateway.database.dsnSecretRef.key=dsn` renders cleanly WITHOUT bundled Postgres — gateway Deployment references the external Secret. Proves the BYO path.
- [ ] Operator with `llmGateway.enabled=false` (default) preserves today's direct-backend behavior — no regression for the `homelab-orchestrator` migration plan.
- [ ] Demo on the live cluster (homelab, bundled Postgres): 4 concurrent AgentTasks against `nemotron-jetson` (cap=2) → 2 Jobs un-suspended, 2 stay suspended, jobs roll through as capacity frees, all complete.
- [ ] Workbench TaskDetail shows `Pending — queued for capacity` state when an AgentTask is admission-blocked (≤ a one-line UI tweak).

## 10. Open questions

- **Q1.** Naming. The package is `@kagent/llm-gateway`; the deployable Service is `kagent-llm-gateway`. The existing homelab Service is `ai-gateway-router` in `ai-services` ns. **Plan:** deploy the new one in `kagent-system` (clean namespacing, no collision); after the new gateway is green and the kagent demo agents are pointed at it, delete the dead-letter `ai-services/ai-gateway*` resources via GitOps cleanup (one PR removing the Argo Application + kustomization entry). The two never coexist as live consumers — dead-letter just has stale pods burning ~150MB RAM until the cleanup PR lands.

## 11. Decisions made (resolved during brainstorming)

- **Admin UI:** skip for v1, add as `llmGatewayAdmin.enabled=true` in v0.2.
- **API key Secret:** lives in `kagent-system` ns, mounted by every spawned Job — same pattern as today's `KAGENT_LITELLM_API_KEY`.
- **Postgres deployment:** BYO via `gateway.database.dsnSecretRef`; bundled in-cluster Postgres is opt-in via `gateway.database.bundled: true` (default `false`). Cloud deployers point at RDS / Cloud SQL / Aurora / Neon / Supabase. See §3.7.
