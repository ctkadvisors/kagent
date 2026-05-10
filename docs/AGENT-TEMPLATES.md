# Agent Templates / On-Demand Specialists

**Date:** 2026-04-26
**Status:** Phase 5 design proposal — substrate primitive only, no v0.1 model change.
**Scope:** Allow an orchestrator agent to dynamically materialize approved specialist Agents (e.g. `summarizer-v3`, `deep-research-v1`) without a human authoring a new `Agent` CRD per specialist, while making it structurally impossible for a prompt-injected orchestrator to spawn a `superuser-shell-agent`.

> Read [`DESIGN-V0.1.md`](./DESIGN-V0.1.md) for the v1alpha1 surface; this proposal extends — does not replace — that model. No changes to `Agent` / `AgentTask` / `AgentCapability` are required to land this primitive.

---

## 1. Motivation

Phase 5's first consumer is the homelab researcher → summarizer chain. The existing `homelab-orchestrator` had to ship every specialist as a hand-edited Agent definition; the orchestrator agent could ask for a `summarizer` but it could not ask for a `summarizer-tuned-for-200-word-output`, because there was no path from "agent decides it needs a slightly different specialist" to "Pod with that spec exists." Two real-world variants of the gap:

1. **Parameterized fan-out.** A research orchestrator wants 7 sub-agents, each summarizing one topic with the topic name baked into the system prompt. Today: 7 hand-written Agent CRDs, or one Agent that re-parses the topic each call (worse traces, worse model perf on instruction-following).
2. **Versioned specialist evolution.** An orchestrator improves its summarizer prompt at run T+1; instead of editing the live `summarizer` Agent (which other tasks may be using), it wants `summarizer-v2` to exist alongside.

The blast radius is the catch. An orchestrator with `create_agent()` capability is one prompt injection away from `model: gpt-4-most-expensive`, `systemPrompt: <attacker-controlled>`, `tools: [shell, exfiltrate]`. The substrate must make it impossible to vary anything that wasn't enumerated as a parameter at template-author time, by a human, in git.

This proposal introduces a substrate primitive — `AgentTemplate` — that an orchestrator instantiates via a tool call. The orchestrator can choose a template and supply only template-defined parameter values; everything load-bearing (model, system prompt, tools, sandbox, budget) is locked at template-author time.

## 2. CRD vs app-owned catalog — pick: CRD

Two designs were on the table:

- **App-owned template catalog.** A JSON/YAML file (or ConfigMap) the orchestrator reads, optionally validated by app code. Lower kagent surface area; no operator schema work.
- **`AgentTemplate` CRD.** A new v1alpha1 Kubernetes resource the operator (and only the operator) consumes when an `ensure_agent_from_template` request arrives. Higher schema cost; persistent, auditable, RBAC-bounded.

**Pick: `AgentTemplate` CRD.** Justification:

1. **RBAC is the load-bearing security boundary.** The whole point of templates is to give an orchestrator a constrained authoring surface. A file-based catalog gives no API-server-enforced trust boundary between "who may add a template" and "who may instantiate one." A CRD lets us bind `create/update/delete agenttemplates` to humans + GitOps service accounts, while binding `agents` `create` to the operator's service account only — the orchestrator agent never holds Agent-create RBAC; it only holds the right to ask the operator (via a tool call) to materialize a template instance. App-owned files cannot enforce this asymmetry.
2. **etcd is the substrate's existing audit log.** Every template add/edit shows up in the K8s audit stream beside every Agent it generates. App-owned files would need a parallel audit pipeline.
3. **GitOps-native.** Templates live under `packages/operator/charts/.../templates/` or in a consumer's `homelab-orchestrator` ArgoCD app — same delivery pipeline as everything else in the substrate.
4. **The "high schema cost" is a one-shot bill.** Once `AgentTemplate` is defined, instantiation cost is one operator endpoint + one materialization function. No ongoing schema churn.

Per [`CLAUDE.md`](../CLAUDE.md): "If a feature would expand the substrate's primitives appropriately ... it belongs here." `AgentTemplate` qualifies — it is the primitive that makes constrained agent authoring possible.

## 3. `ensure_agent_from_template` — tool contract

The operator exposes a small HTTP endpoint (`POST /v1alpha1/templates/{name}:instantiate`) inside the cluster, ServiceAccount-token-authenticated. The agent-pod runtime (`@kagent/agent-loop`) ships a built-in tool that wraps this endpoint:

