/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 2 / CC-01 — canvas-side orphan assertion test.
 *
 * Wave 0 scaffold: 3 it.todo placeholders. Wave 1 (02-02-PLAN.md)
 * fills in the bodies once the CC-01 assertion lands in
 * CommandView.tsx's agentNodes useMemo (per CONTEXT.md D-CC-01-A).
 *
 * Mirrors the orphan-throw pattern from source-binding.test.ts
 * Tests 2, 3, 8, 9 (vi.stubEnv 'NODE_ENV' beforeEach/afterEach;
 * `as unknown as <DTO>` casting for synthesized orphans).
 */

import { afterEach, beforeEach, describe, it, vi } from 'vitest';

describe('cc-orphan (CC-01 — canvas-side orphan assertion)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.todo(
    'canvas-side orphan assertion throws in dev when a task references an agent key not in snapshot.agents',
  );
  it.todo(
    'AgentPanel field-orphan: assertSourceField throws when capabilities is missing on a synthesized AgentSummaryRow',
  );
  it.todo("NODE_ENV='production' makes both assertions no-ops (vi.stubEnv)");
});
