# Roadmap

**Date:** 2026-05-01
**Status:** Phase 4 smoke green; Phase 4.x hardening complete; Phase 5 Workbench read-side materialized; WS-I parent-child reconcile shipped (`v0.0.6-ws-i`). **Next: Phase 5.x agent-self-service slate** — bridges substrate to user via write API, in-pod delegation tools, and AgentTemplate. After that: researcher port + comparison rig.
**Convention:** one phase = one git commit cluster + one tag (`vX.Y.Z-phaseN`).

> Read [`DESIGN-V0.1.md`](./DESIGN-V0.1.md) for the v0.1 architecture detail. This document is the multi-version phasing plan.

---

## Phase 0 — Scope + docs ✓ (this commit cluster)

- [x] Repo scaffold: `README.md`, `LICENSE`, `CLAUDE.md`, `.gitignore`
- [x] `docs/WHY.md` — gap analysis, kernel pivot, strategic posture
- [x] `docs/DESIGN-V0.1.md` — v0.1 architecture spec
- [x] `docs/PRIOR-ART.md` — landscape and selection rationale
- [x] `docs/HARNESS-LESSONS.md` — failure modes from prior experiments → substrate implications
- [x] `docs/ROADMAP.md` — this document

**Tag:** `v0.0.0-phase0`
**Done when:** repo can be opened cold by a fresh session and the *why* + *what* are fully legible without external context.

---

## Phase 1 — TS scaffold + agent-loop fork (~1 week)

