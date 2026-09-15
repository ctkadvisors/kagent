/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Config-presence guard for the coverage threshold the mission adds.
 *
 * This repo's vitest v8 coverage provider (v9.15.9 + @vitest/coverage-v8
 * 4.1.4) emits the numbers on a breached threshold but does NOT abort the
 * `pnpm test` process on that breach, so a `test:coverage` script alone would
 * be green even when coverage regresses below the floor. The enforceable side
 * of the gate is a red probe in the pipeline's `verify.sh`, not a vitest
 * assertion here — it drives `vitest run --coverage.thresholds.lines=100` and
 * asserts the process exits non-zero, which is the contract that matters.
 *
 * This test is strictly a config-presence guard: it fails only if the
 * `test:coverage` script or a non-zero `thresholds` block is removed, so it
 * does not claim to fail when coverage regresses. That separation is the whole
 * point — the reviewer on ctkadvisors/kagent#59 asked for exactly this,
 * because a test that claims to guard coverage while staying green over the
 * floor is worse than no guard.
 *
 * The floor numbers themselves are a policy choice, not part of the contract:
 * this test asserts they are > 0 but never pins a specific value, so a human
 * may raise or lower the floor without editing a test.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf-8')) as {
  scripts: Record<string, string>;
};
const cfgText = readFileSync(resolve(here, '../vitest.config.ts'), 'utf-8');

describe('coverage threshold contract', () => {
  it('declares a test:coverage script that enables coverage', () => {
    expect(pkg.scripts).toHaveProperty('test:coverage');
    expect(pkg.scripts['test:coverage']).toContain('--coverage');
  });

  it('vitest.config.ts declares all four coverage metrics, each > 0', () => {
    expect(cfgText).toMatch(/thresholds\s*:/);
    // The full thresholds block (its braces stay balanced on one line).
    const matches = cfgText.match(/thresholds\s*:\s*\{[^}]*\}/s);
    expect(matches, 'expected a thresholds block').toBeTruthy();
    const body = matches![0];

    // Every standard metric must be present with a real (non-zero)
    // floor. A gate that only pins, say, statements would let the
    // other three drift silently — enforcement requires all four.
    for (const metric of ['statements', 'lines', 'functions', 'branches']) {
      const re = new RegExp(`${metric}\\s*:\\s*(\\d+)`);
      const m = body.match(re);
      expect(m, `expected a non-zero '${metric}' threshold`).toBeTruthy();
      const value = Number(m![1]);
      expect(value > 0, `expected a non-zero '${metric}' floor, got ${value}`).toBe(true);
    }
  });
});
