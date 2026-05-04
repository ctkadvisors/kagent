/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `BlackboardClient` — narrow client surface the agent-pod's four
 * built-in tools (`read_blackboard`, `write_blackboard`,
 * `list_blackboard`, `append_blackboard`) call.
 *
 * The shape is JSON-only — keys are strings, values are JSON-
 * serializable values (`unknown` because we don't constrain payload
 * shape; the agent application owns its own per-key schema). All
 * transport-layer details (NATS wire format, key encoding, revision
 * tracking) live behind this surface so tests can substitute a pure
 * in-memory fake.
 *
 * Errors policy: each method REJECTS with a descriptive `Error` on:
 *   - transport failures (NATS not reachable, bucket missing)
 *   - value-size violations (too big to fit in the bucket's max_value_bytes)
 *   - revision mismatch on `cas()` (caller retries)
 *
 * Successful read of an absent key returns `null` (not an error).
 *
 * Production wiring lives in `nats-client.ts`; the agent-pod wires the
 * NATS-backed implementation at boot. Tests inject a `FakeBlackboardClient`
 * that backs onto a `Map<string, {value, revision}>`.
 */

/**
 * One blackboard entry as observed by `read()`. `revision` is the
 * NATS-supplied revision number (monotonic per key); `null` revisions
 * are not surfaced to the agent loop — the tool wrapper treats them
 * as "key absent" and returns `null` to the caller.
 */
export interface BlackboardEntry {
  readonly value: unknown;
  readonly revision: number;
}

/**
 * The thin client interface. Implementations must:
 *   - JSON-encode `unknown` to UTF-8 bytes on `put` / `cas` / `create`.
 *   - JSON-decode bytes on `read` (returns `null` on absent OR
 *     malformed entry; the malformed case logs to stderr but doesn't
 *     surface — a corrupt entry shouldn't poison the agent loop).
 */
export interface BlackboardClient {
  /**
   * Read the latest revision of `key`. Returns `null` when the key is
   * absent OR has been deleted (NATS soft-delete tombstones surface as
   * absent).
   */
  read(key: string): Promise<BlackboardEntry | null>;

  /**
   * Last-writer-wins put. Returns the new revision number. Throws on
   * transport / size / quota failures.
   */
  put(key: string, value: unknown): Promise<number>;

  /**
   * Compare-and-swap. Updates the entry iff its current revision is
   * `expectedRevision`. Throws a `RevisionMismatchError` when the
   * current revision differs (caller's append-loop catches and
   * retries). Returns the new revision on success.
   */
  cas(key: string, value: unknown, expectedRevision: number): Promise<number>;

  /**
   * Create-only put. Fails (with a `RevisionMismatchError` when the
   * key already exists. Used by `append_blackboard` to seed a key on
   * its first append without racing against another writer.
   */
  create(key: string, value: unknown): Promise<number>;

  /**
   * List keys. When `prefix` is provided, returns only keys whose
   * literal prefix matches (no glob semantics — the cap-gated read
   * patterns already do glob matching at the tool layer; this just
   * scopes the listing).
   *
   * Implementations cap results at `maxKeys` (default 1000) to bound
   * a runaway agent's listing cost.
   */
  list(prefix?: string, maxKeys?: number): Promise<readonly string[]>;
}

/**
 * Sentinel error subclass thrown by `cas()` and `create()` on revision
 * conflict. The `append_blackboard` tool's CAS-loop catches this and
 * retries; any other call site treats it as fatal and surfaces the
 * conflict to the agent loop as a `tool_error`.
 */
export class RevisionMismatchError extends Error {
  public readonly key: string;
  public readonly expectedRevision: number | undefined;
  public readonly currentRevision: number | undefined;
  constructor(
    key: string,
    expectedRevision: number | undefined,
    currentRevision: number | undefined,
  ) {
    super(
      `blackboard: revision mismatch for key "${key}" ` +
        `(expected=${expectedRevision === undefined ? 'absent' : String(expectedRevision)}, ` +
        `current=${currentRevision === undefined ? 'absent' : String(currentRevision)})`,
    );
    this.name = 'RevisionMismatchError';
    this.key = key;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}
