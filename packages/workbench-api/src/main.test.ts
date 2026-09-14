/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { parseWorkbenchPort } from './main.js';

// The port guard lives in a small, pure, exported helper (parseWorkbenchPort)
// rather than in main() so it can be unit-tested directly. The previous
// child-process smoke test (execFileSync('npx', ['tsx', 'src/main.ts'])) was
// brittle: it depended on the cwd being the package root, npx/tsx being
// installable in the sandbox, and the child's exit status / stderr buffering.
// The main() entrypoint now delegates to exactly this helper, so testing it
// covers the runtime validation path.

describe('parseWorkbenchPort', () => {
  it('defaults to 8080 when the env var is unset', () => {
    // No argument → the helper falls back to process.env. Make this hermetic
    // (do not rely on the ambient env having WORKBENCH_PORT unset — a host or
    // CI job may export it, which would otherwise flip this assertion): save
    // the prior value, delete the var, and restore it in finally.
    const prior = process.env.WORKBENCH_PORT;
    delete process.env.WORKBENCH_PORT;
    try {
      expect(parseWorkbenchPort()).toBe(8080);
    } finally {
      if (prior === undefined) delete process.env.WORKBENCH_PORT;
      else process.env.WORKBENCH_PORT = prior;
    }
  });

  it('parses a plain integer string', () => {
    expect(parseWorkbenchPort('3000')).toBe(3000);
  });

  it('accepts the upper bound of the TCP range', () => {
    expect(parseWorkbenchPort('65535')).toBe(65535);
  });

  it('accepts the lower bound (rejects 0)', () => {
    expect(parseWorkbenchPort('1')).toBe(1);
  });

  it('ignores surrounding whitespace', () => {
    expect(parseWorkbenchPort('  8080  ')).toBe(8080);
  });

  it('rejects a non-numeric value', () => {
    expect(() => parseWorkbenchPort('not-a-number')).toThrow(/invalid WORKBENCH_PORT/);
  });

  it('rejects a numeric value with trailing junk (parseInt would accept it)', () => {
    expect(() => parseWorkbenchPort('8080abc')).toThrow(/invalid WORKBENCH_PORT/);
  });

  it('rejects a hexadecimal-looking value (parseInt would accept it)', () => {
    expect(() => parseWorkbenchPort('0x10')).toThrow(/invalid WORKBENCH_PORT/);
  });

  it('rejects 0 (the chart-managed service needs a concrete port)', () => {
    expect(() => parseWorkbenchPort('0')).toThrow(/invalid WORKBENCH_PORT/);
  });

  it('rejects a negative value', () => {
    expect(() => parseWorkbenchPort('-1')).toThrow(/invalid WORKBENCH_PORT/);
  });

  it('rejects an out-of-range value above 65535', () => {
    expect(() => parseWorkbenchPort('70000')).toThrow(/invalid WORKBENCH_PORT/);
  });

  it('produces a descriptive error message naming the offending value', () => {
    try {
      parseWorkbenchPort('not-a-number');
      throw new Error('should have thrown');
    } catch (err) {
      expect(String(err)).toContain('invalid WORKBENCH_PORT');
      expect(String(err)).toContain('not-a-number');
      expect(String(err)).toContain('1..65535');
    }
  });

  it('accepts a leading-zero value as decimal, not octal', () => {
    expect(parseWorkbenchPort('08080')).toBe(8080);
  });
});
