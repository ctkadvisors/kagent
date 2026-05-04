/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AgentTask admission validators — v0.2.0-typed-io (Wave 1 / I/O).
 *
 * Distinct from `admission.ts` (which gates Job un-suspend by per-model
 * + per-Agent capacity), this module covers the typed-I/O contract on
 * AgentTask creation:
 *
 *   1. `validateAgentTaskInputs(agent, task)` — admission rejects with
 *      `reason: 'InvalidInputs'` when `AgentTask.spec.inputs[]` doesn't
 *      satisfy the target `Agent.spec.inputs[]` (missing required,
 *      unknown bindings, malformed `from` discriminants, mountPath
 *      missing on workspace/artifact inputs).
 *
 *   2. `IdempotencyCache` — operator-local in-memory cache keyed by
 *      `(namespace, agent, idempotencyKey)`. 24h TTL; entries store
 *      input-hash + cached outputs so the second submission of the
 *      same key replays the prior task's outputs (Stripe / Temporal
 *      pattern).
 *
 *   3. `validateRequiredOutputsPresent(agent, status.outputs)` —
 *      reconciler refuses a `Completed` patch when any required Agent
 *      output is missing from `AgentTask.status.outputs[]`. Returns
 *      the list of missing names so the caller can compose the
 *      structured failure reason.
 *
 * v0.2.0 keeps the cache process-local. Distributed dedupe via etcd is
 * a follow-up release; the public API on this module stays stable
 * across that change (hash + key are the only inputs).
 */

import type { Agent, AgentSpec, AgentTask, AgentTaskSpec, OutputRef } from './crds/index.js';
import {
  API_GROUP_VERSION,
  hashTaskInputs,
  inputsMissingMountPath,
  outputsByName,
  requiredOutputNames,
  validateInputBindings,
} from './crds/index.js';

/* =====================================================================
 * Typed-input contract validation
 * ===================================================================== */

/**
 * Result of `validateAgentTaskInputs`. `ok: false` carries the
 * structured rejection reason + a human-readable message admission
 * surfaces on the AgentTask's status (`reason`, `message`) and on the
 * `contract.violated` audit event.
 */
export type TypedInputValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'InvalidInputs';
      readonly message: string;
      readonly missing: readonly string[];
      readonly unknownBindings: readonly string[];
      readonly malformed: readonly string[];
      readonly mountPathMissing: readonly string[];
    };

export function validateAgentTaskInputs(
  agent: Agent | AgentSpec,
  task: AgentTask | AgentTaskSpec,
): TypedInputValidation {
  const bindingResult = validateInputBindings(agent, task);
  const mountPathMissing = inputsMissingMountPath(agent);

  const anyFailure =
    bindingResult.missing.length > 0 ||
    bindingResult.unknown.length > 0 ||
    bindingResult.malformed.length > 0 ||
    mountPathMissing.length > 0;

  if (!anyFailure) return { ok: true };

  const parts: string[] = [];
  if (bindingResult.missing.length > 0) {
    parts.push(`missing required inputs: [${bindingResult.missing.join(', ')}]`);
  }
  if (bindingResult.unknown.length > 0) {
    parts.push(`unknown input bindings: [${bindingResult.unknown.join(', ')}]`);
  }
  if (bindingResult.malformed.length > 0) {
    parts.push(`malformed input bindings: [${bindingResult.malformed.join(', ')}]`);
  }
  if (mountPathMissing.length > 0) {
    parts.push(
      `Agent.spec.inputs missing mountPath: [${mountPathMissing.join(', ')}] (required for kind: workspace | artifact)`,
    );
  }
  const message = parts.join('; ');

  return {
    ok: false,
    reason: 'InvalidInputs',
    message,
    missing: bindingResult.missing,
    unknownBindings: bindingResult.unknown,
    malformed: bindingResult.malformed,
    mountPathMissing,
  };
}

