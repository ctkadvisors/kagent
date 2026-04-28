/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ARTIFACT_PVC,
  INLINE_DEFAULT_MAX_BYTES,
  inlineSafe,
  isArtifactRef,
  parseArtifactUri,
  pvcUri,
} from './artifact-ref.js';

describe('pvcUri', () => {
  it('produces canonical pvc://kagent-artifacts/<uid>/<name> shape', () => {
    expect(pvcUri('9b1a8c4e-research', 'digest.md')).toBe(
      'pvc://kagent-artifacts/9b1a8c4e-research/digest.md',
    );
  });

  it('uses the configured default PVC name', () => {
    expect(DEFAULT_ARTIFACT_PVC).toBe('kagent-artifacts');
  });

  it('accepts an override PVC name', () => {
    expect(pvcUri('uid-1', 'a.txt', 'custom-pvc')).toBe('pvc://custom-pvc/uid-1/a.txt');
  });

  it('preserves nested name segments (e.g. screenshots/01.png)', () => {
    expect(pvcUri('uid-1', 'screenshots/01.png')).toBe(
      'pvc://kagent-artifacts/uid-1/screenshots/01.png',
    );
  });

  it.each([
    ['empty taskUid', '', 'a.txt'],
    ['empty name', 'uid', ''],
  ])('throws on %s', (_label, uid, name) => {
    expect(() => pvcUri(uid, name)).toThrow();
  });

  it('rejects names beginning with /', () => {
    expect(() => pvcUri('uid', '/escape.txt')).toThrow(/must not begin with/);
  });

  it('rejects names containing .. segments (path traversal)', () => {
    expect(() => pvcUri('uid', '../escape.txt')).toThrow(/must not contain/);
    expect(() => pvcUri('uid', 'a/../b.txt')).toThrow(/must not contain/);
  });
});

describe('parseArtifactUri', () => {
  it('parses pvc:// into scheme + bucket + path', () => {
    expect(parseArtifactUri('pvc://kagent-artifacts/uid-1/digest.md')).toEqual({
      scheme: 'pvc',
      bucket: 'kagent-artifacts',
      path: 'uid-1/digest.md',
    });
  });

  it('parses s3:// (v0.2)', () => {
    expect(parseArtifactUri('s3://my-bucket/uid-1/x.png')).toEqual({
      scheme: 's3',
      bucket: 'my-bucket',
      path: 'uid-1/x.png',
    });
  });

  it('parses minio:// (v0.2)', () => {
    expect(parseArtifactUri('minio://kagent/uid/file.json')).toEqual({
      scheme: 'minio',
      bucket: 'kagent',
      path: 'uid/file.json',
    });
  });

  it('parses http:// and https:// without bucket (host-as-bucket-equiv)', () => {
    expect(parseArtifactUri('https://artifacts.example.com/uid/x.har')).toEqual({
      scheme: 'https',
      path: 'uid/x.har',
    });
    expect(parseArtifactUri('http://artifacts.example.com/uid/x')).toEqual({
      scheme: 'http',
      path: 'uid/x',
    });
  });

  it('parses inline://sha256:<hex> (content-addressed, NOT persisted)', () => {
    const hex = 'a'.repeat(64);
    expect(parseArtifactUri(`inline://sha256:${hex}`)).toEqual({
      scheme: 'inline',
      path: `sha256:${hex}`,
    });
  });

  it('lowercases the scheme so PVC:// parses', () => {
    const parsed = parseArtifactUri('PVC://kagent-artifacts/uid/file.md');
    expect(parsed?.scheme).toBe('pvc');
  });

  it.each([
    ['null-ish empty', ''],
    ['no scheme separator', 'kagent-artifacts/uid/file.md'],
    ['unknown scheme', 'ftp://server/file'],
    ['pvc with no bucket', 'pvc:///uid/file'],
    ['pvc with no path', 'pvc://kagent-artifacts/'],
    ['pvc with no slash after bucket', 'pvc://kagent-artifacts'],
    ['totally garbage', '://'],
  ])('returns null on %s', (_label, input) => {
    expect(parseArtifactUri(input)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseArtifactUri(undefined as unknown as string)).toBeNull();
  });
});

