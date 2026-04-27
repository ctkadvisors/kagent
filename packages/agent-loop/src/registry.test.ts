/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from './registry.js';
import { DuplicateAgentTypeError, DuplicateSkillIdError } from './errors.js';
import type { MyPhase, MyType } from './__fixtures__/agents.js';
import { chatAgent, researchAgent } from './__fixtures__/agents.js';

describe('AgentRegistry — registration and retrieval', () => {
  let reg: AgentRegistry<MyType, MyPhase>;

  beforeEach(() => {
    reg = new AgentRegistry<MyType, MyPhase>();
  });

  it('SC1: registers two unrelated types with distinct phase affinity', () => {
    reg.register(chatAgent);
    reg.register(researchAgent);
    expect(reg.getAll()).toHaveLength(2);
    expect(reg.getAgent('chat')?.type).toBe('chat');
    expect(reg.getAgent('research')?.type).toBe('research');
    // Distinct phase affinity — chat primaries intake/triage; research primary resolution
    expect(reg.getAgent('chat')?.primaryPhases).toEqual(['intake', 'triage']);
    expect(reg.getAgent('research')?.primaryPhases).toEqual(['resolution']);
  });

  it('returns undefined for getAgent on unknown type', () => {
    expect(reg.getAgent('chat')).toBeUndefined();
  });

  it('SC4f: duplicate type — register() throws DuplicateAgentTypeError on second register without replace', () => {
    reg.register(chatAgent);
    expect(() => reg.register(chatAgent)).toThrow(DuplicateAgentTypeError);
    expect(() => reg.register(chatAgent)).toThrow(/already registered/);
  });

  it('SC4f: duplicate type — { replace: true } overwrites without throwing', () => {
    reg.register(chatAgent);
    expect(() =>
      reg.register({ ...chatAgent, baseConfidence: 0.5 }, { replace: true }),
    ).not.toThrow();
    expect(reg.getAgent('chat')?.baseConfidence).toBe(0.5);
  });

  it('SC4e: duplicate skill — register() throws DuplicateSkillIdError when skill ids collide', () => {
    const badSkills = [
      { id: 'talk', name: 'Talk', description: '', phases: [] as MyPhase[] },
      { id: 'talk', name: 'Other', description: '', phases: [] as MyPhase[] },
    ];
    expect(() => reg.register({ ...chatAgent, skills: badSkills })).toThrow(DuplicateSkillIdError);
  });

  it('SC4c: empty primaryPhases — registers successfully', () => {
    reg.register({ ...chatAgent, primaryPhases: [] });
    expect(reg.getAgent('chat')).toBeDefined();
    expect(reg.getAgent('chat')?.primaryPhases).toEqual([]);
  });

  it('getAll returns a fresh copy — mutation does not affect registry', () => {
    reg.register(chatAgent);
    const copy = reg.getAll();
    copy.pop();
    expect(reg.getAll()).toHaveLength(1);
  });
});
