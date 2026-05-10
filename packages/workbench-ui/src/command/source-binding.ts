/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * source-binding — Phase 1 / DISP-04 implementation of the
 * COMMAND-CENTER-CONTRACT.md §2 Prime Directive scoped to the
 * disposition slice, generalized in Phase 2 / CC-01 to all of the
 * Command Center. Every rendered field MUST derive from a substrate
 * source. The TypeScript type system is the primary defense (the four
 * DTOs `DispositionOverlayRow`, `AgentSummaryRow`, `TaskSummary`,
 * `GatewayCapacityRow` are closed shapes); this module adds a
 * development-only runtime guard that throws when a rendered field
 * name is NOT present on the DTO instance — useful during
 * synthesized-fixture test runs and as a debugging aid in dev builds.
 *
 * In production builds (import.meta.env.PROD === true OR
 * process.env.NODE_ENV === 'production'), the assertions are no-ops
 * for performance.
 *
 * Phase 2 / CC-01 generalization (RESEARCH.md Finding 14, Option A):
 *   - The runtime helpers are generic over the DTO type; narrowing is
 *     enforced at the call site by the closed-enum K (one of
 *     DispositionFieldName, AgentSummaryFieldName, TaskSummaryFieldName,
 *     GatewayCapacityFieldName, PressureFieldName).
 *   - A new top-level field on any DTO requires extending the matching
 *     closed-enum union — that's the design.
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

/**
 * Closed enumeration of DispositionOverlayRow top-level field names.
 * The TypeScript type system narrows callers to one of these at the
 * source-bind call site. Adding a new top-level field requires
 * updating this list — that's the design.
 *
 * Exported in Phase 2 so cc-orphan.test.ts (CC-01) can import it
 * alongside the four new closed-enum types.
 */
export type DispositionFieldName =
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

/** Closed enumeration of AgentSummaryRow top-level field names. */
export type AgentSummaryFieldName =
  | 'name'
  | 'namespace'
  | 'model'
  | 'modelClass'
  | 'tools'
  | 'capabilities';

/** Closed enumeration of TaskSummary top-level field names. */
export type TaskSummaryFieldName =
  | 'name'
  | 'namespace'
  | 'uid'
  | 'phase'
  | 'targetAgent'
  | 'targetCapability'
  | 'model'
  | 'createdAt'
  | 'startedAt'
  | 'completedAt'
  | 'podName'
  | 'error'
  | 'suspicious'
  | 'artifactCount'
  | 'childCount'
  | 'aggregatePhase';

/** Closed enumeration of GatewayCapacityRow top-level field names. */
export type GatewayCapacityFieldName =
  | 'model'
  | 'endpoint'
  | 'backendKind'
  | 'inFlight'
  | 'currentCap'
  | 'seed'
  | 'max'
  | 'minSafe'
  | 'recentP50Ms'
  | 'crName'
  | 'crNamespace';

/**
 * Re-exported from pressure.ts so PRESSURE_TYPES stays the single
 * source of truth for the pressure kind union (per CONTEXT.md
 * D-CC-04-A). Wave 1 populates PRESSURE_TYPES with all 9 entries; the
 * union resolves automatically.
 */
export type { PressureFieldName } from './pressure.js';

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
 *
 * The `process` reference is read through `globalThis` so the workbench-
 * ui's tsconfig.build.json (vite/client types only, no `node`) doesn't
 * need to take a `@types/node` dep. At runtime in a Node/vitest context
 * `process` is present on `globalThis`; in a browser bundle it's
 * undefined and the falsy guards skip the check.
 */