/* =====================================================================
 * v0.3.0-capabilities — capability admission validator
 *
 * Defense-in-depth gate: even if a compromised agent-pod's
 * `spawn_child_task` skipped the in-pod cap check, the operator's
 * admission MUST refuse to admit a child whose Agent claims escalate
 * past the parent's. Mirrors the in-pod refusal taxonomy
 * (`policy_denied:capability_violation`) so per-trace observability
 * rolls up.
 * ===================================================================== */

import {
  claimsSubsetViolations,
  formatViolations,
  type CapabilityBundle,
} from '@kagent/capability-types';
import { resolveAgentClaims } from './cap-issuer.js';

export type CapabilityAdmissionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'CapabilityViolation';
      readonly message: string;
    };

/**
 * Validate the target Agent's resolved claims are ⊆ parent's bundle
 * claims. Used by admission BEFORE Job creation when the spawning
 * task carried a verifiable parent capability bundle. When no parent
 * bundle is present (root task), the validator passes trivially —
 * the issuer assigns whatever claims the Agent declares.
 *
 * Refusal `reason: 'CapabilityViolation'` lands as a status
 * condition + a `contract.violated` audit event; the AgentTask is
 * marked Failed with `policy_denied:capability_violation` to mirror
 * the in-pod refusal string.
 */
export function validateCapabilityBounds(
  agent: Agent | AgentSpec,
  parentBundle: CapabilityBundle | undefined,
): CapabilityAdmissionValidation {
  if (parentBundle === undefined) return { ok: true };
  const agentRef: Agent =
    'spec' in agent
      ? agent
      : { apiVersion: API_GROUP_VERSION, kind: 'Agent', metadata: {}, spec: agent };
  // Pass the full Agent CR shape to resolveAgentClaims; it accepts
  // the (Agent | AgentSpec)-narrowing pattern same as our other
  // validators.
  const agentClaims = resolveAgentClaims(agentRef);
  const violations = claimsSubsetViolations(agentClaims, parentBundle.claims);
  if (violations.length === 0) return { ok: true };
  return {
    ok: false,
    reason: 'CapabilityViolation',
    message: `policy_denied:capability_violation — Agent claims escalate past parent cap (jti=${parentBundle.jti}): ${formatViolations(violations)}`,
  };
}

/* =====================================================================
 * Required-outputs validation (reconciler-side)
 * ===================================================================== */

export type RequiredOutputsValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'MissingRequiredOutputs';
      readonly message: string;
      readonly missing: readonly string[];
    };

/**
 * Validate that every `Agent.spec.outputs[].required` entry is present
 * in `AgentTask.status.outputs[]`. The reconciler invokes this when
 * the agent-pod patches `phase=Completed`; on `ok: false` the
 * reconciler force-fails the task with `reason: 'MissingRequiredOutputs'`
 * and emits a `contract.violated` audit event.
 *
 * Back-compat: an Agent without `outputs[]` always passes (v0.1
 * Agents trivially satisfy the empty contract).
 */
export function validateRequiredOutputsPresent(
  agent: Agent | AgentSpec,
  taskOutputs: readonly OutputRef[] | undefined,
): RequiredOutputsValidation {
  const required = requiredOutputNames(agent);
  if (required.length === 0) return { ok: true };
  const present = outputsByName(taskOutputs);
  const missing: string[] = [];
  for (const name of required) {
    if (!present.has(name)) missing.push(name);
  }
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    reason: 'MissingRequiredOutputs',
    message: `agent-pod published phase=Completed but required outputs are missing: [${missing.join(', ')}]`,
    missing,
  };
}

/* =====================================================================
 * Idempotency cache — operator-local in-memory TTL map
 * ===================================================================== */

/** 24h. Per WAVES.md §3.1 + spec on `AgentTask.spec.idempotencyKey`. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Distinguishing dimensions for a cache hit. We key by
 * `namespace + agent + idempotencyKey` so the same key reused under a
 * different Agent (or in a different namespace) is NOT a hit — same
 * pattern Stripe documents for the Idempotency-Key header (key scope =
 * authenticated principal + idempotency key).
 */
export interface IdempotencyKey {
  readonly namespace: string;
  readonly agentName: string;
  readonly idempotencyKey: string;
}