```jsonc
// Tool name: kagent.ensure_agent_from_template
// Request:
{
  "templateName": "summarizer",          // required; AgentTemplate.metadata.name in pod's namespace
  "instanceName": "topic-rust-async",    // optional; if omitted the operator derives a hash-suffixed name
  "parameterValues": {                   // required (may be {}); MUST be a flat string-keyed map
    "topic": "rust async runtimes",
    "wordBudget": "200"
  }
}
// Response:
{
  "agentName": "summarizer-topic-rust-async-7f3a2b",  // the Agent CRD's metadata.name
  "namespace": "kagent",
  "reused": true,                                      // true = idempotent return of an existing Agent
  "templateRef": "summarizer@v3",                      // template name + spec hash
  "parameterHash": "7f3a2b9c"                          // hash of the canonicalized parameter map
}
```

The orchestrator's next step is to issue an `AgentTask` with `targetAgent: <agentName>`. The substrate already covers everything from there.

**Idempotency:** Two orchestrators calling with identical `(templateName, parameterValues)` (modulo `instanceName` choice) get the same `agentName` back — see §4.

**Failure shape:** validation errors return `400` with a structured `{ code: 'parameter_unknown' | 'parameter_missing' | 'parameter_invalid' | 'template_not_found' | 'budget_exceeded' | 'rbac_denied' | 'cap_exhausted', message }`. This goes back to the orchestrator as a `ToolResult{isError: true, ...}` — same envelope as the `sub_agent_refused` pattern (HARNESS-LESSONS §1.2). The substrate is opinionated about masquerading-as-success.

## 4. Naming + hash strategy

The operator computes:

```
parameterHash = base32(sha256(canonicalJson({...spec.parameterDefaults, ...parameterValues})))[0..7]
agentName     = `${templateName}-${slug(instanceName ?? parameterHash)}-${parameterHash}`
```

- **Canonicalization** sorts keys lexicographically so map-order doesn't change the hash.
- **`parameterDefaults` from the template are included** so adding a default later doesn't silently change the hash for callers who don't pass that parameter.
- **`templateName + parameterHash` is the identity.** Two simultaneous `ensure_agent_from_template` calls with identical args race on K8s `create`; `409 AlreadyExists` is treated as success and the existing object is returned (`reused: true`). Identical to the operator's existing Job-create idempotency in `reconcile.ts`.
- **`instanceName` is a vanity slug** — useful in `kubectl get agents` listings, but the hash suffix is the actual deduplicator. Different `instanceName` with same params still produces the same Agent (the second call is `reused: true` and the operator ignores the suggested instanceName).
- **Cap on revisions.** `AgentTemplate.spec.revisionHistoryLimit` (default `20`) bounds how many materialized Agents may exist for one template at any time; exceeding it returns `cap_exhausted` and forces the GC sweeper (§5) to reclaim before new ones spawn. Prevents an orchestrator-loop bug from creating 10⁶ Agents.

## 5. TTL / ownerRef / GC

Two complementary mechanisms; both default-on:

1. **OwnerRef back to the FIRST AgentTask that materialized it.** When the Agent is created, the operator sets `metadata.ownerReferences = [{ apiVersion: kagent..., kind: AgentTask, name: <createdByTask>, uid: ..., blockOwnerDeletion: false, controller: false }]`. This ties the Agent's lifetime to that AgentTask via Kubernetes garbage collection: when the parent task is deleted (or its TTL expires), kube-controller-manager reaps the Agent.
   - **Why first task only:** subsequent `reused: true` returns do NOT add ownerRefs. We track concurrent users via §5.2 instead. (Multi-ownerRef would block deletion until all parents disappear, which couples unrelated tasks.)

2. **`lastUsedAt` annotation + sweeper.** The operator stamps `kagent.knuteson.io/last-used-at: <RFC3339>` on every `reused: true` return AND on every `AgentTask` reconcile that resolves to this Agent. A periodic sweeper (every 5 min, configurable) deletes Agents where:
   - `metadata.ownerReferences` is empty OR all owners are gone, AND
   - `lastUsedAt` is older than `AgentTemplate.spec.idleTtlSeconds` (default 3600), AND
   - no `AgentTask` in `phase ∈ {Pending, Dispatched}` references this Agent.

3. **Hard TTL escape hatch.** `AgentTemplate.spec.maxAgeSeconds` (optional) — a wall-clock cap regardless of usage. Useful for compliance ("no ephemeral specialist lives more than 24h").

This composes the two best K8s-native cleanup primitives without inventing a finalizer (which would couple deletion ordering across substrates).

## 6. Guardrails — the security contract

These four guardrails are non-negotiable. Each lists the enforcement point.

### (a) Only template-defined parameters can vary

**State:** The template declares `spec.parameters: [{ name, type, allowedValues?, pattern?, required, default? }]`. The orchestrator may supply values ONLY for declared parameters. Model, system prompt, tools, sandboxProfile, capabilities are fields on the template itself — never accepted from the caller.

