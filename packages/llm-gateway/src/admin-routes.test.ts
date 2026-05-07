/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import {
  adminAuth,
  buildCapacityResponse,
  buildUsageResponse,
  parseUsageQuery,
} from './admin-routes.js';
import { AimdController } from './aimd.js';
import { InFlightCounter } from './inflight-counter.js';
import { ModelIndex } from './model-index.js';
import type { ModelEndpoint } from './types.js';
import type { UsageRepo, UsageQueryFilter, UsageQueryRow } from './db/usage.js';

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('adminAuth', () => {
  it('rejects when authorization header is absent', () => {
    expect(adminAuth(fakeReq({}), 'tok')).toMatchObject({ ok: false, statusCode: 401 });
  });

  it('rejects when supplied token differs in length', () => {
    expect(adminAuth(fakeReq({ authorization: 'Bearer short' }), 'longertoken')).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });

  it('rejects when supplied token differs in value', () => {
    expect(adminAuth(fakeReq({ authorization: 'Bearer aaaa' }), 'bbbb')).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });

  it('accepts a matching Bearer token', () => {
    expect(adminAuth(fakeReq({ authorization: 'Bearer tok' }), 'tok')).toMatchObject({ ok: true });
  });

  it('accepts a raw token without the Bearer prefix', () => {
    expect(adminAuth(fakeReq({ authorization: 'tok' }), 'tok')).toMatchObject({ ok: true });
  });

  /* =====================================================================
   * H14 — admin-token compare must not leak the expected token's
   * length. The previous implementation early-returned 403 whenever
   * `supplied.length !== expectedToken.length`; the fix HMAC-digests
   * both sides to a fixed 32-byte width before timingSafeEqual, so
   * supplied tokens of any length take the same compare path.
   * ===================================================================== */

  it('still rejects a length-mismatched token (defence-in-depth)', () => {
    expect(
      adminAuth(fakeReq({ authorization: 'Bearer x' }), 'much-longer-expected-token-12345'),
    ).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });

  it('rejects an empty supplied token without leaking expected length', () => {
    expect(adminAuth(fakeReq({ authorization: 'Bearer ' }), 'expected')).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });

  it('returns 403 (not 401) for a non-empty malformed token — the auth header IS present', () => {
    // Belt-and-suspenders: 401 is "no header"; 403 is "header present
    // but does not authenticate" — same posture before and after the
    // HMAC fix.
    expect(adminAuth(fakeReq({ authorization: 'Bearer ' }), 'tok')).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });
});

function ep(model: string, max = 4, seed = 2, url = 'http://x'): ModelEndpoint {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ModelEndpoint',
    metadata: { name: 'm' },
    spec: {
      model,
      backendKind: 'mock',
      backendUrl: url,
      inFlight: { seed, max },
    },
  };
}

describe('buildCapacityResponse', () => {
  it('returns empty rows when the index is empty', () => {
    const r = buildCapacityResponse(
      new ModelIndex(),
      new InFlightCounter(),
      new AimdController({ seed: 1, max: 4, minSafe: 1 }),
    );
    expect(r.rows).toEqual([]);
  });

  it('returns one row per (model, endpoint) with current cap + in-flight', () => {
    const idx = new ModelIndex();
    idx.upsert(ep('a', 8, 4, 'http://aa'));
    idx.upsert(ep('b', 4, 2, 'http://bb'));
    const cnt = new InFlightCounter();
    cnt.acquire('a', 'http://aa');
    cnt.acquire('a', 'http://aa');
    const aimd = new AimdController({ seed: 4, max: 8, minSafe: 1 });
    aimd.updateBounds('a', 'http://aa', { seed: 4, max: 8, minSafe: 1 });
    aimd.updateBounds('b', 'http://bb', { seed: 2, max: 4, minSafe: 1 });
    const r = buildCapacityResponse(idx, cnt, aimd);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.model).toBe('a');
    expect(r.rows[0]?.inFlight).toBe(2);
    expect(r.rows[0]?.currentCap).toBe(4);
    expect(r.rows[1]?.model).toBe('b');
    expect(r.rows[1]?.currentCap).toBe(2);
  });
});

