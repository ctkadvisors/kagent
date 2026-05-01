# Agent Self-Service — Bridging the Substrate to the User

**Date:** 2026-05-01
**Status:** Plan (post-`v0.0.6-ws-i`; no code yet)
**Phase:** 5.x — bridge between substrate-shipped and substrate-usable
**License:** MIT

> Read [`PLATFORM-PRIORITIES.md`](./PLATFORM-PRIORITIES.md) §4 (the channel-equality decision rule), [`AGENT-TEMPLATES.md`](./AGENT-TEMPLATES.md) (the locked-in template design this doc operationalizes), [`TASK-GRAPH.md`](./TASK-GRAPH.md) (the parent-child surface this builds on), and [`TOOL-BROKER.md`](./TOOL-BROKER.md) (the policy boundary this work knowingly preempts and must remain compatible with).

---

## 1. Motivation

The substrate ships. The operator owns CRDs, the workbench surfaces task state, WS-I (parent → children projection + aggregation) reconciles the moment a child appears. **What's missing is a path from "agent or human wants to start a task" to "AgentTask CR exists in etcd" that does not require editing YAML and waiting for Argo.**

`PLATFORM-PRIORITIES.md` §4 already commits to this:

> When two items compete, choose the one that improves operability of the engine for every channel. The platform wins when the same unit of work can be created by YAML, CLI, GUI, webhook, scheduler, or agent — and all of them produce the same task graph, traces, artifacts, and status.

Today the channel matrix looks like this:

| Channel        | v0.0.6 status                         | What's missing                                    |
|----------------|---------------------------------------|---------------------------------------------------|
| YAML / GitOps  | ✅ works                              | nothing — but it's the wrong UX for invocation    |
| GUI button     | ❌ workbench is read-only             | `POST /api/tasks` + a "New Task" modal            |
| CLI            | ❌ no CLI exists                      | `kagent submit <agent> "<prompt>"` wrapping POST  |
| Agent (in-pod) | ❌ no spawn-child tool                | built-in `spawn_child_task` + `wait_for_child_task` |
| Webhook        | ❌ no endpoint                        | `POST /webhook/<token>/tasks` (deferred — no driver) |
| Scheduler      | ❌ no CRD                             | `KagentSchedule` CRD wrapping CronJob (deferred)  |

The two functional gaps:

1. **Human invocation.** Today the only path to "run a task" is "commit a manifest, wait for Argo." A button + a CLI close that gap with shared semantics (both call the same `POST /api/tasks`).
2. **Agent-driven invocation.** Today an agent loop in a pod has no way to spawn a child task. `agent-pod-rbac.yaml` (template/agent-pod-rbac.yaml:36-44) only grants `agenttasks: [get]` and `agenttasks/status: [get,patch,update]` — no `create`. The operator's WS-I reconcile fires the moment a child *appears*; we just need a tool that calls the K8s API to make one.

This doc plans four workstreams that close both gaps, sequenced and contract-locked. A fifth (external entry points) is sketched and explicitly deferred until a driver exists.

## 2. Workstream map + sequencing

```
WS-J  Write surface for humans (POST API + UI button + CLI)        ──┐
WS-K  spawn_child_task built-in tool + Agent.spec.allowedChildAgents ─┤── independent of WS-M
WS-L  wait_for_child_task / wait_for_children_all (polling)         ──┘
WS-M  AgentTemplate CRD + ensure_agent_from_template tool             ── consumes WS-K (children-from-template path)
WS-N  Webhook + KagentSchedule (DEFERRED — no driver yet)
```

WS-J unblocks "kick off a task today." WS-K + WS-L close the agent → agent loop. WS-M is the dynamic-specialists payoff per `AGENT-TEMPLATES.md`. WS-N waits for `homelab-orchestrator` to retire its CronJob+runner against this substrate.

Tag-per-workstream matches the repo convention (`vX.Y.Z-<slug>`):

| WS | Tag                       | Effort     | Depends on |
|----|---------------------------|------------|------------|
| J  | `v0.0.7-write-surface`    | ~1 day     | nothing    |
| K  | `v0.0.8-spawn-child`      | ~1 day     | nothing    |
| L  | `v0.0.9-wait-for-child`   | ~0.5 day   | WS-K       |
| M  | `v0.1.0-templates`        | ~3 days    | WS-K       |
| N  | `v0.1.4-entry-points`     | (deferred) | WS-J       |

Total focused-work for J+K+L+M is ~5-6 days. **The `v0.1.0` tag flips meaning under this plan**: instead of "Phase 5 + comparison rig," it becomes "agent self-service shipped." Comparison rig + researcher port are still in-flight Phase 5 items but no longer gating v0.1.0 — they move to a `v0.1.5-rig` tag. Reasoning: the substrate-completeness milestone (you can actually USE the thing without writing YAML) is a stronger v0.1 anchor than a single benchmark run, and the comparison rig's value depends on having self-service to even configure runs against.

