/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 4 / REV-01 + REV-02 — /api/review-queue route tests.
 *
 * Wave 1 (Plan 04-02) covers:
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
 *
 * Wave 2 (Plan 04-03) covers POST handlers (accept / reject / request):
 *   - accept verifier-failed happy path → 200 + review.accepted audit event
 *   - accept candidate-template happy path → CR created BEFORE patch, both events
 *   - accept fails-closed when customApi undefined → 503 (verbatim message)
 *   - accept on missing task → 404
 *   - accept on already-decided → 409
 *   - accept on candidate-template with malformed YAML → 422
 *   - accept on candidate-template with K8s 409 collision → 422, no annotation patch
 *   - reject happy path → 200 + review.rejected, never creates CR
 *   - reject on already-decided → 409
 *   - request happy path → 200 + review.requested annotation + event
 *   - auth fallback to "unknown" when X-Forwarded-User absent
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertIsReviewQueueRow, type ReviewQueueRow } from '@kagent/dto';
import type { AgentTask } from '@kagent/dto';

// Load the candidate-template YAML fixture at module scope (W0 fixture).
const _dirname = dirname(fileURLToPath(import.meta.url));
const candidateYamlPath = resolve(_dirname, '../__fixtures__/candidate-template.yaml');
const candidateYaml = readFileSync(candidateYamlPath, 'utf8');

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

// ---------------------------------------------------------------------------
// W2 POST handler tests (Plan 04-03 — REV-02 accept / reject / request)
// ---------------------------------------------------------------------------

/**
 * Build a mock customApi with fresh vi.fn() stubs for the two methods
 * used by the POST handlers. Both resolve successfully by default.
 */
function makeMockCustomApi(overrides?: {
  createResolvesWith?: unknown;
  createRejectsWith?: unknown;
  patchResolvesWith?: unknown;
  patchRejectsWith?: unknown;
}): {
  createNamespacedCustomObject: ReturnType<typeof vi.fn>;
  patchNamespacedCustomObject: ReturnType<typeof vi.fn>;
} {
  const createFn = vi.fn();
  const patchFn = vi.fn();

  if (overrides?.createRejectsWith !== undefined) {
    createFn.mockRejectedValueOnce(overrides.createRejectsWith);
  } else {
    createFn.mockResolvedValue({
      metadata: {
        name: 'researcher-v2-template',
        namespace: 'kagent-system',
        uid: 'uid-created-template',
        creationTimestamp: '2026-05-10T13:00:00.000Z',
      },
    });
  }

  if (overrides?.patchRejectsWith !== undefined) {
    patchFn.mockRejectedValueOnce(overrides.patchRejectsWith);
  } else {
    patchFn.mockResolvedValue({});
  }

  return {
    createNamespacedCustomObject: createFn,
    patchNamespacedCustomObject: patchFn,
  };
}

