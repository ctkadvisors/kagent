/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * TypeScript surface for the v1alpha1 CRDs the operator watches.
 * These types mirror the YAML CRD schemas under `manifests/crds/` —
 * keep them in sync if either changes. Field semantics trace to
 * docs/DESIGN-V0.1.md §4.1.
 *
 * API group: `kagent.knuteson.io/v1alpha1` (knuteson.io subdomain
 * chosen to avoid collision with kagent.dev/Solo.io's K8s-ops-agent
 * project — see CLAUDE.md naming note).
 */

import type { V1ObjectMeta } from '@kubernetes/client-node';

import type { CapabilityClaims } from '@kagent/capability-types';

import type { ArtifactRef } from './artifact-ref.js';

export const API_GROUP = 'kagent.knuteson.io';
export const API_VERSION = 'v1alpha1';
export const API_GROUP_VERSION = `${API_GROUP}/${API_VERSION}` as const;

/* =====================================================================
 * Agent — declarative spec for a workload that can be invoked.
 * ===================================================================== */

export interface AgentSpec {
  /**
   * Model identifier passed to LiteLLM in the standard `model` field.
   * MUST include the provider prefix per docs/CLAUDE.md (e.g.
   * `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`,
   * `aws-bedrock/au.anthropic.claude-sonnet-4-6`).
   */
  readonly model: string;

  /** Optional system prompt baked into every run of this agent. */
  readonly systemPrompt?: string;

  /**
   * v0.1.6 — Langfuse-managed system prompt reference. Operator
   * threads this verbatim into KAGENT_AGENT_SPEC; agent-pod fetches
   * the prompt body from Langfuse at boot via the v2 prompts API.
   *
   * When both `systemPrompt` and `systemPromptRef` are set, the ref
   * wins on fetch success; the literal is the fallback on fetch
   * failure. When only the ref is set, fetch failure boot-fails.
   *
   * `version` is optional — Langfuse returns the production-promoted
   * version when omitted (latest if no production label set).
   */
  readonly systemPromptRef?: {
    readonly name: string;
    readonly version?: number;
  };

  /** Optional tool names this agent is allowed to invoke. Empty/undefined = none. */
  readonly tools?: readonly string[];

  /** Optional capability tags this agent can satisfy when AgentTasks address by capability. */
  readonly capabilities?: readonly string[];

  /**
   * Sandbox profile for the agent pod. `default` = standard `runc`
   * isolation. `strict` = `runtimeClassName: kata` (lands in v0.2 once
   * Kata is deployed onto the K3s nodes).
   */
  readonly sandboxProfile?: 'default' | 'strict';

  /**
   * WS-K — declarative allowlist of Agent names this agent may spawn
   * as children via the in-pod `spawn_child_task` tool. Empty / unset
   * means NO children may be spawned (fail-closed). The list is the
   * GitOps-controlled trust boundary so an LLM-driven prompt injection
   * cannot pick its own child target.
   *
   * When the Tool Broker (P6) lands, this becomes the fallback for
   * `spawn_child_task`'s `argumentPolicy` when no `ToolBinding` exists
   * for the spawn tool — see docs/AGENT-SELF-SERVICE.md §8 D9.
   */
  readonly allowedChildAgents?: readonly string[];

  /**
   * v0.1.3 — companion to `allowedChildAgents` that admits a child by
   * its target Agent's `kagent.knuteson.io/from-template` label
   * (stamped by the WS-M template-instantiator). Lets a parent permit
   * a whole class of materialized agents (e.g. every Agent the
   * operator mints from the `summarizer` template) without
   * enumerating their content-addressed names. Both lists union; an
   * Agent missing the from-template label is NEVER admitted via this
   * field (fail-closed).
   */
  readonly allowedChildTemplates?: readonly string[];

  /**
   * WS-K — upper bound on direct children of THIS agent's tasks that
   * may be in non-terminal phases simultaneously. Stops an LLM-loop
   * bug from creating 10⁶ children. Default 10.
   */
  readonly maxConcurrentChildren?: number;

