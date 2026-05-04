/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Workspace controller — reconciler tests. Drives the pure
 * `reconcileWorkspace` path against mocked K8s API surfaces; verifies
 * the manifest builders, status transitions, finalizer dance, and TTL
 * predicate.
 */

import { describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION } from './crds/index.js';
import type { Workspace } from './crds/index.js';
import {
  buildClonePopulationJob,
  buildWorkspacePvc,
  cloneJobNameForWorkspace,
  computePhase,
  isWorkspaceTtlExpired,
  mergeCondition,
  pvcNameForWorkspace,
  reconcileWorkspace,
  WORKSPACE_FINALIZER,
  WORKSPACE_LABEL_KEY,
  WORKSPACE_MANAGED_LABEL_KEY,
  WORKSPACE_MANAGED_LABEL_VALUE,
  type WorkspaceReconcilerDeps,
} from './workspace-controller.js';

const baseWorkspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  apiVersion: API_GROUP_VERSION,
  kind: 'Workspace',
  metadata: {
    name: 'corpus',
    namespace: 'default',
    uid: 'ws-uid-12345',
    finalizers: [WORKSPACE_FINALIZER],
    ...(overrides.metadata ?? {}),
  },
  spec: { pvc: { storage: '5Gi' }, ...(overrides.spec ?? {}) },
  ...(overrides.status !== undefined && { status: overrides.status }),
});

function makeDeps(
  overrides: Partial<{
    createPvc: ReturnType<typeof vi.fn>;
    deletePvc: ReturnType<typeof vi.fn>;
    createJob: ReturnType<typeof vi.fn>;
    patchStatus: ReturnType<typeof vi.fn>;
    patchObject: ReturnType<typeof vi.fn>;
    options: WorkspaceReconcilerDeps['options'];
  }> = {},
): {
  deps: WorkspaceReconcilerDeps;
  mocks: {
    createPvc: ReturnType<typeof vi.fn>;
    deletePvc: ReturnType<typeof vi.fn>;
    createJob: ReturnType<typeof vi.fn>;
    patchStatus: ReturnType<typeof vi.fn>;
    patchObject: ReturnType<typeof vi.fn>;
  };
} {
  const createPvc = overrides.createPvc ?? vi.fn().mockResolvedValue({});
  const deletePvc = overrides.deletePvc ?? vi.fn().mockResolvedValue({});
  const createJob = overrides.createJob ?? vi.fn().mockResolvedValue({});
  const patchStatus = overrides.patchStatus ?? vi.fn().mockResolvedValue({});
  const patchObject = overrides.patchObject ?? vi.fn().mockResolvedValue({});
  const customApi = {
    patchNamespacedCustomObjectStatus: patchStatus,
    patchNamespacedCustomObject: patchObject,
  } as unknown as WorkspaceReconcilerDeps['customApi'];
  const coreApi = {
    createNamespacedPersistentVolumeClaim: createPvc,
    deleteNamespacedPersistentVolumeClaim: deletePvc,
  } as unknown as WorkspaceReconcilerDeps['coreApi'];
  const batchApi = {
    createNamespacedJob: createJob,
  } as unknown as WorkspaceReconcilerDeps['batchApi'];
  const deps: WorkspaceReconcilerDeps = {
    customApi,
    coreApi,
    batchApi,
    ...(overrides.options !== undefined && { options: overrides.options }),
  };
  return { deps, mocks: { createPvc, deletePvc, createJob, patchStatus, patchObject } };
}

