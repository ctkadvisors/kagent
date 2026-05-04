/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { SIGNATURE_HEADER, computeSignature, verifySignature } from './hmac.js';

describe('computeSignature', () => {
  it('produces a 64-character lowercase hex digest for a string body', () => {
    const sig = computeSignature('secret', 'hello');
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same digest for string and Buffer bodies of identical bytes', () => {
    const text = '{"foo":"bar"}';
    const a = computeSignature('shh', text);
    const b = computeSignature('shh', Buffer.from(text, 'utf8'));
    expect(a).toBe(b);
  });

  it('matches a known RFC-shaped vector', () => {
    // Sanity: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog")
    // = f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8
    const sig = computeSignature('key', 'The quick brown fox jumps over the lazy dog');
    expect(sig).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });
});

describe('verifySignature', () => {
  it('accepts a freshly-computed signature for the same body', () => {
    const body = '{"trigger":"daily"}';
    const sig = computeSignature('shared-secret', body);
    expect(verifySignature('shared-secret', body, sig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = '{"trigger":"daily"}';
    const sig = computeSignature('shared-secret', body);
    expect(verifySignature('shared-secret', '{"trigger":"weekly"}', sig)).toBe(false);
  });

  it('rejects a tampered signature byte', () => {
    const body = '{"trigger":"daily"}';
    const sig = computeSignature('shared-secret', body);
    const flipped = (sig.startsWith('a') ? 'b' : 'a') + sig.slice(1);
    expect(verifySignature('shared-secret', body, flipped)).toBe(false);
  });

  it('rejects a wrong-length signature', () => {
    expect(verifySignature('shared-secret', 'body', 'deadbeef')).toBe(false);
  });

  it('rejects a non-hex signature', () => {
    expect(
      verifySignature(
        'shared-secret',
        'body',
        'GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
      ),
    ).toBe(false);
  });

  it('rejects empty signature', () => {
    expect(verifySignature('shared-secret', 'body', '')).toBe(false);
  });

  it('rejects when secret is wrong', () => {
    const body = 'payload';
    const sig = computeSignature('right', body);
    expect(verifySignature('wrong', body, sig)).toBe(false);
  });

  it('exports the canonical header name', () => {
    expect(SIGNATURE_HEADER).toBe('x-kagent-signature');
  });
});
