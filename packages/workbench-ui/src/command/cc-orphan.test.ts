/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 2 / CC-01 — canvas-side orphan assertion test.
 *
 * Mirrors the orphan-throw pattern from source-binding.test.ts
 * Tests 2, 3, 8, 9 (vi.stubEnv 'NODE_ENV' beforeEach/afterEach;
 * `as unknown as <DTO>` casting for synthesized orphans).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertCanvasOrphan, assertSourceField } from './source-binding.js';
import type { AgentSummaryFieldName } from './source-binding.js';
import type { AgentSummaryRow } from '../types.js';

describe('cc-orphan (CC-01 — canvas-side orphan assertion)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('Test 1 — canvas-orphan throws in dev when task references an agent key not in snapshot.agents', () => {
    const snapshot = { agents: new Map<string, unknown>() };
    expect(() => {
      assertCanvasOrphan(snapshot, 'kagent-system', 'lonely-task', 'kagent-system/missing-agent');
    }).toThrow(/CC-01 source-binding violation/);
    expect(() => {
      assertCanvasOrphan(snapshot, 'kagent-system', 'lonely-task', 'kagent-system/missing-agent');
    }).toThrow(/lonely-task/);
    expect(() => {
      assertCanvasOrphan(snapshot, 'kagent-system', 'lonely-task', 'kagent-system/missing-agent');
    }).toThrow(/kagent-system\/missing-agent/);
    expect(() => {
      assertCanvasOrphan(snapshot, 'kagent-system', 'lonely-task', 'kagent-system/missing-agent');
    }).toThrow(/COMMAND-CENTER-CONTRACT\.md §2/);
  });

  it('Test 2 — canvas-orphan passes silently when agent key exists in snapshot.agents', () => {
    const snapshot = {
      agents: new Map<string, unknown>([['kagent-system/researcher-01', {}]]),
    };
    expect(() => {
      assertCanvasOrphan(snapshot, 'kagent-system', 'task-x', 'kagent-system/researcher-01');
    }).not.toThrow();
  });

  it('Test 3 — AgentPanel field-orphan: assertSourceField throws when capabilities is missing on synthesized AgentSummaryRow', () => {
    const orphan = {
      name: 'researcher-01',
      namespace: 'kagent-system',
      // capabilities intentionally missing
    } as unknown as AgentSummaryRow;
    expect(() => {
      assertSourceField<typeof orphan, AgentSummaryFieldName>(orphan, 'capabilities');
    }).toThrow(/source-binding violation: rendered field 'capabilities'/);
  });

  it('Test 4 — NODE_ENV=production makes both assertions no-ops', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const emptySnapshot = { agents: new Map<string, unknown>() };
    expect(() => {
      assertCanvasOrphan(emptySnapshot, 'kagent-system', 't', 'kagent-system/missing');
    }).not.toThrow();
    const orphan = {
      name: 'a',
      namespace: 'b',
    } as unknown as AgentSummaryRow;
    expect(() => {
      assertSourceField<typeof orphan, AgentSummaryFieldName>(orphan, 'capabilities');
    }).not.toThrow();
  });
});
