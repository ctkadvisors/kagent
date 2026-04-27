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
}

export interface AgentTask {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'AgentTask';
  readonly metadata: V1ObjectMeta;
  readonly spec: AgentTaskSpec;
  readonly status?: AgentTaskStatus;
}
