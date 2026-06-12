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
  /**
   * Physical model id passed to LiteLLM (e.g. `workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct`).
   *
   * Optional since the substrate's `modelClass` primitive landed
   * (v0.1.8-modelclass.0) — an Agent may declare a logical capability
   * tier (`modelClass`) instead of a hard-coded physical model id, and
   * the operator's resolver translates the class to a model centrally
   * via chart values.
   *
   * AT LEAST ONE of `model` or `modelClass` MUST be set; admission
   * rejects otherwise. When both are set, `model` is the explicit
   * override (escape-hatch for one-off agents that need a physical
   * model the cluster's classes don't cover); the operator-side
   * resolver prefers `model` over `modelClass`.
   *
   * Mirror of `AgentSpec.model` in `operator/src/crds/types.ts` —
   * see that file for the canonical comments. Keep both in sync.
   */
  readonly model?: string;
  /**
   * Logical model-capability tier (e.g. `tool-caller-default`,
   * `text-generator-default`). Resolved to a physical model id by the
   * operator at job-spec build time via chart-supplied class→model
   * values. Mirror of `AgentSpec.modelClass` in `operator/src/crds/types.ts`.
   */
  readonly modelClass?: string;
  readonly systemPrompt?: string;
  /**
   * v0.1.6 — Langfuse-managed system prompt reference. Mirror of
   * AgentSpec.systemPromptRef in operator/crds/types.ts.
   */
  readonly systemPromptRef?: {
    readonly name: string;
    readonly version?: number;
  };
  readonly tools?: readonly string[];
  /** Gateway-owned tool profile grant resolved centrally by the tool gateway. */
  readonly toolProfileRef?: string;
  /** Alias for `toolProfileRef` using the user-facing agent-type term. */
  readonly agentType?: string;
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

export interface AgentTaskRunConfig {
  readonly tokenLimit?: number;
  readonly costLimitUsd?: number;
  readonly maxIterations?: number;
  readonly timeoutSeconds?: number;
  /** W3C Trace Context value stamped on child tasks by spawn_child_task. */
  readonly traceparent?: string;
}

export interface AgentTaskSpec {
  readonly targetAgent?: string;
  readonly targetCapability?: string;
  readonly payload: unknown;
  readonly timeoutSeconds?: number;
  readonly runConfig?: AgentTaskRunConfig;
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

export interface AgentTaskCondition {
  readonly type: string;
  readonly status: 'True' | 'False' | 'Unknown';
  readonly reason?: string;
  readonly message?: string;
  readonly lastTransitionTime: string;
  readonly observedGeneration?: number;
}

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
 * Channels
 *
 * Mirror of `packages/operator/src/crds/channel.ts`. Kept here so
 * Workbench can watch the channel control-plane CRDs without depending
 * on @kagent/operator internals.
 * ===================================================================== */

export type ChannelProvider = 'whatsapp' | 'workbench' | 'webhook' | (string & {});
export type ChannelPeerKind = 'dm' | 'group' | 'channel' | 'room';
export type ChannelDmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled';
export type ChannelGroupPolicy = 'allowlist' | 'open' | 'disabled';

export interface ChannelLocalRef {
  readonly name: string;
}

export interface ChannelSecretKeyRef extends ChannelLocalRef {
  readonly key?: string;
}

export interface ChannelPvcRef {
  readonly claimName: string;
}

export interface ChannelPeer {
  readonly kind: ChannelPeerKind;
  readonly id: string;
}

export interface ChannelPolicy {
  readonly dmPolicy?: ChannelDmPolicy;
  readonly allowFrom?: readonly string[];
  readonly groupPolicy?: ChannelGroupPolicy;
  readonly groupAllowFrom?: readonly string[];
  readonly groups?: readonly string[];
}

export interface ChannelSessionStorage {
  readonly secretRef?: ChannelLocalRef;
  readonly pvc?: ChannelPvcRef;
}

export interface ChannelWhatsAppSpec {
  readonly authDir?: string;
  readonly sendReadReceipts?: boolean;
  readonly mediaMaxMb?: number;
}

export interface ChannelSpec {
  readonly provider: ChannelProvider;
  readonly accountId: string;
  readonly displayName?: string;
  readonly paused?: boolean;
  readonly authSecretRef?: ChannelSecretKeyRef;
  readonly sessionStorage?: ChannelSessionStorage;
  readonly policy?: ChannelPolicy;
  readonly whatsapp?: ChannelWhatsAppSpec;
}

export type ChannelPhase = 'Pending' | 'Pairing' | 'Ready' | 'Paused' | 'Failed';

export interface ChannelPairingStatus {
  readonly state: 'unpaired' | 'qr' | 'paired' | 'failed';
  readonly qrCode?: string;
  readonly pairingCode?: string;
  readonly expiresAt?: string;
  readonly accountJid?: string;
  readonly message?: string;
}

export interface ChannelStatus {
  readonly phase?: ChannelPhase;
  readonly observedGeneration?: number;
  readonly conditions?: readonly AgentTaskCondition[];
  readonly pairing?: ChannelPairingStatus;
  readonly lastHeartbeatAt?: string;
  readonly activeSessionCount?: number;
}

export interface Channel {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'Channel';
  readonly metadata: V1ObjectMeta;
  readonly spec: ChannelSpec;
  readonly status?: ChannelStatus;
}

export interface ChannelBindingMatch {
  readonly accountId?: string;
  readonly peer?: ChannelPeer;
  readonly threadId?: string;
}

export interface ChannelBindingTarget {
  readonly agentRef?: ChannelLocalRef;
  readonly capability?: string;
  readonly profileRef?: string;
  readonly modelClass?: string;
  readonly toolProfileRef?: string;
  readonly runConfig?: AgentTaskRunConfig;
  readonly session?: {
    readonly scope?: 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer';
    readonly mainKey?: string;
  };
}

export interface ChannelBindingSpec {
  readonly channelRef: ChannelLocalRef;
  readonly match?: ChannelBindingMatch;
  readonly default?: boolean;
  readonly paused?: boolean;
  readonly target: ChannelBindingTarget;
  readonly approval?: {
    readonly required?: boolean;
    readonly mode?: 'operator' | 'per-turn' | 'tool';
  };
}

export interface ChannelBindingStatus {
  readonly observedGeneration?: number;
  readonly conditions?: readonly AgentTaskCondition[];
  readonly lastMatchedAt?: string;
}

export interface ChannelBinding {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'ChannelBinding';
  readonly metadata: V1ObjectMeta;
  readonly spec: ChannelBindingSpec;
  readonly status?: ChannelBindingStatus;
}

export type ChannelSessionPhase = 'Pending' | 'Active' | 'Paused' | 'Backoff' | 'Failed';

export interface ChannelTaskRef {
  readonly namespace: string;
  readonly name: string;
  readonly uid?: string;
}

export interface ChannelSessionSpec {
  readonly channelRef: ChannelLocalRef;
  readonly provider: ChannelProvider;
  readonly accountId: string;
  readonly peer: ChannelPeer;
  readonly threadId?: string;
  readonly sessionKey: string;
  readonly bindingRef?: ChannelLocalRef;
  readonly target: ChannelBindingTarget;
  readonly paused?: boolean;
}

export interface ChannelSessionStatus {
  readonly phase?: ChannelSessionPhase;
  readonly observedGeneration?: number;
  readonly conditions?: readonly AgentTaskCondition[];
  readonly lastInboundAt?: string;
  readonly lastOutboundAt?: string;
  readonly lastTaskRef?: ChannelTaskRef;
  readonly lastOutboundTaskRef?: ChannelTaskRef;
  readonly consecutiveFailures?: number;
  readonly backoffUntil?: string;
  readonly lastFailureReason?: string;
}

export interface ChannelSession {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'ChannelSession';
  readonly metadata: V1ObjectMeta;
  readonly spec: ChannelSessionSpec;
  readonly status?: ChannelSessionStatus;
}

export function isChannel(obj: unknown): obj is Channel {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'Channel') return false;
  const spec = o.spec as { provider?: unknown; accountId?: unknown } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  return isNonEmptyString(spec.provider) && isNonEmptyString(spec.accountId);
}

