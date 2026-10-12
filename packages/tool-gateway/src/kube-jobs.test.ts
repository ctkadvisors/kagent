/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inClusterSandboxKube } from './kube-jobs.js';

const api = vi.hoisted(() => ({
  batch: {
    createNamespacedJob: vi.fn(),
    listNamespacedJob: vi.fn(),
    deleteNamespacedJob: vi.fn(),
  },
  core: { listNamespacedPod: vi.fn() },
}));
vi.mock('@kubernetes/client-node', () => {
  class BatchV1Api {}
  class CoreV1Api {}
  return {
    BatchV1Api,
    CoreV1Api,
    KubeConfig: class {
      loadFromCluster() {}
      makeApiClient(kind: unknown) {
        return kind === BatchV1Api ? api.batch : api.core;
      }
    },
  };
});

beforeEach(() => vi.resetAllMocks());
describe('sandbox Kubernetes adapter', () => {
  it('discovers only managed same-task Jobs in the configured namespace', async () => {
    const jobs = [{ metadata: { name: 'owned', uid: 'job-uid' } }];
    api.batch.listNamespacedJob.mockResolvedValue({ items: jobs });
    expect(await inClusterSandboxKube().listTaskJobs('sandbox-ns', 'task-uid')).toBe(jobs);
    expect(api.batch.listNamespacedJob).toHaveBeenCalledWith({
      namespace: 'sandbox-ns',
      labelSelector:
        'kagent.knuteson.io/sandbox-task=task-uid,app.kubernetes.io/component=code-sandbox,app.kubernetes.io/managed-by=kagent-tool-gateway',
    });
  });

  it('deletes only the observed Job with a UID precondition', async () => {
    await inClusterSandboxKube().deleteJob('sandbox-ns', 'owned', 'original-uid');
    expect(api.batch.deleteNamespacedJob).toHaveBeenCalledWith({
      namespace: 'sandbox-ns',
      name: 'owned',
      body: { propagationPolicy: 'Background', preconditions: { uid: 'original-uid' } },
    });
  });

  it('requires a live Running pod controlled by the exact observed Job UID', async () => {
    const pod = (uid: string, ip: string, extra = {}) => ({
      metadata: {
        namespace: 'sandbox-ns',
        ownerReferences: [{ kind: 'Job', name: 'owned', uid, controller: true }],
        ...extra,
      },
      status: { phase: 'Running', podIP: ip },
    });
    api.core.listNamespacedPod.mockResolvedValue({
      items: [
        pod('old-job-uid', '10.0.0.1'),
        pod('job-uid', '10.0.0.2', { deletionTimestamp: new Date() }),
        pod('job-uid', '10.0.0.3', { namespace: 'other' }),
        pod('job-uid', '10.0.0.4'),
      ],
    });
    expect(await inClusterSandboxKube().runningPodIp('sandbox-ns', 'owned', 'job-uid')).toBe(
      '10.0.0.4',
    );
    expect(api.core.listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'sandbox-ns',
      labelSelector: 'job-name=owned',
    });
    expect(
      await inClusterSandboxKube().runningPodIp('sandbox-ns', 'owned', 'missing-uid'),
    ).toBeUndefined();
  });
});
