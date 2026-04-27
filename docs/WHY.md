# Why kagent exists

**Date:** 2026-04-26 (initial)

## 1. The OSS market gap

In 2026 the agent-platform field has converged on a primitive: each agent gets its own sandbox, with persistent state, per-instance scheduling, and a managed loop. AWS calls it Bedrock AgentCore. Cloudflare calls it Agents + Sandbox SDK. Anthropic calls it Managed Agents (Agent → Environment → Session). All three ship proprietary, cloud-locked implementations.

**Nobody has shipped the OSS / K3s equivalent.** Every component to assemble it exists:
- **Kata Containers** — microVM-grade per-pod isolation as a Kubernetes `RuntimeClass`
- **NATS JetStream** — durable subject-based messaging, KV buckets for live state
- **Bun** — lean TypeScript runtime; ~40MB RSS for an agent pod (Anthropic-owned as of Dec 2025)
- **LiteLLM** — multi-provider OpenAI-compat proxy with virtual keys, fallbacks, cost tracking
- **Langfuse** — self-hostable trace + cost + eval store
- **`@kubernetes/client-node`** — TS Kubernetes client with watch/informer patterns sufficient for a hand-rolled operator

But nobody has wired them. AWS AgentCore is non-portable (locked to Bedrock + AWS). CF Agents is non-portable (Durable Objects don't exist outside Cloudflare; `workerd` OSS doesn't include them). Anthropic Managed Agents is non-portable (managed cloud, Claude-only).

`kagent` is the composition. K3s-native, MIT-licensed, BYO-everything (cluster, LLM endpoint, sandbox profile). Sandbox-per-agent. A2A messaging. Unified trace. Same manifests run on the homelab and on GKE / EKS / AKS unchanged.

## 2. The kernel pivot

This project supersedes the "governance kernel" framing of [`@ctkadvisors/agent-runtime`](../../agent-runtime). That repo was a thoughtful attempt to encode Aaron Sempf's *Architecting Autonomy* thesis — "governance as architecture, structural enforcement before dispatch, authority as a designable primitive" — as a TypeScript kernel. The repo shipped real work: an AgentExecutor with documented loop invariants, a `RunBudget` carried in the result envelope, JSONL trace sinks on a PVC, MCP / HTTP / InProcess tool-provider abstractions.

It also revealed three things on contact with real workloads (see [`HARNESS-LESSONS.md`](./HARNESS-LESSONS.md)):

1. **The kernel's M1 code does no pre-dispatch enforcement.** `RunBudget.cumulativeCostUsd` is observed in the result envelope; the iteration cap is the only thing that actually stops a run, and every framework has that. The "structural enforcement" differentiator was M2 vapor — aspirational, not load-bearing in the code.

2. **The run-end detectors built to catch real failures (synthesis vacuity, methodology fabrication, tool-use omission, truncated synthesis, sub-agent refusal) are exactly the "telemetry after the fact" that the thesis criticized.** The kernel was performing the same shape of monitoring it claimed to obsolete.

3. **Most of the harness pain was a model-tier problem, not a framework problem.** Llama-4-Scout via the Cloudflare AI Gateway compat endpoint was inconsistent at OpenAI tool-call protocol — three runs, three different shapes, JSON-as-text drift, sub-agent refusals on thin prompts. None of these are fixed by replacing the framework. They are mitigated by routing to a competent model (Sonnet 4.6, Llama-3.3-70B) and by surrounding the loop with the right substrate-level affordances.

The honest result: the kernel itself was not the load-bearing artifact. The substrate composition is. **The AgentExecutor is reusable as the inner loop of a single agent pod.** The Sempf-flavored thesis docs are not.

## 3. Strategic posture

`kagent` is built around five commitments:

1. **K3s-native, cloud-portable.** The K3s homelab is the deploy target; same manifests run on any K8s 1.27+. No proprietary primitives in the substrate (no Durable Objects, no Bedrock-only resources, no managed-cloud assumptions). The substrate is the gap; closing it for OSS is the contribution.