describe('pvcNameForWorkspace + cloneJobNameForWorkspace', () => {
  it('PVC name maps 1:1 to Workspace name', () => {
    expect(pvcNameForWorkspace(baseWorkspace())).toBe('corpus');
  });

  it('clone Job name is prefixed kws-clone- and capped at 63 chars', () => {
    const ws = baseWorkspace({ metadata: { name: 'corpus', uid: 'x'.repeat(100) } });
    const name = cloneJobNameForWorkspace(ws);
    expect(name.startsWith('kws-clone-')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('throws on missing uid', () => {
    expect(() =>
      cloneJobNameForWorkspace(baseWorkspace({ metadata: { name: 'corpus', uid: undefined } })),
    ).toThrow(/missing metadata.uid/);
  });
});

describe('buildWorkspacePvc', () => {
  it('emits ReadWriteMany by default + carries managed-by labels', () => {
    const pvc = buildWorkspacePvc(baseWorkspace());
    expect(pvc.spec?.accessModes).toEqual(['ReadWriteMany']);
    expect(pvc.metadata?.labels?.[WORKSPACE_MANAGED_LABEL_KEY]).toBe(WORKSPACE_MANAGED_LABEL_VALUE);
    expect(pvc.metadata?.labels?.[WORKSPACE_LABEL_KEY]).toBe('corpus');
  });

  it('honors explicit accessModes', () => {
    const ws = baseWorkspace({
      spec: { pvc: { storage: '5Gi', accessModes: ['ReadWriteOnce'] } },
    });
    expect(buildWorkspacePvc(ws).spec?.accessModes).toEqual(['ReadWriteOnce']);
  });

  it('threads spec.pvc.storageClassName through', () => {
    const ws = baseWorkspace({
      spec: { pvc: { storage: '1Gi', storageClassName: 'longhorn' } },
    });
    expect(buildWorkspacePvc(ws).spec?.storageClassName).toBe('longhorn');
  });

  it('uses defaults.defaultStorageClassName when spec omits storageClassName', () => {
    const pvc = buildWorkspacePvc(baseWorkspace(), { defaultStorageClassName: 'kagent-rwx' });
    expect(pvc.spec?.storageClassName).toBe('kagent-rwx');
  });

  it('omits storageClassName entirely when neither spec nor default supplied', () => {
    const pvc = buildWorkspacePvc(baseWorkspace());
    expect(pvc.spec?.storageClassName).toBeUndefined();
  });

  it('owner-references the Workspace with controller=true', () => {
    const pvc = buildWorkspacePvc(baseWorkspace());
    expect(pvc.metadata?.ownerReferences?.[0]?.controller).toBe(true);
    expect(pvc.metadata?.ownerReferences?.[0]?.uid).toBe('ws-uid-12345');
  });
});

describe('buildClonePopulationJob', () => {
  const ws = baseWorkspace({
    spec: {
      pvc: { storage: '5Gi' },
      source: { git: { url: 'https://git/foo.git', ref: 'main', depth: 1 } },
    },
  });

  it('renders backoffLimit=0 + restartPolicy Never + ttl 600', () => {
    const job = buildClonePopulationJob(ws, { url: 'https://git/foo.git', depth: 1 });
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.template.spec?.restartPolicy).toBe('Never');
    expect(job.spec?.ttlSecondsAfterFinished).toBe(600);
  });

  it('owner-references the Workspace', () => {
    const job = buildClonePopulationJob(ws, { url: 'https://git/foo.git' });
    expect(job.metadata?.ownerReferences?.[0]?.uid).toBe('ws-uid-12345');
  });

  it('threads GIT_URL through env (literal — never spliced into the script)', () => {
    const job = buildClonePopulationJob(ws, { url: 'https://git/foo.git' });
    const env = job.spec?.template.spec?.containers?.[0]?.env ?? [];
    expect(env.find((e) => e.name === 'GIT_URL')?.value).toBe('https://git/foo.git');
  });

  it('mounts the PVC at /workspace via the workspace volume', () => {
    const job = buildClonePopulationJob(ws, { url: 'https://git/foo.git' });
    const vols = job.spec?.template.spec?.volumes ?? [];
    expect(vols[0]?.persistentVolumeClaim?.claimName).toBe('corpus');
    const mounts = job.spec?.template.spec?.containers?.[0]?.volumeMounts ?? [];
    expect(mounts[0]?.mountPath).toBe('/workspace');
  });

  it('propagates authSecretRef as GIT_TOKEN env via secretKeyRef', () => {
    const job = buildClonePopulationJob(ws, {
      url: 'https://git/foo.git',
      authSecretRef: { name: 'git-creds', key: 'token' },
    });
    const env = job.spec?.template.spec?.containers?.[0]?.env ?? [];
    const tok = env.find((e) => e.name === 'GIT_TOKEN');
    expect(tok?.valueFrom?.secretKeyRef?.name).toBe('git-creds');
    expect(tok?.valueFrom?.secretKeyRef?.key).toBe('token');
  });

  it('omits GIT_TOKEN when no authSecretRef supplied', () => {
    const job = buildClonePopulationJob(ws, { url: 'https://git/foo.git' });
    const env = job.spec?.template.spec?.containers?.[0]?.env ?? [];
    expect(env.find((e) => e.name === 'GIT_TOKEN')).toBeUndefined();
  });

  it('drops capabilities + runs non-root', () => {
    const job = buildClonePopulationJob(ws, { url: 'https://git/foo.git' });
    const sec = job.spec?.template.spec?.containers?.[0]?.securityContext;
    expect(sec?.runAsNonRoot).toBe(true);
    expect(sec?.allowPrivilegeEscalation).toBe(false);
    expect(sec?.capabilities?.drop).toEqual(['ALL']);
  });
});

describe('reconcileWorkspace — finalizer dance', () => {
  it('adds the finalizer on first sight (no PVC create yet)', async () => {
    const ws = baseWorkspace({ metadata: { name: 'corpus', uid: 'ws-uid-12345', finalizers: [] } });
    const { deps, mocks } = makeDeps();
    const action = await reconcileWorkspace({ ws }, deps);
    expect(action.kind).toBe('finalizer-added');
    expect(mocks.patchObject).toHaveBeenCalledTimes(1);
    // PVC create must NOT happen on the finalizer-add pass — reconcile
    // re-queues + comes back next event.
    expect(mocks.createPvc).not.toHaveBeenCalled();
  });
});

describe('reconcileWorkspace — PVC provisioning', () => {
  it('creates the PVC on a Workspace with no source', async () => {
    const ws = baseWorkspace();
    const { deps, mocks } = makeDeps();
    const action = await reconcileWorkspace({ ws }, deps);
    expect(action.kind).toBe('pvc-created');
    expect(mocks.createPvc).toHaveBeenCalledTimes(1);
    expect(mocks.patchStatus).toHaveBeenCalled();
  });

  it('treats AlreadyExists as success (idempotent re-reconcile)', async () => {
    const ws = baseWorkspace();
    const conflict = Object.assign(new Error('already exists'), { code: 409 });
    const { deps, mocks } = makeDeps({
      createPvc: vi.fn().mockRejectedValueOnce(conflict),
    });
    const action = await reconcileWorkspace({ ws }, deps);
    expect(action.kind).not.toBe('pvc-created');
    expect(mocks.createPvc).toHaveBeenCalled();
  });

  it('marks Failed when PVC create returns non-409', async () => {
    const ws = baseWorkspace();
    const fail = Object.assign(new Error('quota exceeded'), { code: 403 });
    const { deps, mocks } = makeDeps({
      createPvc: vi.fn().mockRejectedValueOnce(fail),
    });
    const action = await reconcileWorkspace({ ws }, deps);
    expect(action).toEqual({ kind: 'status-patched', phase: 'Failed' });
    expect(mocks.patchStatus).toHaveBeenCalled();
    const patch = mocks.patchStatus.mock.calls[0][0] as { body: { status: { phase: string } } };
    expect(patch.body.status.phase).toBe('Failed');
  });
});

describe('reconcileWorkspace — clone Job dispatch', () => {
  const sourcedWs = baseWorkspace({
    spec: {
      pvc: { storage: '5Gi' },
      source: { git: { url: 'https://git/foo.git', depth: 1 } },
    },
  });

  it('creates the clone Job when source.git is set + populationJobName not yet recorded', async () => {
    const { deps, mocks } = makeDeps();
    const action = await reconcileWorkspace({ ws: sourcedWs }, deps);
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    // Action is the FIRST mutating event observed; PVC create wins
    // (PVC create happens before clone Job), so action == 'pvc-created'.
    expect(action.kind).toBe('pvc-created');
  });

  it('does NOT re-dispatch the clone Job when status.populationJobName is set', async () => {
    const ws: Workspace = {
      ...sourcedWs,
      status: { phase: 'Pending', populationJobName: 'kws-clone-x' },
    };
    const { deps, mocks } = makeDeps();
    await reconcileWorkspace({ ws }, deps);
    expect(mocks.createJob).not.toHaveBeenCalled();
  });
});

describe('reconcileWorkspace — deletion path', () => {
  it('patches phase=Releasing then deletes the PVC', async () => {
    const wsBase = baseWorkspace({
      metadata: {
        name: 'corpus',
        uid: 'ws-uid-12345',
        finalizers: [WORKSPACE_FINALIZER],
        deletionTimestamp: new Date('2026-05-04T00:00:00Z'),
      },
      status: { phase: 'Ready' },
    });
    const { deps, mocks } = makeDeps();
    const action = await reconcileWorkspace({ ws: wsBase }, deps);
    expect(mocks.patchStatus).toHaveBeenCalled();
    const patch = mocks.patchStatus.mock.calls[0][0] as { body: { status: { phase: string } } };
    expect(patch.body.status.phase).toBe('Releasing');
    expect(mocks.deletePvc).toHaveBeenCalled();
    expect(action.kind).toBe('finalizer-removed');
  });

  it('treats PVC NotFound on delete as success', async () => {
    const wsBase = baseWorkspace({
      metadata: {
        name: 'corpus',
        uid: 'ws-uid-12345',
        finalizers: [WORKSPACE_FINALIZER],
        deletionTimestamp: new Date('2026-05-04T00:00:00Z'),
      },
      status: { phase: 'Ready' },
    });
    const notFound = Object.assign(new Error('not found'), { code: 404 });
    const { deps, mocks } = makeDeps({
      deletePvc: vi.fn().mockRejectedValueOnce(notFound),
    });
    const action = await reconcileWorkspace({ ws: wsBase }, deps);
    expect(action.kind).toBe('finalizer-removed');
    expect(mocks.patchObject).toHaveBeenCalled(); // finalizer strip
  });
});

describe('computePhase', () => {
  it('Pending when PVC is not bound', () => {
    const ws = baseWorkspace();
    expect(computePhase(ws, { ws, lookupPvc: () => undefined })).toBe('Pending');
  });

  it('Ready when PVC bound + no source', () => {
    const ws = baseWorkspace();
    expect(
      computePhase(ws, {
        ws,
        lookupPvc: () => ({ status: { phase: 'Bound' } }),
      }),
    ).toBe('Ready');
  });

  it('Pending when PVC bound + source set + Job not Complete', () => {
    const ws = baseWorkspace({
      spec: { pvc: { storage: '5Gi' }, source: { git: { url: 'g' } } },
    });
    expect(
      computePhase(ws, {
        ws,
        lookupPvc: () => ({ status: { phase: 'Bound' } }),
        lookupCloneJob: () => ({ status: {} }),
      }),
    ).toBe('Pending');
  });

  it('Ready when PVC bound + Job succeeded', () => {
    const ws = baseWorkspace({
      spec: { pvc: { storage: '5Gi' }, source: { git: { url: 'g' } } },
    });
    expect(
      computePhase(ws, {
        ws,
        lookupPvc: () => ({ status: { phase: 'Bound' } }),
        lookupCloneJob: () => ({ status: { succeeded: 1 } }),
      }),
    ).toBe('Ready');
  });

  it('Failed when PVC bound + Job failed', () => {
    const ws = baseWorkspace({
      spec: { pvc: { storage: '5Gi' }, source: { git: { url: 'g' } } },
    });
    expect(
      computePhase(ws, {
        ws,
        lookupPvc: () => ({ status: { phase: 'Bound' } }),
        lookupCloneJob: () => ({ status: { failed: 1 } }),
      }),
    ).toBe('Failed');
  });
});

describe('isWorkspaceTtlExpired', () => {
  const oneDayAgo = new Date('2026-05-03T00:00:00Z');
  const now = new Date('2026-05-04T00:00:01Z');

  it('returns false when lastReferencedAt is unset', () => {
    expect(isWorkspaceTtlExpired(baseWorkspace(), now)).toBe(false);
  });

  it('returns false on TTL=0 (explicit no-auto-GC)', () => {
    const ws = baseWorkspace({
      spec: { pvc: { storage: '5Gi' }, ttl: '0' },
      status: { lastReferencedAt: oneDayAgo.toISOString() },
    });
    expect(isWorkspaceTtlExpired(ws, now)).toBe(false);
  });

  it('returns true past 24h default + lastReferencedAt 24h ago', () => {
    const ws = baseWorkspace({ status: { lastReferencedAt: oneDayAgo.toISOString() } });
    expect(isWorkspaceTtlExpired(ws, now)).toBe(true);
  });

  it('returns false within TTL window', () => {
    const ws = baseWorkspace({
      spec: { pvc: { storage: '5Gi' }, ttl: '48h' },
      status: { lastReferencedAt: oneDayAgo.toISOString() },
    });
    expect(isWorkspaceTtlExpired(ws, now)).toBe(false);
  });
});

describe('mergeCondition', () => {
  it('appends when no matching condition exists', () => {
    const out = mergeCondition([], {
      type: 'PVCBound',
      status: 'True',
      lastTransitionTime: '2026-05-04T00:00:00Z',
    });
    expect(out).toHaveLength(1);
  });

  it('preserves lastTransitionTime when status/reason/message unchanged', () => {
    const earlier: import('./crds/index.js').WorkspaceCondition = {
      type: 'PVCBound',
      status: 'True',
      lastTransitionTime: '2026-05-03T00:00:00Z',
    };
    const out = mergeCondition([earlier], {
      type: 'PVCBound',
      status: 'True',
      lastTransitionTime: '2026-05-04T00:00:00Z',
    });
    expect(out[0]?.lastTransitionTime).toBe('2026-05-03T00:00:00Z');
  });

  it('replaces when status changes', () => {
    const out = mergeCondition(
      [{ type: 'PVCBound', status: 'False', lastTransitionTime: '2026-05-03T00:00:00Z' }],
      { type: 'PVCBound', status: 'True', lastTransitionTime: '2026-05-04T00:00:00Z' },
    );
    expect(out[0]?.status).toBe('True');
    expect(out[0]?.lastTransitionTime).toBe('2026-05-04T00:00:00Z');
  });
});