  /**
   * v0.1.4 — declarative LLM request-tuning knobs threaded into every
   * `chat()` call this Agent's loop makes. Maps 1:1 to the OpenAI
   * body fields `temperature` / `max_tokens` / `stop` once translated
   * by `@kagent/openai-compat`. Unset fields fall through to the LLM
   * provider's defaults; the substrate never invents values.
   */
  readonly llmParams?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly stopSequences?: readonly string[];
  };

  /**
   * Opt-in per-Agent fairness cap (LLM-gateway bundle, spec §3.4).
   * Upper bound on the number of Jobs the operator's admission
   * reconciler will leave un-suspended at any given moment whose
   * `kagent.knuteson.io/agent=<name>` label matches this Agent.
   *
   * Absent / undefined = unlimited at this layer; the per-(model,
   * backend) cap declared on the matching `ModelEndpoint` is the only
   * gate when this field is unset. Set this when one Agent is hot
   * enough to monopolize a backend's capacity and you want to leave
   * headroom for others.
   *
   * Range 1..1024. Counted by direct in-flight Jobs only; queued /
   * suspended Jobs do not count against the cap.
   */
  readonly maxInFlightTasks?: number;

  /* ---- v0.2.0-typed-io — Wave 1 sub-team I/O.
   * Typed dataflow contract between the static Agent class and runtime
   * AgentTask invocations. Per docs/SUBSTRATE-V1.md §3.1 + §3.2, every
   * Agent declares the inputs it consumes and the outputs it produces;
   * every AgentTask binds those inputs by reference (workspace name,
   * upstream taskUid+output, scalar literal). Admission validates the
   * contract; reconciler refuses `Completed` patches missing required
   * outputs. The kind enum is the contract Workspace + CAS sub-teams
   * branch from. */

  /**
   * Inputs this Agent consumes. Each entry's `kind` is one of
   * `workspace | artifact | scalar`. Workspace inputs MUST declare a
   * `mountPath` (admission rejects otherwise — Workspace sub-team
   * mount plumbing depends on it); artifact inputs SHOULD declare one
   * (CAS sub-team mounts artifact bytes the same way); scalars are
   * passed through to the agent loop in-band.
   *
   * `required: true` (default) means an AgentTask must bind it at
   * creation time; admission rejects creation otherwise.
   * `optional: true` is the explicit opt-out and overrides any
   * `required: true` on the same entry.
   */
  readonly inputs?: readonly InputDecl[];

  /**
   * Outputs this Agent produces. Reconciler validates each
   * `required: true` entry is present in `AgentTask.status.outputs`
   * before allowing a `phase=Completed` patch to land — missing
   * required outputs force `Failed` with `reason: MissingRequiredOutputs`
   * and emit a `contract.violated` audit event.
   *
   * `retention` is parsed in v0.2.2-cas; v0.2.0 only threads the
   * field through the schema so authoring + admission round-trip it.
   */
  readonly outputs?: readonly OutputDecl[];

  /**
   * Reserved for the Workspace sub-team (v0.2.1-workspaces). Opaque
   * object array at v0.2.0; the Workspace sub-team locks the shape in
   * its release. Threaded through here so v0.2.0 schemas + admission
   * accept the field without a CRD-bump dependency on Workspace.
   */
  readonly workspaceClaims?: readonly Record<string, unknown>[];

  /* ---- v0.4.2-cache — Wave 3 / Cache sub-team.
   * Per-Agent persistent caches keyed by sha256(template-render).
   * See docs/SUBSTRATE-V1.md §3.5 (CAS — same sharded sha256 layout,
   * different reachability semantics) + docs/WAVES.md §5.3.
   *
   * On task admission the operator's cache-controller derives a key
   * from `key` (a template that interpolates `{input_artifact_hashes}`,
   * `{image_digest}`, `{model_name}`, plus any literal text), looks up
   * `cache://sha256:<key>/<name>` in the cache PVC, and:
   *   - hit  → adds an init-container that copies bytes onto `mountPath`
   *            inside the spawned pod; emits `cache.hit` audit
   *   - miss → no init-container; the agent runs cold; emits
   *            `cache.miss` audit
   *
   * On terminal `phase=Completed`, a sidecar (operator-spawned watcher
   * Job per task — see WAVES.md §5.3 deviations note) tar-streams the
   * mountPath contents back into `cache://sha256:<key>/...` so the
   * next run that derives the same key warm-starts from disk.
   *
   * Cache miss is NEVER an error; cold fall-back is the contract.
   * Failure to save a cache entry on completion is logged as a
   * substrate-degraded WARN, never propagates to AgentTask status.
   */
  readonly caches?: readonly CacheDecl[];

  /* ---- v0.3.0-capabilities — Wave 2 sub-team Caps.
   * The substrate's sealed-authority primitive per docs/SUBSTRATE-V1.md
   * §3.6. When set, this is the upper bound on the capability bundle
   * the operator's capability-issuer mints for tasks invoking this
   * Agent. Spawn-narrowing enforces children ⊆ parent at admission.
   *
   * When set, the legacy fields below are IGNORED with a one-line WARN
   * log on Agent admission (deprecation shim, one release):
   *   - allowedChildAgents     → use claims.spawn (glob patterns supported)
   *   - allowedChildTemplates  → use claims.spawn (glob patterns)
   *   - egress (env)           → use claims.egress
   *
   * When unset, the legacy fields continue to apply (back-compat). */

  /**
   * Capability claims this Agent is permitted to mint into a JWT
   * capability bundle for any of its tasks. Each claim category is a
   * glob-pattern array (per `@kagent/capability-types` glob dialect):
   *
   *   - tools     — built-in tools the agent loop may invoke
   *   - models    — model ids the agent may call (OpenAI-compat)
   *   - spawn     — Agent name patterns this agent may spawn
   *   - read/write — `cas://` + `workspace:` prefixed targets
   *   - egress    — hostname patterns the HTTP-tool family may reach
   *   - tenant    — opaque tenant id (Wave 4 Tenancy)
   *   - publish/subscribe — Wave 3 Events topic patterns
   *
   * Schema mirror at `packages/operator/manifests/crds/agent.yaml`
   * under `spec.properties.capabilityClaims`.
   */
  readonly capabilityClaims?: CapabilityClaims;

  /* ---- v0.3.1-supervision — Wave 2 / Supervision sub-team.
   * Erlang/OTP supervision strategy for the failure-handling
   * behavior the operator applies to children of THIS agent's tasks.
   * See docs/WAVES.md §4.2 and `@kagent/supervision`'s strategy
   * engine for the action-set per strategy. */

  /**
   * Strategy the operator applies when a child AgentTask of THIS
   * agent's task fails (see `@kagent/supervision`).
   *   - `one_for_one`   restart only the failed child (DEFAULT —
   *                     matches v0.1's implicit "fail one, others
   *                     continue" semantics so existing Agents that
   *                     don't declare the field don't change behavior).
   *   - `one_for_all`   terminate every sibling + restart the subtree.
   *   - `rest_for_one`  terminate failed + every sibling started
   *                     after it (start-order); restart that subset.
   *   - `escalate`      propagate the failure to the parent task; the
   *                     parent's strategy then handles this subtree
   *                     as a single failed child.
   */
  readonly supervisionStrategy?: SupervisionStrategy;

  /**
   * Per-AgentTask restart cap. Default 3, min 0. The operator
   * increments `AgentTask.status.restartCount` each time the
   * supervision engine returns `restart` for a task; once
   * `restartCount >= maxRestarts`, the operator FAILS-CLOSED instead
   * of restarting (`reason: restart_limit_exceeded`). Setting `0`
   * disables restarts entirely — the first failure is terminal.
   *
   * The substrate's job is to bound restart loops, not to relitigate
   * an LLM's contract violation indefinitely. Tune up only when an
   * application is genuinely transient-failure prone.
   */
  readonly maxRestarts?: number;

  /* ---- v0.4.0-events — Wave 3 / Events sub-team.
   * Typed pub/sub registration on the `kagent.events.*` JetStream
   * stream per docs/SUBSTRATE-V1.md §3.7 + WAVES.md §5.1. Each entry
   * is a CONCRETE topic (no NATS wildcards — the cap claim list is
   * the glob authority). Admission validates the topic ⊆ the same
   * Agent's `capabilityClaims.publish` / `capabilityClaims.subscribe`
   * glob list — fail-closed on a topic outside the claim. */

  /**
   * Topics this Agent's tasks may publish to via the in-pod
   * `publish_event` built-in tool. Each topic is exact (validated by
   * `@kagent/events:validateTopic`) and MUST be admitted by
   * `capabilityClaims.publish` — admission refuses otherwise with
   * `reason: 'invalid_publishes'`.
   */
  readonly publishes?: readonly EventPublishDecl[];

  /**
   * Topics this Agent subscribes to. The operator's Wave 3 events
   * dispatcher provisions a NATS pull-consumer per entry; on
   * delivery, mints an AgentTask whose payload (or
   * `inputs[trigger.inputBinding]` when set) carries the event's
   * `data` field. Each topic MUST be admitted by
   * `capabilityClaims.subscribe`.
   */
  readonly subscribes?: readonly EventSubscribeDecl[];

  /* ---- v0.5.1-egress — Wave 4 / Egress sub-team.
   * Declarative network egress allowlist for Agents in this class.
   * The operator's egress-controller materializes a per-Agent
   * NetworkPolicy (or CiliumNetworkPolicy when Cilium is detected)
   * scoping outbound traffic to the declared CIDRs / domains / ports.
   *
   * Default-deny semantics: an Agent that does NOT declare `egress`
   * gets a deny-all-but-substrate-internal policy (kube-dns + NATS +
   * the LLM gateway Service). See
   * `packages/egress-controller/src/policy.ts` JSDoc for the exact
   * substrate-internal allowlist.
   *
   * Tenant fallback: when this field is unset AND the Agent's tenant
   * declares `Tenant.spec.defaultEgress`, the egress-controller's
   * `resolveEffectiveEgress` falls back to the tenant default before
   * the substrate's default-deny baseline. */

  /**
   * Per-Agent network egress allowlist. When set, the operator's
   * egress-controller emits a NetworkPolicy / CiliumNetworkPolicy
   * scoping outbound traffic to the declared CIDRs / domains /
   * ports. When unset, the Agent receives the substrate's default-
   * deny posture (DNS + NATS + LLM gateway only) — possibly widened
   * by the tenant's `defaultEgress`.
   *
   * Schema mirror at `packages/operator/manifests/crds/agent.yaml`
   * under `spec.properties.egress`.
   */
  readonly egress?: AgentEgress;
}