2. **MIT, no SaaS in the data path by default.** Every component (operator, agent-loop, NATS, LiteLLM, Langfuse) self-hosts. Cloud egress (Bedrock, Anthropic, OpenAI, AI Gateway) is operator choice, not a precondition.

3. **Sandbox-per-agent.** Each agent runs in its own pod. v0.1 ships with default `runc`; v0.2 adds Kata Containers as a `RuntimeClass` for microVM-grade isolation. Untrusted-code-exec inside an agent (CF Sandbox analog) is nested isolation — agent in Kata pod, plus sub-process Bubblewrap or a separately-managed Firecracker pool — and lands when a workload demands it.

4. **A2A as messaging primitive, not as a framework.** NATS JetStream subjects with a capability-routing convention (`agent.cap.<capability>.task.<taskId>`) and a heartbeat-expiring KV bucket for live agent → capability resolution. Topology (DAG, swarm, plan-then-execute) is application-layer, not substrate-layer.

5. **Observability is a contract, not a vendor.** Every iteration emits structured trace events via OTel. Langfuse self-hosted is the v0.1 sink; the same exporter works against any OTel-compatible backend. Cost is a first-class field, surfaced via LiteLLM tagging.

## 4. Why now

Three forces converge at this moment:

- **Anthropic acquired Bun (Dec 2025).** TypeScript-first agent infrastructure is now structurally aligned with the company driving the most aggressive coding-agent adoption. Building the substrate in Bun is alignment, not bet.
- **The harness experiments are saturated.** The `homelab-orchestrator` + chat-server + agent-runtime triangle has produced a complete catalog of model-failure modes (F1/F2/F3 detectors, refusal detection, synthesis vacuity, tool-name hallucination). Continuing to add detectors inside `agent-runtime` is post-hoc patchwork; lifting them into `@kagent/agent-loop` as middleware lets them serve any workload on the substrate.
- **The OSS components are individually mature.** Kata Containers ships with K3s deployer support. NATS JetStream is production-stable. Bun has cleared the 1.x stability bar. LiteLLM has 100+ providers. Langfuse has Helm charts. The composition is the missing thing.

## 5. What changes for the existing CTK projects

| Existing | Becomes |
|---|---|
| `@ctkadvisors/agent-runtime` | The AgentExecutor + RunBudget + JsonlSink + F1/F2/F3 detectors lift into `@kagent/agent-loop` as a thin in-pod library. ~70% of the TypeScript survives. The Sempf governance-kernel framing retires. |
| `homelab-orchestrator` | First consumer of the new substrate. The current CronJob + runner disappears; replaced by a thin K8s CronJob that templates and `kubectl apply`s an `AgentTask` CRD per topic per day. The repo becomes topics + Agent CRD definitions, not a runtime. |
| Chat UI (`agent.knuteson.io`) | Either retired in favor of Langfuse + a thin chat client targeting `kagent`'s API, OR migrated as a UI for `AgentTask` submission. Decided post-v0.1. |
| JSONL trace + viewer at `orchestrator.knuteson.io` | Retired once Langfuse ingestion is reliable. `JsonlSink` stays in `@kagent/agent-loop` as a debug-mode option. |

## 6. The fail-state we are honest about

If, at v0.1 ship, the new substrate's autonomous-uptime ÷ failure-rate is no better than `homelab-orchestrator`'s current numbers running the same 5-topic researcher workload, then the substrate is not yet earning its keep at the level the thesis promises. That outcome means v0.2 work (Kata, warm pool, optional framework swap) is required to validate; if v0.2 also fails to move the metric, the project is admit-failure territory, not double-down territory. We define the comparison rig BEFORE starting (run the existing 5-topic workload through both substrates for one week, compare cost + completion + median latency).

This is the discipline the kernel project lacked: a clear, falsifiable success criterion ahead of work, not a thesis to defend after.
