# Model Routing — `Agent.spec.modelClass`

**Date:** 2026-05-06
**Status:** Design proposal, ratified for `v0.1.8-modelclass.0`
**Owner / scope:** v0.1.8 — substrate-level. One new field, one config map, no new CRD.

> Read [`SUBSTRATE-V1.md`](./SUBSTRATE-V1.md) §3.1 (Agent primitive) and
> [`RESILIENT-CONTRACTS.md`](./RESILIENT-CONTRACTS.md) §1.3 first.
> This doc describes how the substrate decouples Agent definitions
> from the physical model behind them — so a homelab operator can swap
> from `nemotron-3-nano:4b` to `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`
> by editing **one** chart value, not N Agent CRs.

---

## 1. Problem statement

Today every `Agent` CR carries a required, literal model string:

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: Agent
metadata:
  name: orchestrator
spec:
  model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct'   # required, literal
  systemPrompt: ...
```

`spec.model` is plumbed straight through the operator's `job-spec`
builder into `KAGENT_AGENT_MODEL` (env on the spawned Pod), which
the agent-pod's `runner.ts` hands verbatim to LiteLLM / the LLM
gateway. The string is opaque to the substrate; the gateway parses
the LiteLLM provider prefix and routes.

This works. It is also the wrong layer.

### 1.1 The coupling cost — concrete

Right now (2026-05-06) the homelab `kagent-system` demo set runs on
`nemotron-3-nano:4b` (LM Studio at `192.168.68.60:1234` is the warm
inference endpoint). The RC-pilot set runs on
`workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct` (Cloudflare AI
Gateway). `RESILIENT-CONTRACTS.md` shows nemotron-nano-4B emits
free-text tool calls; the right move is to switch the orchestrator
to llama-4-scout. Today that means editing the four
`kagent-system/*.yaml` Agent CRs one at a time, committing, pushing,
waiting for Argo — every Agent's `spec.model` is its own
physical-model string. Multiply by the rc-pilot set, the
`examples/`, and any future consumer's manifests, and the substrate
has the coupling problem Kubernetes services solved in 2014: every
caller hard-codes the endpoint of the callee.

To swap from `nemotron-3-nano:4b` to `workers-ai/llama-4-scout` for
the orchestrator agent, we'd have to edit one manifest at the leaf
— but only because we already accept this is the wrong layer; in a
healthy substrate the swap is a single line in the cluster config.

### 1.2 Why this is a substrate problem, not a YAML one

The same Agent is reusable across deployments. `homelab-orchestrator`,
`ai-interviewer/SeekArc`, and a hypothetical enterprise consumer all
want the *same logical agent* — "a tool-calling orchestrator" — but
with **different physical models** (CF-hosted Llama 4 Scout, hosted
GPT-4o through an enterprise gateway, an air-gapped vLLM serving
Llama 3.3 70B). If "the model" is a property of the Agent CR, every
consumer either forks the manifests, Kustomize-patches them, or
accepts model lock-in. None match the substrate's "ship a primitive,
compose at the cluster layer" pitch.

---

## 2. The primitive — `Agent.spec.modelClass`

A new optional CRD field: `spec.modelClass: string` — a logical
**capability tier**, not a physical model.

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: Agent
metadata:
  name: orchestrator
spec:
  modelClass: tool-caller-default              # logical
  systemPrompt: ...
  tools: [spawn_child_task]
```

**Validator rules** (admission webhook + CRD `x-kubernetes-validations`):

- `modelClass` is a string, non-empty, ≤ 64 chars,
  matching `^[a-z][a-z0-9-]*$` (DNS-label-ish; lowercased; no underscores).
- The pre-existing `spec.model` stays optional, free-form (LiteLLM
  prefix already enforced upstream by the gateway, not by the
  operator — keep it that way).
- **At least one** of `spec.model` or `spec.modelClass` MUST be set.
  Admission rejects an Agent with neither; the rejection message
  names both fields and the cluster's known classes.
- **If both are set,** `spec.model` wins (escape-hatch precedence,
  see §3). Admission accepts the combination and emits a `WARN` audit
  event so a cluster operator can see Agents that bypass the class
  layer.
- The class string itself is **not validated against the cluster's
  configured classes at admission time**. Resolution is deferred to
  AgentTask materialization (§3) so that adding a new class via Helm
  doesn't require re-admitting every Agent CR.

The validator additions land in `packages/operator/src/crds/agent.ts`
(Zod schema) and the OpenAPI v3 schema baked into
`packages/operator/charts/kagent-operator/crds/agent.yaml`.

---

## 3. Resolution model

Resolution is **operator-side, at AgentTask materialization** — the
moment the operator's reconciler builds the Job spec for a freshly
admitted AgentTask. Not at admission time. Not at request time at
the gateway. The operator is the only place that has both:

- the Agent CR (with `model` and/or `modelClass`), and
- the cluster's class-to-physical-model map (a Helm-values structure
  loaded at operator boot, refreshed on chart upgrade — see §4).

### 3.1 Order of precedence

```
1. spec.model            — wins if set (escape-hatch, §6)
2. spec.modelClass       — resolved against cluster config
3. neither set           — admission error (already prevented)
4. modelClass set, no map entry — Job-spec build error → AgentTask
                                  Failed with reason
                                  'unresolvable_model_class: <class>'
```

Behavior 4 is loud-on-purpose. The substrate refuses to silently
fall back to a "default model" — that would be the same coupling
sin one level deeper. If the cluster operator removed a class from
the map but Agents still reference it, the next AgentTask for that
Agent fails terminally with a structured reason and an audit event
(`agent.task.unresolvable_model_class`). Workbench surfaces it.
The fix is on the cluster operator's plate, not the Agent author's.

### 3.2 What the operator writes

After resolution, the operator's `job-spec` builder writes a single
env var on the Pod (`KAGENT_AGENT_MODEL=<physical>`). The agent-pod's
`runner.ts` reads it exactly as it does today. **The agent-pod has
no awareness of `modelClass`.** Class-to-physical resolution stays
at the operator layer; the Pod sees a literal string. This keeps
the agent-pod's contract unchanged across the v0.1.8 boundary,
which matters for the Bun revert plan (CLAUDE.md: the agent-pod
runtime is the most-touched boundary in this codebase).

Per-AgentTask audit emission (one line, on the existing CloudEvents
stream — `SUBSTRATE-V1.md` §4.3):

```
event: agent.task.model_resolved
fields: { taskUid, agentName, source: 'modelClass' | 'model',
          modelClass: <class or null>, resolvedModel: <physical> }
```

Cluster operators answer "which Agents are pinned with `model:`?"
with one query against the audit warehouse.

### 3.3 Why not gateway-side resolution

Tempting alternative: ship `modelClass` as a body field and let the
gateway decode. Rejected for v0.1.8 — the gateway is substitutable
by design (`SUBSTRATE-V1.md` §2, `GATEWAY-CONTRACT.md`); pushing
resolution into it means every substitute (LiteLLM, OpenRouter,
enterprise gateway) reimplements it, and the per-task audit trail
moves off-substrate. The operator already knows the Agent CR;
resolving where the data is is the cheaper move.

---

## 4. Cluster-side configuration

The class map is a Helm value on the operator chart. Each entry's
value is an **object**, not a bare string — that's deliberate so
the shape is forward-compatible with §7's heavier alternatives.
v0.1.8 reads only `.model`; unknown sub-fields are tolerated.

**Homelab values** (workers-ai for tool-callers; local Ollama for
text generation):

```yaml
# packages/operator/charts/kagent-operator/values.yaml (excerpt)
agent:
  modelClasses:
    tool-caller-default:
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct'
    text-generator-default:
      model: 'ollama/nemotron-3-nano:4b'
    reasoner-default:
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct'
      # reserved for v0.2 — see §7:
      # endpointSelector: { tier: hot }
      # constraints: { maxTokens: 4096 }
```

**Cloud / enterprise values** (managed gateway → strict-tool-use
models):

```yaml
agent:
  modelClasses:
    tool-caller-default:     { model: 'openai/gpt-4o' }
    text-generator-default:  { model: 'anthropic/claude-3-5-haiku-latest' }
    reasoner-default:        { model: 'anthropic/claude-3-7-sonnet-latest' }
```

The chart projects this map into the operator deployment's pod env
as `KAGENT_AGENT_MODEL_CLASSES_JSON` (a JSON-encoded blob, see
`packages/operator/charts/kagent-operator/templates/deployment.yaml`).
The operator parses it once at boot via `parseModelClassesEnv`
(`packages/operator/src/main.ts:206`) and panic-rejects malformed
entries loudly (operator boot fail → restart → fail again; the
chart's `helm install --wait` smoke test catches this in CI).

> **No hot-reload.** Updates to `agent.modelClasses` require an
> operator pod restart via `helm upgrade` and the operator
> deployment rollout. There is no ConfigMap watch, no SIGHUP
> handler, and no `templates/configmap-model-classes.yaml` —
> the env-baked-at-boot path is the only path. In-flight Job pods
> continue using the value baked into their env at spawn time and
> are unaffected by chart upgrades; only newly-dispatched pods see
> the new map. See `docs/CONTEXT-AWARENESS.md §7` for the same
> caveat applied to `contextWindowTokens`.
>
> A ConfigMap-watch path (matching the audit-stream config pattern)
> is queued as a separate v0.2 task; the chart-values shape is
> already forward-compatible with it.

---

## 5. Naming convention — `<role>-<tier>`

Class names follow `<role>-<tier>`. **Role** is what the agent
*does* in tool-shape terms; **tier** is what the cluster operator
*paid for*.

v0.1.8 ships with three roles and one tier (`default`):

| Class                      | Role             | Intended use                                                 |
|----------------------------|------------------|--------------------------------------------------------------|
| `tool-caller-default`      | tool-caller      | Orchestrators, agents that emit `tool_calls[]`. Strict-tool-use-capable model strongly recommended (see RESILIENT-CONTRACTS.md §2(e)). |
| `text-generator-default`   | text-generator   | Summarizers, writers, distillers. No tool-call requirement. Smaller / cheaper models OK. |
| `reasoner-default`         | reasoner         | Multi-step reasoning, planning. Placeholder in v0.1.8; identical to `tool-caller-default` in the homelab values until a chain-of-thought-tuned model is wired. |

**Tiers** that appear in later phases (`<role>-cheap`, `<role>-fast`,
`<role>-strict`) are deliberately out of scope for v0.1.8 — they
add a per-call decision the substrate can't yet make
without §7's endpoint-capabilities work. A consumer who wants
tier-fanout today writes two classes (`summarizer-fast` mapping to
Haiku, `summarizer-strict` mapping to Opus) and references each by
name. That works fine; the convention just nudges the names.

**Vision and audio roles** (`vision-default`, `audio-default`) are
likewise reserved for when the substrate grows the matching
`Agent.spec.modalities` field. Don't introduce them in v0.1.8.

**Anti-pattern.** Names like `nemotron-class` or `llama4-scout-class`
are forbidden — they leak the physical model into the logical layer
and reproduce the coupling we're removing. Admission does NOT
enforce this (the validator only checks the regex); it's a code-review
norm, called out in `examples/*/README.md`.

---

## 6. Backward compatibility — the escape-hatch

`spec.model` becomes optional but does not disappear. Two cases keep
needing it:

1. **The pre-v0.1.8 manifest fleet.** Every existing Agent in
   `examples/`, `kagent-system/`, and external consumers has
   `spec.model: <literal>`. Those manifests work unchanged. Phase 4
   migrates them, but the operator does NOT require migration —
   pinned-model Agents are valid forever.
2. **The genuine override.** Reproducibility regression tests
   (`gpt-4o-2024-08-06`), experimental-model agents whose whole point
   is the new model, vendor-specific eval agents
   (`anthropic/claude-3-7-sonnet-20250219` against a frozen build).
   For these, set `spec.model: <literal>` directly. The operator
   emits a `WARN` audit event (`agent.created.pinned_model`) so a
   cluster operator can periodically grep for un-classed Agents, but
   the substrate doesn't block them.

The precedence in §3.1 makes the escape-hatch explicit. Setting
`model:` to `null` while `modelClass` is set is treated identically
to `model:` being absent (the YAML form most CRD writers end up with).

> **Context-awareness caveat (audit-rev2 NM1).** Agents using literal `spec.model` (the escape-hatch) do **not** receive `KAGENT_AGENT_MODEL_CONTEXT_WINDOW`. The 95% substrate safety-net AND the `context_pressure_ignored` detector are no-ops for these pods because `resolveAgentModel` returns `source: 'override'` with `contextWindowTokens: undefined` (per `packages/operator/src/model-class-resolver.ts:144-145` and the explicit design decision in `CONTEXT-AWARENESS.md` §9 Q5). A cluster that migrates most Agents to `modelClass` but leaves a few pinned (e.g. for reproducibility) gets context-awareness on the migrated subset only. This is intentional but easy to miss — operators expecting a cluster-wide safety-net should know that pinned-model Agents are silently outside its protection. **Migrate to `modelClass` to enable context-awareness**, or accept the carve-out as a deliberate part of the override path.

### 6.1 Migration table — current Agent CRs

The Phase 4 migration commit changes these manifests in lock-step:

#### `kagent-system/` (4 demo agents)

| Agent name             | Old `model:`           | New `modelClass:`         | Rationale                                                                                  |
|------------------------|------------------------|---------------------------|--------------------------------------------------------------------------------------------|
| `orchestrator`         | `nemotron-3-nano:4b`   | `tool-caller-default`     | Tool-calls via `spawn_child_task`; nemotron-nano-4B fails this per RESILIENT-CONTRACTS §1.2. The class swap is the fix. |
| `summarizer-rust`      | `nemotron-3-nano:4b`   | `text-generator-default`  | No tool-calls; nemotron is fine here.                                                       |
| `summarizer-k8s`       | `nemotron-3-nano:4b`   | `text-generator-default`  | No tool-calls; nemotron is fine here.                                                       |
| `summarizer-postgres`  | `nemotron-3-nano:4b`   | `text-generator-default`  | No tool-calls; nemotron is fine here.                                                       |

After the migration, swapping the orchestrator's model is *one
chart-values edit*: change `agent.modelClasses.tool-caller-default.model`.
The summarizers stay on nemotron. The orchestrator picks up
llama-4-scout. No Agent CR touched.

#### `examples/rc-pilot/01-agents.yaml` (6 RC-pilot agents)

| Agent name                  | Old `model:`                                          | New `modelClass:`         | Rationale                                                                |
|-----------------------------|-------------------------------------------------------|---------------------------|--------------------------------------------------------------------------|
| `rc-pilot-orchestrator`     | `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`  | `tool-caller-default`     | Tool-calls (`spawn_child_task`).                                         |
| `rc-pilot-summarizer`       | `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`  | `text-generator-default`  | No tool-calls; smallest viable summarizer.                               |
| `rc-pilot-artifact-writer`  | `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`  | `tool-caller-default`     | Calls `write_artifact` — tool-caller class.                              |
| `rc-pilot-verifier-gated`   | `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`  | `tool-caller-default`     | Emits structured JSON; until `outputContract` lands (v0.2), the strict-tool-use path is the safer class. |
| `rc-pilot-policy-capped`    | `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`  | `tool-caller-default`     | Tool-calls (`spawn_child_task`).                                         |
| `rc-pilot-bad-tool`         | `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`  | **stays on `model:`**     | Failure-mode test fixture — boot-fail comes from `spec.tools`, not the model. Keep the literal pin so the test stays self-contained. |

The `rc-pilot-bad-tool` exception is intentional. RC-pilot evidence
rows are fixtures; the goal is reproducibility, not abstraction.
Pinning the model keeps the test stable across cluster-config
changes.

The migration is **mechanical** (`yq` one-liner per file). The PR
description in the Phase 4 commit links back to this table.

---

## 7. Forward-compat — alternatives considered

Three alternatives were on the table. Documenting why none of them
is the right v0.1.8 step.

### 7.1 `ModelAlias` CRD

A cluster-scoped CR mapping logical name → physical model.
`Agent.spec.modelClass` would reference the CR by name; the operator
resolves the chain.

**Why not v0.1.8:** new CRD, new RBAC surface, new controller
responsibility, new admission ordering concern (an Agent admitted
before its alias is invalid — do we wait? do we GC?). That's the
right shape for "runtime alias swaps without chart redeploys," but
we have N=0 consumers asking for it (Argo applies chart diffs in
seconds). Revisit in v0.3+ for multi-tenant clusters needing
per-tenant aliases. The v0.1.8 ConfigMap is **trivially upgradable**
when that day comes — the map entry shape and the CR `spec` shape
are deliberately the same (`{ model: <physical>, ... }`), so a
future operator can read both with the CR winning.

### 7.2 Capabilities on `ModelEndpoint` + requirements on `Agent`

`ModelEndpoint` (v0.1.5-llm-gateway, already exists) grows
`spec.capabilities`; `Agent` grows `spec.modelRequirements`; the
operator picks any matching endpoint.

```yaml
kind: ModelEndpoint
spec:
  model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct'
  capabilities: { strictToolUse: true, contextWindowTokens: 128000 }
