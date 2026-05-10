/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 4 / REV-01 — /api/review-queue route tests (Wave 1, Plan 04-02).
 *
 * Covers:
 *   - GET / returns 200 with { items: ReviewQueueRow[] }; every row passes assertIsReviewQueueRow
 *   - verifier-failed fires with correct fields
 *   - suspicious-detector fires with correct fields
 *   - human-review-requested fires with correct fields
 *   - candidate-template fires with correct fields
 *   - candidate-template WITHOUT matching artifact is OMITTED
 *   - already-decided task is SKIPPED
 *   - priority: verifier-failed beats suspicious-detector
 *   - sort descending by stalenessSeconds (oldest first)
 *   - replay-divergence and eval-failed are zero-producer in v0.2 (D-04)
 *   - reload-stability: two consecutive GETs return identical row content
 *     modulo stalenessSeconds (which is zero with a fixed clock)
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertIsReviewQueueRow, type ReviewQueueRow } from '@kagent/dto';
import type { AgentTask } from '@kagent/dto';

import reviewQueueFixture from '../__fixtures__/review-queue-snapshot.json' with { type: 'json' };

import { reviewQueueRoute, type ReviewQueueRouteDeps } from './review-queue.js';
import { SnapshotCache } from '../cache.js';

// ---------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------

/** Cast the JSON fixture to strongly-typed AgentTask objects. */
const allFixtureTasks = reviewQueueFixture as unknown as readonly AgentTask[];

/** Fixed clock for deterministic stalenessSeconds assertions. */
const fixedNow = new Date('2026-05-10T12:00:00.000Z');

// ---------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------

/**
 * Build a stub cache from an array of tasks. Uses the stub form to
 * avoid needing the full SnapshotCache infrastructure.
 */
function makeStubCache(tasks: readonly AgentTask[]): SnapshotCache {
  return {
    listTasks: () => tasks,
    getTask: (namespace: string, name: string) =>
      tasks.find((t) => t.metadata.namespace === namespace && t.metadata.name === name),
  } as unknown as SnapshotCache;
}

/**
 * Mount the reviewQueueRoute factory and return a fetch closure for
 * asserting the GET / response. Mirrors the dispositions.test.ts
 * `mountAndFetch` helper.
 */
