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
import {
  decideCapTtl,
  type CapTtlDecision,
  type CapTtlPolicy,
} from '@kagent/keyrotation-controller';
import { makeEvent, type AuditEvent } from '@kagent/audit-events';
import type { CoreV1Api } from '@kubernetes/client-node';

import type { CapCa, MintCapResult } from './cap-ca.js';
import type { Agent, AgentTask, AgentWorkflow, Tenant } from './crds/index.js';
import { resolveTenantIssuer } from './crds/index.js';
import { classifyToolAsProposal } from './disposition/proposal-tool-map.js';
import {
  narrowByDispositionOverlay,
  type ProposalRejection,
} from './disposition/narrow-by-overlay.js';
import type { DispositionOverlay } from './disposition/overlay-loader.js';
import { incrementProposalsToday } from './disposition/proposals-counter.js';

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
  /**
   * v0.5.0-tenancy — Wave 4 / Tenancy sub-team. The Tenant CR resolved
   * for this task (from the AgentTask's or Agent's
   * `metadata.labels[kagent.knuteson.io/tenant]` lookup against the
   * Tenant informer cache). When present:
   *
   *   1. The minted bundle's `claims.tenant` is set to the tenant's
   *      canonical name (substrate-attributable; ungrabbable by any
   *      Agent claim).
   *   2. The minted bundle's JWT `iss` (RFC 7519 §4.1.1) is set to
   *      `spec.capabilityRoot.issuer` when the tenant declares one,
   *      otherwise the operator's default issuer applies.
   *
   * When the AgentTask carries no resolvable tenant (legacy install,
   * no Tenant CR yet), this is undefined and the cap is minted
   * tenant-less (the existing v0.3.0 behavior).
   *
   * Precedence on `claims.tenant`:
   *   1. Explicit `Agent.spec.capabilityClaims.tenant` (Agent author
   *      pinned a tenant) — kept as-is, MUST equal `tenant?.spec.name`
   *      or admission rejects.
   *   2. Tenant default (`tenant.spec.name`) — applied here when (1)
   *      is unset.
   *   3. Operator default (none) — `claims.tenant` left unset.
   */
  readonly tenant?: Tenant;
  /**
   * v0.5.4-keyrotation — Wave 4 / KeyRotation sub-team. The resolved
   * cap TTL policy from `@kagent/keyrotation-controller`. When
   * provided, `mintCapabilityForTask` consumes it via `applyTtlPolicy`
   * to compute `exp`; the resolved tier is exposed on the result so
   * the reconciler can emit `keyrotation.cap_minted_with_ttl`.
   *
   * When undefined (legacy / pre-Wave-4 install), the issuer falls
   * back to its v0.3.0 heuristic (`runConfig.timeoutSeconds + 60s`,
   * else JWT helper default). Forward-compat: a deployment can flip
   * Wave 4 keyrotation on without breaking pre-Wave-4 callsites.
   */
  readonly ttlPolicy?: CapTtlPolicy;
  /**
   * Phase 1 / DISP-02 — AgentDisposition overlay loader. Optional.
   * When provided, the cap-issuer reads the per-Agent overlay
   * (sibling ConfigMap labeled `kagent.knuteson.io/agent-disposition=true`
   * with annotation `kagent.knuteson.io/agent-ref=<ns>/<name>`) and
   * narrows the minted JWT's `tools` claim against
   * `proposalScope.mayProposeAgainst`. Self-proposal terminology
   * only: narrows; never widens.
   *
   * If undefined, no narrowing applied (back-compat for call sites
   * predating Phase 1). If the loader throws, narrowing is treated
   * as "no overlay" (fail-open for availability — malformed overlays
   * fail closed in the parser/schema path).
   */
  readonly loadDispositionOverlay?: (
    agentNamespace: string,
    agentName: string,
  ) => Promise<DispositionOverlay | null>;
  /**
   * Phase 1 / DISP-02 — audit-event publisher. Optional. Emits one
   * `disposition.proposal_rejected` event per excluded proposal-category
   * tool. If undefined OR the publish call rejects, narrowing still
   * applies (the rejection is recorded in
   * `MintCapForTaskResult.dispositionRejections` for caller observability).
   */
  readonly auditPublisher?: { publish(event: AuditEvent): Promise<void> };
  /**
   * Phase 1 / DISP-02 → DISP-03 bridge — Kubernetes core API client.
   * Optional. When provided AND an overlay was loaded AND the minted
   * JWT carries a proposal-category tool, the cap-issuer PATCHes the
   * disposition ConfigMap's `kagent.knuteson.io/proposals-today`
   * annotation to increment the daily proposal counter. Read by the
   * workbench-api dispositions projection (plan 03).
   */
  readonly coreApi?: Pick<CoreV1Api, 'patchNamespacedConfigMap' | 'readNamespacedConfigMap'>;
  /**
   * Phase 1 / DISP-02 → DISP-03 bridge — clock injection for the
   * UTC-day boundary computation. Defaults to `() => new Date()`.
   * Tests inject a deterministic now to verify rollover semantics.
   */
  readonly now?: () => Date;
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
  readonly issuer: string;
  readonly expiresAt: number;
  readonly claims: CapabilityClaims;
  /**
   * v0.5.4-keyrotation — populated when `MintCapForTaskInput.ttlPolicy`
   * was supplied. Records the decision the cap-TTL policy made (the
   * resolved seconds + the tier — short-running / long-running-grace /
   * long-running-clamped) so the reconciler can emit
   * `keyrotation.cap_minted_with_ttl`. Undefined when the legacy
   * (pre-Wave-4) TTL heuristic was used.
   */
  readonly ttlDecision?: CapTtlDecision;
  /**
   * Phase 1 / DISP-02 — proposal-tool rejections produced by the
   * disposition overlay narrowing step. Empty / undefined when no
   * overlay was loaded or when no tools were excluded.
   */
  readonly dispositionRejections?: readonly ProposalRejection[];
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

  // Phase 1 / DISP-02 — apply AgentDisposition overlay narrowing
  // BEFORE parent-narrowing. The overlay narrows the per-Agent base
  // scope; parent-narrowing then intersects against the parent-bundle.
  // Order matters: overlay rules are an Agent-author expression of
  // intent, not a child-of-parent constraint.
  let overlayClaims: CapabilityClaims = agentClaims;
  let dispositionRejections: readonly ProposalRejection[] = [];
  let overlay: DispositionOverlay | null = null;
  if (input.loadDispositionOverlay !== undefined) {
    try {
      overlay = await input.loadDispositionOverlay(
        input.agent.metadata.namespace ?? '',
        input.agent.metadata.name ?? '',
      );
    } catch (e) {
      // Fail-open-on-load-error for availability: treat as no overlay.
      // The schema-validate Job (DISP-01) is the upstream gate; an
      // unparseable overlay should never reach here in steady state.
      // Do NOT throw — that would break revocation semantics (delete
      // the ConfigMap → next mint must succeed). console.warn keeps
      // the failure observable.
      const message = e instanceof Error ? e.message : String(e);
      console.warn(
        `cap-issuer: loadDispositionOverlay threw, falling back to no overlay: ${message}`,
      );
      overlay = null;
    }
    if (overlay !== null) {
      const narrowResult = narrowByDispositionOverlay(agentClaims, overlay);
      overlayClaims = narrowResult.narrowed;
      dispositionRejections = narrowResult.rejections;

      // Emit one disposition.proposal_rejected event per rejection.
      // Publish failures are caught and logged — the JWT mint must not
      // be blocked by audit-stream issues (audit best-effort contract).
      if (input.auditPublisher !== undefined && dispositionRejections.length > 0) {
        const rejectionTaskUid = input.task.metadata.uid ?? '';
        const publisher = input.auditPublisher;
        for (const r of dispositionRejections) {
          try {
            await publisher.publish(
              makeEvent({
                type: 'disposition.proposal_rejected',
                source: 'kagent.knuteson.io/operator',
                subject: `Agent/${r.agentNamespace}/${r.agentName}`,
                data: {
                  agentRef: r.agentRef,
                  agentNamespace: r.agentNamespace,
                  agentName: r.agentName,
                  dispositionConfigMapName: r.dispositionConfigMapName,
                  dispositionConfigMapNamespace: r.dispositionConfigMapNamespace,
                  excludedTool: r.tool,
                  excludedKind: r.kind,
                  mayProposeAgainst: r.mayProposeAgainst,
                  reason: r.reason,
                  taskUid: rejectionTaskUid,
                },
              }),
            );
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.warn(`cap-issuer: disposition.proposal_rejected publish failed: ${message}`);
          }
        }
      }
    }
  }

  const narrowed =
    input.parentBundle === undefined
      ? overlayClaims
      : narrowClaimsByParent(overlayClaims, input.parentBundle.claims);

  if (input.parentBundle !== undefined) {
    const violations = claimsSubsetViolations(narrowed, input.parentBundle.claims);
    if (violations.length > 0) {
      throw new CapabilityViolationError(violations, input.parentBundle.jti);
    }
  }

  // v0.5.0-tenancy — Wave 4 / Tenancy. Stamp `claims.tenant` from the
  // resolved Tenant CR when:
  //   - the Agent didn't already pin one (Agent-pin wins; admission
  //     enforces tenant equality earlier)
  //   - the task carries a resolvable tenant
  const withTenant = applyTenantClaim(narrowed, input.tenant);

  const taskUid = input.task.metadata.uid ?? '';
  if (taskUid.length === 0) {
    throw new Error('mintCapabilityForTask: AgentTask has no metadata.uid');
  }
  const jti = input.jtiOverride ?? defaultJti(taskUid);

  // v0.5.4-keyrotation — apply Wave 4 cap-TTL policy when present;
  // fall back to the v0.3.0 heuristic otherwise.
  const ttlPolicyDecision = applyTtlPolicy(input.task, input.ttlPolicy);
  const ttlSeconds = ttlPolicyDecision.ttlSeconds;

  // Per-tenant issuer override — when the Tenant declares
  // `spec.capabilityRoot.issuer`, that's the JWT `iss`; otherwise
  // the operator's default. The CA's mint accepts an optional
  // `issuerOverride` that we plumb here. CapCa.mint signatures pre-
  // dating Wave 4 don't read `issuerOverride` and ignore it, so this
  // is forward-compatible: a CA that doesn't yet honor the override
  // simply falls back to its default issuer (matches today's behavior).
  const tenantIssuer = input.tenant !== undefined ? resolveTenantIssuer(input.tenant) : undefined;

  const result: MintCapResult = await ca.mint({
    subjectTaskUid: taskUid,
    jti,
    claims: withTenant,
    ...(ttlSeconds !== undefined && { ttlSeconds }),
    ...(tenantIssuer !== undefined && { issuerOverride: tenantIssuer }),
  });

  // Phase 1 / DISP-02 → DISP-03 bridge — when the mint REPRESENTS a
  // proposal-claim that would have proceeded (i.e., the minted JWT
  // carries at least one proposal-category tool AFTER overlay
  // narrowing), increment the disposition ConfigMap's
  // kagent.knuteson.io/proposals-today annotation. workbench-api's
  // projection (plan 03) READS this annotation to compute proposalsToday;
  // the operator is the SOLE writer.
  //
  // Increment runs AFTER the mint completes (post-mint) so the JWT is
  // observable in the substrate even if the patch fails. The helper
  // itself catches and logs patch errors — mint reliability is more
  // important than counter exactness.
  //
  // Skip when:
  //   - no overlay was loaded (loadDispositionOverlay undefined OR overlay null)
  //   - the post-narrowing minted tools has NO proposal-category tool
  //     (i.e., this mint was not for a proposal — counting it would
  //     inflate proposalsToday)
  //   - input.coreApi is undefined (test paths without K8s wiring)
  if (overlay !== null && input.coreApi !== undefined) {
    const mintedTools = withTenant.tools ?? [];
    const hasProposalTool = mintedTools.some((t) => classifyToolAsProposal(t) !== null);
    if (hasProposalTool) {
      // Fire-and-await — the helper does not throw out (it catches+logs).
      await incrementProposalsToday({
        coreApi: input.coreApi,
        overlay,
        now: input.now?.() ?? new Date(),
      });
    }
  }

  return {
    jwt: result.jwt,
    jti: result.jti,
    issuer: tenantIssuer ?? ca.issuer,
    expiresAt: result.expiresAt,
    claims: withTenant,
    ...(ttlPolicyDecision.decision !== undefined && {
      ttlDecision: ttlPolicyDecision.decision,
    }),
    ...(dispositionRejections.length > 0 && { dispositionRejections }),
  };
}