/* =====================================================================
 * v0.5.1-egress — Wave 4 / Egress sub-team.
 *
 * Declarative network egress allowlist for an Agent class. Materializes
 * into a per-Agent NetworkPolicy or CiliumNetworkPolicy at reconcile
 * time. Per docs/SUBSTRATE-V1.md §3.1 (`Agent.spec.egress`) +
 * docs/WAVES.md §6.2.
 *
 * Three orthogonal allowlist axes:
 *
 *   - `domains` — FQDN allowlist. Cilium's `toFQDNs` selector evaluates
 *      these natively (DNS-aware); plain NetworkPolicy's `to.ipBlock`
 *      is best-effort CIDR-resolved at reconcile time (one DNS lookup
 *      per FQDN; the resulting addresses pinned for the policy's
 *      lifetime). Domain allowlists strongly favor Cilium.
 *   - `cidrs`   — raw CIDR allowlist. Always supported by every CNI.
 *   - `ports`   — protocol+port pairs. When empty, every port on the
 *      domain/CIDR target is allowed (rarely what you want — the
 *      egress-controller logs a WARN line on empty `ports[]`).
 *
 * The shape is union'd with the tenant's `defaultEgress`: an Agent's
 * own `egress` wins; absent, the tenant default fills in; absent both,
 * substrate default-deny applies. See
 * `packages/egress-controller/src/resolver.ts` for the precedence
 * pipeline.
 * ===================================================================== */

export interface AgentEgressPort {
  /** Transport protocol — `'TCP' | 'UDP'`. K8s NetworkPolicy syntax mirror. */
  readonly protocol: 'TCP' | 'UDP';
  /** Port number. 1..65535. */
  readonly port: number;
}

export interface AgentEgress {
  /**
   * FQDN allowlist (e.g. `'api.github.com'`, `'*.googleapis.com'`).
   * Honored by Cilium's `toFQDNs` selector natively. For plain
   * `NetworkPolicy`, the egress-controller resolves each FQDN at
   * reconcile time (best-effort) and pins the resulting addresses
   * onto `to.ipBlock` rules. Cilium is strongly recommended for
   * production domain-allowlist enforcement.
   */
  readonly domains?: readonly string[];
  /**
   * Raw CIDR allowlist (e.g. `'10.0.0.0/8'`, `'1.2.3.4/32'`). Always
   * supported regardless of CNI; the substrate baseline.
   */
  readonly cidrs?: readonly string[];
  /**
   * Protocol+port pairs. Empty / unset = all ports. The
   * egress-controller logs a WARN when `ports[]` is empty; declare
   * specific ports unless you really mean any.
   */
  readonly ports?: readonly AgentEgressPort[];
}

/* =====================================================================
 * v0.4.0-events — Wave 3 / Events sub-team.
 *
 * Two declarative entries on `Agent.spec` express the Agent's pub/sub
 * footprint. They mirror the example shape in docs/SUBSTRATE-V1.md
 * §3.7 + WAVES.md §5.1 deliverable 1. Schema (JSON-Schema'd payload)
 * is OPTIONAL at the CRD level — the substrate's CloudEvents envelope
 * always wraps the payload regardless; per-topic application
 * validators are the inner shape gate (registered via
 * `@kagent/events:buildEventValidatorRegistry`).
 * ===================================================================== */

