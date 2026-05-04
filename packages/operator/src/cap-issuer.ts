/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Capability-issuer — the operator-side glue that mints a JWT
 * capability bundle for an admitted AgentTask (v0.3.0-capabilities,
 * Wave 2 Caps).
 *
 * Responsibilities (per WAVES.md §4.1 deliverable 3):
 *   1. Resolve the target Agent's `capabilityClaims`.
 *   2. If the task was spawned (parent task UID known), narrow the
 *      Agent's claims by intersecting with the parent's bundle. The
 *      child cap MUST be a subset of the parent — substrate-enforced
 *      composition rule per docs/SUBSTRATE-V1.md §3.6.
 *   3. Augment with the substrate-managed claims (`tenant` from the
 *      Agent CR, scoped to the AgentTask).
 *   4. Sign via `CapCa.mint()`.
 *   5. Return `{ jti, jwt, expiresAt, claims, narrowedFrom }` so the
 *      reconciler can:
 *        - Mount the JWT into the spawned Job (via Secret-volume).
 *        - Stamp `AgentTask.status.capabilityRef = jti` on the
 *          status patch.
 *        - Emit the `capability.minted` audit event.
 *
 * Kept pure-ish — no K8s API calls live here. Inputs include the
 * already-fetched parent bundle (when the spawning agent-pod sent
 * one) and the Agent CR (already loaded by the reconciler). The
 * issuer just composes claims + signs.
 */

import {
  ALL_CAPABILITY_CLAIM_CATEGORIES,
  claimsSubsetViolations,
  formatViolations,
  type CapabilityBundle,
  type CapabilityClaims,
  type SubsetViolation,
} from '@kagent/capability-types';

import type { CapCa, MintCapResult } from './cap-ca.js';
import type { Agent, AgentTask } from './crds/index.js';

/**
 * Inputs to `mintCapabilityForTask`.
 */
export interface MintCapForTaskInput {
  readonly task: AgentTask;
  readonly agent: Agent;
  /**
   * Parent's already-verified capability bundle. Required when the
   * task carries a `parentTask` UID (i.e. it was spawned by a
   * `spawn_child_task` call); the issuer narrows the child claims
   * against this bundle. Undefined for root tasks.
   */
  readonly parentBundle?: CapabilityBundle;
  /**
   * Test-injectable randomly-generated jti. Production omits.
   */
  readonly jtiOverride?: string;
}

/**
 * Output of `mintCapabilityForTask`. The reconciler uses every field:
 *   - `jwt` is mounted into the spawned Job's pod via Secret-volume
 *     (file: `/var/kagent/cap/cap.jwt`).
 *   - `jti` is stamped on `AgentTask.status.capabilityRef`.
 *   - `expiresAt` is recorded in audit (`capability.minted` event's
 *     `expiresAt` field).
 *   - `claims` is the post-narrowing claims object — same content the
 *     JWT carries, exposed as a typed value so audit emission doesn't
 *     have to re-decode.
 */
export interface MintCapForTaskResult {
  readonly jwt: string;
  readonly jti: string;
  readonly expiresAt: number;
  readonly claims: CapabilityClaims;
}

/**
 * Subset-check failure path. `mintCapabilityForTask` throws
 * `CapabilityViolationError` when the parent's bundle does NOT admit
 * the Agent's declared `capabilityClaims` (the reconciler patches the
 * task Failed with `reason: 'policy_denied:capability_violation'`).
 */
export class CapabilityViolationError extends Error {
  constructor(
    readonly violations: readonly SubsetViolation[],
    readonly parentJti: string,
  ) {
    super(`capability_violation: ${formatViolations(violations)}`);
    this.name = 'CapabilityViolationError';
  }
}

