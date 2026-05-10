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
import type { DispositionOverlayRow } from '@kagent/dto/disposition';

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

// ────────────────────────────────────────────────────────────────────
// Phase 2 / CC-01 — generalization to AgentSummaryRow / TaskSummary /
// GatewayCapacityRow. Generic helpers; closed-enum K narrows callers.
// Mirrors the Phase-1 disposition test pattern (vi.stubEnv 'NODE_ENV',
// `as unknown as <DTO>` casting for synthesized orphans).
// ────────────────────────────────────────────────────────────────────

describe('source-binding (CC-01 generalization to AgentSummaryRow / TaskSummary / GatewayCapacityRow)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeAgent(
    overrides: Partial<import('../types.js').AgentSummaryRow> = {},
  ): import('../types.js').AgentSummaryRow {
    return {
      name: 'researcher-01',
      namespace: 'kagent-system',
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      modelClass: 'tool-caller-default',
      tools: ['http', 'mcp'],
      capabilities: ['research', 'summarize'],
      ...overrides,
    };
  }

  function makeTask(
    overrides: Partial<import('../types.js').TaskSummary> = {},
  ): import('../types.js').TaskSummary {
    return {
      name: 'research-001',
      namespace: 'kagent-system',
      uid: 'u-001',
      phase: 'Dispatched',
      targetAgent: 'researcher-01',
      targetCapability: 'research',
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      createdAt: '2026-05-10T10:00:00Z',
      startedAt: '2026-05-10T10:00:30Z',
      completedAt: '2026-05-10T10:01:30Z',
      podName: 'research-001-pod',
      suspicious: [],
      artifactCount: 1,
      childCount: 0,
      aggregatePhase: 'Dispatched',
      ...overrides,
    };
  }

  function makeGateway(
    overrides: Partial<import('../types.js').GatewayCapacityRow> = {},
  ): import('../types.js').GatewayCapacityRow {
    return {
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      endpoint: 'https://gateway.ai.cloudflare.com/v1/.../workers-ai',
      backendKind: 'cloudflare-workers-ai',
      inFlight: 1,
      currentCap: 8,
      seed: 4,
      max: 12,
      minSafe: 2,
      recentP50Ms: 42,
      crName: 'cf-llama-4-scout',
      crNamespace: 'kagent-system',
      ...overrides,
    };
  }

  it('Test A — assertSourceField passes silently for AgentSummaryRow.capabilities', () => {
    const row = makeAgent();
    expect(() => {
      assertSourceField<typeof row, import('./source-binding.js').AgentSummaryFieldName>(
        row,
        'capabilities',
      );
    }).not.toThrow();
  });

  it('Test B — assertSourceField THROWS in dev for AgentSummaryRow missing capabilities', () => {
    const orphan = {
      name: 'researcher-01',
      namespace: 'kagent-system',
      // capabilities intentionally missing
    } as unknown as import('../types.js').AgentSummaryRow;

    expect(() => {
      assertSourceField<typeof orphan, import('./source-binding.js').AgentSummaryFieldName>(
        orphan,
        'capabilities',
      );
    }).toThrow(/source-binding violation: rendered field 'capabilities' has no backing source/);
  });

  it('Test C — assertSourceField is a no-op in production for the same orphan AgentSummaryRow', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const orphan = {
      name: 'x',
      namespace: 'y',
    } as unknown as import('../types.js').AgentSummaryRow;
    expect(() => {
      assertSourceField<typeof orphan, import('./source-binding.js').AgentSummaryFieldName>(
        orphan,
        'capabilities',
      );
    }).not.toThrow();
  });

  it('Test D — useSourceField returns the literal field name for AgentSummaryFieldName', () => {
    const v = useSourceField<import('./source-binding.js').AgentSummaryFieldName>('capabilities');
    expect(v).toBe('capabilities');
  });

  it('Test E — assertSourceFields THROWS in dev for synthesized TaskSummary missing phase', () => {
    const orphan = {
      name: 'orphan',
      namespace: 'kagent-system',
      uid: 'u-orphan',
      // phase intentionally missing — multi-field check should catch it.
      targetAgent: 'researcher-01',
    } as unknown as import('../types.js').TaskSummary;

    let caught: Error | null = null;
    try {
      assertSourceFields<typeof orphan, import('./source-binding.js').TaskSummaryFieldName>(
        orphan,
        ['phase', 'targetAgent'],
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toMatch(/sourceFields=phase,targetAgent/);
    expect(caught?.message).toMatch(/computed value/);
  });

  it('Test F — useSourceFields returns the comma-joined string for TaskSummaryFieldName', () => {
    const v = useSourceFields<import('./source-binding.js').TaskSummaryFieldName>([
      'phase',
      'targetAgent',
    ]);
    expect(v).toBe('phase,targetAgent');
  });

  it('Test G — assertSourceField passes for every member of AgentSummaryFieldName on a fully-populated AgentSummaryRow', () => {
    const row = makeAgent();
    expect(() => {
      assertSourceField<typeof row, import('./source-binding.js').AgentSummaryFieldName>(
        row,
        'name',
      );
      assertSourceField<typeof row, import('./source-binding.js').AgentSummaryFieldName>(
        row,
        'namespace',
      );
      assertSourceField<typeof row, import('./source-binding.js').AgentSummaryFieldName>(
        row,
        'model',
      );
      assertSourceField<typeof row, import('./source-binding.js').AgentSummaryFieldName>(
        row,
        'modelClass',
      );
      assertSourceField<typeof row, import('./source-binding.js').AgentSummaryFieldName>(
        row,
        'tools',
      );
      assertSourceField<typeof row, import('./source-binding.js').AgentSummaryFieldName>(
        row,
        'capabilities',
      );
    }).not.toThrow();
  });

  it('Test H — assertSourceField passes for every member of GatewayCapacityFieldName on a fully-populated GatewayCapacityRow', () => {
    const row = makeGateway();
    expect(() => {
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'model',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'endpoint',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'backendKind',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'inFlight',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'currentCap',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'seed',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'max',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'minSafe',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'recentP50Ms',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'crName',
      );
      assertSourceField<typeof row, import('./source-binding.js').GatewayCapacityFieldName>(
        row,
        'crNamespace',
      );
    }).not.toThrow();
  });

  it('Test I — TaskSummary fully-populated: assertSourceField passes for every TaskSummaryFieldName', () => {
    const row = makeTask();
    expect(() => {
      assertSourceField<typeof row, import('./source-binding.js').TaskSummaryFieldName>(
        row,
        'phase',
      );
      assertSourceField<typeof row, import('./source-binding.js').TaskSummaryFieldName>(
        row,
        'targetAgent',
      );
      assertSourceField<typeof row, import('./source-binding.js').TaskSummaryFieldName>(
        row,
        'artifactCount',
      );
      assertSourceField<typeof row, import('./source-binding.js').TaskSummaryFieldName>(
        row,
        'childCount',
      );
    }).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// Phase 3 / FLOW-01 — FlowFieldName closed-enum narrowing tests.
// Proves FlowFieldName is exported from source-binding.ts and that
// the generic helpers accept it without modification (K extends string).
// ────────────────────────────────────────────────────────────────────

describe('source-binding (Phase 3 — FlowFieldName narrowing)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('Test K — useSourceField narrows correctly for each of the 8 FlowFieldName literals', () => {
    const literals: ReadonlyArray<import('./source-binding.js').FlowFieldName> = [
      'modelPower',
      'tokenFlow',
      'buildPower',
      'podCapacity',
      'artifactBandwidth',
      'authority',
      'trust',
      'attention',
    ];
    for (const v of literals) {
      expect(useSourceField<import('./source-binding.js').FlowFieldName>(v)).toBe(v);
    }
  });

  it('Test L — useSourceFields returns comma-joined string for FlowFieldName array', () => {
    const v2 = useSourceFields<import('./source-binding.js').FlowFieldName>([
      'modelPower',
      'tokenFlow',
    ]);
    expect(v2).toBe('modelPower,tokenFlow');
    const v3 = useSourceFields<import('./source-binding.js').FlowFieldName>([
      'modelPower',
      'tokenFlow',
      'buildPower',
    ]);
    expect(v3).toBe('modelPower,tokenFlow,buildPower');
  });
});
