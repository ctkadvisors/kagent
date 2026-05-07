/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';
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
  // === Audit BLOCKER #1 (C2.1) — capability mount required-by-default ===
  // Four cells of the env × file-present matrix:
  //   A: KAGENT_CAP_JWT_FILE unset                   → return undefined (legacy)
  //   B: env set, file missing, allowMissing != true → throw (fail-loud)
  //   C: env set, file missing, allowMissing == true → return undefined + WARN
  //   D: env set, file present                       → verify (existing path)

  it('cell A — KAGENT_CAP_JWT_FILE unset returns undefined (legacy / pre-v0.3.0 path)', async () => {
    // No KAGENT_CAP_JWT_FILE in env → legacy pre-v0.3.0 deploy. Must
    // return undefined WITHOUT touching the filesystem (the chart hasn't
    // been upgraded to mount the cap Secret yet; this is the back-compat
    // door, not the fail-open opt-out).
    const readFile = vi.fn<(p: string) => string>(() => {
      throw new Error('readFile must not be called when env is unset');
    });
    const result = await loadCapabilityOptional({
      env: {},
      readFile,
      fetchJwks: () => Promise.resolve({ keys: [] }),
    });
    expect(result).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('cell B — KAGENT_CAP_JWT_FILE set + file missing + allowMissing!=true → throws clearly', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), {
      code: 'ENOENT',
    });
    await expect(
      loadCapabilityOptional({
        env: { KAGENT_CAP_JWT_FILE: '/var/kagent/cap/cap.jwt' },
        readFile: () => {
          throw enoent;
        },
        fetchJwks: () => Promise.resolve({ keys: [] }),
      }),
    ).rejects.toThrow(/capability JWT file missing.*KAGENT_CAPABILITY_ALLOW_MISSING=true/);
  });

  it('cell C — KAGENT_CAP_JWT_FILE set + file missing + allowMissing=true → undefined + loud WARN', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), {
      code: 'ENOENT',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await loadCapabilityOptional({
        env: {
          KAGENT_CAP_JWT_FILE: '/var/kagent/cap/cap.jwt',
          KAGENT_CAPABILITY_ALLOW_MISSING: 'true',
        },
        readFile: () => {
          throw enoent;
        },
        fetchJwks: () => Promise.resolve({ keys: [] }),
      });
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      // Loud WARN must mention KAGENT_CAPABILITY_ALLOW_MISSING and that
      // capability enforcement is DISABLED so trace metadata makes the
      // opt-out visible.
      const msg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toContain('KAGENT_CAPABILITY_ALLOW_MISSING');
      expect(msg).toMatch(/DISABLED/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('cell D — file present verifies normally (existing path preserved)', async () => {
    const { jwt, jwks } = await makeKeysAndJwt({
      jti: 'cap-d',
      claims: { tools: ['http_get'] },
    });
    const result = await loadCapabilityOptional({
      env: { KAGENT_CAP_JWT_FILE: '/cap.jwt' },
      readFile: (p) => (p === '/cap.jwt' ? jwt : ''),
      fetchJwks: () => Promise.resolve(jwks),
    });
    expect(result).toBeDefined();
    expect(result?.bundle.jti).toBe('cap-d');
  });

  it('returns undefined when file is empty (legacy zero-byte mount)', async () => {
    // Empty file with the env set — treat the mount as a no-op (the
    // chart minted a Secret with an empty key during a misconfigured
    // upgrade); this is functionally identical to "no claims" and
    // returns undefined so the runner falls through. Distinct from
    // ENOENT which trips the require-by-default gate.
    const result = await loadCapabilityOptional({
      env: { KAGENT_CAP_JWT_FILE: '/cap.jwt' },
      readFile: () => '',
      fetchJwks: () => Promise.resolve({ keys: [] }),
    });
    expect(result).toBeUndefined();
  });

  it('throws when file is present but verification fails (env set)', async () => {
    await expect(
      loadCapabilityOptional({
        env: { KAGENT_CAP_JWT_FILE: '/cap.jwt' },
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
