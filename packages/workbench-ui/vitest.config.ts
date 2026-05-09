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
    },
  },
});
