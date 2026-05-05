# Substrate v1 Architecture

**Date:** 2026-05-03
**Status:** Draft, ratifies the v1.0 substrate shape; locked-in primitive set
**License:** MIT

> Prereqs: [`WHY.md`](./WHY.md), [`DESIGN-V0.1.md`](./DESIGN-V0.1.md), [`ROADMAP.md`](./ROADMAP.md), [`GATEWAY-CONTRACT.md`](./GATEWAY-CONTRACT.md).
>
> This document is the contract every release between v0.1 and v1.0 drafts against. Each PR has a one-sentence test: *does this preserve the 7-primitive shape?*

---

## 1. The bet

kagent v1.0 is a substrate composed of **seven orthogonal primitives** and **three cross-cutting concerns**. Every concern raised in the v0.1.x audit (spawn authority, pod cleanup, secret hygiene, shared workspaces, self-introspection, multi-tenancy, compliance) maps to exactly one primitive or one cross-cutting concern. No more. The substrate is small. The substrate composes.

The bet: a small, orthogonal substrate beats a feature-rich, organic one — measured by the ability to support an enterprise consumer's stack without forking, and by the time-to-correct-mental-model for a new engineer reading the code.

---

## 2. Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Application                                                 │
│  Researcher agents, summarizers, multi-stage workflows,      │
│  webhook consumers — written by users of kagent              │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  kagent — orchestration substrate (THIS REPO)                │
│  7 primitives + 3 cross-cutting concerns                     │
│  Authority, lifecycle, I/O, supervision, audit, identity     │
└─────────────────────────────────────────────────────────────┘
                              │
       OpenAI-compat HTTP + traceparent + X-Kagent-* + bounded auth
       (see GATEWAY-CONTRACT.md)
                              │
┌─────────────────────────────────────────────────────────────┐
│  Model gateway — model substrate (EXTERNAL)                  │
│  Routing, PII scrubbing, response cache, per-token quota     │
│  Pluggable: enterprise gateway, LiteLLM, OpenRouter direct   │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  Providers — OpenAI, Anthropic, OpenRouter, Bedrock,         │
│  on-prem, Workers AI, ...                                    │
└─────────────────────────────────────────────────────────────┘
```

The model gateway is **not** a kagent concern. kagent ships an OSS bundled gateway (`@kagent/llm-gateway`) for OSS / dev convenience; production deploys plug in a production gateway. The wire is small enough that this is a one-config-line decision.

---

## 3. The seven primitives

```
┌─────────────────────────────────────────────────────────────┐
│  1. Agent          static declaration: I/O, capabilities    │
│  2. AgentTask      runtime instance: bound inputs + caps    │
│  3. AgentWorkflow  durable orchestrator (Restate-backed)    │
│  4. Workspace      shared scratch FS, pipeline-scoped       │
│  5. Artifact       typed bytes, content-addressed (CAS)     │
│  6. Capability     sealed JWT, narrows on spawn             │
│  7. Event          pub/sub + blackboard for loose coord     │
└─────────────────────────────────────────────────────────────┘
```

Each primitive has its own CRD (or substrate object) and its own controller (or controller responsibility). They compose via well-defined references. None subsumes another. None is implicit.

### 3.1 Agent — *what is possible*

The static, declarative description of an agent class. Its image, its model preference, its declared tools, its required inputs and produced outputs, its supervision strategy, its declared egress.

```yaml
kind: Agent
spec:
  image: ghcr.io/.../researcher:v1.4
  model: gpt-4o          # gateway-resolved (see GATEWAY-CONTRACT.md §2.1)
  systemPromptRef: { name: researcher-system }
  tools: [http_get, write_artifact]
  inputs:
    - { name: corpus, kind: workspace, mode: ro, mountPath: /var/kagent/in/corpus }
    - { name: brief, kind: artifact, mediaType: text/markdown, optional: true }
  outputs:
    - { name: digest, kind: artifact, mediaType: text/markdown, required: true }
  caches:
    - { name: npm, key: "{{ files('package-lock.json') }}", mountPath: /home/agent/.npm }
  supervisionStrategy: one_for_one
  egress:
    domains: [api.github.com, news.ycombinator.com]
  sandboxProfile: default        # default | strict (Kata)
