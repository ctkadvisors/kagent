/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-01 — disposition-parser tests.
 *
 * Validates V5 input-validation discipline: every malformed overlay
 * returns `{ ok: false, error }` with an error string mentioning the
 * specific field — never throws. Callers fall back to "no overlay"
 * (base Agent claims) on `ok=false`.
 */

import { describe, expect, it } from 'vitest';
import type { V1ConfigMap } from '@kubernetes/client-node';

import {
  DISPOSITION_AGENT_REF_ANNOTATION,
  DISPOSITION_LABEL,
  PROPOSAL_KINDS,
  parseDispositionConfigMap,
} from './disposition-parser.js';

const VALID_DISPOSITION_YAML = `
idleBehavior:
  readChannels: []
  attentionBudget:
    tokensPerDay: 50000
    pollIntervalSeconds: 300
  proposalScope:
    mayProposeAgainst:
      - templates
      - verifiers
    maxProposalsPerDay: 3
`;

function makeCm(overrides: {
  data?: Record<string, string>;
  annotations?: Record<string, string>;
  name?: string | null;
  namespace?: string | null;
}): V1ConfigMap {
  return {
    metadata: {
      name: overrides.name === null ? undefined : (overrides.name ?? 'researcher-01-disposition'),
      namespace:
        overrides.namespace === null ? undefined : (overrides.namespace ?? 'kagent-system'),
      labels: { [DISPOSITION_LABEL]: 'true' },
      annotations: overrides.annotations ?? {
        [DISPOSITION_AGENT_REF_ANNOTATION]: 'kagent-system/researcher-01',
      },
    },
    data: overrides.data ?? { 'disposition.yaml': VALID_DISPOSITION_YAML },
  } as V1ConfigMap;
}

describe('PROPOSAL_KINDS', () => {
  it('is a frozen array of three known kinds in declaration order', () => {
    expect([...PROPOSAL_KINDS]).toEqual(['templates', 'verifiers', 'capability-policy']);
    expect(Object.isFrozen(PROPOSAL_KINDS)).toBe(true);
  });
});

describe('parseDispositionConfigMap — valid overlay', () => {
  it('parses a canonical valid ConfigMap', () => {
    const result = parseDispositionConfigMap(makeCm({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overlay.agentRef).toBe('kagent-system/researcher-01');
    expect(result.overlay.agentNamespace).toBe('kagent-system');
    expect(result.overlay.agentName).toBe('researcher-01');
    expect(result.overlay.configMapName).toBe('researcher-01-disposition');
    expect(result.overlay.configMapNamespace).toBe('kagent-system');
    expect(result.overlay.idleBehavior.readChannels).toEqual([]);
    expect(result.overlay.idleBehavior.attentionBudget.tokensPerDay).toBe(50000);
    expect(result.overlay.idleBehavior.attentionBudget.pollIntervalSeconds).toBe(300);
    expect([...result.overlay.idleBehavior.proposalScope.mayProposeAgainst]).toEqual([
      'templates',
      'verifiers',
    ]);
    expect(result.overlay.idleBehavior.proposalScope.maxProposalsPerDay).toBe(3);
  });
});

describe('parseDispositionConfigMap — fail-closed on missing required fields', () => {
  it('rejects an overlay missing tokensPerDay (mentions the field)', () => {
    const yaml = `
idleBehavior:
  readChannels: []
  attentionBudget:
    pollIntervalSeconds: 300
  proposalScope:
    mayProposeAgainst:
      - templates
    maxProposalsPerDay: 3
`;
    const result = parseDispositionConfigMap(makeCm({ data: { 'disposition.yaml': yaml } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/attentionBudget\.tokensPerDay/);
  });

  it('rejects an overlay missing mayProposeAgainst (mentions the field)', () => {
    const yaml = `
idleBehavior:
  readChannels: []
  attentionBudget:
    tokensPerDay: 50000
    pollIntervalSeconds: 300
  proposalScope:
    maxProposalsPerDay: 3
`;
    const result = parseDispositionConfigMap(makeCm({ data: { 'disposition.yaml': yaml } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/proposalScope\.mayProposeAgainst/);
  });

  it('rejects an overlay missing the agent-ref annotation', () => {
    const result = parseDispositionConfigMap(makeCm({ annotations: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/kagent\.knuteson\.io\/agent-ref/);
  });

  it('rejects an unknown ProposalKind in mayProposeAgainst', () => {
    const yaml = `
idleBehavior:
  readChannels: []
  attentionBudget:
    tokensPerDay: 50000
    pollIntervalSeconds: 300
  proposalScope:
    mayProposeAgainst:
      - unknown
    maxProposalsPerDay: 3
`;
    const result = parseDispositionConfigMap(makeCm({ data: { 'disposition.yaml': yaml } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/mayProposeAgainst\[0\]/);
    expect(result.error).toMatch(/unknown/);
  });

  it('fails closed (returns error; does NOT throw) on malformed YAML', () => {
    const malformed = ': : :\n  this is not valid yaml :::: [';
    let threw = false;
    let result;
    try {
      result = parseDispositionConfigMap(makeCm({ data: { 'disposition.yaml': malformed } }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
  });

  it('rejects an agent-ref that does not match <namespace>/<name>', () => {
    const result = parseDispositionConfigMap(
      makeCm({ annotations: { [DISPOSITION_AGENT_REF_ANNOTATION]: 'BAD_REF' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/<namespace>\/<name>/);
  });

  it('rejects a missing data["disposition.yaml"] key', () => {
    const result = parseDispositionConfigMap(makeCm({ data: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/disposition\.yaml/);
  });

  it('rejects a numeric tokensPerDay that is zero or negative', () => {
    const yaml = `
idleBehavior:
  readChannels: []
  attentionBudget:
    tokensPerDay: 0
    pollIntervalSeconds: 300
  proposalScope:
    mayProposeAgainst: []
    maxProposalsPerDay: 0
`;
    const result = parseDispositionConfigMap(makeCm({ data: { 'disposition.yaml': yaml } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/tokensPerDay/);
  });
});
