# Upstream diff — `kubernetes-sigs/agent-sandbox` ↔ `ctkadvisors/kagent`

**Reference date:** 2026-05-06
**`kubernetes-sigs/agent-sandbox` snapshot:** `main` @ 2026-05-07, v0.4.5 (2,057★, Apache-2.0, SIG Apps).
**`ctkadvisors/kagent` snapshot:** local working tree, tag `v0.1.8-modelclass.2`, HEAD `32b5ff7` (MIT, pre-public-release).
**Audience:** kubernetes-sigs/agent-sandbox maintainers + anyone watching the K8s-native agent space. Written as a discussion seed, not a proposal — explicit asks are tagged in §6 and §7.
**Author note:** kagent's owner (Chris Knuteson) ran an internal audit (`docs/AUDIT-2026-05-06.md`) that prompted this write-up. The headline finding: **agent-sandbox falsifies kagent's earlier "only OSS K3s-native agent framework" framing.** This document tries to be useful in light of that, not defensive about it.

> Where I cite agent-sandbox by file path I mean the commit that resolves on `main` at the timestamp above. Where I cite kagent by file path I mean the local working tree at HEAD `32b5ff7`. I have tried to mark every uncertain claim with `(unverified — please correct if wrong)`. Please do; the goal is a shared map, not a one-sided pitch.

---

## 1. Why this comparison exists

Both projects landed independently on the same load-bearing premise: **per-agent isolation should be a Kubernetes-native primitive, not a per-vendor proprietary one.** That convergence is the most significant fact in this document. Two unrelated repos — one inside the Kubernetes SIG, one a small homelab-flavored substrate — independently decided that the right place for "this agent runs in its own pod under a real RuntimeClass with declared lifecycle" is a CRD in a controller in a Helm chart, not a hosted SaaS product.

Where the projects diverge is **scope**. agent-sandbox has chosen the smallest defensible primitive — *the sandbox itself* — and is letting the surrounding substrate (orchestration, identity, audit, capability narrowing, content-addressed I/O) be assembled by consumers. kagent has chosen a wider footprint — seven primitives plus three cross-cutting concerns — and accepts the cost of owning more of the stack. Solo.io kagent.dev (a third project, separate from this one) sits between them: it consumes agent-sandbox for isolation and adds an `Agent` CRD on top for K8s-operating agents.

That difference of scope, not any technical incompatibility, is what this doc is trying to make legible.

---

## 2. Functional inventory side-by-side

The following table is intentionally generous about gaps on both sides. "✅" means the primitive ships in code today; "⚠" means partial / declared but not fully wired; "❌" means not present; `(planned)` is a roadmap commitment. kagent claims about post-v0.1 primitives are tagged `(planned)` because the audit found at least one doc-stated feature ("hot-reloadable model classes") that the code did not implement — be skeptical of every "planned" until kagent ships it.

