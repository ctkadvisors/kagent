/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-04 prereq — vitest + jsdom + @testing-library
 * configuration for `@kagent/workbench-ui`.
 *
 * Mirrors the shape of `packages/dto/vitest.config.ts` but targets
 * the browser environment via jsdom so React component tests work
 * (DispositionOverlay.test.tsx in plan 04, future Command Center
 * snapshot tests).
 *
 * Reload-stability assertion strategy (CC-01 / Slice A):
 *   1. Render component with a fixture-derived prop set.
 *   2. Snapshot the rendered DOM.
 *   3. Re-render with the same fixture; assert identical snapshot.
 *
 * `passWithNoTests: true` keeps `pnpm test` green during plans
 * that haven't authored UI tests yet (DISP-01..03 are pure-API).
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/main.tsx'],
      // Regression floor. Set to 30 — deliberately just below the
      // package's current measured value (~32.83% lines) so a gate
      // added today is green on arrival. A coverage gate that passes
      // the day it lands would prove nothing. This still fails the
      // moment coverage regresses below 30%, which is exactly the
      // regression guard a coverage threshold should provide. Do NOT
      // raise it to match a number elsewhere; clearing a higher floor
      // requires adding tests, which is separate work.
      // Today's measured coverage: 34.63% statements, 32.83% lines,
      // 43.96% functions, 27.87% branches. Keep statements/functions/
      // lines at 30 (below their current values) and set branches
      // below 27.87% — it is the metric the current tests most miss,
      // so it is the one that would bite first. All four floors sit
      // under today's measured coverage, so the gate is green on the
      // day it lands and fails only if coverage regresses.
      thresholds: {
        statements: 30,
        lines: 30,
        functions: 30,
        branches: 25,
      },
    },
  },
});
