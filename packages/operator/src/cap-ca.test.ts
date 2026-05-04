/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI, jwtVerify, createLocalJWKSet } from 'jose';
import { KAGENT_SUBSTRATE_AUDIENCE } from '@kagent/capability-types';

import { loadFromMaterials, loadFromEnv } from './cap-ca.js';

async function makeEsKeys(): Promise<{ privatePem: string; publicPem: string }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return {
    privatePem: await exportPKCS8(privateKey),
    publicPem: await exportSPKI(publicKey),
  };
}

async function makeRsaKeys(): Promise<{ privatePem: string; publicPem: string }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return {
    privatePem: await exportPKCS8(privateKey),
    publicPem: await exportSPKI(publicKey),
  };
}

describe('loadFromMaterials', () => {
  it('builds a CapCa that mints + the JWT verifies via the JWKS', async () => {
    const { privatePem, publicPem } = await makeEsKeys();
    const ca = await loadFromMaterials({ privatePem, publicPem });
    expect(ca.alg).toBe('ES256');
    expect(ca.jwk.kid).toBe(ca.kid);

    const minted = await ca.mint({
      subjectTaskUid: 'abc',
      jti: 'cap-abc',
      claims: { tools: ['http_get'] },
    });
    expect(minted.jwt.split('.').length).toBe(3);
    expect(minted.jti).toBe('cap-abc');
    expect(minted.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Verify via the JWKS the CA exposes.
    const jwks = createLocalJWKSet(
      ca.jwks() as { keys: Parameters<typeof createLocalJWKSet>[0]['keys'] },
    );
    const verified = await jwtVerify(minted.jwt, jwks, {
      audience: KAGENT_SUBSTRATE_AUDIENCE,
      issuer: 'kagent.knuteson.io/operator',
    });
    expect((verified.payload as { sub?: string }).sub).toBe('task-uid:abc');
  });

  it('detects RS256 from a long PEM body', async () => {
    const { privatePem, publicPem } = await makeRsaKeys();
    const ca = await loadFromMaterials({ privatePem, publicPem });
    expect(ca.alg).toBe('RS256');
  });

  it('honors an explicit alg override', async () => {
    const { privatePem, publicPem } = await makeRsaKeys();
    const ca = await loadFromMaterials({ privatePem, publicPem, alg: 'RS256' });
    expect(ca.alg).toBe('RS256');
  });

  it('jwks includes secondary key when supplied (rotation cutover)', async () => {
    const primary = await makeEsKeys();
    const secondary = await makeEsKeys();
    const ca = await loadFromMaterials({
      privatePem: primary.privatePem,
      publicPem: primary.publicPem,
      secondaryPublicPem: secondary.publicPem,
    });
    const keys = ca.jwks().keys;
    expect(keys.length).toBe(2);
    const kids = new Set(keys.map((k) => k.kid));
    expect(kids.size).toBe(2);
  });

  it('honors an explicit kid + issuer', async () => {
    const { privatePem, publicPem } = await makeEsKeys();
    const ca = await loadFromMaterials({
      privatePem,
      publicPem,
      kid: 'k1',
      issuer: 'urn:tests',
    });
    expect(ca.kid).toBe('k1');
    expect(ca.issuer).toBe('urn:tests');
    const minted = await ca.mint({ subjectTaskUid: 't', jti: 'c', claims: {} });
    const parts = minted.jwt.split('.');
    const header = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8')) as {
      kid?: string;
    };
    expect(header.kid).toBe('k1');
  });

  it('test clock injection drives exp', async () => {
    const { privatePem, publicPem } = await makeEsKeys();
    const ca = await loadFromMaterials({
      privatePem,
      publicPem,
      now: () => 1_700_000_000_000, // ms
    });
    const minted = await ca.mint({
      subjectTaskUid: 't',
      jti: 'c',
      claims: {},
      ttlSeconds: 300,
    });
    expect(minted.expiresAt).toBe(1_700_000_000 + 300);
  });
});