export interface EventPublishDecl {
  /**
   * Concrete topic — `[a-z0-9_-]+(\.[a-z0-9_-]+)*`, no NATS wildcards.
   * Validated by `@kagent/events:validateTopic`.
   */
  readonly topic: string;
  /**
   * Optional JSON-Schema (or a forward-compat opaque object)
   * describing the payload shape. Substrate-opaque at v0.4.0 — the
   * Wave 3 brief carves payload schema gates as application-layer.
   * The CRD persists the field verbatim so consumers can introspect
   * publishers' declared schemas via `kubectl get agents -o yaml`.
   */
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface EventSubscribeDecl {
  /** Same dialect + validator as `publishes[].topic`. */
  readonly topic: string;
  /** Optional JSON-Schema; substrate-opaque (see `EventPublishDecl.schema`). */
  readonly schema?: Readonly<Record<string, unknown>>;
  /**
   * Operator-side trigger config — what the dispatcher does when an
   * event arrives. Mirrors the `Wave 0 Entry` / `KagentSchedule`
   * pattern: declare which Agent to mint, optionally bind the
   * payload into a typed input (Wave 1 typed-I/O).
   */
  readonly trigger?: EventSubscribeTrigger;
}

export interface EventSubscribeTrigger {
  /**
   * Optional input-binding name. When set, the dispatcher renders
   * `AgentTask.spec.inputs[<inputBinding>] = { scalar: <event.data> }`
   * so the agent loop receives the payload through the Wave 1 typed-
   * input pipeline. When unset, the event's `data` is forwarded as
   * `AgentTask.spec.payload` (legacy / opaque path).
   */
  readonly inputBinding?: string;
}

/**
 * Mirror of `@kagent/supervision`'s strategy enum, declared here so
 * the CRD type surface doesn't pull in the supervision package's
 * runtime exports just for the literal-union. Keep these two in sync
 * (the supervision package is the source of truth — anything beyond
 * "the four OTP behaviors" lands there first).
 */
export type SupervisionStrategy = 'one_for_one' | 'one_for_all' | 'rest_for_one' | 'escalate';

/* =====================================================================
 * Typed I/O — input + output declarations on `Agent.spec`.
 *
 * The `kind` enum is the lowest-level contract Workspace + CAS sub-teams
 * branch from. Workspace consumes `kind: 'workspace'` (RWX PVC, mounted
 * via init-container clone, GC'd with the root task tree). CAS consumes
 * `kind: 'artifact'` (content-addressed bytes, hashed `cas://` URIs).
 * `kind: 'scalar'` is a literal value pass-through — substrate-opaque,
 * forwarded to the agent loop in-band on the bound AgentTask.
 *
 * Mount-path discipline: every `kind: workspace | artifact` input MUST
 * declare `mountPath` so the operator's job-spec builder mounts the
 * underlying volume deterministically. Admission rejects otherwise —
 * default-deny, NEVER pick a path on the agent's behalf.
 * ===================================================================== */

export type InputKind = 'workspace' | 'artifact' | 'scalar';
export type OutputKind = 'artifact' | 'scalar';
export type InputMode = 'ro' | 'rw';

export interface InputDecl {
  /** Stable name; AgentTask.spec.inputs[].name binds to this. */
  readonly name: string;
  readonly kind: InputKind;
  /** RFC 6838 media type for documentation + downstream filtering. */
  readonly mediaType?: string;
  /**
   * Container path the input is mounted at. Required for
   * `kind: 'workspace' | 'artifact'`; ignored for `kind: 'scalar'`.
   * Admission rejects when missing on a non-scalar input.
   */
  readonly mountPath?: string;
  /** Read-only vs. read-write. Defaults to `'ro'` when unset. */
  readonly mode?: InputMode;
  /**
   * Explicit opt-out from required-by-default. When true, the
   * AgentTask may omit a binding for this input.
   */
  readonly optional?: boolean;
  /**
   * Belt-and-suspenders required marker. Defaults to `true` when
   * unset and `optional` is unset. `optional: true` always wins.
   */
  readonly required?: boolean;
}

export interface OutputDecl {
  readonly name: string;
  readonly kind: OutputKind;
  readonly mediaType?: string;
  /** Defaults to true; reconciler force-fails Completed if missing. */
  readonly required?: boolean;
  /**
   * Retention duration string (e.g. `7d`, `24h`). Parsed by the CAS
   * sub-team in v0.2.2; v0.2.0 only threads the field through the
   * schema for forward-compatibility.
   */
  readonly retention?: string;
}

/* =====================================================================
 * v0.4.2-cache — Wave 3 / Cache sub-team.
 *
 * `CacheDecl` declares one persistent, reusable cache slot on an Agent.
 * Per docs/WAVES.md §5.3:
 *
 *   - `name`      — opaque, per-Agent stable identifier; the second
 *                   path segment of the cache URI
 *                   (`cache://sha256:<key>/<name>`).
 *   - `key`       — template string. Tokens (`{input_artifact_hashes}`,
 *                   `{image_digest}`, `{model_name}`) interpolate per
 *                   `@kagent/cache-controller`'s `deriveCacheKey`. Any
 *                   literal substring is preserved verbatim. `key:
 *                   "default"` is sugar for the canonical recipe
 *                   `"{input_artifact_hashes}+{image_digest}+{model_name}"`.
 *   - `mountPath` — container path the cache contents land at on
 *                   restore; same path the sidecar walks on save. The
 *                   substrate never picks a path on the agent's behalf
 *                   (default-deny per the typed-I/O mount-path
 *                   discipline).
 *
 * Cache identity is `sha256(rendered-template)`; the URI shape mirrors
 * CAS's `cas://sha256:<hex>/<name>` so the same shard + dedup tooling
 * can back both. `cache://` and `cas://` MAY share a PVC.
 */
export interface CacheDecl {
  /** Per-Agent stable identifier. ≤ 63 chars; `[a-z0-9-]` grammar. */
  readonly name: string;
  /**
   * Template string that derives the cache key. Recognized tokens:
   *
   *   - `{input_artifact_hashes}` — joined CAS sha256 hashes of every
   *     `kind: 'artifact'` input bound on the AgentTask (joined with
   *     `+`, sorted lexicographically for stable hashing).
   *   - `{image_digest}` — Agent's container image digest.
   *   - `{model_name}` — `Agent.spec.model` verbatim.
   *
   * `key: "default"` is sugar for
   * `"{input_artifact_hashes}+{image_digest}+{model_name}"`. Any
   * literal substring (e.g. `npm-{image_digest}-v2`) is preserved.
   */
  readonly key: string;
  /** Container path the cache mounts at. */
  readonly mountPath: string;
}

export interface Agent {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'Agent';
  readonly metadata: V1ObjectMeta;
  readonly spec: AgentSpec;
}

/* =====================================================================
 * AgentTask — single invocation request, addressed by agent or capability.
 * ===================================================================== */

export type AgentTaskPhase = 'Pending' | 'Dispatched' | 'Completed' | 'Failed';

/**
 * Per-run knobs surfaced to the agent loop. Mirrors `RunInput`'s
 * budget surface in `@kagent/agent-loop` (`tokenLimit`, `costLimitUsd`,
 * `maxIterations`) plus the wall-clock `timeoutSeconds`. Additive on
 * top of (and preferred over) the deprecated top-level
 * `AgentTaskSpec.timeoutSeconds` field — when both timeouts are set,
 * `runConfig.timeoutSeconds` wins.
 *
 * The CRD schema mirror lives at
 * `packages/operator/manifests/crds/agenttask.yaml` under
 * `spec.properties.runConfig`. Keep both in sync.
 */
export interface AgentTaskRunConfig {
  /** Hard cap on cumulative input+output tokens; exit with `budget_exceeded`. */
  readonly tokenLimit?: number;
  /** Hard cap on cumulative backend-reported cost (USD); exit with `budget_exceeded`. */
  readonly costLimitUsd?: number;
  /** Override the executor's default `maxIterations` (8). 1..100. */
  readonly maxIterations?: number;
  /** Wall-clock deadline; same semantics as the deprecated top-level field. */
  readonly timeoutSeconds?: number;
  /**
   * v0.1.11 — W3C Trace Context propagation. When the parent agent-pod's
   * `spawn_child_task` issues a child AgentTask, it stamps the parent's
   * current OTel span context here as a `traceparent` header value
   * (`00-<32hex traceId>-<16hex spanId>-<2hex flags>`). The operator's
   * job-spec builder threads the value into the spawned Job's container
   * env as `OTEL_TRACEPARENT`; the agent-pod's main.ts seeds its
   * OtelTraceSink root span context from that env so the child's trace
   * tree becomes a child of the parent's trace, not a sibling.
   *
   * Format is the literal W3C Trace Context value — never re-encode.
   * Substrate-opaque otherwise; nothing else in the operator inspects it.
   *
   * The CRD YAML mirror at
   * `packages/operator/manifests/crds/agenttask.yaml` carries the same
   * field under `spec.runConfig.traceparent`.
   */
  readonly traceparent?: string;
}

export interface AgentTaskSpec {
  /** Target Agent's `metadata.name`. Mutually exclusive with `targetCapability`. */
  readonly targetAgent?: string;

