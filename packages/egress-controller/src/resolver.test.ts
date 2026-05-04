/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { applyResolvedEgress, resolveEffectiveEgress } from './resolver.js';
import type { AgentLike, TenantLike } from './types.js';

function agent(egress?: AgentLike['spec']['egress']): AgentLike {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'Agent',
    metadata: { name: 'a', namespace: 'ns', uid: 'uid-a' },
    spec: { ...(egress !== undefined && { egress }) },
  };
}

function tenant(allow?: readonly string[]): TenantLike {
  return {
    metadata: { name: 'acme' },
    spec: {
      name: 'acme',
      ...(allow !== undefined && { defaultEgress: { allow } }),
    },
  };
}

describe('resolveEffectiveEgress — precedence', () => {
  it('returns the Agent explicit egress when set, ignoring tenant default', () => {
    const e = resolveEffectiveEgress(agent({ cidrs: ['1.1.1.1/32'] }), tenant(['api.github.com']));
    expect(e?.cidrs).toEqual(['1.1.1.1/32']);
    expect(e?.domains).toBeUndefined();
  });

  it('preserves an explicit empty egress on the Agent', () => {
    const e = resolveEffectiveEgress(agent({}), tenant(['api.github.com']));
    expect(e).toEqual({});
  });

  it('falls back to tenant default when Agent has no egress', () => {
    const e = resolveEffectiveEgress(agent(), tenant(['api.github.com']));
    expect(e?.domains).toEqual(['api.github.com']);
  });

  it('routes tenant entries by `/` heuristic into domains vs cidrs', () => {
    const e = resolveEffectiveEgress(
      agent(),
      tenant(['api.github.com', '10.0.0.0/8', 'feeds.example.com', '1.2.3.4/32']),
    );
    expect(e?.domains).toEqual(['api.github.com', 'feeds.example.com']);
    expect(e?.cidrs).toEqual(['10.0.0.0/8', '1.2.3.4/32']);
  });

  it('returns undefined when both Agent + tenant lack egress', () => {
    expect(resolveEffectiveEgress(agent())).toBeUndefined();
    expect(resolveEffectiveEgress(agent(), tenant())).toBeUndefined();
    expect(resolveEffectiveEgress(agent(), tenant([]))).toBeUndefined();
  });

  it('skips empty strings in tenant allow', () => {
    const e = resolveEffectiveEgress(agent(), tenant(['', 'api.github.com']));
    expect(e?.domains).toEqual(['api.github.com']);
  });
});

describe('applyResolvedEgress', () => {
  it('returns the original Agent unchanged when no resolution applies', () => {
    const a = agent();
    expect(applyResolvedEgress(a)).toBe(a);
  });

  it('returns the original Agent unchanged when explicit egress is set', () => {
    const a = agent({ cidrs: ['1.1.1.1/32'] });
    const decorated = applyResolvedEgress(a, tenant(['api.github.com']));
    expect(decorated).toBe(a);
  });

  it('returns a decorated Agent with tenant default merged in', () => {
    const a = agent();
    const decorated = applyResolvedEgress(a, tenant(['api.github.com']));
    expect(decorated).not.toBe(a);
    expect(decorated.spec.egress?.domains).toEqual(['api.github.com']);
  });
});
