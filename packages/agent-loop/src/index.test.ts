/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import { VERSION, scaffoldOk } from './index.js';

describe('scaffold contract', () => {
  it('exports a semver-shaped VERSION', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('scaffoldOk() returns a string that embeds VERSION', () => {
    const out = scaffoldOk();
    expect(out).toContain(VERSION);
    expect(out).toMatch(/scaffold OK$/);
  });
});