**Enforce:**
1. The instantiate endpoint rejects any `parameterValues` key not in `spec.parameters` (`code: parameter_unknown`).
2. Each value is validated against `type` + `allowedValues` + `pattern` + length cap (256 chars per value, 32 keys per call — substrate-level DoS guard).
3. The materializer renders the template's `agentSpec` with `${param.X}` substitution using a strictly non-Turing template engine (no JS eval; mustache-without-helpers semantics). System prompt is a string with substitution holes; the orchestrator cannot inject control flow.
4. The validating admission webhook (operator-side) rejects any Agent whose `metadata.annotations['kagent.knuteson.io/template-ref']` is set but whose hash does not match the template's signature — defense in depth against direct kubectl misuse if the operator's RBAC ever leaks.

### (b) Budget ceiling inherits from template

**State:** `spec.budget: { maxIterations, maxTokensPerIteration, maxCostUsdPerRun, maxParallelInstances }`. These are template-author constants; the caller cannot raise them.

**Enforce:**
1. Materialized Agent gets `metadata.annotations['kagent.knuteson.io/budget']: <hash-of-budget-block>`; the agent-pod runtime reads it on boot and seeds `RunBudget` from the annotation, NOT from anything in the AgentTask payload.
2. `@kagent/agent-loop`'s existing `RunBudget` enforces `maxIterations` and `maxCostUsdPerRun` per the existing executor contract — this is the same lever that already stops runaway loops; we just bind its values structurally.
3. `maxParallelInstances` is enforced at the materializer: if the count of Agents-from-this-template currently referenced by `phase ∈ {Pending, Dispatched}` AgentTasks ≥ cap, return `budget_exceeded`. Composes with §4's `revisionHistoryLimit` (one is rate, one is concurrency).

### (c) Tool set is a SUBSET of template's allowlist (intersected with caller scope)

**State:** `spec.toolAllowlist: [string]` is the authoritative ceiling for the materialized Agent's `spec.tools`. The caller cannot expand it. Templates MAY also declare `spec.toolDefaults: [string]` (subset of allowlist) which is what's actually written to the Agent if the parameter set doesn't request a different subset.

**Enforce:**
1. If a parameter of `type: toolSelection` is declared, the orchestrator may pass an array of tool names; the materializer **intersects** that array with `toolAllowlist`. Anything not in the intersection is silently dropped, with the dropped names returned in the response under `droppedTools` so the orchestrator's loop is aware.
2. **Caller-scope intersection (Tool Broker workstream hook).** When the parent task arrives, it carries (in a future header / annotation) the caller's *granted* tool scope. The materializer intersects the template's `toolAllowlist` with the parent's granted scope before applying step 1. Net: a child Agent CAN'T have a tool the parent didn't have. This is the invariant that defeats privilege-escalation-via-template.
3. The reconciler refuses to spawn a Job for an Agent whose `spec.tools` references an unknown tool name (already partially enforced by the planned Tool Broker; this proposal makes it strict for template-materialized Agents).

### (d) Audit fields

**State:** Every materialized Agent carries:

```yaml
metadata:
  annotations:
    kagent.knuteson.io/template-ref: "summarizer@v3"        # name + spec hash
    kagent.knuteson.io/parameter-hash: "7f3a2b9c"
    kagent.knuteson.io/created-by-task: "task-abc123"        # AgentTask UID, not name
    kagent.knuteson.io/created-at: "2026-04-26T18:14:22Z"
    kagent.knuteson.io/budget-hash: "<sha256-of-template-budget>"
  ownerReferences: [...]                                     # see §5
```

**Enforce:**
1. The materializer ALWAYS writes these. The validating admission webhook rejects any Agent that has `template-ref` set but is missing the other three (defense against tampering).
2. Trace events for every instantiate call go through the OTel exporter wired in Phase 3 — Langfuse becomes the queryable history of "who spawned what specialist when, hashed under what template revision."
3. `kubectl get agents -o custom-columns=NAME:.metadata.name,TEMPLATE:..annotations.template-ref,PARAMS:..annotations.parameter-hash,PARENT:..annotations.created-by-task` is the audit query.

## 7. Example

### `AgentTemplate` (authored by a human, in git)

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: AgentTemplate
metadata:
  name: summarizer
  namespace: kagent
spec:
  templateVersion: 3                         # bumped when a human edits the template
  revisionHistoryLimit: 20
  idleTtlSeconds: 3600
  parameters:
    - name: topic
      type: string
      pattern: "^[a-zA-Z0-9 _-]{1,80}$"
      required: true
    - name: wordBudget
      type: integer
      allowedValues: [100, 200, 400]
      default: 200
  budget:
    maxIterations: 6
    maxCostUsdPerRun: 0.05
    maxParallelInstances: 50
  toolAllowlist: ["fetch_url", "web_search"]
  toolDefaults:  ["fetch_url"]
  agentSpec:                                 # fed into the Agent CRD's spec verbatim, after substitution
    model: "workers-ai/@cf/meta/llama-3.3-70b-instruct"
    sandboxProfile: default
    systemPrompt: |
      You summarize the topic "${param.topic}" in approximately ${param.wordBudget} words.
      Cite sources you actually fetched. Do not narrate process.
