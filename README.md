# kagent

> Kubernetes-native multi-agent substrate. MIT-licensed. Single-author homelab origin.
> **Status:** v0.1 RC line on `main` (`v0.1.9-rc.2`). Live on a 3-node K3s homelab; smoke-tested against Cloudflare AI Gateway + Workers AI.

## TL;DR for peer review

`kagent` is an opinionated implementation of the agent-substrate primitives that AWS AgentCore, Cloudflare Agents+Sandbox, and Anthropic Managed Agents ship as proprietary services — built as a thin **Kubernetes operator + per-agent Job runtime** that composes existing OSS (Kata Containers / NATS JetStream / LiteLLM / Langfuse / `kubernetes-sigs/agent-sandbox`) rather than reinventing any of those layers.

The distinctive value is **two narrow primitives that the surveyed OSS+proprietary landscape does not ship together** (see [§Defensible scope](#defensible-scope-the-three-primitives) below):

1. **Substrate-thin context-pressure handling** — pre-call refusal at 95% context, agent-side `get_my_context` introspection tool, run-end `context_pressure_ignored` detector.
2. **Sealed-JWT capability narrowing on child spawn** — substrate-enforced `child.claims ⊆ parent.claims`, signed by the operator's CA.
3. **Workbench Command Center** — RTS-style live spatial visualization of the cluster as agents-as-buildings, tasks-as-units (Tier-0 shipped in `v0.1.9-rc.2`).

Everything else (CRDs, NATS A2A bus, OTel→Langfuse traces, capability-tier model routing, AIMD-tuned gateway, Helm-managed deploy, ArgoCD-driven GitOps) is table stakes once you commit to the Kubernetes-native path.

**This README is written to be handed to peer principal engineers for a go/no-go review.** What I'm asking for is at the bottom in [§The decision being asked](#the-decision-being-asked).

---

## What kagent is, in one paragraph

A Kubernetes operator that watches `Agent` and `AgentTask` CRDs and materializes a per-task Job whose Pod runs `@kagent/agent-pod` — a thin wrapper around an in-pod agent loop (`@kagent/agent-loop`, lifted from a prior learning experiment, framework-agnostic) that speaks OpenAI-compat to a self-hosted LiteLLM-shaped gateway, emits OTel spans to Langfuse, mints capability-narrowed JWTs when the agent uses the substrate's built-in `spawn_child_task` tool, and patches the AgentTask status when it terminates. NATS JetStream provides the A2A messaging layer for agent-to-agent discovery + dispatch. CRDs, RBAC, and Helm charts ship as a single operator chart.

**One agent = one Pod.** No persistent agent processes, no shared interpreter, no co-tenancy. AgentTask reaches a terminal phase and the Pod exits. v0.2 introduces warm pools.

---

## What's actually shipped (`v0.1.9-rc.2`)

The list below is "in the cluster, executing real work, observable in evidence packs" — not "designed in a doc."

### Substrate layer

- ✅ `Agent`, `AgentTask`, `AgentCapability`, `ModelEndpoint`, `AgentTemplate`, `Tenant` CRDs in API group `kagent.knuteson.io/v1alpha1`.
- ✅ Operator (TypeScript, `@kubernetes/client-node`) reconciling AgentTask → Job with cluster-wide informer, ownerRef chain, idempotency cache, supervision-router escalation depth, restarter with cap + reset on success.
- ✅ Per-Agent micro-isolation via `agentPod.runtimeClasses.strict` — strict-profile Agents land on a configurable `RuntimeClass` (Kata is the canonical pick when nodes ship with Kata).
- ✅ Capability JWTs minted by the operator's cap-issuer (CA-signed), consumed by the agent-pod's cap-consumer, narrowed at every `spawn_child_task` boundary, claims set carried through child run + audit stamps.
- ✅ NATS JetStream dispatcher + KV-backed `agents-live` capability registry (publish path; in-pod subscription deferred to v0.2 — task assignment is via env, status patch is via K8s API).
- ✅ Sandbox profiles (`default`, `strict`) wired through the Pod spec.

### Inference + observability

- ✅ LLM Gateway (`@kagent/llm-gateway`) — OpenAI-compat proxy with AIMD in-flight cap per ModelEndpoint, per-backend API key fan-out, structured usage events to a Postgres backend, admin surface (`/admin/*`) consumed by the workbench's `#/gateway` page.
- ✅ Cloudflare AI Gateway integration via the OpenAI-compat `/compat` endpoint — `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct` and `workers-ai/@cf/meta/llama-3.3-70b-instruct` wired as ModelEndpoint CRs against the homelab's CF gateway.
- ✅ Langfuse-native OTel trace export (`@kagent/trace-sinks` `OtelTraceSink`) — gen_ai semconv + Langfuse-flavored attrs so spans render as Generations/Tools in the UI.
- ✅ Structured run-end detectors: `f1_orchestration_lock`, `f2_synthesis_vacuity`, `f3_truncated_synthesis`, `refusal`, `context_pressure_ignored`, `usage_source` markers for token-usage provenance.

### Agent-side primitives

- ✅ AgentExecutor loop (`@kagent/agent-loop` + `@kagent/agent-loop-vercel-ai` reference adapter on Vercel AI SDK).
- ✅ Built-in tools: `spawn_child_task`, `write_artifact`, `get_my_context`, `ensure_agent_from_template`.
- ✅ `Agent.spec.modelClass` logical-tier routing — decouples Agent CR from physical model id (`tool-caller-default`, `text-generator-default`, `reasoner-default` map to physical models in the cluster's chart values).
- ✅ Per-attempt latency-accurate retry with 429 + Retry-After honoring on the agent-pod side; AIMD doesn't have to drop the protective floor for bursty fan-outs.

### Visibility / operations

- ✅ **Workbench** at `https://kagent.knuteson.io/` — read-only React/Vite SPA over a thin Hono API serving `/api/{tasks,agents,gateway/*,cluster/*,stream}`. Deep-links to Langfuse on every task. Live SSE refresh.
- ✅ **Workbench Command Center at `#/command`** (Tier-0, shipped in this RC) — canvas-rendered RTS-style overview: gateway as central HQ hexagon, agents as rectangular buildings in faction rings (one per namespace), tasks as colored sprites traveling on belts between gateway and target agent, top HUD with token/min + in-flight tickers, bottom-left activity log, right-side selection panel. Vanilla HTML5 canvas + RAF, no game-engine deps.
- ✅ **Two evidence rigs** as ArgoCD Applications under `examples/`:
  - `examples/rc-pilot/` — the GA-evidence checklist scenarios (happy path, forced timeout, pod-boot fail, delegation, artifact producer, gated verifier, policy cap, audit stamps). Cross-referenced to `docs/GA-EVIDENCE-CHECKLIST.md`.
  - `examples/rc-spectrum/` — wider task spectrum (deep researcher, code generator, 4-pass long-running, head-to-head model A/B on scout vs llama-3.3-70b, cross-model fanout). Spans two CF AI Gateway models.
- ✅ One-shot evidence-collector Jobs that tar a workbench projection of every scenario's status to stdout: `kubectl logs job/rc-{pilot,spectrum}-evidence-collector | tar xv`.

### What's NOT shipped (and where it lives on the roadmap)

- ❌ Streaming responses (substrate is fire-and-forget; v0.2).
- ❌ Warm pools (v0.2).
- ❌ In-pod NATS subscription / streaming-cancel (v0.2 — currently env-injection at Job spec time).
- ❌ Agent CR write surface from the workbench ("construction mode" — Tier-2 of the Command Center; gated on forward-auth wiring before write-RBAC ships).
- ❌ Production model gateway as a kagent-bundled offering (LiteLLM Proxy is a pluggable companion; the project does not ship its own).
- ❌ Bedrock / OpenAI / Anthropic backend wiring (only Workers AI + Ollama exercised; the pluggable contract is there, the API keys are not).
- ❌ Cluster-wide policy engine integrations (OPA / Kyverno are companions, explicitly out of scope per `docs/SUBSTRATE-V1.md` §8).

---

## Defensible scope: the three primitives

The competitive landscape (next section) means the question isn't "is this useful," it's "is this useful *that the alternatives don't already do*." Three answers:

### 1. Substrate-thin context-pressure handling

Most agent frameworks (LangGraph, CrewAI, Strands TS, AutoGen) do not have a substrate-level concept of "this context window is at 95%, refuse before the model does." They treat token budgeting as an application concern. kagent's agent-pod implements pre-call refusal at a configurable threshold (default 95%), exposes `get_my_context` so the agent itself can introspect remaining budget mid-loop, and a run-end detector flags `context_pressure_ignored` if the agent kept emitting tool calls past the threshold. The trace + audit stamps carry it through to the workbench so reviewers see it.

Why it matters: lifecycle-stage failure modes (F1/F2/F3 from `docs/HARNESS-LESSONS.md`) cluster around context exhaustion, and treating it as a runtime concern rather than an SDK concern means it works regardless of which framework the in-pod agent uses. **Status:** shipped in `v0.1.9-rc.2` (commits `73f67f4`, `fb549c0`, `fc32b13`; review under `evidence/audit-rev2/R1.md` §3).

### 2. Sealed-JWT capability narrowing on child spawn

When an agent uses `spawn_child_task`, the operator's cap-issuer mints a JWT for the child whose claims are the **intersection** of the parent's claims and the per-child explicit grant. The agent-pod's cap-consumer enforces it on every tool call. This means a parent agent with `tools: [search, write_artifact]` cannot create a child with `tools: [shell]` even by lying — the JWT signature is rejected.

The OSS landscape (Solo.io kagent.dev v0.9.x, kubernetes-sigs/agent-sandbox v0.4.5) has Agent isolation but does not have substrate-enforced **capability narrowing across the parent/child boundary**. AWS AgentCore has a related primitive ("on-behalf-of" identity) at the proprietary level. Anthropic Managed Agents and CF Agents+Sandbox have neither.

**Status:** shipped (`packages/operator/src/cap-issuer.ts`, `packages/agent-pod/src/cap-consumer.ts`; review under `evidence/audit-rev2/R1.md` §1).

### 3. Workbench Command Center (RTS overview)

Spatial-canvas live visualization of agents-as-structures, tasks-as-units, ModelEndpoints-as-resource-bars. The substrate is graph-shaped (parent/child fanout, gateway routing, per-tenant tenancy); existing dashboards flatten it into tables, which fights the mental model. Tier-0 shipped here (`v0.1.9-rc.2`); Tier-1 promotes to default landing with pan/zoom + minimap; Tier-2 ("construction mode": drag-drop new agents → write Agent CRs from the canvas) is gated on forward-auth.

**Status:** Tier-0 shipped. Tier-1+ planned but not on the v0.1 ship-line.

---

## Competitive landscape — the question peers actually need to answer

The peer review framing is "adopt this, adopt the official sandbox set, or go another way." Here's the honest comparison:

### vs `kubernetes-sigs/agent-sandbox` (the official answer)

| | `agent-sandbox` v0.4.5 | kagent |
|---|---|---|
| Per-agent Pod isolation | ✅ via `Sandbox` CRD | ✅ via `agentPod.runtimeClasses.strict` |
| Kubernetes-native | ✅ | ✅ |
| Capability narrowing across spawn | ❌ | ✅ |
| Substrate context-pressure handling | ❌ | ✅ |
| Built-in observability (Langfuse OTel) | ❌ (you wire it) | ✅ default-on |
| Built-in gateway (AIMD, capacity bounds) | ❌ | ✅ `@kagent/llm-gateway` |
| RTS Command Center | ❌ | ✅ Tier-0 |
| Production hardening (audit stamps, supervision, key rotation) | partial | ✅ shipped |
| Workbench / read surface | ❌ | ✅ |
| Author count | many (sigs project) | 1 (single-author homelab) |
| Battle-tested at scale | partial | ❌ (homelab only) |

**The honest answer:** if you only need per-Pod agent isolation as a building block, `agent-sandbox` is the right thing — it's the upstream sigs project, has a real maintainer team, and you can bring your own observability + gateway. kagent makes sense if you want the *opinionated full stack* including capability narrowing, context-pressure semantics, and the workbench — knowing the maintenance bus factor is 1.

A possible middle ground: kagent could refactor to *consume* `kubernetes-sigs/agent-sandbox` for the isolation primitive and keep the three distinctive primitives on top. This is documented as `docs/UPSTREAM-DIFF-AGENT-SANDBOX.md` and is a viable path forward.

### vs Solo.io [`kagent.dev`](https://kagent.dev) (name collision, different problem)

Solo.io's kagent.dev is an autonomous **K8s-operating** agent — an AI that troubleshoots clusters. **Different problem domain.** Their v0.9.x consumes `kubernetes-sigs/agent-sandbox` for the isolation layer. Pre-public-release, this kagent (the homelab project) will need to rename to avoid collision — candidates in `docs/RENAME-EVALUATION.md`: `agentforge`, `kfarm`, `agentpod`, `podforge`. **Not blocking the technical evaluation.**

### vs proprietary substrates

| | AWS AgentCore | Anthropic Managed Agents | Cloudflare Agents+Sandbox | kagent |
|---|---|---|---|---|
| OSS | ❌ | ❌ | partial (Agents SDK is) | ✅ MIT |
| Per-agent isolation | ✅ (Firecracker) | ✅ | ✅ (V8 + Sandbox) | ✅ (Kata-capable) |
| Capability narrowing | ✅ (OBO) | ❌ | ❌ | ✅ |
| Context-pressure substrate | ❌ (SDK concern) | ❌ (SDK concern) | ❌ (SDK concern) | ✅ |
| Bring your own model | partial (Bedrock-mediated) | ❌ (Anthropic only) | ✅ | ✅ |
| Run on a homelab K3s | ❌ | ❌ | ❌ | ✅ |
| Lock-in posture | Strong | Total | Moderate | None (MIT, runs anywhere) |

**The honest answer:** if you're cloud-only and the lock-in is acceptable, those substrates are stronger on operational maturity. kagent's pitch is portability + transparency + the three distinctive primitives.

### vs framework-layer multi-agent (LangGraph / CrewAI / AutoGen / Strands TS / Mastra)

**Different layer.** Those frameworks define agent topologies (graphs, hierarchies, swarms) inside a single Python or Node process. kagent is the *pod substrate* under any of those — your LangGraph `StateGraph` runs *inside* a kagent agent-pod that the operator scheduled. They compose. Per `docs/PRIOR-ART.md` audit (2026-05-06), Mastra is the closest substrate-shaped peer; the rest are framework-shaped.

---

## Reading order (deeper dive)

For a peer doing a real evaluation:

1. [`docs/WHY.md`](./docs/WHY.md) — the strategic case + the kernel-pivot retrospective (single biggest historical mistake on this codebase).
2. [`docs/DESIGN-V0.1.md`](./docs/DESIGN-V0.1.md) — v0.1 architecture spec.
3. [`docs/SUBSTRATE-V1.md`](./docs/SUBSTRATE-V1.md) — the v1 primitive set (what reaches production).
4. [`docs/UPSTREAM-DIFF-AGENT-SANDBOX.md`](./docs/UPSTREAM-DIFF-AGENT-SANDBOX.md) — concrete diff vs the sigs project; pivotal for the "should we just use the official thing" question.
5. [`docs/V0.1-COMPARISON.md`](./docs/V0.1-COMPARISON.md) — falsifiable comparison rig methodology vs the prior `homelab-orchestrator`.
6. [`docs/PRIOR-ART.md`](./docs/PRIOR-ART.md) + [`docs/AUDIT-2026-05-06.md`](./docs/AUDIT-2026-05-06.md) — landscape audit.
7. [`docs/HARNESS-LESSONS.md`](./docs/HARNESS-LESSONS.md) — the model-failure-mode evidence that justified the substrate-level primitives.
8. [`docs/RFC-CAPABILITY-NARROWING.md`](./docs/RFC-CAPABILITY-NARROWING.md) — the capability-narrowing primitive's threat model + protocol.
9. [`docs/CONTEXT-PRESSURE-PRIMITIVE.md`](./docs/CONTEXT-PRESSURE-PRIMITIVE.md) — context-pressure primitive design.
10. [`docs/ROADMAP.md`](./docs/ROADMAP.md) — phasing through v1.0; falsifiable success criterion at the bottom.
11. [`evidence/rc1/`](./evidence/) — actual RC-pilot evidence pack as a baseline of what "executes real work" means in this repo.

For the workbench specifically: [`docs/WORKBENCH.md`](./docs/WORKBENCH.md) and `packages/workbench-ui/src/CommandView.tsx` for the Command Center reference implementation.

---

## Quickstart (homelab K3s, ~10 minutes)

```sh
# 1. Bring up K3s + Traefik + cert-manager + ArgoCD via the standard homelab path
#    (or any K8s 1.27+ cluster with an Ingress controller). Worked example:
#    https://github.com/ctkadvisors/new_localai

# 2. Install the operator chart. ArgoCD-driven path:
kubectl apply -f https://raw.githubusercontent.com/ctkadvisors/new_localai/main/k8s-kustomized/overlays/production/kagent/application.yaml

# 3. (Optional) Apply the rc-pilot or rc-spectrum scenario bundle:
kubectl apply -k examples/rc-spectrum/

# 4. Watch the cluster react in the Workbench:
#    https://<your-cluster>.example/#/command   <- the RTS Command Center
#    https://<your-cluster>.example/#/          <- the per-task list

# 5. Pull an evidence pack to stdout (as tar):
kubectl logs -n kagent-system job/rc-spectrum-evidence-collector | tar xv -C ./evidence/spectrum1
```

For a pure local kind cluster: `pnpm i && pnpm -r build && pnpm -F @kagent/operator helm:smoke` — the chart's smoke-test target installs the operator + a single AgentTask + a verification Job that asserts terminal phase.

---

## Repository layout

```
.
├── packages/                     <- 27 TypeScript workspace packages (pnpm)
│   ├── operator/                 <- the K8s operator + Helm charts
│   ├── agent-pod/                <- in-pod runtime (built-in tools, cap-consumer, runner)
│   ├── agent-loop/               <- AgentExecutor + detectors + middleware
│   ├── agent-loop-vercel-ai/     <- reference adapter on Vercel AI SDK (proves any-framework-in-pod)
│   ├── llm-gateway/              <- OpenAI-compat gateway with AIMD + admin surface
│   ├── workbench-{api,ui}/       <- read-only operator console (with #/command RTS view)
│   ├── trace-sinks/              <- OtelTraceSink for Langfuse-native export
│   ├── capability-types/         <- shared cap-JWT shape across operator + agent-pod
│   └── ... 19 more (controllers, providers, supervision, supervision-router, etc.)
├── examples/
│   ├── rc-pilot/                 <- GA evidence checklist (8 scenarios)
│   └── rc-spectrum/              <- wider task spectrum (6 scenarios, 2 CF gateway models)
├── docs/                         <- 40+ design + audit + RFC documents
└── evidence/                     <- captured workbench evidence packs
```

The operator runtime (currently Node 22 + tsx) was originally targeted at Bun, but Bun 1.1's TLS handling rejects K3s's self-signed CA on `@kubernetes/client-node`'s Watch + status-PATCH paths. Bun revert is on the v0.2 list once the undici/TLS parity gap closes.

---

## Risks + open questions named explicitly

The peer review wouldn't be honest without these:

1. **Bus factor = 1.** Single-author homelab project. `kubernetes-sigs/agent-sandbox` has a sigs-team behind it. This is the strongest argument *against* adopting kagent over the official path.
2. **Battle-tested at scale = no.** Runs on a 3-node K3s homelab with tens of concurrent tasks. Has not been exercised at hundreds of agents, multi-cluster, or with adversarial workloads.
3. **The two distinctive primitives might not be load-bearing for your use case.** If you don't need capability narrowing across a parent/child agent boundary, that primitive is dead weight. Same for context-pressure handling if your workload is short-context.
4. **Name collision** with Solo.io's kagent.dev. Rename TBD before any wider release.
5. **The defensible scope claim is bounded by `docs/PRIOR-ART.md` audit dates** (2026-05-06 / 2026-05-07). Both the sigs project and the proprietary substrates are moving; what's distinctive today may not be in 6 months.
6. **Comparison rig is not yet executed.** [`docs/ROADMAP.md`](./docs/ROADMAP.md) §"Comparison rig — the falsifiable test" commits the project to a no-regression measurement vs the prior `homelab-orchestrator`. That hasn't run end-to-end yet. Until it does, the substrate's claim of "improving on the baseline" is theoretical.
7. **`@kagent/agent-loop` is lifted from a learning experiment.** It works, but it's not a "third-party-validated" agent loop. Vercel AI SDK adapter (`@kagent/agent-loop-vercel-ai`) exists specifically so the in-pod runtime is replaceable.

---

## The decision being asked

This README exists to seek a directional decision from peer principal engineers. Three plausible paths:

| Path | When this is right | What changes |
|---|---|---|
| **A. Adopt kagent as-is** | The three distinctive primitives are load-bearing for your workload AND you can absorb the bus-factor-of-1 risk. | Use the operator chart from this repo; consume Workers AI / OpenAI / Anthropic via LiteLLM; ship workloads. |
| **B. Adopt `kubernetes-sigs/agent-sandbox` instead** | You only need per-Pod isolation; you can wire your own observability + gateway; you want the sigs project's bus factor. | Use the official sandbox; carry forward kagent's three distinctive primitives as PRs upstream OR as separate components. The `docs/UPSTREAM-DIFF-AGENT-SANDBOX.md` is the start of this analysis. |
| **C. Refactor kagent to consume `agent-sandbox`** | Both the distinctive primitives AND the official isolation primitive matter. Best of both, but more work to maintain compatibility. | kagent becomes a thin layer atop `agent-sandbox` that adds: cap-narrowing, context-pressure handling, command-center UI. |

**What I'd find most useful from a reviewer:**

- Your read on whether the three distinctive primitives [(§Defensible scope)](#defensible-scope-the-three-primitives) actually constitute load-bearing differentiation for *your* deployment context, or whether they're solving a problem you don't have.
- Your read on the vs-`agent-sandbox` table — am I being fair to the upstream project, or am I oversimplifying their roadmap?
- Whether path C (refactor to consume `agent-sandbox`) is a better strategic bet than maintaining a parallel isolation layer.
- Anything in [§Risks](#risks--open-questions-named-explicitly) that I'm under-weighting.

PRs welcome on the README itself, especially around any technical claim you find unsubstantiated.

---

## License

MIT — see [`LICENSE`](./LICENSE). Every `.ts` source file carries an SPDX header; CI enforces.

## Contact

`chris@ctkadvisors.net` — single author, single point of contact. Issue tracker: GitHub Issues on this repo.
