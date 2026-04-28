/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Locks down the watch-path strings produced by `createAgentTaskInformer`
 * and `createJobPodInformer` for both namespace-scoped (chart default)
 * and cluster-wide (`watchAllNamespaces=true`) configurations.
 *
 * A wrong path string is silently a 404 against the apiserver — the
 * informer just relists in a loop and never sees an event. Asserting
 * the literal path here catches regressions before they ship.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const makeInformerMock = vi.fn();

vi.mock('@kubernetes/client-node', async () => {
  const actual =
    await vi.importActual<typeof import('@kubernetes/client-node')>('@kubernetes/client-node');
  return {
    ...actual,
    makeInformer: (...args: unknown[]) => {
      makeInformerMock(...args);
      // Minimal Informer surface — start/stop/on are sufficient for
      // construction-time assertions; we never drive real events here.
      return {
        on: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };
    },
  };
});

import type { CoreV1Api, CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

import { createJobPodInformer, type JobPodHandler } from './job-watch.js';
import { createAgentTaskInformer, type AgentTaskHandler } from './watch.js';

const fakeKc = {} as KubeConfig;

const noopAgentTaskHandler: AgentTaskHandler = {
  onAdd: () => {},
  onUpdate: () => {},
  onDelete: () => {},
};

const noopJobPodHandler: JobPodHandler = {
  onJob: () => {},
  onPod: () => {},
};

describe('createAgentTaskInformer — watch-path namespace plumbing', () => {
  beforeEach(() => {
    makeInformerMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the cluster-wide path when no namespace is supplied', () => {
    const customApi = {
      listClusterCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as CustomObjectsApi;

    createAgentTaskInformer(fakeKc, customApi, noopAgentTaskHandler);

    expect(makeInformerMock).toHaveBeenCalledTimes(1);
    const watchPath = makeInformerMock.mock.calls[0][1] as string;
    expect(watchPath).toBe('/apis/kagent.knuteson.io/v1alpha1/agenttasks');
  });

  it('uses the namespaced path when namespace is supplied', () => {
    const customApi = {
      listClusterCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as CustomObjectsApi;

    createAgentTaskInformer(fakeKc, customApi, noopAgentTaskHandler, {
      namespace: 'kagent-system',
    });

    const watchPath = makeInformerMock.mock.calls[0][1] as string;
    expect(watchPath).toBe('/apis/kagent.knuteson.io/v1alpha1/namespaces/kagent-system/agenttasks');
  });

  it('listFn calls listNamespacedCustomObject for namespaced watch', async () => {
    const listNamespaced = vi.fn().mockResolvedValue({ items: [] });
    const listCluster = vi.fn().mockResolvedValue({ items: [] });
    const customApi = {
      listClusterCustomObject: listCluster,
      listNamespacedCustomObject: listNamespaced,
    } as unknown as CustomObjectsApi;

    createAgentTaskInformer(fakeKc, customApi, noopAgentTaskHandler, {
      namespace: 'kagent-system',
    });
    const listFn = makeInformerMock.mock.calls[0][2] as () => Promise<unknown>;
    await listFn();

    expect(listNamespaced).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'kagent-system', plural: 'agenttasks' }),
    );
    expect(listCluster).not.toHaveBeenCalled();
  });

  it('listFn calls listClusterCustomObject for cluster-wide watch', async () => {
    const listNamespaced = vi.fn().mockResolvedValue({ items: [] });
    const listCluster = vi.fn().mockResolvedValue({ items: [] });
    const customApi = {
      listClusterCustomObject: listCluster,
      listNamespacedCustomObject: listNamespaced,
    } as unknown as CustomObjectsApi;

    createAgentTaskInformer(fakeKc, customApi, noopAgentTaskHandler);
    const listFn = makeInformerMock.mock.calls[0][2] as () => Promise<unknown>;
    await listFn();

    expect(listCluster).toHaveBeenCalledWith(expect.objectContaining({ plural: 'agenttasks' }));
    expect(listNamespaced).not.toHaveBeenCalled();
  });
});

describe('createJobPodInformer — Job + Pod watch-path namespace plumbing', () => {
  beforeEach(() => {
    makeInformerMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const labelQuery = encodeURIComponent('kagent.knuteson.io/managed-by=kagent-operator');

  it('cluster-wide: both Job and Pod use unscoped paths', () => {
    const coreApi = {
      listNamespacedPod: vi.fn(),
      listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as CoreV1Api;
    const batchListFn = vi.fn().mockResolvedValue({ items: [] });

    createJobPodInformer(fakeKc, coreApi, batchListFn, noopJobPodHandler);

    expect(makeInformerMock).toHaveBeenCalledTimes(2);
    const jobPath = makeInformerMock.mock.calls[0][1] as string;
    const podPath = makeInformerMock.mock.calls[1][1] as string;
    expect(jobPath).toBe(`/apis/batch/v1/jobs?labelSelector=${labelQuery}`);
    expect(podPath).toBe(`/api/v1/pods?labelSelector=${labelQuery}`);
  });

  it('namespaced: both Job and Pod use scoped paths', () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      listPodForAllNamespaces: vi.fn(),
    } as unknown as CoreV1Api;
    const batchListFn = vi.fn().mockResolvedValue({ items: [] });

    createJobPodInformer(fakeKc, coreApi, batchListFn, noopJobPodHandler, {
      namespace: 'kagent-system',
    });

    const jobPath = makeInformerMock.mock.calls[0][1] as string;
    const podPath = makeInformerMock.mock.calls[1][1] as string;
    expect(jobPath).toBe(
      `/apis/batch/v1/namespaces/kagent-system/jobs?labelSelector=${labelQuery}`,
    );
    expect(podPath).toBe(`/api/v1/namespaces/kagent-system/pods?labelSelector=${labelQuery}`);
  });

  it('Pod listFn calls listNamespacedPod for namespaced watch', async () => {
    const listNamespacedPod = vi.fn().mockResolvedValue({ items: [] });
    const listAll = vi.fn();
    const coreApi = {
      listNamespacedPod,
      listPodForAllNamespaces: listAll,
    } as unknown as CoreV1Api;
    const batchListFn = vi.fn().mockResolvedValue({ items: [] });

    createJobPodInformer(fakeKc, coreApi, batchListFn, noopJobPodHandler, {
      namespace: 'kagent-system',
    });
    // call index [1] is the pod informer; arg [2] is its listFn.
    const podListFn = makeInformerMock.mock.calls[1][2] as () => Promise<unknown>;
    await podListFn();

    expect(listNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'kagent-system' }),
    );
    expect(listAll).not.toHaveBeenCalled();
  });

  it('encodes namespaces with reserved URL chars', () => {
    const coreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      listPodForAllNamespaces: vi.fn(),
    } as unknown as CoreV1Api;
    const batchListFn = vi.fn().mockResolvedValue({ items: [] });

    // Real K8s namespaces are DNS-label restricted, but encodeURIComponent
    // on the path is the safety net. Confirm it actually fires.
    createJobPodInformer(fakeKc, coreApi, batchListFn, noopJobPodHandler, {
      namespace: 'has space', // would never come from K8s, but still: escape it.
    });

    const jobPath = makeInformerMock.mock.calls[0][1] as string;
    expect(jobPath).toContain('namespaces/has%20space/jobs');
  });
});
