# Platform Priorities

**Date:** 2026-04-27
**Status:** Priority spine for Phase 4.x → Phase 5
**Purpose:** collapse the design fan-out into an implementation order.

`kagent` is becoming a Kubernetes-native agent execution fabric:
durable task state, ephemeral execution pods, isolated tools, artifacts,
and traces. The highest leverage next step is not adding more channels.
It is making the engine visible and operable while preserving the
same primitives for GUI, CLI, GitOps, webhooks, scheduled jobs, and
future chat clients.

## 1. Current substrate

Already proven on the homelab K3s cluster:

- `AgentTask` is the unit of work.
- `Agent` is the declarative execution profile.
- Operator materializes one Job per task.
- Agent pod runs the loop against an OpenAI-compatible endpoint.
- Agent pod patches `AgentTask.status`.
- Job/Pod failure reflection and deadlines protect against stuck tasks.
- OTel/Langfuse and local trace sinks are the evidence path.

Still intentionally incomplete:

- Tool wiring from `Agent.spec.tools`.
- Durable parent/child task graph.
- Artifact store.
- Policy-managed browser/code/git tools.
- Agent templates for controlled on-demand specialists.
- Replay/eval harness.
- Workbench/console visibility surface.

## 2. Priority order

### P0 — Keep the smoke test boring

Do not expand the platform while the deployment loop is fragile.

Done or effectively landed:

- Runtime switched to Node 22 + tsx for K3s TLS parity.
- Status patches use merge-patch content type.
- Agent pod image pull policy is plumbed.
- AgentTask timeout maps to both `AbortSignal.timeout` and Job
  `activeDeadlineSeconds`.
- Job/Pod failure states reflect back to `AgentTask.status`.
- Smoke-test resources rerun predictably under Argo.

Remaining P0 work:

- Verify `helm template` in CI or a local dev toolchain.
- Keep the workbench/operator image-build path on ghcr.io documented
  alongside chart defaults (see `packages/workbench-api/IMAGE-BUILD-NOTES.md`).
- Keep Phase 4 smoke green after every operator/runtime change.

### P1 — Build visibility before complexity

Add a read-only Workbench/Console before adding browser/code sandbox
workflows. It should expose what already exists:

- task list and task detail
- Job/Pod status and failure reasons
- parent/child relationships when present
- trace links and detector flags
- artifact references when artifacts land
- Agent catalog

This is a client of the platform, not the platform itself. A task that
works through the Workbench must also work through YAML, CLI, webhook,
or another agent.

Design doc: [`WORKBENCH.md`](./WORKBENCH.md).

### P2 — Wire tools minimally for the first real workload

Phase 5 cannot run the researcher workload until `Agent.spec.tools`
actually configures the agent pod's `ToolProvider`s.

First slice:

- support a small in-process tool bundle for the researcher
- support HTTP fetch / RSS fetch / extract text
- keep browser and code execution out until policy exists
- surface tool names in traces and status errors

Do not build a generalized policy engine in this slice; make the
existing `tools[]` field real enough for Candidate A.

Related design doc: [`TOOL-BROKER.md`](./TOOL-BROKER.md).

### P3 — Add artifact references, not a giant artifact system

The first real workflow needs outputs bigger and richer than
`status.result.content`, but the CRD should not become an object store.

First slice:

- add `ArtifactRef` type
- allow `AgentTask.status.artifacts[]`
- store small markdown inline only when safe
- store large files/screenshots/traces in an external backend
- owner/GC artifacts by `AgentTask` UID

Related design doc: [`ARTIFACTS.md`](./ARTIFACTS.md).

### P4 — Make delegation task-native

A2A should mean durable task-to-task delegation, not pod-to-pod RPC.
The parent creates a child `AgentTask`; the substrate tracks it.

First slice:

- child task creation helper/tool
- parent/child labels and status projection
- cancellation propagation
- retry count at AgentTask layer
- no DAG engine, no workflow scheduler

Related design doc: [`TASK-GRAPH.md`](./TASK-GRAPH.md).

### P5 — Port one real workflow

Pick the researcher → summarizer workload because it already has a
baseline in `homelab-orchestrator`.

Done when:

- existing topic set runs on kagent
- final digest quality is comparable
- source/fetch tooling is visible in traces
- researcher delegates once to summarizer
- comparison metrics are published

Related design doc:
[`PHASE-5-WORKFLOW-CANDIDATES.md`](./PHASE-5-WORKFLOW-CANDIDATES.md).

### P6 — Add policy before powerful tools

Browser, code sandbox, git write, and ops tools must not be exposed as
plain prompt-side capabilities. They need policy boundaries first.

First slice:

- tool bindings are declared by humans
- child tool scope is subset of parent scope
- code/browser tools have explicit egress and filesystem boundaries
- audit records include caller, tool, args preview, and artifact refs

Related design doc: [`TOOL-BROKER.md`](./TOOL-BROKER.md).

### P7 — Add controlled dynamic specialists

On-demand agents are useful only if they are created from approved
templates. The orchestrator should request a capability; app-owned
template code compiles it into an `Agent`.

First slice:

- `ensure_agent_from_template`
- idempotent names from template + parameter hash
- TTL / ownerRef cleanup
- budget and tool scope inheritance

Related design doc: [`AGENT-TEMPLATES.md`](./AGENT-TEMPLATES.md).

### P8 — Add replay/evals once runs are rich enough

Replay depends on stable tasks, artifacts, traces, and run metadata.
Do not build it before the first real workflow has generated evidence.

First slice:

- `AgentTaskRun` per execution attempt
- replay tape as artifact
- comparison reducer for completion, cost, latency, flags
- publish `docs/V0.1-COMPARISON.md`

Related design doc: [`REPLAY-EVALS.md`](./REPLAY-EVALS.md).

## 3. Explicitly not next

- Chat-first UX.
- Workflow/DAG builder.
- Browser or code sandbox before policy.
- Multi-tenant auth.
- Full trace-store replacement.
- Arbitrary LLM-created agents.

## 4. Decision rule

When two items compete, choose the one that improves operability of the
engine for every channel. The platform wins when the same unit of work
can be created by YAML, CLI, GUI, webhook, scheduler, or agent — and
all of them produce the same task graph, traces, artifacts, and status.
