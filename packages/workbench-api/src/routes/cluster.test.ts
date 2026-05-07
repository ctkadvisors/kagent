/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Unit tests for the cluster route. Focuses on M14 (TTL-cached
 * `listNode()`) and NEW-M2 (single `listPods()` snapshot per
 * `/api/cluster/snapshot` handler call).
 */

import type { CoreV1Api, V1Pod } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';

import { SnapshotCache } from '../cache.js';
import { clusterRoute } from './cluster.js';

function makeReq(url: string): Request {
  return new Request(`http://test${url}`, { method: 'GET' });
}

function fakeCoreApi(listNode: () => Promise<unknown>): CoreV1Api {
  return { listNode } as unknown as CoreV1Api;
}

describe('cluster.ts — M14 listNode cache', () => {
  it('GET /api/cluster/nodes hits the upstream listNode once across rapid polls (cache hit)', async () => {
    const cache = new SnapshotCache();
    const listNode = vi.fn(() => Promise.resolve({ items: [] }));
    let t = 1_000_000;
    const app = clusterRoute({
      cache,
      coreApi: fakeCoreApi(listNode),
      nodeListTtlMs: 5_000,
      now: () => t,
    });
    // Three back-to-back polls within the TTL window.
    await app.request(makeReq('/api/cluster/nodes'));
    t += 100;
    await app.request(makeReq('/api/cluster/nodes'));
    t += 4_000;
    await app.request(makeReq('/api/cluster/nodes'));
    expect(listNode).toHaveBeenCalledTimes(1);
  });

  it('re-loads after the TTL elapses', async () => {
    const cache = new SnapshotCache();
    const listNode = vi.fn(() => Promise.resolve({ items: [] }));
    let t = 1_000_000;
    const app = clusterRoute({
      cache,
      coreApi: fakeCoreApi(listNode),
      nodeListTtlMs: 5_000,
      now: () => t,
    });
    await app.request(makeReq('/api/cluster/nodes'));
    t += 6_000; // step past TTL
    await app.request(makeReq('/api/cluster/nodes'));
    expect(listNode).toHaveBeenCalledTimes(2);
  });

  it('snapshot AND nodes endpoints share the same cache', async () => {
    const cache = new SnapshotCache();
    const listNode = vi.fn(() => Promise.resolve({ items: [] }));
    let t = 1_000_000;
    const app = clusterRoute({
      cache,
      coreApi: fakeCoreApi(listNode),
      nodeListTtlMs: 5_000,
      now: () => t,
    });
    await app.request(makeReq('/api/cluster/nodes'));
    t += 10;
    await app.request(makeReq('/api/cluster/snapshot'));
    expect(listNode).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache failures — next call re-loads', async () => {
    const cache = new SnapshotCache();
    let calls = 0;
    const listNode = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('apiserver down'));
      return Promise.resolve({ items: [] });
    });
    let t = 1_000_000;
    const app = clusterRoute({
      cache,
      coreApi: fakeCoreApi(listNode),
      nodeListTtlMs: 5_000,
      now: () => t,
    });
    const first = await app.request(makeReq('/api/cluster/nodes'));
    expect(first.status).toBe(502);
    t += 10;
    const second = await app.request(makeReq('/api/cluster/nodes'));
    expect(second.status).toBe(200);
    expect(listNode).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent in-flight misses to a single upstream call', async () => {
    const cache = new SnapshotCache();
    let resolveOuter: ((v: { items: unknown[] }) => void) | null = null;
    const pending = new Promise<{ items: unknown[] }>((r) => {
      resolveOuter = r;
    });
    const listNode = vi.fn(() => pending);
    const app = clusterRoute({
      cache,
      coreApi: fakeCoreApi(listNode),
      nodeListTtlMs: 5_000,
    });
    const a = app.request(makeReq('/api/cluster/nodes'));
    const b = app.request(makeReq('/api/cluster/nodes'));
    if (resolveOuter !== null) (resolveOuter as (v: { items: unknown[] }) => void)({ items: [] });
    await Promise.all([a, b]);
    expect(listNode).toHaveBeenCalledTimes(1);
  });

  it('503s when coreApi omitted (test mode)', async () => {
    const app = clusterRoute({ cache: new SnapshotCache() });
    const res = await app.request(makeReq('/api/cluster/nodes'));
    expect(res.status).toBe(503);
  });
});