```

**Substrate responsibility:** validate the schema, manage lifecycle (immutable post-publish; versioned per `v0.5.3-versioning`), expose to admission.

**Application responsibility:** write meaningful prompts, tools, and outputs.

### 3.2 AgentTask — *what is happening now*

The runtime instance. An invocation of an Agent with bound inputs and a sealed capability bundle. Owned by either an external trigger (webhook, CLI, scheduler) or an AgentWorkflow.

```yaml
kind: AgentTask
spec:
  agentName: researcher
  agentVersion: 1.4              # pinned, immutable
  idempotencyKey: digest-2026-05-03-k3s
  capabilityRef: cap-jti-abc123
  inputs:
    - { name: corpus, from: { workspace: seekarc-pr-1234 } }
    - { name: brief, from: { taskUid: <orchestrator-uid>, output: brief } }
  runConfig:
    timeoutSeconds: 600
    tokenLimit: 50000
    costLimitUsd: 1.50
    maxIterations: 8
status:
  phase: Running                 # Pending | Running | Completed | Failed | Cancelled
  startedAt: 2026-05-03T...
  completedAt: ...
  result:
    content: ...
    contentHash: sha256:...      # CAS handle (post v0.2.2)
  outputs:
    - { name: digest, ref: 'cas://sha256:abc.../digest.md' }
  children:
    - { name: summarizer-1, uid: ..., phase: Completed }
  observedUsage:
    tokensIn: ...
    tokensOut: ...
    costUsd: ...
```

**Substrate:** admission validates inputs satisfy Agent.spec.inputs; owner-refs propagate cascading delete; tracks children; refuses `Completed` patch with missing required outputs; emits audit events.

**Application:** issued by trigger; consumed via `wait_for_*` tools.

**v0.1.7-rig.2 — verifier as a substrate-mediated post-completion quality gate.** `AgentTask.spec.verifyContract = { scriptRef?, llmJudgePromptRef? }` is the substrate's sixth observation channel (alongside admission, capability mint/use, audit emission, supervision routing, and parent re-aggregation). It is NOT a per-task tool the agent can call from inside its loop; it is a SUBSTRATE-side verdict applied AFTER the agent-pod writes `phase: Completed`. The reconciler in `packages/operator/src/verifier.ts` picks up the Completed-with-contract event, dispatches one of the two paths (Job spawn for scripts, gateway POST for LLM judges), and patches `status.verification = { passed, mode, reason?, completedAt }`. The agent that produced the work does NOT get to review or contest the verdict — keeping the gate substrate-mediated is what lets it serve as a SOC2-grade post-condition rather than a self-attested check. Three audit events (`verifier.started/completed/failed`) frame the lifecycle for compliance warehouses.

### 3.3 AgentWorkflow — *the durable orchestrator*

A long-running, replayable, side-effect-free decision function. Coordinates AgentTasks. State is rebuildable from event log; survives any pod crash. Backed by Restate (v0.3.2).

```yaml
kind: AgentWorkflow
spec:
  image: ghcr.io/.../research-pipeline:v2.1
  triggers:
    - { kind: schedule, cron: '0 6 * * *' }
    - { kind: webhook, path: /trigger/research }
  capabilityRef: cap-jti-workflow-xyz
status:
  runs: [...]
```

**Why distinct from Agent:** an Agent runs an LLM loop with side effects (tool calls, child spawns, writes). A Workflow runs decision logic — read inputs, choose which children to spawn, await results, decide next. Workflows are pure-ish, deterministic given event log; Agents are not.

This split is what enables crash-safe long-running orchestrations: Workflow code re-executes from event log on restart and reaches the same decision at every step, *without* re-issuing already-completed effects.

**Substrate:** Restate adapter, event-log durable storage, signal/query API.

**Application:** writes Workflow code in one of the supported AgentWorkflow runtimes (TS / Python).

### 3.4 Workspace — *shared scratch FS*

A pre-populated, shared filesystem mounted across multiple AgentTasks in a task tree. Pattern: Tekton Workspaces, SLURM/Lustre, CircleCI workspaces.

```yaml
kind: Workspace
spec:
  source:
    git: { url: ..., ref: main, depth: 1, authSecretRef: { ... } }
  pvc:
    storageClassName: longhorn
    storage: 5Gi
    accessModes: [ReadWriteMany]
  ttl: 24h
  quota:
    maxBytes: 10Gi
