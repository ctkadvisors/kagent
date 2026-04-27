# Roadmap

**Date:** 2026-04-26
**Status:** Draft, pre-implementation
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

- [x] CI image build pipeline ([`.github/workflows/images.yml`](../.github/workflows/images.yml)): builds + pushes `ghcr.io/ctkadvisors/kagent-operator` and `ghcr.io/ctkadvisors/kagent-agent-pod` on tag-push (`v*-phase*` or `vX.Y.Z`), main-branch pushes, and manual dispatch.
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

- [ ] **Watch K8s Job/Pod terminal state and reflect into AgentTask.status.** Today the operator dispatches and walks away — if the agent-pod crashes before it patches status (image pull fails, OOMKilled, container exits non-zero), the task pins in `phase=Dispatched` forever and the operator's reconciler short-circuits on next watch event. Add a Job watcher that maps Job `failed`/`succeeded` to AgentTask phase when no status was patched. (Codex review 2026-04-27 called this out as the highest-leverage lifecycle hardening.)
- [ ] **Restore Bun runtime when `@kubernetes/client-node`'s TLS path fixes parity.** The Watch path under `bun:1.1-alpine` rejects K3s's self-signed CA with `SELF_SIGNED_CERT_IN_CHAIN` even though the same kubeconfig works for one-shot API calls; same bug on the agent-pod's `patchNamespacedCustomObjectStatus`. Both runtimes pivoted to `node:22-alpine` + tsx as a workaround; CLAUDE.md updated to reflect that. Track Bun's undici/TLS work and revert when fixed.
- [ ] **Trigger Gitea Actions on mirrored tags.** Gitea's mirror-pull from GitHub does NOT fire its own Actions workflows by default in 1.22.3, so `git.knuteson.io/homelab/kagent-{operator,agent-pod}` stayed empty until images were pushed manually from a workstation. Long-term fix is one of: (a) push directly to Gitea (loses GitHub-mirror semantics), (b) wait for Gitea/Forgejo to support workflow_dispatch via API in a version we can upgrade to, (c) keep a small webhook bridge that POSTs `mirror-sync` + `workflow_dispatch` together. Until then: manual `workflow_dispatch` in the Gitea UI on every release tag, OR direct `docker buildx --push` from a dev box.
- [ ] **Wire Agent.spec.tools through to the executor.** The agent-pod runs chat-only today — the AgentRegistry registration in `runner.ts` skips the `tools` field. Most consumer workloads (researcher, summarizer) need at least HTTP fetch / MCP tool wiring before Phase 5 can land.
- [ ] **Move Agent + Task spec injection off env JSON.** `KAGENT_AGENT_SPEC` and `KAGENT_TASK_SPEC` as env-var JSON strings is fine for smoke tests but caps payloads at ARG_MAX and exposes secrets to `ps`/`/proc`. Switch to a downward-API volume or a per-task ConfigMap mounted at a known path before the first real consumer.

---

## Phase 5 — End-to-end + first consumer (~1 week)

- [ ] E2E test: `kubectl apply -f` an `AgentTask` → Pod spawned → loop runs against jetson1 Ollama → result written back to AgentTask status → trace in Langfuse
- [ ] Port researcher agent from `homelab-orchestrator` → produces same daily digest on new substrate
- [ ] A2A demo: researcher delegates to summarizer specialist via NATS, both as separate Pods, both traced
- [ ] Comparison rig: run existing 5-topic workload through both substrates for one week; compare cost + completion + median latency
- [ ] Publish comparison numbers in `docs/V0.1-COMPARISON.md`

**Tag:** `v0.1.0-phase5` — **v0.1 ships when this tag lands and the comparison-rig numbers do not regress against `homelab-orchestrator`'s baseline.**

---

## Phase 6 (v0.2) — Kata Containers + warm pool (~1 week)

- [ ] Kata Containers `RuntimeClass` deployed onto K3s nodes via Kata K8s deployer
- [ ] Agent CRD `sandboxProfile: strict` plumbs to `runtimeClassName: kata` on Agent Pod spec
- [ ] Measure overhead: spawn time, RSS, throughput delta vs runc
- [ ] Warm pool option: `Agent` CRD `warmReplicas: N` materializes a StatefulSet alongside the Job-per-task path
- [ ] Decide on default sandbox profile based on measured overhead

**Tag:** `v0.2.0-phase6`

---

## Phase 7 (v0.2) — Framework evaluation (~1–2 weeks)

- [ ] Build alternate `@kagent/agent-loop-strands` (Strands TS in pod) + `@kagent/agent-loop-mastra` (Mastra in pod)
- [ ] Run comparison rig: same researcher workload, three pods (forked AgentExecutor, Strands TS, Mastra)
- [ ] Decide: keep fork? swap to Strands TS or Mastra? Empirical, not philosophical.
- [ ] Document the verdict in `docs/V0.2-FRAMEWORK-EVAL.md`

**Tag:** `v0.2.1-phase7`

---

## Phase 8 (v0.3) — Durable execution (~1–2 weeks)

- [ ] Restate adapter for session persistence — pod restart mid-run resumes from checkpoint
- [ ] `Agent` CRD `durability: restate` flag
- [ ] Test: kill an agent pod mid-multi-iteration run; confirm resume

**Tag:** `v0.3.0-phase8`

---

## Future (no tag yet)

These ship if and when there's a concrete driver, not on speculation:

- **Streaming responses** — for chat-style consumers; requires SSE pass-through from agent pod through operator to client
- **Multi-tenant** — namespace-per-tenant + RBAC + LiteLLM virtual keys keyed by tenant
- **Authority graph / OPA policy enforcement** — only if a real workload demands pre-dispatch policy that detector middleware can't satisfy
- **Operator UI** — replaces `kubectl` interaction; not until the user surface justifies it
- **Untrusted-code-exec sandbox per tool call** — nested isolation (Bubblewrap or Firecracker pool) inside Kata pods, only when a workload needs it
- **Strands TS or Mastra adoption** — if Phase 7 verdict says swap

---

## Comparison rig — the falsifiable test

Per [`WHY.md`](./WHY.md) §6, the project commits to a **falsifiable success criterion before work**:

> Run the existing 5-topic researcher workload through `homelab-orchestrator` (current substrate) and through kagent v0.1 (new substrate) for one week each. Compare:
> - Completion rate (% of runs reaching `completed` status with non-vacuous output)
> - Median run cost (USD)
> - Median end-to-end latency (seconds, AgentTask Created → AgentTask status updated)
> - Failure mode distribution (F1/F2/F3/refusal/vacuity per detector)

If kagent v0.1 does not improve on the baseline, **v0.2 work (Kata, warm pool, framework swap) is the validation bet, not a presumed evolution.** If v0.2 also fails, this is admit-failure territory, not double-down territory.

That discipline — falsifiable test before work, not thesis-defense after — is the lesson the kernel project lacked.