  /** Capability tag — resolved against the live AgentCapability registry. */
  readonly targetCapability?: string;

  /** Free-form payload the agent loop receives. Substrate-opaque. */
  readonly payload: unknown;

  /**
   * Soft time limit.
   *
   * @deprecated Prefer `runConfig.timeoutSeconds`. Kept for backward
   * compatibility; resolution: when both are set, `runConfig.timeoutSeconds`
   * wins. Operator + pod still honor this when `runConfig` is absent.
   */
  readonly timeoutSeconds?: number;

  /**
   * Per-run knobs surfaced to the agent loop. Additive over the
   * deprecated top-level `timeoutSeconds`; see `AgentTaskRunConfig`.
   */
  readonly runConfig?: AgentTaskRunConfig;

  /** UID of the AgentTask that delegated this task. */
  readonly parentTask?: string;

  /**
   * Originating user message — required at the protocol level for delegation
   * chains so sub-agents can't be context-stripped (per HARNESS-LESSONS §4).
   * If unset, the operator copies the parent task's value.
   */
  readonly originalUserMessage?: string;

  /**
   * Optional parent-agent distillation of the request. Recommended.
   *
   * @deprecated v0.2.0-typed-io — superseded by typed inputs.
   * Migration target: bind via
   * `AgentTask.spec.inputs[{ name: 'distillation', from: { taskUid: <parent>, output: 'distillation' } }]`.
   * The agent-pod logs a deprecation warning when this field is read.
   * Field stays accepted for back-compat through one minor release.
   */
  readonly parentDistillation?: string;

  /**
   * Optional list of tool category names the operator's prompt requested
   * (e.g. ['fetch_url', 'web_search']). Feeds the F2 detector at run-end.
   */
  readonly expectedTools?: readonly string[];

  /* ---- v0.2.0-typed-io — Wave 1 sub-team I/O.
   *
   * Each entry binds one of the target Agent's declared
   * `Agent.spec.inputs[]` to an actual source (a workspace name, the
   * output of an upstream AgentTask, or an inline scalar literal).
   * Admission validates: every required Agent input is bound (or
   * marked optional on the Agent declaration); every binding's
   * `from` is exactly one of `workspace | taskUid+output | scalar`. */

  /**
   * Bindings that resolve `Agent.spec.inputs[]` at runtime. Admission
   * cross-checks this against the target Agent's declared inputs and
   * rejects when a required input is missing (`reason:
   * 'InvalidInputs'`).
   */
  readonly inputs?: readonly InputBinding[];

