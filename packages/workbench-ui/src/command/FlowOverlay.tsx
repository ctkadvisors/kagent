/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * FlowOverlay — Phase 3 / FLOW-01. Sibling overlay rendering the
 * eight C-flow-economy resource flow gauges from CommandSnapshot
 * fields. Mirrors DispositionOverlay and PressureOverlay's
 * HTML-over-canvas pattern: a top-level <aside> with absolutely-
 * positioned gauge rows per flow type, each row carrying
 * data-source-field(s) attributes per COMMAND-CENTER-CONTRACT.md
 * §2 Prime Directive (D7).
 *
 * Reload-stable by construction: state is computed from the snapshot
 * prop via useMemo grouped by FLOW_TYPES kind; no internal state,
 * no fetches, no localStorage.
 *
 * KEY DEVIATION from PressureOverlay.tsx:49 (`if (markers.length === 0) return null;`):
 * FlowOverlay NEVER returns null. All 8 flow sections are ALWAYS
 * visible — when a flow has no gauges, a placeholder "— no <kind>
 * source data" row is rendered carrying the FlowType's source
 * field(s) so the orphan assertion still has a backing field.
 * Silence is data per CONTEXT.md D-05-A + RESEARCH.md Pitfall 7.
 *
 * D7 / Prime Directive: every rendered gauge and every empty-state
 * placeholder carries a substrate source field name. The compute
 * functions in flows.ts are the source-binding contract; this
 * component just renders what they produce. The conditional spread
 * on data-source-field/data-source-fields preserves strict-typed
 * JSX (no attribute set to undefined).
 */

import { type FC, useMemo } from 'react';

import { FLOW_TYPES } from './flows.js';
import type { FlowGauge, FlowType } from './flows.js';
import type { CommandSnapshot } from './state.js';
import styles from './FlowOverlay.module.css';

export interface FlowOverlayProps {
  readonly snapshot: CommandSnapshot;
  /**
   * Slice E base-building-only fallback. Default true. When false
   * the same data still renders but the dramatic CSS class is
   * replaced with a subdued one.
   *
   * Per CONTEXT.md D-04-A: single global flag covers BOTH pressure
   * markers AND flow gauges. Prop name is intentionally identical to
   * PressureOverlay's — DO NOT rename to flowDramatization.
   */
  readonly pressureDramatization?: boolean;
}

export const FlowOverlay: FC<FlowOverlayProps> = ({
  snapshot,
  pressureDramatization = true,
}) => {
  const gaugesByKind = useMemo<ReadonlyMap<FlowType['kind'], readonly FlowGauge[]>>(() => {
    const m = new Map<FlowType['kind'], readonly FlowGauge[]>();
    for (const ft of FLOW_TYPES) {
      m.set(ft.kind, ft.compute(snapshot));
    }
    return m;
  }, [snapshot]);

  return (
    <aside className={styles.card} aria-label="Resource flows">
      <header className={styles.header}>Flows</header>
      {FLOW_TYPES.map((ft) => {
        const gauges = gaugesByKind.get(ft.kind) ?? [];
        const ftSf = ft.sourceField;
        const ftSfs = ft.sourceFields;
        return (
          <section key={ft.kind} className={styles.section}>
            <h3 className={styles.sectionHeader}>{ft.kind}</h3>
            <ul className={styles.list}>
              {gauges.length === 0 ? (
                <li key={`${ft.kind}-empty`} className={styles.row}>
                  <div
                    className={styles.emptyRow}
                    {...(ftSf !== undefined ? { 'data-source-field': ftSf } : {})}
                    {...(ftSfs !== undefined ? { 'data-source-fields': ftSfs.join(',') } : {})}
                  >
                    — no {ft.kind} source data
                  </div>
                </li>
              ) : (
                gauges.map((gauge, i) => {
                  const stableKey = `${gauge.kind}-${gauge.affectedKey ?? `idx-${String(i)}`}`;
                  const sf = gauge.sourceField;
                  const sfs = gauge.sourceFields;
                  const hasCapacity = gauge.capacity !== undefined && gauge.capacity > 0;
                  const fillPct = hasCapacity
                    ? Math.min(100, Math.round((gauge.value / gauge.capacity) * 100))
                    : undefined;
                  return (
                    <li key={stableKey} className={styles.row}>
                      <a
                        className={
                          pressureDramatization ? styles.flowGauge : styles.flowGaugeSubdued
                        }
                        href={gauge.detailLink}
                        {...(sf !== undefined ? { 'data-source-field': sf } : {})}
                        {...(sfs !== undefined ? { 'data-source-fields': sfs.join(',') } : {})}
                      >
                        {hasCapacity && fillPct !== undefined ? (
                          <>
                            <div className={styles.bar}>
                              <div
                                className={styles.barFill}
                                style={{ width: `${String(fillPct)}%` }}
                              />
                              <span className={styles.readout}>
                                {gauge.label} {String(gauge.value)}/{String(gauge.capacity)}{' '}
                                {gauge.unit}
                              </span>
                            </div>
                          </>
                        ) : (
                          <span className={styles.readout}>
                            {gauge.label} {String(gauge.value)} {gauge.unit}
                          </span>
                        )}
                      </a>
                    </li>
                  );
                })
              )}
            </ul>
          </section>
        );
      })}
    </aside>
  );
};