## 3. Workstream J — Write surface for humans

### 3.1 Goal

A human can start a task by clicking a button or running a CLI command. No YAML, no Argo wait. The same call shape works in both places.

### 3.2 Files

**Add:**
- `packages/workbench-api/src/routes/tasks.ts` — extend with `POST /api/tasks`. The handler validates input, builds an AgentTask manifest, calls the K8s API, returns the created object.
- `packages/workbench-api/src/k8s-client.ts` (new) — wraps `@kubernetes/client-node` for write operations. The existing read path uses the SnapshotCache; writes need a fresh K8s client.
- `packages/workbench-ui/src/components/NewTaskModal.tsx` (new) — agent picker (queries `/api/agents`), prompt textarea, optional `runConfig.timeoutSeconds` field.
- `packages/workbench-ui/src/views/TaskList.tsx` — add a "New Task" button that opens the modal.
- `packages/cli/` (new workspace package):
  - `package.json` with `bin: { kagent: './dist/cli.js' }`
  - `src/cli.ts` — main entry, `kagent submit` subcommand
  - `src/k8s-client.ts` — uses `@kubernetes/client-node` to talk to the cluster directly via kubeconfig
  - `src/commands/submit.ts` — `kagent submit <agent> "<prompt>" [--namespace <ns>] [--timeout <sec>] [--wait] [--json]`
  - `tsconfig.json`, `vitest.config.ts`
- `packages/cli/README.md` — install + usage

**Modify:**
- `pnpm-workspace.yaml` — add `packages/cli`
- `packages/operator/charts/kagent-workbench/templates/clusterrole.yaml` — add `agenttasks: [create]` (and `agents: [create]` if we want UI-driven Agent creation; defer that — see §3.5)

### 3.3 API contract

`POST /api/tasks` request body:

```jsonc
{
  "namespace": "kagent-system",       // optional; default = workbench-api's release namespace
  "name": "manual-2026-05-01-1430",   // optional; default = `manual-${nanoid(8)}`
  "targetAgent": "smoke-test",         // required
  "originalUserMessage": "...",        // required, non-empty
  "runConfig": {                       // optional
    "timeoutSeconds": 300,
    "maxIterations": 6
  },
  "labels": { "submitted-by": "alice" }  // optional, merged with operator-managed labels
}
```

Response (201):

```jsonc
{
  "namespace": "kagent-system",
  "name": "manual-2026-05-01-1430",
  "uid": "f1c2...",
  "createdAt": "2026-05-01T14:30:12Z",
  "phase": "Pending",
  "_links": {
    "detail": "/api/tasks/kagent-system/manual-2026-05-01-1430",
    "ui":     "/#/tasks/kagent-system/manual-2026-05-01-1430"
  }
}
```

Error taxonomy (4xx):

| Code | When                                                        |
|------|-------------------------------------------------------------|
| 400  | Invalid body shape / missing required / `originalUserMessage` empty |
| 403  | Auth gate fails (`X-Forwarded-User` missing when required) |
| 404  | `targetAgent` does not exist in the namespace               |
| 409  | Name collision (already-exists)                             |
| 422  | Schema validation failure (e.g. timeoutSeconds out of range) |
| 500  | K8s API call failed unexpectedly                            |

Validation: zod (already a transitive dep via `@kagent/dto`) for body parsing + 422 mapping. Check agent existence via the SnapshotCache — no extra K8s round-trip needed.

### 3.4 RBAC delta

`packages/operator/charts/kagent-workbench/templates/clusterrole.yaml`:

```yaml
# Existing read perms unchanged.
# Add:
- apiGroups: ['kagent.knuteson.io']
  resources: ['agenttasks']
  verbs: ['create']
```

The read role already exists cluster-scoped. Adding `create` is additive; no namespace explosion.

### 3.5 What's intentionally NOT in WS-J

- **`POST /api/agents`** — Agent CRD creation via UI. Agents are configuration; they belong in GitOps. Templates (WS-M) are the "create-an-agent-on-demand" surface.
- **`POST /api/tasks/.../cancel`** and **`/retry`** — listed in `WORKBENCH.md` §5; defer to v0.2 with the `Cancelled` phase work (TASK-GRAPH.md §5).
- **Per-Agent ACL on POST.** `X-Forwarded-User` gates the endpoint; everything past the gate may submit any AgentTask. v0.2 adds per-user/per-agent ACLs when forward-auth is in front.

### 3.6 CLI UX

