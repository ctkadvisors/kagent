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

  /** Optional parent-agent distillation of the request. Recommended. */
  readonly parentDistillation?: string;

  /**
   * Optional list of tool category names the operator's prompt requested
   * (e.g. ['fetch_url', 'web_search']). Feeds the F2 detector at run-end.
   */
  readonly expectedTools?: readonly string[];
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
