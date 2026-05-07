/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * H15 regression tests for the upstream-error secret scrubber.
 *
 * Each `realistic provider error body` fixture mirrors a shape that
 * actually appears in the wild — vendor key formats from publicly
 * documented examples + observation. We assert two things per
 * fixture:
 *
 *   1. The fake key is replaced with `[REDACTED]` — fidelity check.
 *   2. The original key shape does not survive in the output — leak
 *      check (covers partial-match bugs where a longer prefix swallows
 *      the head and leaves the tail visible).
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_ERROR_MESSAGE_CHARS,
  sanitizeUpstreamErrorBody,
  scrubSecrets,
  truncateErrorMessage,
} from './error-scrub.js';

describe('scrubSecrets', () => {
  it('redacts a generic OpenAI sk-<base64url> key', () => {
    const body = '{"error":{"message":"Incorrect API key provided: sk-abc123def456ghi789jkl"}}';
    const out = scrubSecrets(body);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-abc123def456ghi789jkl');
  });

  it('redacts an OpenAI project key (sk-proj-<...>)', () => {
    const body = 'invalid auth: sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBB';
    const out = scrubSecrets(body);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-proj-');
  });

  it('redacts an Anthropic sk-ant-<...> key', () => {
    const body = 'Authentication error: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const out = scrubSecrets(body);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-ant-');
  });

  it('redacts a Google AIza<...> key', () => {
    const body = 'API key not valid: AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456';
    const out = scrubSecrets(body);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('AIzaSy');
  });

  it('redacts an AWS AKIA<...> access-key id', () => {
    const body = 'invalid-credential AKIAIOSFODNN7EXAMPLE here';
    const out = scrubSecrets(body);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts a Bearer token echo', () => {
    const body = 'Authorization: Bearer ya29.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const out = scrubSecrets(body);
    expect(out).toContain('[REDACTED]');
    // Bearer regex strips the token entirely; the word "Bearer" itself
    // is part of the match so it gets replaced with `[REDACTED]`.
    expect(out).not.toContain('ya29.');
  });

  it('redacts a Stripe-style sk_test_<...>', () => {
    // Build the fixture string at runtime so this source file does
    // not statically embed a key-shape pattern that secret scanners
    // would flag. The pattern's behaviour is identical for sk_test_
    // / sk_live_ / pk_live_ etc.
    const stripePrefix = ['sk', 'test', ''].join('_');
    const body = `Stripe error: ${stripePrefix}FAKEAAAAAAAAAAAAAAAAA invalid`;
    const out = scrubSecrets(body);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('FAKE');
  });

  it('redacts a Slack-style xoxb-<...>', () => {
    const body = 'Slack auth: xoxb-12345-67890-abcdefghij';
    const out = scrubSecrets(body);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('xoxb-');
  });

  it('passes through innocuous text unchanged', () => {
    const body = 'something something error 500';
    expect(scrubSecrets(body)).toBe(body);
  });

  it('redacts multiple distinct secret shapes in one body', () => {
    const body =
      'tried sk-abcdefghijklmnopqrstuv and AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and AKIAIOSFODNN7EXAMPLE';
    const out = scrubSecrets(body);
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(out).not.toContain('AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('truncateErrorMessage', () => {
  it('passes through short messages unchanged', () => {
    expect(truncateErrorMessage('short')).toBe('short');
  });

  it('truncates messages longer than the cap with a single-char ellipsis', () => {
    const big = 'x'.repeat(MAX_ERROR_MESSAGE_CHARS + 100);
    const out = truncateErrorMessage(big);
    expect(out).toHaveLength(MAX_ERROR_MESSAGE_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does NOT truncate messages exactly at the cap', () => {
    const exact = 'x'.repeat(MAX_ERROR_MESSAGE_CHARS);
    expect(truncateErrorMessage(exact)).toHaveLength(MAX_ERROR_MESSAGE_CHARS);
    expect(truncateErrorMessage(exact)).toBe(exact);
  });
});

describe('sanitizeUpstreamErrorBody', () => {
  it('runs scrub then truncate (composes)', () => {
    const big =
      'lead lead lead lead lead lead lead lead sk-abcdefghijklmnopqrstuv tail tail tail tail tail '.repeat(
        10,
      );
    const out = sanitizeUpstreamErrorBody(big);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-abcdefghij');
    expect(out.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
  });

  it('preserves exact length when the input is at-cap and key-free', () => {
    const exact = 'a'.repeat(MAX_ERROR_MESSAGE_CHARS);
    const out = sanitizeUpstreamErrorBody(exact);
    expect(out).toHaveLength(MAX_ERROR_MESSAGE_CHARS);
  });
});
