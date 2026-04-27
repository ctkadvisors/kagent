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

- [ ] `package.json` + `bun.lockb` + `tsconfig.json` (strict ESM Node 22 / Bun 1.1+ target)
- [ ] `pnpm-workspace.yaml` for monorepo: `packages/agent-loop`, `packages/operator`, `packages/agent-pod`
- [ ] Lift AgentExecutor + RunBudget + JsonlSink + ToolProvider abstraction from `agent-runtime` into `packages/agent-loop`
- [ ] Lift F1/F2/F3 detectors + refusal detection + synthesis-vacuity heuristic from chat-server commits into `packages/agent-loop` as run-end middleware
- [ ] MIT license header on every `.ts` source file
- [ ] CI: typecheck + lint + test on push-to-main + every PR
- [ ] Coverage: ≥85% on agent-loop core, ≥75% on glue

**Tag:** `v0.0.1-phase1`

---

## Phase 2 — Operator + CRDs (~1 week)

- [ ] CRD definitions: `Agent`, `AgentTask`, `AgentCapability` (`packages/operator/src/crds/`)
- [ ] Operator skeleton: Bun + `@kubernetes/client-node`, watch loop on `AgentTask`
- [ ] Reconcile logic: `AgentTask` Created → resolve target Agent → create Job → publish to NATS subject → watch for completion → write result to AgentTask status
- [ ] Smoke test against `kind` cluster
- [ ] Helm chart for the operator + RBAC

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