```
$ kagent submit smoke-test "What is etcd in one sentence?"
✔ Created AgentTask kagent-system/manual-a3f9b2 (uid: f1c2...)
  Trace:  https://langfuse.knuteson.io/trace/<derived>
  Detail: https://kagent.knuteson.io/#/tasks/kagent-system/manual-a3f9b2

$ kagent submit smoke-test "..." --wait
✔ Created AgentTask ...
⏳ phase=Pending
⏳ phase=Dispatched (pod: kagent-pod-...)
✔ phase=Completed (12.3s)

  Result:
    etcd is a distributed key-value store...

$ kagent submit smoke-test "..." --json
{ "namespace": "...", "name": "...", "uid": "...", ... }
```

Auth: by default uses kubeconfig (so the same `KUBECONFIG` env var that `kubectl` honors). `--via-workbench <https://kagent.knuteson.io>` flag forces the workbench-api path with X-Forwarded-User taken from kube-context user — useful for users without direct cluster RBAC.

### 3.7 Test plan

- `packages/workbench-api/src/routes/tasks.test.ts` — POST handler contract tests:
  - happy-path: 201 + body matches contract
  - 400 on each missing required field
  - 404 on unknown agent
  - 409 on name collision (mock K8s `create` to throw 409)
  - 403 when auth required + no `X-Forwarded-User`
- `packages/cli/src/commands/submit.test.ts` — CLI exit codes, JSON output shape, `--wait` polling loop
- Helm template smoke: workbench chart still renders cleanly with the new ClusterRole verb

### 3.8 Acceptance criteria

- [ ] In a browser at `https://kagent.knuteson.io/`, click "New Task," fill the form, submit, see the new task appear in the list within 2s and progress through phases.
- [ ] On a laptop with kubeconfig, run `kagent submit smoke-test "..."`, see the task created and (with `--wait`) reach `Completed`.
- [ ] All read views still work with the expanded RBAC (no permission regressions).
- [ ] `helm template packages/operator/charts/kagent-workbench` still renders.

### 3.9 Tag

`v0.0.7-write-surface`

---

## 4. Workstream K — `spawn_child_task` built-in tool

### 4.1 Goal

An agent in a pod can call a tool to create a child AgentTask. The operator's WS-I reconcile picks up the new child via the `parent-task-uid` label, projects it onto the parent's `status.children`, and updates `aggregatePhase`. Closes the agent → agent loop end-to-end.

### 4.2 Files

**Add:**
- `packages/agent-pod/src/builtin-tools-spawn.ts` (new) — co-located near `builtin-tools.ts` to keep network-tool concerns separate. Same `defineInProcessTool` pattern.
- `packages/agent-pod/src/k8s-task-creator.ts` (new) — thin wrapper around `customApi.createNamespacedCustomObject` for AgentTask creation. Reads SA token from `/var/run/secrets/kubernetes.io/serviceaccount/token`. Owns the parent-uid → label/spec.parentTask wiring.

**Modify:**
- `packages/agent-pod/src/builtin-tools.ts` — extend `buildBuiltinToolRegistry` to merge in spawn tools when feature-flagged on (env: `KAGENT_SPAWN_CHILD_ENABLED=true`)
- `packages/agent-pod/src/runner.ts` — pass parent task's `uid` + `namespace` into the tool registry so the spawn tool can stamp them onto children
- `packages/operator/src/crds/types.ts` + `packages/operator/charts/kagent-operator/crds/agent.yaml` — add `Agent.spec.allowedChildAgents?: string[]` (optional; empty/unset = no children may be spawned by this agent — fail-closed)
- `packages/operator/charts/kagent-operator/templates/agent-pod-rbac.yaml` — add `agenttasks: [create]` to the agent-pod Role
- `packages/agent-pod/src/env.ts` — surface `KAGENT_SPAWN_CHILD_ENABLED` and the parent uid/namespace already in env

### 4.3 Tool contract

```jsonc
// Tool name: spawn_child_task
// Description: Create a child AgentTask under the current task. The operator
// will dispatch a fresh pod for the named agent. This tool returns immediately;
// use `wait_for_child_task` to block on completion.
{
  "name": "spawn_child_task",
  "inputSchema": {
    "type": "object",
    "required": ["agentName", "originalUserMessage"],
    "properties": {
      "agentName": { "type": "string", "minLength": 1, "maxLength": 253 },
      "originalUserMessage": { "type": "string", "minLength": 1, "maxLength": 32768 },
      "runConfig": {
        "type": "object",
        "properties": {
          "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 86400 }
        }
      },
      "payload": {
        "type": "object",
        "additionalProperties": true,
        "description": "Opaque structured data forwarded to the child as AgentTask.spec.payload."
      }
    },
    "additionalProperties": false
  }
}

// Returns:
{ "name": "<created-name>", "namespace": "<ns>", "uid": "<uid>" }
```

