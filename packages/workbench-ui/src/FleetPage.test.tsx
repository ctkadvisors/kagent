/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { fleetConsoleUrl } from './FleetPage.js';

describe('fleetConsoleUrl', () => {
  it('frames only https and falls back otherwise', () => {
    expect(fleetConsoleUrl(undefined)).toBe('https://fleet.knuteson.io/');
    expect(fleetConsoleUrl('https://fleet.lan/')).toBe('https://fleet.lan/');
    expect(fleetConsoleUrl('javascript:alert(1)')).toBe('https://fleet.knuteson.io/');
    expect(fleetConsoleUrl('data:text/html,hi')).toBe('https://fleet.knuteson.io/');
    expect(fleetConsoleUrl('not a url')).toBe('https://fleet.knuteson.io/');
  });
});
