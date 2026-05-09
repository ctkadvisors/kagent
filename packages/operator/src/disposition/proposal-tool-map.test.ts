/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { PROPOSAL_KINDS, PROPOSAL_TOOL_MAP, classifyToolAsProposal } from './proposal-tool-map.js';

describe('PROPOSAL_KINDS (re-exported from @kagent/dto)', () => {
  it('contains exactly the three Phase-1 kinds in declaration order', () => {
    expect([...PROPOSAL_KINDS]).toEqual(['templates', 'verifiers', 'capability-policy']);
  });
});

describe('PROPOSAL_TOOL_MAP — v0.1 minimal mapping', () => {
  it('maps templates → [write_artifact]', () => {
    expect([...PROPOSAL_TOOL_MAP.templates]).toEqual(['write_artifact']);
  });

  it('maps verifiers → [verifier_register]', () => {
    expect([...PROPOSAL_TOOL_MAP.verifiers]).toEqual(['verifier_register']);
  });

  it('maps capability-policy → [capability_policy_propose]', () => {
    expect([...PROPOSAL_TOOL_MAP['capability-policy']]).toEqual(['capability_policy_propose']);
  });
});

describe('classifyToolAsProposal', () => {
  it('classifies write_artifact as templates', () => {
    expect(classifyToolAsProposal('write_artifact')).toBe('templates');
  });

  it('classifies verifier_register as verifiers', () => {
    expect(classifyToolAsProposal('verifier_register')).toBe('verifiers');
  });

  it('classifies capability_policy_propose as capability-policy', () => {
    expect(classifyToolAsProposal('capability_policy_propose')).toBe('capability-policy');
  });

  it('returns null for a non-proposal tool name like http_get', () => {
    expect(classifyToolAsProposal('http_get')).toBeNull();
  });

  it('returns null for read_artifact (a non-proposal read tool)', () => {
    expect(classifyToolAsProposal('read_artifact')).toBeNull();
  });
});
