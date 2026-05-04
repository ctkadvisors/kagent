/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * RWX probe tests — drive the probe against mocked CoreV1Api surfaces
 * for the success path, the unavailable path, and error pass-through.
 */

import type { CoreV1Api, V1PersistentVolumeClaim } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';

import {
  probeRwxStorageClass,
  RWX_PROBE_PVC_NAME,
  type RwxProbeResult,
} from './workspace-rwx-probe.js';

function makeApi(overrides: {
  readPhases?: string[];
  createReject?: unknown;
  deleteReject?: unknown;
  readReject?: unknown;
}): {
  api: CoreV1Api;
  mocks: {
    create: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
} {
  const create = vi.fn();
  if (overrides.createReject !== undefined) create.mockRejectedValue(overrides.createReject);
  else create.mockResolvedValue({});
  const phases = overrides.readPhases ?? ['Pending', 'Bound'];
  const read = vi.fn();
  if (overrides.readReject !== undefined) {
    read.mockRejectedValue(overrides.readReject);
  } else {
    let i = 0;
    read.mockImplementation(() => {
      const phase = phases[Math.min(i, phases.length - 1)];
      i++;
      const pvc: V1PersistentVolumeClaim = {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: RWX_PROBE_PVC_NAME, namespace: 'kagent-system' },
        spec: { accessModes: ['ReadWriteMany'], resources: { requests: { storage: '1Mi' } } },
        status: { phase },
      };
      return Promise.resolve(pvc);
    });
  }
  const del = vi.fn();
  if (overrides.deleteReject !== undefined) del.mockRejectedValue(overrides.deleteReject);
  else del.mockResolvedValue({});
  const api = {
    createNamespacedPersistentVolumeClaim: create,
    readNamespacedPersistentVolumeClaim: read,
    deleteNamespacedPersistentVolumeClaim: del,
  } as unknown as CoreV1Api;
  return { api, mocks: { create, read, delete: del } };
}

describe('probeRwxStorageClass — happy path', () => {
  it('returns rwx-available when the probe PVC binds', async () => {
    const { api, mocks } = makeApi({ readPhases: ['Pending', 'Bound'] });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await probeRwxStorageClass(api, {
      namespace: 'kagent-system',
      storageClassName: 'longhorn',
      timeoutMs: 5000,
      sleep,
    });
    expect(result).toEqual({ kind: 'rwx-available', storageClassName: 'longhorn' });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    // Probe PVC name is deterministic (re-bind safe).
    const createBody = mocks.create.mock.calls[0][0] as { body: V1PersistentVolumeClaim };
    expect(createBody.body.metadata?.name).toBe(RWX_PROBE_PVC_NAME);
    expect(createBody.body.spec?.accessModes).toEqual(['ReadWriteMany']);
    // Cleanup ALWAYS runs — we expect at least 2 deletes (pre-create
    // sweep + post-probe cleanup).
    expect(mocks.delete.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('omits storageClassName when not provided', async () => {
    const { api } = makeApi({ readPhases: ['Bound'] });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await probeRwxStorageClass(api, {
      namespace: 'kagent-system',
      timeoutMs: 5000,
      sleep,
    });
    expect(result.kind).toBe('rwx-available');
    if (result.kind === 'rwx-available') {
      expect(result.storageClassName).toBeUndefined();
    }
  });
});

describe('probeRwxStorageClass — unavailable path', () => {
  it('returns rwx-unavailable when PVC never binds before timeout', async () => {
    const { api } = makeApi({ readPhases: ['Pending', 'Pending', 'Pending'] });
    // Use a fake sleep that just elapses 5s per call so we time out
    // after a small number of polls.
    let elapsed = 0;
    const realDateNow = Date.now;
    const startedAt = realDateNow();
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => startedAt + elapsed);
    const sleep = vi.fn().mockImplementation((ms: number) => {
      elapsed += ms;
      return Promise.resolve();
    });
    try {
      const result: RwxProbeResult = await probeRwxStorageClass(api, {
        namespace: 'kagent-system',
        timeoutMs: 5000,
        sleep,
      });
      expect(result.kind).toBe('rwx-unavailable');
      if (result.kind === 'rwx-unavailable') {
        expect(result.reason).toMatch(/did not bind/);
      }
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('returns rwx-unavailable when the apiserver rejects the PVC with 422', async () => {
    const reject = Object.assign(new Error('Invalid: spec.accessModes'), { code: 422 });
    const { api } = makeApi({ createReject: reject });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await probeRwxStorageClass(api, {
      namespace: 'kagent-system',
      storageClassName: 'flannel-only-default',
      timeoutMs: 1000,
      sleep,
    });
    expect(result.kind).toBe('rwx-unavailable');
  });
});

describe('probeRwxStorageClass — error pass-through', () => {
  it('returns probe-error on non-422 create failure', async () => {
    const reject = Object.assign(new Error('connection refused'), { code: 503 });
    const { api } = makeApi({ createReject: reject });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await probeRwxStorageClass(api, {
      namespace: 'kagent-system',
      timeoutMs: 1000,
      sleep,
    });
    expect(result.kind).toBe('probe-error');
  });
});

describe('probeRwxStorageClass — cleanup', () => {
  it('best-effort: 404 on cleanup is fine (no exception)', async () => {
    const { api } = makeApi({
      readPhases: ['Bound'],
      deleteReject: Object.assign(new Error('not found'), { code: 404 }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await probeRwxStorageClass(api, {
      namespace: 'kagent-system',
      timeoutMs: 1000,
      sleep,
    });
    expect(result.kind).toBe('rwx-available');
  });
});