/**
 * Apply the tenant claim per the precedence documented on
 * {@link MintCapForTaskInput.tenant}:
 *
 *   1. Explicit `claims.tenant` from the Agent's declared claims wins
 *      (Agent-author pin). Admission validates equality with the
 *      resolved tenant CR before reaching this path.
 *   2. Tenant default (`tenant.spec.name`) populates `claims.tenant`
 *      when the Agent hasn't pinned one.
 *   3. No tenant resolved → leave `claims.tenant` unset (legacy /
 *      pre-Wave-4 install).
 *
 * Pure helper exported for cap-issuer test coverage.
 */
/**
 * v0.5.4-keyrotation — Wave 4 / KeyRotation sub-team. Apply the Wave 4
 * cap-TTL policy when present; fall back to the legacy
 * `pickTtlSeconds` heuristic when the policy is undefined (pre-Wave-4
 * install or operator booted with KAGENT_KEYROTATION_ENABLED unset).
 *
 * Returns:
 *   - `ttlSeconds` — the value the CA's `mint()` consumes (undefined
 *     means "let the JWT helper apply its own default").
 *   - `decision` — present ONLY when the Wave 4 policy was applied;
 *     carries the resolved tier so the reconciler can emit
 *     `keyrotation.cap_minted_with_ttl` with the policy attribution.
 *
 * Pure helper — exported for cap-issuer test coverage. Both inputs
 * are immutable; output reads through to `CapTtlDecision` from
 * `@kagent/keyrotation-controller`.
 */
