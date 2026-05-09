/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-02 prereq — PROPOSAL_TOOL_MAP.
 *
 * Maps each `ProposalKind` (templates / verifiers / capability-policy)
 * to the tool-name strings on a capability-JWT that constitute
 * "proposing against" that kind. The plan-02 cap-issuer narrowing
 * step uses this map to decide which `tools` claim entries to remove
 * when an Agent's disposition overlay omits the corresponding kind
 * from `mayProposeAgainst`.
 *
 * Self-proposal terminology only (D6, locked 2026-05-09 PM):
 * agents may PROPOSE new capability/templates/verifiers/policies; the
 * substrate or human governance disposes. The overlay narrows
 * which kinds an Agent's JWT may even attempt to propose against; it
 * never widens. Agents never self-escalate authority anywhere in
 * this code path.
 *
 * !!! WARNING — v0.1 OBSERVATION-PHASE MAPPING ONLY !!!
 *
 *   1. The `proposalsToday` counter (see plan-02 / plan-03) increments
 *      on capability MINTS whose minted JWT survives narrowing AND
 *      carries a proposal-category tool — NOT on actual proposal writes
 *      inside the agent pod. One mint can correspond to zero, one, or
 *      many proposal actions; the counter measures cap-mint events with
 *      surviving proposal-category tools. The DTO field
 *      `DispositionOverlayRow.proposalsToday` and the annotation
 *      `kagent.knuteson.io/proposals-today` carry the same semantics —
 *      both are "today's mint count for caps carrying a surviving
 *      proposal-category tool" rather than "today's proposal issuances."
 *      UI labels SHOULD say "today's proposal-cap mints" or similar
 *      where space permits; "Proposals" / "remaining" is acceptable
 *      shorthand inside the disposition card.
 *
 *   2. The v0.1 minimal mapping below is over-broad. `write_artifact` is
 *      the agent's PRIMARY WORK OUTPUT in v0.1 (not a proposal-only
 *      tool). Operators MUST NOT deploy restrictive `mayProposeAgainst:
 *      []` in production with this mapping — that would block all
 *      artifact writes and stall the agent. Narrowing to
 *      `mayProposeAgainst: ['templates']` ALSO permits write_artifact
 *      while excluding `verifier_register` and `capability_policy_propose`,
 *      which is correct narrowing for a templates-only agent. The seed
 *      overlay in `tests/fixtures/disposition/overlay-valid.yaml` uses
 *      `mayProposeAgainst: [templates, verifiers]` (non-empty) on
 *      purpose. v0.3+ introduces proposal-specific tool names
 *      (`propose_template`, `propose_verifier`,
 *      `propose_capability_policy`) in the agent-pod runtime; until
 *      then, narrowing is BEST USED for observation rather than
 *      enforcement.
 *
 * Both gaps are tracked in the post-phase observation evidence
 * packet (see 01-01-SUMMARY.md output template).
 */

import type { ProposalKind } from '@kagent/dto';
import { PROPOSAL_KINDS } from '@kagent/dto';

export type { ProposalKind };
export { PROPOSAL_KINDS };

/**
 * v0.1 minimal mapping. Each entry is a tool-name STRING (not a glob)
 * for v0.1 simplicity. Future kinds and tool-name patterns are
 * post-Phase-1 evidence-driven extensions — do NOT extend without an
 * empirical-signal evidence packet (see PROJECT.md Future Research
 * status flow).
 */
export const PROPOSAL_TOOL_MAP: Readonly<Record<ProposalKind, readonly string[]>> = Object.freeze({
  templates: Object.freeze(['write_artifact']),
  verifiers: Object.freeze(['verifier_register']),
  'capability-policy': Object.freeze(['capability_policy_propose']),
});

/**
 * Returns the `ProposalKind` a tool name represents, or `null` if
 * the tool is not a proposal tool. Self-proposal terminology only.
 */
export function classifyToolAsProposal(tool: string): ProposalKind | null {
  for (const kind of PROPOSAL_KINDS) {
    if (PROPOSAL_TOOL_MAP[kind].includes(tool)) return kind;
  }
  return null;
}
