/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * DispositionOverlay — Phase 1 / DISP-04. Sibling overlay rendering
 * per-Agent disposition state alongside Mission and Replay overlays
 * in the Command Center. All state derives from
 * `useCommandSnapshot().dispositions` (no client-side state). Reload-
 * stable by construction.
 *
 * D7 / Prime Directive (COMMAND-CENTER-CONTRACT.md §2): every rendered
 * field carries an explicit source-field name; assertSourceField (or
 * assertSourceFields for computed values per Codex HIGH #5) fires in
 * dev builds when a rendered field has no backing on the DTO instance.
 *
 * NOTE on `postsToday`: reserved for forward compatibility; always
 * suppressed (NOT surfaced in the UI) in v0.2 because Posts/Channels
 * are Future Research per REQUIREMENTS.md §4. The DTO locks the value
 * to literal `0` so a regression that wires a non-zero source surfaces
 * at type-check time; this overlay simply does not render it.
 *
 * Slice E (pressure systems) compliance:
 *   - Each over-budget marker carries a `data-source-fields` attribute
 *     listing every input the value was computed from.
 *   - Each marker has a detail link target (existing TaskDetail /
 *     GatewayPage routes — no new routes added).
 *   - `pressureDramatization=false` (base-building-only mode) keeps
 *     the same data but swaps the dramatic CSS class for a subdued
 *     class so the numeric over-budget delta is still legible.
 */

import { type FC } from 'react';
import type { DispositionOverlayRow } from '@kagent/dto';

import {
  assertSourceField,
  assertSourceFields,
  useSourceField,
  useSourceFields,
} from './source-binding.js';
import styles from './DispositionOverlay.module.css';

export interface DispositionOverlayProps {
  /**
   * Snapshot slice — the full `useCommandSnapshot()` return is fine
   * (the type structurally satisfies this) or the caller can pass a
   * minimal `{ dispositions }` object for testability.
   */
  readonly snapshot: { readonly dispositions: ReadonlyMap<string, DispositionOverlayRow> };
  /**
   * Slice E base-building-only fallback. When false, the same data
   * still renders but the dramatic CSS class is replaced with a
   * subdued one. Default true.
   */
  readonly pressureDramatization?: boolean;
}

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export const DispositionOverlay: FC<DispositionOverlayProps> = ({
  snapshot,
  pressureDramatization = true,
}) => {
  const rows = Array.from(snapshot.dispositions.values());
  if (rows.length === 0) return null;

  return (
    <aside className={styles.card} aria-label="Agent dispositions">
      <header className={styles.header}>Agent dispositions</header>
      <ul className={styles.list}>
        {rows.map((row) => {
          // Per Codex HIGH #5, computed values (e.g., "tokens remaining"
          // = tokensPerDay − spentTokensToday) MUST list ALL inputs via
          // the multi-field helper. Single-source fields (overBudget,
          // overBudgetEventCountToday) keep the singular helper.
          assertSourceFields(row, ['spentTokensToday', 'idleBehavior']);
          assertSourceFields(row, ['proposalsToday', 'idleBehavior']);
          assertSourceField(row, 'overBudget');
          if (row.overBudget) {
            assertSourceField(row, 'overBudgetEventCountToday');
          }

          const tokensPerDay = row.idleBehavior.attentionBudget.tokensPerDay;
          const maxProposalsPerDay = row.idleBehavior.proposalScope.maxProposalsPerDay;
          const tokensRemaining = tokensPerDay - row.spentTokensToday;
          const proposalsRemaining = maxProposalsPerDay - row.proposalsToday;
          const tokensExceeded =
            row.overBudget &&
            (row.overBudgetReason === 'tokens_exceeded' || row.overBudgetReason === 'both');
          const proposalsExceeded =
            row.overBudget &&
            (row.overBudgetReason === 'proposals_exceeded' || row.overBudgetReason === 'both');
          // Detail link target: existing per-Agent route. No new routes
          // added per Slice E acceptance.
          const agentDetailHref = `/agents/${row.namespace}/${row.agentName}`;

          return (
            <li key={row.agentRef} className={styles.row} data-agent-ref={row.agentRef}>
              <div className={styles.agent}>
                {row.agentName}{' '}
                <span className={styles.namespace}>({row.namespace})</span>
              </div>

              <div
                className={styles.metric}
                data-source-fields={useSourceFields(['spentTokensToday', 'idleBehavior'])}
              >
                <span className={styles.metricLabel}>Tokens</span>{' '}
                <span
                  className={
                    tokensExceeded && pressureDramatization
                      ? styles.pressureDramatic
                      : styles.metricValue
                  }
                >
                  {tokensExceeded
                    ? `+${fmtNumber(row.spentTokensToday - tokensPerDay)} over budget`
                    : `${fmtNumber(tokensRemaining)} remaining`}
                </span>
              </div>

              <div
                className={styles.metric}
                data-source-fields={useSourceFields(['proposalsToday', 'idleBehavior'])}
              >
                <span className={styles.metricLabel}>Proposals</span>{' '}
                <span
                  className={
                    proposalsExceeded && pressureDramatization
                      ? styles.pressureDramatic
                      : styles.metricValue
                  }
                >
                  {proposalsExceeded
                    ? `+${fmtNumber(row.proposalsToday - maxProposalsPerDay)} over budget`
                    : `${fmtNumber(proposalsRemaining)} remaining`}
                </span>
              </div>

              {/* Codex HIGH #4 / ROADMAP success criterion 4 — over-budget
                  event count today, rendered ONLY when the row is in
                  the over-budget state (the count is meaningless when
                  no event has fired yet today). */}
              {row.overBudget && (
                <div
                  className={styles.eventCount}
                  data-source-field={useSourceField('overBudgetEventCountToday')}
                >
                  {row.overBudgetEventCountToday === 1
                    ? '1 event today'
                    : `${fmtNumber(row.overBudgetEventCountToday)} events today`}
                </div>
              )}

              {tokensExceeded && (
                <a
                  className={
                    pressureDramatization
                      ? styles.pressureMarker
                      : styles.pressureMarkerSubdued
                  }
                  data-source-fields={useSourceFields(['spentTokensToday', 'idleBehavior'])}
                  href={agentDetailHref}
                >
                  Tokens over budget — open agent detail →
                </a>
              )}
              {proposalsExceeded && (
                <a
                  className={
                    pressureDramatization
                      ? styles.pressureMarker
                      : styles.pressureMarkerSubdued
                  }
                  data-source-fields={useSourceFields(['proposalsToday', 'idleBehavior'])}
                  href={agentDetailHref}
                >
                  Proposals over budget — open agent detail →
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
};
