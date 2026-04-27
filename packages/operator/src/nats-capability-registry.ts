/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * NATS JetStream KV-backed `CapabilityRegistry`. Reads the
 * `agents-live` bucket where each entry is keyed by `agentId` and
 * the value is a JSON `{capabilities, lastHeartbeatMs}` document.
 *
 * Resolution semantics: scan all live entries; return the first
 * agent whose `capabilities` array contains the requested tag. In
 * v0.1 we don't filter by heartbeat freshness — entry presence is
 * good enough since the KV bucket is configured with a TTL upstream.
 *
 * Lazy connection (matches NatsDispatcher pattern). Tests inject a
 * stubbed `KvBucketLike` instead of standing up real NATS.
 */

export interface AgentLiveEntry {
  readonly capabilities: readonly string[];
  readonly lastHeartbeatMs: number;
}

/**
 * Narrow contract over the part of NATS KV we use. `keys()` yields
 * agentIds; `get(key)` reads the JSON-encoded entry.
 */
export interface KvBucketLike {
  keys(): AsyncIterable<string>;
  get(key: string): Promise<{ value: Uint8Array } | null>;
}

export type KvBucketFactory = () => Promise<KvBucketLike>;

import type { CapabilityRegistry } from './capability-registry.js';

const decoder = new TextDecoder();

export class NatsCapabilityRegistry implements CapabilityRegistry {
  private readonly factory: KvBucketFactory;
  private bucket: KvBucketLike | undefined;

  constructor(factory: KvBucketFactory) {
    this.factory = factory;
  }

  async resolveCapability(capability: string): Promise<string | null> {
    const bucket = await this.ensureBucket();
    for await (const agentId of bucket.keys()) {
      const entry = await bucket.get(agentId);
      if (entry === null) continue;
      const parsed = parseEntry(entry.value);
      if (parsed === null) continue;
      if (parsed.capabilities.includes(capability)) {
        return agentId;
      }
    }
    return null;
  }

  private async ensureBucket(): Promise<KvBucketLike> {
    if (this.bucket === undefined) {
      this.bucket = await this.factory();
    }
    return this.bucket;
  }
}

function parseEntry(raw: Uint8Array): AgentLiveEntry | null {
  try {
    const obj = JSON.parse(decoder.decode(raw)) as unknown;
    if (typeof obj !== 'object' || obj === null) return null;
    const e = obj as { capabilities?: unknown; lastHeartbeatMs?: unknown };
    if (!Array.isArray(e.capabilities)) return null;
    if (typeof e.lastHeartbeatMs !== 'number') return null;
    if (!e.capabilities.every((c) => typeof c === 'string')) return null;
    return {
      capabilities: e.capabilities,
      lastHeartbeatMs: e.lastHeartbeatMs,
    };
  } catch {
    return null;
  }
}
