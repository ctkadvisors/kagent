/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { claimsAreSubsetOf, claimsSubsetViolations, formatViolations } from './subset.js';
import type { CapabilityClaims } from './types.js';

const FULL_PARENT: CapabilityClaims = {
  tools: ['*'],
  models: ['*'],
  spawn: ['summarizer-*', 'validator'],
  read: ['cas://*', 'workspace:*'],
  write: ['cas://', 'workspace:seekarc-*'],
  egress: ['api.github.com', '*.googleapis.com'],
  tenant: 'acme',
  publish: ['kagent.events.*'],
  subscribe: ['kagent.events.*'],
};

describe('claimsSubsetViolations', () => {
  it('admits an empty child against any parent', () => {
    const v = claimsSubsetViolations({}, FULL_PARENT);
    expect(v).toEqual([]);
  });

  it('admits a child with strictly narrower claims', () => {
    const child: CapabilityClaims = {
      tools: ['http_get'],
      models: ['gpt-4o'],
      spawn: ['summarizer-1'],
      read: ['cas://sha256:abc'],
      write: ['workspace:seekarc-pr-1234'],
      egress: ['api.github.com'],
      tenant: 'acme',
    };
    const v = claimsSubsetViolations(child, FULL_PARENT);
    expect(v).toEqual([]);
  });

  it('rejects when child broadens spawn beyond parent', () => {
    const child: CapabilityClaims = { spawn: ['evil-agent'] };
    const v = claimsSubsetViolations(child, FULL_PARENT);
    expect(v.length).toBe(1);
    expect(v[0]?.category).toBe('spawn');
  });

  it('reports multiple violations across categories', () => {
    const child: CapabilityClaims = {
      spawn: ['evil'],
      egress: ['evil.com'],
    };
    const v = claimsSubsetViolations(child, FULL_PARENT);
    expect(v.length).toBe(2);
    const cats = v.map((x) => x.category).sort();
    expect(cats).toEqual(['egress', 'spawn']);
  });

  it('rejects when child requests a tenant the parent lacks', () => {
    const v = claimsSubsetViolations({ tenant: 'acme' }, {});
    expect(v.length).toBe(1);
    expect(v[0]?.category).toBe('tenant');
  });

  it('rejects when child requests a different tenant than parent', () => {
    const v = claimsSubsetViolations({ tenant: 'evil' }, { tenant: 'acme' });
    expect(v.length).toBe(1);
    expect(v[0]?.category).toBe('tenant');
    expect(v[0]?.detail).toContain('does not match');
  });

  it('admits child without tenant under tenant parent (drops authority)', () => {
    const v = claimsSubsetViolations({}, { tenant: 'acme' });
    expect(v).toEqual([]);
  });

  it('rejects when child names a category parent has nothing in', () => {
    const v = claimsSubsetViolations({ models: ['gpt-4o'] }, {});
    expect(v.length).toBe(1);
    expect(v[0]?.category).toBe('models');
  });

  /* v0.4.1-blackboard — Wave 3 Blackboard sub-team. */
  it('admits a narrower blackboard claim', () => {
    const parent: CapabilityClaims = {
      blackboard: { read: ['*'], write: ['mine.*'] },
    };
    const child: CapabilityClaims = {
      blackboard: { read: ['findings.*'], write: ['mine.42'] },
    };
    expect(claimsSubsetViolations(child, parent)).toEqual([]);
  });

  it('rejects a child that broadens blackboard.read', () => {
    const parent: CapabilityClaims = {
      blackboard: { read: ['findings.*'] },
    };
    const child: CapabilityClaims = {
      blackboard: { read: ['*'] },
    };
    const v = claimsSubsetViolations(child, parent);
    expect(v.length).toBe(1);
    expect(v[0]?.category).toBe('blackboard.read');
  });

  it('rejects a child that broadens blackboard.write when parent has none', () => {
    const child: CapabilityClaims = {
      blackboard: { write: ['anything'] },
    };
    const v = claimsSubsetViolations(child, {});
    expect(v.length).toBe(1);
    expect(v[0]?.category).toBe('blackboard.write');
  });
});

describe('claimsAreSubsetOf', () => {
  it('mirrors the violations check as a boolean', () => {
    expect(claimsAreSubsetOf({ spawn: ['summarizer-1'] }, FULL_PARENT)).toBe(true);
    expect(claimsAreSubsetOf({ spawn: ['evil'] }, FULL_PARENT)).toBe(false);
  });
});

describe('formatViolations', () => {
  it('formats an empty list as the empty string', () => {
    expect(formatViolations([])).toBe('');
  });

  it('formats a single violation', () => {
    const formatted = formatViolations([{ category: 'spawn', detail: 'foo' }]);
    expect(formatted).toBe('[spawn] foo');
  });

  it('joins multiple violations with semicolons', () => {
    const formatted = formatViolations([
      { category: 'spawn', detail: 'a' },
      { category: 'egress', detail: 'b' },
    ]);
    expect(formatted).toContain('[spawn] a');
    expect(formatted).toContain('[egress] b');
    expect(formatted).toContain(';');
  });
});
