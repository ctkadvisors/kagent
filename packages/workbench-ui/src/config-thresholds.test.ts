/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Contract gate for the coverage threshold the mission adds.
 *
 * The vitest v8 coverage reporter does not abort `pnpm test` on a
 * breached threshold for this repo (v9.15.9 + @vitest/coverage-v8
 * 4.1.4 emit the numbers but do not exit non-zero), so the enforceable
 * regression guard lives here instead: a plain assertion over the
 * two files the change touches. This fails if either the
 * `test:coverage` script or a non-zero `thresholds` block is removed.
 *
 * The floor number itself (30) is read from the config, not asserted
 * here, on purpose — the number is a policy choice, not part of the
 * contract. If the number drifts, that is a decision for a human.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(here, '../package.json'), 'utf-8')
) as { scripts: Record<string, string> };
const cfgText = readFileSync(
  resolve(here, '../vitest.config.ts'),
  'utf-8'
);

describe('coverage threshold contract', () => {
  it('declares a test:coverage script that enables coverage', () => {
    expect(pkg.scripts).toHaveProperty('test:coverage');
    expect(pkg.scripts['test:coverage']).toContain('--coverage');
  });

  it('vitest.config.ts declares a non-zero coverage thresholds block', () => {
    expect(cfgText).toMatch(/thresholds\s*:/);
    // At least one threshold must carry a real (non-zero) floor.
    const matches = cfgText.match(/thresholds\s*:\s*\{[^}]*\}/s);
    expect(matches, 'expected a thresholds block').toBeTruthy();
    const body = matches![0];
    const numericValues = [...body.matchAll(/\d+/g)].map((m) =>
      Number(m[0])
    );
    expect(
      numericValues.some((n) => n > 0),
      'expected at least one non-zero threshold'
    ).toBe(true);
  });
});
