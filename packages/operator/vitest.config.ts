/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'scripts/**/*.test.ts'],
      // Coverage discipline floor (H5). CLAUDE.md targets ≥85% on the
      // operator reconciler and ≥75% on glue code; the package-level
      // floor below is the CI-enforceable minimum that catches regression
      // without per-file routing. Today's package-level coverage may
      // fall short of these floors on hot files (notably main.ts and
      // some controllers); raising coverage to clear the floor is the
      // follow-up work tracked alongside H5. Do NOT lower these numbers
      // to accommodate today's gaps — add tests instead.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
