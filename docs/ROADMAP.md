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

- [ ] NATS JetStream Helm wiring + KV bucket setup
- [ ] Agent Pod base image: Bun + agent-loop + downward API for Agent definition
- [ ] In-pod NATS subscription: `agent.<id>.task.<taskId>` for inbound; `agent.cap.<cap>.task.<id>` for delegation
- [ ] A2A envelope contract (per [`HARNESS-LESSONS.md`](./HARNESS-LESSONS.md) §6): `taskId, parentTaskId?, originalUserMessage, parentDistillation?, expectedTools?, structuralVerdict`
- [ ] OTel exporter wired into agent-loop, pointing at Langfuse

**Tag:** `v0.0.3-phase3`

---

## Phase 4 — LiteLLM + Langfuse (~0.5 week)

- [ ] LiteLLM Proxy Helm chart deployed; routes for `cf-gateway`, `ollama`, `bedrock`, future `on-prem-*`
- [ ] Langfuse self-hosted Helm chart; OTel ingest verified
- [ ] Smoke: agent pod calls LiteLLM, trace lands in Langfuse with cost attribution

**Tag:** `v0.0.4-phase4`

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
