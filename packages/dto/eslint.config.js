/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import licenseHeader from 'eslint-plugin-license-header';
import prettierConfig from 'eslint-config-prettier';

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    // Skip generated artefacts. eslint.config.js is the lint rules
    // themselves (linting it would create a chicken-and-egg type-aware
    // parsing loop). vitest.config.ts IS linted (added to
    // tsconfig.eslint.json) so lint-staged on a `vitest.config.ts` edit
    // doesn't choke with "file ignored" warnings.
    ignores: ['dist/**', 'coverage/**', '.tsbuildinfo', 'node_modules/**', 'eslint.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Legacy `project` form (rather than projectService) — required so
        // test files + __fixtures__ lint via tsconfig.eslint.json without
        // typescript-eslint v8's "** glob disallowed in allowDefaultProject"
        // restriction kicking in. tsconfig.json (build) excludes tests; this
        // config sees them.
        project: ['tsconfig.eslint.json'],
        tsconfigRootDir,
      },
    },
    plugins: {
      'license-header': licenseHeader,
    },
    rules: {
      'license-header/header': [
        'error',
        [
          '/**',
          ' * SPDX-License-Identifier: MIT',
          ' * Copyright (c) 2026 Chris Knuteson',
          ' */',
        ],
      ],
      // Standard `_`-prefix convention for intentionally-unused params.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  prettierConfig,
);
