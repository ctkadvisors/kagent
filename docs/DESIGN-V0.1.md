# kagent — v0.1 Design

**Date:** 2026-04-26
**Status:** Draft, pre-implementation
**License:** MIT

> Read [`WHY.md`](./WHY.md) first if you have not. This document presupposes the *why* and answers the *what*.

---

## 1. Premise

The OSS / K3s ecosystem ships every component to assemble a per-agent-microVM substrate (Kata Containers, NATS JetStream, Bun, LiteLLM, Langfuse, K8s operator patterns) but nobody has wired them. AWS AgentCore, Cloudflare Agents + Sandbox, and Anthropic Managed Agents are the proprietary equivalents. `kagent` is the composition.

The AgentExecutor implementation built in `@ctkadvisors/agent-runtime` is reusable as the inner loop of a single agent pod, not as a freestanding governance primitive.

## 2. Success metric

**Autonomous-uptime ÷ failure-rate.** Concretely: the same 5-topic researcher workload `homelab-orchestrator` runs today, plus a 2-agent delegation chain demo (researcher → summarizer), running on the new substrate, with the same or better completion rate and equal or lower median run cost.

v0.1 ships when:
- An `AgentTask` CRD applied to the cluster causes a Pod to spawn, run an agent loop against any OpenAI-compatible LLM endpoint (via LiteLLM), and write a result back to the CRD's status — without a CronJob, without `homelab-orchestrator`'s runner.
- A second agent, addressed by capability tag through NATS, can be invoked from the first agent mid-loop and returns a structured result.
- Every iteration's trace is queryable in self-hosted Langfuse with cost attribution.

## 3. Architecture

```
[CLI / kubectl / future Operator UI]
        ↓ (creates AgentTask CRD)
[Control Plane: Operator (Bun, TS, @kubernetes/client-node watchers)]
   - CRDs: Agent, AgentTask, AgentCapability
   - Reconcile: AgentTask → Pod (Job for ephemeral) → wait for NATS completion → status update
        ↓
[NATS JetStream — A2A bus + queue + capability index]
   - Subjects: agent.<id>.task.<taskId>, agent.cap.<cap>.task.<taskId>, agent.<id>.event.<seq>
   - KV bucket for live agent → capabilities map (heartbeat-expiring)
        ↓
[Agent Pod (Bun image, ~50MB)]
   - @kagent/agent-loop  (forked AgentExecutor + RunBudget + sinks)
   - Subscribes to its NATS subject for inbound tasks
   - Publishes delegation requests to other agents' subjects
   - Streams trace via OTel exporter
        ↓ (model calls)
[LiteLLM Proxy (Helm) → Ollama jetson1 / CF AI Gateway / Bedrock / on-prem]
        ↓ (trace events)
[Langfuse self-hosted (Helm)]
```

## 4. Components — concrete picks

### 4.1 Control plane (operator)

- **Bun + TypeScript + `@kubernetes/client-node`.** Watch loops on `AgentTask` events. No Kubebuilder/operator-sdk (Go-shaped); a hand-rolled controller in TS keeps the surface small and language-aligned.
- **CRDs (v0.1 minimal):**
  - `Agent` — `model`, `systemPrompt`, `tools[]`, `capabilities[]`, `sandboxProfile` (`default` | `strict`)
  - `AgentTask` — `targetAgent` *or* `targetCapability`, `payload`, `timeoutSeconds`, `parentTask?` (delegation chain)
  - `AgentCapability` — capability tag → matcher rules (defer until v0.2 if not needed)
- **Reconcile loop:** `AgentTask` Created → resolve target Agent → create Job (one Pod) with downward API mounting Agent definition → publish `agent.<id>.task.<taskId>` on NATS → watch for completion event → write `result` to AgentTask status → garbage-collect Pod.
- **No leader election** in v0.1 (single replica); add in v0.2 if multi-replica becomes useful.

### 4.2 Agent runtime (in-pod)

