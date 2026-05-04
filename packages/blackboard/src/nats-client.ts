/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * NATS JetStream KV-backed `BlackboardClient`. Translates the narrow
 * `BlackboardClient` surface into NATS' `KV` calls.
 *
 * Connection management: the constructor takes a pre-resolved `KV`
 * handle. Booting (NATS `connect()` + `views.kv(name)`) is the
 * caller's responsibility — keeps the package free of NATS connection
 * lifecycle concerns and lets the agent-pod / operator share one
 * connection across blackboard + dispatcher + audit publishers.
 *
 * Encoding: values are JSON-encoded to UTF-8 bytes; reads JSON-decode.
 * `null` / `undefined` decoded values surface as `null` BlackboardEntry.
 *
 * Revision semantics:
 *   - `put(k, v)` → calls `kv.put(k, bytes)`; last-writer-wins.
 *   - `create(k, v)` → calls `kv.create(k, bytes)`. NATS rejects when
 *     the key already exists; we map the rejection to RevisionMismatchError.
 *   - `cas(k, v, rev)` → calls `kv.update(k, bytes, rev)`. NATS rejects
 *     on revision drift; we map to RevisionMismatchError.
 *
 * Listing: NATS' `kv.keys(filter?)` returns an async iterator. We
 * collect into an array bounded by `maxKeys` and use a NATS-side
 * subject filter when possible (literal-prefix → `<prefix>.>`-style
 * filter); falls back to a client-side prefix filter for non-NATS-
 * compatible prefixes.
 */

import type { BlackboardClient, BlackboardEntry } from './client.js';
import { RevisionMismatchError } from './client.js';

/**
 * Minimal subset of NATS' `KV` interface we depend on. Kept narrow so
 * tests can stub without dragging in the full nats.js types and so
 * we have a single place to swap implementations if the NATS API
 * shape changes between minor versions.
 */
export interface KvLike {
  get(key: string): Promise<{ value: Uint8Array; revision: number; operation?: string } | null>;
  put(key: string, data: Uint8Array): Promise<number>;
  create(key: string, data: Uint8Array): Promise<number>;
  update(key: string, data: Uint8Array, revision: number): Promise<number>;
  keys(filter?: string | string[]): Promise<AsyncIterable<string>>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

const DEFAULT_LIST_CAP = 1000;

/**
 * Build a NATS-backed BlackboardClient. The `kv` arg is a resolved
 * `KV` handle (typically `await js.views.kv('kagent-kv-<root-uid>')`).
 */
export class NatsBlackboardClient implements BlackboardClient {
  private readonly kv: KvLike;
  private readonly maxValueBytes: number | undefined;

  constructor(opts: { readonly kv: KvLike; readonly maxValueBytes?: number }) {
    this.kv = opts.kv;
    this.maxValueBytes = opts.maxValueBytes;
  }

