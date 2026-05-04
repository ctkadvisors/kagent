/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Whole-bundle subset check — does `child` claim ≤ authority of `parent`?
 *
 * The substrate's composition rule is the central elegance bet: spawn
 * MUST narrow, never escalate. This module implements the narrowing
 * predicate at category granularity:
 *
 *   - For each claim category in `child.claims`:
 *     - Patterns in the child must each be admitted by some pattern
 *       in the parent (`patternListIsSubset`).
 *   - Tenant: child tenant must equal parent tenant (or be absent if
 *     parent has none); the substrate doesn't admit a tenant change
 *     across spawn — Tenant migration is a Wave 4 concern.
 *
 * Returns `null` when child ⊆ parent, or a descriptive string
 * explaining the violation. Mirrors the `bundleTimeError` shape so
 * callers can compose violation strings into a single audit record.
 */

import { patternListIsSubset } from './glob-match.js';
import type { CapabilityClaims } from './types.js';

/**
 * Per-category violation report. A subset check accumulates violations
 * across categories (rather than short-circuiting on the first) so the
 * audit record carries the full picture of the proposed escalation.
 */
export interface SubsetViolation {
  readonly category: string;
  readonly detail: string;
}

/**
 * Test whether `child` claims are a subset of `parent` claims. Returns
 * an empty array on success; otherwise an array of violations.
 *
 * Semantics per category:
 *   - tools/models/spawn/read/write/egress/publish/subscribe:
 *     `patternListIsSubset(child[cat], parent[cat])` — every child
 *     pattern must be admissible by some parent pattern.
 *   - tenant: child must match parent exactly (string equality), or
 *     child must be absent (granting nothing tenant-scoped is always
 *     OK).
 */
export function claimsSubsetViolations(
  child: CapabilityClaims,
  parent: CapabilityClaims,
): readonly SubsetViolation[] {
  const violations: SubsetViolation[] = [];

  const arrayCats = [
    'tools',
    'models',
    'spawn',
    'read',
    'write',
    'egress',
    'publish',
    'subscribe',
  ] as const;

  for (const cat of arrayCats) {
    const c = child[cat];
    const p = parent[cat];
    if (!patternListIsSubset(c, p)) {
      const cList = (c ?? []).join(', ');
      const pList = (p ?? []).join(', ');
      violations.push({
        category: cat,
        detail: `child.${cat}=[${cList}] is not a subset of parent.${cat}=[${pList}]`,
      });
    }
  }

  // tenant — exact match required; child-absent is always OK; parent-
  // absent + child-present is an escalation.
  if (child.tenant !== undefined) {
    if (parent.tenant === undefined) {
      violations.push({
        category: 'tenant',
        detail: `child.tenant="${child.tenant}" requested but parent has no tenant claim`,
      });
    } else if (child.tenant !== parent.tenant) {
      violations.push({
        category: 'tenant',
        detail: `child.tenant="${child.tenant}" does not match parent.tenant="${parent.tenant}"`,
      });
    }
  }

  return violations;
}

/**
 * Convenience predicate — true iff `child ⊆ parent`. Same algorithm as
 * `claimsSubsetViolations` but discards the per-category detail. Use
 * this when you only care about the boolean (e.g. fast-path admission
 * gate); use `claimsSubsetViolations` when you need an audit-friendly
 * violation record.
 */
export function claimsAreSubsetOf(child: CapabilityClaims, parent: CapabilityClaims): boolean {
  return claimsSubsetViolations(child, parent).length === 0;
}

/**
 * Format a violation list into a single string suitable for an audit
 * record `reason` field. Returns an empty string when no violations.
 */
export function formatViolations(violations: readonly SubsetViolation[]): string {
  if (violations.length === 0) return '';
  return violations.map((v) => `[${v.category}] ${v.detail}`).join('; ');
}
