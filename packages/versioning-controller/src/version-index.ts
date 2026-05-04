/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Multi-version Agent registry — Wave 4 / Versioning sub-team
 * (v0.5.3-versioning).
 *
 * Per docs/WAVES.md §6.4 deliverable 4: operators MAY publish a NEW
 * Agent CR with the SAME `metadata.name` AND a NEW `spec.version`.
 * The operator treats each (name, version) pair as a distinct Agent.
 * The index here is the authoritative read-side surface:
 *
 *   - `onAdd(agent)`     — informer's add+update path; upserts the
 *                          (name, version) entry. Updating an existing
 *                          (name, version) overwrites the cached CR
 *                          (Agent CRs are immutable post-publish per
 *                          the webhook, but the informer may re-emit
 *                          the same object on resync).
 *   - `onDelete(agent)`  — informer's delete path; removes the
 *                          (name, version) entry. When the last
 *                          version of a name is deleted, the bucket
 *                          itself is dropped.
 *   - `lookupExact(name, version) → Agent | undefined` — pinned
 *                          dispatch path. Reconciler uses this when
 *                          building the Job spec for an AgentTask
 *                          whose `status.agentVersion` is already
 *                          stamped.
 *   - `lookupLatest(name) → Agent | undefined` — version-resolution
 *                          path. Admission uses this to stamp
 *                          `AgentTask.status.agentVersion` for new
 *                          tasks (no `agentVersion` on admission).
 *   - `versionsOf(name) → readonly string[]` — diagnostic surface.
 *
 * Comparison is LEXICAL — `compareVersions('1.10.0', '1.2.0') > 0`
 * which differs from semver! The substrate never parses semver. Agent
 * authors are expected to use ZERO-PADDED segments
 * (`'1.02.00'`) when they need lexical-correct ordering, OR rely on
 * monotonic publication order (the index also tracks the
 * insertionOrder so `lookupLatest` can fall back to "most-recently
 * upserted" when several versions tie lexically — same idea as
 * `Map.set` ordering).
 *
 * Operator sources this from `Agent` informer events. Tests construct
 * the index directly + drive `onAdd` / `onDelete`.
 */

import { DEFAULT_AGENT_VERSION } from './constants.js';
import type { VersionedAgent } from './types.js';

/**
 * Per-name registry entry. Keyed by version string; carries the most
 * recent CR observed for each version + the insertion sequence so
 * `lookupLatest` can break ties.
 */
export interface AgentVersionIndexEntry {
  readonly version: string;
  readonly agent: VersionedAgent;
  readonly insertedSeq: number;
}

/**
 * Read-only lookup surface the operator wires to `task-admission.ts`.
 * Defining this as a separate interface lets tests pass an
 * in-memory Map-backed implementation without owning a full
 * `AgentVersionIndex`.
 */
export interface AgentVersionLookup {
  /**
   * Return the Agent CR exactly matching (name, version). Used by the
   * Job-spec builder when `AgentTask.status.agentVersion` is set.
   */
  lookupExact(namespace: string, name: string, version: string): VersionedAgent | undefined;
  /**
   * Return the LATEST version of an Agent named `name` in the given
   * namespace. "Latest" = lexically-greatest version with insertion
   * order as the tiebreaker. Returns undefined when the index has no
   * Agent of that name in that namespace.
   */
  lookupLatest(namespace: string, name: string): VersionedAgent | undefined;
  /**
   * Diagnostic surface — list versions known for a given (namespace,
   * name) tuple, lexically sorted ascending.
   */
  versionsOf(namespace: string, name: string): readonly string[];
}

interface InternalBucket {
  readonly versions: Map<string, AgentVersionIndexEntry>;
  /** Insertion sequence; used as the tiebreaker on `lookupLatest`. */
  insertionCounter: number;
}

/**
 * Authoritative implementation. Pure in-memory; no I/O. The operator's
 * Agent informer drives onAdd/onDelete; the registry survives a
 * watch-restart by re-population (informers always emit a snapshot on
 * `start()`).
 */
export class AgentVersionIndex implements AgentVersionLookup {
  /** namespace → name → bucket. */
  private readonly byKey = new Map<string, InternalBucket>();
  /** Process-wide monotonic sequence counter. */
  private seq = 0;