/**
 * Mint a capability for the given task. Pure compose-around the
 * `CapCa.mint()` call: resolve claims → narrow → sign.
 *
 * Algorithm:
 *
 *   1. Pull `Agent.spec.capabilityClaims` (the upper bound this Agent
 *      is permitted to mint). If unset, fall back to the legacy
 *      `allowedChildAgents` / `allowedChildTemplates` translation
 *      (deprecation shim).
 *
 *   2. If the task has a parent, intersect with the parent bundle:
 *      - Per category, take only entries the parent's pattern set
 *        admits.
 *      - For literals (no glob), simple set-intersection.
 *      - For globs, promote the parent's pattern when the child's
 *        glob is a subset of one of the parent's globs (we don't
 *        construct intersection of two globs — we keep the child's
 *        if it's already ⊆ parent).
 *
 *   3. Validate the final claims are ⊆ parent (defense in depth — the
 *      narrowing should always satisfy this, but if intersection
 *      misses a category we throw `CapabilityViolationError`).
 *
 *   4. Sign + return.
 */
export async function mintCapabilityForTask(
  ca: CapCa,
  input: MintCapForTaskInput,
): Promise<MintCapForTaskResult> {
  const agentClaims = resolveAgentClaims(input.agent);

  const narrowed =
    input.parentBundle === undefined
      ? agentClaims
      : narrowClaimsByParent(agentClaims, input.parentBundle.claims);

  if (input.parentBundle !== undefined) {
    const violations = claimsSubsetViolations(narrowed, input.parentBundle.claims);
    if (violations.length > 0) {
      throw new CapabilityViolationError(violations, input.parentBundle.jti);
    }
  }

  const taskUid = input.task.metadata.uid ?? '';
  if (taskUid.length === 0) {
    throw new Error('mintCapabilityForTask: AgentTask has no metadata.uid');
  }
  const jti = input.jtiOverride ?? defaultJti(taskUid);

  const ttlSeconds = pickTtlSeconds(input.task);

  const result: MintCapResult = await ca.mint({
    subjectTaskUid: taskUid,
    jti,
    claims: narrowed,
    ...(ttlSeconds !== undefined && { ttlSeconds }),
  });

  return {
    jwt: result.jwt,
    jti: result.jti,
    expiresAt: result.expiresAt,
    claims: narrowed,
  };
}

/**
 * Resolve effective `CapabilityClaims` from an Agent CR. When
 * `Agent.spec.capabilityClaims` is set, that's the authority. When
 * absent, fall back to legacy fields:
 *   - `allowedChildAgents`        → `claims.spawn`
 *   - `allowedChildTemplates`     → `claims.spawn` (template-name
 *                                   patterns prefixed `template:` so
 *                                   admission can distinguish)
 *
 * Legacy fallback is intentionally narrow — the deprecation note in
 * WAVES.md §4.1 says the legacy fields stay readable for ONE release;
 * use of them logs a WARN at admission time (handled in admission.ts).
 */
export function resolveAgentClaims(agent: Agent): CapabilityClaims {
  const declared = agent.spec.capabilityClaims;
  if (declared !== undefined) return declared;

  const out: { -readonly [K in keyof CapabilityClaims]: CapabilityClaims[K] } = {};
  const legacySpawn: string[] = [];
  if (Array.isArray(agent.spec.allowedChildAgents)) {
    for (const n of agent.spec.allowedChildAgents) {
      if (typeof n === 'string' && n.length > 0) legacySpawn.push(n);
    }
  }
  if (Array.isArray(agent.spec.allowedChildTemplates)) {
    for (const t of agent.spec.allowedChildTemplates) {
      if (typeof t === 'string' && t.length > 0) {
        // Encode template-name patterns with a `template:` prefix so
        // the runtime can distinguish a template-admit from an
        // exact-name-admit. Spawn-narrowing in the agent-pod knows
        // about both encodings.
        legacySpawn.push(`template:${t}`);
      }
    }
  }
  if (legacySpawn.length > 0) out.spawn = legacySpawn;

  return out;
}

/**
 * Intersect `child` with `parent`. The result MUST satisfy
 * `claimsAreSubsetOf(result, parent)`.
 *
 * For each category:
 *   - Drop any child pattern that no parent pattern admits.
 *   - Keep child patterns that ARE admitted (they're narrower or
 *     equal).
 *   - The substrate doesn't auto-add parent patterns the child
 *     didn't declare — that would silently grant authority the
 *     Agent never asked for.
 */
