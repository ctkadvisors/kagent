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
 * Wave 0 scaffold: returns null until PRESSURE_TYPES is populated
 * in Wave 1 (02-02-PLAN.md) and full JSX lands in Wave 2
 * (02-03-PLAN.md).
 */

import { type FC, useMemo } from 'react';

import { PRESSURE_TYPES } from './pressure.js';
import type { PressureMarker } from './pressure.js';
import type { CommandSnapshot } from './state.js';
// Module CSS imported so Wave 2 can drop in styles without an additional
// file change. The `_styles` underscore-prefix mirrors eslint.config.js's
// `varsIgnorePattern: '^_'` so the unused-binding warning is silenced
// until Wave 2 references it.
import _styles from './PressureOverlay.module.css';

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
  pressureDramatization: _pressureDramatization = true,
}) => {
  // Wave 1 (02-02-PLAN.md) populates PRESSURE_TYPES with 9 entries;
  // until then this returns [] and the component renders null.
  const markers = useMemo<readonly PressureMarker[]>(
    () => PRESSURE_TYPES.flatMap((pt) => pt.classify(snapshot)),
    [snapshot],
  );
  if (markers.length === 0) return null;

  // Wave 2 (02-03-PLAN.md) replaces this with the full <aside>+<ul>
  // JSX (mirrors DispositionOverlay.tsx lines 71-189). Until then
  // the component cannot reach this branch (PRESSURE_TYPES is empty).
  return null;
};
