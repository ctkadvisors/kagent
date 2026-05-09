/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * DispositionOverlayRow — Phase 1 / DISP-03 read projection.
 *
 * The workbench-api computes this row per Agent that has an
 * AgentDisposition overlay (sibling ConfigMap labeled
 * `kagent.knuteson.io/agent-disposition=true`). Spec fields mirror
 * the overlay's `data.disposition.yaml`; counter fields are computed
 * projections from existing telemetry (gateway token-usage + operator-
 * written `kagent.knuteson.io/proposals-today` annotation). NO new
 * persistence primitive — D2.
 *
 * The DTO is the single source of truth across the substrate-API-UI
 * tier boundary: workbench-api emits it, workbench-ui consumes it
 * (DISP-04). Adding a field is SemVer-minor; renaming or removing one
 * is SemVer-major.
 */

/**
 * Phase-1 proposal categories aligned with C-governance-tiers
 * (templates, verifiers, capability-policy). Mirrored from
 * `disposition-parser.ts`'s `ProposalKind` so callers don't need to
 * import both.
 */
export type DispositionProposalKind = 'templates' | 'verifiers' | 'capability-policy';

/**
 * Reason flag for the over-budget condition. `'both'` is set when
 * tokens AND proposals exceed their budgets in the same projection
 * read; the projection still emits ONE audit event per reason (so
 * `'both'` corresponds to two audit events, one `tokens_exceeded`
 * and one `proposals_exceeded`).
 */
export type DispositionOverBudgetReason = 'tokens_exceeded' | 'proposals_exceeded' | 'both';

/**
 * One row per Agent with an attached AgentDisposition overlay.
 * Returned by `GET /api/dispositions` as `{ items: DispositionOverlayRow[] }`.
 */
export interface DispositionOverlayRow {
  /** "namespace/name" of the Agent the overlay narrows. */
  readonly agentRef: string;
  /** The Agent's namespace (mirrored from `agentRef`). */
  readonly namespace: string;
  /** The Agent's name (mirrored from `agentRef`). */
  readonly agentName: string;
  /** Name of the sibling ConfigMap that carried the overlay. */
  readonly configMapName: string;

  /** Spec fields parsed from the ConfigMap's `data.disposition.yaml`. */
  readonly idleBehavior: {
    readonly readChannels: readonly string[];
    readonly attentionBudget: {
      readonly tokensPerDay: number;
      readonly pollIntervalSeconds: number;
    };
    readonly proposalScope: {
      readonly mayProposeAgainst: readonly DispositionProposalKind[];
      readonly maxProposalsPerDay: number;
    };
  };

  /**
   * Sum of `inputTokens + outputTokens` across gateway usage rows
   * with this Agent's name and `occurredAt >= dailyBoundaryUtc`.
   */
  readonly spentTokensToday: number;

  /**
   * Always 0 in v0.2. Posts/Channels are Future Research; this field
   * is reserved for forward compatibility and is locked to literal `0`
   * in TypeScript so a regression that wires a non-zero source is
   * caught at type-check time.
   *
   * NOT-IMPLEMENTED-IN-V0.2: when Posts/Channels graduate from Future
   * Research, the literal type widens to `number` and the projection
   * acquires a Posts source.
   */
  readonly postsToday: 0;

  /**
   * Count of proposal-scope rejections for this Agent in the current
   * UTC day window. Read from the disposition ConfigMap's
   * `kagent.knuteson.io/proposals-today` annotation, which is written
   * by the operator's cap-issuer narrowing step (plan 02). The
   * sibling annotation `kagent.knuteson.io/proposals-today-day`
   * records the UTC day window the count belongs to; on mismatch the
   * projection treats this as 0 (rollover semantics).
   */
  readonly proposalsToday: number;

  /**
   * True when `spentTokensToday > tokensPerDay` OR
   * `proposalsToday > maxProposalsPerDay`.
   */
  readonly overBudget: boolean;

