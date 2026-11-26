# Solo kagent and this kagent, compared

**Date:** 2026-11-26. Dated evidence, not a standing conclusion: check it again before relying on it.
**Replaces** the Solo claims in `AUDIT-2026-05-06.md`, `AUDIT-2026-05-06-rev2.md`, `AUDIT-2026-05-07.md`,
`RENAME-EVALUATION.md`, `PRIOR-ART.md` and the README, which describe Solo kagent v0.9.2 (May 2026).

"Solo kagent" is Solo.io's project (kagent.dev, `kagent-dev/kagent`, CNCF Sandbox). "This kagent" is this repository.
This kagent stays the fleet's harness. The question here is only what each has, and what is worth porting in.

## How this was checked

- Solo versions, dates and licences: `gh api repos/<repo>/releases/latest` and the repo licence field, read 2026-11-26.
- Solo features: the kagent `main` tree (≈ v1.0.1), its 1.0 release notes and architecture docs.
- This kagent: `origin/main` at `e4f74de`, and production values in `ctkadvisors/new_localai`
  `k8s-kustomized/overlays/production/kagent/application.yaml` at `d00f68dd`.
- Nothing from Solo was installed or run.

## What Solo ships

| Piece | Version | Released | Licence | Open or enterprise |
|---|---|---|---|---|
| Solo kagent | v1.0.1 (0.10 line: v0.10.7) | 2026-11-12 (1.0.0 on 2026-11-09) | Apache-2.0 | Open, CNCF Sandbox |
| Agent Substrate (the runtime under 1.0) | v1.0.1 | 2026-11-20 | Apache-2.0 | Open, Google-led, Solo co-maintains |
| agentgateway | v1.7.0 | 2026-10-27 | Apache-2.0 | Open, Linux Foundation |
| agentregistry | v0.4.0 | 2026-08-03 | Apache-2.0 | Open |
| agentevals | v0.15.1 | 2026-11-20 | Apache-2.0 | Open |
| kmcp | v0.4.0 | 2026-09-17 | Apache-2.0 | Open, no longer bundled in 1.0 |
| khook | v0.0.4 | 2025-09-18 | Apache-2.0 | Open, stale |
| Solo Enterprise for Agent Substrate and kagent | none published | GA 2026-11-10 | Commercial | Enterprise |

Solo kagent 1.0 is a re-platform. Each session runs as an actor on Agent Substrate (gVisor or a microVM) instead of
a Deployment. The CRD group moved to `api.kagent.dev/v1alpha3` with eight kinds: `Agent`, `AgentTemplate`, `Harness`,
`EgressPolicy`, `ModelConfig`, `ModelProviderConfig`, `RemoteMCPServer`, `SandboxTemplate`. `SandboxAgent`,
`AgentHarness`, `Memory` and `ToolServer` are gone. There is no in-place upgrade from 0.10.

**Their `Agent` and `AgentTemplate` now share names with ours** (different API group).

## Capability by capability

| Capability | Solo kagent 1.0 | This kagent |
|---|---|---|
| Runtimes | Harness kinds `kagent`, `codex`, `claude`, `byo` | One loop (`packages/agent-loop`), one Job per `AgentTask` |
| Sandbox | Substrate actor per session, suspend and resume from a snapshot | Kata `kata-qemu` for every agent pod; a separate sandbox Job per task for code |
| Checkpoint, fork, resume | Yes | No |
| A2A | Always on, public gateway, AgentCard | No wire protocol; agents use the forum and `spawn_child_task` |
| MCP | `RemoteMCPServer`, per-tool approval | Stdio MCP in the pod, remote MCP through `packages/tool-gateway` |
| LLM gateway | agentgateway: budgets, failover, guardrails, rate limits | `packages/llm-gateway`: AIMD in-flight cap, FIFO admission, failure backoff |
| Tool authorization | Enterprise: on-behalf-of identity | Capability JWT verified on every tool call; `claims.tools` not checked on invoke |
| Schedules | `ScheduledRun`: cron, time zone, manual trigger, history | `KagentSchedule`: cron, idle gate, webhook; missed-tick catch-up and run-now added 2026-11-26 |
| Human in the loop | Pause and resume the exact operation | Review queue; fleet decisions take no human |
| Memory | pgvector memory with TTL, compaction | Fleet memory face, the shared brain over MCP, playbook rules on recall |
| Skills | `AgentTemplate` skills from OCI, Git or S3 | Promoted tools pinned by commit in the fleet catalog; no per-agent skills |
| Evals | agentevals scores OTel spans; none in kagent core | In-loop detectors, a verifier agent, and the fleet authority's release measurements |
| Self-improvement and promotion | Not found (searched the tree for optimi, learn, reflect, feedback, dspy, gepa) | Inventor → verifier → catalog `AgentTemplate`, and proposal → lab → fleet PR → measured release |
| Registry | agentregistry | The fleet catalog in the authority report |
| Observability | OTel GenAI conventions in every harness | OTel to self-hosted Langfuse |
| UI auth | OIDC, principals, RBAC, share tokens | LAN only, forward-auth header |
| CLI | install, apply, agent, sandbox, db | `kagent submit` |

Not verified: whether LangGraph, CrewAI and khook work under Solo 1.0; what Solo's enterprise edition adds beyond
the open source; whether Solo narrows capability from parent to child.

## Mechanisms worth porting into this kagent

In order. Each names the loop step in `NORTH-STAR-SYSTEM-DESIGN.md` §3 and the object it lives in.

1. **Missed-tick catch-up and a manual trigger** (from `ScheduledRun`). Intent, `KagentSchedule`. Shipped 2026-11-26.
2. **Checkpoint and resume of a task** (from Agent Substrate). Work, `AgentTask`. A run that hits its time limit loses its work today.
3. **Evaluation results attached to the trace** (from agentevals). Evidence → Review, the detectors and the verifier verdict.
4. **Skills pinned by commit on the template** (from `AgentTemplate` skills). Promotion → Better Future Work, `AgentTemplate`.
5. **Ask and resume between agents** (from the human-in-the-loop extension, with no human). Review, a forum question on an `AgentTask`.

Not worth porting: a separate `Harness` object, agentgateway (one local model, the AIMD cap fits), OIDC (LAN only).

## What the May documents now get wrong

About Solo kagent:

- "Six CRDs including `SandboxAgent` and `AgentHarness`": both were removed in 1.0.
- "A2A over HTTP through the controller on :8083": there is a public A2A gateway.
- "No SPIFFE": each actor has a SPIFFE identity.
- "Focused on cluster operations, a different problem domain": it is a general agent runtime that overlaps this one.

About this kagent:

- Kata "planned": it is the default for every agent pod.
- NATS event bus, A2A bus and audit marked as shipped: NATS is not deployed in production and audit is off.
- "The gateway is LiteLLM Proxy": it is `packages/llm-gateway`.
- "Running on Cloudflare AI Gateway and Workers AI": production runs local models on the Spark and a Jetson, plus one OpenCode Go endpoint.
- "The tool gateway authenticates nothing": it verifies the capability JWT. The `claims.tools` gap is still open.
- "Code execution runs on the gateway-local runner": it runs in a per-task sandbox Job.
- `Workspace` and `AgentCapability` CRDs "planned": both exist.