  async read(key: string): Promise<BlackboardEntry | null> {
    let entry: { value: Uint8Array; revision: number; operation?: string } | null;
    try {
      entry = await this.kv.get(key);
    } catch (err) {
      throw new Error(
        `blackboard.read("${key}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (entry === null) return null;
    // NATS KV emits soft-delete tombstones with operation === 'DEL' or 'PURGE'.
    // Surface them as "absent" so the tool caller doesn't see internal markers.
    if (entry.operation === 'DEL' || entry.operation === 'PURGE') return null;
    return decodeEntry(entry.value, entry.revision);
  }

  async put(key: string, value: unknown): Promise<number> {
    const bytes = this.encodeValueOrThrow(key, value);
    try {
      return await this.kv.put(key, bytes);
    } catch (err) {
      throw new Error(
        `blackboard.put("${key}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async cas(key: string, value: unknown, expectedRevision: number): Promise<number> {
    const bytes = this.encodeValueOrThrow(key, value);
    try {
      return await this.kv.update(key, bytes, expectedRevision);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (looksLikeRevisionConflict(msg)) {
        // Read current to surface the actual revision in the thrown
        // error — keeps the CAS-loop's diagnostics legible without an
        // extra round-trip on the happy path.
        let current: number | undefined;
        try {
          const e = await this.kv.get(key);
          current = e === null ? undefined : e.revision;
        } catch {
          // ignore — we'd rather throw the original conflict than
          // mask it with a fetch-current failure
        }
        throw new RevisionMismatchError(key, expectedRevision, current);
      }
      throw new Error(`blackboard.cas("${key}") failed: ${msg}`);
    }
  }

  async create(key: string, value: unknown): Promise<number> {
    const bytes = this.encodeValueOrThrow(key, value);
    try {
      return await this.kv.create(key, bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (looksLikeRevisionConflict(msg) || /key.*exist/i.test(msg)) {
        let current: number | undefined;
        try {
          const e = await this.kv.get(key);
          current = e === null ? undefined : e.revision;
        } catch {
          // ignore
        }
        throw new RevisionMismatchError(key, undefined, current);
      }
      throw new Error(`blackboard.create("${key}") failed: ${msg}`);
    }
  }

  async list(prefix?: string, maxKeys: number = DEFAULT_LIST_CAP): Promise<readonly string[]> {
    const cap = Number.isInteger(maxKeys) && maxKeys > 0 ? maxKeys : DEFAULT_LIST_CAP;
    let iterable: AsyncIterable<string>;
    try {
      iterable = await this.kv.keys();
    } catch (err) {
      throw new Error(
        `blackboard.list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const out: string[] = [];
    for await (const k of iterable) {
      if (prefix !== undefined && prefix.length > 0 && !k.startsWith(prefix)) continue;
      out.push(k);
      if (out.length >= cap) break;
    }
    return out;
  }

  private encodeValueOrThrow(key: string, value: unknown): Uint8Array {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch (err) {
      throw new Error(
        `blackboard: value for key "${key}" is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (serialized === undefined) {
      // JSON.stringify returns undefined for `undefined` / functions /
      // symbols. Refuse explicitly so the agent loop sees a clear
      // error instead of NATS rejecting an empty payload later.
      throw new Error(
        `blackboard: value for key "${key}" must be JSON-serializable (got ${typeof value})`,
      );
    }
    const bytes = encoder.encode(serialized);
    if (this.maxValueBytes !== undefined && bytes.byteLength > this.maxValueBytes) {
      throw new Error(
        `blackboard: value for key "${key}" is ${String(bytes.byteLength)} bytes (max=${String(this.maxValueBytes)})`,
      );
    }
    return bytes;
  }
}

/**
 * Decode a stored entry. Treats decode failures as "absent" so a
 * single corrupt write can't poison every read of the same bucket.
 * Logs the corruption to stderr — operators see it in pod logs.
 */
function decodeEntry(bytes: Uint8Array, revision: number): BlackboardEntry | null {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    console.warn('[kagent-blackboard] read: undecodable bytes, returning null');
    return null;
  }
  if (text.length === 0) {
    return { value: null, revision };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return { value: parsed, revision };
  } catch (err) {
    console.warn(
      `[kagent-blackboard] read: malformed JSON, returning null: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Heuristic — does this NATS error message indicate a revision
 * conflict? NATS' `KV.update()` rejects with a `wrong last sequence`
 * style message; `KV.create()` with `key already exists`. Both are
 * surfaceable to the caller as a `RevisionMismatchError` so the
 * append-loop can retry without parsing brittle error codes.
 */
function looksLikeRevisionConflict(msg: string): boolean {
  return (
    /wrong last sequence/i.test(msg) ||
    /sequence mismatch/i.test(msg) ||
    /\b10071\b/.test(msg) || // NATS error code for last-seq mismatch
    /\b10058\b/.test(msg) // NATS error code for key-exists on create
  );
}