export function narrowClaimsByParent(
  child: CapabilityClaims,
  parent: CapabilityClaims,
): CapabilityClaims {
  const out: { -readonly [K in keyof CapabilityClaims]: CapabilityClaims[K] } = {};

  for (const cat of ALL_CAPABILITY_CLAIM_CATEGORIES) {
    if (cat === 'tenant') {
      // Tenant doesn't intersect — child takes parent's tenant when
      // child's is unset (inherit), or must equal parent's when
      // child sets one (admission rejects mismatch).
      const childTenant = child.tenant;
      const parentTenant = parent.tenant;
      if (childTenant !== undefined) {
        if (parentTenant === undefined || childTenant !== parentTenant) {
          // Don't carry — admission will catch this on the subset
          // check that follows the narrow.
          continue;
        }
        out.tenant = childTenant;
      } else if (parentTenant !== undefined) {
        // Inherit: a child without a tenant claim is implicitly
        // scoped to the parent's tenant.
        out.tenant = parentTenant;
      }
      continue;
    }

    const childList = child[cat] ?? [];
    if (childList.length === 0) continue;
    const parentList = parent[cat] ?? [];
    const filtered: string[] = [];
    for (const pat of childList) {
      if (patternIsAdmittedByList(pat, parentList)) filtered.push(pat);
    }
    if (filtered.length > 0) assignArrayCategoryNarrowed(out, cat, filtered);
  }
  return out;
}

/* =====================================================================
 * Internals
 * ===================================================================== */

import { globPatternIsSubset } from '@kagent/capability-types';
import type { CapabilityClaimCategory } from '@kagent/capability-types';

function patternIsAdmittedByList(child: string, parent: readonly string[]): boolean {
  if (parent.length === 0) return false;
  for (const p of parent) {
    if (globPatternIsSubset(child, p)) return true;
  }
  return false;
}

function defaultJti(taskUid: string): string {
  // Convention: `cap-<8-char hex>` derived from the task UID + a
  // random nonce so audit-log queries can lattice-join `taskUid` to
  // `jti` reliably (the suffix collisions don't matter — etcd dedup
  // handles them).
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  let hex = '';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  // Use a short prefix from taskUid so audit grep is direct.
  const prefix = taskUid.slice(0, 8);
  return `cap-${prefix}-${hex}`;
}

/**
 * Choose a TTL for the cap JWT. Production heuristic: the task's
 * `runConfig.timeoutSeconds` (when set) plus a 60s slack so the cap
 * outlives the pod by a small margin. When the task has no deadline,
 * the JWT helper's default (`DEFAULT_CAP_JWT_TTL_SECONDS = 600`)
 * applies.
 */
function pickTtlSeconds(task: AgentTask): number | undefined {
  const rcTimeout = task.spec.runConfig?.timeoutSeconds;
  if (typeof rcTimeout === 'number' && rcTimeout > 0 && Number.isFinite(rcTimeout)) {
    return rcTimeout + 60;
  }
  const legacyTimeout = task.spec.timeoutSeconds;
  if (typeof legacyTimeout === 'number' && legacyTimeout > 0 && Number.isFinite(legacyTimeout)) {
    return legacyTimeout + 60;
  }
  return undefined;
}

function assignArrayCategoryNarrowed(
  out: { -readonly [K in keyof CapabilityClaims]: CapabilityClaims[K] },
  cat: CapabilityClaimCategory,
  list: readonly string[],
): void {
  switch (cat) {
    case 'tools':
      out.tools = list;
      return;
    case 'models':
      out.models = list;
      return;
    case 'spawn':
      out.spawn = list;
      return;
    case 'read':
      out.read = list;
      return;
    case 'write':
      out.write = list;
      return;
    case 'egress':
      out.egress = list;
      return;
    case 'publish':
      out.publish = list;
      return;
    case 'subscribe':
      out.subscribe = list;
      return;
    case 'tenant':
      // Tenant is handled before this fn; included for exhaustiveness.
      return;
  }
}
