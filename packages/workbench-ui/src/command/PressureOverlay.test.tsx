/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 2 / CC-04 — PressureOverlay tests.
 *
 * Wave 0 scaffold: it.todo placeholders for the four real test
 * cases. Wave 2 (02-03-PLAN.md) replaces them with actual render
 * tests once PRESSURE_TYPES is populated and the JSX lands.
 */

import { afterEach, beforeEach, describe, it, vi } from 'vitest';

describe('PressureOverlay (CC-04)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.todo('renders each pressure marker with data-source-field or data-source-fields');
  it.todo('reload stability — re-render with same snapshot produces equal selector tree');
  it.todo('pressureDramatization=true applies dramatic class on markers');
  it.todo('pressureDramatization=false keeps same data but does NOT apply dramatic class');
});
