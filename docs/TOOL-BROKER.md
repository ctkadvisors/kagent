# Tool Broker + Policy Boundary

**Date:** 2026-04-26
**Status:** Design (Phase 5 substrate primitive — design-only, no wiring)
**License:** MIT

> Read [`DESIGN-V0.1.md`](./DESIGN-V0.1.md) §4.2 and [`HARNESS-LESSONS.md`](./HARNESS-LESSONS.md) §1 first. This doc scopes the policy boundary that MUST land before tool providers are wired into `agent-pod/src/runner.ts`.

## 1. Motivation — the LLM-RCE risk we will not ship into

The agent-pod runner is chat-only today (`runner.ts:60-122`). Tool providers in `packages/{in-process,mcp,http}-tool-provider/` exist as freestanding `ToolProvider` impls but are NOT wired in. The temptation, on Phase 5, will be to lift them straight in — read `Agent.spec.tools[]`, hand the names to a `ToolProviderRegistry`, let the loop dispatch.

That shape is an LLM-driven RCE waiting to happen:

- `mcp-tool-provider` spawns subprocesses (`provider.ts:166-203`). An LLM that can choose `command + args` chooses its own process.
- `http-tool-provider` accepts arbitrary `path` + `body` and forwards bearer tokens (`provider.ts:139-193`). An LLM that can shape arguments freely can exfiltrate auth, hit `kubernetes.default.svc`, hit the NATS admin port, hit the LiteLLM virtual-key issuance endpoint.
- `in-process-tool-provider` runs JS handlers in-process (`provider.ts:112-135`). Whatever the operator registers, the LLM invokes with arbitrary args.

`HARNESS-LESSONS.md` §1.3 (methodology fabrication) and §1.4 (tool-use omission) all observe an LLM choosing tools poorly. We must not also let a poor choice be a privileged choice. **The substrate's job is to make "LLM picks a tool" a within-policy event before dispatch, not an after-the-fact detector event.**

## 2. Proposed model — `ToolBinding` CRD

Two alternatives considered:

**(a) Inline on `Agent.spec.tools[]`.** Loses on reuse (every Agent re-declares tool config), auth surface (Agent CR becomes the place secrets land), and GitOps blast radius (editing Agent restarts pods).

**(b) Separate `ToolBinding` CRD that links Agents ↔ tool definitions.** Wins on reuse, separates the WHO from the WHAT, mirrors `RoleBinding`. **Recommended.**

### 2.1 CRD shapes

`ToolDefinition` is the cluster-scoped registry of installed tools:

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: ToolDefinition
metadata:
  name: web-fetch
spec:
  provider: http                   # 'http' | 'mcp-stdio' | 'in-process'
  description: Fetch a URL and return its body.
  inputSchema:                     # JSON Schema; passed verbatim to LLM
    type: object
    required: [url]
    properties:
      url: { type: string, format: uri }
  http:                            # operator-supplied; NEVER visible to LLM
    method: GET
    urlTemplate: '{url}'           # only the schema-permitted args substitute
    egressClass: public-internet   # see §6
    authSecretRef: { name: web-fetch-auth, key: bearer }
  argumentPolicy:                  # checked BEFORE dispatch, REJECTS on miss
    - field: url
      kind: regex
      allow: ['^https?://(?!169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|kubernetes\.default).+']
  tags: [read-only, network]
```

`ToolBinding` grants a tool to one or more agents:

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: ToolBinding
metadata: { name: researcher-web-fetch, namespace: agents }
spec:
  toolRef: { name: web-fetch }
  subjects:
    - { kind: Agent, name: researcher }
    - { kind: AgentSelector, matchLabels: { capability: research } }
  modelTierPolicy: { minTier: standard }     # 'cheap' | 'standard' | 'opus'
  argumentPolicy:                            # ANDs with ToolDefinition policy
    - field: url
      kind: regex
      allow: ['^https://(arxiv\.org|nytimes\.com)/.*']
  perTaskBudget: { maxInvocations: 20 }
```

`ToolDefinition` is the cluster-wide catalog (think `ClusterRole`); `ToolBinding` is the namespace-scoped grant (think `RoleBinding`). Auth, URLs, subprocess commands, MCP transports — all live in `ToolDefinition.spec.<provider>` which the agent pod reads from a downward-API mount, not from the `Agent` CR.

## 3. Allowlist algorithm

At `AgentTask` dispatch the operator computes:

```
effectiveTools(agent, task) :=
  bindings := ToolBindings where
    any subject matches agent
    AND modelTierPolicy.minTier <= tier(agent.spec.model)
    AND parentSubsetCheck(task)             # see §7.b
  for each binding:
    def := ToolDefinition[binding.toolRef]
    yield ResolvedTool(
      descriptor:     { name, description, inputSchema },     # LLM-visible
      providerConfig: def.spec.<provider>,                    # operator-only
      argPolicy:      def.argPolicy ∧ binding.argPolicy,
      budget:         binding.perTaskBudget
    )
```

The resolved set is materialized as a per-task `ConfigMap` (or downward-API JSON volume) the agent-pod reads at boot. The pod's `ToolBroker` (a thin wrapper `ToolProviderRegistry` delegates through) checks `argPolicy` on every `executeTool` call BEFORE handing it to the underlying provider. Policy miss → `ToolResult{isError: true, content: "policy_denied: <reason>"}` — same shape as a refusal, observable in trace, the LLM sees a structured no.

**Stacking:** tier policy AND subject match AND parent-subset AND argument policy. All must allow; none alone grants.

## 4. Code-execution sandbox boundary

When (later) we add a `code_execute` tool:

