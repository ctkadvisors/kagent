/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from './registry.js';
import type { MyPhase, MyType } from './__fixtures__/agents.js';
import { chatAgent, researchAgent } from './__fixtures__/agents.js';

describe('AgentRegistry — scoring determinism (SC2)', () => {
  let reg: AgentRegistry<MyType, MyPhase>;

  beforeEach(() => {
    reg = new AgentRegistry<MyType, MyPhase>();
    reg.register(chatAgent);
    reg.register(researchAgent);
  });

  it('SC2a: recommendAgent is deterministic across 1000 invocations', () => {
    const first = reg.recommendAgent('triage');
    for (let i = 0; i < 999; i++) {
      expect(reg.recommendAgent('triage')).toEqual(first);
    }
  });

  it('SC2b: two instances with identical registration order produce identical scoring', () => {
    const a = new AgentRegistry<MyType, MyPhase>();
    const b = new AgentRegistry<MyType, MyPhase>();
    for (const r of [a, b]) {
      r.register(chatAgent);
      r.register(researchAgent);
    }
    expect(a.listSuitable('triage')).toEqual(b.listSuitable('triage'));
    expect(a.listSuitable('resolution')).toEqual(b.listSuitable('resolution'));
    expect(a.recommendAgent('intake')).toEqual(b.recommendAgent('intake'));
  });
});

describe('AgentRegistry — scoring edges', () => {
  it('SC4a: tied scores break on insertion order', () => {
    const reg = new AgentRegistry<MyType, MyPhase>();
    // Two identical-scoring agents — same baseConfidence, same primaryPhases, no skills
    const twinA: typeof chatAgent = {
      ...chatAgent,
      type: 'chat',
      name: 'Twin A',
      primaryPhases: ['intake'],
      secondaryPhases: [],
      skills: [],
      baseConfidence: 0.7,
    };
    const twinB: typeof chatAgent = {
      ...chatAgent,
      type: 'research',
      name: 'Twin B',
      primaryPhases: ['intake'],
      secondaryPhases: [],
      skills: [],
      baseConfidence: 0.7,
    };
    reg.register(twinA);
    reg.register(twinB);
    const ranked = reg.listSuitable('intake');
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
    // Tie-break: first registered (twinA = 'chat') comes first
    expect(ranked[0]?.agent.type).toBe('chat');
    expect(ranked[1]?.agent.type).toBe('research');
  });

  it('SC4b: unknown phase returns neither-bonus score, not crash', () => {
    const reg = new AgentRegistry<MyType, MyPhase>();
    reg.register(chatAgent); // baseConfidence 0.82; primaryPhases intake/triage; secondary resolution
    // 'resolution' is secondaryPhases → +0.1 ; an unknown phase is neither → -0.3
    const knownSecondary = reg.calculateSuitabilityScore('chat', 'resolution');
    expect(knownSecondary).toBeCloseTo(0.82 + 0.1 + 0, 5); // no skills match resolution
    // Simulate an "unknown" phase by asking about a phase not in primary or secondary.
    // (All MyPhase values are covered by chatAgent's primary+secondary, so we cast.)
    const unknownScore = reg.calculateSuitabilityScore('chat', 'unrecognized' as MyPhase);
    // 0.82 + (-0.3) + 0 * 0.05 = 0.52
    expect(unknownScore).toBeCloseTo(0.52, 5);
    expect(unknownScore).toBeGreaterThan(0);
    expect(unknownScore).toBeLessThan(1);
  });
});

describe('AgentRegistry — scope filter truth table (SC4d)', () => {
  // [row-number, requiredScope, callerScope, expectedPass]
  const rows: Array<
    [number, readonly string[] | undefined, readonly string[] | undefined, boolean]
  > = [
    [1, undefined, undefined, true],
    [2, undefined, [], true],
    [3, undefined, ['x', 'y'], true],
    [4, [], undefined, true],
    [5, [], [], true],
    [6, [], ['x'], true],
    [7, ['a'], undefined, false],
    [8, ['a'], [], false],
    [9, ['a'], ['a'], true],
    [10, ['a'], ['a', 'b'], true],
    [11, ['a', 'b'], ['a'], false],
    [12, ['a'], ['b'], false],
    [13, ['a', 'b'], ['a', 'b', 'c'], true],
  ];

  it.each(rows)(
    'scope filter row %i: required=%j caller=%j -> pass=%s',
    (_row, required, caller, expectedPass) => {
      const reg = new AgentRegistry<MyType, MyPhase>();
      const agent = {
        ...chatAgent,
        ...(required !== undefined ? { requiredScope: required } : {}),
      };
      reg.register(agent);
      const result = reg.listSuitable('intake', caller);
      const included = result.some((s) => s.agent.type === 'chat');
      expect(included).toBe(expectedPass);
    },
  );
});
