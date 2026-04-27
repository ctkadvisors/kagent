/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { NatsCapabilityRegistry, type KvBucketLike } from './nats-capability-registry.js';

const enc = new TextEncoder();
const json = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));

function makeBucket(entries: Record<string, unknown>): KvBucketLike {
  return {
    async *keys(): AsyncIterable<string> {
      for (const k of Object.keys(entries)) {
        yield k;
        await Promise.resolve();
      }
    },
    get(key: string): Promise<{ value: Uint8Array } | null> {
      const v = entries[key];
      if (v === undefined) return Promise.resolve(null);
      return Promise.resolve({ value: json(v) });
    },
  };
}

describe('NatsCapabilityRegistry', () => {
  it('opens the KV bucket lazily', async () => {
    let called = 0;
    const r = new NatsCapabilityRegistry(() => {
      called += 1;
      return Promise.resolve(makeBucket({}));
    });
    expect(called).toBe(0);
    await r.resolveCapability('research');
    expect(called).toBe(1);
    await r.resolveCapability('research');
    expect(called).toBe(1); // reused
  });

  it('returns the first agent whose capabilities array includes the tag', async () => {
    const bucket = makeBucket({
      researcher: { capabilities: ['research', 'fetch'], lastHeartbeatMs: 100 },
      summarizer: { capabilities: ['summary'], lastHeartbeatMs: 100 },
    });
    const r = new NatsCapabilityRegistry(() => Promise.resolve(bucket));
    expect(await r.resolveCapability('research')).toBe('researcher');
    expect(await r.resolveCapability('summary')).toBe('summarizer');
  });

  it('returns null when no agent satisfies the capability', async () => {
    const bucket = makeBucket({
      researcher: { capabilities: ['research'], lastHeartbeatMs: 100 },
    });
    const r = new NatsCapabilityRegistry(() => Promise.resolve(bucket));
    expect(await r.resolveCapability('summary')).toBeNull();
  });

  it('skips entries with malformed JSON / missing fields', async () => {
    const bucket = makeBucket({
      'bad-shape': { wrongField: 'oops' },
      researcher: { capabilities: ['research'], lastHeartbeatMs: 100 },
    });
    const r = new NatsCapabilityRegistry(() => Promise.resolve(bucket));
    expect(await r.resolveCapability('research')).toBe('researcher');
  });

  it('skips entries with non-string capability items', async () => {
    const bucket = makeBucket({
      'mixed-types': { capabilities: [1, 2, 3], lastHeartbeatMs: 100 },
    });
    const r = new NatsCapabilityRegistry(() => Promise.resolve(bucket));
    expect(await r.resolveCapability('research')).toBeNull();
  });

  it('returns null when the bucket is empty', async () => {
    const r = new NatsCapabilityRegistry(() => Promise.resolve(makeBucket({})));
    expect(await r.resolveCapability('research')).toBeNull();
  });
});