export function applyTtlPolicy(
  task: AgentTask,
  policy: CapTtlPolicy | undefined,
): { ttlSeconds: number | undefined; decision: CapTtlDecision | undefined } {
  if (policy === undefined) {
    return { ttlSeconds: pickTtlSeconds(task), decision: undefined };
  }
  const timeoutSeconds = task.spec.runConfig?.timeoutSeconds ?? task.spec.timeoutSeconds;
  const decision = decideCapTtl({
    timeoutSeconds: typeof timeoutSeconds === 'number' ? timeoutSeconds : undefined,
    policy,
  });
  return { ttlSeconds: decision.ttlSeconds, decision };
}

export function applyTenantClaim(
  claims: CapabilityClaims,
  tenant: Tenant | undefined,
): CapabilityClaims {
  if (tenant === undefined) return claims;
  // (1) Agent-author already pinned a tenant — keep as-is.
  if (typeof claims.tenant === 'string' && claims.tenant.length > 0) return claims;
  // (2) Tenant CR's canonical name becomes the substrate-attributable
  // tenant claim. We do NOT honor `metadata.name` overrides on the
  // Tenant CR — CRD admission already enforces `spec.name == metadata.name`.
  const tenantName = tenant.spec.name;
  if (typeof tenantName !== 'string' || tenantName.length === 0) return claims;
  return { ...claims, tenant: tenantName };
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

    if (cat === 'blackboard') {
      // v0.4.1-blackboard — nested-object claim. Intersect each
      // sub-list (read/write) independently using the same pattern
      // as top-level array categories.
      const childBb = child.blackboard;
      if (childBb === undefined) continue;
      const parentBb = parent.blackboard;
      const narrowed: { read?: readonly string[]; write?: readonly string[] } = {};
      for (const sub of ['read', 'write'] as const) {
        const cList = childBb[sub] ?? [];
        if (cList.length === 0) continue;
        const pList = parentBb?.[sub] ?? [];
        const filtered: string[] = [];
        for (const pat of cList) {
          if (patternIsAdmittedByList(pat, pList)) filtered.push(pat);
        }
        if (filtered.length > 0) narrowed[sub] = filtered;
      }
      if (narrowed.read !== undefined || narrowed.write !== undefined) {
        out.blackboard = narrowed;
      }
      continue;
    }

    const childList = child[cat] ?? [];
    if (!Array.isArray(childList)) continue;
    if (childList.length === 0) continue;
    // Narrow widened types back to readonly string[] for both lists.
    // `Array.isArray` widens to `any[]`; we re-typecheck contents
    // before forwarding into pattern-matching to keep the no-unsafe-
    // argument lint clean.
    const childPatterns: readonly string[] = (childList as readonly unknown[]).every(
      (x): x is string => typeof x === 'string',
    )
      ? (childList as readonly string[])
      : [];
    const parentArr = parent[cat];
    const parentPatterns: readonly string[] =
      Array.isArray(parentArr) &&
      (parentArr as readonly unknown[]).every((x): x is string => typeof x === 'string')
        ? (parentArr as readonly string[])
        : [];
    const filtered: string[] = [];
    for (const pat of childPatterns) {
      if (patternIsAdmittedByList(pat, parentPatterns)) filtered.push(pat);
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
    case 'blackboard':
      // v0.4.1-blackboard — nested-object claim handled before this
      // fn; included for exhaustiveness.
      return;
  }
}

