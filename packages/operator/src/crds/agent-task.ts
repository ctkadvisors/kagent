/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Typed I/O surface — v0.2.0-typed-io (Wave 1 sub-team I/O).
 *
 * Helpers for `AgentTask.spec.inputs[]` bindings + idempotency-key
 * derivation. Sibling to `agent.ts` so admission, reconciler, and tests
 * can reach a single source of truth for binding-shape predicates.
 *
 * The `from: { workspace | taskUid+output | scalar }` discriminant is
 * the contract Workspace + CAS sub-teams branch from. `from.workspace`
 * resolves through the Workspace controller's CRD; `from.taskUid+output`
 * resolves at agent-pod boot time by reading the upstream task's
 * `status.outputs[]` (typically a CAS URI in v0.2.2).
 */

import type {
  Agent,
  AgentSpec,
  AgentTask,
  AgentTaskSpec,
  InputBinding,
  InputFrom,
  OutputRef,
} from './types.js';

import { inputIsRequired } from './agent.js';

/* =====================================================================
 * Binding-shape predicates — narrow `InputFrom` at compile time.
 * ===================================================================== */

export function isFromWorkspace(
  from: InputFrom,
): from is { readonly workspace: string } {
  return 'workspace' in from && typeof from.workspace === 'string';
}

export function isFromTaskUidOutput(
  from: InputFrom,
): from is { readonly taskUid: string; readonly output: string } {
  return (
    'taskUid' in from &&
    typeof from.taskUid === 'string' &&
    'output' in from &&
    typeof from.output === 'string'
  );
}

export function isFromScalar(from: InputFrom): from is { readonly scalar: unknown } {
  return 'scalar' in from && !('workspace' in from) && !('taskUid' in from);
}

/**
 * Validate exactly one discriminant is set — admission rejects
 * otherwise. Returns one of: `'workspace' | 'taskUid' | 'scalar' |
 * null` (null = malformed / multiple keys / no keys).
 */
export function fromKindOrNull(from: InputFrom): 'workspace' | 'taskUid' | 'scalar' | null {
  if (typeof from !== 'object' || from === null) return null;
  const hasWs = isFromWorkspace(from);
  const hasTask = isFromTaskUidOutput(from);
  const hasScalar = isFromScalar(from);
  // Defensive: count discriminants explicitly. The TS union makes them
  // mutually exclusive at the type level but a CR coming off the API
  // server is `unknown` until we narrow it.
  const count = (hasWs ? 1 : 0) + (hasTask ? 1 : 0) + (hasScalar ? 1 : 0);
  if (count !== 1) return null;
  if (hasWs) return 'workspace';
  if (hasTask) return 'taskUid';
  return 'scalar';
}

/* =====================================================================
 * Admission validation — typed-input contract.
 * ===================================================================== */

/**
 * Result of `validateInputBindings`. Non-empty `missing` or
 * `malformed` means admission must reject the AgentTask with
 * `reason: 'InvalidInputs'` and an audit `contract.violated` event.
 *
 *   - `missing`:   names of required Agent inputs the task didn't bind
 *   - `unknown`:   binding names that don't appear on the Agent's
 *                  declared inputs (typo / drift)
 *   - `malformed`: bindings with zero or multiple `from` discriminants
 */
export interface InputValidationResult {
  readonly missing: readonly string[];
  readonly unknown: readonly string[];
  readonly malformed: readonly string[];
}

export function validateInputBindings(
  agent: Agent | AgentSpec,
  task: AgentTask | AgentTaskSpec,
): InputValidationResult {
  const agentSpec = 'spec' in agent ? agent.spec : agent;
  const taskSpec = 'spec' in task ? task.spec : task;
  const declared = agentSpec.inputs ?? [];
  const bound = taskSpec.inputs ?? [];

  const declByName = new Map<string, (typeof declared)[number]>();
  for (const decl of declared) declByName.set(decl.name, decl);

  const boundByName = new Map<string, InputBinding>();
  const malformed: string[] = [];
  for (const b of bound) {
    if (typeof b.name !== 'string' || b.name.length === 0) {
      malformed.push('<unnamed>');
      continue;
    }
    const kind = fromKindOrNull(b.from);
    if (kind === null) {
      malformed.push(b.name);
      continue;
    }
    boundByName.set(b.name, b);
  }

  const missing: string[] = [];
  for (const decl of declared) {
    if (!inputIsRequired(decl)) continue;
    if (!boundByName.has(decl.name)) missing.push(decl.name);
  }

  const unknownNames: string[] = [];
  for (const name of boundByName.keys()) {
    if (!declByName.has(name)) unknownNames.push(name);
  }

  return { missing, unknown: unknownNames, malformed };
}

/**
 * Deterministic hash over an AgentTask's bound inputs + payload —
 * used by the idempotency-key cache to differentiate
 * "same key, same inputs → replay" from "same key, different inputs →
 * conflict" per Stripe's idempotency semantics.
 *
 * Implementation note: we deliberately use a small portable hash
 * (FNV-1a on a stable JSON projection) rather than dragging in
 * `node:crypto` here — admission already runs in the operator's hot
 * path and the hash space is collision-resistant enough for a 24h
 * in-memory dedupe window. v0.3+ moves to SHA-256 once the cache
 * goes distributed (etcd-backed).
 */
export function hashTaskInputs(task: AgentTask | AgentTaskSpec): string {
  const spec = 'spec' in task ? task.spec : task;
  const projection = {
    targetAgent: spec.targetAgent ?? '',
    targetCapability: spec.targetCapability ?? '',
    payload: spec.payload ?? null,
    inputs: stableSortInputs(spec.inputs),
  };
  return fnv1aHex(stableStringify(projection));
}

/**
 * Helper: walk an OutputRef list and turn it into a name->ref map.
 * Used by the reconciler when checking required outputs are present
 * AND when caching a deduped task's outputs for idempotency replay.
 */
export function outputsByName(refs: readonly OutputRef[] | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (refs === undefined) return out;
  for (const r of refs) {
    if (typeof r.name === 'string' && r.name.length > 0 && typeof r.ref === 'string') {
      out.set(r.name, r.ref);
    }
  }
  return out;
}

/* =====================================================================
 * Internal helpers
 * ===================================================================== */

function stableSortInputs(
  inputs: readonly InputBinding[] | undefined,
): readonly Pick<InputBinding, 'name' | 'from'>[] {
  if (inputs === undefined) return [];
  const copy = inputs.map((b) => ({ name: b.name, from: b.from }));
  copy.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return copy;
}

/**
 * Stable JSON stringify — sorts object keys recursively so the same
 * logical object always serializes to identical bytes regardless of
 * insertion order. Required so two AgentTasks with the same inputs but
 * different field-write order hash identically.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ':' + stableStringify(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * FNV-1a 32-bit hash → 8-char hex string. Trivial cost; sufficient
 * for an in-memory 24h dedupe window. Distributed-cache version
 * upgrades to SHA-256 in v0.3.
 */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // Math.imul keeps the multiply within 32 bits.
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned 32-bit.
  return (h >>> 0).toString(16).padStart(8, '0');
}