  /**
   * Idempotency key (Stripe / Temporal pattern). When set, the
   * operator's admission cache dedupes by
   * (namespace, agent, idempotencyKey, inputHash) within a 24h TTL:
   *
   *   - cache hit, same input hash → mark `Completed` with the prior
   *     task's outputs (cached replay); emit `task.deduped`.
   *   - cache hit, different input hash → mark `Failed` with
   *     `reason: 'IdempotencyConflict'`.
   *   - cache miss → store + continue to normal admission.
   *
   * v0.2.0 cache is operator-local in-memory only. Distributed
   * dedupe via etcd is a follow-up release; the schema field is
   * stable across that change.
   */
  readonly idempotencyKey?: string;

  /**
   * v0.3.0-capabilities — Wave 2 Caps sub-team.
   *
   * `verifyContract` is the substrate-level post-completion gate.
   * When set, the reconciler runs the verification at terminal-status
   * patch time and refuses Completed if the verification fails (the
   * task lands Failed with `reason: 'verify_failed'` instead).
   *
   * Modes:
   *   - `scriptRef`: substrate spawns a one-shot Job with the
   *     referenced artifact as the entrypoint script; the script
   *     receives `KAGENT_TASK_OUTPUTS_JSON` env. Exit 0 → admit
   *     Completed; non-zero → patch Failed.
   *   - `llmJudgePromptRef`: the operator dispatches the prompt
   *     template (rendered with the task outputs) to the model
   *     gateway; the response's `verdict` field gates Completed.
   *
   * Either mode may be set; both is admissible (each independently
   * gates). When neither is set the field acts as a no-op (current
   * pre-v0.3.0 behavior).
   *
   * Audit:
   *   - `verification.passed` event on success.
   *   - `verification.failed` event on failure (carries the failure
   *     reason + a digest of the verifier's output).
   *
   * Field is reserved at v0.3.0; the implementation is wired in
   * subsequent commits per the Wave 2 brief.
   */
  readonly verifyContract?: VerifyContract;
}

/**
 * Substrate-level post-completion verification contract. Per
 * docs/WAVES.md §4.1 deliverable 7: at status-patch time the
 * reconciler runs the contract; failure → Completed → Failed with
 * `reason: 'verify_failed'`.
 */
export interface VerifyContract {
  /**
   * Reference to an artifact whose body is a verifier script. Spawned
   * as a one-shot Job; receives the task outputs as env.
   *
   * Ref shape mirrors `Agent.spec.systemPromptRef` — opaque
   * `{ name, version? }` resolved through Langfuse / artifact backend.
   */
  readonly scriptRef?: { readonly name: string; readonly version?: number };

  /**
   * Reference to an LLM-judge prompt template. The operator dispatches
   * the rendered prompt to the model gateway; the response is parsed
   * for a `verdict` field.
   */
  readonly llmJudgePromptRef?: { readonly name: string; readonly version?: number };
}

/* =====================================================================
 * Typed I/O — input bindings on `AgentTask.spec`.
 *
 * Exactly one of `from.workspace`, `from.taskUid + output`, or
 * `from.scalar` MUST be set. The CRD YAML schema enforces this with a
 * `oneOf` on the `from` block; the TS surface here makes the discriminant
 * a tagged union so admission code reads cleanly without runtime sniffing.
 * ===================================================================== */

export type InputFrom =
  | { readonly workspace: string }
  | { readonly taskUid: string; readonly output: string }
  | { readonly scalar: unknown };

export interface InputBinding {
  /** MUST match an `Agent.spec.inputs[].name` on the target Agent. */
  readonly name: string;
  readonly from: InputFrom;
}

/**
 * Reference into a substrate output produced by an AgentTask. Populated
 * on `AgentTask.status.outputs` by the operator's reconciler from the
 * agent-pod's status patch — `ref` shape varies by output kind:
 *   - `kind: 'artifact'` → CAS URI (`cas://sha256:<hex>/<name>` once
 *     v0.2.2-cas lands; `pvc://kagent-artifacts/<task-uid>/<name>` in
 *     v0.2.0).
 *   - `kind: 'scalar'`   → string-encoded scalar (typically JSON).
 */
export interface OutputRef {
  readonly name: string;
  readonly ref: string;
}

/**
 * Discrete status condition observed for an AgentTask, modeled after
 * the standard Kubernetes condition pattern (type/status/reason/message
 * + lastTransitionTime). WS-E uses these for additive failure context
 * — e.g. an OOMKill detected after the pod already wrote `Completed`
 * appends a `JobFailedAfterComplete` condition rather than overwriting
 * the terminal phase.
 */
export interface AgentTaskCondition {
  /**
   * CamelCase identifier — `Dispatched`, `Failed`, `ImagePullBackOff`,
   * `OOMKilled`, `DeadlineExceeded`, `JobFailedAfterComplete`, etc.
   * Free-form by design; consumers match by string.
   */
  readonly type: string;
  readonly status: 'True' | 'False' | 'Unknown';
  readonly reason?: string;
  readonly message?: string;
  /** RFC 3339 timestamp; preserved across no-op condition rewrites. */
  readonly lastTransitionTime: string;
  /** `metadata.generation` observed when this condition was emitted. */
  readonly observedGeneration?: number;
}

export interface AgentTaskStatus {
  readonly phase?: AgentTaskPhase;
  readonly result?: unknown;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  /** Pod that ran this task (Job-spawned in v0.1). */
  readonly podName?: string;
  /**
   * `metadata.generation` the operator most recently reconciled. WS-E.
   * Consumers can compare `metadata.generation` vs.
   * `status.observedGeneration` to tell whether the operator has caught
   * up to a new spec write. Operator-owned; the agent-pod stamps it
   * too on its terminal write so observers see the agent's view.
   */
  readonly observedGeneration?: number;
  /**
   * Append-only list of discrete conditions (Kubernetes pattern). WS-E
   * uses this to surface failure context that doesn't fit the single
   * terminal `phase` field — e.g. multiple failure modes within one
   * task UID, or a Job-level failure detected after the pod's success
   * write.
   */
  readonly conditions?: readonly AgentTaskCondition[];
  /**
   * Detector-emitted verdict envelope per HARNESS-LESSONS §6. Empty
   * `suspicious` = clean run.
   */
  readonly structuralVerdict?: {
    readonly suspicious: readonly string[];
  };
  /**
   * Artifacts produced by this task (substrate-defined `ArtifactRef`s).
   * Empty/undefined = no artifacts. Bytes live behind `uri` in the
   * configured backend (PVC v0.1, MinIO v0.2); etcd carries metadata
   * only. See `docs/ARTIFACTS.md` for the addressing scheme + retention
   * policy. Optional / additive in v0.1 — no agent loop populates this
   * yet (writer lands in the next slice).
   */
  readonly artifacts?: readonly ArtifactRef[];
  /**
   * v0.2.0-typed-io — output references the agent-pod published, keyed
   * by the `Agent.spec.outputs[].name`. Populated by the agent-pod's
   * terminal status patch; the operator's reconciler validates that
   * each `Agent.spec.outputs[].required` entry is present here before
   * admitting `phase=Completed` (missing required → force `Failed`
   * with `reason: MissingRequiredOutputs`).
   */
  readonly outputs?: readonly OutputRef[];
  /* ---- Workstream 5 / Phase 5 — parent/child task-graph projection.
   *
   * Populated by the operator's parent re-reconcile path
   * (`reconcileParentFromChildEvent` in `reconcile.ts`). All fields
   * are additive + optional so existing AgentTasks remain valid; the
   * agent-pod NEVER writes these — they are operator-owned state
   * derived from a `LIST agenttasks --label-selector=parent-task-uid`.
   *
   * The shape mirrors `ParentStatusProjection` in `task-graph.ts`,
   * minus the `children: ChildRef[]` field which is duplicated here
   * with a slightly different optional-readonly profile to satisfy
   * the strict CRD-types pattern. See docs/TASK-GRAPH.md §4 for the
   * aggregation algorithm. */
  readonly children?: ReadonlyArray<{
    readonly name: string;
    readonly namespace: string;
    readonly uid?: string;
    readonly phase?: AgentTaskPhase;
    readonly completedAt?: string;
    readonly error?: string;
  }>;
  /**
   * Aggregate phase across `children`, distinct from this task's own
   * `phase` (which describes the parent's own pod-side work).
   */
  readonly aggregatePhase?:
    | 'Pending'
    | 'Dispatched'
    | 'PartiallyComplete'
    | 'AllComplete'
    | 'AnyFailed';
  /** Number of children currently in `phase=Completed`. */
  readonly successCount?: number;
  /** Number of children currently in `phase=Failed`. */
  readonly failureCount?: number;
  /** Children that have not reached a terminal phase yet. */
  readonly inFlightCount?: number;