The created child gets:
- `metadata.namespace`: parent's namespace
- `metadata.name`: `${parentName}-c-${nanoid(8)}`
- `metadata.labels["kagent.knuteson.io/parent-task-uid"]`: parent's UID  → triggers WS-I reconcile
- `metadata.ownerReferences[0]`: parent AgentTask, `controller: false, blockOwnerDeletion: false` (per TASK-GRAPH.md §5)
- `spec.parentTask`: parent's UID
- `spec.targetAgent`: caller-supplied
- `spec.originalUserMessage`: caller-supplied
- `spec.runConfig`: caller-supplied (clamped — see §4.4)

### 4.4 Guardrails

These are the non-negotiables. Each fails fast with a `policy_denied:` error matching the existing builtin-tools convention:

1. **`agentName ∈ Agent.spec.allowedChildAgents`** of the parent agent. Empty or unset list = `policy_denied: this agent has no allowedChildAgents`. The agent-pod reads its own Agent spec at boot (it has `agents: [get]` already? — VERIFY; if not, add the verb in WS-K) and refuses anything not on the list.
2. **`agentName != self`** — cycle prevention belt-and-braces. The operator already detects multi-hop cycles via `cycleCheck` (TASK-GRAPH.md §7.2; landed in WS-I). The tool refuses single-hop self-reference up front for cleaner error UX.
3. **Concurrent-children cap.** Tool refuses when the parent already has ≥ N (default 10, configurable via `Agent.spec.maxConcurrentChildren`) children in non-terminal phases. Reads from the K8s API via label selector, no cache. Prevents an LLM-loop-bug from creating 10⁶ children.
4. **`runConfig.timeoutSeconds` clamped to ≤ parent's remaining budget**. If parent has 60s left and child requests 300s, child gets 60s. Avoids "child outlives parent" pathology.
5. **`originalUserMessage` size cap** — 32KB. Anything longer should go through `payload` (which is opaque to the LLM-visible schema but loggable in the trace).

### 4.5 Test plan

- `packages/agent-pod/src/builtin-tools-spawn.test.ts`:
  - happy path: tool call → K8s API called with correct manifest → returns name/uid
  - `policy_denied` on each guardrail (allowlist miss, self-ref, cap exceeded, oversize message)
  - `runConfig.timeoutSeconds` clamping math
  - K8s API error → tool returns `isError: true` with structured reason (matches `policy_denied:` shape)
- Operator-side integration: `packages/operator/src/reconcile.test.ts` already covers WS-I (parent re-reconcile on child status change); no new operator tests needed for this slice.
- `helm template packages/operator/charts/kagent-operator` — the new RBAC verb renders cleanly.

### 4.6 Acceptance criteria

- [ ] An agent with `spec.allowedChildAgents: [summarizer]` can call `spawn_child_task({ agentName: 'summarizer', ... })` from inside its loop and a child pod boots within 5s.
- [ ] The same agent gets `policy_denied` when calling with `agentName: 'researcher'` (not on allowlist).
- [ ] The parent's `status.children` populates within 2s of child creation (WS-I sanity check).
- [ ] An agent without `allowedChildAgents` set gets `policy_denied: this agent has no allowedChildAgents`.

### 4.7 Tag

`v0.0.8-spawn-child`

---

## 5. Workstream L — `wait_for_child_task` + `wait_for_children_all`

### 5.1 Goal

A parent agent can block in-pod until a specific child reaches a terminal phase (`Completed | Failed`), or until ALL children do. Without this, the only delegation pattern is fire-and-forget — useful sometimes, broken for fan-out → join → synthesize flows.

### 5.2 Polling vs Watch

**Pick: polling.**

Reasons:
- The agent-pod K8s client is already wired for one-shot reads. A Watch path would require a second connection, lifecycle management, and reconnection logic.
- Latency budget: we're polling for LLM-completion-scale events (multi-second). 2s polling tail latency is invisible against a 10-30s typical child run.
- A polling loop is trivially testable with a mock clock; Watch needs a fake informer.
- Watch can land in v0.2 if a workload genuinely needs sub-second join latency.

### 5.3 Files

**Add:**
- `packages/agent-pod/src/builtin-tools-wait.ts` — two new tools using the same `defineInProcessTool` pattern.

**Modify:**
- `packages/agent-pod/src/builtin-tools.ts` — merge into registry when `KAGENT_SPAWN_CHILD_ENABLED=true` (waiting only makes sense when spawning is enabled)

### 5.4 Tool contracts