/* =====================================================================
 * AgentWorkflow (v0.3.2-workflows) — Wave 2 / Workflows sub-team.
 *
 * Workflows are spawn parents the same way Agents are: their own cap
 * is the upper bound on what their spawned AgentTasks may carry. The
 * minter here is a sibling to `mintCapabilityForTask` but works off
 * an AgentWorkflow CR's `spec.capabilityClaims`.
 *
 * Subject convention: the JWT's `sub` claim is `workflow:<uid>` (vs.
 * tasks' `task-uid:<uid>`). Verifiers downstream switch on the prefix
 * to know whether the bundle came from an Agent loop or a Workflow
 * runtime. Audit lookups distinguish without ambiguity.
 *
 * Parent narrowing: workflows are top-level (no parent task), so the
 * minter accepts an optional `tenantCeiling` claim set the chart-side
 * tenancy guard might apply at admission. v0.3.2 leaves this as a
 * future hook; the typical caller passes `undefined` and the workflow's
 * declared claims land verbatim.
 * ===================================================================== */

export interface MintCapForWorkflowInput {
  readonly workflow: AgentWorkflow;
  /**
   * Optional tenant-level ceiling — the same shape as a parent
   * bundle's claims. When set, the workflow's claims are intersected
   * with this ceiling (defense in depth). When unset, the workflow's
   * declared claims are minted verbatim.
   */
  readonly tenantCeiling?: CapabilityClaims;
  /** Test-injectable jti override. */
  readonly jtiOverride?: string;
  /**
   * v0.5.0-tenancy — Wave 4 / Tenancy sub-team. Resolved Tenant CR for
   * this workflow. Same semantics as `MintCapForTaskInput.tenant`:
   * stamps `claims.tenant` (when not already set by the workflow's
   * declared claims) and routes through the tenant's `capabilityRoot.issuer`
   * when declared.
   */
  readonly tenant?: Tenant;
}