- **Fork `@ctkadvisors/agent-runtime`'s AgentExecutor as `@kagent/agent-loop`.** Lift: `executor.ts`, `RunBudget`, `JsonlSink`, OpenAI-compat client, `ToolProvider` abstraction, the F1/F2/F3 detectors, refusal detection, synthesis-vacuity heuristic. Drop: governance/Sempf framing in docs, the freestanding-process assumption.
- **Bun image:** `oven/bun:alpine` base + agent-loop dist + agent definition mounted via downward API as JSON. Approx 50MB image, ~40MB RSS at idle.
- **Lifecycle:**
  1. Pod boots, reads Agent definition + AgentTask payload from env/mount.
  2. Connects to NATS, subscribes to its task subject.
  3. Connects to LiteLLM via its `OPENAI_BASE_URL`.
  4. Configures OTel exporter pointing at Langfuse.
  5. Runs the loop. On any `delegate_to_capability(cap, payload)` tool call, publishes to `agent.cap.<cap>.task.<newId>`, awaits result via reply-subject pattern.
  6. Publishes final result to its task's reply subject; exits.

### 4.3 A2A bus

- **NATS JetStream** (Helm chart `nats-io/nats`). JetStream gives durable streams so a pod death doesn't lose in-flight delegations.
- **Subject taxonomy:**
  - `agent.<agentId>.task.<taskId>` — direct addressing
  - `agent.cap.<capability>.task.<taskId>` — capability-routed (queue-group fan-in across matching subscribers)
  - `agent.<agentId>.event.<seq>` — heartbeat / lifecycle events
- **KV bucket `agents-live`** — `(agentId → {capabilities, lastHeartbeat})`. Stale entries drop on heartbeat timeout. Operator reads this for capability resolution.
- **Single-node v0.1.** JetStream cluster mode is v0.2 if HA matters.

### 4.4 Sandbox layer

- **v0.1: default `runc`.** Ship without Kata to reduce v0.1 risk. Pods are still namespace-isolated; this just isn't microVM-grade.
- **v0.2: Kata Containers as a `RuntimeClass`** (`kata` runtime added to K3s nodes via the Kata K8s deployer). Set `runtimeClassName: kata` on Agent Pod spec when `sandboxProfile: strict`. ~30MB overhead per pod, ~1s additional spawn.
- **For untrusted-code-exec inside an agent (CF Sandbox analog):** out of scope v0.1. Eventual answer is nested isolation — Agent runs in Kata pod, plus a sub-process sandboxed via Bubblewrap for code-exec tools, OR a separately-managed Firecracker pool the agent dispatches to.

### 4.5 Model gateway

- **LiteLLM Proxy** (Helm chart, MIT). Postgres-backed for virtual keys + cost tracking. Routes:
  - `ollama` → jetson1 bare-metal (`http://192.168.68.73:11434/v1`) or any other Ollama
  - `cf-gateway` → Cloudflare AI Gateway compat endpoint
  - `bedrock` → AWS Bedrock (when creds wired)
  - `on-prem-*` → registered custom OpenAI-compat endpoints when on-prem GPU comes online
- Agents speak OpenAI-compat to LiteLLM, ignorant of backend. Per-call model selection via the standard `model` field with provider prefix (e.g., `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`).

### 4.6 Observability

- **Langfuse self-hosted** (Helm chart). All trace events from `@kagent/agent-loop` go via OTel exporter. Cost is in the trace via LiteLLM tagging.
- **Retire** the JSONL-on-PVC sink and `orchestrator.knuteson.io` viewer once Langfuse is ingesting reliably. Keep `JsonlSink` in `@kagent/agent-loop` as a debug-mode option (env-flag).

## 5. v0.1 scope (4–6 weeks)

### In scope

| # | Item | Est |
|---|---|---|
| 1 | CRD definitions + Operator skeleton (Bun, TS, k8s client) | 1 week |
| 2 | NATS JetStream Helm wiring + KV bucket setup | 0.5 week |
| 3 | `@kagent/agent-loop` library forked from agent-runtime | 0.5 week |
| 4 | Agent Pod base image (Bun + agent-loop) | 0.5 week |
| 5 | E2E: AgentTask CRD → Pod spawned → loop runs → result returned | 1 week |
| 6 | LiteLLM + Langfuse Helm charts deployed and wired | 0.5 week |
| 7 | Port researcher agent → produces same daily digest on new substrate | 1 week |
| 8 | A2A demo: researcher delegates to summarizer specialist via NATS | 0.5 week |