```jsonc
// wait_for_child_task — block until a single child reaches terminal phase.
{
  "name": "wait_for_child_task",
  "inputSchema": {
    "type": "object",
    "required": ["uid"],
    "properties": {
      "uid": { "type": "string" },
      "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 86400, "default": 600 },
      "pollIntervalSeconds": { "type": "integer", "minimum": 1, "maximum": 60, "default": 2 }
    }
  }
}
// Returns: { "phase": "Completed" | "Failed", "result": <child's status.result>, "error": <child's status.error?> }
// Error: policy_denied: child uid not found OR timed out (timed-out includes last-known phase)

// wait_for_children_all — block until ALL children of THIS task are terminal.
{
  "name": "wait_for_children_all",
  "inputSchema": {
    "type": "object",
    "properties": {
      "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 86400, "default": 1800 },
      "pollIntervalSeconds": { "type": "integer", "minimum": 1, "maximum": 60, "default": 5 }
    }
  }
}
// Returns: { "aggregatePhase": "AllComplete" | "AnyFailed", "successCount": N, "failureCount": N,
//            "children": [{ "uid", "name", "phase", "result", "error" }] }
```

`wait_for_children_all` reads the parent's own `status.aggregatePhase` (operator-maintained per WS-I). It returns when `inFlightCount === 0`. Returns `AnyFailed` immediately on first failure — caller decides whether to retry/ignore/abort.

### 5.5 Run-budget interaction

Waiting consumes wall-clock, not LLM tokens. But:
- The agent-loop's `RunBudget.maxIterations` is ITERATION-counted; one wait call = one iteration. Long waits don't blow the iteration budget.
- The Job's `activeDeadlineSeconds` (set by operator from `AgentTask.spec.timeoutSeconds`) DOES bound wall-clock. A wait that exceeds remaining wall-clock = pod gets SIGKILL'd by kubelet → status flipped to Failed by Job watcher.
- **Mitigation:** `wait_for_*` tools clamp their `timeoutSeconds` to the parent's remaining budget at call time, return `timed_out` cleanly before the kubelet kills the pod, and the agent loop has a chance to set its own status.

### 5.6 Anti-patterns to document

- **Fan-out, then immediately wait_all** — wastes the parent's LLM session. The parent's tokens cost the same whether it's thinking or waiting; if there's no work to do between fan-out and join, structure as a synchronous tool call from a thinner orchestrator.
- **Wait-for-children inside a child** — children waiting on grandchildren is fine semantically but explodes wall-clock. Each tier of the tree multiplies remaining budget. Document the depth budget pattern explicitly.

### 5.7 Test plan

- Mock the K8s API + a deterministic clock; assert poll cadence, timeout-clamp math, terminal-phase return shape.
- Cover: child reaches Completed, child reaches Failed, child never appears (uid not found), timeout fires before terminal, parent has no children (returns immediately with `successCount=0, failureCount=0`).

### 5.8 Acceptance criteria

- [ ] An agent that calls `spawn_child_task` × 3 then `wait_for_children_all` returns when all 3 are terminal, with each child's result accessible.
- [ ] A `wait_for_child_task(uid)` with a 5s timeout returns `timed_out` cleanly when the child is still running at 5s.
- [ ] A wait against a non-existent uid returns `policy_denied: child uid not found` immediately.

### 5.9 Tag

`v0.0.9-wait-for-child`

---

## 6. Workstream M — AgentTemplate CRD + `ensure_agent_from_template`

### 6.1 Scope vs `AGENT-TEMPLATES.md`

The full design is locked in [`AGENT-TEMPLATES.md`](./AGENT-TEMPLATES.md). This workstream **implements** that design — it does not redesign. Open questions from §8 of that doc are resolved below for v0.1.

### 6.2 What lands now (v0.1) vs deferred

**In v0.1.0-templates:**
- `AgentTemplate` CRD (namespaced; per §8.4)
- Operator endpoint `POST /v1alpha1/templates/{name}:instantiate` (in-cluster only, SA-token auth)
- Built-in tool `ensure_agent_from_template` (per §3 contract)
- Naming + hash strategy (§4)
- OwnerRef + `lastUsedAt` GC sweeper (§5.1, §5.2; hard `maxAgeSeconds` deferred)
- Guardrails (a) parameter substitution + (b) budget inheritance + (d) audit fields (§6)
- Parameter types: `string`, `integer`, `toolSelection` (per §8.5)

**Deferred to v0.2:**
- Validating admission webhook (§8.1) — homelab relies on RBAC + operator-internal validation
- Tool Broker scope-passing (§8.2) — guardrail (c) child tools ⊆ parent tools is **stubbed**: child gets the template's `toolDefaults` intersected with `toolAllowlist`. Parent-scope intersection is a no-op until Tool Broker lands and `AgentTask.status.effectiveTools` is wired.
- `enum`, `boolean`, `secret-ref` parameter types (§8.5)
- Cross-namespace templates (§8.4)
- Hot-reload / aggressive idle-reclaim (§8.6)
- Hard `maxAgeSeconds` TTL escape hatch

