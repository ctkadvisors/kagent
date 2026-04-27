# Prior art — what we use, what we don't, why

**Date:** 2026-04-26
**Subject:** Decision-grade survey of the 2026 agent-platform field, oriented around the question "for a K3s-portable agent farm with per-agent sandbox/dyno, what do we adopt vs build vs avoid?"
**Source material:** synthesizes the WHY-NOT-X.md / GAP-VS-STRANDS-AUTONOMOUS.md / GAP-VS-CF-OAS-ADK.md analyses from `homelab-orchestrator/docs/` (originals retained there as the reasoning trail).

---

## 1. Decision summary

| Component | Choice | Why |
|---|---|---|
| **Container runtime** | runc (v0.1) → Kata Containers (v0.2) | Kata gives microVM-grade per-pod isolation as a `RuntimeClass`, no infra rebuild |
| **A2A messaging** | NATS JetStream | Subject-routing + KV bucket + durable streams; sub-ms in-cluster latency; battle-tested |
| **Pod runtime** | Bun | Lean, TS-native, Anthropic-owned (Dec 2025) → ecosystem alignment |
| **In-pod agent loop** | Forked AgentExecutor (`@kagent/agent-loop`) for v0.1 | Debugged code, ports F1/F2/F3 detectors forward; framework swap deferred to v0.2 evaluation |
| **Model gateway** | LiteLLM Proxy (self-hosted) | 100+ providers, virtual keys, fallbacks, cost tracking, Postgres-backed; nothing we'd write beats it |
| **Trace + cost + eval** | Langfuse (self-hosted) | OSS Helm chart; OTel-compatible; replaces JSONL-on-PVC |
| **Operator language** | TypeScript + `@kubernetes/client-node` | Avoids Go context-switch; small operator surface keeps risk bounded |
| **Sandbox per untrusted-code-exec** | Deferred (v0.2+ — nested Bubblewrap or Firecracker pool) | Not in v0.1 scope; agent-pod-level Kata covers default isolation |

## 2. What we don't use as the substrate, and why

### 2.1 AWS Strands