describe('isArtifactRef', () => {
  it('accepts a minimal ref (uri only)', () => {
    expect(isArtifactRef({ uri: 'pvc://kagent-artifacts/uid/x.md' })).toBe(true);
  });

  it('accepts a fully-populated ref', () => {
    expect(
      isArtifactRef({
        uri: 'pvc://kagent-artifacts/uid/x.md',
        mediaType: 'text/markdown',
        sizeBytes: 1234,
        checksum: 'sha256:abc',
        name: 'digest.md',
        producedAt: '2026-04-28T14:23:11Z',
      }),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'pvc://...'],
    ['number', 42],
    ['array', []],
    ['empty object (no uri)', {}],
    ['empty uri', { uri: '' }],
    ['non-string uri', { uri: 5 }],
    ['bad mediaType type', { uri: 'pvc://k/u/x', mediaType: 42 }],
    ['bad sizeBytes type', { uri: 'pvc://k/u/x', sizeBytes: '100' }],
    ['negative sizeBytes', { uri: 'pvc://k/u/x', sizeBytes: -1 }],
    ['NaN sizeBytes', { uri: 'pvc://k/u/x', sizeBytes: Number.NaN }],
    ['bad checksum type', { uri: 'pvc://k/u/x', checksum: 12 }],
    ['bad name type', { uri: 'pvc://k/u/x', name: 12 }],
    ['bad producedAt type', { uri: 'pvc://k/u/x', producedAt: new Date() }],
  ])('rejects %s', (_label, value) => {
    expect(isArtifactRef(value)).toBe(false);
  });
});

describe('inlineSafe', () => {
  it('inlines small text/markdown', () => {
    const result = inlineSafe('# tiny report', 'text/markdown');
    expect(result).toEqual({ kind: 'inline', content: '# tiny report' });
  });

  it('inlines small JSON', () => {
    const result = inlineSafe('{"k":"v"}', 'application/json');
    expect(result.kind).toBe('inline');
  });

  it('refuses binary media types regardless of size', () => {
    expect(inlineSafe('whatever', 'image/png').kind).toBe('reference-needed');
    expect(inlineSafe('whatever', 'application/octet-stream').kind).toBe('reference-needed');
  });

  it('refuses oversized text payloads', () => {
    const big = 'x'.repeat(INLINE_DEFAULT_MAX_BYTES + 1);
    expect(inlineSafe(big, 'text/markdown').kind).toBe('reference-needed');
  });

  it('treats UTF-8 byte length, not code points (multi-byte chars)', () => {
    // 4-byte UTF-8 character × 3 = 12 bytes; cap of 8 forces reference.
    const four = '\u{1F4A9}'; // pile-of-poo (4 UTF-8 bytes)
    const payload = four.repeat(3);
    expect(inlineSafe(payload, 'text/markdown', 8).kind).toBe('reference-needed');
    expect(inlineSafe(payload, 'text/markdown', 16).kind).toBe('inline');
  });

  it('inlines exactly at the byte cap (boundary inclusive)', () => {
    const exact = 'x'.repeat(INLINE_DEFAULT_MAX_BYTES);
    expect(inlineSafe(exact, 'text/markdown').kind).toBe('inline');
  });

  it('honors a per-call maxBytes override', () => {
    expect(inlineSafe('x'.repeat(100), 'text/markdown', 50).kind).toBe('reference-needed');
    expect(inlineSafe('x'.repeat(40), 'text/markdown', 50).kind).toBe('inline');
  });

  it('matches mediaType case-insensitively', () => {
    expect(inlineSafe('hi', 'TEXT/Markdown').kind).toBe('inline');
  });

  it('rejects non-string content (defensive)', () => {
    expect(inlineSafe(123 as unknown as string, 'text/markdown').kind).toBe('reference-needed');
  });
});
