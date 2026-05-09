/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * source-binding — Phase 1 / DISP-04 implementation of the
 * COMMAND-CENTER-CONTRACT.md §2 Prime Directive scoped to the
 * disposition slice. Every rendered field MUST derive from a
 * substrate source. The TypeScript type system is the primary
 * defense (`DispositionOverlayRow` is a closed shape from
 * `@kagent/dto`); this module adds a development-only runtime guard
 * that throws when a rendered field name is NOT present on the DTO
 * instance — useful during synthesized-fixture test runs and as a
 * debugging aid in dev builds.
 *
 * In production builds (import.meta.env.PROD === true OR
 * process.env.NODE_ENV === 'production'), the assertions are no-ops
 * for performance.
 *
 * CC-01 (Phase 2 scope) generalizes this pattern to all of Command
 * Center; Phase 1 implements the disposition-specific slice. See
 * docs/COMMAND-CENTER-CONTRACT.md for the binding contract.
 *
 * Single vs multi-field variant (Codex HIGH #5 mitigation):
 *   - `assertSourceField` / `useSourceField` — a single DTO field
 *     directly maps to a rendered value (e.g., `overBudget` →
 *     "over budget" boolean badge).
 *   - `assertSourceFields` / `useSourceFields` — a COMPUTED rendered
 *     value derives from MULTIPLE DTO fields (e.g., "tokens remaining"
 *     = `idleBehavior.attentionBudget.tokensPerDay − spentTokensToday`
 *     uses BOTH inputs). The multi-field helper proves backing for
 *     every input, not just one.
 */

import type { DispositionOverlayRow } from '@kagent/dto';

/**
 * Closed enumeration of DispositionOverlayRow top-level field names.
 * The TypeScript type system narrows callers to one of these at the
 * source-bind call site. Adding a new top-level field requires
 * updating this list — that's the design.
 */
type DispositionFieldName =
  | 'agentRef'
  | 'namespace'
  | 'agentName'
  | 'configMapName'
  | 'idleBehavior'
  | 'spentTokensToday'
  | 'postsToday'
  | 'proposalsToday'
  | 'overBudget'
  | 'overBudgetReason'
  | 'overBudgetEventCountToday'
  | 'dailyBoundaryUtc';

/**
 * Detect dev-build context. Priority order:
 *   1. `process.env.NODE_ENV === 'production'` → prod (no-op assertions).
 *      This is the SDK / vitest / jest standard and is the explicit
 *      override path tests use via `vi.stubEnv('NODE_ENV', 'production')`.
 *   2. Vite's `import.meta.env.PROD` flag → prod.
 *   3. Vite's `import.meta.env.DEV` flag → dev.
 *   4. `process.env.NODE_ENV !== 'production'` → dev.
 *   5. Default: dev (so unhandled environments still get the assertion's
 *      value during testing).
 */
function isDevBuild(): boolean {
  // (1) Explicit NODE_ENV=production — the standard prod marker
  // across the Node/test ecosystem. Win first so vitest's
  // `vi.stubEnv` test path is honored.
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') {
    return false;
  }
  // (2)/(3) Vite-bundled flags.
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean; PROD?: boolean } }).env;
    if (env?.PROD === true) return false;
    if (env?.DEV === true) return true;
  } catch {
    // import.meta not available — fall through.
  }
  // (4) Other NODE_ENV values (development, test, etc).
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== undefined) {
    return process.env.NODE_ENV !== 'production';
  }
  // (5) Default safe-mode: dev.
  return true;
}

/**
 * Throws in dev builds if `field` is not a present key on the
 * `DispositionOverlayRow` instance. No-op in prod.
 *
 * Usage:
 *   assertSourceField(row, 'overBudget');
 *   <div data-source-field={useSourceField('overBudget')}>...</div>
 *
 * COMMAND-CENTER-CONTRACT.md §2 Prime Directive: every visible field
 * MUST derive from a substrate source.
 */
export function assertSourceField(row: DispositionOverlayRow, field: DispositionFieldName): void {
  if (!isDevBuild()) return;
  if (!(field in row)) {
    throw new Error(
      `disposition source-binding violation: rendered field '${String(field)}' has no backing source on DispositionOverlayRow ` +
        `(agentRef=${row.agentRef ?? '?'}). See COMMAND-CENTER-CONTRACT.md §2 Prime Directive.`,
    );
  }
}

/**
 * Returns the field name string. Use as
 * `data-source-field={useSourceField('spentTokensToday')}` so the
 * source binding is visible in the DOM (debugging + future CC-01
 * generalization can scrape these attributes).
 *
 * This is a passthrough — no runtime check. The check is the
 * companion `assertSourceField` call which the component should
 * invoke once per row before rendering.
 */
export function useSourceField(field: DispositionFieldName): DispositionFieldName {
  return field;
}

/**
 * Multi-field variant for COMPUTED rendered values. Phase 1 / Codex
 * HIGH #5 mitigation: a rendered value like "tokens remaining" derives
 * from BOTH `spentTokensToday` AND `idleBehavior.attentionBudget.tokensPerDay`
 * — a single sourceField does not fully prove backing for every
 * visible value. Throws in dev builds when ANY of the listed sourceFields
 * is not present on the DTO instance; no-op in prod.
 *
 * Usage:
 *   assertSourceFields(row, ['spentTokensToday', 'idleBehavior']);
 *   <div data-source-fields={useSourceFields(['spentTokensToday', 'idleBehavior'])}>
 *     {tokensRemaining} remaining
 *   </div>
 *
 * Single-source fields (e.g., `overBudget`) MAY keep the singular
 * `assertSourceField` helper.
 */
export function assertSourceFields(
  row: DispositionOverlayRow,
  fields: readonly DispositionFieldName[],
): void {
  if (!isDevBuild()) return;
  for (const field of fields) {
    if (!(field in row)) {
      throw new Error(
        `disposition source-binding violation: rendered field '${String(field)}' has no backing source on DispositionOverlayRow ` +
          `(agentRef=${row.agentRef ?? '?'}) [computed value listed sourceFields=${fields.join(',')}]. ` +
          `See COMMAND-CENTER-CONTRACT.md §2 Prime Directive.`,
      );
    }
  }
}

/**
 * Multi-field DOM attribute helper. Returns a comma-joined string
 * suitable for
 * `data-source-fields={useSourceFields(['spentTokensToday', 'idleBehavior'])}`.
 * The comma-separated form is what future CC-01 scrapers parse.
 */
export function useSourceFields(fields: readonly DispositionFieldName[]): string {
  return fields.join(',');
}
