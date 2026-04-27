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

export interface AgentTaskSpec {
  /** Target Agent's `metadata.name`. Mutually exclusive with `targetCapability`. */
  readonly targetAgent?: string;

  /** Capability tag — resolved against the live AgentCapability registry. */
  readonly targetCapability?: string;

  /** Free-form payload the agent loop receives. Substrate-opaque. */
  readonly payload: unknown;

  /** Soft time limit. Operator does not enforce; agent loop honors via RunBudget. */
  readonly timeoutSeconds?: number;

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

export interface AgentTaskStatus {
  readonly phase?: AgentTaskPhase;
  readonly result?: unknown;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  /** Pod that ran this task (Job-spawned in v0.1). */
  readonly podName?: string;
  /**
   * Detector-emitted verdict envelope per HARNESS-LESSONS §6. Empty
   * `suspicious` = clean run.
   */
  readonly structuralVerdict?: {
    readonly suspicious: readonly string[];
  };
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
