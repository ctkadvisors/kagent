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
    ignores: ['dist/**', 'coverage/**', '.tsbuildinfo', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          defaultProject: 'tsconfig.eslint.json',
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
        },
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
    },
  },
  prettierConfig,
);