  /**
   * v0.3.0-capabilities — Wave 2 Caps sub-team.
   *
   * The `<jti>` of the JWT capability bundle the operator's
   * capability-issuer minted for this task. Used for forensics
   * (re-find the bundle in the operator's capability registry by
   * jti) + revocation. Operator-owned; the agent-pod NEVER writes
   * this — the cap is signed BEFORE the Job is admitted.
   */
  readonly capabilityRef?: string;

  /**
   * v0.3.0-capabilities — Wave 2 Caps sub-team.
   *
   * Verification result captured by the reconciler when
   * `AgentTask.spec.verifyContract` is set. Populated only after the
   * verifier runs (Completed status patch path). Absent on tasks
   * that don't declare a verifyContract.
   */
  readonly verification?: {
    readonly passed: boolean;
    readonly mode: 'script' | 'llmJudge';
    readonly reason?: string;
    readonly completedAt?: string;
  };

  /**
   * v0.3.1-supervision — Wave 2 / Supervision sub-team.
   *
   * Number of times the operator's supervision engine has restarted
   * THIS task. Bumped each time `evaluateStrategy` returns `restart`
   * (or `terminate-and-restart-{tree,subset}` for tasks in the
   * targets[] list). When `restartCount >= Agent.spec.maxRestarts`,
   * the operator fails-closed with `reason: restart_limit_exceeded`
   * instead of restarting again. Default 0 (operator omits the field
   * for never-restarted tasks).
   */
  readonly restartCount?: number;
}

export interface AgentTask {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'AgentTask';
  readonly metadata: V1ObjectMeta;
  readonly spec: AgentTaskSpec;
  readonly status?: AgentTaskStatus;
}

/* =====================================================================
 * AgentCapability — capability tag → matcher rules.
 *
 * v0.1 ships the type definition + CRD manifest but reconcile logic
 * leans on the `agents-live` NATS KV bucket for capability resolution
 * (Phase 3). This CRD is the persistent / declarative form for
 * matcher rules that don't fit a heartbeat model — e.g. an explicit
 * "this capability resolves to a specific agent name only when label X."
 * Materially used in v0.2.
 * ===================================================================== */

export interface AgentCapabilitySpec {
  /** Capability tag — appears in AgentTask.spec.targetCapability. */
  readonly capability: string;

