/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * H13 regression tests for the BackendError envelope and its
 * fromUpstreamResponse factory.
 */

import { describe, expect, it } from 'vitest';

import { BackendError, parseRetryAfter } from './backend-error.js';

interface StubHeaders {
  get(name: string): string | null;
}

function stubResponse(input: { status: number; body: string; retryAfter?: string | null }): {
  status: number;
  text(): Promise<string>;
  headers: StubHeaders;
} {
  return {
    status: input.status,
    text: () => Promise.resolve(input.body),
    headers: {
      get: (name: string): string | null => {
        if (name.toLowerCase() === 'retry-after') {
          return input.retryAfter ?? null;
        }
        return null;
      },
    },
  };
}

describe('parseRetryAfter', () => {
  it('returns undefined for null/undefined/empty', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
  });

  it('parses a delta-seconds value as an integer count of seconds', () => {
    expect(parseRetryAfter('7')).toBe(7);
    expect(parseRetryAfter('  42  ')).toBe(42);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses an HTTP-date value as a delta-from-now', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const v = parseRetryAfter(future);
    expect(v).toBeGreaterThanOrEqual(28);
    expect(v).toBeLessThanOrEqual(31);
  });

  it('parses a past HTTP-date as 0 (clamped non-negative)', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it('returns undefined for garbage', () => {
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('BackendError.fromUpstreamResponse', () => {
  it('captures status + Retry-After from a 429 response', async () => {
    const err = await BackendError.fromUpstreamResponse({
      backend: 'openai',
      response: stubResponse({
        status: 429,
        body: '{"error":{"message":"rate_limit"}}',
        retryAfter: '12',
      }),
    });
    expect(err).toBeInstanceOf(BackendError);
    expect(err.backend).toBe('openai');
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(12);
    expect(err.message).toContain('openai error 429');
  });

  it('captures status without Retry-After when header is absent', async () => {
    const err = await BackendError.fromUpstreamResponse({
      backend: 'anthropic',
      response: stubResponse({
        status: 503,
        body: 'service unavailable',
        retryAfter: null,
      }),
    });
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBeUndefined();
  });

  it('scrubs secrets out of the response body before storing the message', async () => {
    const err = await BackendError.fromUpstreamResponse({
      backend: 'openai',
      response: stubResponse({
        status: 401,
        body: 'Incorrect API key provided: sk-abcdefghijklmnopqrstuvwx',
      }),
    });
    expect(err.message).toContain('[REDACTED]');
    expect(err.message).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });

  it('truncates long bodies to ≤256 chars', async () => {
    const big = 'x'.repeat(2000);
    const err = await BackendError.fromUpstreamResponse({
      backend: 'openai',
      response: stubResponse({
        status: 502,
        body: big,
      }),
    });
    // The full message includes the prefix `openai error 502: …` then
    // the truncated body. We just need the body portion to have been
    // capped — the total length is bounded by 256 + prefix length.
    expect(err.message.length).toBeLessThanOrEqual(256 + 30);
  });
});

describe('BackendError direct construction', () => {
  it('honours all fields on the input shape', () => {
    const e = new BackendError({
      backend: 'cf',
      status: 429,
      message: 'too many',
      retryAfter: 9,
    });
    expect(e.name).toBe('BackendError');
    expect(e.backend).toBe('cf');
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe(9);
    expect(e.message).toBe('too many');
  });

  it('omits retryAfter when not provided', () => {
    const e = new BackendError({ backend: 'cf', status: 500, message: 'oops' });
    expect(e.retryAfter).toBeUndefined();
  });
});