| Concern | agent-sandbox primitive | kagent primitive | Convergence / divergence |
|---|---|---|---|
| **Per-pod isolation** | `Sandbox` CR — `api/v1alpha1/sandbox_types.go` (PodTemplate inline; `replicas: 0|1`; `Lifecycle` with `shutdownTime` + `shutdownPolicy: Delete|Retain`) | `Agent` (class) + `AgentTask` (instance) — `packages/operator/src/crds/types.ts:60-637` (Agent), `:687-1037` (AgentTask) | **Both ship a CRD that owns the per-agent pod.** Shape is different (see §3.1): agent-sandbox is *one stable-identity pod per Sandbox CR*; kagent dispatches *a Job per AgentTask* with the static Agent CR as a class definition. |
| **Templates** | `SandboxTemplate` — `extensions/api/v1alpha1/sandboxtemplate_types.go` (PodTemplate + VolumeClaimTemplates + NetworkPolicy + EnvVarsInjectionPolicy) | `AgentTemplate` — `packages/operator/src/crds/types.ts:1075-1120` (parameter-typed templates rendered into Agent CRs by `template-instantiator.ts`) | **Both ship a templating CRD.** agent-sandbox's is pod-template-shaped (close to PodSpec); kagent's is agent-spec-shaped (parameters, budget, tool allowlist) and materializes into a separate Agent CR rather than directly into a pod. |
| **Warm pool / pre-provisioning** | `SandboxWarmPool` — `extensions/api/v1alpha1/sandboxwarmpool_types.go` (replicas + `updateStrategy: Recreate|OnReplenish`, scale subresource for HPA) | ❌ **No warm-pool primitive.** kagent's roadmap notes "warm pool / StatefulSet — only Job-per-task in v0.1; v0.2 if cold-start measures bad" but no design exists yet. | **Pure divergence.** agent-sandbox already shipped what kagent has on a maybe-list. See §4.1. |
| **Claim / binding** | `SandboxClaim` — `extensions/api/v1alpha1/sandboxclaim_types.go` (binds a SandboxTemplate to a runtime instance, supports warm-pool adoption + `Lifecycle.ttlSecondsAfterFinished` + EnvVar injection) | `AgentTask.spec.inputs[]` typed bindings — `packages/operator/src/crds/types.ts:738-754, 836-847` (binds Agent.spec.inputs to workspace / upstream taskUid+output / scalar literal) | **Both have a "claim" concept but they target different concerns.** SandboxClaim binds *a runtime instance to a Pod template*; AgentTask.inputs bind *typed dataflow* (workspaces, artifacts, upstream outputs) into a runtime instance. They could compose — see §6 path 1. |
| **Runtime class / sandbox profile** | `Sandbox.spec.podTemplate.spec.runtimeClassName` — explicit, blog-level support for Kata + gVisor (Kubernetes blog 2026-03-20) | `Agent.spec.sandboxProfile: 'default' | 'strict'` → resolved to `runtimeClassName` at job-spec build time — `packages/operator/src/job-spec.ts:837-849`; chart values map `agentPod.runtimeClasses.{default,strict}` | **Convergent intent, different surface.** agent-sandbox passes `runtimeClassName` straight through; kagent abstracts to a `default | strict` enum and resolves operator-side. Both arrive at the same kubelet decision. |
| **A2A messaging** | ❌ — Sandbox README explicitly scopes itself to "stable hostname and network identity"; A2A is BYO. | NATS JetStream + `Event` primitive (typed pub/sub topics + blackboard) — `Agent.spec.publishes[]/subscribes[]` (`crds/types.ts:359-516`); operator-side dispatcher minted on subscribe. | **Pure divergence — orthogonal concerns.** kagent treats A2A as a substrate primitive; agent-sandbox treats it as application-layer. Note: the kagent audit (R2) flagged that **kagent's Event primitive does not currently speak the A2A protocol** that 150+ orgs run in production via Vertex / AgentCore / Foundry — both projects have an opportunity here. |
| **Workflow durability** | ❌ | `AgentWorkflow` CRD planned for `v0.3.2-workflows` (Restate-backed) — `packages/operator/src/agent-workflow-controller.ts` exists; the CRD type surface lives outside `crds/types.ts` and is post-v0.1 work `(unverified — Restate adapter is sketched, not measured against a long-running multi-day workflow yet)` | **Divergence, but kagent has it on the roadmap.** This is exactly the case where agent-sandbox's smaller surface is cleaner and where Argo Workflows + Argo Events on NATS is the assembly answer for an agent-sandbox consumer today. |
| **Capability / authority model** | ❌ — pod identity = ServiceAccount + whatever RBAC the consumer wires; no narrowing primitive | `Capability` — sealed JOSE JWT (ES256 default, RS256 fallback; `cap-ca.ts:1-60`), minted by the operator's `cap-issuer.ts:1-120`, narrows on spawn (child claims ⊆ parent claims, substrate-enforced) — `crds/types.ts:282-313` declares the claim categories; `packages/agent-pod/src/cap-consumer.ts` verifies on the pod side | **The single biggest divergence.** Per the kagent audit (R1.4 #4), **no other surveyed OSS project ships caveat-narrowing JWT capabilities for K8s-spawned agents.** This is the one primitive kagent might be best-positioned to share upstream. See §5.1. |
| **Artifact / CAS** | ❌ — Sandbox has persistent storage (PVCs via `volumeClaimTemplates`) but no content-addressed primitive | `Artifact` (planned for `v0.2.2-cas`) — `cas://sha256:<hex>/<name>` URIs, identity = hash; `packages/agent-pod/src/cas-backend.ts` ships the PVC backend; `cas-gc.ts` ships reachability GC | **Divergence.** agent-sandbox ships *a place for bytes to live*; kagent ships *a content-addressed protocol on top of a place for bytes to live*. The semantics are stronger but the substrate cost is also higher. Cloudflare's "Artifacts" primitive (Git-compatible versioned storage, GA 2026) is in the same neighborhood — there may be appetite for a SIG-level convention. |
| **Workspace / shared FS** | `Sandbox.spec.volumeClaimTemplates[]` (per-Sandbox PVCs); `SandboxTemplate.spec.volumeClaimTemplates[]` (template-level PVC defaults) | `Workspace` CRD (planned for `v0.2.1-workspaces`) — RWX-PVC backed, shared across multiple AgentTasks in a tree, GC'd on root-task completion + ttl. `packages/operator/src/workspace-controller.ts` exists; CRD type lives outside `crds/types.ts` for v0.2 cut | **Both ship persistent storage; semantics differ.** agent-sandbox PVCs are scoped to a single Sandbox CR's lifetime. kagent's Workspace is **explicitly multi-task pipeline-scoped** (one git checkout, mounted RO across N agent pods, no re-clone storm). The pattern is Tekton Workspaces / SLURM. agent-sandbox could express this with a CR pointing at an externally-provisioned PVC, but the lifecycle GC isn't in-band. |
| **Audit stream** | ❌ — uses standard pod logs + events; no substrate-level signed event stream | `@kagent/audit-events` — CloudEvents on NATS JetStream `audit` stream; emitters in operator (`events-bootstrap.ts`) emit `capability.minted`, `secret.accessed`, `task.deduped`, `verifier.{started,completed,failed}`, `quota.breached`, `contract.violated`, etc. (`SUBSTRATE-V1.md` §4.3) | **Divergence.** kagent treats audit as a first-class substrate concern (SOC2 framing); agent-sandbox treats it as application-layer (consumer wires Loki/Splunk). |
| **Identity** | Pod identity via ServiceAccount; no SPIFFE primitive in the CRD `(unverified — searched only `api/v1alpha1`; if there's a SPIRE integration elsewhere I missed it)` | SPIFFE planned for `v0.4.3-identity` (`packages/agent-pod/src/svid-client.ts` exists today as a probe-only client); Capability JWT carries `iss/sub/jti/exp` + claims today | **Convergent intent.** Red Hat Kagenti has shipped the strongest SPIFFE story of any surveyed OSS project; agent-sandbox + kagent could likely both adopt that pattern (auto-injected SVIDs via SPIRE + Istio Ambient) without re-inventing. |
| **Quota** | ❌ — falls back to standard K8s `ResourceQuota` / `LimitRange` | Hierarchical org → tenant → Agent (`SUBSTRATE-V1.md` §4.2); `packages/quota-controller/` lands in `v0.5.2-quotas` | **Divergence.** kagent picked a wider scope. agent-sandbox could compose with stock `ResourceQuota` plus a per-Sandbox annotation; that's lighter but lacks the per-Agent in-flight count and per-tenant gateway-quota cascade kagent is going for. |
| **Run-end detectors / quality flags** | ❌ — no opinion on what "the agent's output looks bad" means | F1 (methodology fabrication), F2 (tool-use omission), F3 (truncated synthesis), refusal detection, synthesis-vacuity — `packages/agent-loop/src/detectors/quality-flags.ts:1-90` + `refusal.ts`. Lifted from chat-server experiments documented in `docs/HARNESS-LESSONS.md`. | **kagent has shipped substrate-level run-end middleware that catches model-tier failure modes pure isolation primitives won't catch.** See §5.2 — this is the kind of learning worth sharing whether or not agent-sandbox adopts it. |
| **Verifier / post-completion gate** | ❌ — Sandbox is "did the pod run"; no post-condition assertion in-band | `AgentTask.spec.verifyContract = { scriptRef? | llmJudgePromptRef? }` — substrate-side gate the agent-pod cannot contest; runner in `packages/operator/src/verifier.ts:1-120`; status patches `verification = { passed, mode, reason?, completedAt }` — `crds/types.ts:805-827, 989-998` | **Divergence; cleanly separable.** This composes with any Sandbox CR — a post-Sandbox-Finished verifier that runs against the Sandbox's outputs would slot in cleanly. See §5.3. |
| **LLM gateway boundary** | ❌ — explicitly out of scope (Sandbox is a pod; what the pod does with LLMs is consumer's problem) | `docs/GATEWAY-CONTRACT.md` — explicit MUST-list for OpenAI-compat HTTP + W3C `traceparent` + `X-Kagent-{Task-UID,Agent,Tenant,Capability-Id}` headers + bounded auth. `@kagent/llm-gateway` is the bundled OSS impl; LiteLLM is the documented production swap. | **Divergence — but the contract document itself is plausibly a SIG-level concern.** See §5.5. |

> The comparison is constrained to what either project ships in code today plus what kagent has documented as `(planned)`. I have **not** read the agent-sandbox controller-side code in depth — only the `api/v1alpha1` and `extensions/api/v1alpha1` type definitions, the README, and the K8s blog post. If you read this and think "we ship that, you missed it" — I likely did, please correct.

---

## 3. Where the projects are doing the same thing differently

### 3.1 Per-pod isolation — Tekton-shape vs. Deployment-shape

agent-sandbox's `Sandbox` CR is a **single, stable-identity, long-lived stateful pod**. The README's own framing: "the gap between stateless Deployments and numbered StatefulSets." `replicas: 0|1`. `Lifecycle.shutdownTime` is an absolute timestamp at which the controller deletes (or retains) the underlying pod.

kagent's `Agent` + `AgentTask` is **a class + an instance, not a pod-per-CR**. `Agent` (`crds/types.ts:60`) is the static declaration — image, model, tools, capability claims, supervision strategy. `AgentTask` (`crds/types.ts:687`) is the runtime invocation, dispatched as a K8s Job that runs to completion. Phase enum is `Pending | Dispatched | Completed | Failed`. The pod is ephemeral — task-scoped, deleted on completion via the Job's TTL.

Both shapes are valid. The difference matters when:

- **Long-running agents.** agent-sandbox is the natural fit. kagent today has no long-running-agent story — every AgentTask is a one-shot Job. (kagent owner's note: this is one of the strongest reasons to adopt agent-sandbox for the long-running-agent case rather than reinvent it. See §6 path 1.)
- **Burst / many-tasks-per-class.** kagent's shape is the natural fit — one Agent CR can be invoked thousands of times in parallel via thousands of AgentTask CRs without N CR-creates per concurrent agent.
- **Stable identity for incoming connections** (SSH-into-the-sandbox, Jupyter notebook URLs, persistent agent state). agent-sandbox.
- **Capability narrowing on spawn.** kagent (because there's a per-instance CR to attach a per-instance JWT to). agent-sandbox would need an external mechanism, or to mint a per-Sandbox capability at create time.

The Tekton parallel is exact. `Task` ↔ `Agent`; `TaskRun` ↔ `AgentTask`. The Deployment-vs-StatefulSet parallel is what agent-sandbox's README invokes and is also exact for the stable-identity case.

### 3.2 Templates — which layer of indirection?

`SandboxTemplate.spec.podTemplate` is a `PodSpec`-shaped object (`extensions/api/v1alpha1/sandboxtemplate_types.go`). A SandboxClaim instantiates it directly into a pod via the controller.

`AgentTemplate.spec.agentSpec` (`crds/types.ts:1092-1106`) is an opaque map of fields with `${param.X}` placeholders that the operator's `template-instantiator.ts` renders into an `Agent` CR — which is then the input to the AgentTask machinery. So kagent has *two* layers of indirection (Template → Agent → AgentTask → Job → Pod) where agent-sandbox has *one* (Template → Claim → Pod).

The kagent extra layer pays for itself in admission (typed inputs, capability claims, supervision strategy all live at the Agent layer and are reusable across AgentTasks); it's pure overhead if all you need is "spawn a pod from a template."

### 3.3 Network policy ownership

This one is interesting because the projects are doing **the exact same thing** but at different layers.

- agent-sandbox: `SandboxTemplate.spec.networkPolicy` + `networkPolicyManagement: Managed|Unmanaged`. The controller materializes a per-template NetworkPolicy with explicit "default-deny ingress, allow public-internet egress, block RFC1918" semantics. Documented in the type comments.
- kagent: `Agent.spec.egress: { domains, cidrs, ports }` (`crds/types.ts:436-463`). The egress-controller materializes a per-Agent NetworkPolicy or CiliumNetworkPolicy. Tenant default fills in when unset; substrate baseline is default-deny.

These two systems would happily coexist on the same cluster — one materializing per-template policies for Sandbox-shaped workloads, one materializing per-Agent policies for kagent workloads — but it would be cleaner if there were a shared convention. The agent-sandbox sidecar warning ("If your Pod uses Istio proxy, monitoring agents that listen on their own ports, the NetworkPolicy will BLOCK traffic to them by default") is exactly the lesson kagent is going to relearn the hard way `(unverified — kagent's egress-controller may have addressed this; I haven't read its code in this audit)`.

### 3.4 Lifecycle — absolute time vs. completion-relative

agent-sandbox's `Lifecycle.shutdownTime` is an absolute `*metav1.Time`. `SandboxClaim.spec.lifecycle.ttlSecondsAfterFinished` is a completion-relative TTL (added in `extensions/`). `ShutdownPolicy: Delete|DeleteForeground|Retain`.

kagent's `AgentTask.spec.runConfig.timeoutSeconds` and `AgentTask.spec.timeoutSeconds` (deprecated) are wall-clock duration budgets enforced via `Job.spec.activeDeadlineSeconds` (`packages/operator/src/job-spec.ts:864-867`). No absolute-time field. TTL post-completion is handled by `Job.spec.ttlSecondsAfterFinished` (kagent default `DEFAULT_TTL_SECONDS_AFTER_FINISHED`, set in `job-spec.ts`).

This is a cleanly separable difference. The two semantics could merge into one — "I want this gone at 5pm tomorrow" vs. "I want this gone 1h after it finishes" — and a SIG-level convention would help any consumer that wants to express both.

### 3.5 EnvVar injection policy — agent-sandbox has thought about this; kagent has not

`SandboxTemplate.spec.envVarsInjectionPolicy: Allowed|Overrides|Disallowed` (`extensions/api/v1alpha1/sandboxtemplate_types.go`) is a small but pointed primitive: the template author decides whether the claim-creator can inject or override env vars. Default `Disallowed` — secure-by-default.

kagent has nothing equivalent. `Agent.spec` declares the agent class; `AgentTask.spec.payload` is opaque `unknown` (`crds/types.ts:695`); env-var injection from AgentTask into the pod isn't a concept (the operator builds the pod env from the Agent + AgentTask + ConfigMap). agent-sandbox's three-state enum is a sharper articulation of the trust boundary than kagent has — see §4.4.

---

## 4. What kagent could adopt from agent-sandbox

These are honest "we should consider doing this" candidates from kagent's POV. Citations are agent-sandbox file:line where I have them; kagent paths are relative.

### 4.1 Adopt SandboxWarmPool semantics for the long-running-agent gap

kagent ships only Job-per-task. The roadmap notes "warm pool / StatefulSet — only Job-per-task in v0.1; v0.2 if cold-start measures bad" but no design exists. agent-sandbox's `SandboxWarmPool` (`extensions/api/v1alpha1/sandboxwarmpool_types.go`) is exactly the primitive — `replicas`, `sandboxTemplateRef`, `updateStrategy: Recreate|OnReplenish`, scale subresource for HPA. The `OnReplenish` semantics (stale pods replaced lazily on adoption by claim) are particularly nice — they avoid the recreate-storm problem when the template version bumps.

**Smallest commit to start:** add a `kagent-warmpool` package that watches `SandboxWarmPool` CRs (registers as a consumer of agent-sandbox extensions) and, when an `AgentTask` is admitted, prefers an adopted Sandbox over a fresh Job-spawn for Agents annotated `kagent.knuteson.io/long-running: "true"`. Doesn't replace Job-per-task; adds it as a path.

### 4.2 Adopt the `envVarsInjectionPolicy` enum verbatim

`AgentTask.spec.payload` is `unknown` (`crds/types.ts:695`) and is wholly unconstrained — the audit (C2.5) identified env-JSON ARG_MAX exhaustion as a concrete failure mode. agent-sandbox's `Disallowed`-by-default + `Allowed` (additive only) + `Overrides` (full replace) trichotomy is the right shape. kagent could land it on `AgentTemplate` (the layer that materializes Agent CRs from rendered specs) and on `Agent` (gating what AgentTask is allowed to push down).

**Smallest commit:** add `Agent.spec.envVarsInjectionPolicy: 'Disallowed' | 'Allowed' | 'Overrides'` (default `'Disallowed'`); have admission reject AgentTasks that violate it. Two-day change.

### 4.3 Adopt Sandbox CR shape for the per-pod-isolation primitive

This is the big one. The kagent audit's strategic option C is "consolidate — donate AgentTask + Workflow + Capability + Workspace + Artifact CRDs upstream." A less aggressive move that captures most of the value: **kagent stops reinventing per-pod isolation and treats `kubernetes-sigs/agent-sandbox`'s `Sandbox` CR as the substrate primitive.** AgentTask's job becomes "build the SandboxClaim spec, mint the capability JWT, mount it as a Secret-volume, wait for the Sandbox to reach Finished, run the verifier." Solo.io kagent.dev's `SandboxAgent` CRD is the precedent — they adopted exactly this pattern.

What kagent loses: full control of the pod-spawn path, including the suspended-Job pattern (`job-spec.ts:872-876`) that lets the operator publish a dispatch envelope before kubelet schedules the pod. Whether SandboxClaim has an equivalent ordering hook is `(unverified — please correct if there's a way to admit-then-start a Sandbox)`.

What kagent gains: Kata/gVisor support that's already battle-tested at SIG scale, warm-pool semantics for free, conformance with whatever conventions emerge from the SIG (label conventions, condition shapes, scale-subresource patterns).

**Smallest commit:** ship a feature-flagged path in `packages/operator/src/job-spec.ts` that, when `agentPod.useSandboxBackend: true`, emits a `SandboxClaim` instead of a `Job`. Job-based path stays as the OSS-friendly default for clusters without agent-sandbox installed. See §6 path 1 for the bigger version of this.

### 4.4 Adopt SIG-blessed label conventions

agent-sandbox uses `agents.x-k8s.io/...` labels (`SandboxIDLabel = "agents.x-k8s.io/claim-uid"`, `SandboxPodNameAnnotation = "agents.x-k8s.io/pod-name"`, `SandboxPodTemplateHashLabel = "agents.x-k8s.io/sandbox-pod-template-hash"`). kagent uses `kagent.knuteson.io/...`. The reasonable thing for a downstream is to **also** stamp the SIG conventions when the underlying object is Sandbox-shaped, so cluster-wide tooling (`kubectl get -l agents.x-k8s.io/claim-uid=…`) finds kagent objects too.

**Smallest commit:** in the spawned-Job pod template, add agent-sandbox-equivalent labels alongside kagent's. Half a day.

### 4.5 Adopt the `NetworkPolicyManagement: Managed|Unmanaged` discriminator

kagent's egress-controller is always-on when `Agent.spec.egress` is set; there's no clean way to say "I'm using Cilium and managing the policy externally, please don't materialize a NetworkPolicy." agent-sandbox's `Managed|Unmanaged` enum is the right shape — Cilium-Ambient consumers want to disable controller-side NetworkPolicy management explicitly. Adopt the exact same field name + enum so consumers running both projects don't have two different switches for the same concept.

---

## 5. What kagent thinks agent-sandbox could consider

**Framing for these:** every entry below is "we found this useful in our scope; here's the file path you'd want to read; would you consider whether it's a fit for yours?" Not a feature request. agent-sandbox's smaller scope is itself a feature — adding any of these without a use case dilutes that.

### 5.1 Caveat-narrowing JWT capabilities for sandbox-spawned children

The kagent audit (R1.4 #4) found that **no other surveyed OSS project ships sealed-JWT capabilities that narrow on spawn.** Macaroons exist as a 2014-era concept; Microsoft's Agent Governance Toolkit signs plugins with Ed25519; Red Hat Kagenti uses Keycloak RFC-8693 token exchange; AWS Cedar policies live at the Gateway, not at the spawn boundary. None of those are JOSE ES256/RS256 capability bundles where the substrate enforces `child.claims ⊆ parent.claims` at admission.

kagent's implementation:

- Issuer side: `packages/operator/src/cap-issuer.ts:1-120` mints a bundle from `Agent.spec.capabilityClaims` (`crds/types.ts:282-313`), narrowed by the parent's bundle when one was provided.
- CA side: `packages/operator/src/cap-ca.ts:1-60` (file-mount key by default; cert-manager-Issuer-mounted as the advanced path; no cert-manager bootstrap requirement).
- JWKS publication: operator's `template-server.ts` exposes `/.well-known/jwks.json`.
- Consumer side: `packages/agent-pod/src/cap-consumer.ts` verifies the JWT, threads `claims.tenant` into every gateway call, gates `publish_event` and `spawn_child_task` on the corresponding claim categories.

The audit found two real defects in the *consumer* side (capability is fail-open if the JWT mount is missing; `publish_event` falls back to a self-minted unverified bundle when no JWT is mounted) — those are kagent-side bugs we're fixing, not contract defects. The contract itself is sound.

**Update 2026-05-07 (rev2 audit close-out):** the rev2 audit (`evidence/audit-rev2/AUDIT-2026-05-06-rev2.md`, with per-finding evidence in `C2.md`) confirmed **six BLOCKERs closed in the capability infrastructure path** between 2026-05-06 and 2026-05-07:

- **B1 (Wave 0)** — `publish_event` synthetic-cap-bundle fallback removed. The pod-side publish path can no longer self-mint capability access; it refuses with `policy_denied:no_capability` when no operator-signed JWT is mounted. Commit `5d3cb3a` (`fix(agent-pod): refuse publish_event when no operator-signed JWT mounted`); evidence at `packages/agent-pod/src/builtin-tools-publish.ts:138-148`.
- **B2 (Wave 0)** — capability fail-OPEN closed. `loadCapabilityOptional` now has three explicit modes: env unset = legacy no-op; env set + file missing = throw (fail-LOUD default) with explicit `KAGENT_CAPABILITY_ALLOW_MISSING=true` opt-out; file present = verify normally. The operator's chart now requires the JWT mount by default. Commit `42a04fd` (`fix(agent-pod, operator/chart): require capability JWT mount by default`); evidence at `packages/agent-pod/src/cap-consumer.ts:148-206` + `main.ts:117-149`.
- **H7 (Wave 0)** — substrate-tools allowlist enforcement added. `assertSubstrateToolsAdmitted` runs pre-boot; every substrate-provider tool name must be in `Agent.spec.tools` or satisfy an implicit-when-X predicate (`get_my_context` is universally admitted). An agent can no longer accidentally gain access to `spawn_child_task` without declaring it. Commit `1a64c92` (`fix(agent-pod): cross-check substrate tool registration vs Agent.spec.tools`); evidence at `packages/agent-pod/src/runner.ts:636,795-819`.
- **M6 (Wave 3)** — `cap.claims.spawn = ['*']` no longer bypasses the GitOps-controlled `Agent.spec.allowedChildAgents` list. The defense-in-depth fix enforces both the cap AND the legacy list when the operator declared the legacy list non-empty (the "cap-only deploy" pattern remains preserved when both lists are intentionally empty). Commit `81419f0` (`fix(agent-pod): runtime hardening — keep allowedChildAgents w/ cap, fstat CAS reads, lift write_artifact env to boot (M6, M8, M9)`); evidence at `packages/agent-pod/src/builtin-tools-spawn.ts:283-322`.

The capability primitive is now hardened enough to be the **load-bearing example** for the upstream RFC — see [`docs/RFC-CAPABILITY-NARROWING.md`](./RFC-CAPABILITY-NARROWING.md), a discussion-seed draft for the SIG. The RFC names a concrete threat model (including the M6 finding as a worked-example known-weakness mitigation), proposes three wire-shape options for SIG to pick from, and lists the open questions explicitly. **The R1 rev2 finding stands:** zero KEPs, zero open issues in `kubernetes-sigs/agent-sandbox` mention "capability" / "narrow" / "authority" / "JWT" / "SPIFFE" as of 2026-05-07 (re-verified via `gh issue list --search` + `gh api repos/kubernetes-sigs/agent-sandbox/contents/docs/keps`); the gap is uncontested and the primitive is now production-shaped enough to share.

**Would you consider:** a SIG-level conversation about whether sandbox-spawned children should carry a substrate-attested authority token, and whether the kagent contract (claim categories, narrowing rule, JWKS-published verification key) is a useful starting point. The smallest experiment: a `Sandbox.spec.capability` opaque-string field that the controller threads into the pod env unmodified, as a proof-of-concept seam.

### 5.2 Run-end detectors as substrate-level middleware

`packages/agent-loop/src/detectors/quality-flags.ts:1-90` ships four pure-function detectors for classes of model failure that pure-isolation primitives won't catch:

- `synthesis_low_yield` — tools fired and produced material; final assistant message narrates the process instead of delivering content.
- `methodology_fabrication` — model claims a tool action ("I fetched", "I read") that didn't appear in the trace's `tool_call` list.
- `tool_use_omission` — operator's prompt requested a tool category that didn't fire.
- `truncated_synthesis` — output near `max_tokens` cap AND content lacks sentence-terminating punctuation. Catches CF-gateway-compat reporting `stop_reason: end_turn` instead of `length`.

Plus `refusal.ts` for the sub-agent-refused-but-returned-success-shape pattern.

**Update 2026-05-07:** the run-end detector battery now also includes `context_pressure_ignored` (commit `fc32b13`). It flags Agent CRs whose prompts ride to high context utilization (>70%) without delegating via `spawn_child_task` in the last N=3 iterations — i.e. the prompt is failing to manage its own context budget despite having the introspection tool (`get_my_context.tokenUtilization`, commit `fb549c0`) and the substrate-side refusal at 95% (commit `73f67f4`) wired up. This is exactly the kind of thing pure-isolation primitives won't catch: the pod runs to completion fine; the *prompt* is bad at self-managing its window. Worth folding into the upstream-share conversation alongside the original four — the design rationale is in `evidence/audit-rev2/R1.md` §3 and the slate is documented in `docs/CONTEXT-AWARENESS.md`.

These earned their keep against Llama-4-Scout via Cloudflare AI Gateway in the chat-server experiments documented in `docs/HARNESS-LESSONS.md`. The cross-cutting lesson from that doc: **most "framework bugs" in the agent-platform space are model-tier bugs in disguise.** A Sandbox CR by itself can't see that.

**Would you consider:** whether agent-sandbox wants an opinion on what "the agent's output is suspicious" means at the substrate level, or whether that's deliberately out of scope. If it's in scope, the five detectors are pure functions over a trace + final message + user prompt (and, for `context_pressure_ignored`, a token-utilization signal threaded from the gateway) — they'd port to any controller.

### 5.3 Substrate-mediated post-completion verifier hook

`AgentTask.spec.verifyContract = { scriptRef? | llmJudgePromptRef? }` (`crds/types.ts:805-827`) gates the `Completed` patch on a verifier verdict the agent-pod cannot contest. Implementation in `packages/operator/src/verifier.ts:1-120`:

- `scriptRef` path → operator spawns a one-shot Job whose container runs the verifier script with the parent task's outputs mounted as `/var/kagent/verify/input.json`. Exit 0 → admit Completed; non-zero → patch Failed with `reason: 'verify_failed'`.
- `llmJudgePromptRef` path → operator dispatches the rendered prompt to the gateway; response's `verdict` field gates Completed.

Three audit events bracket the lifecycle (`verifier.{started,completed,failed}`). Fail-closed if both modes set; fail-closed on verifier-side errors (timeout, gateway 5xx, malformed JSON).

The architectural point: this is a SUBSTRATE-side verdict, not a per-task tool the agent can call. The agent that produced the work does NOT get to review or contest the verdict. That's what lets it serve as a SOC2-grade post-condition rather than a self-attested check.

**Would you consider:** whether `Sandbox.status.conditions[Finished]` could carry a substrate-attested `verifyContract` outcome, distinct from the pod's own exit status. Useful for any consumer that wants "did the work the sandbox did meet the post-condition?" answered at the controller layer rather than left to the consumer.

### 5.4 The "what belongs in the substrate vs. application code" mental model

`docs/SUBSTRATE-V1.md` is kagent's seven-primitives + three-cross-cutting-concerns design doc. The discipline it tries to maintain: every concrete concern raised in the v0.1 audit (spawn authority, pod cleanup, secret hygiene, shared workspaces, multi-tenancy, compliance) maps to *exactly one* primitive or *exactly one* cross-cutting concern. The composition rules in §5 of that doc ("capabilities flow downward, narrowing only", "artifacts are content-addressed", "owner references propagate", "identity authorizes, not tokens", "schema declared at design, instantiated at runtime", "failures are loud and substrate-attributed", "primitives are orthogonal") are the test for whether a proposed feature belongs in the substrate.

agent-sandbox today is laser-focused on isolation, which is a defensible scope. But every consumer is going to want to compose isolation *with* something — A2A, audit, identity, quotas. **Would you consider** whether the SIG wants an explicit "what's in scope, what's in the consumer's lap" discipline document, modeled either on kagent's seven-primitives shape or on whatever shape the SIG prefers? Without it, every consumer rebuilds the same neighborhood differently and the SIG's surface area accidentally grows by gravity.

### 5.5 GATEWAY-CONTRACT.md as a SIG-level convention

`docs/GATEWAY-CONTRACT.md` is kagent's explicit wire contract between an agent runtime and any LLM gateway:

- MUST speak OpenAI Chat Completions v1 over HTTP at `/v1/chat/completions`.
- MUST stamp + accept `traceparent` (W3C) plus `X-Kagent-{Task-UID,Agent,Tenant,Capability-Id}` for cross-system attribution.
- MUST accept `X-Idempotency-Key`.
- MUST NOT echo `Authorization` in any response body / log / trace attribute.

The point of the contract is that **any** gateway (LiteLLM, OpenRouter direct, an enterprise gateway, the bundled `@kagent/llm-gateway`) is swappable behind one config-line by satisfying every MUST.

**Would you consider:** whether a SIG-level "LLM gateway contract" specification would let agent-sandbox-shaped agents plug into any of the existing gateway implementations without per-vendor adapters. The headers don't need to be `X-Kagent-*`-prefixed obviously; the substantive part is the attribution-headers convention plus the auth + idempotency rules.

### 5.6 CloudEvents-on-NATS audit stream

`@kagent/audit-events` emits a CloudEvents-shaped record on a NATS JetStream `audit` stream for every substrate decision (`SUBSTRATE-V1.md` §4.3). The stream is append-only, optionally cryptographically signed for SOC2. Consumers: Loki, Splunk, Elastic, real-time alerters, compliance reporters.

**Would you consider:** whether SIG Apps wants a convention for "what events agent-shaped controllers emit." K8s Events + pod logs work but are awkward for cross-controller correlation; a CloudEvents stream gives consumers a single subscription point. Independent of whether the wire is NATS, Kafka, or something else.

---

## 6. Integration paths

Three paths kagent could take toward agent-sandbox, ranked by friendliness to upstream. None is irrevocable; the three blend.

### Path 1 — Adopt + extend (recommended by the kagent audit)

kagent demotes its per-pod-isolation primitive to "consumer of `kubernetes-sigs/agent-sandbox`." `Agent` + `AgentTask` stay; the AgentTask reconciler emits `SandboxClaim` instead of `Job`. `SandboxTemplate` becomes the pod-template layer (kagent's `AgentTemplate` materializes a SandboxTemplate alongside the Agent CR). `SandboxWarmPool` lights up the long-running-agent and warm-pool gaps that kagent has on roadmap but unbuilt. kagent contributes its substrate-level extensions (capability JWT, audit, verifier, run-end detectors) as either separate CRDs that compose with Sandbox, or as upstream RFCs / Issues.

**Smallest commit to start:** a feature flag `agentPod.useSandboxBackend: true` in the kagent Helm chart that swaps the `Job`-emitter for a `SandboxClaim`-emitter in `packages/operator/src/job-spec.ts`. Job-emitter path stays as the OSS-friendly default for clusters without agent-sandbox installed. Plus a single upstream Issue in `kubernetes-sigs/agent-sandbox` titled "share learnings: substrate-level extensions to Sandbox" linking this document.

**Net effect:** kagent stops being an island; SIG gets a real-world consumer that's exercising the extensions surface and contributing back; users get `SandboxWarmPool` for long-running agents with kagent's typed-I/O + capability-narrowing layered on top.

### Path 2 — Compose at the user's discretion

kagent stays self-contained but ships an integration recipe: "swap kagent's pod-spawn for an agent-sandbox-backed `SandboxClaim`, get the SIG-blessed isolation guarantees with kagent's substrate orthogonality on top." The recipe is a Helm-values document and a docs page, not a refactor.

**Smallest commit to start:** a new `docs/INTEGRATION-AGENT-SANDBOX.md` page showing the values overlay + a worked example. No code change.

**Net effect:** lower friction than path 1 but doesn't actually fold the warm-pool / long-running-agent gap; users have to wire it themselves.

### Path 3 — Coexist + cross-reference

No technical integration. Both projects update their docs to point at each other ("if you want X, look at Y") so users self-select. kagent's `docs/PRIOR-ART.md` already nods at the broader landscape; an explicit "when to choose kagent vs. agent-sandbox vs. Solo.io kagent.dev" section would help.

**Smallest commit to start:** PR against `docs/PRIOR-ART.md` adding the comparison; an Issue against `kubernetes-sigs/agent-sandbox` (or a comment on whatever the SIG considers the right surface) suggesting a similar pointer in their README.

**Net effect:** zero risk of either project growing accidental dependencies; least value to either project's users.

---

## 7. Open questions for the agent-sandbox maintainers

Concrete things kagent's maintainer would want to ask if this turns into a real conversation:

1. **Is there appetite in SIG Apps for a CRD that wraps Sandbox with declarative I/O contracts** (the kagent `Agent.spec.inputs[]/outputs[]` shape — typed dataflow bindings, content-addressed artifact + RWX-workspace mount semantics)? If yes, where does that primitive live — is it in `agent-sandbox/extensions/`, a separate kubernetes-sigs repo, or do you see it as a consumer's problem?

2. **What's your thinking on capability-narrowing for Sandbox-spawned children, if anything?** A Sandbox can spawn a child Sandbox via the K8s API; today that grants the child whatever the parent's ServiceAccount is allowed to do. Is there interest in a substrate-attested authority token (something like the kagent JWT bundle, but vendor-neutral) that narrows on the spawn boundary?

3. **How do you see the relationship between `kubernetes-sigs/agent-sandbox` and Solo.io kagent.dev's `SandboxAgent` CRD shaping out over the next release cycle?** The kagent audit (R1.1) shows Solo.io's `SandboxAgent` is already a consumer; is that the canonical pattern you want consumers to follow, or are there integration sharp edges you'd want a second consumer (kagent, hypothetically) to learn from before adopting?

4. **What's the Sandbox CR's intended posture on long-running-but-stateful-and-resumable workloads** (snapshot + restore of FS+memory state, like Modal / Cloudflare Sandboxes / OpenAI SandboxAgent)? `Lifecycle.shutdownPolicy: Retain` keeps the CR around; does it keep the underlying volume and is there a "resume from this Sandbox" pattern?

5. **For the `SandboxTemplate.spec.envVarsInjectionPolicy` enum** (`Allowed | Overrides | Disallowed`) — was that motivated by a specific compliance / security request, or is it the natural shape of the trust boundary you wanted to express? kagent has the same shaped boundary unprotected today and would adopt your enum verbatim if you'd consider the field name stable.

6. **Are there SIG-blessed conventions for label/annotation namespaces, condition shapes, or scale-subresource patterns** that consumers should follow when wrapping or extending Sandbox? kagent stamps `kagent.knuteson.io/...` labels; happy to also stamp `agents.x-k8s.io/...` ones if there's a documented convention.

7. **Is there any appetite in SIG Apps for a substrate-level audit-stream convention** (CloudEvents-on-some-bus for the events agent-shaped controllers emit), or is that better left to consumers? kagent's `@kagent/audit-events` shape is in `docs/SUBSTRATE-V1.md` §4.3 if useful as a starting point.

---

## What I couldn't verify and would want a maintainer to confirm

- Whether agent-sandbox has any built-in story for capability narrowing on spawn-children. I read `api/v1alpha1` and `extensions/api/v1alpha1`; if there's a webhook or controller-side enforcement layer I missed, please correct.
- Whether there's a SIG-level identity story (SPIFFE / SPIRE integration) elsewhere in the repo that I didn't surface.
- Whether `SandboxClaim` has an "admit-then-start" hook analogous to kagent's suspended-Job pattern (`packages/operator/src/job-spec.ts:872-876`) where the controller can publish a dispatch envelope before kubelet schedules the pod.
- Whether the Kubernetes blog post (2026-03-20) committed the SIG to any roadmap for primitives beyond the four CRDs shipped today (warm-pool semantics, snapshot/resume, mTLS substrate, etc.).
- Whether the "long-running stateful singleton" framing in the README is the *only* intended use case, or whether burst / per-task / Job-shaped workloads are a roadmap item.

---

## Closing note from the kagent owner

The kagent audit (`docs/AUDIT-2026-05-06.md`) flagged that calling kagent "the only OSS K3s-native agent framework" was wrong — agent-sandbox shipped first and the SIG owns the per-agent isolation primitive now. That's a useful correction, not a problem. The genuinely interesting question for kagent is: which of the seven primitives kagent has shipped or is shipping (Agent, AgentTask, AgentWorkflow, Workspace, Artifact, Capability, Event) belong in the substrate at all, vs. as separate composable controllers, vs. in the consumer's lap?

For at least one of those — the capability narrowing primitive — the kagent audit's R1 survey couldn't find any other OSS implementation. That's the one we'd most like to share with the SIG before either reinventing it elsewhere or letting it die in a private repo. Path 1 from §6 is the cleanest way to start that conversation; path 3 is the lowest-risk way; path 2 is an honest middle.

We're easy to find via this repo or `cknuteson@gmail.com`. Thank you for shipping `kubernetes-sigs/agent-sandbox` — it changed the strategic landscape we were assuming, and that's a good problem to have.
