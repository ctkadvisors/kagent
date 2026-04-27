# kagent

K3s-native, OSS, MIT-licensed agent farm operator. Composes Kata Containers + NATS JetStream + Bun + LiteLLM + Langfuse into the per-agent-microVM substrate that AWS AgentCore, Cloudflare Agents + Sandbox, and Anthropic Managed Agents all ship proprietarily — and that the OSS world has not yet shipped.

**Status:** pre-implementation. The "why" and "what" live in [`docs/`](./docs); the "how" lands in subsequent sessions. v0.1 scope is 4–6 weeks of focused work.

**Deploy target:** K3s (homelab). Same manifests run on GKE / EKS / AKS / any Kubernetes 1.27+.

## What this is

Every agent runs in its own pod. Agents discover and address each other via NATS JetStream subjects. Inference routes through a self-hosted LiteLLM proxy that fronts homelab Ollama, AWS Bedrock, Cloudflare AI Gateway, or any OpenAI-compatible backend. Every iteration is traced into self-hosted Langfuse with cost attribution. v0.2 adds Kata Containers as a `RuntimeClass` for microVM-grade per-agent isolation.

The control plane is a small Bun + TypeScript Kubernetes operator that watches `Agent` and `AgentTask` CRDs and materializes pods (Jobs in v0.1; warm pools in v0.2). The agent runtime inside each pod is the AgentExecutor lifted from the prior `@ctkadvisors/agent-runtime` learning-experiment kernel, now repackaged as `@kagent/agent-loop` — a thin in-pod library, not a freestanding governance primitive.

## What this is NOT

- **Not a new agent SDK.** Agents inside pods can run any TypeScript framework (Strands TS, Mastra, the forked AgentExecutor) or a hand-rolled loop. The substrate is framework-agnostic.
- **Not a new LLM gateway.** LiteLLM does that.
- **Not a new trace store.** Langfuse does that.
- **Not a multi-agent framework in the LangGraph/CrewAI sense.** Topology is a property of what you put on top; the substrate ships A2A messaging primitives only.
- **Not a governance kernel.** That framing was retired (see [`docs/WHY.md`](./docs/WHY.md) §2). Pre-dispatch policy enforcement, if it lands at all, lands as middleware in `@kagent/agent-loop`, not as a separate runtime concept.

## Reading order

1. [`docs/WHY.md`](./docs/WHY.md) — why this exists, what gap it closes, the kernel pivot
2. [`docs/DESIGN-V0.1.md`](./docs/DESIGN-V0.1.md) — the v0.1 architecture spec
3. [`docs/PRIOR-ART.md`](./docs/PRIOR-ART.md) — what exists in 2026, what we use, what we don't, why
4. [`docs/HARNESS-LESSONS.md`](./docs/HARNESS-LESSONS.md) — model failure modes from prior experiments that inform substrate design
5. [`docs/ROADMAP.md`](./docs/ROADMAP.md) — v0.1 / v0.2 / v0.3 / future phasing

## License

MIT — see [`LICENSE`](./LICENSE).