describe('parseUsageQuery', () => {
  it('returns empty filter on bare path', () => {
    expect(parseUsageQuery('/admin/usage')).toEqual({});
  });

  it('parses every supported field', () => {
    const f = parseUsageQuery(
      '/admin/usage?taskUid=u&agentName=a&model=m&since=2026-01-01&until=2026-02-01&limit=50',
    );
    expect(f).toEqual<UsageQueryFilter>({
      taskUid: 'u',
      agentName: 'a',
      model: 'm',
      since: '2026-01-01',
      until: '2026-02-01',
      limit: 50,
    });
  });

  it('drops a non-numeric or non-positive limit', () => {
    expect(parseUsageQuery('/admin/usage?limit=oops').limit).toBeUndefined();
    expect(parseUsageQuery('/admin/usage?limit=-1').limit).toBeUndefined();
  });

  it('drops empty-string params', () => {
    expect(parseUsageQuery('/admin/usage?taskUid=&model=')).toEqual({});
  });
});

describe('buildUsageResponse', () => {
  class FakeUsageRepo implements UsageRepo {
    captured: UsageQueryFilter | null = null;
    rowsToReturn: UsageQueryRow[] = [];

    async record(): Promise<void> {
      /* not used */
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async query(filter: UsageQueryFilter): Promise<readonly UsageQueryRow[]> {
      this.captured = filter;
      return this.rowsToReturn;
    }
  }

  it('hands a parsed filter to the repo and wraps the rows', async () => {
    const repo = new FakeUsageRepo();
    repo.rowsToReturn = [
      {
        id: '1',
        occurredAt: '2026-05-03T01:02:03Z',
        apiKeyPrefix: 'sk-x',
        requestId: 'r-1',
        model: 'm',
        backend: 'mock',
        backendUrl: null,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        latencyMs: 1,
        statusCode: 200,
        costUsd: 0,
        streaming: false,
        taskUid: 'task-1',
        agentName: 'a',
        errorMessage: null,
      },
    ];
    const r = await buildUsageResponse('/admin/usage?taskUid=task-1&limit=10', repo);
    expect(repo.captured).toEqual({ taskUid: 'task-1', limit: 10 });
    expect(r.rows).toHaveLength(1);
  });
});

/* =====================================================================
 * v0.1.12-keys-rest — POST/GET/DELETE /admin/keys handlers.
 * ===================================================================== */

describe('parseCreateApiKeyBody', () => {
  it('accepts a minimal body (label only)', async () => {
    const { parseCreateApiKeyBody } = await import('./admin-routes.js');
    expect(parseCreateApiKeyBody({ label: 'cli' })).toEqual({ label: 'cli' });
  });

  it('preserves modelAllowlist + expiresAt when supplied', async () => {
    const { parseCreateApiKeyBody } = await import('./admin-routes.js');
    expect(
      parseCreateApiKeyBody({
        label: 'researcher',
        modelAllowlist: ['gpt-4o', 'claude-3.5'],
        expiresAt: '2030-01-01T00:00:00Z',
      }),
    ).toEqual({
      label: 'researcher',
      modelAllowlist: ['gpt-4o', 'claude-3.5'],
      expiresAt: '2030-01-01T00:00:00Z',
    });
  });

  it('rejects a missing label', async () => {
    const { parseCreateApiKeyBody } = await import('./admin-routes.js');
    expect(() => parseCreateApiKeyBody({})).toThrowError(/label/);
  });

  it('rejects an empty-string label', async () => {
    const { parseCreateApiKeyBody } = await import('./admin-routes.js');
    expect(() => parseCreateApiKeyBody({ label: '' })).toThrowError(/label/);
  });

  it('rejects a non-string label', async () => {
    const { parseCreateApiKeyBody } = await import('./admin-routes.js');
    expect(() => parseCreateApiKeyBody({ label: 42 })).toThrowError(/label/);
  });

  it('rejects modelAllowlist if not an array of strings', async () => {
    const { parseCreateApiKeyBody } = await import('./admin-routes.js');
    expect(() => parseCreateApiKeyBody({ label: 'a', modelAllowlist: 'not-array' })).toThrowError(
      /modelAllowlist/,
    );
    expect(() => parseCreateApiKeyBody({ label: 'a', modelAllowlist: [1, 2] })).toThrowError(
      /modelAllowlist/,
    );
  });

  it('rejects expiresAt that is not a string', async () => {
    const { parseCreateApiKeyBody } = await import('./admin-routes.js');
    expect(() => parseCreateApiKeyBody({ label: 'a', expiresAt: 1234 })).toThrowError(/expiresAt/);
  });
});

describe('handleCreateApiKey', () => {
  it('mints sk-<random>, hashes it, persists via insertAndReturn, and returns plaintext + id + hash', async () => {
    const { handleCreateApiKey } = await import('./admin-routes.js');
    const { hashApiKey } = await import('./auth.js');
    const calls: { input: unknown }[] = [];
    const repo = {
      insertAndReturn: async (input: unknown) => {
        calls.push({ input });
        return Promise.resolve({ id: '17' });
      },
    };
    const out = await handleCreateApiKey(
      { label: 'cli', modelAllowlist: ['gpt-4o'], expiresAt: '2030-01-01T00:00:00Z' },

      repo,
    );
    expect(out.id).toBe('17');
    expect(out.label).toBe('cli');
    expect(out.modelAllowlist).toEqual(['gpt-4o']);
    expect(out.expiresAt).toBe('2030-01-01T00:00:00Z');
    expect(out.key).toMatch(/^sk-[A-Za-z0-9_-]+$/);
    expect(out.key.length).toBeGreaterThan(20);
    // Hash matches sha256(plaintext) — proof we persisted the right hash.
    expect(out.hash).toBe(hashApiKey(out.key));
    // Repo got the SAME hash we returned, plus a derived prefix that
    // matches the first chars of the plaintext.
    const persisted = calls[0]?.input as Record<string, unknown>;
    expect(persisted.keyHash).toBe(out.hash);
    expect(typeof persisted.keyPrefix).toBe('string');
    expect(out.key.startsWith(persisted.keyPrefix as string)).toBe(true);
    expect(persisted.name).toBe('cli');
  });

  it('two consecutive calls with the same body produce different plaintext + hashes', async () => {
    const { handleCreateApiKey } = await import('./admin-routes.js');
    const repo = {
      insertAndReturn: async () => Promise.resolve({ id: '1' }),
    };

    const a = await handleCreateApiKey({ label: 'x' }, repo);

    const b = await handleCreateApiKey({ label: 'x' }, repo);
    expect(a.key).not.toBe(b.key);
    expect(a.hash).not.toBe(b.hash);
  });

  it('omits expiresAt + modelAllowlist when not supplied (clean response)', async () => {
    const { handleCreateApiKey } = await import('./admin-routes.js');
    const repo = { insertAndReturn: async () => Promise.resolve({ id: '5' }) };

    const out = await handleCreateApiKey({ label: 'cli' }, repo);
    expect(out.expiresAt).toBeUndefined();
    expect(out.modelAllowlist).toBeUndefined();
  });
});

describe('handleListApiKeys', () => {
  it('returns the repo rows verbatim wrapped in {rows}', async () => {
    const { handleListApiKeys } = await import('./admin-routes.js');
    const repo = {
      list: async () =>
        Promise.resolve([
          {
            id: '1',
            label: 'cli',
            hashPrefix: 'sk-abc12',
            status: 'active' as const,
            modelAllowlist: ['gpt-4o'],
            expiresAt: null,
            revokedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
    };

    const r = await handleListApiKeys(repo);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.label).toBe('cli');
    // Belt + suspenders — ensure no plaintext / hash leak
    expect(JSON.stringify(r)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  });
});

describe('handleRevokeApiKey', () => {
  it('returns {revoked: true} when repo.revoke matches a row', async () => {
    const { handleRevokeApiKey } = await import('./admin-routes.js');
    const captured: string[] = [];
    const repo = {
      revoke: async (id: string) => {
        captured.push(id);
        return Promise.resolve({ revoked: true });
      },
    };

    const r = await handleRevokeApiKey('42', repo);
    expect(r.revoked).toBe(true);
    expect(captured).toEqual(['42']);
  });

  it('returns {revoked: false} for an unknown id (handler surfaces 404)', async () => {
    const { handleRevokeApiKey } = await import('./admin-routes.js');
    const repo = { revoke: async () => Promise.resolve({ revoked: false }) };

    const r = await handleRevokeApiKey('nope', repo);
    expect(r.revoked).toBe(false);
  });
});

/* =====================================================================
 * M19 — admin numeric validation. parseRevokeIdFromUrl gives us the
 * raw URL segment; validateRevokeId rejects shapes that pg's BIGSERIAL
 * cast would throw on (non-numeric, negative, leading zeros, overflow).
 * ===================================================================== */

describe('validateRevokeId (M19)', () => {
  it('accepts a small positive integer', async () => {
    const { validateRevokeId } = await import('./admin-routes.js');
    expect(validateRevokeId('1')).toEqual({ ok: true, id: '1' });
    expect(validateRevokeId('42')).toEqual({ ok: true, id: '42' });
  });

  it('accepts BIGSERIAL maximum exactly', async () => {
    const { validateRevokeId } = await import('./admin-routes.js');
    expect(validateRevokeId('9223372036854775807')).toEqual({
      ok: true,
      id: '9223372036854775807',
    });
  });

  it('rejects empty string', async () => {
    const { validateRevokeId } = await import('./admin-routes.js');
    const r = validateRevokeId('');
    expect(r.ok).toBe(false);
    expect(r.message ?? '').toMatch(/required/);
  });

  it('rejects non-decimal characters (alphabetic, dashes)', async () => {
    const { validateRevokeId } = await import('./admin-routes.js');
    expect(validateRevokeId('abc').ok).toBe(false);
    expect(validateRevokeId('42abc').ok).toBe(false);
    expect(validateRevokeId('abc-def').ok).toBe(false);
  });

  it('rejects negative-shaped ids', async () => {
    const { validateRevokeId } = await import('./admin-routes.js');
    expect(validateRevokeId('-5').ok).toBe(false);
  });

  it('rejects leading-zero ids', async () => {
    const { validateRevokeId } = await import('./admin-routes.js');
    expect(validateRevokeId('042').ok).toBe(false);
    // `0` alone is also rejected — id starts at 1 (BIGSERIAL).
    expect(validateRevokeId('0').ok).toBe(false);
  });

  it('rejects scientific notation', async () => {
    const { validateRevokeId } = await import('./admin-routes.js');
    expect(validateRevokeId('1e10').ok).toBe(false);
  });

  it('rejects ids exceeding BIGSERIAL range', async () => {
    const { validateRevokeId } = await import('./admin-routes.js');
    const r = validateRevokeId('9223372036854775808');
    expect(r.ok).toBe(false);
    expect(r.message ?? '').toMatch(/range/);
  });

  it('rejects id with too many digits (regex bound)', async () => {
    const { validateRevokeId } = await import('./admin-routes.js');
    // 20-digit string is structurally rejected by the regex (max 19).
    expect(validateRevokeId('99999999999999999999').ok).toBe(false);
  });
});

describe('parseRevokeIdFromUrl', () => {
  it('extracts the id from /admin/keys/:id', async () => {
    const { parseRevokeIdFromUrl } = await import('./admin-routes.js');
    expect(parseRevokeIdFromUrl('/admin/keys/42')).toBe('42');
    expect(parseRevokeIdFromUrl('/admin/keys/abc-def')).toBe('abc-def');
  });

  it('returns undefined for the bare /admin/keys path', async () => {
    const { parseRevokeIdFromUrl } = await import('./admin-routes.js');
    expect(parseRevokeIdFromUrl('/admin/keys')).toBeUndefined();
    expect(parseRevokeIdFromUrl('/admin/keys/')).toBeUndefined();
  });

  it('returns undefined when the id contains a path separator', async () => {
    const { parseRevokeIdFromUrl } = await import('./admin-routes.js');
    expect(parseRevokeIdFromUrl('/admin/keys/42/extra')).toBeUndefined();
  });

  it('strips trailing query strings', async () => {
    const { parseRevokeIdFromUrl } = await import('./admin-routes.js');
    expect(parseRevokeIdFromUrl('/admin/keys/42?ignored=true')).toBe('42');
  });
});