status:
  ready: true
  bytesUsed: 1.2Gi
```

Lifetime is pipeline-run (root AgentTask of the consuming tree), not per-task. Same checkout, mounted across N agents — no re-clone storm. RWX storage class required (Longhorn / NFS / Ceph).

**Substrate:** Workspace controller does the initial fetch via init-container, mounts PVC, GCs on root-task completion + ttl. Quota events on > 80%.

**Application:** declares `Agent.spec.workspaceClaims[]`; references by name in `AgentTask.spec.inputs`.

### 3.5 Artifact — *typed output bytes, content-addressed*

Immutable, content-addressed bytes produced by an AgentTask, consumed by downstream tasks (siblings, children, humans, dashboards). Pattern: Bazel remote cache, Nix store, Git pack.

```
URI: cas://sha256:<hex>/<name>
Backend: PVC (v0.2) | MinIO/S3 (v0.3+)
```

Identity is `hash(bytes)`. Two tasks producing identical bytes produce one artifact. Re-running an identical task replays the cached trace, never re-calls the LLM. Content-addressing makes lineage auditable and de-dup automatic.

**Substrate:** CAS controller, GC by reachability, retention policy enforcement, `read_artifact(uri)` built-in tool.

**Application:** `write_artifact` + `read_artifact` built-ins; declared in `Agent.spec.outputs`.

### 3.6 Capability — *sealed authority token*

A JWT signed by the operator's CA. Names every right an AgentTask has: which tools, which models, which artifacts to read, which Agents to spawn, which workspaces to mount, which egress domains.

```jsonc
{
  "iss": "kagent.knuteson.io/operator",
  "sub": "task-uid:abc123",
  "exp": 1735689600,
  "jti": "cap-abc123",
  "aud": ["kagent-substrate"],
  "claims": {
    "tools": ["http_get", "write_artifact", "spawn_child_task"],
    "models": ["gpt-4o", "claude-3.5-sonnet"],
    "spawn": ["summarizer-*", "validator"],
    "read":  ["cas://*", "workspace:seekarc-*"],
    "write": ["cas://", "workspace:seekarc-pr-1234"],
    "egress": ["api.github.com"],
    "tenant": "acme"
  }
}
```

**Composition rule:** spawn produces a child capability ⊆ parent's. Substrate validates at admission. *No application code can re-grant.*

**Why this is the central elegance bet:** capabilities collapse three currently-separate concerns — `allowedChildAgents`, RBAC, secret hygiene — into one primitive. The audit question "can children spawn arbitrary agents?" has a substrate answer: only if `cap.claims.spawn` includes the target name.

**Substrate:** Capability controller mints + signs; admission validates; agent-pod surfaces relevant claims via `get_my_context` tool.

**Application:** never directly handles capability tokens; the substrate threads them.

### 3.7 Event — *pub/sub + blackboard*

The loose-coordination primitive. Two surfaces on one backend (NATS JetStream):

- **Pub/sub:** typed event streams. `Agent.spec.publishes/subscribes`. Decouples broadcast-style flows from explicit child relationships.
- **Blackboard:** task-tree-scoped typed KV. `read_blackboard(key)` / `write_blackboard(key, value)`. Pattern: game AI blackboard.

```yaml
Agent.spec:
  publishes:
    - { topic: research.findings, schema: ... }
  subscribes:
    - { topic: research.priorities, ... }
