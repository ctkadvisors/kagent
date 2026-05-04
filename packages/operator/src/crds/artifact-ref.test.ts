/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  casUri,
  DEFAULT_ARTIFACT_PVC,
  INLINE_DEFAULT_MAX_BYTES,
  inlineSafe,
  isArtifactRef,
  parseArtifactUri,
  parseUri,
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

/* =====================================================================
 * v0.2.2-cas — content-addressed storage URI scheme.
 *
 * URI shape: cas://sha256:<hex>/<name>
 *   - <hex>  = lowercase 64 char sha256 hex
 *   - <name> = relative human-friendly file name (any UTF-8, validated
 *              by the same path-traversal rules as pvcUri)
 *
 * Identity = hash(bytes). Two AgentTasks producing the same bytes
 * produce one stored object; the URI is identical and re-running the
 * task replays the cached trace without an LLM call. Pattern follows
 * Bazel remote cache + Nix store + Git pack files.
 * ===================================================================== */

describe('casUri', () => {
  it('produces canonical cas://sha256:<hex>/<name> shape', () => {
    const hex = 'a'.repeat(64);
    expect(casUri(hex, 'digest.md')).toBe(`cas://sha256:${hex}/digest.md`);
  });

  it('preserves nested name segments (e.g. screenshots/01.png)', () => {
    const hex = 'b'.repeat(64);
    expect(casUri(hex, 'screenshots/01.png')).toBe(`cas://sha256:${hex}/screenshots/01.png`);
  });

  it('rejects names beginning with "/"', () => {
    expect(() => casUri('a'.repeat(64), '/escape.md')).toThrow(/must not begin with/);
  });

  it('rejects names containing ".." segments (path traversal)', () => {
    expect(() => casUri('a'.repeat(64), '../escape.md')).toThrow(/must not contain/);
    expect(() => casUri('a'.repeat(64), 'a/../b.md')).toThrow(/must not contain/);
  });

  it('rejects empty hash', () => {
    expect(() => casUri('', 'name.md')).toThrow(/contentHash required/);
  });

  it('rejects empty name', () => {
    expect(() => casUri('a'.repeat(64), '')).toThrow(/name required/);
  });

  it('rejects malformed hash (non-hex)', () => {
    expect(() => casUri('XYZ' + 'a'.repeat(61), 'name.md')).toThrow(/contentHash/);
  });

  it('rejects malformed hash (wrong length)', () => {
    expect(() => casUri('abc', 'name.md')).toThrow(/contentHash/);
    expect(() => casUri('a'.repeat(63), 'name.md')).toThrow(/contentHash/);
    expect(() => casUri('a'.repeat(65), 'name.md')).toThrow(/contentHash/);
  });

  it('lowercases hex (canonical form)', () => {
    const upper = 'A'.repeat(64);
    expect(casUri(upper, 'a.md')).toBe(`cas://sha256:${'a'.repeat(64)}/a.md`);
  });
});

describe('parseUri (cas + pvc + inline)', () => {
  it('parses cas://sha256:<hex>/<name> into scheme + hash + name', () => {
    const hex = '0123456789abcdef'.repeat(4); // 64 chars
    expect(parseUri(`cas://sha256:${hex}/digest.md`)).toEqual({
      scheme: 'cas',
      hash: hex,
      name: 'digest.md',
    });
  });

  it('parses nested cas names', () => {
    const hex = 'c'.repeat(64);
    expect(parseUri(`cas://sha256:${hex}/screenshots/01.png`)).toEqual({
      scheme: 'cas',
      hash: hex,
      name: 'screenshots/01.png',
    });
  });

  it('returns null on cas with malformed hash', () => {
    expect(parseUri('cas://sha256:abc/x.md')).toBeNull();
    expect(parseUri('cas://md5:abc/x.md')).toBeNull(); // wrong algo
    expect(parseUri('cas://sha256:/x.md')).toBeNull();
  });

  it('returns null on cas with no name', () => {
    expect(parseUri(`cas://sha256:${'a'.repeat(64)}`)).toBeNull();
    expect(parseUri(`cas://sha256:${'a'.repeat(64)}/`)).toBeNull();
  });

  it('parses pvc:// URIs into scheme + name (legacy back-compat)', () => {
    const parsed = parseUri('pvc://kagent-artifacts/uid-1/digest.md');
    expect(parsed?.scheme).toBe('pvc');
    expect(parsed?.name).toBe('digest.md');
  });

  it('parses inline://sha256:<hex> URIs into scheme + hash', () => {
    const hex = 'd'.repeat(64);
    expect(parseUri(`inline://sha256:${hex}`)).toEqual({
      scheme: 'inline',
      hash: hex,
    });
  });

  it('returns null on unknown scheme', () => {
    expect(parseUri('ftp://server/x')).toBeNull();
  });

  it('returns null on non-string', () => {
    expect(parseUri(undefined as unknown as string)).toBeNull();
    expect(parseUri('')).toBeNull();
  });
});

describe('isArtifactRef + contentHash', () => {
  it('accepts a ref with a valid sha256-hex contentHash', () => {
    expect(
      isArtifactRef({
        uri: 'cas://sha256:abc/x.md',
        contentHash: 'a'.repeat(64),
      }),
    ).toBe(true);
  });

  it('accepts a ref without contentHash (optional for inline://)', () => {
    expect(isArtifactRef({ uri: 'inline://sha256:abc' })).toBe(true);
  });

  it('rejects non-string contentHash', () => {
    expect(isArtifactRef({ uri: 'pvc://k/u/x', contentHash: 12 })).toBe(false);
  });
});
