/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Local copy of the operator's CRD TypeScript shapes — re-declared here
 * (rather than imported from `@kagent/operator`) so `@kagent/dto` stays a
 * leaf workspace dependency.
 *
 * **Why duplicate.** The natural dep direction is *operator → dto* (the
 * operator should consume the DTO read-model when it serves status to a
 * future Workbench API), so `dto → operator` would invert the long-term
 * arrow. The operator package today exposes no public API surface — its
 * `exports` map only points at `./src/index.ts`, which doesn't re-export
 * the CRD types — so importing from `@kagent/operator/src/crds/...js` in
 * a downstream consumer would reach into private internals.
 *
 * The pragmatic slice (per Workstream 1 brief): copy the type shapes here
 * with a TODO to consolidate post-Workbench-MVP. There is one source of
 * truth for the CRD wire schema — the YAML under `manifests/crds/` —
 * and both this file and `packages/operator/src/crds/types.ts` have to
 * mirror it. Keep them in sync if either changes.
 *
 * TODO(post-mvp): once a `@kagent/crds` package exists (just the type
 * declarations, zero runtime code), move both copies behind it and have
 * both `@kagent/operator` and `@kagent/dto` consume that.
 */

import type { V1ObjectMeta } from '@kubernetes/client-node';

export const API_GROUP = 'kagent.knuteson.io';
export const API_VERSION = 'v1alpha1';
export const API_GROUP_VERSION = `${API_GROUP}/${API_VERSION}` as const;

/* =====================================================================
 * Agent
 * ===================================================================== */

export interface AgentSpec {
  readonly model: string;
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly sandboxProfile?: 'default' | 'strict';
  /**
   * WS-K — agents this Agent may spawn as children via the in-pod
   * `spawn_child_task` tool. Empty / unset = no children may be
   * spawned UNLESS `allowedChildTemplates` admits the target.
   */
  readonly allowedChildAgents?: readonly string[];
  /**
   * v0.1.3 — companion to `allowedChildAgents` that admits children
   * by the `kagent.knuteson.io/from-template` label on the target
   * Agent CR (set by the WS-M template-instantiator). Both lists
   * union; an Agent without the label is never admitted by this field.
   */
  readonly allowedChildTemplates?: readonly string[];
  /** WS-K — direct-child concurrency cap. Default 10. */
  readonly maxConcurrentChildren?: number;
  /**
   * v0.1.4 — declarative LLM request-tuning knobs (temperature,
   * maxTokens, stopSequences) threaded through to every chat() call.
   * Unset fields = provider defaults.
   */
  readonly llmParams?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly stopSequences?: readonly string[];
  };
  /**
   * Opt-in per-Agent fairness cap (LLM-gateway bundle, spec §3.4).
   * Upper bound on the number of in-flight Jobs the operator's
   * admission reconciler will leave un-suspended for this Agent.
   * Absent = unlimited at this layer; the per-(model, backend) cap on
   * the matching `ModelEndpoint` is the only gate when this is unset.
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
 * AgentTask
 * ===================================================================== */

export type AgentTaskPhase = 'Pending' | 'Dispatched' | 'Completed' | 'Failed';

export interface AgentTaskSpec {
  readonly targetAgent?: string;
  readonly targetCapability?: string;
  readonly payload: unknown;
  readonly timeoutSeconds?: number;
  readonly parentTask?: string;
  readonly originalUserMessage?: string;
  readonly parentDistillation?: string;
  readonly expectedTools?: readonly string[];
}

/**
 * Substrate-defined artifact handle. Type-only mirror of
 * `packages/operator/src/crds/artifact-ref.ts`'s `ArtifactRef` (the
 * runtime helpers — pvcUri, parseArtifactUri, inlineSafe — stay in
 * the operator package; the DTO layer only ever reads refs back).
 *
 * See docs/ARTIFACTS.md for the full type rationale. Mirrored here
 * so `@kagent/dto` stays a leaf workspace dep — once a shared
 * `@kagent/crds` package exists, both copies fold behind it.
 */
export interface ArtifactRef {
  readonly uri: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly checksum?: string;
  readonly name?: string;
  readonly producedAt?: string;
}

/**
 * Parent/child task-graph projection. Operator-owned state populated
 * by `reconcileParentFromChildEvent`; agent-pods never write these.
 * Mirror of the `ChildRef` shape in
 * `packages/operator/src/crds/types.ts`.
 */
export interface ChildRef {
  readonly name: string;
  readonly namespace: string;
  readonly uid?: string;
  readonly phase?: AgentTaskPhase;
  readonly completedAt?: string;
  readonly error?: string;
}

export type AggregatePhase =
  | 'Pending'
  | 'Dispatched'
  | 'PartiallyComplete'
  | 'AllComplete'
  | 'AnyFailed';

export interface AgentTaskStatus {
  readonly phase?: AgentTaskPhase;
  readonly result?: unknown;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly podName?: string;
  readonly structuralVerdict?: {
    readonly suspicious: readonly string[];
  };

  /**
   * Artifacts produced by this task. Populated by the agent-pod's
   * end-of-run collation step (see packages/agent-pod/src/runner.ts).
   * Empty/undefined = no artifacts. Bytes live behind `uri` in the
   * configured backend; etcd carries metadata only.
   */
  readonly artifacts?: readonly ArtifactRef[];

  /* ---- Phase 5 / Workstream 5 — parent/child task-graph projection.
   * Operator-owned. See packages/operator/src/crds/types.ts and
   * docs/TASK-GRAPH.md §4 for the aggregation algorithm. */

  /** Children spawned by this task as a parent (delegation chain). */
  readonly children?: readonly ChildRef[];

  /** Aggregate phase across `children` — distinct from this task's own `phase`. */
  readonly aggregatePhase?: AggregatePhase;

  /** Children currently in `phase=Completed`. */
  readonly successCount?: number;

  /** Children currently in `phase=Failed`. */
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
 * ModelEndpoint
 *
 * Mirror of `packages/operator/src/crds/types.ts`'s `ModelEndpoint`
 * (per the duplication contract documented at the top of this file).
 * Source-of-truth = the YAML schema under
 * `packages/operator/charts/kagent-operator/crds/modelendpoint.yaml`.
 * See docs/superpowers/specs/2026-05-03-llm-gateway-bundle-design.md
 * §3.3 for the full design + YAML example.
 * ===================================================================== */

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

export interface ModelEndpointInFlight {
  readonly seed: number;
  readonly max: number;
}

export interface ModelEndpointSpec {
  readonly model: string;
  readonly backendKind: ModelEndpointBackendKind;
  readonly backendUrl: string;
  readonly inFlight: ModelEndpointInFlight;
  readonly minSafe?: number;
}

export interface ModelEndpointStatus {
  readonly observedInFlight?: number;
  readonly lastSampledAt?: string;
  readonly recentErrorRate?: number;
}

export interface ModelEndpoint {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'ModelEndpoint';
  readonly metadata: V1ObjectMeta;
  readonly spec: ModelEndpointSpec;
  readonly status?: ModelEndpointStatus;
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
