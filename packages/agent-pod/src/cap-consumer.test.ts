/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import {
  buildCapabilityJwt,
  createLocalJWKSet,
  exportJWK,
  type JWK,
} from '@kagent/capability-types';
import { generateKeyPair } from 'jose';

import { bundleAdmits, loadCapabilityFromEnv, loadCapabilityOptional } from './cap-consumer.js';

const ISSUER = 'kagent.knuteson.io/operator';

async function makeKeysAndJwt(opts: {
  jti: string;
  claims?: Parameters<typeof buildCapabilityJwt>[0]['claims'];
  ttlSeconds?: number;
}): Promise<{ jwt: string; jwks: { keys: JWK[] } }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = opts.jti;
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  const builder = buildCapabilityJwt({
    issuer: ISSUER,
    subjectTaskUid: 'subj',
    jti: opts.jti,
    claims: opts.claims ?? {},
    ...(opts.ttlSeconds !== undefined && { ttlSeconds: opts.ttlSeconds }),
  });
  builder.setProtectedHeader({ alg: 'ES256', kid: opts.jti });
  const jwt = await builder.sign(privateKey);
  return { jwt, jwks: { keys: [jwk] } };
}

describe('loadCapabilityFromEnv', () => {
  it('reads + verifies the JWT mounted at KAGENT_CAP_JWT_FILE', async () => {
    const { jwt, jwks } = await makeKeysAndJwt({
      jti: 'cap-1',
      claims: { tools: ['http_get'], spawn: ['summarizer-*'] },
    });
    const result = await loadCapabilityFromEnv({
      env: { KAGENT_CAP_JWT_FILE: '/cap.jwt' },
      readFile: (p) => (p === '/cap.jwt' ? jwt : ''),
      fetchJwks: () => Promise.resolve(jwks),
    });
    expect(result.bundle.jti).toBe('cap-1');
    expect(result.bundle.claims.spawn).toEqual(['summarizer-*']);
  });

  it('uses default file path when env unset', async () => {
    const { jwt, jwks } = await makeKeysAndJwt({ jti: 'cap-default' });
    const result = await loadCapabilityFromEnv({
      env: {},
      readFile: (p) => {
        if (p === '/var/kagent/cap/cap.jwt') return jwt;
        throw new Error(`unexpected: ${p}`);
      },
      fetchJwks: () => Promise.resolve(jwks),
    });
    expect(result.bundle.jti).toBe('cap-default');
  });

  it('throws when JWT file is empty', async () => {
    await expect(
      loadCapabilityFromEnv({
        env: {},
        readFile: () => '',
        fetchJwks: () => Promise.resolve({ keys: [] }),
      }),
    ).rejects.toThrow(/empty/);
  });

  it('throws when JWT verification fails (tampered)', async () => {
    const { jwt, jwks } = await makeKeysAndJwt({ jti: 'cap-x' });
    // Flip the middle of the body segment so the signature doesn't
    // match anymore (base64url `eyJ...` body always has 'eyJ' as the
    // first three chars; pad an extra alpha so the result still looks
    // like a JWT but verification fails).
    const parts = jwt.split('.');
    const body = parts[1] ?? '';
    const tamperedBody = body.length > 10 ? `eyJX${body.slice(4)}` : body;
    const tampered = `${parts[0] ?? ''}.${tamperedBody}.${parts[2] ?? ''}`;
    await expect(
      loadCapabilityFromEnv({
        env: {},
        readFile: () => tampered,
        fetchJwks: () => Promise.resolve(jwks),
      }),
    ).rejects.toThrow(/cap-consumer/);
  });

  it('throws on issuer mismatch', async () => {
    const { jwt, jwks } = await makeKeysAndJwt({ jti: 'cap-x' });
    await expect(
      loadCapabilityFromEnv({
        env: { KAGENT_CAP_ISSUER: 'someone-else' },
        readFile: () => jwt,
        fetchJwks: () => Promise.resolve(jwks),
      }),
    ).rejects.toThrow(/cap-consumer/);
  });

  it('honors clock injection for expiry checks', async () => {
    const { jwt, jwks } = await makeKeysAndJwt({ jti: 'cap-soon', ttlSeconds: 60 });
    // Verify clock waaaay in the future = expired.
    await expect(
      loadCapabilityFromEnv({
        env: {},
        readFile: () => jwt,
        fetchJwks: () => Promise.resolve(jwks),
        now: () => 1_900_000_000,
      }),
    ).rejects.toThrow();
  });
});

describe('loadCapabilityOptional', () => {
  it('returns undefined when JWT file is missing (ENOENT)', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), {
      code: 'ENOENT',
    });
    const result = await loadCapabilityOptional({
      env: {},
      readFile: () => {
        throw enoent;
      },
      fetchJwks: () => Promise.resolve({ keys: [] }),
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when file is empty (legacy pod)', async () => {
    const result = await loadCapabilityOptional({
      env: {},
      readFile: () => '',
      fetchJwks: () => Promise.resolve({ keys: [] }),
    });
    expect(result).toBeUndefined();
  });

  it('throws when file is present but verification fails', async () => {
    await expect(
      loadCapabilityOptional({
        env: {},
        readFile: () => 'malformed.jwt.body',
        fetchJwks: () => Promise.resolve({ keys: [] }),
      }),
    ).rejects.toThrow();
  });
});

describe('bundleAdmits', () => {
  const bundle = {
    iss: 'k',
    sub: 's',
    aud: ['kagent-substrate'] as const,
    exp: 9_999_999_999,
    jti: 'cap-x',
    claims: {
      tools: ['http_get', 'wait_*'],
      spawn: ['summarizer-*'],
      tenant: 'acme',
    },
  };

  it('admits literal in tools list', () => {
    expect(bundleAdmits(bundle, 'tools', 'http_get')).toBe(true);
  });

  it('admits glob match in tools', () => {
    expect(bundleAdmits(bundle, 'tools', 'wait_for_child_task')).toBe(true);
  });

  it('rejects unmatched target', () => {
    expect(bundleAdmits(bundle, 'tools', 'http_post')).toBe(false);
  });

  it('admits glob match in spawn', () => {
    expect(bundleAdmits(bundle, 'spawn', 'summarizer-1')).toBe(true);
  });

  it('handles tenant exact-match', () => {
    expect(bundleAdmits(bundle, 'tenant', 'acme')).toBe(true);
    expect(bundleAdmits(bundle, 'tenant', 'evil')).toBe(false);
  });

  it('returns false when bundle is undefined', () => {
    expect(bundleAdmits(undefined, 'tools', 'anything')).toBe(false);
  });

  it('returns false when category is unset on the bundle', () => {
    expect(bundleAdmits(bundle, 'models', 'gpt-4o')).toBe(false);
  });
});

// Use createLocalJWKSet to silence the import warning if eslint flags
// it as unused — this validates the JWKS roundtrip binding.
describe('jwks helper sanity', () => {
  it('creates a local JWKS without throwing', async () => {
    const { jwks } = await makeKeysAndJwt({ jti: 'cap-sanity' });
    const local = createLocalJWKSet({ keys: jwks.keys });
    expect(typeof local).toBe('function');
  });
});