function mountAndFetch(deps: ReviewQueueRouteDeps): {
  readonly fetch: (path?: string) => Promise<Response>;
} {
  const app = new Hono();
  app.route('/', reviewQueueRoute(deps));
  return {
    fetch: (path = '/') => app.request(path),
  };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe('GET /api/review-queue', () => {
  beforeEach(() => {
    // Selective fake-timer form — does NOT break app.request() await.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ------------------------------------------------------------------
  // Test 1 — baseline shape
  // ------------------------------------------------------------------

  it('Test 1 — GET / returns 200 with { items: ReviewQueueRow[] }; empty cache → items: []', async () => {
    const { fetch } = mountAndFetch({
      cache: makeStubCache([]),
      now: () => fixedNow,
    });
    const response = await fetch();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // Test 2 — assertIsReviewQueueRow drift-defense (fixture-driven)
  // ------------------------------------------------------------------

  it('Test 2 — every emitted row passes assertIsReviewQueueRow (drift defense)', async () => {
    const { fetch } = mountAndFetch({
      cache: makeStubCache(allFixtureTasks),
      now: () => fixedNow,
    });
    const response = await fetch();
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(() => assertIsReviewQueueRow(item)).not.toThrow();
    }
  });

  // ------------------------------------------------------------------
  // Test 3 — verifier-failed fires
  // ------------------------------------------------------------------

  it('Test 3 — verifier-failed fires with correct fields', async () => {
    const task = allFixtureTasks.find((t) => t.metadata.name === 'researcher-verifier-fail-01');
    expect(task).toBeDefined();

    const { fetch } = mountAndFetch({
      cache: makeStubCache([task!]),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.reason).toBe('verifier-failed');
    expect(body.items[0]?.reasonDetail).toBe('verifier_returned_non_json');
    expect(body.items[0]?.verifierError).toBe('verifier_returned_non_json');
    // enqueuedAt = verification.completedAt
    expect(body.items[0]?.enqueuedAt).toBe('2026-05-10T08:05:00.000Z');
    expect(body.items[0]?.taskRef.uid).toBe('uid-verifier-fail-01');
    expect(body.items[0]?.taskRef.namespace).toBe('kagent-system');
    expect(body.items[0]?.taskRef.name).toBe('researcher-verifier-fail-01');
  });

  // ------------------------------------------------------------------
  // Test 4 — suspicious-detector fires
  // ------------------------------------------------------------------

  it('Test 4 — suspicious-detector fires with correct fields', async () => {
    const task = allFixtureTasks.find((t) => t.metadata.name === 'researcher-suspicious-01');
    expect(task).toBeDefined();

    const { fetch } = mountAndFetch({
      cache: makeStubCache([task!]),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.reason).toBe('suspicious-detector');
    expect(body.items[0]?.reasonDetail).toBe('hallucination-pattern, unexpected-tool-use');
    expect(body.items[0]?.suspicious).toEqual(['hallucination-pattern', 'unexpected-tool-use']);
    expect(body.items[0]?.taskRef.uid).toBe('uid-suspicious-01');
  });

  // ------------------------------------------------------------------
  // Test 5 — human-review-requested fires
  // ------------------------------------------------------------------

  it('Test 5 — human-review-requested fires with correct fields', async () => {
    const task = allFixtureTasks.find((t) => t.metadata.name === 'researcher-review-requested-01');
    expect(task).toBeDefined();

    const { fetch } = mountAndFetch({
      cache: makeStubCache([task!]),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.reason).toBe('human-review-requested');
    expect(body.items[0]?.reasonDetail).toBe('requested by operator@kagent');
    // enqueuedAt = annotations['review-requested-at']
    expect(body.items[0]?.enqueuedAt).toBe('2026-05-10T05:00:00.000Z');
    expect(body.items[0]?.taskRef.uid).toBe('uid-review-requested-01');
  });

  // ------------------------------------------------------------------
  // Test 6 — candidate-template fires
  // ------------------------------------------------------------------

  it('Test 6 — candidate-template fires with correct fields', async () => {
    const task = allFixtureTasks.find(
      (t) => t.metadata.name === 'researcher-template-candidate-01',
    );
    expect(task).toBeDefined();

    const { fetch } = mountAndFetch({
      cache: makeStubCache([task!]),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.reason).toBe('candidate-template');
    expect(body.items[0]?.candidateTemplate).toBeDefined();
    expect(body.items[0]?.candidateTemplate?.artifactRef.uri).toBe(
      'pvc://kagent-cas/sha256:abc123def456',
    );
    expect(typeof body.items[0]?.candidateTemplate?.proposedTemplateName).toBe('string');
    expect(body.items[0]?.candidateTemplate?.proposedTemplateName.length).toBeGreaterThan(0);
    expect(body.items[0]?.candidateTemplate?.proposedNamespace).toBe('kagent-system');
    expect(body.items[0]?.taskRef.uid).toBe('uid-template-candidate-01');
  });

  // ------------------------------------------------------------------
  // Test 7 — candidate-template WITHOUT matching artifact is OMITTED
  // ------------------------------------------------------------------

  it('Test 7 — candidate-template WITHOUT matching artifact is OMITTED', async () => {
    // A task with the template-candidate annotation but NO artifact
    // with the correct mediaType should be omitted from the queue.
    const taskWithoutArtifact: AgentTask = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'AgentTask',
      metadata: {
        name: 'no-artifact-candidate',
        namespace: 'kagent-system',
        uid: 'uid-no-artifact',
        creationTimestamp: '2026-05-10T10:00:00.000Z',
        annotations: {
          'kagent.knuteson.io/template-candidate': 'true',
        },
      },
      spec: {
        targetAgent: 'researcher',
        payload: {},
      },
      status: {
        phase: 'Completed',
        // No artifacts — should be omitted
        structuralVerdict: { suspicious: [] },
      },
    };

    const { fetch } = mountAndFetch({
      cache: makeStubCache([taskWithoutArtifact]),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    // Task with template-candidate annotation but no matching artifact is OMITTED.
    expect(body.items).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // Test 8 — already-decided task is SKIPPED
  // ------------------------------------------------------------------

  it('Test 8 — already-decided task is SKIPPED (review-decision annotation present)', async () => {
    const task = allFixtureTasks.find((t) => t.metadata.name === 'researcher-already-decided-01');
    expect(task).toBeDefined();

    const { fetch } = mountAndFetch({
      cache: makeStubCache([task!]),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    // The task has review-decision annotation — it must be skipped.
    expect(body.items).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // Test 9 — priority: verifier-failed beats suspicious-detector
  // ------------------------------------------------------------------

  it('Test 9 — priority: verifier-failed beats suspicious-detector on conflict', async () => {
    const task = allFixtureTasks.find((t) => t.metadata.name === 'researcher-priority-conflict-01');
    expect(task).toBeDefined();

    const { fetch } = mountAndFetch({
      cache: makeStubCache([task!]),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    expect(body.items).toHaveLength(1);
    // verifier-failed wins the priority race
    expect(body.items[0]?.reason).toBe('verifier-failed');
    // But the suspicious field is still populated from the task data
    expect(body.items[0]?.taskRef.uid).toBe('uid-priority-conflict-01');
  });

  // ------------------------------------------------------------------
  // Test 10 — sort descending by stalenessSeconds
  // ------------------------------------------------------------------

  it('Test 10 — sort descending by stalenessSeconds (oldest enqueuedAt first)', async () => {
    const { fetch } = mountAndFetch({
      cache: makeStubCache(allFixtureTasks),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    // Expect at least 2 items (all non-decided tasks from fixture)
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    // Items should be sorted descending (largest stalenessSeconds first)
    for (let i = 0; i < body.items.length - 1; i++) {
      const curr = body.items[i];
      const next = body.items[i + 1];
      expect(curr!.stalenessSeconds).toBeGreaterThanOrEqual(next!.stalenessSeconds);
    }
    // Oldest task should be first
    expect(body.items[0]!.stalenessSeconds).toBeGreaterThanOrEqual(
      body.items[body.items.length - 1]!.stalenessSeconds,
    );
  });

  // ------------------------------------------------------------------
  // Test 11 — replay-divergence and eval-failed are zero-producer in v0.2
  // ------------------------------------------------------------------

  it('Test 11 — replay-divergence and eval-failed never emitted from v0.2 fixture set (D-04 / REV-03)', async () => {
    const { fetch } = mountAndFetch({
      cache: makeStubCache(allFixtureTasks),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    for (const item of body.items) {
      expect(item.reason).not.toBe('replay-divergence');
      expect(item.reason).not.toBe('eval-failed');
    }
  });

  // ------------------------------------------------------------------
  // Test 12 — reload-stability
  // ------------------------------------------------------------------

  it('Test 12 — reload-stability: two consecutive GETs return identical items (fixed clock)', async () => {
    const { fetch } = mountAndFetch({
      cache: makeStubCache(allFixtureTasks),
      now: () => fixedNow,
    });
    const r1 = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    const r2 = (await (await fetch()).json()) as { items: ReviewQueueRow[] };

    // Same length
    expect(r2.items).toHaveLength(r1.items.length);

    // Same taskRef.uid order
    const uids1 = r1.items.map((i) => i.taskRef.uid);
    const uids2 = r2.items.map((i) => i.taskRef.uid);
    expect(uids2).toEqual(uids1);

    // Same row content (with fixed clock, stalenessSeconds is identical)
    for (let i = 0; i < r1.items.length; i++) {
      expect(r2.items[i]).toEqual(r1.items[i]);
    }
  });

  // ------------------------------------------------------------------
  // Additional edge-case: candidate-template with wrong-mediaType artifact omitted
  // ------------------------------------------------------------------

  it('Test 13 — candidate-template with wrong-mediaType artifact is OMITTED', async () => {
    const taskWrongMediaType: AgentTask = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'AgentTask',
      metadata: {
        name: 'wrong-media-type-candidate',
        namespace: 'kagent-system',
        uid: 'uid-wrong-media',
        creationTimestamp: '2026-05-10T10:00:00.000Z',
        annotations: {
          'kagent.knuteson.io/template-candidate': 'true',
        },
      },
      spec: {
        targetAgent: 'researcher',
        payload: {},
      },
      status: {
        phase: 'Completed',
        artifacts: [
          {
            uri: 'pvc://kagent-cas/sha256:deadbeef',
            mediaType: 'application/json', // WRONG mediaType
            name: 'some-output.json',
          },
        ],
        structuralVerdict: { suspicious: [] },
      },
    };

    const { fetch } = mountAndFetch({
      cache: makeStubCache([taskWrongMediaType]),
      now: () => fixedNow,
    });
    const body = (await (await fetch()).json()) as { items: ReviewQueueRow[] };
    // Wrong mediaType → no matching artifact → OMIT
    expect(body.items).toHaveLength(0);
  });
});