[strandsagents.com](https://strandsagents.com) — Apache 2.0, Python primary with a TypeScript SDK, Bedrock-native, MCP-native, OTel-built-in, deployable Lambda → EKS, ships ~50 first-party tools.

**Why not as the substrate:** Strands is an *agent SDK*, not a K3s-portable substrate. It assumes the runtime is the agent process; it does not ship a Kubernetes operator, per-agent-pod isolation, or a NATS-routed A2A bus. You could run Strands TS *inside* a kagent pod — that is the v0.2 framework-evaluation question. You cannot use Strands *as* the substrate; the substrate is the gap Strands does not close.

**Where it's structurally closer to our stated goals than `@ctkadvisors/agent-runtime` was:** Strands' 13-event hook system (`BeforeToolCallEvent`, `AfterToolCallEvent`, etc.) with read+write access pre-dispatch is the actual shape of the "structural enforcement before dispatch" idea the kernel project never built.

**v0.2 question:** does swapping `@kagent/agent-loop` for Strands TS inside the pod move the autonomous-uptime ÷ failure-rate metric? Empirical, not philosophical.

### 2.2 Cloudflare Agents + Sandbox SDK

[developers.cloudflare.com/agents](https://developers.cloudflare.com/agents) — MIT, Durable-Object-per-agent, SQLite-per-DO, native scheduling (`this.schedule()`), first-party Browser Rendering and Sandbox bindings, AI Gateway integration. The cleanest per-agent-isolation primitive in the industry.

**Why not as the substrate:** Cloudflare-locked. Durable Objects are not in `workerd`'s OSS surface. The whole value prop (per-instance state, alarms, SQLite-per-DO) leans on DO. Adopting CF Agents as the substrate means abandoning K3s portability — directly opposed to this project's premise.

**Where CF Agents wins on its own terms:** a non-K3s "autonomous-explorer" workload (separate from `homelab-orchestrator`'s digest workload) could legitimately land on CF Agents and call jetson1 Ollama via Cloudflare Tunnel. That hybrid was Option D in the prior gap analysis and remains a defensible path for an explorer use case where K3s portability is not a constraint.

### 2.3 Anthropic Claude Managed Agents

[platform.claude.com/docs/en/managed-agents](https://platform.claude.com/docs/en/managed-agents) — beta as of April 2026 (`managed-agents-2026-04-01` header). Pre-built configurable harness running in Anthropic's managed infrastructure. *Agent* (model + prompt + tools + MCP + skills) → *Environment* (cloud container template, pre-installed Python/Node/Go) → *Session* (running instance, persistent FS, conversation history). Steering / interrupt mid-execution.

**Why not as the substrate:**
- Claude-only by definition (model is part of Agent definition; no Llama/Gemini/Ollama path).
- Hosted on Anthropic's containers; no K3s, no on-prem hardware in the data path. Defeats this project's portability premise.
- Harness is opaque — you cannot add structural detectors at iteration boundaries; you can only consume completion events.
- Beta API stability for a substrate decision is poor footing.
- Cost floor is API pricing × container hours, not local-hardware-amortized.

**Where Managed Agents wins on its own terms:** for any team where the agent farm is a *services product* and Anthropic-cloud is acceptable in the data path, Managed Agents is the fastest path from vision to working autonomous agent in 2026 — days, not weeks. Our project is the inverse use case (substrate ownership, model portability, on-prem hardware option).

### 2.4 OpenAI Agents JS

[openai.github.io/openai-agents-js](https://openai.github.io/openai-agents-js) — MIT, custom `ModelProvider` interface (genuinely provider-agnostic), pluggable `TraceProvider` (default exports to OpenAI cloud), MCP first-class, runs on Node + Cloudflare Workers + voice (WebRTC/SIP).

**Why not as the substrate:** OpenAI Agents JS is what `@ctkadvisors/agent-runtime` already structurally is — a TypeScript agent runner with a `ModelProvider` interface and a tracing-exporter contract. Adopting it gains us nothing over forking AgentExecutor; we trade a kernel we control for a kernel we don't, with no tool-catalog windfall versus Strands. Default tracing exporter ships traces to OpenAI cloud.

**v0.2 framework-evaluation question, same shape as Strands TS:** does swapping the in-pod loop for OpenAI Agents JS move the metric? Empirical.

### 2.5 Google ADK

[adk.dev](https://adk.dev) — Apache 2.0, multi-language (Py/TS/Go/Java), evaluation framework, session rewind, multi-LLM via LiteLlm wrapper (Ollama works).

**Why not as the substrate:** ADK is GCP-optimized. Without a GCP dependency the value proposition collapses to "Strands but written by Google." We are not GCP-native; we are K3s-native. The eval framework is genuinely interesting and may inform our Langfuse evaluator design later.

### 2.6 Mastra

YC-backed (W24), MIT, TypeScript-native, agent + workflow + memory + eval primitives, ships Mastra Cloud and self-host via Docker.

**Why not as the substrate:** Mastra is a TS agent SDK with batteries, not a K3s substrate. Same shape as Strands TS for our purposes — viable as the v0.2 in-pod loop choice; not viable as the operator/A2A/sandbox layer.

### 2.7 LangGraph

[docs.langchain.com/langgraph](https://docs.langchain.com/langgraph) — MIT (with LangSmith and LangGraph Platform commercial), state-machine/graph runtime, durable checkpointers.

**Why not as the substrate:** LangGraph is a runtime for *stateful, long-running, durable* agents. Adopting it means inheriting the LangChain abstraction stack. Our durable-execution story (Restate adapter) lives at v0.3 and is its own concern; LangGraph is wrong layer for v0.1.

### 2.8 E2B / Daytona

E2B and Daytona both ship sub-second sandbox SDKs. Both are **open-core**: SDK is MIT, control plane / orchestration is SaaS-first. E2B's `e2b-infra` is open and runs on Firecracker, but the self-host story is "run our software on your AWS" rather than "helm install."

**Why not as the v0.1 sandbox layer:** open-core ≠ pure OSS. For a K3s-native, MIT, BYO-everything substrate, the sandbox primitive needs to ship as a Helm chart we own. Kata Containers + RuntimeClass meets that bar; E2B and Daytona do not.

**Where they may earn a place:** as an OPTIONAL adapter for users who want managed sandbox-as-a-service rather than self-hosted Kata. A `sandboxProfile: e2b` Agent CRD value could plumb to E2B's API. Not v0.1.

## 3. What we do use, in detail

### 3.1 LiteLLM Proxy

MIT, 100+ providers, OpenAI-compat unification, virtual keys, budgets, fallbacks, cost tracking, Postgres-backed. There is no scenario where we beat LiteLLM by writing our own gateway in <6 months. Helm-deploy and treat as plumbing.

Routing for the homelab:
- `cf-gateway` → Cloudflare AI Gateway (default per [`memory:project_llm_backend_decision`](../../homelab-orchestrator/.planning/memory))
- `ollama` → jetson1 bare-metal `192.168.68.73:11434` (opt-in)
- `bedrock` → AWS Bedrock when creds wired
- `on-prem-*` → custom OpenAI-compat endpoints when on-prem GPU hardware comes online

### 3.2 Langfuse

Self-hosted, MIT, OTel ingest, cost tracking, eval, prompt management, dataset versioning. Replaces both the JSONL-on-PVC sink and the `orchestrator.knuteson.io` viewer.

The F1/F2/F3 / refusal / synthesis-vacuity detectors that earned their keep in `homelab-orchestrator/src/chat/` port forward into `@kagent/agent-loop` as run-end middleware AND can be re-implemented as Langfuse evaluators for offline replay against historical traces.

### 3.3 NATS JetStream

Subject-based pub/sub plus durable streams plus a KV bucket primitive. Sub-millisecond in-cluster latency. Helm chart `nats-io/nats`.

A2A subject taxonomy (locked into [`DESIGN-V0.1.md`](./DESIGN-V0.1.md) §4.3):
- `agent.<agentId>.task.<taskId>` — direct addressing
- `agent.cap.<capability>.task.<taskId>` — capability-routed
- `agent.<agentId>.event.<seq>` — heartbeat / lifecycle
- KV bucket `agents-live` for live agent → capabilities map (heartbeat-expiring)

### 3.4 Kata Containers (v0.2)

`RuntimeClass: kata` deployed via the Kata K8s deployer onto K3s nodes. ~30MB overhead, ~1s additional spawn vs runc. Set `runtimeClassName: kata` on Agent Pod spec when Agent CRD specifies `sandboxProfile: strict`.

### 3.5 Bun

Lean TS runtime. ~30MB image base. Anthropic owns Bun (Dec 2025); MIT/OSS preserved. Both the operator and the in-pod agent runtime use Bun.

## 4. The day-job AI gateway question (out of scope here)

A separate decision space — covered in conversation, not encoded in this repo. The short version: for a smaller-scale shop with SOC 2 ambitions, on-prem peering plans, and an acquisition narrative, the right shape is **LiteLLM as the data-plane plumbing + a custom control plane (policy, voice routing, domain RAG injection, audit emit, ops UI) as the IP**, branded externally as "our AI Engine." Building the proxy from scratch is commodity work that buyers do not pay for; building the control plane is acquirable IP.

That work lives elsewhere — likely as a separate repo at the day job. Documented here only to disambiguate: when conversation about "AI gateway" comes up in this repo, it means **LiteLLM as a kagent component**, not a built-from-scratch gateway product.