export function isChannelBinding(obj: unknown): obj is ChannelBinding {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'ChannelBinding') return false;
  const spec = o.spec as { channelRef?: { name?: unknown }; target?: unknown } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (!isNonEmptyString(spec.channelRef?.name)) return false;
  return isValidChannelTarget(spec.target);
}

export function isChannelSession(obj: unknown): obj is ChannelSession {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'ChannelSession') return false;
  const spec = o.spec as {
    channelRef?: { name?: unknown };
    provider?: unknown;
    accountId?: unknown;
    peer?: unknown;
    sessionKey?: unknown;
    target?: unknown;
  } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (!isNonEmptyString(spec.channelRef?.name)) return false;
  if (!isNonEmptyString(spec.provider)) return false;
  if (!isNonEmptyString(spec.accountId)) return false;
  if (!isChannelPeer(spec.peer)) return false;
  if (!isNonEmptyString(spec.sessionKey)) return false;
  return isValidChannelTarget(spec.target);
}

function isValidChannelTarget(target: unknown): target is ChannelBindingTarget {
  if (typeof target !== 'object' || target === null) return false;
  const t = target as {
    agentRef?: { name?: unknown };
    capability?: unknown;
    profileRef?: unknown;
    modelClass?: unknown;
    toolProfileRef?: unknown;
  };
  if (t.agentRef !== undefined && !isNonEmptyString(t.agentRef.name)) return false;
  if (t.capability !== undefined && !isNonEmptyString(t.capability)) return false;
  if (t.profileRef !== undefined && !isNonEmptyString(t.profileRef)) return false;
  if (t.modelClass !== undefined && !isNonEmptyString(t.modelClass)) return false;
  if (t.toolProfileRef !== undefined && !isNonEmptyString(t.toolProfileRef)) return false;
  return (
    isNonEmptyString(t.agentRef?.name) ||
    isNonEmptyString(t.capability) ||
    isNonEmptyString(t.profileRef)
  );
}

function isChannelPeer(value: unknown): value is ChannelPeer {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as { kind?: unknown; id?: unknown };
  return isChannelPeerKind(p.kind) && isNonEmptyString(p.id);
}

function isChannelPeerKind(value: unknown): value is ChannelPeerKind {
  return value === 'dm' || value === 'group' || value === 'channel' || value === 'room';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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