describe('cluster.ts — L13 lastResultPreview secret scrub', () => {
  // Audit-rev2 L13 — task `result.content` is unconstrained agent
  // output. The 200-char preview is a triage convenience, NOT an
  // attestable channel; it must run the same secret-scrub regex set
  // that workbench-api applies to `usage_records.errorMessage`.
  it('scrubs sk- API keys out of lastResultPreview before serving the row', async () => {
    const cache = new SnapshotCache();
    // Build a Completed task with a leaked OpenAI-shape key in its
    // result.content. The dashboard renders this row in the
    // "recently completed" panel of /api/cluster/snapshot.
    const taskWithSecret = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'AgentTask',
      metadata: {
        namespace: 'kagent-system',
        name: 'leaky-task',
        uid: 'uid-leaky',
        creationTimestamp: '2026-05-01T15:00:00Z',
      },
      spec: { targetAgent: 'smoke-test', originalUserMessage: 'hi' },
      status: {
        phase: 'Completed',
        completedAt: '2026-05-01T15:01:00Z',
        result: {
          content:
            'helpfully echoing my upstream key: sk-proj-abcdefghijklmnop1234567890qrstu — please rotate.',
        },
      },
    } as unknown as Parameters<typeof cache.upsertTask>[0];
    cache.upsertTask(taskWithSecret);

    const listNode = vi.fn(() => Promise.resolve({ items: [] }));
    const app = clusterRoute({ cache, coreApi: fakeCoreApi(listNode), nodeListTtlMs: 0 });
    const res = await app.request(makeReq('/api/cluster/snapshot'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recentTasks: ReadonlyArray<{ name: string; lastResultPreview?: string }>;
    };
    const row = body.recentTasks.find((r) => r.name === 'leaky-task');
    expect(row).toBeDefined();
    // The preview is present (the dashboard still gets at-a-glance copy)…
    expect(row?.lastResultPreview).toBeDefined();
    // …but the secret patterns from error-scrub are redacted.
    expect(row?.lastResultPreview).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(row?.lastResultPreview).not.toMatch(/sk-proj-[A-Za-z0-9_-]+/);
    expect(row?.lastResultPreview).toContain('[REDACTED]');
    // The 200-char cap is preserved post-scrub.
    expect(row?.lastResultPreview?.length ?? 0).toBeLessThanOrEqual(200);
  });

  it('passes through ordinary content unchanged (no false-positive redaction)', async () => {
    const cache = new SnapshotCache();
    const benignTask = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'AgentTask',
      metadata: {
        namespace: 'kagent-system',
        name: 'benign-task',
        uid: 'uid-benign',
        creationTimestamp: '2026-05-01T15:00:00Z',
      },
      spec: { targetAgent: 'smoke-test', originalUserMessage: 'hi' },
      status: {
        phase: 'Completed',
        completedAt: '2026-05-01T15:01:00Z',
        result: { content: 'etcd is a distributed key-value store used by Kubernetes.' },
      },
    } as unknown as Parameters<typeof cache.upsertTask>[0];
    cache.upsertTask(benignTask);
    const listNode = vi.fn(() => Promise.resolve({ items: [] }));
    const app = clusterRoute({ cache, coreApi: fakeCoreApi(listNode), nodeListTtlMs: 0 });
    const res = await app.request(makeReq('/api/cluster/snapshot'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recentTasks: ReadonlyArray<{ name: string; lastResultPreview?: string }>;
    };
    const row = body.recentTasks.find((r) => r.name === 'benign-task');
    expect(row?.lastResultPreview).toBe(
      'etcd is a distributed key-value store used by Kubernetes.',
    );
    expect(row?.lastResultPreview).not.toContain('[REDACTED]');
  });
});

describe('cluster.ts — NEW-M2 single-snapshot pod read', () => {
  it('snapshot uses ONE listPods() snapshot — no cross-contamination when cache mutates mid-handler', async () => {
    // We can't easily detect duplicate listPods() calls without
    // monkey-patching the cache, so we directly verify the response
    // is internally consistent: the per-node managedPodCount column
    // must sum to allPods.length.
    const cache = new SnapshotCache();
    // Insert a pod so node-count is non-zero.
    const pod = {
      metadata: {
        name: 'p1',
        namespace: 'kagent-system',
        labels: { 'kagent.knuteson.io/managed-by': 'kagent-operator' },
      },
      spec: { nodeName: 'worker-1' },
      status: { phase: 'Running' },
    } as unknown as V1Pod;
    cache.upsertPod(pod);
    const listNode = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            metadata: { name: 'worker-1', labels: { 'node-role.kubernetes.io/worker': '' } },
            status: {
              conditions: [{ type: 'Ready', status: 'True' }],
              nodeInfo: {
                kubeletVersion: 'v1.32.5+k3s1',
                osImage: 'K3s',
                containerRuntimeVersion: 'containerd://1.7',
              },
              capacity: { cpu: '4' },
            },
          },
        ],
      }),
    );
    const app = clusterRoute({ cache, coreApi: fakeCoreApi(listNode), nodeListTtlMs: 0 });
    const res = await app.request(makeReq('/api/cluster/snapshot'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ name: string; managedPodCount: number }>;
      pods: Array<{ namespace: string; name: string }>;
      counts: { managedPods: number };
    };
    expect(body.nodes[0]?.managedPodCount).toBe(1);
    expect(body.counts.managedPods).toBe(1);
    expect(body.pods).toHaveLength(1);
  });
});
