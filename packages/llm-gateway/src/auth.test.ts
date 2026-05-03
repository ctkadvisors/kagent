/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { authenticate, hashApiKey, type ApiKeyLookup } from './auth.js';

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const validKeyInfo = {
  keyHash: hashApiKey('sk-good-1'),
  keyPrefix: 'sk-good-',
  status: 'active' as const,
  expiresAt: null,
};

const lookup: ApiKeyLookup = (hash) => {
  if (hash === hashApiKey('sk-good-1')) return Promise.resolve({ ...validKeyInfo });
  if (hash === hashApiKey('sk-revoked-1')) {
    return Promise.resolve({ ...validKeyInfo, keyHash: hash, status: 'revoked' as const });
  }
  if (hash === hashApiKey('sk-expired-1')) {
    return Promise.resolve({
      ...validKeyInfo,
      keyHash: hash,
      status: 'active' as const,
      expiresAt: new Date('2020-01-01T00:00:00Z').toISOString(),
    });
  }
  return Promise.resolve(null);
};

describe('authenticate', () => {
  it('rejects when authorization header is missing', async () => {
    const r = await authenticate(fakeReq({}), lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(401);
      expect(r.message).toMatch(/missing/i);
    }
  });

  it('rejects when key does not start with sk-', async () => {
    const r = await authenticate(fakeReq({ authorization: 'Bearer not-a-key' }), lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(401);
  });

  it('rejects when key is unknown', async () => {
    const r = await authenticate(fakeReq({ authorization: 'Bearer sk-unknown-1' }), lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(401);
      expect(r.message).toMatch(/not found/i);
    }
  });

  it('rejects when key is revoked', async () => {
    const r = await authenticate(fakeReq({ authorization: 'Bearer sk-revoked-1' }), lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(403);
      expect(r.message).toMatch(/revoked/);
    }
  });

  it('rejects when key is expired', async () => {
    const r = await authenticate(fakeReq({ authorization: 'Bearer sk-expired-1' }), lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(403);
      expect(r.message).toMatch(/expired/i);
    }
  });

  it('accepts a valid active key', async () => {
    const r = await authenticate(fakeReq({ authorization: 'Bearer sk-good-1' }), lookup);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.keyPrefix).toBe('sk-good-');
    }
  });

  it('accepts a key without the Bearer prefix (raw header)', async () => {
    const r = await authenticate(fakeReq({ authorization: 'sk-good-1' }), lookup);
    expect(r.ok).toBe(true);
  });
});