```

The blackboard is GC'd with the root task. Streams persist according to JetStream retention policy.

**Substrate:** NATS JetStream cluster, typed schemas, capability-gated topic ACLs.

**Application:** publishes findings, subscribes to topics, uses blackboard for sibling-coordinated state.

---

## 4. The three cross-cutting concerns

These cut across every primitive. Each is a substrate-level concern, not an application one.

### 4.1 Identity

Every workload carries a SPIFFE SVID. Every gateway/inter-substrate call is mTLS-authenticated. Every Capability is signed by the operator's CA, rotated on a schedule, revocable.

No bearer token in env. No shared secret across pods.

Lands across `v0.1.8-secret-hygiene` (interim shared-secret-hardening), `v0.3.0-capabilities` (per-Agent identity), `v0.4.3-identity` (full SPIFFE).

### 4.2 Quota

Hierarchical: org → tenant → Agent. Compute (CPU/memory), gateway in-flight, artifact storage, workspace storage — all subject to the cascade. Quota breach is a substrate-level event with audit trail.

Lands in `v0.2.1-workspaces` (storage), `v0.3.0-capabilities` (in-flight implicit in cap), `v0.5.2-quotas` (full hierarchical model).

### 4.3 Audit

Every substrate decision — admission accept/reject, capability mint, secret access, spawn, completion, contract violation, quota breach — emits a [CloudEvents](https://cloudevents.io/)-shaped record on the audit stream. The stream is append-only, optionally cryptographically signed for SOC2 compliance.

Backbone: NATS JetStream `audit` stream. Consumers: log warehouse (Loki, Splunk, Elastic), real-time alerting, compliance reporting.

Lands in `v0.1.15-audit-stream` (foundation, before Capabilities depend on it).

---

## 5. Composition rules

These are what make it feel like an architecture, not a feature list.

| Rule | What it gives you |
|---|---|
| **Capabilities flow downward, narrowing only.** Substrate-enforced. | Spawn auth answered at substrate level; no escalation possible. |
| **Artifacts are content-addressed.** Identity = hash. | Free dedup, free cache, automatic lineage, idempotent re-runs. |
| **Owner references propagate.** Root task → workflows → child tasks → workspaces → artifacts (per retention). | One delete, whole subtree dies. No orphans. |
| **Identity authorizes, not tokens.** SVID + cap claim. | No bearer leaks. Per-pod attribution. |
| **Schema declared at design, instantiated at runtime.** Agent → AgentTask, like Tekton Task → TaskRun. | Type-checked dataflow. Admission catches misuse. |
| **Failures are loud and substrate-attributed.** Contract violation → fail fast, structured cause, audit event. | No silent degradation. Debug-able outages. |
| **Primitives are orthogonal.** Workspace ≠ Artifact ≠ Cache ≠ Blackboard. | No conflation. Each does one thing. |

If a proposed feature breaks any of these rules, it does not belong in the substrate — it belongs in an application or in a separate substrate (like the model gateway).

---

## 6. Mapping the v0.1.x audit gaps

Every concrete gap raised in the audit maps to exactly one primitive or cross-cutting concern. This is the test that the substrate is "complete enough":

| Audit gap | Primitive / concern | Lands in |
|---|---|---|
| Tree depth unbounded | Capability (depth claim) | v0.1.9 (interim) → v0.3.0 (substrate) |
| Transitive fan-out unbounded | Capability + Quota | v0.3.0 + v0.5.2 |
| Spawn auth only in agent-pod tool | Capability | v0.3.0 |
| Payload provenance / scrubbing | Identity (per-Agent claim) + Capability | v0.3.0 |
| 1h Job TTL too long | (operational) | v0.1.9 |
| Parent→child AgentTask cascade missing | AgentTask (owner-ref) | v0.1.9 |
| Plaintext API key in Job env | Identity | v0.1.8 → v0.4.3 |
| `KAGENT_AGENT_SPEC` env JSON | AgentTask (typed mount) | v0.2.0 |
| No Workspace primitive | **Workspace** | v0.2.1 |
| No `read_artifact` tool | **Artifact** | v0.2.2 |
| No `get_my_context` introspection | AgentTask (substrate API) | v0.1.9 |
| No `verify_completion` hook | AgentTask + Capability | v0.3.0 schema; v0.1.7-rig.2 reconciler runner |
| backoffLimit retry double-spawn | AgentTask + Capability (idempotency) | v0.2.0 |
| Pod-pressure circuit breaker | Quota | v0.5.2 |
| Multi-tenancy | (Tenant primitive) + Capability | v0.5.0 |
| Egress controls | Capability (egress claim) → NetworkPolicy | v0.5.1 |
| Audit / SOC2 | Audit | v0.1.15 + ongoing |
| Secret rotation | Identity | v0.5.4 |
| Webhook + scheduler entry points | (trigger system) | v0.1.16 |
| Spec versioning + migration | Agent (immutable + versioned) | v0.5.3 |

If a future concern doesn't map onto this table, **first** check whether it belongs in the model gateway (probably). **Second** check whether it's an application concern. **Third** consider whether it's a missing primitive — a high bar.

---

## 7. What v1.0 enables for an enterprise consumer

Without writing substrate code:

- **Multi-tenant SaaS** — substrate-enforced isolation via Tenant + Capability scoping
- **SOC2-ready audit trail** — every action, capability use, secret access on the audit stream
- **Reproducible agent runs** — same inputs → same outputs (CAS)
- **Disaster recovery** — workflows replay from event log; artifacts rebuild from CAS; capabilities re-issue from CA
- **Compliance-required egress controls** — `Agent.spec.egress` → NetworkPolicy
- **Zero-downtime key rotation** — SVID + JWT issuer at substrate level
- **Spec evolution with in-flight safety** — versioned Agents, pinned task→Agent version
- **Plug-and-play model gateway** — swap LiteLLM → enterprise gateway → OpenRouter direct via one config line
- **Pluggable storage** — Workspace PVC backend swappable; CAS backend swappable (PVC, MinIO, S3, Ceph)
- **Cross-system attribution** — every gateway request joins to a kagent task UID via headers + traceparent

---

## 8. What v1.0 explicitly does NOT include

The substrate stays small. These belong in applications (or in pluggable adapters), not in the substrate:

- ❌ A built-in agent SDK (agents run any framework — agent-loop, Strands, Mastra, raw)
- ❌ A model gateway (substitutable; see GATEWAY-CONTRACT.md)
- ❌ Domain-specific tools (researchers, summarizers, validators) — application code
- ❌ Workflow DAG languages (use AgentWorkflow + the runtime's own host language)
- ❌ Streaming response support (out of scope until a real consumer drives it)
- ❌ Cluster-wide policy engines (OPA / Kyverno are excellent companions, not substitutes)
- ❌ Kubernetes-managing agents (Solo.io's kagent.dev domain; we are different)

---

## 9. Release waves

The path from v0.1.7 (today) to v1.0:

| Wave | Tag range | Focus | Approximate weeks |
|---|---|---|---|
| 0 | v0.1.7 → v0.1.16 | Hardening + audit foundation + entry points | 3-4 |
| 1 | v0.2.0 → v0.2.2 | I/O contracts (typed I/O, Workspace, CAS) | 5-6 |
| 2 | v0.3.0 → v0.3.2 | Authority + lifecycle (capabilities, supervision, workflows) | 6 |
| 3 | v0.4.0 → v0.4.4 | Coordination at scale (events, blackboard, cache, SPIFFE, locality) | 5 |
| 4 | v0.5.0 → v0.5.4 | Tenancy + compliance | 5 |

Each release tag is one git commit cluster, atomic, with conventional commits and a tag artifact. See [`ROADMAP.md`](./ROADMAP.md) for the per-release task slate.

---

## 10. Versioning + change policy

This document is versioned semver alongside the kagent repo. Changes to:

- The set of primitives (adding/removing) → **major bump** (v2.0 territory)
- Composition rules → **major bump**
- Per-primitive schema (additive) → **minor bump**
- Cross-cutting concern semantics → **minor bump** unless it breaks composition rules

Substrate primitives are ratified here. Anything not in this document is implementation detail and may change unilaterally between minor versions.

---

## 11. The mental model

If you remember nothing else: the substrate is **seven primitives, three cross-cutting concerns, and one external boundary (the model gateway).** Every substrate-level question — what runs, with what authority, sharing what data, supervised how, observed how — answers to one of those. If a question doesn't, it's either an application concern or it's pointing at a missing piece this document needs to grow.
