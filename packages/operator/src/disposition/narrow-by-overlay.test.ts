/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Unit tests for `narrowByDispositionOverlay` — the pure narrowing
 * function at the heart of DISP-02. Tests cover the
 * narrows-never-widens monotonicity invariant, exhaustive proposal-kind
 * coverage, input immutability, and rejection metadata fidelity.
 */

import { describe, expect, it } from 'vitest';

import type { CapabilityClaims } from '@kagent/capability-types';

import type { DispositionOverlay } from './overlay-loader.js';
import { narrowByDispositionOverlay, type ProposalRejection } from './narrow-by-overlay.js';
import type { ProposalKind } from './proposal-tool-map.js';

function makeOverlay(mayProposeAgainst: readonly ProposalKind[]): DispositionOverlay {
  return {
    agentRef: 'kagent-system/researcher-01',
    agentNamespace: 'kagent-system',
    agentName: 'researcher-01',
    configMapName: 'researcher-01-disposition',
    configMapNamespace: 'kagent-system',
    idleBehavior: {
      readChannels: [],
      attentionBudget: { tokensPerDay: 50000, pollIntervalSeconds: 300 },
      proposalScope: { mayProposeAgainst, maxProposalsPerDay: 3 },
    },
  };
}

describe('narrowByDispositionOverlay', () => {
  it('Test 1 — narrowing happens: keeps allowed proposal tools + non-proposal tools, removes the rest', () => {
    const claims: CapabilityClaims = {
      tools: ['write_artifact', 'verifier_register', 'capability_policy_propose', 'http_get'],
    };
    const overlay = makeOverlay(['templates']);
    const result = narrowByDispositionOverlay(claims, overlay);
    expect(result.narrowed.tools).toEqual(['write_artifact', 'http_get']);
    expect(result.rejections).toHaveLength(2);
    expect(result.rejections.map((r) => r.tool)).toEqual([
      'verifier_register',
      'capability_policy_propose',
    ]);
    expect(result.rejections.map((r) => r.kind)).toEqual(['verifiers', 'capability-policy']);
  });

  it('Test 2 — narrowing never widens (empty cap stays empty even when overlay allows everything)', () => {
    const claims: CapabilityClaims = { tools: [] };
    const overlay = makeOverlay(['templates', 'verifiers', 'capability-policy']);
    const result = narrowByDispositionOverlay(claims, overlay);
    expect(result.narrowed.tools).toEqual([]);
    expect(result.rejections).toHaveLength(0);
  });

  it('Test 3 — non-proposal tools are untouched even when mayProposeAgainst is empty', () => {
    const claims: CapabilityClaims = {
      tools: ['http_get', 'read_artifact', 'spawn_child_task'],
    };
    const overlay = makeOverlay([]);
    const result = narrowByDispositionOverlay(claims, overlay);
    expect(result.narrowed.tools).toEqual(['http_get', 'read_artifact', 'spawn_child_task']);
    expect(result.rejections).toHaveLength(0);
  });

  it('Test 4 — empty mayProposeAgainst removes ALL proposal-category tools', () => {
    const claims: CapabilityClaims = {
      tools: ['write_artifact', 'verifier_register', 'capability_policy_propose', 'http_get'],
    };
    const overlay = makeOverlay([]);
    const result = narrowByDispositionOverlay(claims, overlay);
    expect(result.narrowed.tools).toEqual(['http_get']);
    expect(result.rejections).toHaveLength(3);
    const kinds = result.rejections.map((r) => r.kind).sort();
    expect(kinds).toEqual(['capability-policy', 'templates', 'verifiers']);
  });

  it('Test 5 — full mayProposeAgainst keeps all proposal tools verbatim', () => {
    const claims: CapabilityClaims = {
      tools: ['write_artifact', 'verifier_register', 'capability_policy_propose'],
    };
    const overlay = makeOverlay(['templates', 'verifiers', 'capability-policy']);
    const result = narrowByDispositionOverlay(claims, overlay);
    expect(result.narrowed.tools).toEqual([
      'write_artifact',
      'verifier_register',
      'capability_policy_propose',
    ]);
    expect(result.rejections).toHaveLength(0);
  });

  it('Test 6 — null overlay passes claims through unchanged (revocation path)', () => {
    const claims: CapabilityClaims = { tools: ['write_artifact'] };
    const result = narrowByDispositionOverlay(claims, null);
    expect(result.narrowed).toEqual(claims);
    expect(result.rejections).toHaveLength(0);
  });

  it('Test 7 — undefined claims.tools stays undefined (do not invent an empty array)', () => {
    const claims: CapabilityClaims = { spawn: ['some-agent'] };
    const overlay = makeOverlay(['templates']);
    const result = narrowByDispositionOverlay(claims, overlay);
    expect(result.narrowed.tools).toBeUndefined();
    expect(result.narrowed.spawn).toEqual(['some-agent']);
    expect(result.rejections).toHaveLength(0);
  });

  it('Test 8 — other claim categories pass through unchanged; only tools is narrowed', () => {
    const claims: CapabilityClaims = {
      tools: ['write_artifact', 'verifier_register'],
      models: ['workers-ai/test'],
      spawn: ['summarizer-*'],
      read: ['read-1'],
      write: ['write-1'],
      egress: ['https://example.com'],
      tenant: 'acme',
    };
    const overlay = makeOverlay(['templates']);
    const result = narrowByDispositionOverlay(claims, overlay);
    expect(result.narrowed.tools).toEqual(['write_artifact']);
    expect(result.narrowed.models).toEqual(['workers-ai/test']);
    expect(result.narrowed.spawn).toEqual(['summarizer-*']);
    expect(result.narrowed.read).toEqual(['read-1']);
    expect(result.narrowed.write).toEqual(['write-1']);
    expect(result.narrowed.egress).toEqual(['https://example.com']);
    expect(result.narrowed.tenant).toBe('acme');
  });

  it('Test 9 — rejection metadata is fully populated from the overlay', () => {
    const claims: CapabilityClaims = { tools: ['verifier_register'] };
    const overlay = makeOverlay(['templates']);
    const result = narrowByDispositionOverlay(claims, overlay);
    expect(result.rejections).toHaveLength(1);
    const rejection: ProposalRejection = result.rejections[0]!;
    expect(rejection.tool).toBe('verifier_register');
    expect(rejection.kind).toBe('verifiers');
    expect(rejection.agentRef).toBe('kagent-system/researcher-01');
    expect(rejection.agentNamespace).toBe('kagent-system');
    expect(rejection.agentName).toBe('researcher-01');
    expect(rejection.dispositionConfigMapName).toBe('researcher-01-disposition');
    expect(rejection.dispositionConfigMapNamespace).toBe('kagent-system');
    expect(rejection.mayProposeAgainst).toEqual(['templates']);
    expect(rejection.reason).toBe('not_in_mayProposeAgainst');
  });

  it('Test 10 — input claims object is NOT mutated (immutability invariant)', () => {
    const inputTools = ['write_artifact', 'verifier_register', 'http_get'];
    const claims: CapabilityClaims = { tools: inputTools };
    const snapshot = { tools: [...inputTools] };
    const overlay = makeOverlay(['templates']);
    const result = narrowByDispositionOverlay(claims, overlay);
    // Input must be untouched.
    expect(claims.tools).toEqual(snapshot.tools);
    expect(claims.tools).toBe(inputTools); // identity preserved on input
    // Result must be a fresh object.
    expect(result.narrowed).not.toBe(claims);
    expect(result.narrowed.tools).not.toBe(claims.tools);
  });

  it('Test 11 — duplicate tools each produce one rejection (observability surfaces the duplicate)', () => {
    const claims: CapabilityClaims = { tools: ['write_artifact', 'write_artifact'] };
    const overlay = makeOverlay([]);
    const result = narrowByDispositionOverlay(claims, overlay);
    expect(result.narrowed.tools).toEqual([]);
    expect(result.rejections).toHaveLength(2);
    expect(result.rejections.every((r) => r.tool === 'write_artifact')).toBe(true);
    expect(result.rejections.every((r) => r.kind === 'templates')).toBe(true);
  });
});