export interface MintCapForWorkflowResult extends MintCapForTaskResult {
  /** Always equals the workflow's UID for forensics correlation. */
  readonly workflowUid: string;
}

/**
 * Resolve effective `CapabilityClaims` from an AgentWorkflow. The
 * workflow CRD has no legacy fields to fall back on (workflows are a
 * new substrate primitive in v0.3.2), so this is a thin lookup.
 */
export function resolveWorkflowClaims(workflow: AgentWorkflow): CapabilityClaims {
  return workflow.spec.capabilityClaims ?? {};
}

/**
 * Mint a capability bundle for the given workflow. Algorithm mirrors
 * `mintCapabilityForTask` but:
 *   - Subject is `workflow:<uid>` (not `task-uid:<uid>`)
 *   - There is no parent task; tenant ceiling is the optional outer
 *     bound (typically supplied by Wave 4 Tenancy)
 *   - JTI prefix is `cap-wf-<8>` so audit grep distinguishes from task
 *     caps (`cap-<8>-<rand>`).
 */
export async function mintCapabilityForWorkflow(
  ca: CapCa,
  input: MintCapForWorkflowInput,
): Promise<MintCapForWorkflowResult> {
  const declared = resolveWorkflowClaims(input.workflow);

  const narrowed =
    input.tenantCeiling === undefined
      ? declared
      : narrowClaimsByParent(declared, input.tenantCeiling);

  if (input.tenantCeiling !== undefined) {
    const violations = claimsSubsetViolations(narrowed, input.tenantCeiling);
    if (violations.length > 0) {
      throw new CapabilityViolationError(violations, '<tenant-ceiling>');
    }
  }

  const workflowUid = input.workflow.metadata.uid ?? '';
  if (workflowUid.length === 0) {
    throw new Error('mintCapabilityForWorkflow: AgentWorkflow has no metadata.uid');
  }

  const jti = input.jtiOverride ?? defaultWorkflowJti(workflowUid);

  // v0.5.0-tenancy — apply tenant claim + per-tenant issuer override
  // (same precedence as mintCapabilityForTask).
  const withTenant = applyTenantClaim(narrowed, input.tenant);
  const tenantIssuer = input.tenant !== undefined ? resolveTenantIssuer(input.tenant) : undefined;

  // Workflows don't carry a per-run timeoutSeconds the way AgentTasks
  // do; the JWT helper's default TTL applies (DEFAULT_CAP_JWT_TTL_SECONDS
  // ~ 600s). The controller re-mints periodically as part of its
  // reconcile loop so the cap stays fresh.
  const result: MintCapResult = await ca.mint({
    subjectTaskUid: `workflow:${workflowUid}`,
    jti,
    claims: withTenant,
    ...(tenantIssuer !== undefined && { issuerOverride: tenantIssuer }),
  });

  return {
    jwt: result.jwt,
    jti: result.jti,
    expiresAt: result.expiresAt,
    claims: withTenant,
    issuer: tenantIssuer ?? ca.issuer,
    workflowUid,
  };
}

function defaultWorkflowJti(workflowUid: string): string {
  // `cap-wf-<8>` — distinguishable from task caps' `cap-<8>-<rand>`.
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  let hex = '';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  const prefix = workflowUid.slice(0, 8);
  return `cap-wf-${prefix}-${hex}`;
}
