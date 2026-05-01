/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import type { BatchV1Api } from '@kubernetes/client-node';

import {
  DISPATCH_PUBLISHED_ANNOTATION,
  DISPATCH_PUBLISHED_TRUE,
  isDispatchPublished,
  markJobPublished,
  readJob,
  unsuspendJob,
} from './job-annotator.js';

interface MockBatchApi {
  readNamespacedJob: ReturnType<typeof vi.fn>;
  patchNamespacedJob: ReturnType<typeof vi.fn>;
}

function makeBatchApi(overrides: Partial<MockBatchApi> = {}): MockBatchApi {
  return {
    readNamespacedJob: vi.fn(),
    patchNamespacedJob: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('readJob', () => {
  it('returns the Job on 200', async () => {
    const sample = { metadata: { name: 'kat-x', namespace: 'default' } };
    const api = makeBatchApi({ readNamespacedJob: vi.fn().mockResolvedValue(sample) });
    const got = await readJob(api as unknown as BatchV1Api, 'default', 'kat-x');
    expect(got).toEqual(sample);
    expect(api.readNamespacedJob).toHaveBeenCalledWith({ namespace: 'default', name: 'kat-x' });
  });

  it('returns undefined on 404', async () => {
    const api = makeBatchApi({
      readNamespacedJob: vi.fn().mockRejectedValue({ code: 404 }),
    });
    const got = await readJob(api as unknown as BatchV1Api, 'default', 'kat-x');
    expect(got).toBeUndefined();
  });

  it('treats statusCode:404 the same as code:404 (v0.x client compat)', async () => {
    const api = makeBatchApi({
      readNamespacedJob: vi.fn().mockRejectedValue({ statusCode: 404 }),
    });
    const got = await readJob(api as unknown as BatchV1Api, 'default', 'kat-x');
    expect(got).toBeUndefined();
  });

  it('rethrows non-404 errors', async () => {
    const api = makeBatchApi({
      readNamespacedJob: vi.fn().mockRejectedValue(new Error('forbidden')),
    });
    await expect(readJob(api as unknown as BatchV1Api, 'default', 'kat-x')).rejects.toThrow(
      /forbidden/,
    );
  });
});

describe('isDispatchPublished', () => {
  it('returns false for undefined Job', () => {
    expect(isDispatchPublished(undefined)).toBe(false);
  });

  it('returns false when annotations are absent', () => {
    expect(isDispatchPublished({ metadata: { name: 'kat-x' } })).toBe(false);
  });

  it('returns false when the dispatch-published annotation is missing', () => {
    expect(
      isDispatchPublished({
        metadata: { name: 'kat-x', annotations: { 'other.io/foo': 'bar' } },
      }),
    ).toBe(false);
  });

  it('returns true only when the value is exactly "true"', () => {
    expect(
      isDispatchPublished({
        metadata: {
          name: 'kat-x',
          annotations: { [DISPATCH_PUBLISHED_ANNOTATION]: DISPATCH_PUBLISHED_TRUE },
        },
      }),
    ).toBe(true);
  });

  it('returns false for a non-"true" value (defensive against typos)', () => {
    expect(
      isDispatchPublished({
        metadata: {
          name: 'kat-x',
          annotations: { [DISPATCH_PUBLISHED_ANNOTATION]: 'TRUE' },
        },
      }),
    ).toBe(false);
  });
});

describe('markJobPublished', () => {
  it('issues a merge-patch with the published annotation set to "true"', async () => {
    const api = makeBatchApi();
    await markJobPublished(api as unknown as BatchV1Api, 'default', 'kat-x');
    expect(api.patchNamespacedJob).toHaveBeenCalledWith(
      {
        namespace: 'default',
        name: 'kat-x',
        body: {
          metadata: {
            annotations: {
              [DISPATCH_PUBLISHED_ANNOTATION]: DISPATCH_PUBLISHED_TRUE,
            },
          },
        },
      },
      // Per-call header override forcing application/merge-patch+json —
      // the K8s SDK 1.x default (json-patch+json) wants a JSON Patch
      // array; we send an object body, so we must override.
      expect.objectContaining({}) as unknown,
    );
  });

  it('propagates patch errors so the reconcile loop can log them', async () => {
    const api = makeBatchApi({
      patchNamespacedJob: vi.fn().mockRejectedValue(new Error('apiserver')),
    });
    await expect(
      markJobPublished(api as unknown as BatchV1Api, 'default', 'kat-x'),
    ).rejects.toThrow(/apiserver/);
  });
});

describe('unsuspendJob', () => {
  it('issues a merge-patch with spec.suspend=false', async () => {
    const api = makeBatchApi();
    await unsuspendJob(api as unknown as BatchV1Api, 'default', 'kat-x');
    expect(api.patchNamespacedJob).toHaveBeenCalledWith(
      {
        namespace: 'default',
        name: 'kat-x',
        body: { spec: { suspend: false } },
      },
      expect.objectContaining({}) as unknown,
    );
  });

  it('propagates patch errors (operator caller logs + relies on relist)', async () => {
    const api = makeBatchApi({
      patchNamespacedJob: vi.fn().mockRejectedValue(new Error('forbidden')),
    });
    await expect(unsuspendJob(api as unknown as BatchV1Api, 'default', 'kat-x')).rejects.toThrow(
      /forbidden/,
    );
  });
});
