/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  casShardPath,
  hashBytes,
  PvcCasBackend,
  S3CasBackend,
  type CasBackend,
} from './cas-backend.js';

function freshMount(): string {
  return mkdtempSync(join(tmpdir(), 'kagent-cas-test-'));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('hashBytes', () => {
  it('returns a 64-char lowercase-hex sha256', () => {
    const h = hashBytes(new TextEncoder().encode('hello'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('casShardPath', () => {
  it('shards into <root>/cas/sha256/<first-2-hex>/<remaining-62-hex>', () => {
    const hex = 'a'.repeat(64);
    const path = casShardPath('/var/kagent/cas', hex);
    expect(path).toBe(`/var/kagent/cas${sep}cas${sep}sha256${sep}aa${sep}${'a'.repeat(62)}`);
  });

  it('throws on malformed hash', () => {
    expect(() => casShardPath('/x', 'abc')).toThrow(/malformed sha256 hex/);
  });
});

describe('PvcCasBackend round-trip', () => {
  let mount: string;

  beforeEach(() => {
    mount = freshMount();
  });

  afterEach(() => {
    rmSync(mount, { recursive: true, force: true });
  });

  it('writes bytes, returns canonical cas:// URI + contentHash', async () => {
    const backend: CasBackend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('hello world');
    const expectedHash = sha256(bytes);

    const result = await backend.write(bytes, 'greeting.txt');

    expect(result.contentHash).toBe(expectedHash);
    expect(result.uri).toBe(`cas://sha256:${expectedHash}/greeting.txt`);
  });

  it('writes bytes onto the sharded layout', async () => {
    const backend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('shard me');
    const expected = sha256(bytes);

    await backend.write(bytes, 'shard.txt');

    const onDisk = backend.pathForHash(expected);
    expect(existsSync(onDisk)).toBe(true);
    expect(onDisk).toContain(`${sep}cas${sep}sha256${sep}${expected.slice(0, 2)}${sep}`);
    expect(readFileSync(onDisk).toString('utf-8')).toBe('shard me');
  });

  it('round-trips identical bytes via read()', async () => {
    const backend: CasBackend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('round-trip me');

    const { uri } = await backend.write(bytes, 'rt.txt');
    const read = await backend.read(uri);

    expect(Buffer.from(read).toString('utf-8')).toBe('round-trip me');
  });

  it('detects hash mismatch on read (corrupted blob)', async () => {
    const backend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('original');
    const { uri, contentHash } = await backend.write(bytes, 'corrupt.txt');

    // Tamper with the bytes on disk.
    const path = backend.pathForHash(contentHash);
    writeFileSync(path, 'tampered');

    await expect(backend.read(uri)).rejects.toThrow(/hash mismatch/);
  });

  it('exists() returns true after write and false for unknown hash', async () => {
    const backend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('exists');
    const { contentHash } = await backend.write(bytes, 'e.txt');

    expect(await backend.exists(contentHash)).toBe(true);
    expect(await backend.exists('a'.repeat(64))).toBe(false);
  });

  it('exists() returns false on malformed hash', async () => {
    const backend = new PvcCasBackend(mount);
    expect(await backend.exists('not-a-hash')).toBe(false);
  });

  it('writes are idempotent (same bytes → same path, no duplicate work)', async () => {
    const backend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('idempotent');

    const r1 = await backend.write(bytes, 'a.txt');
    const r2 = await backend.write(bytes, 'b.txt'); // different name, same bytes

    expect(r1.contentHash).toBe(r2.contentHash);
    // Same hash → same path on disk regardless of name.
    expect(backend.pathForHash(r1.contentHash)).toBe(backend.pathForHash(r2.contentHash));
  });

  it('rejects non-Uint8Array bytes', async () => {
    const backend = new PvcCasBackend(mount);
    await expect(backend.write('not-bytes' as unknown as Uint8Array, 'x.txt')).rejects.toThrow(
      /Uint8Array/,
    );
  });

  it('rejects empty / leading-slash / .. names', async () => {
    const backend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('x');
    await expect(backend.write(bytes, '')).rejects.toThrow();
    await expect(backend.write(bytes, '/abs.txt')).rejects.toThrow();
    await expect(backend.write(bytes, '../escape.txt')).rejects.toThrow();
    await expect(backend.write(bytes, 'a/../b.txt')).rejects.toThrow();
  });

  it('rejects malformed cas:// URI on read', async () => {
    const backend = new PvcCasBackend(mount);
    await expect(backend.read('pvc://x/y/z.txt')).rejects.toThrow(/cas:\/\//);
    await expect(backend.read('cas://md5:abc/x.txt')).rejects.toThrow(/sha256/);
    await expect(backend.read('cas://sha256:abc/x.txt')).rejects.toThrow(/malformed sha256 hex/);
    await expect(backend.read('cas://sha256:' + 'a'.repeat(64))).rejects.toThrow(/missing name/);
  });

  it('constructor rejects empty mountPath', () => {
    expect(() => new PvcCasBackend('')).toThrow(/mountPath required/);
  });

  it('handles 0-byte writes', async () => {
    const backend = new PvcCasBackend(mount);
    const empty = new Uint8Array(0);
    const { uri, contentHash } = await backend.write(empty, 'empty.txt');
    // sha256 of empty string is well-known.
    expect(contentHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const read = await backend.read(uri);
    expect(read.byteLength).toBe(0);
  });
});

describe('S3CasBackend stub', () => {
  it('constructor accepts options', () => {
    const backend = new S3CasBackend({ bucket: 'kagent-cas' });
    expect(backend.getOptions().bucket).toBe('kagent-cas');
  });

  it('constructor rejects missing bucket', () => {
    expect(() => new S3CasBackend({} as never)).toThrow(/bucket required/);
    expect(() => new S3CasBackend({ bucket: '' })).toThrow(/bucket required/);
  });

  it('read() throws "S3 backend coming in v0.3"', async () => {
    const backend = new S3CasBackend({ bucket: 'b' });
    await expect(backend.read('cas://sha256:' + 'a'.repeat(64) + '/x.txt')).rejects.toThrow(
      /S3 backend coming in v0.3/,
    );
  });

  it('write() throws "S3 backend coming in v0.3"', async () => {
    const backend = new S3CasBackend({ bucket: 'b' });
    await expect(backend.write(new Uint8Array(0), 'x.txt')).rejects.toThrow(
      /S3 backend coming in v0.3/,
    );
  });

  it('exists() throws "S3 backend coming in v0.3"', async () => {
    const backend = new S3CasBackend({ bucket: 'b' });
    await expect(backend.exists('a'.repeat(64))).rejects.toThrow(/S3 backend coming in v0.3/);
  });

  it('preserves caller-supplied options', () => {
    const backend = new S3CasBackend({
      bucket: 'kagent-cas',
      endpoint: 'http://minio.example:9000',
      region: 'us-west-2',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
    });
    const opts = backend.getOptions();
    expect(opts.bucket).toBe('kagent-cas');
    expect(opts.endpoint).toBe('http://minio.example:9000');
    expect(opts.region).toBe('us-west-2');
    expect(opts.credentials?.accessKeyId).toBe('AKIA');
  });
});
