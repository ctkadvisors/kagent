/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { DEPRECATED_ANNOTATION, REMOVED_AT_ANNOTATION } from './constants.js';
import { evaluateLifecycle, lifecycleSweepTickMs } from './lifecycle.js';
import type { VersionedAgent } from './types.js';

function agentWith(annotations: Record<string, string>): VersionedAgent {
  return {
    metadata: { name: 'a', namespace: 'default', annotations },
    spec: { model: 'test/model', version: '1.0.0' },
  };
}

const NOW = Date.parse('2026-05-04T00:00:00Z');

describe('lifecycleSweepTickMs', () => {
  it('defaults to 1 hour', () => {
    expect(lifecycleSweepTickMs).toBe(60 * 60 * 1000);
  });
});

describe('evaluateLifecycle', () => {
  it('returns active when no annotations are set', () => {
    const e = evaluateLifecycle(agentWith({}), NOW);
    expect(e.status).toBe('active');
    expect(e.message).toBe('');
  });

  it('returns deprecated when deprecated=true and removed-at absent', () => {
    const e = evaluateLifecycle(agentWith({ [DEPRECATED_ANNOTATION]: 'true' }), NOW);
    expect(e.status).toBe('deprecated');
    expect(e.message).toContain('agent.deprecated_used');
  });

  it('returns deprecated when deprecated=true and removed-at in future', () => {
    const future = new Date(NOW + 24 * 3600 * 1000).toISOString();
    const e = evaluateLifecycle(
      agentWith({ [DEPRECATED_ANNOTATION]: 'true', [REMOVED_AT_ANNOTATION]: future }),
      NOW,
    );
    expect(e.status).toBe('deprecated');
    expect(e.removedAtMs).toBe(Date.parse(future));
  });

  it('returns removed when removed-at <= now (regardless of deprecated)', () => {
    const past = new Date(NOW - 1).toISOString();
    const e = evaluateLifecycle(agentWith({ [REMOVED_AT_ANNOTATION]: past }), NOW);
    expect(e.status).toBe('removed');
    expect(e.message).toContain('policy_denied:agent_removed');
    expect(e.removedAtMs).toBe(Date.parse(past));
  });

  it('removed-at == now is the boundary (treated as removed)', () => {
    const exact = new Date(NOW).toISOString();
    const e = evaluateLifecycle(agentWith({ [REMOVED_AT_ANNOTATION]: exact }), NOW);
    expect(e.status).toBe('removed');
  });

  it('returns active when removed-at is unparseable', () => {
    const e = evaluateLifecycle(agentWith({ [REMOVED_AT_ANNOTATION]: 'not-a-date' }), NOW);
    expect(e.status).toBe('active');
    expect(e.removedAtMs).toBeUndefined();
  });

  it('treats deprecated="true" case-insensitively', () => {
    const e = evaluateLifecycle(agentWith({ [DEPRECATED_ANNOTATION]: 'TRUE' }), NOW);
    expect(e.status).toBe('deprecated');
  });

  it('does NOT treat deprecated=anything-else as deprecated', () => {
    const e = evaluateLifecycle(agentWith({ [DEPRECATED_ANNOTATION]: 'yes' }), NOW);
    expect(e.status).toBe('active');
  });

  it('removed beats deprecated when both fire', () => {
    const past = new Date(NOW - 1).toISOString();
    const e = evaluateLifecycle(
      agentWith({ [DEPRECATED_ANNOTATION]: 'true', [REMOVED_AT_ANNOTATION]: past }),
      NOW,
    );
    expect(e.status).toBe('removed');
  });

  it('uses Date.now when no clock is passed', () => {
    // Just verify the function accepts the default and doesn't throw.
    const e = evaluateLifecycle(agentWith({}));
    expect(e.status).toBe('active');
  });
});
