/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPair } from 'jose';

import {
  ACCEPTED_CAP_ALGS,
  buildCapabilityJwt,
  createLocalJWKSet,
  decodeCapabilityJwtUnsafe,
  exportJWK,
  verifyCapabilityJwt,
} from './jwt.js';
import type { JWK } from './jwt.js';
import { KAGENT_SUBSTRATE_AUDIENCE } from './types.js';

const ISSUER = 'kagent.knuteson.io/operator';

async function makeKeyAndJwks(
  alg: 'ES256' | 'RS256',
  kid?: string,
): Promise<{
  privateKey: CryptoKey | Uint8Array;
  publicKey: CryptoKey | Uint8Array;
  jwks: ReturnType<typeof createLocalJWKSet>;
  jwk: JWK;
}> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid ?? 'test-kid';
  jwk.alg = alg;
  jwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey, publicKey, jwks, jwk };
}

describe('buildCapabilityJwt + verifyCapabilityJwt round-trip (ES256)', () => {
  it('signs a bundle and verifies it', async () => {
    const { privateKey, publicKey } = await makeKeyAndJwks('ES256');
    const jwt = await buildCapabilityJwt({
      issuer: ISSUER,
      subjectTaskUid: 'abc123',
      jti: 'cap-abc123',
      claims: { tools: ['http_get'], spawn: ['summarizer-*'] },
    }).sign(privateKey);

    const result = await verifyCapabilityJwt({
      jwt,
      keyOrJwks: { kind: 'key', key: publicKey },
      expectedIssuer: ISSUER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.sub).toBe('task-uid:abc123');
      expect(result.bundle.jti).toBe('cap-abc123');
      expect(result.bundle.aud).toContain(KAGENT_SUBSTRATE_AUDIENCE);
      expect(result.bundle.claims.tools).toEqual(['http_get']);
    }
  });

  it('verifies via JWKS resolver (rotation path)', async () => {
    // The JWKS path uses kid to find the right key — set the JWK's kid
    // to match the JWT's jti (which buildCapabilityJwt stamps as kid).
    const { privateKey, jwks } = await makeKeyAndJwks('ES256', 'cap-rot');
    const jwt = await buildCapabilityJwt({
      issuer: ISSUER,
      subjectTaskUid: 'rotated',
      jti: 'cap-rot',
      claims: {},
    }).sign(privateKey);
    const result = await verifyCapabilityJwt({
      jwt,
      keyOrJwks: { kind: 'jwks', jwks },
      expectedIssuer: ISSUER,
    });
    expect(result.ok).toBe(true);
  });

  it('rotation simulated: second JWKS key admits a freshly-signed JWT', async () => {
    // Old key signs the historical bundle; we then ADD a new key to the
    // JWKS and confirm a NEW bundle signed by the new key verifies.
    const old = await makeKeyAndJwks('ES256', 'cap-old');
    const fresh = await makeKeyAndJwks('ES256', 'cap-new');

    // JWKS now carries BOTH keys.
    const merged = createLocalJWKSet({ keys: [old.jwk, fresh.jwk] });

    // Old JWT still verifies.
    const oldJwt = await buildCapabilityJwt({
      issuer: ISSUER,
      subjectTaskUid: 'old',
      jti: 'cap-old',
      claims: {},
    }).sign(old.privateKey);
    const oldResult = await verifyCapabilityJwt({
      jwt: oldJwt,
      keyOrJwks: { kind: 'jwks', jwks: merged },
      expectedIssuer: ISSUER,
    });
    expect(oldResult.ok).toBe(true);

    // New JWT signed by the new key also verifies.
    const newJwt = await buildCapabilityJwt({
      issuer: ISSUER,
      subjectTaskUid: 'new',
      jti: 'cap-new',
      claims: {},
    }).sign(fresh.privateKey);
    const newResult = await verifyCapabilityJwt({
      jwt: newJwt,
      keyOrJwks: { kind: 'jwks', jwks: merged },
      expectedIssuer: ISSUER,
    });
    expect(newResult.ok).toBe(true);
  });

  it('rejects on issuer mismatch', async () => {
    const { privateKey, publicKey } = await makeKeyAndJwks('ES256');
    const jwt = await buildCapabilityJwt({
      issuer: 'other',
      subjectTaskUid: 'x',
      jti: 'cap-x',
      claims: {},
    }).sign(privateKey);
    const r = await verifyCapabilityJwt({
      jwt,
      keyOrJwks: { kind: 'key', key: publicKey },
      expectedIssuer: ISSUER,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects on tampered claims', async () => {
    const { privateKey, publicKey } = await makeKeyAndJwks('ES256');
    const jwt = await buildCapabilityJwt({
      issuer: ISSUER,
      subjectTaskUid: 'x',
      jti: 'cap-x',
      claims: { tools: ['http_get'] },
    }).sign(privateKey);
    // Tamper: flip a character in the body segment.
    const parts = jwt.split('.');
    expect(parts.length).toBe(3);
    const tamperedBody = (parts[1] ?? '').replace(/[A-Za-z]$/, (c) => (c === 'a' ? 'b' : 'a'));
    const tampered = `${parts[0] ?? ''}.${tamperedBody}.${parts[2] ?? ''}`;
    const r = await verifyCapabilityJwt({
      jwt: tampered,
      keyOrJwks: { kind: 'key', key: publicKey },
      expectedIssuer: ISSUER,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects when expired', async () => {
    const { privateKey, publicKey } = await makeKeyAndJwks('ES256');
    const past = () => 1_000_000_000_000; // year 2001 ms
    const jwt = await buildCapabilityJwt({
      issuer: ISSUER,
      subjectTaskUid: 'x',
      jti: 'cap-x',
      claims: {},
      ttlSeconds: 60,
      now: past,
    }).sign(privateKey);
    const r = await verifyCapabilityJwt({
      jwt,
      keyOrJwks: { kind: 'key', key: publicKey },
      expectedIssuer: ISSUER,
      // verify clock at year 2030
      now: () => 1_900_000_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expired|exp/i);
  });
});

describe('verifyCapabilityJwt with RS256', () => {
  it('admits an RS256-signed bundle', async () => {
    const { privateKey, publicKey } = await makeKeyAndJwks('RS256');
    const jwt = await buildCapabilityJwt({
      issuer: ISSUER,
      subjectTaskUid: 'rsa-1',
      jti: 'cap-rsa',
      claims: {},
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'cap-rsa' })
      .sign(privateKey);
    const r = await verifyCapabilityJwt({
      jwt,
      keyOrJwks: { kind: 'key', key: publicKey },
      expectedIssuer: ISSUER,
    });
    expect(r.ok).toBe(true);
  });
});

describe('ACCEPTED_CAP_ALGS', () => {
  it('does not include HS256 or none', () => {
    const list = [...ACCEPTED_CAP_ALGS];
    expect(list).not.toContain('HS256');
    expect(list).not.toContain('none');
    expect(list).toEqual(['ES256', 'RS256']);
  });
});

describe('decodeCapabilityJwtUnsafe', () => {
  it('decodes a valid JWT payload without verifying', async () => {
    const { privateKey } = await makeKeyAndJwks('ES256');
    const jwt = await buildCapabilityJwt({
      issuer: ISSUER,
      subjectTaskUid: 'd1',
      jti: 'cap-d1',
      claims: { tools: ['http_get'] },
    }).sign(privateKey);
    const decoded = decodeCapabilityJwtUnsafe(jwt);
    expect(decoded?.jti).toBe('cap-d1');
    expect(decoded?.claims.tools).toEqual(['http_get']);
  });

  it('returns undefined on malformed input', () => {
    expect(decodeCapabilityJwtUnsafe('not.a.jwt')).toBeUndefined();
    expect(decodeCapabilityJwtUnsafe('only-one-part')).toBeUndefined();
  });
});
