/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Bounds normalization shared across every production read site of a
 * `ModelEndpoint`'s `spec.minSafe`. Centralised here so the AIMD floor
 * invariant (`minSafe >= 1`) can be enforced at watch time, lookup
 * time, and admin-display time from one canonical implementation.
 *
 * Audit trail:
 *   - B5 (rev2) installed `Math.max(1, ep.spec.minSafe ?? 1)` at
 *     `model-watch.ts:179` only.
 *   - C3-REV3-H1 (rev3) found that the router calls
 *     `aimd.updateBounds` with the value returned from
 *     `ModelIndex.lookup()` on EVERY request, and that read site at
 *     `model-index.ts:147` was unclamped — so a CR with
 *     `spec.minSafe: 0` would have its watch-time normalization
 *     overwritten on the next request, restoring the original B5 DoS.
 *     `admin-routes.ts:183` was also unclamped (display-only, but
 *     still misleading to operators).
 *
 * The fix: extract the clamp here and have all 3 read sites call it.
 * Future read sites of `spec.minSafe` MUST funnel through this module
 * — grep for `spec.minSafe` should return at most: this file, the
 * type definition in `types.ts`, the test fixtures, and call sites
 * that import `normalizeBounds`.
 *
 * Why a dedicated module instead of re-exporting from `model-watch.ts`
 * (where the function originally lived): `model-watch.ts` imports
 * `@kubernetes/client-node` at the top level, so importing it from
 * `model-index.ts` (a pure data structure used by router unit tests
 * that do not boot the K8s client) would pull in heavy deps, slow
 * test boot, and risk circular-import issues. A dedicated tiny
 * module is the cleanest decoupling.
 */

import type { ModelEndpoint } from './types.js';

/** AIMD-controlled lower bound — must always be >= 1 in practice. */
export const MIN_SAFE_FLOOR = 1;

/**
 * Project a CR's `spec.inFlight.{seed,max}` + `spec.minSafe` into the
 * AIMD-controller bounds shape, applying the audit-B5 floor of 1 to
 * `minSafe`. Nullish-coalescing alone is NOT enough — `?? 1` only
 * substitutes for `null`/`undefined`, not `0`, so a CR with
 * `spec.minSafe: 0` would slip through and let the multiplicative-
 * decrease floor stay at 0 (which combined with `floor(cap/2)` would
 * leave the cap pinned at 0 indefinitely after the first 429/error).
 *
 * We clamp here so the rest of the gateway code (router, AIMD
 * controller, admin/capacity surface) can assume `bounds.minSafe >= 1`
 * as an invariant — at watch time AND on every router read of
 * `ModelIndex.lookup()`, AND in the admin /capacity display.
 */
export function normalizeBounds(ep: ModelEndpoint): {
  seed: number;
  max: number;
  minSafe: number;
} {
  return {
    seed: ep.spec.inFlight.seed,
    max: ep.spec.inFlight.max,
    minSafe: Math.max(MIN_SAFE_FLOOR, ep.spec.minSafe ?? MIN_SAFE_FLOOR),
  };
}