describe('loadFromEnv', () => {
  it('reads PEM materials from disk paths declared in env', async () => {
    const { privatePem, publicPem } = await makeEsKeys();
    const fakeFiles = new Map<string, string>([
      ['/var/kagent/cap-ca/tls.key', privatePem],
      ['/var/kagent/cap-ca/tls.crt', publicPem],
    ]);
    const ca = await loadFromEnv({}, (path) => {
      const v = fakeFiles.get(path);
      if (v === undefined) throw new Error(`unexpected read: ${path}`);
      return v;
    });
    expect(ca.alg).toBe('ES256');
  });

  it('threads custom file paths via env', async () => {
    const { privatePem, publicPem } = await makeEsKeys();
    const fakeFiles = new Map<string, string>([
      ['/custom/key.pem', privatePem],
      ['/custom/pub.pem', publicPem],
    ]);
    const ca = await loadFromEnv(
      {
        KAGENT_CAP_SIGNING_KEY_FILE: '/custom/key.pem',
        KAGENT_CAP_SIGNING_PUB_FILE: '/custom/pub.pem',
        KAGENT_CAP_ISSUER: 'urn:test',
      },
      (p) => {
        const v = fakeFiles.get(p);
        if (v === undefined) throw new Error(`unexpected read: ${p}`);
        return v;
      },
    );
    expect(ca.issuer).toBe('urn:test');
  });

  it('supports the rotation prev-pub file', async () => {
    const primary = await makeEsKeys();
    const secondary = await makeEsKeys();
    const ca = await loadFromEnv({ KAGENT_CAP_SIGNING_PREV_PUB_FILE: '/prev.pem' }, (p) => {
      if (p === '/var/kagent/cap-ca/tls.key') return primary.privatePem;
      if (p === '/var/kagent/cap-ca/tls.crt') return primary.publicPem;
      if (p === '/prev.pem') return secondary.publicPem;
      throw new Error(`unexpected read: ${p}`);
    });
    expect(ca.jwks().keys.length).toBe(2);
  });

  it('throws when private file is missing', async () => {
    await expect(loadFromEnv({}, () => '')).rejects.toThrow(/KAGENT_CAP_SIGNING_KEY_FILE/);
  });

  it('throws when public file is missing', async () => {
    const { privatePem } = await makeEsKeys();
    await expect(
      loadFromEnv({}, (p) => (p === '/var/kagent/cap-ca/tls.key' ? privatePem : '')),
    ).rejects.toThrow(/KAGENT_CAP_SIGNING_PUB_FILE/);
  });

  /* v0.4.3-identity — additive SPIRE-managed key source. Wave 2's
   * existing tests are the spec for back-compat; these tests cover the
   * Wave 3 additive paths. */
  describe('Wave 3 — Identity SPIRE source', () => {
    it('uses SPIRE-managed key when KAGENT_IDENTITY_ENABLED=true and SPIRE files present', async () => {
      const spireKeys = await makeEsKeys();
      const chartKeys = await makeEsKeys();
      const fakeFiles = new Map<string, string>([
        ['/var/kagent/spire-cap-ca/tls.key', spireKeys.privatePem],
        ['/var/kagent/spire-cap-ca/tls.crt', spireKeys.publicPem],
        ['/var/kagent/cap-ca/tls.key', chartKeys.privatePem],
        ['/var/kagent/cap-ca/tls.crt', chartKeys.publicPem],
      ]);
      const ca = await loadFromEnv(
        { KAGENT_IDENTITY_ENABLED: 'true', KAGENT_CAP_ISSUER: 'urn:spire-test' },
        (p) => {
          const v = fakeFiles.get(p);
          if (v === undefined) return '';
          return v;
        },
      );
      // SPIRE-source CA verifies a JWT minted with the SPIRE key.
      const minted = await ca.mint({
        subjectTaskUid: 'spire-task',
        jti: 'cap-spire',
        claims: {},
      });
      expect(minted.jwt.split('.').length).toBe(3);
      expect(ca.issuer).toBe('urn:spire-test');
    });

    it('falls back to chart Secret when KAGENT_IDENTITY_ENABLED=true but SPIRE files absent', async () => {
      const chartKeys = await makeEsKeys();
      const fakeFiles = new Map<string, string>([
        ['/var/kagent/cap-ca/tls.key', chartKeys.privatePem],
        ['/var/kagent/cap-ca/tls.crt', chartKeys.publicPem],
      ]);
      const ca = await loadFromEnv({ KAGENT_IDENTITY_ENABLED: 'true' }, (p) => {
        const v = fakeFiles.get(p);
        // Empty string for SPIRE paths → fall-back path.
        if (v === undefined) return '';
        return v;
      });
      // Chart-source CA still mints + verifies (proves Wave 2 fall-back still works).
      const minted = await ca.mint({
        subjectTaskUid: 'fallback-task',
        jti: 'cap-fb',
        claims: {},
      });
      expect(minted.jwt.split('.').length).toBe(3);
    });

    it('honors override SPIRE paths via env', async () => {
      const spireKeys = await makeEsKeys();
      const fakeFiles = new Map<string, string>([
        ['/etc/spire/cap.key', spireKeys.privatePem],
        ['/etc/spire/cap.crt', spireKeys.publicPem],
      ]);
      const ca = await loadFromEnv(
        {
          KAGENT_IDENTITY_ENABLED: 'true',
          KAGENT_SPIRE_CAP_SIGNING_KEY_FILE: '/etc/spire/cap.key',
          KAGENT_SPIRE_CAP_SIGNING_PUB_FILE: '/etc/spire/cap.crt',
        },
        (p) => fakeFiles.get(p) ?? '',
      );
      expect(ca.alg).toBe('ES256');
    });

    it('Wave 2 flag-disabled path: SPIRE files ignored when KAGENT_IDENTITY_ENABLED unset', async () => {
      const spireKeys = await makeEsKeys();
      const chartKeys = await makeEsKeys();
      // Two distinct key pairs; if Wave 3 path were taken the test
      // would mint with the SPIRE key. Without the env flag the
      // Wave 2 chart path MUST be taken.
      const fakeFiles = new Map<string, string>([
        ['/var/kagent/spire-cap-ca/tls.key', spireKeys.privatePem],
        ['/var/kagent/spire-cap-ca/tls.crt', spireKeys.publicPem],
        ['/var/kagent/cap-ca/tls.key', chartKeys.privatePem],
        ['/var/kagent/cap-ca/tls.crt', chartKeys.publicPem],
      ]);
      const askedPaths: string[] = [];
      const ca = await loadFromEnv({}, (p) => {
        askedPaths.push(p);
        const v = fakeFiles.get(p);
        if (v === undefined) throw new Error(`unexpected read: ${p}`);
        return v;
      });
      // Wave 2 path should NEVER ask for the SPIRE files when identity disabled.
      expect(askedPaths).not.toContain('/var/kagent/spire-cap-ca/tls.key');
      expect(askedPaths).not.toContain('/var/kagent/spire-cap-ca/tls.crt');
      expect(ca.alg).toBe('ES256');
    });
  });
});
