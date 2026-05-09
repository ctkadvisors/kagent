/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * narrowByDispositionOverlay — Phase 1 / DISP-02. The AgentDisposition
 * overlay's `proposalScope.mayProposeAgainst` narrows the existing
 * capability-JWT scope at proposal-issuance time. NEVER widens.
 *
 * Self-proposal terminology only (D6): the overlay states which
 * proposal kinds the agent MAY propose against; tools mapped to
 * proposal kinds NOT in `mayProposeAgainst` are removed from
 * `claims.tools`. Agents propose; substrate or human governance
 * disposes — the overlay narrows what an Agent's JWT may propose
 * against; it never widens. The existing `claimsSubsetViolations`
 * defense-in-depth check after parent-narrowing is unaffected —
 * narrowing produces a subset of the input claims, so subset
 * invariants are preserved.
 *
 * Pure function. Caller (cap-issuer.ts) is responsible for emitting
 * `disposition.proposal_rejected` audit events from the returned
 * `rejections` list.
 */

import type { CapabilityClaims } from '@kagent/capability-types';

import type { DispositionOverlay } from './overlay-loader.js';
import { classifyToolAsProposal, type ProposalKind } from './proposal-tool-map.js';

/**
 * One per tool excluded by the overlay's `mayProposeAgainst` allow-list.
 * The cap-issuer emits one `disposition.proposal_rejected` audit event
 * per rejection; the helper itself is pure and does no I/O.
 */
export interface ProposalRejection {
  readonly tool: string;
  readonly kind: ProposalKind;
  readonly agentRef: string;
  readonly agentNamespace: string;
  readonly agentName: string;
  readonly dispositionConfigMapName: string;
  readonly dispositionConfigMapNamespace: string;
  readonly mayProposeAgainst: readonly ProposalKind[];
  readonly reason: 'not_in_mayProposeAgainst';
}

/** Result of one narrowing pass — the narrowed claims plus rejection log. */
export interface NarrowResult {
  readonly narrowed: CapabilityClaims;
  readonly rejections: readonly ProposalRejection[];
}

/**
 * Narrow `claims.tools` against `overlay.idleBehavior.proposalScope.mayProposeAgainst`.
 *
 * Algorithm:
 *   1. If `overlay === null` or `claims.tools === undefined`, pass through
 *      unchanged with no rejections (revocation path / no-op-by-default).
 *   2. Otherwise iterate `claims.tools`:
 *        - tools with `classifyToolAsProposal(t) === null` (non-proposal) → kept verbatim
 *        - tools whose proposal kind IS in `mayProposeAgainst` → kept verbatim
 *        - tools whose proposal kind is NOT in `mayProposeAgainst` → rejected (omitted)
 *   3. Return a fresh claims object with `tools` replaced by the kept list;
 *      every other claim category passes through unchanged.
 *
 * Monotonicity invariant: the returned `narrowed.tools` is always a subset
 * of the input `claims.tools`. The function never adds tools, never
 * widens any category, never mutates the input.
 */
export function narrowByDispositionOverlay(
  claims: CapabilityClaims,
  overlay: DispositionOverlay | null,
): NarrowResult {
  if (overlay === null) {
    return { narrowed: claims, rejections: Object.freeze<ProposalRejection[]>([]) };
  }
  if (claims.tools === undefined) {
    return { narrowed: claims, rejections: Object.freeze<ProposalRejection[]>([]) };
  }

  const allow = new Set<ProposalKind>(overlay.idleBehavior.proposalScope.mayProposeAgainst);
  const keptTools: string[] = [];
  const rejections: ProposalRejection[] = [];

  for (const tool of claims.tools) {
    const kind = classifyToolAsProposal(tool);
    if (kind === null) {
      // Non-proposal tools are untouched by overlay narrowing.
      keptTools.push(tool);
      continue;
    }
    if (allow.has(kind)) {
      // Proposal-category tool whose kind is admitted — keep it.
      keptTools.push(tool);
      continue;
    }
    // Proposal-category tool whose kind is NOT in mayProposeAgainst →
    // remove from the minted tools claim, record one rejection.
    rejections.push({
      tool,
      kind,
      agentRef: overlay.agentRef,
      agentNamespace: overlay.agentNamespace,
      agentName: overlay.agentName,
      dispositionConfigMapName: overlay.configMapName,
      dispositionConfigMapNamespace: overlay.configMapNamespace,
      mayProposeAgainst: overlay.idleBehavior.proposalScope.mayProposeAgainst,
      reason: 'not_in_mayProposeAgainst',
    });
  }

  // Spread + replace `tools` so other claim categories
  // (read/write/spawn/models/egress/tenant/...) flow through verbatim.
  const narrowed: CapabilityClaims = { ...claims, tools: Object.freeze(keptTools) };
  return { narrowed, rejections: Object.freeze(rejections) };
}