### 6.3 Files

**Add:**
- `packages/operator/charts/kagent-operator/crds/agenttemplate.yaml` — full CRD spec from `AGENT-TEMPLATES.md` §7
- `packages/operator/src/crds/types.ts` — `AgentTemplate` types
- `packages/operator/src/template-instantiator.ts` — the materializer (parameter validation, hash, render, K8s create with 409-as-success)
- `packages/operator/src/template-server.ts` — the in-cluster HTTP endpoint
- `packages/operator/src/template-gc.ts` — the idle sweeper (cron-style, runs every 5 min)
- `packages/operator/src/template-instantiator.test.ts`, `template-server.test.ts`, `template-gc.test.ts`
- `packages/agent-pod/src/builtin-tools-template.ts` — the `ensure_agent_from_template` tool (calls the operator endpoint via in-cluster service URL)

**Modify:**
- `packages/operator/charts/kagent-operator/templates/clusterrole.yaml` — operator gets `agenttemplates: [get,list,watch]` and `agents: [create,update,delete,patch,get,list,watch]` (the operator now mints Agents)
- `packages/operator/charts/kagent-operator/templates/agent-pod-rbac.yaml` — agent pods get NETWORK access to the operator's template service (NetworkPolicy egress class)
- `packages/operator/charts/kagent-operator/templates/service.yaml` (new) — Service for the operator template-server endpoint
- `packages/operator/src/main.ts` — wire instantiator + server + GC into operator boot

### 6.4 Test plan

- Per-file unit tests as listed above
- Integration: a full instantiate → operator creates Agent → tool returns name → caller spawns AgentTask with that name → operator dispatches → pod runs the templated agent
- Idempotency: two concurrent instantiates with same params → both get `reused: true` for the second
- Hash stability: changing parameter map order doesn't change `parameterHash`
- Default merging: adding a default to template after first instantiate doesn't silently change the hash

### 6.5 Acceptance criteria

- [ ] Apply an `AgentTemplate` for `summarizer` via GitOps. From inside an agent pod, call `ensure_agent_from_template({ templateName: 'summarizer', parameterValues: { topic: 'rust async', wordBudget: '200' } })`. Get back an `agentName`. Then call `spawn_child_task({ agentName, ... })`. A pod runs the templated agent against the substituted prompt.
- [ ] Calling `ensure_agent_from_template` with the same params again returns `reused: true` and the same name.
- [ ] An invalid parameter (regex miss) returns `400` with `code: parameter_invalid`.
- [ ] An idle templated Agent gets reaped by the GC sweeper after `idleTtlSeconds`.

### 6.6 Tag

`v0.1.0-templates`

---

## 7. Workstream N — External entry points (DEFERRED)

### 7.1 What this would be

- **Webhook:** `POST /webhook/<token>/tasks` on workbench-api. External systems (Linear, n8n, Tailscale Funnel one-off URLs) submit tasks via shared-secret token instead of K8s RBAC.
- **`KagentSchedule` CRD:** `spec: { schedule: '0 6 * * *', task: <AgentTaskSpec> }`. Operator creates AgentTasks on a Cron schedule. Equivalent to the homelab's current "CronJob → kubectl apply" pattern, but native to the substrate.

### 7.2 Why deferred

