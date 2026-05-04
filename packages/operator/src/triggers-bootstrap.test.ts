/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Smoke test for the triggers wiring. The actual schedule controller +
 * webhook receiver are exercised in `@kagent/triggers/*.test.ts`; this
 * file just verifies that:
 *   - `buildTriggersBootstrap` returns a handle with the expected shape
 *   - the handle's `scheduleController` is wired (not undefined)
 * It does NOT call `.start()` because that opens a real K8s informer
 * (which needs a working KubeConfig). Boot-with-real-K8s coverage lives
 * in the homelab smoke test (a kubectl-driven Job).
 */

import { describe, expect, it } from 'vitest';

import { buildTriggersBootstrap } from './triggers-bootstrap.js';

describe('buildTriggersBootstrap', () => {
  it('returns a handle with start, stop, and scheduleController', () => {
    const handle = buildTriggersBootstrap({
      kc: {} as never,
      customApi: {} as never,
    });
    expect(typeof handle.start).toBe('function');
    expect(typeof handle.stop).toBe('function');
    expect(handle.scheduleController).toBeDefined();
    expect(typeof handle.scheduleController.tickOnce).toBe('function');
    expect(handle.scheduleController.size()).toBe(0);
  });
});