  /**
   * Reason flag — `undefined` when `overBudget` is false. `'both'`
   * means tokens AND proposals are over budget; the audit stream
   * carries one event per reason regardless.
   */
  readonly overBudgetReason?: DispositionOverBudgetReason;

  /**
   * Count of distinct over-budget reasons emitted today for this
   * agentRef by the workbench-api process. Derived from the in-process
   * `overBudgetDedup` Set (keys `${agentRef}|${reason}|${dailyBoundaryUtc}`);
   * bounded by `[0, 2]` (one per reason of `tokens_exceeded` /
   * `proposals_exceeded`). Resets on workbench-api restart —
   * acceptable per CONTEXT.md observation-phase semantics.
   *
   * Source for ROADMAP success criterion 4 ("budget remaining AND
   * over-budget event count per agent").
   */
  readonly overBudgetEventCountToday: number;

  /**
   * ISO 8601 timestamp of the start of the current day window
   * (UTC midnight by default; only `'UTC'` is supported in v0.2 with
   * a forward-compatibility hook for IANA names via Helm value
   * `api.disposition.dailyBoundaryTimezone`).
   */
  readonly dailyBoundaryUtc: string;
}

/**
 * Runtime shape check — used by workbench-ui to fail fast if the API
 * payload changes. Throws a descriptive `Error` on mismatch. Does NOT
 * exhaustively validate every nested field; the workbench-api
 * produces the row with full type-coverage so this guard's job is to
 * detect schema drift across the substrate-API-UI boundary, not to
 * re-implement V5 input validation.
 */
export function assertIsDispositionOverlayRow(
  value: unknown,
): asserts value is DispositionOverlayRow {
  if (typeof value !== 'object' || value === null) {
    throw new Error('DispositionOverlayRow: not an object');
  }
  const r = value as Record<string, unknown>;
  if (typeof r['agentRef'] !== 'string') {
    throw new Error('DispositionOverlayRow: agentRef missing');
  }
  if (typeof r['namespace'] !== 'string') {
    throw new Error('DispositionOverlayRow: namespace missing');
  }
  if (typeof r['agentName'] !== 'string') {
    throw new Error('DispositionOverlayRow: agentName missing');
  }
  if (typeof r['configMapName'] !== 'string') {
    throw new Error('DispositionOverlayRow: configMapName missing');
  }
  if (typeof r['spentTokensToday'] !== 'number') {
    throw new Error('DispositionOverlayRow: spentTokensToday missing');
  }
  if (r['postsToday'] !== 0) {
    throw new Error('DispositionOverlayRow: postsToday must be 0 in v0.2');
  }
  if (typeof r['proposalsToday'] !== 'number') {
    throw new Error('DispositionOverlayRow: proposalsToday missing');
  }
  if (typeof r['overBudget'] !== 'boolean') {
    throw new Error('DispositionOverlayRow: overBudget missing');
  }
  if (typeof r['overBudgetEventCountToday'] !== 'number') {
    throw new Error('DispositionOverlayRow: overBudgetEventCountToday missing');
  }
  if (typeof r['dailyBoundaryUtc'] !== 'string') {
    throw new Error('DispositionOverlayRow: dailyBoundaryUtc missing');
  }
  if (typeof r['idleBehavior'] !== 'object' || r['idleBehavior'] === null) {
    throw new Error('DispositionOverlayRow: idleBehavior missing');
  }
  // Nested sub-object validation is intentionally LIGHT here — see
  // module JSDoc. The workbench-api owns the full type-correct
  // construction; this guard is a UI-side defense against schema drift.
  if (r['overBudgetReason'] !== undefined) {
    const reason = r['overBudgetReason'];
    if (reason !== 'tokens_exceeded' && reason !== 'proposals_exceeded' && reason !== 'both') {
      // `reason` may be any non-string here; render it through
      // JSON.stringify so a non-stringifiable value (object) does NOT
      // surface as "[object Object]" in the diagnostic.
      const rendered = typeof reason === 'string' ? reason : JSON.stringify(reason);
      throw new Error(`DispositionOverlayRow: overBudgetReason '${rendered}' is not a known value`);
    }
  }
}