export interface IdempotencyEntry {
  /** Hash over the bound inputs + payload — see hashTaskInputs. */
  readonly inputHash: string;
  /** UID of the originating AgentTask (for diagnostics). */
  readonly originalTaskUid: string;
  /** Outputs captured from the original task's terminal Completed write. */
  readonly outputs: readonly OutputRef[];
  /** Wall-clock ms when this entry was inserted; TTL evicts older. */
  readonly insertedAtMs: number;
}

/**
 * Result of `IdempotencyCache.checkAndStore`:
 *
 *   - `kind: 'miss'`      → no entry exists yet; the caller proceeds
 *                            to normal admission and later calls
 *                            `recordOutputs` from the terminal write.
 *   - `kind: 'replay'`    → cache hit, same input hash → admission
 *                            short-circuits, marks the new task
 *                            Completed with the cached outputs, and
 *                            emits `task.deduped`.
 *   - `kind: 'conflict'`  → cache hit, DIFFERENT input hash →
 *                            admission marks the new task Failed
 *                            with `reason: 'IdempotencyConflict'`.
 */
export type IdempotencyDecision =
  | { readonly kind: 'miss' }
  | {
      readonly kind: 'replay';
      readonly originalTaskUid: string;
      readonly outputs: readonly OutputRef[];
    }
  | {
      readonly kind: 'conflict';
      readonly originalTaskUid: string;
      readonly storedHash: string;
      readonly incomingHash: string;
    };

export interface IdempotencyCacheOptions {
  /** Defaults to `DEFAULT_IDEMPOTENCY_TTL_MS` (24h). */
  readonly ttlMs?: number;
  /** Override for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class IdempotencyCache {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: IdempotencyCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Check the cache for `key`; if no live entry exists, store the
   * incoming `originalTaskUid` + `inputHash` (with empty outputs)
   * and return `{ kind: 'miss' }`. The caller later calls
   * `recordOutputs` once the original task completes so a future
   * replay can return cached outputs.
   *
   * On a live entry with the same input hash → `replay`.
   * On a live entry with a DIFFERENT input hash → `conflict`.
   * Expired entries are dropped before the comparison (TTL eviction).
   */
  checkAndStore(
    key: IdempotencyKey,
    inputHash: string,
    originalTaskUid: string,
  ): IdempotencyDecision {
    this.evictExpired();
    const k = this.keyOf(key);
    const existing = this.entries.get(k);
    if (existing === undefined) {
      this.entries.set(k, {
        inputHash,
        originalTaskUid,
        outputs: [],
        insertedAtMs: this.now(),
      });
      return { kind: 'miss' };
    }
    if (existing.inputHash !== inputHash) {
      return {
        kind: 'conflict',
        originalTaskUid: existing.originalTaskUid,
        storedHash: existing.inputHash,
        incomingHash: inputHash,
      };
    }
    return {
      kind: 'replay',
      originalTaskUid: existing.originalTaskUid,
      outputs: existing.outputs,
    };
  }

  /**
   * Replace the cached entry's `outputs` once the original task
   * completes. Used by the reconciler's terminal-write path to make
   * subsequent replay decisions surface the real outputs.
   *
   * Called best-effort from the status patch path; a no-op if the
   * entry has been TTL-evicted in the meantime (unlikely within 24h
   * of the original task's completion but defensive).
   */
  recordOutputs(key: IdempotencyKey, outputs: readonly OutputRef[]): void {
    const k = this.keyOf(key);
    const existing = this.entries.get(k);
    if (existing === undefined) return;
    this.entries.set(k, { ...existing, outputs });
  }

  /** Test/diagnostic surface: number of live entries. */
  size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /** Test surface: clear all entries (e.g. between vitest cases). */
  reset(): void {
    this.entries.clear();
  }

  private keyOf(key: IdempotencyKey): string {
    // Pipe is non-special in ns/name/key strings (K8s names disallow
    // it). Pipe-join is cheaper than JSON-encoding three fields per
    // lookup in the hot path.
    return `${key.namespace}|${key.agentName}|${key.idempotencyKey}`;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.entries) {
      if (v.insertedAtMs <= cutoff) this.entries.delete(k);
    }
  }
}

