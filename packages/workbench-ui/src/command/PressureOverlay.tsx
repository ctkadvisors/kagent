/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * PressureOverlay — Phase 2 / CC-04. Sibling overlay rendering the
 * nine pressure types from CommandSnapshot fields. Mirrors
 * DispositionOverlay's HTML-over-canvas pattern: a top-level
 * <aside> with absolutely-positioned anchors per marker, each
 * marker carrying data-source-field(s) attributes per
 * COMMAND-CENTER-CONTRACT.md §2 Prime Directive (D7).
 *
 * Reload-stable by construction: state is computed from the snapshot
 * prop via useMemo; no internal state, no fetches, no localStorage.
 *
 * D7 / Prime Directive: every rendered marker carries a substrate
 * source field name. The classify functions in pressure.ts are the
 * source-binding contract; this component just renders what they
 * produce. The conditional spread on data-source-field/data-source-fields
 * preserves strict-typed JSX (no attribute set to undefined).
 */

import { type FC, useMemo } from 'react';

import { PRESSURE_TYPES } from './pressure.js';
import type { PressureMarker } from './pressure.js';
import type { CommandSnapshot } from './state.js';
import styles from './PressureOverlay.module.css';

export interface PressureOverlayProps {
  readonly snapshot: CommandSnapshot;
  /**
   * Slice E base-building-only fallback. Default true. When false
   * the same data still renders but the dramatic CSS class is
   * replaced with a subdued one.
   */
  readonly pressureDramatization?: boolean;
}

export const PressureOverlay: FC<PressureOverlayProps> = ({
  snapshot,
  pressureDramatization = true,
}) => {
  const markers = useMemo<readonly PressureMarker[]>(
    () => PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot)),
    [snapshot],
  );
  if (markers.length === 0) return null;

  return (
    <aside className={styles.card} aria-label="Pressure markers">
      <header className={styles.header}>Pressure</header>
      <ul className={styles.list}>
        {markers.map((marker, i) => {
          const stableKey = `${marker.kind}-${marker.affectedKey ?? `idx-${String(i)}`}`;
          const sf = marker.sourceField;
          const sfs = marker.sourceFields;
          return (
            <li key={stableKey} className={styles.row}>
              <a
                className={
                  pressureDramatization ? styles.pressureMarker : styles.pressureMarkerSubdued
                }
                href={marker.detailLink}
                {...(sf !== undefined ? { 'data-source-field': sf } : {})}
                {...(sfs !== undefined ? { 'data-source-fields': sfs.join(',') } : {})}
              >
                {marker.label} →
              </a>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};