  /**
   * Upsert the (name, version) entry. Overwriting an existing entry
   * is intentional: informer resync re-emits the same object; the
   * webhook keeps the spec stable.
   *
   * Returns `'inserted'` for a new (name, version) pair (admission
   * fires `agent.published`), `'updated'` for re-emission (no audit
   * event — the operator's Agent informer suppresses these via
   * `metadata.resourceVersion` equality).
   */
  onAdd(agent: VersionedAgent): 'inserted' | 'updated' {
    const namespace = agent.metadata.namespace ?? 'default';
    const name = agent.metadata.name;
    if (typeof name !== 'string' || name.length === 0) return 'updated';
    const version = resolveAgentVersion(agent);
    const key = `${namespace}/${name}`;
    let bucket = this.byKey.get(key);
    if (bucket === undefined) {
      bucket = { versions: new Map(), insertionCounter: 0 };
      this.byKey.set(key, bucket);
    }
    const existed = bucket.versions.has(version);
    bucket.versions.set(version, {
      version,
      agent,
      insertedSeq: existed
        ? (bucket.versions.get(version)?.insertedSeq ?? this.seq++)
        : (() => {
            bucket.insertionCounter += 1;
            return ++this.seq;
          })(),
    });
    return existed ? 'updated' : 'inserted';
  }

  /**
   * Remove the (name, version) entry. The bucket is dropped when its
   * last entry leaves so a re-add of the name from scratch starts
   * with insertion-counter zero (matters only for the tiebreaker).
   */
  onDelete(agent: VersionedAgent): 'removed' | 'not-found' {
    const namespace = agent.metadata.namespace ?? 'default';
    const name = agent.metadata.name;
    if (typeof name !== 'string' || name.length === 0) return 'not-found';
    const version = resolveAgentVersion(agent);
    const key = `${namespace}/${name}`;
    const bucket = this.byKey.get(key);
    if (bucket === undefined) return 'not-found';
    const removed = bucket.versions.delete(version);
    if (!removed) return 'not-found';
    if (bucket.versions.size === 0) this.byKey.delete(key);
    return 'removed';
  }

  lookupExact(namespace: string, name: string, version: string): VersionedAgent | undefined {
    const bucket = this.byKey.get(`${namespace}/${name}`);
    if (bucket === undefined) return undefined;
    return bucket.versions.get(version)?.agent;
  }

  lookupLatest(namespace: string, name: string): VersionedAgent | undefined {
    const bucket = this.byKey.get(`${namespace}/${name}`);
    if (bucket === undefined || bucket.versions.size === 0) return undefined;
    let winner: AgentVersionIndexEntry | undefined;
    for (const entry of bucket.versions.values()) {
      if (winner === undefined) {
        winner = entry;
        continue;
      }
      const cmp = compareVersions(entry.version, winner.version);
      if (cmp > 0) {
        winner = entry;
      } else if (cmp === 0 && entry.insertedSeq > winner.insertedSeq) {
        // Tiebreaker: most-recently inserted wins.
        winner = entry;
      }
    }
    return winner?.agent;
  }

  versionsOf(namespace: string, name: string): readonly string[] {
    const bucket = this.byKey.get(`${namespace}/${name}`);
    if (bucket === undefined) return [];
    return [...bucket.versions.keys()].sort(compareVersions);
  }

  /**
   * Test / diagnostic surface. Returns the live count of distinct
   * (namespace, name, version) triples in the index.
   */
  size(): number {
    let n = 0;
    for (const bucket of this.byKey.values()) n += bucket.versions.size;
    return n;
  }

  /**
   * Test surface — clear the index.
   */
  reset(): void {
    this.byKey.clear();
    this.seq = 0;
  }

  /**
   * Iterate every (namespace, name, version, agent) tuple. Used by
   * the deprecation sweeper to evaluate lifecycle status across all
   * registered Agents.
   */
  *entries(): IterableIterator<{
    readonly namespace: string;
    readonly name: string;
    readonly version: string;
    readonly agent: VersionedAgent;
  }> {
    for (const [key, bucket] of this.byKey) {
      const slash = key.indexOf('/');
      const namespace = key.slice(0, slash);
      const name = key.slice(slash + 1);
      for (const entry of bucket.versions.values()) {
        yield { namespace, name, version: entry.version, agent: entry.agent };
      }
    }
  }
}

/**
 * Lexical version compare. Substrate never parses semver — Agent
 * authors who need numeric ordering should zero-pad
 * (e.g. `'01.02.03'` instead of `'1.2.3'`).
 *
 * Returns:
 *   - `< 0` when a sorts before b
 *   - `0`   when a === b
 *   - `> 0` when a sorts after b
 */
export function compareVersions(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Resolve the effective version of an Agent CR. Falls back to
 * `DEFAULT_AGENT_VERSION` when `spec.version` is absent / empty —
 * matches the admission-time defaulting behavior so the index never
 * stores an entry under `version: undefined`.
 */
export function resolveAgentVersion(agent: VersionedAgent): string {
  const raw = (agent.spec as { version?: unknown }).version;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return DEFAULT_AGENT_VERSION;
}