function isDevBuild(): boolean {
  // (1) Explicit NODE_ENV=production — the standard prod marker
  // across the Node/test ecosystem. Win first so vitest's
  // `vi.stubEnv` test path is honored.
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const nodeEnv = proc?.env?.NODE_ENV;
  if (nodeEnv === 'production') {
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
  if (nodeEnv !== undefined) {
    return nodeEnv !== 'production';
  }
  // (5) Default safe-mode: dev.
  return true;
}

/**
 * Throws in dev builds if `field` is not a present key on the DTO
 * instance. No-op in prod.
 *
 * Phase 2 / CC-01: generic over the DTO type T. K is a closed-enum
 * field-name union (DispositionFieldName / AgentSummaryFieldName /
 * TaskSummaryFieldName / GatewayCapacityFieldName / PressureFieldName)
 * — TypeScript narrows callers at the source-bind call site.
 *
 * Usage:
 *   assertSourceField(row, 'overBudget');
 *   <div data-source-field={useSourceField('overBudget')}>...</div>
 *
 * COMMAND-CENTER-CONTRACT.md §2 Prime Directive: every visible field
 * MUST derive from a substrate source.
 */
export function assertSourceField<T extends object, K extends string>(row: T, field: K): void {
  if (!isDevBuild()) return;
  if (!(field in row)) {
    const ref = (row as { agentRef?: string }).agentRef;
    throw new Error(
      `source-binding violation: rendered field '${String(field)}' has no backing source` +
        (ref !== undefined ? ` (agentRef=${ref})` : '') +
        `. See COMMAND-CENTER-CONTRACT.md §2 Prime Directive.`,
    );
  }
}

/**
 * Returns the field name string. Use as
 * `data-source-field={useSourceField('spentTokensToday')}` so the
 * source binding is visible in the DOM (debugging + future CC-01
 * scrapers can read these attributes).
 *
 * This is a passthrough — no runtime check. The check is the
 * companion `assertSourceField` call which the component should
 * invoke once per row before rendering.
 */
export function useSourceField<K extends string>(field: K): K {
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
 * Phase 2 / CC-01: generic over the DTO type T. K is a closed-enum
 * field-name union; the body remains identical to Phase 1's so
 * existing assertion semantics are preserved.
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
export function assertSourceFields<T extends object, K extends string>(
  row: T,
  fields: readonly K[],
): void {
  if (!isDevBuild()) return;
  for (const field of fields) {
    if (!(field in row)) {
      const ref = (row as { agentRef?: string }).agentRef;
      throw new Error(
        `source-binding violation: rendered field '${String(field)}' has no backing source` +
          (ref !== undefined ? ` (agentRef=${ref})` : '') +
          ` [computed value listed sourceFields=${fields.join(',')}]. ` +
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
export function useSourceFields<K extends string>(fields: readonly K[]): string {
  return fields.join(',');
}

/**
 * CC-01 (Phase 2) — canvas-side orphan assertion.
 *
 * The CommandView.tsx agentNodes useMemo iterates `snapshot.tasks`
 * and may build a synthetic AgentNode from a task's `targetAgent`
 * when no matching `snapshot.agents` row exists. In dev that's a
 * source-binding violation (per COMMAND-CENTER-CONTRACT.md §2 Prime
 * Directive — every world object must derive from a substrate
 * source). This helper throws to surface the violation. In prod
 * (NODE_ENV=production) it is a no-op so the caller's existing
 * fallback continues to render gracefully during transient SSE
 * reconnect windows (per RESEARCH.md Pitfall 1).
 *
 * Usage at the call site in agentNodes useMemo (CommandView.tsx):
 *   assertCanvasOrphan(snapshot, t.namespace, t.name, key);
 *   if (!map.has(key)) { ... synthetic fallback ... }
 */
export function assertCanvasOrphan(
  snapshot: { readonly agents: ReadonlyMap<string, unknown> },
  taskNamespace: string,
  taskName: string,
  agentKey: string,
): void {
  if (!isDevBuild()) return;
  if (snapshot.agents.has(agentKey)) return;
  throw new Error(
    `CC-01 source-binding violation: task '${taskNamespace}/${taskName}' references ` +
      `agent key '${agentKey}' not in snapshot.agents. ` +
      `See COMMAND-CENTER-CONTRACT.md §2 Prime Directive. ` +
      `(If this fires during SSE reconnect, check stream connectivity.)`,
  );
}
