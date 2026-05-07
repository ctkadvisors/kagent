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

import {
  bundleAdmits,
  fetchJwksWithRetry,
  JwksUnreachableError,
  loadCapabilityFromEnv,
  loadCapabilityOptional,
} from './cap-consumer.js';

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

/* =====================================================================
 * Audit C2 H11 — JWKS fetch fragility (timeout + retry + structured
 * Failed status patch on terminal failure).
 *
 * Pre-fix `defaultFetchJwks` was a single `fetch()` with no timeout
 * and no retry. A transient operator template-server flap during pod
 * boot caused the AgentTask to hit CrashLoopBackOff with no
 * operator-visible signal. Fix: 10s per-attempt timeout (AbortController),
 * 3-attempt backoff (250ms / 750ms / 2250ms), terminal failure throws
 * `JwksUnreachableError` whose message is structured for the AgentTask
 * `Failed` status patch.
 * ===================================================================== */

describe('fetchJwksWithRetry (H11)', () => {
  function makeFetcher(
    responses: ReadonlyArray<() => Promise<Response>>,
  ): (url: string, init: { signal: AbortSignal }) => Promise<Response> {
    let i = 0;
    return (_url, _init) => {
      const fn = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return fn?.() ?? Promise.reject(new Error('no fetcher'));
    };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('returns the parsed body on first-attempt success', async () => {
    const result = await fetchJwksWithRetry(
      'http://example/jwks.json',
      makeFetcher([() => Promise.resolve(jsonResponse({ keys: [{ kid: 'k1' }] }))]),
      { sleep: () => Promise.resolve() },
    );
    expect(result.keys).toHaveLength(1);
  });

  it('retries on first-attempt network error and succeeds on second', async () => {
    const sleeps: number[] = [];
    const result = await fetchJwksWithRetry(
      'http://example/jwks.json',
      makeFetcher([
        () => Promise.reject(new TypeError('fetch failed')),
        () => Promise.resolve(jsonResponse({ keys: [{ kid: 'k2' }] })),
      ]),
      {
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(result.keys).toHaveLength(1);
    expect(sleeps).toEqual([250]);
  });

  it('honors all 3 backoff delays before terminal failure', async () => {
    const sleeps: number[] = [];
    await expect(
      fetchJwksWithRetry(
        'http://example/jwks.json',
        makeFetcher([
          () => Promise.reject(new TypeError('fail 1')),
          () => Promise.reject(new TypeError('fail 2')),
          () => Promise.reject(new TypeError('fail 3')),
        ]),
        {
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toBeInstanceOf(JwksUnreachableError);
    // 3 attempts → 2 sleeps between attempts (no sleep after final attempt).
    expect(sleeps).toEqual([250, 750]);
  });

  it('throws JwksUnreachableError with structured message on terminal failure', async () => {
    let caught: unknown;
    try {
      await fetchJwksWithRetry(
        'http://operator-template/.well-known/jwks.json',
        makeFetcher([() => Promise.reject(new TypeError('connection refused'))]),
        { sleep: () => Promise.resolve(), retryDelaysMs: [10] },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwksUnreachableError);
    const e = caught as JwksUnreachableError;
    expect(e.message).toMatch(/jwks_unreachable/);
    expect(e.message).toContain('http://operator-template/.well-known/jwks.json');
    expect(e.url).toBe('http://operator-template/.well-known/jwks.json');
    expect(e.attempts).toBe(1);
    expect(e.cause).toBeInstanceOf(TypeError);
  });

  it('treats non-2xx HTTP as failure and retries', async () => {
    const sleeps: number[] = [];
    const result = await fetchJwksWithRetry(
      'http://example/jwks.json',
      makeFetcher([
        () => Promise.resolve(new Response('boom', { status: 503 })),
        () => Promise.resolve(jsonResponse({ keys: [{ kid: 'k3' }] })),
      ]),
      {
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(result.keys).toHaveLength(1);
    expect(sleeps).toEqual([250]);
  });

  it('treats malformed JWKS body (no keys array) as failure and retries', async () => {
    const sleeps: number[] = [];
    const result = await fetchJwksWithRetry(
      'http://example/jwks.json',
      makeFetcher([
        () => Promise.resolve(jsonResponse({ wrong: 'shape' })),
        () => Promise.resolve(jsonResponse({ keys: [{ kid: 'k4' }] })),
      ]),
      {
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(result.keys).toHaveLength(1);
    expect(sleeps).toEqual([250]);
  });

  it('aborts on per-attempt timeout via AbortController.signal', async () => {
    // Make the fetch listen to the AbortSignal and reject when fired.
    // Use a 5ms timeout so the test runs fast.
    let signalSeen: AbortSignal | undefined;
    const slowFetcher: (url: string, init: { signal: AbortSignal }) => Promise<Response> = (
      _url,
      init,
    ) => {
      signalSeen = init.signal;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
        // Don't resolve — let the timeout fire.
      });
    };
    const sleeps: number[] = [];
    await expect(
      fetchJwksWithRetry('http://example/jwks.json', slowFetcher, {
        timeoutMs: 5,
        retryDelaysMs: [1, 1, 1],
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toBeInstanceOf(JwksUnreachableError);
    expect(signalSeen).toBeDefined();
    // 3 attempts, 2 sleeps between.
    expect(sleeps.length).toBe(2);
  });

  it('default schedule is 3 attempts (initial + 2 retries) with 250/750/2250 ms backoff', async () => {
    // Smoke-test the default schedule by passing only the fetcher and
    // a sleep stub — no opts override. The exact delays must match the
    // task spec.
    const sleeps: number[] = [];
    await expect(
      fetchJwksWithRetry(
        'http://example/jwks.json',
        makeFetcher([
          () => Promise.reject(new TypeError('fail 1')),
          () => Promise.reject(new TypeError('fail 2')),
          () => Promise.reject(new TypeError('fail 3')),
        ]),
        {
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toBeInstanceOf(JwksUnreachableError);
    // Default delays are [250, 750, 2250] but with 3 attempts only 2
    // delays between — verify the prefix matches.
    expect(sleeps).toEqual([250, 750]);
  });
});

describe('JwksUnreachableError (H11) — structured boot-time Failed signal', () => {
  it('embeds url + attempt count + reason in message for status patch', () => {
    const cause = new TypeError('ECONNREFUSED');
    const err = new JwksUnreachableError('http://op/.well-known/jwks.json', 3, cause);
    expect(err.message).toContain('jwks_unreachable');
    expect(err.message).toContain('http://op/.well-known/jwks.json');
    expect(err.message).toContain('3 attempts');
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('main.ts capability-load catch surfaces the structured error message', async () => {
    // Simulate the boot path: loadCapabilityOptional uses a JWKS fetcher
    // that always fails. The error should propagate up so main.ts's
    // try/catch (audit C2.1 BLOCKER #1) sees a JwksUnreachableError
    // whose message can be embedded into the AgentTask Failed patch.
    const enoent = new TypeError('connection refused');
    let caught: Error | undefined;
    try {
      await loadCapabilityOptional({
        env: { KAGENT_CAP_JWT_FILE: '/cap.jwt' },
        readFile: () => 'fake.jwt.body',
        fetchJwks: (url) => {
          throw new JwksUnreachableError(url, 3, enoent);
        },
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/jwks_unreachable/);
    // The catch in main.ts:127-149 builds:
    //   `capability load failed: ${message}`
    // The message MUST contain the structured prefix so the operator
    // can grep `jwks_unreachable` in the AgentTask status.
    const failedStatusError = `capability load failed: ${caught?.message ?? ''}`;
    expect(failedStatusError).toContain('jwks_unreachable');
  });

  it('cause chain is preserved on the error instance', () => {
    const cause = new Error('underlying');
    const err = new JwksUnreachableError('http://x', 3, cause);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('JwksUnreachableError');
  });
});