### Out of scope (deferred — see [`ROADMAP.md`](./ROADMAP.md))

- **Kata Containers runtime** — v0.2
- **Warm pool / StatefulSet** — only Job-per-task in v0.1; v0.2 if cold-start measures bad
- **Operator UI** — `kubectl` + Langfuse UI sufficient for v0.1
- **Authority graph / OPA policy enforcement** — may never ship if no concrete need
- **Multi-tenant / namespace isolation** beyond k8s defaults
- **Session persistence across pod restarts** — Restate adapter is v0.3
- **Streaming responses** — batch only
- **Pre-dispatch hooks** — A2A delegation IS the steering surface for now

## 6. Migration path for existing investments

| Existing | Becomes |
|---|---|
| `@ctkadvisors/agent-runtime` package | `@kagent/agent-loop` thin library used inside Agent pods. Governance/Sempf docs retired. ~70% of TS survives. |
| `homelab-orchestrator` | First consumer. Current CronJob + runner disappears; replaced by a thin K8s CronJob that templates and `kubectl apply`s an `AgentTask` CRD per topic per day. The repo becomes topics + Agent CRD definitions, not a runtime. |
| Chat UI (`agent.knuteson.io`) | Either retired in favor of Langfuse + a thin chat client targeting kagent's API, OR migrated as a UI for AgentTask submission. Decide post-v0.1. |
| F1/F2/F3 detectors, refusal detection, synthesis-vacuity heuristic | Lift into `@kagent/agent-loop` as run-end middleware. They earn their keep at the loop boundary regardless of substrate. |
| JSONL trace + viewer | Retire. Langfuse subsumes. `JsonlSink` stays in `agent-loop` as debug-mode option. |
| `WHY-NOT-X.md` / GAP-VS-* docs in `homelab-orchestrator/docs/` | Source material for [`PRIOR-ART.md`](./PRIOR-ART.md). The originals stay in `homelab-orchestrator` for posterity (reasoning trail). |

## 7. Risks

- **TS operator quality.** TS k8s operators are less battle-tested than Go. Risk: race conditions in watch loops. Mitigation: keep reconcile logic minimal in v0.1; lean on K8s status conditions; add integration tests against a kind cluster.
- **NATS operational surface.** Another thing to monitor. Mitigation: Helm chart with sane defaults; single node v0.1; wire Langfuse alerts on heartbeat-bucket churn.
- **Cold start ~1s on Job-per-task.** Too slow for chat-style interactive workloads. v0.1 is batch-only; v0.2 adds warm pool when measured latency is the constraint.
- **Strands TS / Mastra catch up before v0.1 ships.** Either could announce a "k3s-native operator + sandbox primitives" surface. Mitigation: ship fast (4–6 weeks); if upstream catches up, retire substrate and adopt.
- **Anthropic ships Managed Agents on-prem.** Possible but unlikely (their business model is hosted). Even if they do, OSS substrate is still needed for non-Claude workloads.
- **v0.1 thesis fails — failure rate doesn't improve over `homelab-orchestrator`.** Honest fail-state. Mitigation: define the comparison rig before starting (run the existing 5-topic workload through both substrates for one week, compare cost + completion + median latency). If new substrate is no better, the work was scaffolding for v0.2 (Kata + warm pool + framework swap), not a final answer.

## 8. What this spec does NOT cover

- Day-job AI gateway design (separate decision; recommendation is thin policy layer over LiteLLM, not a custom gateway).
- Hardware procurement for M5 Max / DGX (independent decision; agent farm runs on whatever hardware K3s sees).
- The chat UI's eventual fate (deferred — substrate ships first; UI choice follows).
- Authentication / authz / multi-tenant beyond K8s namespace defaults.

## 9. Open decisions

1. **Pod runtime debate revisited at v0.2.** v0.1 uses forked AgentExecutor. v0.2 evaluate Mastra or Strands TS adoption empirically — does swapping the in-pod loop materially change failure-rate? If yes, swap. If not, stay.
2. **Repo public-release name.** `kagent` for internal use; pre-public-release evaluate rename to avoid collision with kagent.dev (Solo.io's K8s-ops-agent project). Candidates: `agentforge`, `kfarm`, `agentpod`, `podforge`.