```

### Generated `Agent` (operator-authored, on instantiate)

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: Agent
metadata:
  name: summarizer-topic-rust-async-7f3a2b
  namespace: kagent
  annotations:
    kagent.knuteson.io/template-ref: "summarizer@v3"
    kagent.knuteson.io/parameter-hash: "7f3a2b9c"
    kagent.knuteson.io/created-by-task: "f1c2..."
    kagent.knuteson.io/created-at: "2026-04-26T18:14:22Z"
    kagent.knuteson.io/budget-hash: "..."
  ownerReferences:
    - apiVersion: kagent.knuteson.io/v1alpha1
      kind: AgentTask
      name: research-rust-async-2026-04-26
      uid: f1c2...
spec:
  model: "workers-ai/@cf/meta/llama-3.3-70b-instruct"
  sandboxProfile: default
  systemPrompt: |
    You summarize the topic "rust async runtimes" in approximately 200 words.
    Cite sources you actually fetched. Do not narrate process.
  tools: ["fetch_url"]
```

## 8. Open questions

1. **Validating admission webhook vs operator-internal check.** Defense-in-depth (admission webhook) requires cert mgmt + a webhook server in the operator pod. Cheaper alternative: rely on RBAC denying everything-but-operator from creating Agents, plus operator-internal validation. Pick at implementation time based on threat model — homelab probably skips the webhook; multi-tenant cloud must have it.
2. **Tool Broker scope-passing protocol.** §6(c) intersects with the parent's granted scope, but the channel for that ("future header / annotation") is undefined here. Should land alongside the Tool Broker workstream — likely an annotation on the parent AgentTask written by the orchestrator at delegation time.
3. **Template versioning — semver vs monotonic int.** Above example uses `templateVersion: 3`; could be `1.4.2`. Monotonic int is simpler and matches existing K8s `revisionHistoryLimit` semantics. Defer until a real consumer asks for breaking-change semantics within a template.
4. **Cross-namespace templates.** v0.1: same-namespace only (operator looks up template in the pod's namespace). Cross-namespace would need an explicit allowlist on the template. Defer to v0.2.
5. **Template parameter types beyond string/int/toolSelection.** `enum`, `boolean`, `secret-ref` (read-only mount of an existing K8s secret) all plausible; ship the minimum that the researcher → summarizer chain requires, expand on demand.
6. **Hot-reload semantics.** Bumping `templateVersion` on the AgentTemplate produces a new effective hash for new instantiations, but already-materialized Agents keep their pinned spec. Open question: should the GC sweeper aggressively reclaim "old-template-version" Agents on idle? Probably yes, behind a flag.

---

**Bottom line:** `AgentTemplate` is the smallest substrate primitive that makes constrained dynamic specialist creation safe. It introduces one new CRD, one operator endpoint, and one in-pod tool — and structurally forecloses the prompt-injection blast radius by making "what can vary" a human-author-time decision in git, not a runtime decision the LLM can drift.

---

## Promotion via review queue (Phase 4)

Candidate AgentTemplates produced by agents (DISP-02 `proposalScope.mayProposeAgainst: ['templates']` allowed) are carried as `ArtifactRef`-shaped blobs at rest. The producing AgentTask carries the annotation `kagent.knuteson.io/template-candidate: "true"`; the artifact's media type is `application/x-kagent-template-candidate+yaml`.

The candidate surfaces as a row in the workbench-api review-queue projection (`GET /api/review-queue`, `reason: "candidate-template"`). An operator-reviewer's `POST /api/review-queue/:namespace/:name/accept` parses the artifact YAML against `AgentTemplateSpec` and creates the new `AgentTemplate` CR via the existing operator-write path. The promoted CR carries `metadata.ownerReferences` to the producing AgentTask and `metadata.annotations["kagent.knuteson.io/promoted-from-task"] = "<ns>/<name>"`. The audit-event log records `review.accepted` + `template.candidate.promoted` (Phase 4 / REV-02).

Single-reviewer scope per Phase 4. Multi-reviewer flows (signed quorum, no-self-review, ring-review detection) are future research per `.planning/REQUIREMENTS.md` §4 (`CoalitionProposal`).

See `.planning/phases/04-review-queue-projection-promotion-path/04-CONTEXT.md` for the full decision corpus (D-01..D-04).
