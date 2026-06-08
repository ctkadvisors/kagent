/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { buildArchitectMessages, REPAIR_PREFIX } from './architect-prompt.js';

describe('buildArchitectMessages', () => {
  it('puts the candidate contract in the system message and the user ask last', () => {
    const msgs = buildArchitectMessages({ userGoal: 'a summarizer agent' });
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toContain('AgentTemplateSpec');
    expect(msgs[0]?.content).toContain('agentSpec');
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'a summarizer agent' });
  });

  it('steers logical routing through modelClass instead of model aliases', () => {
    const system = buildArchitectMessages({ userGoal: 'a summarizer agent' })[0]?.content ?? '';
    expect(system).toContain('modelClass');
    expect(system).toContain('Use agentSpec.modelClass, not agentSpec.model');
    expect(system).toContain('text-generator-default');
  });

  it('appends a repair turn carrying the validation error when provided', () => {
    const msgs = buildArchitectMessages({
      userGoal: 'x',
      priorYaml: 'agentSpec: {}',
      validationError: 'parameters must be a non-empty array',
    });
    const last = msgs.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toContain(REPAIR_PREFIX);
    expect(last.content).toContain('non-empty array');
    expect(last.content).toContain('agentSpec: {}');
    // the bad assistant output is replayed so the model has context
    expect(msgs.some((m) => m.role === 'assistant' && m.content === 'agentSpec: {}')).toBe(true);
  });
});