---
kind: Agent
spec:
  modelRequirements: { strictToolUse: true, minContextWindowTokens: 32000 }
```

**Why not v0.1.8:** the **most powerful** shape — per-task routing
across a fleet of endpoints — but it forces the **picker tie-breaker
problem**. When three endpoints satisfy the requirements, which
wins? Cheapest? Round-robin? Healthiest by EWMA latency? Tagged by
tenant? Each answer is a substrate policy the rest of the codebase
has to grow consensus on; that's v0.3+ territory (multi-tenant +
cost-aware routing under `SUBSTRATE-V1.md` §3.6).

The `modelClass` step is forward-compatible with this future: a
class becomes a *named bundle of requirements* and the picker
resolves the endpoint. Agents written against v0.1.8's
`tool-caller-default` keep working — the cluster operator just
rewires the class definition.

### 7.3 Why `modelClass` is the right v0.1.8 step

The smallest substrate primitive that decouples Agent definitions
from physical models: one field, one config map, no new CRD, no new
controller. Backward-compatible (existing `model:` manifests work
unchanged). Single config touchpoint. Audit-stream-visible. Forward-
compatible with both §7.1 and §7.2. Operator-side resolution keeps
the gateway contract unchanged. Shipping §7.2 directly forces a
picker-policy decision under deadline; shipping §7.1 directly adds
RBAC + admission complexity for a feature with N=0 consumers.
`modelClass` solves the present pain — manifest churn on a model
swap — and earns the right to add the heavier shapes when data
justifies them.

---

## 8. Out of scope / explicit non-goals for v0.1.8

The following are tempting and DO NOT belong in `v0.1.8-modelclass.0`:

- **A `default` class.** No `agent.modelClasses.default` falling-back.
  Unresolvable classes fail loud per §3.1. A "default" would
  reproduce the coupling problem one level up (every Agent without
  a class silently routes to the same model).
- **Per-tenant class maps.** Tenancy is a v0.5 concern
  (`SUBSTRATE-V1.md` §11). The map is cluster-scoped in v0.1.8.
- **Class-level token budgets / cost limits.** That's
  `runConfig.tokenLimit` / `runConfig.costLimitUsd` per AgentTask,
  not per class. Conflating the two layers prematurely binds
  budget-policy to capability-tier.
- **Class-level prompt scaffolds.** A class is "what model"; a
  prompt is "what to ask." Don't fuse them.
- **Operator-side fallback chains.** No "if `tool-caller-default`
  unavailable, try `tool-caller-cheap`." That's a routing decision
  with multiple valid answers; defer to §7.2's endpoint capabilities
  in v0.3+.
- **Config validation against gateway.** The operator does NOT
  pre-flight the resolved model against the LLM gateway at boot.
  An invalid physical string fails at first-task time with the
  gateway's own error surfaced through the agent-pod's status path
  (already visible per WS-D Phase 4.x). Operator-side pre-flight
  would couple the operator's readiness to the gateway's, which
  the substrate explicitly avoids.

---

## 9. Summary

`Agent.spec.modelClass` is one new optional field, one config map,
and one resolution step at AgentTask materialization. It keeps the
agent-pod contract unchanged, keeps the gateway contract unchanged,
keeps every existing manifest working, and turns a model swap from
"edit N Agent CRs" into "edit one chart value." It is forward-
compatible with both the `ModelAlias` CRD shape (v0.3+) and the
endpoint-capabilities shape (v0.3+) — neither of which is
substrate-justified yet.

The single largest win is operational: every consumer that adopts
the convention can be migrated between physical models — including
between providers — by a cluster operator who never opens an Agent
manifest. That's the substrate primitive earning its keep.

---

### Cross-references

- `packages/operator/src/crds/agent.ts` — Agent Zod schema (add `modelClass`).
- `packages/operator/charts/kagent-operator/crds/agent.yaml` — OpenAPI schema (add `modelClass` + `oneOf` for at-least-one-of-(model, modelClass)).
- `packages/operator/src/job-spec.ts` — wire resolution before env-var emission.
- `packages/operator/src/main.ts:206` (`parseModelClassesEnv`) — parses `KAGENT_AGENT_MODEL_CLASSES_JSON` once at boot. NOT a ConfigMap watcher; rolls forward via operator pod restart on `helm upgrade`.
- `packages/operator/charts/kagent-operator/values.yaml` — `agent.modelClasses` map (Helm values, projected to operator env).
- `packages/operator/charts/kagent-operator/templates/deployment.yaml` — stamps the map into `KAGENT_AGENT_MODEL_CLASSES_JSON` on the operator pod.
- `examples/rc-pilot/01-agents.yaml` — Phase 4 migration target (per §6.1).
- `../new_localai/k8s-kustomized/overlays/production/kagent/demo-resources.yaml` — Phase 4 migration target (per §6.1).
- `docs/SUBSTRATE-V1.md` §3.1 — Agent primitive (this field is additive).
- `docs/RESILIENT-CONTRACTS.md` §1.2 — the nemotron tool-call drift evidence motivating the orchestrator move.
- `docs/CONTEXT-AWARENESS.md §7` — same Helm-upgrade-bakes-at-spawn semantics for `contextWindowTokens`.
- `docs/ROADMAP.md` Wave 0 — the v0.1.8 slot this lands in.
