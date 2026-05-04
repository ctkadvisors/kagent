/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  bundleTimeError,
  validateCapabilityBundle,
  validateCapabilityClaims,
  validValue,
} from './validate.js';
import { KAGENT_SUBSTRATE_AUDIENCE } from './types.js';

describe('validateCapabilityClaims', () => {
  it('admits a fully populated claims object', () => {
    const r = validateCapabilityClaims({
      tools: ['http_get', 'spawn_child_task'],
      models: ['gpt-4o'],
      spawn: ['summarizer-*'],
      read: ['cas://*'],
      write: ['cas://'],
      egress: ['api.github.com'],
      tenant: 'acme',
      publish: ['kagent.events.research'],
      subscribe: ['kagent.events.priorities'],
    });
    expect(r.ok).toBe(true);
    expect(validValue(r)?.tools).toEqual(['http_get', 'spawn_child_task']);
    expect(validValue(r)?.tenant).toBe('acme');
  });

  it('admits an empty object (no claims = no authority)', () => {
    const r = validateCapabilityClaims({});
    expect(r.ok).toBe(true);
    expect(validValue(r)).toEqual({});
  });

  it('rejects non-object', () => {
    expect(validateCapabilityClaims(null).ok).toBe(false);
    expect(validateCapabilityClaims(42).ok).toBe(false);
    expect(validateCapabilityClaims('string').ok).toBe(false);
    expect(validateCapabilityClaims([]).ok).toBe(false);
  });

  it('rejects unknown keys', () => {
    const r = validateCapabilityClaims({ rogue: ['x'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown key');
  });

  it('rejects non-string entries in array categories', () => {
    expect(validateCapabilityClaims({ tools: [42] }).ok).toBe(false);
    expect(validateCapabilityClaims({ tools: [''] }).ok).toBe(false);
    expect(validateCapabilityClaims({ tools: [null] }).ok).toBe(false);
  });

  it('rejects non-array values for array categories', () => {
    expect(validateCapabilityClaims({ tools: 'http_get' }).ok).toBe(false);
    expect(validateCapabilityClaims({ tools: { 0: 'x' } }).ok).toBe(false);
  });

  it('rejects empty / non-string tenant', () => {
    expect(validateCapabilityClaims({ tenant: '' }).ok).toBe(false);
    expect(validateCapabilityClaims({ tenant: 42 }).ok).toBe(false);
  });

  /* v0.4.1-blackboard — Wave 3 Blackboard sub-team. */
  it('admits a fully populated blackboard claim', () => {
    const r = validateCapabilityClaims({
      blackboard: { read: ['findings.*'], write: ['my-task:*'] },
    });
    expect(r.ok).toBe(true);
    expect(validValue(r)?.blackboard).toEqual({
      read: ['findings.*'],
      write: ['my-task:*'],
    });
  });

  it('admits a blackboard claim with only one of read/write', () => {
    const r = validateCapabilityClaims({ blackboard: { read: ['*'] } });
    expect(r.ok).toBe(true);
    expect(validValue(r)?.blackboard).toEqual({ read: ['*'] });
  });

  it('rejects blackboard with unknown sub-key', () => {
    const r = validateCapabilityClaims({ blackboard: { rogue: ['x'] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown key');
  });

  it('rejects blackboard array entries that are not non-empty strings', () => {
    expect(validateCapabilityClaims({ blackboard: { read: [42] } }).ok).toBe(false);
    expect(validateCapabilityClaims({ blackboard: { write: [''] } }).ok).toBe(false);
    expect(validateCapabilityClaims({ blackboard: { read: 'foo' } }).ok).toBe(false);
  });

  it('rejects blackboard that is not an object', () => {
    expect(validateCapabilityClaims({ blackboard: ['x'] }).ok).toBe(false);
    expect(validateCapabilityClaims({ blackboard: 'x' }).ok).toBe(false);
  });
});

describe('validateCapabilityBundle', () => {
  const baseBundle = {
    iss: 'kagent.knuteson.io/operator',
    sub: 'task-uid:abc123',
    aud: [KAGENT_SUBSTRATE_AUDIENCE],
    exp: 9_999_999_999, // far future
    iat: 1_000_000_000,
    jti: 'cap-abc123',
    claims: {
      tools: ['http_get'],
    },
  };

  it('admits a well-formed bundle', () => {
    const r = validateCapabilityBundle(baseBundle);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.jti).toBe('cap-abc123');
      expect(r.value.aud).toContain(KAGENT_SUBSTRATE_AUDIENCE);
      expect(r.value.claims.tools).toEqual(['http_get']);
    }
  });

  it('rejects when iss is missing', () => {
    const r = validateCapabilityBundle({ ...baseBundle, iss: undefined });
    expect(r.ok).toBe(false);
  });

  it('rejects when jti is missing', () => {
    const r = validateCapabilityBundle({ ...baseBundle, jti: undefined });
    expect(r.ok).toBe(false);
  });

  it('rejects when sub is missing', () => {
    const r = validateCapabilityBundle({ ...baseBundle, sub: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects when exp is missing or non-number', () => {
    expect(validateCapabilityBundle({ ...baseBundle, exp: undefined }).ok).toBe(false);
    expect(validateCapabilityBundle({ ...baseBundle, exp: 'soon' }).ok).toBe(false);
  });

  it('rejects when aud lacks the substrate audience', () => {
    const r = validateCapabilityBundle({ ...baseBundle, aud: ['some-other-audience'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('aud must include');
  });

  it('rejects when aud is empty / non-array', () => {
    expect(validateCapabilityBundle({ ...baseBundle, aud: [] }).ok).toBe(false);
    expect(validateCapabilityBundle({ ...baseBundle, aud: 'kagent-substrate' }).ok).toBe(false);
  });

  it('rejects when claims sub-object is malformed', () => {
    const r = validateCapabilityBundle({ ...baseBundle, claims: { rogue: ['x'] } });
    expect(r.ok).toBe(false);
  });

  it('admits multiple audiences (substrate + tenant scope)', () => {
    const r = validateCapabilityBundle({
      ...baseBundle,
      aud: [KAGENT_SUBSTRATE_AUDIENCE, 'tenant:acme'],
    });
    expect(r.ok).toBe(true);
  });

  it('admits when iat / nbf are absent (recommended but not required)', () => {
    const minimal = {
      iss: 'k',
      sub: 's',
      aud: [KAGENT_SUBSTRATE_AUDIENCE],
      exp: 9_999_999_999,
      jti: 'j',
      claims: {},
    };
    expect(validateCapabilityBundle(minimal).ok).toBe(true);
  });
});

describe('bundleTimeError', () => {
  const bundle = {
    iss: 'k',
    sub: 's',
    aud: [KAGENT_SUBSTRATE_AUDIENCE],
    exp: 1_000,
    nbf: 500,
    jti: 'j',
    claims: {},
  };

  it('returns null when within validity window', () => {
    expect(bundleTimeError(bundle, 750)).toBeNull();
  });

  it('returns expired error when past exp', () => {
    const e = bundleTimeError(bundle, 1_001);
    expect(e).not.toBeNull();
    expect(e).toContain('expired');
  });

  it('returns not-yet-valid error when before nbf', () => {
    const e = bundleTimeError(bundle, 100);
    expect(e).not.toBeNull();
    expect(e).toContain('not yet valid');
  });

  it('treats exp == now as expired (≤ semantics)', () => {
    expect(bundleTimeError(bundle, 1_000)).not.toBeNull();
  });
});