1. `ToolDefinition.spec.codeExec` declares `runtime: bubblewrap | firecracker | sub-pod`.
2. The agent pod itself never `exec`s — it only talks to the broker.
3. **`runtime: sub-pod`** — broker creates an ephemeral `Job` in `kagent-sandbox-<taskId>` namespace with `runtimeClassName: kata`, no SA token, NetworkPolicy `deny-all-egress`, ReadOnlyRootFilesystem, RAM cap, 30s `activeDeadlineSeconds`. Code arrives via Secret/stdin; output via logs.
4. **`runtime: bubblewrap`** — sidecar in the agent Pod owns code-exec, exposes a localhost-only HTTP socket; broker is the only caller.
5. v0.1: code-exec is OUT OF SCOPE. v0.2 evaluates Bubblewrap-sidecar (lighter) vs sub-pod (cleaner blast radius). Firecracker pool stays deferred for true untrusted-multitenant code.

## 5. Browser tool boundary

Playwright/Chrome will not run in the agent pod itself. Two pool models:

- **Per-task ephemeral (v0.1 default):** broker spawns a `playwright/chrome` sidecar container in the agent's Pod. Profile dies with the Job.
- **Per-Agent warm pool (v0.2 opt-in):** `Deployment` of N pods labelled `kagent.knuteson.io/browser-pool: <agentName>`, fronted by Service. Broker proxies CDP. Faster cold-start; complicates isolation. Lands as `BrowserToolBinding.spec.warmPool: { replicas: N }` when measured cold-start hurts.

Browser sidecar egress uses the **same** NetworkPolicy primitive as §6 — the browser is just a tool consumer of an `egressClass`.

## 6. Network egress policy

NetworkPolicy per egress class, applied to the agent Pod via labels:

| egressClass | Allowed | Use |
|---|---|---|
| `none` | nothing | default for unbound agents |
| `litellm` | LiteLLM Service ClusterIP | every agent (model calls) |
| `nats` | NATS Service ClusterIP | A2A agents |
| `langfuse` | Langfuse Service ClusterIP | tracing |
| `public-internet` | 0.0.0.0/0 except RFC1918 + `kubernetes.default` + cluster CIDR | web tools |
| `allowlist:<name>` | named CIDR/host list | scoped HTTP tools |

The operator computes the union of egress classes from the agent's resolved tools and labels the Job's Pod accordingly. NetworkPolicies are pre-installed Helm artifacts keyed on label. v0.1 floor is vanilla NetworkPolicy + label selectors (K3s-native). Cilium L7 (HTTP method/path-aware policy) is a v0.2 nice-to-have if K3s deploys with Cilium.

## 7. The three security invariants — and how the model enforces each

**(a) The LLM cannot grant itself a tool.**
The tool set is computed by the **operator**, server-side, at AgentTask dispatch — from `ToolBinding` CRs filtered by Agent identity, written into a per-task ConfigMap mounted read-only into the pod. The LLM sees only the resolved `ToolDescriptor[]` (name + description + inputSchema). No in-pod surface lets the running loop add a tool. `Agent.spec.tools[]` (existing field) becomes advisory-only — a hint of which tool *names* the Agent intends; the **binding** is what grants.

**(b) Child tasks can only use a SUBSET of parent tools.**
`AgentTask.spec.parentTask` already exists (`crds/types.ts:80`). The operator's reconciler, when dispatching a child, intersects `effectiveTools(child)` with `effectiveTools(parent)`. A child cannot acquire a tool the parent didn't have, even if a `ToolBinding` would otherwise grant it. Capability-routed children inherit the same way. Implementation: store the parent's effective tool name set in `AgentTask.status.effectiveTools` at dispatch; child resolution reads the parent's status. Tamper-resistant — only the operator's RBAC can patch status.

**(c) Tool config (URLs, auth, commands) is plumbed via the operator, never visible to the LLM.**
`ToolDefinition.spec.{http,mcp,inProcess}` carries the secrets-and-URLs (or `secretRef`s). The operator resolves Secret references and writes ONLY the resolved provider config into the per-task ConfigMap — mounted at a path the broker reads, NOT injected into chat history or tool descriptions. The LLM's tool-call args are run through `argumentPolicy` and SUBSTITUTED into a server-side template (`urlTemplate: '{url}'`) — the LLM never writes a full URL, only the templated fields the schema permits. Auth headers are added by the broker after policy passes. The `http-tool-provider`'s existing header allowlist (`provider.ts:107`) backstops accidental auth echo on errors.

## 8. Open questions

1. **Where does `argumentPolicy` evaluate — operator-side admission webhook or in-pod broker?** Pod-side is simpler; operator-side is more defensible (LLM cannot bypass even if the pod is compromised). v0.1: pod-side, with operator computing policy at dispatch. v0.2: consider operator-side admission for high-trust tools.
2. **`ToolBinding` cluster-scoped vs namespaced?** Likely namespaced for blast radius, with a `ClusterToolBinding` companion for global grants.
3. **Interaction with `AgentCapability`?** A `ToolBinding.subjects` `AgentSelector` already covers "all `capability=research` agents get web_fetch" — AgentCapability stays a routing primitive, not a tool primitive.
4. **Per-AgentTask one-shot grants?** Maybe `AgentTask.spec.adHocTools[]` evaluated against an operator-side allowlist of ad-hoc-allowed ToolDefinitions. Defer until a workload asks.
5. **MCP dynamic discovery vs static binding.** Bind the *server*, but only tools matching `toolNameAllowlist` regex on the binding surface to the LLM. Safer than open `tools/list`.
6. **Trace surface for policy denials.** `policy_denied` should be a structural verdict alongside `sub_agent_refused` (`HARNESS-LESSONS.md` §6) — same shape, operators want the same dashboard.
