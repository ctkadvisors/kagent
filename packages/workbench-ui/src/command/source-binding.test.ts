/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-04 — tests for `source-binding.ts`.
 *
 * Covers the COMMAND-CENTER-CONTRACT.md §2 Prime Directive scoped to
 * the disposition slice: every rendered field MUST derive from a
 * substrate source. Single-field helper for direct DTO bindings;
 * multi-field helper for computed values per Codex HIGH #5.
 *
 * Tests 1–6: single-field variant
 * Tests 7–10: multi-field variant
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispositionOverlayRow } from '@kagent/dto';

import {
  assertSourceField,
  assertSourceFields,
  useSourceField,
  useSourceFields,
} from './source-binding.js';

function makeRow(overrides: Partial<DispositionOverlayRow> = {}): DispositionOverlayRow {
  return {
    agentRef: 'kagent-system/researcher-01',
    namespace: 'kagent-system',
    agentName: 'researcher-01',
    configMapName: 'researcher-01-disposition',
    idleBehavior: {
      readChannels: [],
      attentionBudget: { tokensPerDay: 50_000, pollIntervalSeconds: 300 },
      proposalScope: { mayProposeAgainst: ['templates'], maxProposalsPerDay: 3 },
    },
    spentTokensToday: 12_345,
    postsToday: 0,
    proposalsToday: 1,
    overBudget: false,
    overBudgetEventCountToday: 0,
    dailyBoundaryUtc: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('source-binding (DISP-04 / CC-01 disposition slice)', () => {
  beforeEach(() => {
    // Default: dev build. Individual tests override via vi.stubEnv.
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('Test 1 — assertSourceField passes silently when field is present', () => {
    const row = makeRow();
    expect(() => {
      assertSourceField(row, 'spentTokensToday');
    }).not.toThrow();
  });

  it('Test 2 — assertSourceField THROWS in dev for a synthesized orphan field', () => {
    // Construct a row missing `spentTokensToday` via a typed cast — the
    // exact case synthesized fixtures hit before the DTO guard runs.
    const orphan = {
      agentRef: 'kagent-system/orphan',
      namespace: 'kagent-system',
      agentName: 'orphan',
      configMapName: 'orphan-disposition',
      idleBehavior: makeRow().idleBehavior,
      // spentTokensToday intentionally missing
      postsToday: 0,
      proposalsToday: 0,
      overBudget: false,
      overBudgetEventCountToday: 0,
      dailyBoundaryUtc: '2026-05-09T00:00:00.000Z',
    } as unknown as DispositionOverlayRow;

    expect(() => {
      assertSourceField(orphan, 'spentTokensToday');
    }).toThrow(/source-binding violation: rendered field 'spentTokensToday' has no backing source/);
  });

  it('Test 3 — assertSourceField is a no-op in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const orphan = {
      agentRef: 'x/y',
      // ...everything else missing
    } as unknown as DispositionOverlayRow;

    expect(() => {
      assertSourceField(orphan, 'spentTokensToday');
    }).not.toThrow();
  });

  it('Test 4 — useSourceField returns the field name string', () => {
    expect(useSourceField('spentTokensToday')).toBe('spentTokensToday');
    expect(useSourceField('overBudget')).toBe('overBudget');
  });

  it('Test 5 — useSourceField is a passthrough — does NOT runtime-check', () => {
    // In production mode, the assertion is a no-op; useSourceField is
    // a literal passthrough that has no side effects regardless. This
    // proves the DOM-attribute call site is always-safe.
    vi.stubEnv('NODE_ENV', 'production');
    expect(useSourceField('spentTokensToday')).toBe('spentTokensToday');
    vi.stubEnv('NODE_ENV', 'development');
    expect(useSourceField('proposalsToday')).toBe('proposalsToday');
  });

  it('Test 6 — assertSourceField accepts the closed list of valid keys (type-check primary defense)', () => {
    const row = makeRow();
    // Each closed-enum value passes silently.
    expect(() => {
      assertSourceField(row, 'agentRef');
      assertSourceField(row, 'namespace');
      assertSourceField(row, 'agentName');
      assertSourceField(row, 'configMapName');
      assertSourceField(row, 'idleBehavior');
      assertSourceField(row, 'spentTokensToday');
      assertSourceField(row, 'postsToday');
      assertSourceField(row, 'proposalsToday');
      assertSourceField(row, 'overBudget');
      assertSourceField(row, 'overBudgetEventCountToday');
      assertSourceField(row, 'dailyBoundaryUtc');
    }).not.toThrow();
  });

  // ────────────────────────────────────────────────────────────────
  // Multi-field variant (Codex HIGH #5)
  // ────────────────────────────────────────────────────────────────

  it('Test 7 — assertSourceFields passes silently when ALL listed fields are present', () => {
    const row = makeRow();
    expect(() => {
      assertSourceFields(row, ['spentTokensToday', 'idleBehavior']);
    }).not.toThrow();
    expect(() => {
      assertSourceFields(row, ['proposalsToday', 'idleBehavior']);
    }).not.toThrow();
  });

  it('Test 8 — assertSourceFields THROWS in dev when ANY listed field is missing; message names the missing field AND the full sourceFields list', () => {
    const row = {
      agentRef: 'kagent-system/orphan',
      namespace: 'kagent-system',
      agentName: 'orphan',
      configMapName: 'orphan-disposition',
      // idleBehavior intentionally missing — the multi-field bind for
      // "tokens remaining" must catch the missing input.
      spentTokensToday: 100,
      postsToday: 0,
      proposalsToday: 0,
      overBudget: false,
      overBudgetEventCountToday: 0,
      dailyBoundaryUtc: '2026-05-09T00:00:00.000Z',
    } as unknown as DispositionOverlayRow;

    let caught: Error | null = null;
    try {
      assertSourceFields(row, ['spentTokensToday', 'idleBehavior']);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toMatch(/idleBehavior/);
    expect(caught?.message).toMatch(/sourceFields=spentTokensToday,idleBehavior/);
    expect(caught?.message).toMatch(/computed value/);
  });

  it('Test 9 — assertSourceFields is a no-op in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const orphan = { agentRef: 'x/y' } as unknown as DispositionOverlayRow;
    expect(() => {
      assertSourceFields(orphan, ['spentTokensToday', 'idleBehavior']);
    }).not.toThrow();
  });

  it('Test 10 — useSourceFields returns the comma-joined string', () => {
    expect(useSourceFields(['spentTokensToday', 'idleBehavior'])).toBe(
      'spentTokensToday,idleBehavior',
    );
    expect(useSourceFields(['proposalsToday', 'idleBehavior'])).toBe('proposalsToday,idleBehavior');
    // Single-element list still works (degenerate multi-field call).
    expect(useSourceFields(['overBudget'])).toBe('overBudget');
  });
});
