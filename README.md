# kagent

K3s-native, OSS, MIT-licensed agent operator. Composes per-agent-pod isolation (consuming `kubernetes-sigs/agent-sandbox` for the isolation primitive itself) with NATS JetStream + Node 22/Bun + LiteLLM + Langfuse, and ships two narrower primitives on top that the surveyed OSS+proprietary landscape does not: **(a) substrate-thin context-pressure handling — pre-call refusal at 95%, agent-side introspection via `get_my_context`, and a `context_pressure_ignored` run-end detector** (commits `73f67f4`, `fb549c0`, `fc32b13`; see `evidence/audit-rev2/R1.md` §3); and **(b) sealed-JWT capability narrowing on spawn — substrate-enforced `child.claims ⊆ parent.claims`** (`packages/operator/src/cap-issuer.ts`, `packages/agent-pod/src/cap-consumer.ts`; see `evidence/audit-rev2/R1.md` §1, R1.4 #4). Earlier framing claimed kagent was the only OSS K3s-native agent framework. As of 2026-05, that's false — `kubernetes-sigs/agent-sandbox` v0.4.5 ships per-agent isolation, and Solo.io kagent.dev v0.9.x consumes it via `SandboxAgent`. The defensible scope for kagent is narrower and sharper.

**Status:** Phase 4 (deploy + smoke) shipped 2026-04-27. AgentTask CR → operator informer → Job → agent-pod → AgentTask.status patched, end-to-end on the homelab K3s cluster against LM Studio in ~11s. Phase 4.x lifecycle hardening (Job/Pod failure reflection, deadline enforcement) follows. v0.1 ships when the comparison-rig in Phase 5 proves no-regression vs the prior `homelab-orchestrator` baseline.

**Deploy target:** K3s (homelab). Same manifests run on GKE / EKS / AKS / any Kubernetes 1.27+.

## What this is

Every agent runs in its own pod. Agents discover and address each other via NATS JetStream subjects. Inference routes through a self-hosted LiteLLM proxy that fronts homelab Ollama, AWS Bedrock, Cloudflare AI Gateway, or any OpenAI-compatible backend (the Phase 4 smoke test points directly at LM Studio). Every iteration is traced into self-hosted Langfuse with cost attribution. Per-Agent microVM-grade isolation is available now via `agentPod.runtimeClasses.strict` — strict-profile Agents land on a `RuntimeClass` of your choice (Kata is the canonical pick); requires Kata Containers deployed onto the K3s nodes per `docs/ROADMAP.md` Phase 6 before flipping the value to `'kata'`.

The control plane is a small TypeScript Kubernetes operator that watches `Agent` and `AgentTask` CRDs and materializes pods (Jobs in v0.1; warm pools in v0.2). Operator + agent-pod runtimes are currently **Node 22 + tsx** — Bun was the original target (see `docs/WHY.md` and CLAUDE.md), but Bun 1.1's TLS handling rejects K3s's self-signed CA in `@kubernetes/client-node`'s Watch + status-PATCH paths; revert to Bun is on the list once that lands. The agent runtime inside each pod is the AgentExecutor lifted from the prior `@ctkadvisors/agent-runtime` learning-experiment kernel, now repackaged as `@kagent/agent-loop` — a thin in-pod library, not a freestanding governance primitive.

## What this is NOT

- **Not a new agent SDK.** Agents inside pods can run any TypeScript framework (Strands TS, Mastra, the forked AgentExecutor) or a hand-rolled loop. The substrate is framework-agnostic.
- **Not a new LLM gateway.** LiteLLM does that.
- **Not a new trace store.** Langfuse does that.
- **Not a multi-agent framework in the LangGraph/CrewAI sense.** Topology is a property of what you put on top; the substrate ships A2A messaging primitives only. v0.1 ships the dispatch envelope contract + NATS publish path; in-pod NATS subscription / streaming-cancel / warm-pool delegation lands in v0.2.
- **Not a governance kernel.** That framing was retired (see [`docs/WHY.md`](./docs/WHY.md) §2). Pre-dispatch policy enforcement, if it lands at all, lands as middleware in `@kagent/agent-loop`, not as a separate runtime concept.

## Reading order

1. [`docs/WHY.md`](./docs/WHY.md) — why this exists, what gap it closes, the kernel pivot
2. [`docs/DESIGN-V0.1.md`](./docs/DESIGN-V0.1.md) — the v0.1 architecture spec
3. [`docs/PRIOR-ART.md`](./docs/PRIOR-ART.md) — what exists in 2026, what we use, what we don't, why
4. [`docs/HARNESS-LESSONS.md`](./docs/HARNESS-LESSONS.md) — model failure modes from prior experiments that inform substrate design
5. [`docs/ROADMAP.md`](./docs/ROADMAP.md) — v0.1 / v0.2 / v0.3 / future phasing
6. [`docs/PLATFORM-PRIORITIES.md`](./docs/PLATFORM-PRIORITIES.md) — prioritized implementation spine after the Phase 4 smoke test
7. [`docs/WORKBENCH.md`](./docs/WORKBENCH.md) — read-only visibility surface over the engine, not a new channel

## License

MIT — see [`LICENSE`](./LICENSE).
