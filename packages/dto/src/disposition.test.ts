/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-03 — DispositionOverlayRow DTO tests.
 *
 * Validates the shared DTO that workbench-api emits and workbench-ui
 * consumes. The runtime guard `assertIsDispositionOverlayRow` is a
 * UI-side defense against schema drift — every required field MUST
 * be checked.
 */

import { describe, expect, it, expectTypeOf } from 'vitest';

import {
  assertIsDispositionOverlayRow,
  type DispositionOverBudgetReason,
  type DispositionOverlayRow,
  type DispositionProposalKind,
} from './disposition.js';

function validRow(overrides: Partial<DispositionOverlayRow> = {}): DispositionOverlayRow {
  return {
    agentRef: 'kagent-system/researcher-01',
    namespace: 'kagent-system',
    agentName: 'researcher-01',
    configMapName: 'researcher-01-disposition',
    idleBehavior: {
      readChannels: [],
      attentionBudget: { tokensPerDay: 50000, pollIntervalSeconds: 300 },
      proposalScope: {
        mayProposeAgainst: ['templates', 'verifiers'],
        maxProposalsPerDay: 3,
      },
    },
    spentTokensToday: 0,
    postsToday: 0,
    proposalsToday: 0,
    overBudget: false,
    overBudgetEventCountToday: 0,
    dailyBoundaryUtc: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('assertIsDispositionOverlayRow', () => {
  it('Test 1 — passes a valid DispositionOverlayRow without throwing', () => {
    expect(() => assertIsDispositionOverlayRow(validRow())).not.toThrow();
  });

  it('Test 1b — throws when value is not an object', () => {
    expect(() => assertIsDispositionOverlayRow(null)).toThrow(/not an object/);
    expect(() => assertIsDispositionOverlayRow('hello')).toThrow(/not an object/);
    expect(() => assertIsDispositionOverlayRow(42)).toThrow(/not an object/);
  });

  it('Test 1c — throws on missing top-level required fields', () => {
    const row = validRow() as Record<string, unknown>;
    delete row['agentRef'];
    expect(() => assertIsDispositionOverlayRow(row)).toThrow(/agentRef missing/);
  });

  it('Test 4 — accepts a row whose spentTokensToday > tokensPerDay (shape allows it)', () => {
    // The DTO is shape-only; the projection sets `overBudget` based on
    // the comparison. The guard MUST accept the over-budget shape.
    const row = validRow({
      spentTokensToday: 60000,
      overBudget: true,
      overBudgetReason: 'tokens_exceeded',
      overBudgetEventCountToday: 1,
    });
    expect(() => assertIsDispositionOverlayRow(row)).not.toThrow();
    expect(row.spentTokensToday > row.idleBehavior.attentionBudget.tokensPerDay).toBe(true);
  });

  it('Test 5 — fails the guard when overBudgetEventCountToday is missing; passes when present', () => {
    const missing = { ...validRow() } as Record<string, unknown>;
    delete missing['overBudgetEventCountToday'];
    expect(() => assertIsDispositionOverlayRow(missing)).toThrow(/overBudgetEventCountToday/);

    const present = validRow({ overBudgetEventCountToday: 0 });
    expect(() => assertIsDispositionOverlayRow(present)).not.toThrow();
  });

  it('rejects rows with an unknown overBudgetReason', () => {
    const bad = validRow() as DispositionOverlayRow & {
      overBudgetReason?: string;
    };
    (bad as Record<string, unknown>)['overBudgetReason'] = 'something_else';
    expect(() => assertIsDispositionOverlayRow(bad)).toThrow(
      /overBudgetReason 'something_else' is not a known value/,
    );
  });

  it('rejects rows where postsToday is not literal 0', () => {
    const bad = validRow() as Record<string, unknown>;
    bad['postsToday'] = 5;
    expect(() => assertIsDispositionOverlayRow(bad)).toThrow(/postsToday must be 0 in v0.2/);
  });
});

describe('DispositionOverlayRow type-level invariants', () => {
  it('Test 2 — postsToday is literal-typed as 0 (TypeScript-level)', () => {
    expectTypeOf<DispositionOverlayRow['postsToday']>().toEqualTypeOf<0>();
  });

  it('Test 3 — overBudgetReason is optional and one of the three known values', () => {
    expectTypeOf<DispositionOverlayRow['overBudgetReason']>().toEqualTypeOf<
      DispositionOverBudgetReason | undefined
    >();
    // Exhaustive union check.
    const reasons: DispositionOverBudgetReason[] = [
      'tokens_exceeded',
      'proposals_exceeded',
      'both',
    ];
    expect(reasons).toHaveLength(3);
  });

  it('DispositionProposalKind matches the parser-side kinds', () => {
    expectTypeOf<DispositionProposalKind>().toEqualTypeOf<
      'templates' | 'verifiers' | 'capability-policy'
    >();
  });

  it('overBudgetEventCountToday is a required number (not optional)', () => {
    // If this changes to optional, ROADMAP success criterion 4 breaks.
    expectTypeOf<DispositionOverlayRow['overBudgetEventCountToday']>().toEqualTypeOf<number>();
  });
});