- [x] `package.json` + `pnpm-lock.yaml` + `tsconfig.base.json` (strict ESM Node 22 target). Bun is the runtime target for the operator and agent pod images; pnpm 9.15.9 + Node 22 is the workspace package manager + build target.
- [x] `pnpm-workspace.yaml` for monorepo: 8 packages — `agent-loop`, `openai-compat`, `in-process-tool-provider`, `mcp-tool-provider`, `http-tool-provider`, `trace-sinks`, `operator`, `agent-pod`. Companion packages 2-6 lifted from agent-runtime sibling; operator + agent-pod are stubs for Phase 2/3.
- [x] Lift AgentExecutor + RunBudget + LLMClient/ToolProvider/TraceSink abstractions + AgentRegistry + JsonlFileSink/StdoutSink + 5 companion packages from `agent-runtime` into the new workspace. Sempf/kernel/paperclip framing stripped on copy; cross-package imports rewired to `@kagent/agent-loop`.
- [x] Lift F1/F2/F3 + refusal detection + synthesis-vacuity heuristic from `homelab-orchestrator/src/chat/{server,delegate-tool}.ts` into `packages/agent-loop/src/detectors/` as run-end middleware (`computeQualityFlags`, `detectRefusal`).
- [x] SPDX MIT license header on every `.ts` source file (`/** SPDX-License-Identifier: MIT … */` JSDoc form, enforced by `eslint-plugin-license-header`).
- [x] CI: GitHub Actions workflow runs install (frozen lockfile) → typecheck → lint → test → format check on PRs + push-to-main.
- [ ] Coverage thresholds: ≥85% on agent-loop core, ≥75% on glue. Deferred from Phase 1 — vitest configs ship with thresholds at 0; calibrate and gate once Phase 2 operator numbers settle. (432 tests passing across 30 test files; lifted code inherits sibling's high coverage.)

**Tag:** `v0.0.1-phase1`

---

## Phase 2 — Operator + CRDs (~1 week)

- [x] CRD definitions: `Agent`, `AgentTask`, `AgentCapability` in `packages/operator/src/crds/` (TS) + `packages/operator/manifests/crds/` (YAML). API group `kagent.knuteson.io/v1alpha1` (knuteson.io subdomain to avoid collision with Solo.io's kagent.dev — see CLAUDE.md naming note; rename pre-public-release).
- [x] Operator skeleton: Bun + `@kubernetes/client-node` 1.4.0, `makeInformer` cluster-wide watch on `AgentTask`. Graceful SIGTERM/SIGINT shutdown. Entry point: `packages/operator/src/main.ts`.
- [x] Reconcile logic: AgentTask → resolve target Agent → build Job spec (with ownerRef back to AgentTask) → create Job (409 idempotent) → `Dispatcher.publish` → patch `AgentTask.status.phase=Dispatched`. v0.1 stops at dispatch — Phase 3 wires the completion path (agent pod writes status directly via K8s API; NATS reply pattern is a v0.2 optimization). `targetCapability` resolution defers to Phase 3.
- [ ] Smoke test against `kind` cluster — **deferred to Phase 5** (E2E + comparison rig). Phase 2 ships unit tests against mocked K8s clients (32 tests on reconcile + job-spec); spinning up kind + NATS to validate end-to-end belongs with the cross-substrate comparison rig where the real workload runs.
- [x] Helm chart `packages/operator/charts/kagent-operator/`: Deployment + ServiceAccount + ClusterRole + ClusterRoleBinding + the three CRDs in chart's `crds/`. RBAC scoped to the kagent.knuteson.io group + batch/v1 jobs + pods (read) + events (write).

**Tag:** `v0.0.2-phase2`

---

## Phase 3 — NATS A2A bus + agent pod runtime (~1 week)

- [x] NATS JetStream Helm reference values (`packages/operator/charts/values-references/nats-jetstream.yaml`) covering single-node JetStream + the `agents-live` KV bucket convention. Operator wires a real `NatsDispatcher` when `KAGENT_NATS_URL` is set; otherwise falls back to `StubDispatcher`. KV-backed `NatsCapabilityRegistry` reads `agents-live`.
- [x] Agent Pod base image: multi-stage Dockerfile under `packages/agent-pod/Dockerfile` (Node 22 + pnpm install stage → `oven/bun:1.1-alpine` runtime stage). Pod reads task assignment via env vars (operator's job-spec injects KAGENT_AGENT_SPEC + KAGENT_TASK_SPEC as JSON; simpler boot than waiting on NATS). Image not yet published; operator Helm values still point at the v0.0.2 placeholder until CI builds + pushes.
- [ ] In-pod NATS subscription — **deferred**. v0.1 design pivoted to "operator passes task via env, agent pod patches AgentTask.status via K8s API" since it sidesteps a chain of NATS bootstrap concerns. NATS publish-side is wired (`NatsDispatcher`); subscription is a v0.2 affordance for warm-pool / streaming-cancel signals.
- [x] A2A envelope contract: `DispatchedTask` carries `taskId, agentId, parentTaskId?, originalUserMessage, parentDistillation?, expectedTools?, payload`. Locked in by `packages/operator/src/envelope.test.ts` (10 contract tests reading the StubDispatcher wire-tap).
- [x] OTel exporter wired into `@kagent/agent-loop` via `OtelTraceSink` in `@kagent/trace-sinks` (OTLP/HTTP, Langfuse-compatible). Agent-pod main.ts boots the exporter when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set; silently skips otherwise.

**Tag:** `v0.0.3-phase3`

---

## Phase 4 — Deploy + prove (~0.5 week)

**Scope deviation from original ROADMAP**: Phase 4 was "LiteLLM + Langfuse Helm deploys + smoke." The actual shape pivoted to "shortest path to a deployed + proven kagent": skip the LiteLLM/Langfuse Helm deploys (their values are documented in [`packages/operator/charts/values-references/`](../packages/operator/charts/values-references/)), point the smoke test directly at LM Studio for inference, and prove the GitOps loop end-to-end. LiteLLM + Langfuse install when the homelab actually needs them; the substrate doesn't gate on either.

- [x] CI image build pipeline ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)): verifies on PR/main, then builds + pushes `ghcr.io/ctkadvisors/kagent-operator` and `ghcr.io/ctkadvisors/kagent-agent-pod` on tag-push (`v*`) and manual dispatch.
- [x] Operator Dockerfile mirroring agent-pod's multi-stage shape (Node 22 + pnpm install → Node 22 + tsx runtime; Bun runtime reverted because `@kubernetes/client-node` Watch + status-PATCH paths fail with `SELF_SIGNED_CERT_IN_CHAIN` against K3s under Bun, see Phase 4.x follow-ups below).
- [x] ArgoCD Application + repo secret placeholder in sibling `new_localai/k8s/argocd-apps/kagent-app.yaml`. Targets the kagent repo's Helm chart, sync wave 6.
- [x] Helm chart wires the agent-pod's runtime config (LiteLLM base URL + API key, OTel endpoint + headers) through operator env into the spawned pods. agent-pod ServiceAccount + Role for AgentTask.status patching created by the chart.
- [x] Smoke-test bundle in the Helm chart (`smokeTest.enabled`): Agent CRD + AgentTask CRD + verification Job. Verification Job polls AgentTask phase, prints status YAML, exits 0 on Completed / 1 on Failed-or-timeout. Replace+Force annotation so re-syncs re-run the test.
- [ ] LiteLLM Proxy Helm deploy — **deferred to v0.2**; the substrate works against any OpenAI-compat backend (LM Studio, OpenRouter, Ollama, Bedrock-via-LiteLLM). Values reference at [`packages/operator/charts/values-references/litellm.yaml`](../packages/operator/charts/values-references/litellm.yaml).
- [ ] Langfuse self-hosted Helm deploy — **deferred to v0.2**; OtelTraceSink no-ops when no endpoint is set, so the substrate runs without Langfuse. Values reference at [`packages/operator/charts/values-references/langfuse.yaml`](../packages/operator/charts/values-references/langfuse.yaml).

**Tag:** `v0.0.4-phase4`. CI builds the images on tag push.

**Smoke test verified 2026-04-27**: AgentTask CR → operator informer → Job → agent-pod runs against LM Studio (`google/gemma-4-26b-a4b` at `192.168.68.60:1234/v1`) → status patched with `result.content` + `structuralVerdict.suspicious: []` in ~11s end-to-end.

---

## Phase 4.x — Follow-ups surfaced by the smoke-test bring-up

These are scoped tightly to issues the live deploy exposed; do them before Phase 5's E2E work expands the surface area.

- [x] **Watch K8s Job/Pod terminal state and reflect into AgentTask.status.** The operator now watches owned Jobs/Pods, detects image-pull failures, unschedulable pods, failed Jobs, and terminal container failures, then patches the parent AgentTask Failed without clobbering Completed.
- [x] **Enforce AgentTask deadlines at the Kubernetes layer.** `AgentTask.spec.timeoutSeconds` now maps to agent-pod `AbortSignal.timeout(...)` and Job `activeDeadlineSeconds`, so hung model calls and pre-loop pod stalls both reach terminal status.
- [x] **Make smoke-test reruns reliable under Argo sync.** The smoke AgentTask and verifier Job are revision-suffixed Sync hooks with Replace/Force semantics, so repeated syncs create fresh task resources instead of reusing a terminal prior run.
- [ ] **Restore Bun runtime when `@kubernetes/client-node`'s TLS path fixes parity.** The Watch path under `bun:1.1-alpine` rejects K3s's self-signed CA with `SELF_SIGNED_CERT_IN_CHAIN` even though the same kubeconfig works for one-shot API calls; same bug on the agent-pod's `patchNamespacedCustomObjectStatus`. Both runtimes pivoted to `node:22-alpine` + tsx as a workaround; CLAUDE.md updated to reflect that. Track Bun's undici/TLS work and revert when fixed.
- [x] ~~**Trigger Gitea Actions on mirrored tags.**~~ **Resolved by going public.** Once github.com/ctkadvisors/kagent went public, ghcr.io packages from this repo became public-and-unauthenticated, so the homelab cluster pulls images straight from `ghcr.io/ctkadvisors/kagent-*` with no pull secret. The Gitea Actions workflow + the homelab `git.knuteson.io/homelab/kagent-*` registry mirror were deleted; chart defaults point at ghcr.io. (The git-source mirror at `git.knuteson.io/homelab/kagent.git` stays — that's read-only and ArgoCD's `repoURL` still consumes it.)
- [ ] **Wire Agent.spec.tools through to the executor.** The agent-pod runs chat-only today — the AgentRegistry registration in `runner.ts` skips the `tools` field. Most consumer workloads (researcher, summarizer) need at least HTTP fetch / MCP tool wiring before Phase 5 can land.
- [ ] **Move Agent + Task spec injection off env JSON.** `KAGENT_AGENT_SPEC` and `KAGENT_TASK_SPEC` as env-var JSON strings is fine for smoke tests but caps payloads at ARG_MAX and exposes secrets to `ps`/`/proc`. Switch to a downward-API volume or a per-task ConfigMap mounted at a known path before the first real consumer.
- [x] **Reshape OTel spans to Langfuse + GenAI semconv.** Sibling red item to WS-D (deterministic trace IDs) — that landed navigation; this lands evidence. `OtelTraceSink` now emits `langfuse.observation.{type,model.name,usage_details,cost_details}` + `gen_ai.{operation.name,request.model,response.model,usage.input_tokens,usage.output_tokens,tool.name,tool.call.{arguments,result}}` so Langfuse renders Generations + Tool calls with full context instead of opaque generic spans. Tool spans renamed to `execute_tool <name>` per OTel GenAI semconv. Root span carries `langfuse.trace.{name,tags,metadata.*}` from a new `runContext` plumbed through PodConfig → agent-pod main → sink. `KAGENT_TRACE_CONTENT_MODE=none|preview|full` (default `preview`) controls whether input/output bodies ride the spans (`artifact-ref` reserved for Phase 5 P3 writer). New formatter module (`packages/trace-sinks/src/langfuse-otel-format.ts`) is the single source of truth for the attribute shape; new `'run_complete'` `TraceEntry` carries final-state totals + output to seal the root span. Helm `agentPod.traceContentMode` + `x-langfuse-ingestion-version=4` header reference documented.

---

## Phase 5 — End-to-end + first consumer (~1 week)

Phase 5 has two tracks: prove the first real workflow and make the engine visible enough to operate. The priority spine lives in [`PLATFORM-PRIORITIES.md`](./PLATFORM-PRIORITIES.md); the visibility surface is [`WORKBENCH.md`](./WORKBENCH.md).

**Substrate primitives (overnight 2026-04-27 fan-out):**

- [x] `@kagent/dto` package — read-model DTOs (`TaskSummary`, `TaskDetail`, `AgentSummary`, `PodFailureSummary`, `TraceLink`, `ArtifactSummary`) + pure mappers. Underpins every visibility client (Workbench, CLI, webhooks).
- [x] `Agent.spec.tools` wired into the agent-pod executor (P2). Built-in `http_get` / `rss_fetch` / `extract_text` with SSRF guard + domain allowlist via `KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS`. Unknown tool names fail FAST at boot.
- [x] `ArtifactRef` type + `AgentTask.status.artifacts` schema (P3). Status-reference-only — writer slice is the next P3 step.
- [x] Task-graph helpers (`buildChildTaskManifest`, `aggregateChildren`, `cycleCheck`, parent/child labels) + status-projection schema (P4). Operator wire-up (re-reconcile parent on child status change) is the next P4 step.
- [x] Workbench API + UI blueprint (`docs/WORKBENCH.md` §5; full file-by-file scaffold ready in the WS2 design output for next-session materialization).
- [x] Workbench deployment plan in `new_localai` — `feat/kagent-workbench-deploy` branch with RBAC + auth integration recipe; manifest staged with DO-NOT-APPLY banner pending the first workbench image tag.

**Phase 5 implementation slate (in PLATFORM-PRIORITIES.md priority order):**

- [x] Materialize the Workbench API + UI from the WS2 blueprint (`packages/workbench-api`, `packages/workbench-ui`); views are `TaskList` over `/api/tasks` and `TaskDetail` over `/api/tasks/:ns/:name`, hash-routed (`#/`, `#/tasks/<ns>/<name>`), refreshed by `/api/stream` SSE.
- [x] Ship the Workbench Helm chart at `packages/operator/charts/kagent-workbench/` referenced by `new_localai/k8s/argocd-apps/kagent-workbench-app.yaml`.
- [x] Build + push `kagent-workbench-{api,ui}` images via `.github/workflows/ci.yml` to `ghcr.io/ctkadvisors/kagent-workbench-{api,ui}`. (Originally planned to also mirror through Gitea Actions; the Gitea pipeline was retired when the repo went public — see Phase 4.x bullet above.)
- [x] Helm chart smoke job in CI (`helm-smoke` matrix in `.github/workflows/ci.yml`) — lints + templates the operator and workbench charts on every PR; gates image-build on green smoke. Mitigates the "templating regression silently breaks the deploy" risk surfaced after v0.0.4.
- [x] Trace-link derivation fix in `@kagent/dto` — `traceLink()` now mirrors `OtelTraceSink.traceIdFromRunId` (`sha256(uid).slice(0, 32)`) so Langfuse deep-links resolve. Was previously emitting `<base>/trace/<uid>`, which 404'd in Langfuse because spans are stored under the derived OTel trace ID. Workbench `TaskDetail` surfaces the link when `LANGFUSE_BASE_URL` is set on the API container.
- [ ] Wire the operator's reconcile to USE the task-graph helpers (P4 wire-up): on child status change, look up parent and patch parent.status.children + aggregatePhase.
- [ ] Implement the artifact writer (P3 wire-up): mount the `kagent-artifacts` PVC into agent-pods, expose a `write_artifact` built-in tool, populate `status.artifacts`.
- [ ] Port researcher agent from `homelab-orchestrator` → produces same daily digest on new substrate.
- [ ] A2A demo: researcher delegates to summarizer specialist via task-graph (parent + child AgentTasks), both as separate Pods, both traced, parent waits via re-reconcile.
- [ ] Comparison rig: run existing 5-topic workload through both substrates for one week; compare cost + completion + median latency.
- [ ] Publish comparison numbers in `docs/V0.1-COMPARISON.md`.

---

## Phase 5.x — Agent self-service (~5-6 days, in flight)

The substrate ships but every channel for invoking work is YAML-into-GitOps. [`PLATFORM-PRIORITIES.md`](./PLATFORM-PRIORITIES.md) §4 commits to "the same unit of work can be created by YAML, CLI, GUI, webhook, scheduler, or agent." This slate fills the missing channels in dependency order. **Full plan:** [`AGENT-SELF-SERVICE.md`](./AGENT-SELF-SERVICE.md) — file-level contracts, RBAC deltas, gray-area decisions (D1-D9), and the cross-workstream acceptance test.

| WS  | Goal                                                                | Tag                          | Status   | Depends on |
|-----|---------------------------------------------------------------------|------------------------------|----------|------------|
| J   | `POST /api/tasks` + workbench "New Task" button + `kagent` CLI       | `v0.0.7-write-surface`       | ✅ shipped | none       |
| K   | `spawn_child_task` built-in tool + `Agent.spec.allowedChildAgents`  | `v0.0.8-spawn-child`         | ✅ shipped | none       |
| L   | `wait_for_child_task` / `wait_for_children_all` (polling)           | `v0.0.9-wait-for-child`      | ✅ shipped | WS-K       |
| M   | `AgentTemplate` CRD + `ensure_agent_from_template` (per `AGENT-TEMPLATES.md`) | `v0.1.0-templates` | ✅ shipped | WS-K       |
| —   | `Agent.spec.allowedChildTemplates` (admit children by from-template label — unblocks WS-M live demo) | `v0.1.3-prefix-allow` | ✅ shipped | WS-K + WS-M |
| —   | `Agent.spec.llmParams` — declarative temperature / maxTokens / stopSequences threaded to LLM body | `v0.1.4-llm-params` | ✅ shipped | none |
| —   | LLM gateway bundle — `@kagent/llm-gateway` package + Helm sub-chart + `ModelEndpoint` CRD + operator admission reconciler ([spec](./superpowers/specs/2026-05-03-llm-gateway-bundle-design.md)) | `v0.1.5-llm-gateway` | ✅ shipped | WS-K |
| N   | Webhook + `KagentSchedule` CRD                                       | `v0.1.6-entry-points` (deferred) | pending | WS-J + driver |

**v0.1.0 anchor flips** under this slate: from "comparison rig" to "agent self-service shipped (WS-J/K/L/M)." Comparison rig + researcher port move to `v0.1.7-rig` (was v0.1.5; v0.1.5 was taken by the LLM gateway slice). Reasoning: substrate-completeness (you can use it without YAML) is a stronger v0.1 milestone than a single benchmark, and the rig depends on having self-service to configure it.

**Acceptance for the slate** (per [`AGENT-SELF-SERVICE.md`](./AGENT-SELF-SERVICE.md) §9): browser → "New Task" modal → orchestrator agent runs → uses `ensure_agent_from_template` × 3 → `spawn_child_task` × 3 → `wait_for_children_all` → synthesizes → completes. Workbench shows the task graph live, Langfuse shows nested traces. No YAML, no kubectl.

---

## Phase 5 — Remaining (researcher + comparison)

After Phase 5.x lands, the original Phase 5 workload work resumes:

- [ ] Port researcher agent from `homelab-orchestrator` → produces same daily digest on new substrate
- [ ] A2A demo: researcher → summarizer using WS-K/L/M (replaces the original "parent + child AgentTasks" wording — same outcome, now via real tools instead of hand-applied YAML)
- [ ] Comparison rig: 5-topic workload through both substrates for one week
- [ ] Publish comparison numbers in `docs/V0.1-COMPARISON.md`

**Tag:** `v0.1.7-rig`

---

**Open questions surfaced by the substrate slice (carry forward to next session):**

- **Tool wiring:** Should `Agent.spec.tools` grow a `provider` field so non-built-in tools route differently in P6? Currently just a `string[]` of names. (WS3 Q1)
- **Tools allowlist plumbing:** Project `KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS` from a cluster-level ConfigMap, or keep Helm-values-managed? (WS3 Q2)
- **HTTP body cap:** Hard 1MB with `truncated: true` flag, or refuse over-cap responses outright so the model never sees a half-page? (WS3 Q5)
- **ArtifactRef type duplication:** Should agent-pod adopt a shared `@kagent/contracts` package now, or keep the local copy until the writer slice lands? (WS4 Q1)
- **Inline media-type allowlist:** `inlineSafe` accepts `text/{plain,markdown,x-diff,x-patch}` + `application/json`. Add `text/html` / `application/yaml` / `text/csv`, or wait for the writer? (WS4 Q2)
- **Task-graph cancellation:** `cycleCheck` is fail-open on missing parents. Move to fail-closed for stale chains? Add `Cancelled` to the phase enum? (WS5 Q2/Q3)
- **DTO consolidation:** `@kagent/dto` copied the failure-detector + CRD shapes from `@kagent/operator` (which has no public API). Promote to a shared `@kagent/crds` package now or after Workbench lands? (WS1)
- **Workbench auth:** Resolved for the MVP as fail-closed header-trust auth (`X-Forwarded-User`) in `workbench-api`, with optional Traefik Middleware wiring in the chart. The exact public/Tailscale hostname remains a deployment-values choice. (WS6)

**Tag:** `v0.1.0-phase5` — **v0.1 ships when this tag lands and the comparison-rig numbers do not regress against `homelab-orchestrator`'s baseline.**

---

## Forward roadmap — Wave 0 → Wave 4 (v0.1.7 → v1.0)

> **Architecture spec:** [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) — the 7 primitives + 3 cross-cutting concerns this roadmap delivers.
> **Sub-team plan:** [`WAVES.md`](./WAVES.md) — release-level ownership, parallelism map, file-conflict matrix, validation criteria.
> **Gateway boundary:** [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md) — wire contract for any external model gateway (CTK enterprise, LiteLLM, etc.).
>
> The forward-looking phases that previously occupied this slot (Phase 6 Kata install, Phase 7 framework evaluation, Phase 8 Restate durable execution) have been refactored into the wave structure below:
>
> - **Kata + warm pool** — operator-side wiring already shipped in v0.1 (WS-C); the remaining cluster-side install is an operational task in `new_localai`, not a kagent release. Sandbox profile selection is a per-Agent capability claim under v0.3.0.
> - **Framework evaluation** — application concern, not substrate. Out of scope per [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §8.
> - **Restate durable execution** — folded into `v0.3.2-workflows` as the AgentWorkflow primitive's backend.

### Wave 0 — v0.1 hardening + audit foundation (~2-4 weeks)

Tactical fixes + audit/entry-point foundations that later waves depend on. Five sub-teams in parallel.

| Tag | Scope | Sub-team | Effort |
|---|---|---|---|
| `v0.1.7-attribution` | X-Kagent-{Task-UID,Agent} headers on every LLM call | Gateway | DONE |
| `v0.1.8-secret-hygiene` | `secretKeyRef` for spawned-Job env (kill plaintext gateway/Langfuse keys in etcd) | Secrets | 1 day |
| `v0.1.9-isolation` | `KAGENT_TASK_DEPTH` cap + parent→child AgentTask ownerRef + TTL=300 + `get_my_context` tool + assert `backoffLimit=0` | Isolation | 2 days |
| `v0.1.10-gateway-status` | gateway PATCH `ModelEndpoint.status.observedInFlight` (demoted; optional for enterprise gateway) | Gateway | 2-3h |
| `v0.1.11-traceparent` | W3C traceparent cross-stage propagation (via runConfig + env) | Gateway | 2h |
| `v0.1.12-keys-rest` | `POST /admin/keys` REST endpoint on bundled gateway | Gateway | 2h |
| `v0.1.13-prompts-migrated` | orchestrator + summarizer-{k8s,postgres} → `systemPromptRef` | Hygiene | 10min |
| `v0.1.14-ci-kind-gate` | `helm install --wait` against ephemeral kind in CI | Hygiene | ½ day |
| `v0.1.15-audit-stream` | CloudEvents-shaped audit stream on NATS JetStream (foundation for caps + tenancy) | Audit | 3 days |
| `v0.1.16-entry-points` | `KagentSchedule` CRD + webhook receiver | Entry | 4 days |

**Done when:** every priority queue item from session 2026-05-03 cleared; audit stream emitting events from operator + agent-pod; webhook can mint AgentTasks via shared cap; sub-team file-conflict map clean.

### Wave 1 — v0.2 substrate I/O contracts (~4-5 weeks with parallelism)

Typed dataflow + Workspace + content-addressed Artifacts. v0.2.0 is foundational; v0.2.1 + v0.2.2 fan out in parallel after.

| Tag | Scope | Sub-team | Effort |
|---|---|---|---|
| `v0.2.0-typed-io` | `Agent.spec.inputs/outputs` schema; `AgentTask.spec.inputs[].from`; admission validation; refuse `Completed` patch with missing required outputs; `idempotencyKey`; migrate `KAGENT_AGENT_SPEC` from env JSON to mounted ConfigMap; deprecate `parentDistillation` | I/O | 2 weeks |
| `v0.2.1-workspaces` | `Workspace` CRD (PVC-backed, RWX); init-container clone for `source.git`; mounted via `Agent.spec.workspaceClaims`; quota enforcement; storage-class detection | Workspace | 1.5 weeks |
| `v0.2.2-cas` | Content-addressed artifact store; `read_artifact`/`write_artifact` built-ins keyed by `sha256:<hex>`; ArtifactRef gains `contentHash`; PVC backend (v0.2) abstracted for MinIO/S3 (v0.3+); retention policy | CAS | 2 weeks |

### Wave 2 — v0.3 authority + lifecycle (~5 weeks with parallelism)

Capability bundles + supervision strategies + durable orchestrators. v0.3.0 is foundational; v0.3.1 + v0.3.2 fan out after.

| Tag | Scope | Sub-team | Effort |
|---|---|---|---|
| `v0.3.0-capabilities` | Sealed JWT capability bundle (signed by operator CA); per-Agent claims for tools/models/spawn/read/write/egress/tenant; narrows-on-spawn (substrate-validated); `verify_completion` substrate hook; replaces `allowedChildAgents`/`allowedChildTemplates`/inline tool allowlists | Caps | 3 weeks |
| `v0.3.1-supervision` | `Agent.spec.supervisionStrategy` (one_for_one, one_for_all, rest_for_one, escalate); substrate-handled child-failure routing; structured contract-violation errors | Supervision | 1.5 weeks |
| `v0.3.2-workflows` ✓ SHIPPED | `AgentWorkflow` CRD distinct from `Agent`; `@kagent/agent-workflow-runtime` host SDK (`defineWorkflow` + `WorkflowContext` deterministic ops `spawnAgentTask`/`awaitTask`/`signal`/`awaitSignal`/`sleep`); in-memory deterministic runner + crash-recovery proof; AgentWorkflow controller (informer triplet — AgentWorkflow + Deployment + Service; cap-mint + Secret-volume + Restate admin POST + trigger materialization); workflow-cap issuer (`mintCapabilityForWorkflow`); audit events `workflow.started/step.completed/completed/failed/event_subscription_pending` | Workflows | 2.5 weeks |

### Wave 3 — v0.4 coordination at scale (~2-3 weeks with full parallelism)

Five mostly-independent components ship in parallel.

| Tag | Scope | Sub-team | Effort |
|---|---|---|---|
| `v0.4.0-events` | Typed pub/sub on NATS JetStream; `Agent.spec.publishes/subscribes`; capability-gated topic ACLs | Events | 1 week |
| `v0.4.1-blackboard` | Task-tree-scoped typed KV (NATS JetStream KV backend); `read_blackboard`/`write_blackboard` built-ins | Blackboard | 1 week |
| `v0.4.2-cache` | Best-effort cache primitive keyed by `(input_hash, image_digest, model_name)`; restore-on-boot, save-on-success | Cache | 1 week |
| `v0.4.3-identity` | SPIFFE workload identity; mTLS for agent-pod ↔ gateway; per-Agent SVID replaces shared bearer tokens | Identity | 1.5 weeks |
| `v0.4.4-locality` | NodeAffinity from Workspace placement; speculative execution for slow stragglers; pod-pressure circuit breaker | Locality | 3 days |

### Wave 4 — v0.5 tenancy + compliance (~3 weeks with parallelism)

`Tenant` CRD is foundational; v0.5.1-v0.5.4 fan out after.

| Tag | Scope | Sub-team | Effort |
|---|---|---|---|
| `v0.5.0-tenancy` | `Tenant` CRD (namespace + cap root + audit subject); per-tenant Agent visibility; tenant-scoped quota | Tenancy | 1.5 weeks |
| `v0.5.1-egress` | `Agent.spec.egress` → `NetworkPolicy`/`CiliumNetworkPolicy`; default-deny | Egress | 4 days |
| `v0.5.2-quotas` | Hierarchical org → tenant → Agent quota; pod-pressure cap; quota-breach audit events | Quotas | 1 week |
| `v0.5.3-versioning` | Immutable Agent CRs post-publish; in-flight task version pinning; migration discipline | Versioning | 1 week |
| `v0.5.4-keyrotation` | Operator CA rotates SVIDs; gateway-token rotation API; rotation events in audit stream | KeyRotation | 4 days |

### Path to v1.0

```
Wave 0 (~2-4w) → Wave 1 (~4-5w) → Wave 2 (~5w) → Wave 3 (~2-3w) → Wave 4 (~3w)
                                                                       │
                                                                       ▼
                                                                   v1.0 GA
```

Critical-path sequential: ~16-20 weeks (~4-5 months). Plenty of slack to absorb scope reveal as primitives reify.

**v1.0 ships when:**
- All 7 primitives + 3 cross-cutting concerns are operational per [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md)
- Comparison rig (below) numbers do not regress vs. `homelab-orchestrator` baseline
- An external enterprise consumer can deploy kagent + plug their own model gateway without forking
- Audit stream survives a SOC2 dry-run review

### Out of scope through v1.0

These remain explicitly out of substrate scope per [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §8:

- ❌ Built-in agent SDK (any framework runs in a pod)
- ❌ Bundled production model gateway (gateway is external; OSS bundle is dev-convenience only)
- ❌ Domain-specific tools (researcher / summarizer / validator are application code)
- ❌ Streaming response support (until a real consumer drives it)
- ❌ Cluster-wide policy engines (OPA / Kyverno are companions, not substitutes)
- ❌ Kubernetes-managing agents (Solo.io's [kagent.dev](https://kagent.dev) domain)
- ❌ Untrusted-code-exec per tool call (Bubblewrap/Firecracker nested sandbox — only if a workload needs it)
- ❌ Framework swap (Strands TS / Mastra) — application choice, not substrate

---

## Comparison rig — the falsifiable test

Per [`WHY.md`](./WHY.md) §6, the project commits to a **falsifiable success criterion before work**:

> Run the existing 5-topic researcher workload through `homelab-orchestrator` (current substrate) and through kagent v0.1 (new substrate) for one week each. Compare:
> - Completion rate (% of runs reaching `completed` status with non-vacuous output)
> - Median run cost (USD)
> - Median end-to-end latency (seconds, AgentTask Created → AgentTask status updated)
> - Failure mode distribution (F1/F2/F3/refusal/vacuity per detector)

If kagent v0.1 does not improve on the baseline, **Wave 1+ (the substrate primitives in [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md)) is the validation bet, not a presumed evolution.** If Wave 1 also fails, this is admit-failure territory, not double-down territory.

That discipline — falsifiable test before work, not thesis-defense after — is the lesson the kernel project lacked.