/** Build a mock auditPublisher that records calls. */
function makeMockAuditPublisher(): { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

/**
 * The verifier-fail-1 task from the fixture: has verification.passed=false,
 * no review-decision annotation set, and no template-candidate annotation.
 * Suitable for testing the accept verifier-failed happy path.
 */
const verifierFailTask: AgentTask = {
  apiVersion: 'kagent.knuteson.io/v1alpha1',
  kind: 'AgentTask',
  metadata: {
    name: 'verifier-fail-1',
    namespace: 'kagent-system',
    uid: 'uid-verifier-fail-1',
    creationTimestamp: '2026-05-10T06:00:00.000Z',
    annotations: {},
  },
  spec: { targetAgent: 'researcher', payload: {} },
  status: {
    phase: 'Failed',
    completedAt: '2026-05-10T08:00:00.000Z',
    verification: {
      passed: false,
      reason: 'verifier_returned_non_json',
      mode: 'script',
      completedAt: '2026-05-10T08:05:00.000Z',
    },
    structuralVerdict: { suspicious: [] },
  },
};

/**
 * The already-decided task: has review-decision=accepted annotation set.
 * Used for 409 tests.
 */
const alreadyDecidedTask: AgentTask = {
  apiVersion: 'kagent.knuteson.io/v1alpha1',
  kind: 'AgentTask',
  metadata: {
    name: 'already-decided-1',
    namespace: 'kagent-system',
    uid: 'uid-already-decided-1',
    creationTimestamp: '2026-05-09T14:00:00.000Z',
    annotations: {
      'kagent.knuteson.io/review-decision': 'accepted',
      'kagent.knuteson.io/review-decided-by': 'operator@kagent',
      'kagent.knuteson.io/review-decided-at': '2026-05-09T15:00:00.000Z',
    },
  },
  spec: { targetAgent: 'researcher', payload: {} },
  status: {
    phase: 'Failed',
    completedAt: '2026-05-09T14:30:00.000Z',
    verification: {
      passed: false,
      reason: 'verdict:fail',
      mode: 'llmJudge',
      completedAt: '2026-05-09T14:35:00.000Z',
    },
    structuralVerdict: { suspicious: [] },
  },
};

/**
 * The candidate-template task: has template-candidate=true annotation and
 * a matching artifact with the correct media type. The readArtifact dep
 * is injected in tests to return candidateYaml.
 */
const candidateTemplateTask: AgentTask = {
  apiVersion: 'kagent.knuteson.io/v1alpha1',
  kind: 'AgentTask',
  metadata: {
    name: 'candidate-template-1',
    namespace: 'kagent-system',
    uid: 'uid-candidate-template-1',
    creationTimestamp: '2026-05-10T03:00:00.000Z',
    annotations: {
      'kagent.knuteson.io/template-candidate': 'true',
      'kagent.knuteson.io/proposed-template-name': 'researcher-v2',
    },
  },
  spec: { targetAgent: 'researcher', payload: {} },
  status: {
    phase: 'Completed',
    completedAt: '2026-05-10T03:45:00.000Z',
    structuralVerdict: { suspicious: [] },
    artifacts: [
      {
        uri: 'pvc://kagent-cas/sha256:abc123def456',
        mediaType: 'application/x-kagent-template-candidate+yaml',
        name: 'researcher-v2-template.yaml',
        sizeBytes: 1024,
        producedAt: '2026-05-10T03:44:00.000Z',
      },
    ],
  },
};

/**
 * A completed-clean task (no signals → goes in queue only via review-requested,
 * or can be used for request-handler tests).
 */
const cleanCompletedTask: AgentTask = {
  apiVersion: 'kagent.knuteson.io/v1alpha1',
  kind: 'AgentTask',
  metadata: {
    name: 'clean-completed-1',
    namespace: 'kagent-system',
    uid: 'uid-clean-completed-1',
    creationTimestamp: '2026-05-10T09:00:00.000Z',
    annotations: {},
  },
  spec: { targetAgent: 'researcher', payload: {} },
  status: {
    phase: 'Completed',
    completedAt: '2026-05-10T09:30:00.000Z',
    structuralVerdict: { suspicious: [] },
  },
};

describe('POST /api/review-queue — accept / reject / request (W2 Plan 04-03)', () => {
  // Fixed clock so timestamps are predictable in assertions
  const fixedPostNow = new Date('2026-05-10T14:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixedPostNow);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ------------------------------------------------------------------
  // W2-Test 1 — POST accept (verifier-failed) — happy path
  // ------------------------------------------------------------------

  it('W2-Test 1 — POST accept (verifier-failed) happy path → 200, patch called, no CR, one audit event', async () => {
    const customApi = makeMockCustomApi();
    const auditPublisher = makeMockAuditPublisher();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([verifierFailTask]),
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        auditPublisher,
        now: () => fixedPostNow,
      }),
    );

    const res = await app.request('/kagent-system/verifier-fail-1/accept', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-User': 'operator@kagent',
      },
      body: JSON.stringify({ reasonText: 'verifier output looks correct after manual review' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['decision']).toBe('accepted');
    expect(body['taskRef']).toMatchObject({ namespace: 'kagent-system', name: 'verifier-fail-1' });
    expect(body['agentTemplateRef']).toBeUndefined();

    // patchNamespacedCustomObject called with correct annotations
    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledOnce();
    const patchArgs = customApi.patchNamespacedCustomObject.mock.calls[0] as unknown[];
    const patchBody = patchArgs[0] as Record<string, unknown>;
    expect((patchBody['body'] as Record<string, unknown>)?.['metadata']).toMatchObject({
      annotations: {
        'kagent.knuteson.io/review-decision': 'accepted',
        'kagent.knuteson.io/review-decided-by': 'operator@kagent',
      },
    });

    // createNamespacedCustomObject NOT called (not a candidate-template)
    expect(customApi.createNamespacedCustomObject).not.toHaveBeenCalled();

    // Exactly ONE audit event: review.accepted
    expect(auditPublisher.publish).toHaveBeenCalledOnce();
    const event = auditPublisher.publish.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event['type']).toBe('review.accepted');
    expect((event['data'] as Record<string, unknown>)?.['reason']).toBe('verifier-failed');
  });

  // ------------------------------------------------------------------
  // W2-Test 2 — POST accept (candidate-template) — CR created BEFORE patch, both events
  // ------------------------------------------------------------------

  it('W2-Test 2 — POST accept (candidate-template) creates CR BEFORE patch, emits both events', async () => {
    const customApi = makeMockCustomApi();
    const auditPublisher = makeMockAuditPublisher();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([candidateTemplateTask]),
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        auditPublisher,
        now: () => fixedPostNow,
        readArtifact: () => Promise.resolve(candidateYaml),
      }),
    );

    const res = await app.request('/kagent-system/candidate-template-1/accept', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-User': 'reviewer@kagent',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['decision']).toBe('accepted');
    expect(body['agentTemplateRef']).toMatchObject({
      name: 'researcher-v2-template',
      namespace: 'kagent-system',
      uid: 'uid-created-template',
    });

    // CR creation called BEFORE annotation patch — call-order assertion
    expect(customApi.createNamespacedCustomObject).toHaveBeenCalledOnce();
    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledOnce();
    const createOrder = customApi.createNamespacedCustomObject.mock.invocationCallOrder[0]!;
    const patchOrder = customApi.patchNamespacedCustomObject.mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(patchOrder);

    // Verify create call body
    const createArgs = customApi.createNamespacedCustomObject.mock.calls[0] as unknown[];
    const createBody = (createArgs[0] as Record<string, unknown>)?.['body'] as Record<
      string,
      unknown
    >;
    expect(createBody?.['kind']).toBe('AgentTemplate');
    expect((createBody?.['metadata'] as Record<string, unknown>)?.['name']).toBe('researcher-v2');
    expect(
      (
        (createBody?.['metadata'] as Record<string, unknown>)?.['annotations'] as Record<
          string,
          unknown
        >
      )?.['kagent.knuteson.io/promoted-from-task'],
    ).toBe('kagent-system/candidate-template-1');

    // Two audit events: review.accepted + template.candidate.promoted
    expect(auditPublisher.publish).toHaveBeenCalledTimes(2);
    const events = auditPublisher.publish.mock.calls.map(
      (call) => (call[0] as Record<string, unknown>)['type'],
    );
    expect(events).toContain('review.accepted');
    expect(events).toContain('template.candidate.promoted');
  });

  // ------------------------------------------------------------------
  // W2-Test 3 — POST accept fails-closed when customApi undefined → 503
  // ------------------------------------------------------------------

  it('W2-Test 3 — POST accept returns 503 with verbatim message when customApi undefined', async () => {
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([verifierFailTask]),
        // no customApi
        now: () => fixedPostNow,
      }),
    );

    const res = await app.request('/kagent-system/verifier-fail-1/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe(
      'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart',
    );
  });

  // ------------------------------------------------------------------
  // W2-Test 4 — POST accept on missing task → 404
  // ------------------------------------------------------------------

  it('W2-Test 4 — POST accept on missing task → 404', async () => {
    const customApi = makeMockCustomApi();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([]), // empty cache
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        now: () => fixedPostNow,
      }),
    );

    const res = await app.request('/kagent-system/nonexistent/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
  });

  // ------------------------------------------------------------------
  // W2-Test 5 — POST accept on already-decided → 409
  // ------------------------------------------------------------------

  it('W2-Test 5 — POST accept on already-decided task → 409', async () => {
    const customApi = makeMockCustomApi();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([alreadyDecidedTask]),
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        now: () => fixedPostNow,
      }),
    );

    const res = await app.request('/kagent-system/already-decided-1/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
  });

  // ------------------------------------------------------------------
  // W2-Test 6 — POST accept on candidate-template with malformed YAML → 422
  // ------------------------------------------------------------------

  it('W2-Test 6 — POST accept on candidate-template with malformed YAML → 422', async () => {
    const customApi = makeMockCustomApi();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([candidateTemplateTask]),
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        now: () => fixedPostNow,
        readArtifact: () => Promise.resolve('not-a-spec: : : completely-broken'),
      }),
    );

    const res = await app.request('/kagent-system/candidate-template-1/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
    // The error should mention candidate-template parse failure
    expect((body['error'] as string).toLowerCase()).toMatch(/candidate.template|parse/);

    // CR was NOT created; annotation PATCH was NOT called
    expect(customApi.createNamespacedCustomObject).not.toHaveBeenCalled();
    expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // W2-Test 7 — POST accept on candidate-template with K8s 409 collision → 422, no patch
  // ------------------------------------------------------------------

  it('W2-Test 7 — POST accept on candidate-template with K8s 409 collision → 422, annotation patch NOT called', async () => {
    const k8sConflictError = { code: 409, body: { message: 'already exists' } };
    const customApi = makeMockCustomApi({ createRejectsWith: k8sConflictError });
    const auditPublisher = makeMockAuditPublisher();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([candidateTemplateTask]),
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        auditPublisher,
        now: () => fixedPostNow,
        readArtifact: () => Promise.resolve(candidateYaml),
      }),
    );

    const res = await app.request('/kagent-system/candidate-template-1/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');

    // Annotation PATCH was NOT called (early return after CR creation failure)
    expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
    // No audit events emitted (early return)
    expect(auditPublisher.publish).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // W2-Test 8 — POST reject happy path — never creates CR, emits review.rejected
  // ------------------------------------------------------------------

  it('W2-Test 8 — POST reject happy path → 200, no CR, one audit event review.rejected', async () => {
    const customApi = makeMockCustomApi();
    const auditPublisher = makeMockAuditPublisher();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([verifierFailTask]),
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        auditPublisher,
        now: () => fixedPostNow,
      }),
    );

    const res = await app.request('/kagent-system/verifier-fail-1/reject', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-User': 'operator@kagent',
      },
      body: JSON.stringify({ reasonText: 'verifier output is still incorrect' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['decision']).toBe('rejected');
    expect(body['taskRef']).toMatchObject({ namespace: 'kagent-system', name: 'verifier-fail-1' });

    // Annotation PATCH called with 'rejected'
    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledOnce();
    const patchArgs = customApi.patchNamespacedCustomObject.mock.calls[0] as unknown[];
    const patchBody = (patchArgs[0] as Record<string, unknown>)?.['body'] as Record<
      string,
      unknown
    >;
    expect((patchBody?.['metadata'] as Record<string, unknown>)?.['annotations']).toMatchObject({
      'kagent.knuteson.io/review-decision': 'rejected',
    });

    // CR NOT created
    expect(customApi.createNamespacedCustomObject).not.toHaveBeenCalled();

    // Exactly ONE audit event: review.rejected
    expect(auditPublisher.publish).toHaveBeenCalledOnce();
    const event = auditPublisher.publish.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event['type']).toBe('review.rejected');
  });

  // ------------------------------------------------------------------
  // W2-Test 9 — POST reject on already-decided → 409
  // ------------------------------------------------------------------

  it('W2-Test 9 — POST reject on already-decided task → 409', async () => {
    const customApi = makeMockCustomApi();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([alreadyDecidedTask]),
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        now: () => fixedPostNow,
      }),
    );

    const res = await app.request('/kagent-system/already-decided-1/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
  });

  // ------------------------------------------------------------------
  // W2-Test 10 — POST request happy path → 200 + review-requested annotation + event
  // ------------------------------------------------------------------

  it('W2-Test 10 — POST request happy path → 200, patches review-requested, emits review.requested', async () => {
    const customApi = makeMockCustomApi();
    const auditPublisher = makeMockAuditPublisher();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([cleanCompletedTask]),
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        auditPublisher,
        now: () => fixedPostNow,
      }),
    );

    const res = await app.request('/kagent-system/clean-completed-1/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-User': 'operator@kagent',
      },
      body: JSON.stringify({ reasonText: 'spot audit' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['requested']).toBe(true);
    expect(typeof body['requestedAt']).toBe('string');

    // PATCH called with review-requested: true annotation
    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledOnce();
    const patchArgs = customApi.patchNamespacedCustomObject.mock.calls[0] as unknown[];
    const patchBody = (patchArgs[0] as Record<string, unknown>)?.['body'] as Record<
      string,
      unknown
    >;
    expect((patchBody?.['metadata'] as Record<string, unknown>)?.['annotations']).toMatchObject({
      'kagent.knuteson.io/review-requested': 'true',
      'kagent.knuteson.io/review-requested-by': 'operator@kagent',
    });

    // ONE audit event: review.requested
    expect(auditPublisher.publish).toHaveBeenCalledOnce();
    const event = auditPublisher.publish.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event['type']).toBe('review.requested');
  });

  // ------------------------------------------------------------------
  // W2-Test 11 — X-Forwarded-User absent → annotation falls back to "unknown"
  // ------------------------------------------------------------------

  it('W2-Test 11 — X-Forwarded-User absent → review-decided-by annotation falls back to "unknown"', async () => {
    const customApi = makeMockCustomApi();
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([verifierFailTask]),
        customApi: customApi as unknown as Parameters<typeof reviewQueueRoute>[0]['customApi'],
        now: () => fixedPostNow,
      }),
    );

    // No X-Forwarded-User header, no body reviewerId
    const res = await app.request('/kagent-system/verifier-fail-1/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Should still succeed
    expect(res.status).toBe(200);

    // Annotation should fall back to 'unknown'
    const patchArgs = customApi.patchNamespacedCustomObject.mock.calls[0] as unknown[];
    const patchBody = (patchArgs[0] as Record<string, unknown>)?.['body'] as Record<
      string,
      unknown
    >;
    expect((patchBody?.['metadata'] as Record<string, unknown>)?.['annotations']).toMatchObject({
      'kagent.knuteson.io/review-decided-by': 'unknown',
    });
  });

  // ------------------------------------------------------------------
  // W2-Test 12 — POST reject fails-closed (503) when customApi undefined
  // ------------------------------------------------------------------

  it('W2-Test 12 — POST reject returns 503 with verbatim message when customApi undefined', async () => {
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([verifierFailTask]),
        // no customApi
        now: () => fixedPostNow,
      }),
    );

    const res = await app.request('/kagent-system/verifier-fail-1/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe(
      'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart',
    );
  });

  // ------------------------------------------------------------------
  // W2-Test 13 — POST request fails-closed (503) when customApi undefined
  // ------------------------------------------------------------------

  it('W2-Test 13 — POST request returns 503 with verbatim message when customApi undefined', async () => {
    const app = new Hono();
    app.route(
      '/',
      reviewQueueRoute({
        cache: makeStubCache([cleanCompletedTask]),
        // no customApi
        now: () => fixedPostNow,
      }),
    );

    const res = await app.request('/kagent-system/clean-completed-1/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe(
      'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart',
    );
  });
});