Both are thin wrappers over `POST /api/tasks` (WS-J) once it exists. Building them speculatively is fine; building them WITH a driver pinned (homelab-orchestrator's existing CronJob, the Linear inbox webhook) makes the contract a real-world fit instead of an imagined one.

Open until: `homelab-orchestrator` migration plan names a target consumer.

### 7.3 Tag (placeholder)

`v0.1.4-entry-points`

---

## 8. Cross-cutting decisions

These are sized to be settled BEFORE WS-J starts. Each lists the proposed default + the alternatives explicitly rejected. Open for the user to override; if no override comes, the default ships.

### D1. CLI location + packaging

**Default:** new `packages/cli/` workspace package. Built via `tsc` (consistent with rest of monorepo). Distributed initially as `npx @kagent/cli` from npm; a `bun build --compile` static-binary path is a follow-up.

**Rejected:** separate repo (loses shared-DTO hot-reload), `pkg`/`nexe` static binaries first (premature optimization for a v0.1 CLI).

### D2. CLI auth

**Default:** kubeconfig direct via `@kubernetes/client-node`. Same `KUBECONFIG` env var as `kubectl`. Users with cluster RBAC use this path.

**Alternative path (also ships):** `--via-workbench <url>` flag forces the workbench-api path; auth becomes whatever the workbench-api expects (X-Forwarded-User from the user's kubectl context). Useful for users without K8s RBAC who can hit the workbench through their org SSO.

**Rejected:** kubeconfig-only (loses the no-cluster-RBAC use case), workbench-only (loses one-machine setup for cluster admins).

### D3. `spawn_child_task` default behavior

**Default:** **fire-and-forget.** Returns immediately with the child's name/uid. Caller uses `wait_for_child_task` if it needs to block.

**Rejected:** await-by-default. Implicit blocking inside a tool call hides the wall-clock cost from the LLM (it can't tell "it took 30s" from "it failed silently"). Explicit > implicit.

### D4. `wait_for_*` implementation

**Default:** polling at 2s default cadence (single child) or 5s default cadence (all-children, lower polling rate since K8s LIST is heavier). Configurable per-call.

**Rejected:** Watch-based (more code, more failure modes; latency win is invisible at LLM-call timescales). Revisit in v0.2 if a workload demonstrates a sub-second-join requirement.

### D5. `POST /api/tasks` auth model

**Default:** same X-Forwarded-User gate as the rest of the API. Today the gate is `WORKBENCH_AUTH_REQUIRED=false` (Tailscale subnet trust); when forward-auth lands, this flips to `true` and POST gets the same gate as GET.

**Rejected:** open to any in-cluster ServiceAccount token (tempting for in-cluster tooling but creates a second auth surface to reason about). In-cluster callers should call the K8s API directly (their SA already has create RBAC if granted) — workbench-api is the human-and-CLI surface.

### D6. AgentTemplate CRD scope

**Default:** namespaced (per `AGENT-TEMPLATES.md` §8.4 v0.1 stance).

**Rejected for v0.1:** cluster-scoped (per §8.4 — defer cross-namespace until a real consumer asks).

### D7. AgentTemplate parameter types in v0.1

**Default:** `string`, `integer`, `toolSelection` (per `AGENT-TEMPLATES.md` §8.5).

**Rejected for v0.1:** `enum`, `boolean`, `secret-ref` (additive later; ship the minimum the researcher → summarizer chain needs).

### D8. AgentTemplate validating admission webhook

**Default:** **NO webhook.** Rely on operator-side validation in the materializer + RBAC denying `agents: create` to anything but the operator SA. Per `AGENT-TEMPLATES.md` §8.1 — the homelab is single-tenant + admin-authored, so the cert-mgmt cost of a webhook isn't justified yet.

**Rejected for v0.1:** ship the webhook (cert-manager Certificate + operator-side webhook server + chart wiring is ~1-2 days of yak-shave; revisit when multi-tenant lands).

### D9. `spawn_child_task` and the future Tool Broker

**Default:** ship `spawn_child_task` as a built-in tool with hardcoded guardrails (§4.4 above — `Agent.spec.allowedChildAgents` is the v0.1 declarative gate). When Tool Broker lands (P6), `spawn_child_task` becomes a `ToolDefinition` like any other; `allowedChildAgents` migrates to a `ToolBinding.argumentPolicy` regex over `agentName`. Backward-compat is preserved by keeping `Agent.spec.allowedChildAgents` as a fallback when no `ToolBinding` exists for `spawn_child_task`.

**Knowingly preempted:** Tool Broker §7(b) parent-tool-subset invariant. WS-K stubs this — child Agent's tools are whatever the template / Agent CR says, NOT a strict subset of parent's effective tools. When Tool Broker lands and `AgentTask.status.effectiveTools` exists, the operator's reconcile intersects child's tool set with parent's at dispatch (per AGENT-TEMPLATES.md §6(c) step 2).

**Rejected:** wait for Tool Broker before shipping spawn-child. Tool Broker is a 2-week+ workstream with its own design questions. Blocking the agent-self-service work on it would defer the entire user vision indefinitely.

---

## 9. Acceptance test for the whole effort

Before declaring `v0.1.0-templates` shipped, this end-to-end scenario must pass — not as a unit test, but as a recorded video or live demo:

1. Open `https://kagent.knuteson.io/` in a browser → click "New Task" → pick an `orchestrator` Agent → enter prompt: `"Research these three topics: rust async, k8s networking, postgres MVCC. Summarize each in 200 words."`
2. Workbench POST creates the AgentTask. Operator dispatches. Orchestrator pod boots.
3. Orchestrator agent calls `ensure_agent_from_template({ templateName: 'summarizer', parameterValues: { topic: 'rust async', wordBudget: '200' } })` × 3 (one per topic), getting back three Agent names.
4. Orchestrator calls `spawn_child_task({ agentName, ... })` × 3 with each topic's prompt.
5. Workbench shows the parent + three children appearing live, parent's `aggregatePhase` progressing through `Pending → Dispatched → PartiallyComplete → AllComplete` as children finish.
6. Orchestrator calls `wait_for_children_all`, which returns once all three are `Completed`.
7. Orchestrator concatenates the three `result.content` payloads, writes a final summary via `write_artifact`, sets its own status to `Completed`.
8. Langfuse shows nested trace: parent root span (5+ tool calls), three child spans (each with their own LLM + tool activity), all linked by trace ID derivation.
9. Total wall-clock: under 90s for the gemma-4-26b model on LM Studio.

If any step fails or requires manual YAML/kubectl, this work isn't shipped.

---

## 10. Risks + mitigations

| ID  | Risk                                                                                                  | Likelihood | Mitigation                                                                                          |
|-----|-------------------------------------------------------------------------------------------------------|------------|-----------------------------------------------------------------------------------------------------|
| R1  | LLM-driven prompt injection causes orchestrator to spawn arbitrary agents                              | High       | `Agent.spec.allowedChildAgents` is the GitOps-controlled allowlist; fail-closed default              |
| R2  | Runaway children (cycle / loop bug) explode etcd                                                      | Medium     | Operator-side `cycleCheck` (WS-I, shipped); tool-side concurrent-children cap (§4.4 #3)               |
| R3  | `wait_for_children_all` consumes wall-clock and the kubelet SIGKILLs the pod mid-wait                  | Medium     | Tool clamps timeoutSeconds to remaining Job activeDeadlineSeconds; returns `timed_out` cleanly       |
| R4  | AgentTemplate parameter substitution becomes a template-injection vector                              | High       | mustache-without-helpers semantics (no JS eval); regex-validated parameters (AGENT-TEMPLATES.md §6a) |
| R5  | Workbench POST surface enables an attacker who breaches forward-auth to spawn arbitrary tasks         | Medium     | Same X-Forwarded-User gate as reads; trust boundary unchanged. Per-user/per-agent ACL is a v0.2 add  |
| R6  | CLI breaks when kubeconfig context changes mid-flight                                                 | Low        | Standard `@kubernetes/client-node` pattern; same failure mode as `kubectl`                          |
| R7  | spawn_child_task's RBAC widening (agent-pods now hold `agenttasks: [create]`) changes blast radius   | Low        | Scoped to Role (namespace-bound), not ClusterRole; allowedChildAgents is the policy gate             |
| R8  | Tool Broker design changes invalidate WS-K's hardcoded model                                          | Medium     | D9 spells out the migration path; `allowedChildAgents` survives as fallback                          |
| R9  | NetworkPolicy egress class for the template-server call from agent-pods is missing → calls hang       | Medium     | Add an `agent-pod → operator template-server` allow rule in the operator chart's NetworkPolicy       |

---

## 11. Open questions to resolve in flight

These aren't blockers for the plan; they're decisions to make as the code lands.

- **Q1.** `spawn_child_task` tool name — keep the `_` underscore convention (matches `http_get`, `extract_text`)? Or switch to `kagent.spawn_child_task` with a namespace prefix (matches `AGENT-TEMPLATES.md`'s `kagent.ensure_agent_from_template`)? **Lean: namespace-prefix `kagent.*` for all kagent-substrate-internal tools, leaving bare names for application-layer tools.**
- **Q2.** Should `wait_for_children_all` return early on `AnyFailed`, or wait for all children to terminate even after one fails? Default = early-return. Override via `waitMode: 'any-terminal' | 'all-terminal'`.
- **Q3.** Per-Agent `maxConcurrentChildren` — does it count children-of-children (transitive) or only direct children? Lean: direct only (cheap to compute; cycles already prevented).
- **Q4.** When a child of `agent A` itself spawns a grandchild, is the grandchild's `allowedChildAgents` from `A`'s spec, or the child's spec? Lean: the child's spec — each agent is the security boundary for what it can spawn.
- **Q5.** `KAGENT_SPAWN_CHILD_ENABLED` env knob: default ON or default OFF? Lean: OFF in WS-K (opt-in per-deployment via Helm value), default ON once WS-M lands and the demo flow needs it.
- **Q6.** Should the workbench's "New Task" modal expose `runConfig.maxIterations`? Lean: NO in v0.1 — keep the form minimal; let advanced users hit the CLI / API directly.

---

**Bottom line:** This plan closes the substrate → user gap in four sequenced, contractually scoped workstreams totaling ~5-6 days of focused work. WS-J ships a real "click to run a task" path today. WS-K + WS-L close the agent → agent loop. WS-M delivers the dynamic-specialists payoff `AGENT-TEMPLATES.md` already designed but never implemented. Each workstream tags independently and remains usable on its own — the user gets value from WS-J in isolation, even if WS-M is still weeks out.
