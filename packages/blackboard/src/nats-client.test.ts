/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/* eslint-disable @typescript-eslint/require-await -- in-memory KV stub
 * methods match the async signature of nats.js's KV without doing any
 * I/O; the await-less bodies are intentional.
 */

import { describe, expect, it } from 'vitest';

import { RevisionMismatchError } from './client.js';
import type { KvLike } from './nats-client.js';
import { NatsBlackboardClient } from './nats-client.js';

const encoder = new TextEncoder();

interface FakeEntry {
  bytes: Uint8Array;
  revision: number;
}

/**
 * In-memory KV stub. Mirrors NATS' surface tightly enough that the
 * client can be unit-tested without standing up a real broker.
 */
function makeFakeKv(): KvLike & {
  store: Map<string, FakeEntry>;
} {
  const store = new Map<string, FakeEntry>();
  let nextRevision = 1;
  const allocRev = (): number => nextRevision++;
  return {
    store,
    async get(key) {
      const entry = store.get(key);
      if (entry === undefined) return null;
      return { value: entry.bytes, revision: entry.revision };
    },
    async put(key, data) {
      const rev = allocRev();
      store.set(key, { bytes: data, revision: rev });
      return rev;
    },
    async create(key, data) {
      if (store.has(key)) {
        throw new Error('key already exists (10058)');
      }
      const rev = allocRev();
      store.set(key, { bytes: data, revision: rev });
      return rev;
    },
    async update(key, data, expectedRev) {
      const entry = store.get(key);
      if (entry === undefined) {
        throw new Error('wrong last sequence: key absent');
      }
      if (entry.revision !== expectedRev) {
        throw new Error(`wrong last sequence: ${String(entry.revision)}`);
      }
      const rev = allocRev();
      store.set(key, { bytes: data, revision: rev });
      return rev;
    },
    async keys() {
      const all = [...store.keys()];
      return (async function* () {
        for (const k of all) yield k;
      })();
    },
  };
}

describe('NatsBlackboardClient', () => {
  it('round-trips JSON values via put/read', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv });
    const rev = await client.put('foo', { hello: 'world', n: 42 });
    expect(rev).toBeGreaterThan(0);
    const entry = await client.read('foo');
    expect(entry).not.toBeNull();
    expect(entry?.value).toEqual({ hello: 'world', n: 42 });
    expect(entry?.revision).toBe(rev);
  });

  it('returns null for an absent key', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv });
    expect(await client.read('absent')).toBeNull();
  });

  it('returns null for a soft-deleted entry', async () => {
    const kv = makeFakeKv();
    // Manually seed a tombstone-shaped entry.
    kv.store.set('tomb', { bytes: encoder.encode('null'), revision: 99 });
    const baseGet = kv.get.bind(kv);
    kv.get = async (key) => {
      const e = await baseGet(key);
      if (e === null) return null;
      return { ...e, operation: 'DEL' };
    };
    const client = new NatsBlackboardClient({ kv });
    expect(await client.read('tomb')).toBeNull();
  });

  it('throws RevisionMismatchError on cas conflict', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv });
    const rev1 = await client.put('k', 1);
    await expect(client.cas('k', 2, rev1 + 999)).rejects.toBeInstanceOf(RevisionMismatchError);
  });

  it('cas succeeds when revision matches', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv });
    const rev1 = await client.put('k', 'v1');
    const rev2 = await client.cas('k', 'v2', rev1);
    expect(rev2).toBeGreaterThan(rev1);
    expect((await client.read('k'))?.value).toBe('v2');
  });

  it('create rejects when key exists, throwing RevisionMismatchError', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv });
    await client.put('k', 'v1');
    await expect(client.create('k', 'v2')).rejects.toBeInstanceOf(RevisionMismatchError);
  });

  it('list returns all keys without prefix', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv });
    await client.put('a', 1);
    await client.put('b', 2);
    await client.put('c', 3);
    const keys = await client.list();
    expect([...keys].sort()).toEqual(['a', 'b', 'c']);
  });

  it('list filters by prefix', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv });
    await client.put('foo.1', 1);
    await client.put('foo.2', 2);
    await client.put('bar.1', 3);
    const keys = await client.list('foo.');
    expect([...keys].sort()).toEqual(['foo.1', 'foo.2']);
  });

  it('list caps at maxKeys', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv });
    for (let i = 0; i < 10; i++) await client.put(`k${String(i)}`, i);
    const keys = await client.list(undefined, 3);
    expect(keys.length).toBe(3);
  });

  it('refuses non-JSON-serializable values', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv });
    await expect(client.put('k', () => 1)).rejects.toThrow(/JSON-serializable/);
  });

  it('refuses values exceeding maxValueBytes', async () => {
    const kv = makeFakeKv();
    const client = new NatsBlackboardClient({ kv, maxValueBytes: 16 });
    await expect(client.put('k', 'x'.repeat(100))).rejects.toThrow(/bytes \(max=16\)/);
  });
});
