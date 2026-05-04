/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Capability-gate predicates for the four built-in blackboard tools.
 *
 * Each tool consults `CapabilityClaims.blackboard.{read|write}` glob
 * lists via the substrate's standard `globMatchAny` matcher. Tool
 * wrappers throw `policy_denied:` when the predicate fails — same
 * shape as `assertUrlIsSafe` in builtin-tools.ts so the audit / trace
 * record is consistent across all tool families.
 *
 * Semantics (per docs/SUBSTRATE-V1.md §3.6 + WAVES.md §5.2 #2):
 *   - `read_blackboard(key)` → `read` glob admits the key.
 *   - `write_blackboard(key, value)` → `write` glob admits the key.
 *   - `list_blackboard(prefix?)` → `read` glob has at least one entry
 *     (listing IS a read; we don't try to verify the matched-keys
 *     subset against the read patterns — too expensive and not
 *     load-bearing for the substrate's authority story; the actual
 *     read calls re-gate).
 *   - `append_blackboard(key, value)` → BOTH `read` AND `write`
 *     admit the key (CAS-loop reads + puts).
 *
 * Empty / unset claims = no access. The substrate is fail-closed.
 */

import { globMatchAny, type CapabilityClaims } from '@kagent/capability-types';

/**
 * Subset of `CapabilityClaims` we read here. Carved out so this file
 * stays usable from the agent-pod even when the optional capability
 * bundle is absent (in which case all four predicates return false
 * → all tools throw policy_denied — consistent with the bundle-absent
 * fail-closed posture).
 */
export type BlackboardClaim = NonNullable<CapabilityClaims['blackboard']>;

/**
 * Policy denial classes the wrappers throw. Caller composes a
 * `policy_denied: <reason>` Error message.
 */
export type BlackboardDenyReason =
  | 'no_blackboard_claim'
  | 'read_not_admitted'
  | 'write_not_admitted'
  | 'list_not_admitted';

/**
 * Read predicate. `claim` may be undefined (no blackboard claim → no
 * access). Returns `null` when admitted, or the deny-reason otherwise.
 */
export function checkReadAllowed(
  claim: BlackboardClaim | undefined,
  key: string,
): BlackboardDenyReason | null {
  if (claim === undefined) return 'no_blackboard_claim';
  if (!globMatchAny(claim.read, key)) return 'read_not_admitted';
  return null;
}

/**
 * Write predicate. Same shape as `checkReadAllowed` against
 * `claim.write`.
 */
export function checkWriteAllowed(
  claim: BlackboardClaim | undefined,
  key: string,
): BlackboardDenyReason | null {
  if (claim === undefined) return 'no_blackboard_claim';
  if (!globMatchAny(claim.write, key)) return 'write_not_admitted';
  return null;
}

/**
 * Listing predicate. Listing is a read; we just verify the bundle
 * has any read claim at all. Per-key gates re-fire on subsequent
 * `read_blackboard` calls anyway, so a permissive list here just
 * surfaces the keys; reading them is still cap-gated.
 */
export function checkListAllowed(claim: BlackboardClaim | undefined): BlackboardDenyReason | null {
  if (claim === undefined) return 'no_blackboard_claim';
  if (claim.read === undefined || claim.read.length === 0) return 'list_not_admitted';
  return null;
}

/**
 * Append predicate — requires BOTH read + write admission for the
 * specific key. Returns the first denial reason hit (read first,
 * then write) or null when both pass.
 */
export function checkAppendAllowed(
  claim: BlackboardClaim | undefined,
  key: string,
): BlackboardDenyReason | null {
  const r = checkReadAllowed(claim, key);
  if (r !== null) return r;
  return checkWriteAllowed(claim, key);
}

/**
 * Map a deny reason to the human-readable string the tool wrapper
 * embeds in `policy_denied: <message>`. Kept stable for trace-log
 * pattern-matching.
 */
export function denyReasonToMessage(reason: BlackboardDenyReason): string {
  switch (reason) {
    case 'no_blackboard_claim':
      return 'no blackboard capability claim — tool unavailable';
    case 'read_not_admitted':
      return 'key not in blackboard.read claim';
    case 'write_not_admitted':
      return 'key not in blackboard.write claim';
    case 'list_not_admitted':
      return 'no blackboard.read patterns — list refused';
  }
}