  /** Optional label selector to narrow which Agents satisfy this capability. */
  readonly agentSelector?: { readonly matchLabels?: Readonly<Record<string, string>> };
}

export interface AgentCapability {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'AgentCapability';
  readonly metadata: V1ObjectMeta;
  readonly spec: AgentCapabilitySpec;
}

/* =====================================================================
 * AgentTemplate (WS-M) — declarative recipe for dynamic specialists.
 *
 * The materializer (`template-instantiator.ts`) consumes one of these
 * + a parameter map, computes a deterministic agentName, and posts an
 * `Agent` CR with the rendered spec. The orchestrator agent never
 * holds Agent-create RBAC — it only asks the operator to materialize
 * a template instance. See docs/AGENT-TEMPLATES.md.
 * ===================================================================== */

export type AgentTemplateParameterType = 'string' | 'integer' | 'toolSelection';

export interface AgentTemplateParameter {
  readonly name: string;
  readonly type: AgentTemplateParameterType;
  readonly pattern?: string;
  readonly allowedValues?: readonly string[];
  readonly required?: boolean;
  readonly default?: string;
}

export interface AgentTemplateBudget {
  readonly maxIterations?: number;
  readonly maxCostUsdPerRun?: number;
  readonly maxParallelInstances?: number;
}

export interface AgentTemplateSpec {
  readonly templateVersion?: number;
  readonly revisionHistoryLimit?: number;
  readonly idleTtlSeconds?: number;
  readonly parameters?: readonly AgentTemplateParameter[];
  readonly budget?: AgentTemplateBudget;
  readonly toolAllowlist?: readonly string[];
  readonly toolDefaults?: readonly string[];
  /**
   * Template body. Substituted with `${param.X}` placeholders before
   * being written to the materialized Agent's spec. Mustache-without-
   * helpers semantics — see `template-instantiator.ts:renderAgentSpec`.
   */
  readonly agentSpec: Readonly<Record<string, unknown>>;
}

export interface AgentTemplateStatus {
  readonly liveInstanceCount?: number;
  readonly lastInstantiatedAt?: string;
  readonly conditions?: readonly AgentTaskCondition[];
}

export interface AgentTemplate {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'AgentTemplate';
  readonly metadata: V1ObjectMeta;
  readonly spec: AgentTemplateSpec;
  readonly status?: AgentTemplateStatus;
}

/* =====================================================================
 * ModelEndpoint — declares the per-(model, backend) concurrency cap.
 *
 * Source of truth for both the operator's admission reconciler (spec —
 * what to queue against) and the LLM gateway's AIMD self-tuner (status —
 * live observed in-flight). Same CR; the gateway uses the `status`
 * subresource so spec writes from GitOps and status writes from the
 * gateway never race. See docs/superpowers/specs/2026-05-03-llm-gateway-
 * bundle-design.md §3.3 for the full design + YAML example.
 * ===================================================================== */

/**
 * Backend kind drives which signal-reader the gateway uses (e.g.
 * Ollama `/api/ps` vs. Cloudflare `x-ratelimit-*` headers vs. backend-
 * specific 429 shapes). Kept as a string-union so adding a backend is
 * a CRD bump rather than a code change in the operator.
 */
export type ModelEndpointBackendKind =
  | 'ollama'
  | 'cloudflare'
  | 'openrouter'
  | 'bedrock'
  | 'openai'
  | 'anthropic'
  | 'localai'
  | 'groq'
  | 'exo';

/**
 * AIMD bounds. `seed` is the starting concurrency the gateway uses on
 * cold start; `max` is the ceiling the AIMD self-tuner will not cross
 * even after a long clean-window of successful responses.
 */
export interface ModelEndpointInFlight {
  readonly seed: number;
  readonly max: number;
}

export interface ModelEndpointSpec {
  /**
   * Model identifier as it appears in `Agent.spec.model` (full
   * LiteLLM-style id WITH provider prefix, per CLAUDE.md).
   */
  readonly model: string;
  /** Backend kind — drives the gateway's signal-reader. */
  readonly backendKind: ModelEndpointBackendKind;
  /**
   * Backend address. Provider-agnostic at the kagent layer; the
   * gateway resolves it according to `backendKind`.
   */
  readonly backendUrl: string;
  /** AIMD bounds: starting + ceiling concurrency. */
  readonly inFlight: ModelEndpointInFlight;
  /**
   * Optional hard floor — the AIMD tuner never reduces the live cap
   * below this. Useful for cloud APIs with known concurrency budgets
   * (e.g. Bedrock per-key) where halving on a transient 429 would
   * over-correct.
   */
  readonly minSafe?: number;
}

/**
 * Status subresource. Written by the LLM gateway as it converges its
 * AIMD self-tuner on the actual in-flight ceiling the backend
 * sustains. The operator's admission reconciler reads this so it
 * always queues against the *actual* capacity, not the static
 * `spec.inFlight.seed`.
 */
export interface ModelEndpointStatus {
  /** Gateway-reported live cap (post-AIMD). */
  readonly observedInFlight?: number;
  /** RFC 3339 timestamp of the most recent gateway sample. */
  readonly lastSampledAt?: string;
  /** Rolling error rate over the gateway's recent window (0..1). */
  readonly recentErrorRate?: number;
}

export interface ModelEndpoint {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'ModelEndpoint';
  readonly metadata: V1ObjectMeta;
  readonly spec: ModelEndpointSpec;
  readonly status?: ModelEndpointStatus;
}

/* =====================================================================
 * Type guards — runtime-checkable shapes used by the watch handler when
 * the API server hands back `unknown`-typed CR objects.
 * ===================================================================== */

export function isAgentTask(obj: unknown): obj is AgentTask {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'AgentTask') return false;
  if (typeof o.spec !== 'object' || o.spec === null) return false;
  return true;
}

export function isAgent(obj: unknown): obj is Agent {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'Agent') return false;
  const spec = o.spec as { model?: unknown } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (typeof spec.model !== 'string' || spec.model.length === 0) return false;
  return true;
}

export function isModelEndpoint(obj: unknown): obj is ModelEndpoint {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'ModelEndpoint') return false;
  const spec = o.spec as {
    model?: unknown;
    backendKind?: unknown;
    backendUrl?: unknown;
    inFlight?: unknown;
  } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (typeof spec.model !== 'string' || spec.model.length === 0) return false;
  if (typeof spec.backendKind !== 'string' || spec.backendKind.length === 0) return false;
  if (typeof spec.backendUrl !== 'string' || spec.backendUrl.length === 0) return false;
  const inFlight = spec.inFlight as { seed?: unknown; max?: unknown } | null;
  if (typeof inFlight !== 'object' || inFlight === null) return false;
  if (typeof inFlight.seed !== 'number') return false;
  if (typeof inFlight.max !== 'number') return false;
  return true;
}