/* =====================================================================
 * Convenience: derive the cache key + hash from the task itself.
 * ===================================================================== */

/**
 * Build an `IdempotencyKey` from the AgentTask + resolved Agent. The
 * Agent name is resolved (capability → agent name) BEFORE this is
 * called — admission already does that resolution for the dispatch
 * path, so this stays a pure helper.
 *
 * Returns null when the task has no `idempotencyKey` set (cache is
 * skipped). Returns null when the agent name can't be resolved.
 */
export function deriveIdempotencyKey(
  task: AgentTask,
  resolvedAgentName: string,
): IdempotencyKey | null {
  const k = task.spec.idempotencyKey;
  if (typeof k !== 'string' || k.length === 0) return null;
  if (resolvedAgentName.length === 0) return null;
  return {
    namespace: task.metadata.namespace ?? 'default',
    agentName: resolvedAgentName,
    idempotencyKey: k,
  };
}

/** Compute the hash over the task's bound inputs + payload. Re-export
 * via the typed-IO surface so admission callers only need one import. */
export { hashTaskInputs };

/* =====================================================================
 * v0.4.0-events — Wave 3 / Events sub-team admission validator.
 *
 * Walks `Agent.spec.publishes[]` + `Agent.spec.subscribes[]` and
 * confirms every topic is admitted by the same Agent's
 * `capabilityClaims.publish` / `.subscribe` glob list. Refusal lands
 * as `reason: 'invalid_publishes'` / `'invalid_subscribes'` so the
 * substrate's structured-cause discipline holds — operators see
 * which topic violated the cap, not just "the Agent CR was
 * rejected".
 *
 * Same defense-in-depth pattern as the in-pod publish_event tool:
 * cap-claim is the GLOB authority; publishes/subscribes are CONCRETE
 * topics. Rejecting at admission keeps malformed Agent specs out of
 * the cluster before any Job is ever materialized.
 * ===================================================================== */

import type { EventTopicSubsetViolation } from '@kagent/events';
import { topicSubsetViolations } from '@kagent/events';

export type EventTopicsValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'InvalidEventTopics';
      readonly message: string;
      readonly violations: readonly EventTopicSubsetViolation[];
    };

/**
 * Validate every `Agent.spec.publishes[].topic` ⊆
 * `capabilityClaims.publish` AND every
 * `Agent.spec.subscribes[].topic` ⊆ `capabilityClaims.subscribe`.
 * Returns `ok: true` for Agents that declare neither (back-compat
 * with pre-Wave-3 Agents).
 *
 * Used by the Agent admission path AND the AgentTask admission path
 * (the latter so a stale Agent informer cache doesn't slip an
 * unauthorized topic past once admission already accepted the Agent
 * CR but its claims tightened in a later GitOps update).
 */
export function validateEventTopicsAgainstClaims(agent: Agent | AgentSpec): EventTopicsValidation {
  const spec = 'spec' in agent ? agent.spec : agent;
  const publishes = (spec.publishes ?? []).map((p) => p.topic);
  const subscribes = (spec.subscribes ?? []).map((s) => s.topic);
  if (publishes.length === 0 && subscribes.length === 0) return { ok: true };
  const claims = spec.capabilityClaims ?? {};
  const violations = topicSubsetViolations({
    publishes,
    subscribes,
    ...(claims.publish !== undefined && { publishClaims: claims.publish }),
    ...(claims.subscribe !== undefined && { subscribeClaims: claims.subscribe }),
  });
  if (violations.length === 0) return { ok: true };
  const lines = violations.map(
    (v) =>
      `${v.category} topic "${v.topic}" → ${v.reason === 'invalid_topic' ? 'malformed' : 'not admitted by claims'}`,
  );
  return {
    ok: false,
    reason: 'InvalidEventTopics',
    message: `Agent.spec.publishes/subscribes admission failed: ${lines.join('; ')}`,
    violations,
  };
}
