# kagent Workbench

**Date:** 2026-04-27
**Status:** Design draft; read-only first
**Purpose:** visibility into the execution fabric, not a new channel.

The Workbench is an operator surface over kagent's platform primitives.
It is not the product, not the orchestrator, and not a chat app. Its job
is to make autonomous execution inspectable: tasks, pods, traces,
artifacts, failures, retries, and agent definitions.

## 1. Why this belongs early

Phase 4 proved the core loop works, but the first bring-up also proved
that `kubectl` alone is too slow for development:

- failed pods can explain stuck tasks before the agent can patch status
- image pull and TLS errors are operational facts, not model behavior
- detector flags are useful only if surfaced where operators look
- parent/child delegation needs a visual task graph to be debuggable
- artifact-heavy work needs browsable outputs, not opaque status blobs

Workbench should arrive before browser/code sandbox workflows because
those workflows multiply failure modes.

## 2. Architecture

Keep the UI outside the operator.

```text
[React/Vite Workbench]
        ↓
[thin kagent API facade]
        ↓
[Kubernetes API: Agent, AgentTask, Job, Pod]
        ↓
[Artifact backend + Langfuse links]
```

The API facade is intentionally thin:

- watches `Agent`, `AgentTask`, owned Jobs, owned Pods
- streams updates by SSE or WebSocket
- reads artifact metadata and signed/read URLs
- links to Langfuse/OTel traces instead of reimplementing a trace store
- performs explicit actions only after read-only mode is useful

The Workbench owns no orchestration semantics. If an action cannot be
expressed as a CRD update, artifact read, or trace link, it probably
belongs in the engine first.

## 3. MVP views

### 3.1 Task list

Purpose: answer "what is running, stuck, failed, or done?"

Columns:

- task name / namespace
- phase
- target agent or capability
- created, started, completed, duration
- pod/job name
- failure reason
- detector flags
- artifact count
- trace link

Default filters:

- non-terminal tasks
- failed tasks
- suspicious completed tasks
- last 24 hours

### 3.2 Task detail

Purpose: answer "what happened to this task?"

Sections:

- input payload and `originalUserMessage`
- current status and terminal result/error
- Job and Pod status summary
- container wait/termination details
- structural verdict flags
- parent and children
- trace timeline link
- artifact list

### 3.3 Task graph

Purpose: debug delegation.

First implementation can be simple:

- tree of `AgentTask.spec.parentTask`
- node color by phase
- edge labels by capability/tool call when available
- click node → task detail

No workflow editing. No DAG builder.

### 3.4 Agent catalog

Purpose: answer "what can the platform run?"

Show:

- `Agent` name and namespace
- model
- capabilities
- tools
- sandbox profile
- image/profile if added later
- latest task count and failure count

Later:

- `AgentTemplate` catalog
- generated ephemeral agents
- template parameter schema

### 3.5 Artifact browser

Purpose: inspect outputs without copying blobs from pods.

Show:

- artifact name/type/size
- producer task/run
- media type
- digest
- created time
- preview when safe: markdown, JSON, text, screenshot thumbnail, patch
- download/read link

### 3.6 Ops panel

Purpose: surface platform problems distinctly from model problems.

Cards:

- image pull failures
- pod scheduling failures
- deadline exceeded
- RBAC/status patch errors
- repeated model HTTP failures
- tasks stuck beyond expected duration
- artifact write failures

## 4. Actions, after read-only

Only add actions once the read-only views are useful.

Safe first actions:

- cancel task
- retry failed task
- create task from existing `Agent`
- copy `kubectl`/YAML for a task
- open trace
- open artifact

Later actions:

- create task from `AgentTemplate`
- approve generated ephemeral agent
- quarantine/freeze an agent template

Actions should write the same CRDs a CLI or GitOps path would write.

## 5. API facade shape

Suggested endpoints:

```text
GET /api/tasks
GET /api/tasks/:namespace/:name
GET /api/tasks/:namespace/:name/events
GET /api/agents
GET /api/artifacts/:namespace/:task
GET /api/stream
POST /api/tasks/:namespace/:name/cancel
POST /api/tasks/:namespace/:name/retry
POST /api/tasks
```

The facade should normalize Kubernetes objects into UI-friendly DTOs,
but keep raw object access available for debugging.

Example task summary:

```ts
interface TaskSummary {
  namespace: string;
  name: string;
  uid: string;
  phase: 'Pending' | 'Dispatched' | 'Completed' | 'Failed';
  target: { kind: 'agent' | 'capability'; name: string };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  podName?: string;
  jobName?: string;
  error?: string;
  failureReason?: string;
  suspicious: string[];
  artifactCount: number;
  traceUrl?: string;
  parentTask?: string;
  childCount?: number;
}
```

### 5.1 RC evidence projection

The Enterprise Pilot RC evidence pack uses the same detail endpoint,
without adding controller semantics:

```text
GET /api/tasks/:namespace/:name
  -> TaskDetail + pilotEvidence
```

`pilotEvidence` is a Workbench API projection over already-observed CRD
fields:

- filtered audit metadata from task labels/annotations
- target Agent policy fields (`tools`, child allowlists, concurrency caps)
- task-graph counters and aggregate phase
- artifact ref count
- structural detector verdict
- verifier result when `status.verification` exists
- capability reference when the capability issuer has stamped one
- run-config knobs visible on the task spec

The UI renders this as the task detail page's `RC Evidence` section.
The script [`scripts/collect-workbench-evidence.mjs`](../scripts/collect-workbench-evidence.mjs)
captures the list/detail JSON plus a Markdown summary into an evidence
directory for reviewer handoff. See [`GA-HARDENING.md`](./GA-HARDENING.md)
and [`GA-EVIDENCE-CHECKLIST.md`](./GA-EVIDENCE-CHECKLIST.md).

## 6. Deployment

For the RTS-style Command Center specifically, treat
[`COMMAND-CENTER-CONTRACT.md`](./COMMAND-CENTER-CONTRACT.md) as the
implementation contract. The short version: the canvas may be playful,
but every object and action must map back to CRDs, Workbench API DTOs,
audit events, gateway state, artifacts, traces, or verifier output. It
is a projection over the engine, not a second source of truth.
The broader product/system north star lives in
[`NORTH-STAR-SYSTEM-DESIGN.md`](./NORTH-STAR-SYSTEM-DESIGN.md).

Deploy as a separate app in `new_localai`, not as part of the operator
binary.

Initial deployment:

- namespace: `kagent-system` or `kagent-ui`
- service account: read `Agent`, `AgentTask`, owned Jobs/Pods
- optional write permissions only when actions are enabled
- ingress behind existing homelab auth pattern

The Workbench should tolerate missing optional systems:

- no Langfuse endpoint → show traces unavailable
- no artifact backend → show status/result only
- no templates → hide template catalog

## 7. Do not build yet

- chat interface
- prompt playground
- workflow builder
- multi-tenant auth model
- custom trace database
- arbitrary YAML editor
- live pod exec/log terminal

## 8. First milestone

Read-only Workbench is done when it can show:

1. the successful Phase 4 smoke-test task
2. a forced image-pull failure task
3. a forced model-timeout task
4. the exact pod/job reason for failures
5. detector flags and result content
6. direct link to trace when configured

That milestone gives visibility into the thing we have built without
turning the platform into a single channel.
