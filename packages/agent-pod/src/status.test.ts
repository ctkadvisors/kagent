/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { CustomObjectsApi } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';

import { createArtifactRegistry } from './artifacts.js';
import type { PodConfig } from './env.js';
import type { RunResult } from './runner.js';
import {
  buildArtifactsOnlyPatch,
  buildJsonPatchOps,
  buildStatusPatch,
  isPreconditionFailed,
  writeStatus,
  type StatusPatch,
} from './status.js';

const baseResult: RunResult = {
  runId: 'task-uid-1',
  status: 'completed',
  finalContent: 'K3s uses containerd by default.',
  hitIterationCap: false,
  flags: [],
  traces: [],
  budget: {
    cumulativeInputTokens: 10,
    cumulativeOutputTokens: 5,
    cumulativeCostUsd: 0,
  },
};

const fixedNow = new Date('2026-04-26T10:00:00.000Z');

describe('buildStatusPatch', () => {
  it('maps status=completed to phase=Completed with content + verdict', () => {
    const patch = buildStatusPatch(baseResult, fixedNow);
    expect(patch.phase).toBe('Completed');
    expect(patch.result).toEqual({ content: 'K3s uses containerd by default.' });
    expect(patch.completedAt).toBe('2026-04-26T10:00:00.000Z');
    expect(patch.structuralVerdict?.suspicious).toEqual([]);
    expect(patch.error).toBeUndefined();
  });

  it('maps a completed run with no final content to Failed', () => {
    const patch = buildStatusPatch({ ...baseResult, finalContent: null }, fixedNow);
    expect(patch.phase).toBe('Failed');
    expect(patch.error).toMatch(/no final assistant content/i);
    expect(patch.result).toBeUndefined();
  });

  it('maps a completed run that hit maxIterations to Failed', () => {
    const patch = buildStatusPatch({ ...baseResult, hitIterationCap: true }, fixedNow);
    expect(patch.phase).toBe('Failed');
    expect(patch.error).toMatch(/maxIterations/i);
    expect(patch.result).toBeUndefined();
  });

  it('includes detector flags in structuralVerdict.suspicious', () => {
    const result: RunResult = {
      ...baseResult,
      flags: ['methodology_fabrication', 'truncated_synthesis'],
    };
    const patch = buildStatusPatch(result, fixedNow);
    expect(patch.structuralVerdict?.suspicious).toEqual([
      'methodology_fabrication',
      'truncated_synthesis',
    ]);
  });

  it('maps status=failed to phase=Failed with error message', () => {
    const result: RunResult = {
      ...baseResult,
      status: 'failed',
      error: { message: 'LLM timeout' },
    };
    const patch = buildStatusPatch(result, fixedNow);
    expect(patch.phase).toBe('Failed');
    expect(patch.error).toBe('LLM timeout');
    expect(patch.result).toBeUndefined();
  });

  it('maps non-completed terminal statuses to Failed with synthetic message', () => {
    for (const status of ['cancelled', 'budget_exceeded', 'timeout'] as const) {
      const result: RunResult = { ...baseResult, status };
      const patch = buildStatusPatch(result, fixedNow);
      expect(patch.phase).toBe('Failed');
      expect(patch.error).toMatch(/loop ended with status=/);
    }
  });

  it('preserves verdict on Failed too', () => {
    const result: RunResult = {
      ...baseResult,
      status: 'failed',
      flags: ['synthesis_low_yield'],
      error: { message: 'thing' },
    };
    const patch = buildStatusPatch(result, fixedNow);
    expect(patch.structuralVerdict?.suspicious).toEqual(['synthesis_low_yield']);
  });

  it('omits artifacts entirely when RunResult has none (back-compat)', () => {
    const patch = buildStatusPatch(baseResult, fixedNow);
    expect(patch.artifacts).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(patch, 'artifacts')).toBe(false);
  });

  it('omits artifacts when RunResult.artifacts is an empty array', () => {
    const patch = buildStatusPatch({ ...baseResult, artifacts: [] }, fixedNow);
    expect(patch.artifacts).toBeUndefined();
  });

  it('round-trips artifacts on Completed status', () => {
    const result: RunResult = {
      ...baseResult,
      artifacts: [
        {
          uri: 'pvc://kagent-artifacts/task-uid-1/digest.md',
          mediaType: 'text/markdown',
          sizeBytes: 51284,
          checksum: 'sha256:abc123',
          name: 'digest.md',
          producedAt: '2026-04-26T09:59:00.000Z',
        },
      ],
    };
    const patch = buildStatusPatch(result, fixedNow);
    expect(patch.phase).toBe('Completed');
    expect(patch.artifacts).toHaveLength(1);
    expect(patch.artifacts?.[0]).toEqual({
      uri: 'pvc://kagent-artifacts/task-uid-1/digest.md',
      mediaType: 'text/markdown',
      sizeBytes: 51284,
      checksum: 'sha256:abc123',
      name: 'digest.md',
      producedAt: '2026-04-26T09:59:00.000Z',
    });
  });

  it('round-trips artifacts on Failed status (partial run can produce real outputs)', () => {
    const result: RunResult = {
      ...baseResult,
      status: 'failed',
      error: { message: 'LLM timeout' },
      artifacts: [
        {
          uri: 'pvc://kagent-artifacts/task-uid-1/partial.md',
          mediaType: 'text/markdown',
        },
      ],
    };
    const patch = buildStatusPatch(result, fixedNow);
    expect(patch.phase).toBe('Failed');
    expect(patch.artifacts).toHaveLength(1);
    expect(patch.artifacts?.[0]?.uri).toBe('pvc://kagent-artifacts/task-uid-1/partial.md');
  });

  /* =====================================================================
   * v0.1 P3 wire-up — artifacts flush on Completed AND non-completed
   * terminal paths (cancelled, timeout, budget_exceeded). The runner
   * builds RunResult.artifacts from the registry snapshot in all cases.
   * ===================================================================== */

  it('artifact flush survives non-completed terminal paths', () => {
    for (const status of ['cancelled', 'timeout', 'budget_exceeded'] as const) {
      const result: RunResult = {
        ...baseResult,
        status,
        artifacts: [
          {
            uri: `pvc://kagent-artifacts/task-uid-1/partial-${status}.md`,
            mediaType: 'text/markdown',
            sizeBytes: 4,
            checksum: 'sha256:deadbeef',
            contentHash: 'deadbeef',
          },
        ],
      };
      const patch = buildStatusPatch(result, fixedNow);
      expect(patch.phase).toBe('Failed');
      expect(patch.artifacts).toHaveLength(1);
      expect(patch.artifacts?.[0]?.uri).toBe(
        `pvc://kagent-artifacts/task-uid-1/partial-${status}.md`,
      );
      // contentHash forward-compat field round-trips.
      expect(patch.artifacts?.[0]?.contentHash).toBe('deadbeef');
    }
  });

  it('artifact flush is the SAME shape on Completed and Failed', () => {
    // The substrate contract: status.artifacts is identically populated
    // regardless of the terminal phase — so a Workbench renderer can
    // treat the field uniformly.
    const ref = {
      uri: 'pvc://kagent-artifacts/task-uid-1/uniform.md',
      mediaType: 'text/markdown',
      sizeBytes: 7,
      checksum: 'sha256:abc',
      contentHash: 'abc',
      name: 'uniform.md',
      producedAt: '2026-04-26T09:50:00.000Z',
    };
    const completed = buildStatusPatch(
      { ...baseResult, status: 'completed', artifacts: [ref] },
      fixedNow,
    );
    const failed = buildStatusPatch(
      { ...baseResult, status: 'failed', error: { message: 'x' }, artifacts: [ref] },
      fixedNow,
    );
    expect(completed.artifacts).toEqual(failed.artifacts);
  });
});

/* =====================================================================
 * buildArtifactsOnlyPatch — registry-flush helper.
 *
 * Used by callers that want to surface the in-pod ArtifactRegistry's
 * current snapshot independent of a full RunResult (e.g. a future
 * heartbeat / intermediate status update path).
 * ===================================================================== */

describe('buildArtifactsOnlyPatch', () => {
  it('emits {artifacts: [...]} when the snapshot is non-empty', () => {
    const registry = createArtifactRegistry();
    registry.add({
      uri: 'pvc://kagent-artifacts/uid-1/digest.md',
      name: 'digest.md',
      mediaType: 'text/markdown',
      sizeBytes: 7,
      checksum: 'sha256:xyz',
      contentHash: 'xyz',
    });
    const patch = buildArtifactsOnlyPatch(registry.snapshot());
    expect(patch.artifacts).toHaveLength(1);
    expect(patch.artifacts?.[0]?.uri).toBe('pvc://kagent-artifacts/uid-1/digest.md');
  });

  it('emits {} when the snapshot is empty (omits the field)', () => {
    const patch = buildArtifactsOnlyPatch([]);
    expect(patch.artifacts).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(patch, 'artifacts')).toBe(false);
  });

  it('returns a defensive copy so caller mutation does not leak', () => {
    const refs = [{ uri: 'pvc://k/u/a.md', name: 'a.md' }];
    const patch = buildArtifactsOnlyPatch(refs);
    (patch.artifacts as { uri: string }[] | undefined)?.push({ uri: 'leaked' });
    expect(refs).toHaveLength(1);
  });
});

/* =====================================================================
 * Audit C2 H8 — JSON Patch with `test` op precondition.
 *
 * Two writers race for the AgentTask status.phase transition to
 * terminal: the agent-pod (after the loop unwinds) and the operator's
 * job-watch (when the kubelet reports Job Failed first). Pre-fix
 * last-writer-wins clobbered Completed with Failed. The fix: each
 * writer attempts a JSON-Patch with a `test` op asserting status.phase
 * is still non-terminal. On 412 Precondition Failed, the writer drops
 * silently — terminal-already is the right end state.
 * ===================================================================== */

describe('buildJsonPatchOps (H8)', () => {
  const completedPatch: StatusPatch = {
    phase: 'Completed',
    result: { content: 'done' },
    completedAt: '2026-04-26T10:00:00.000Z',
    structuralVerdict: { suspicious: [] },
  };

  it('emits a test op as the first operation, asserting expected pre-terminal phase', () => {
    const ops = buildJsonPatchOps(completedPatch, 'Dispatched');
    expect(ops[0]).toEqual({ op: 'test', path: '/status/phase', value: 'Dispatched' });
  });

  it('uses RFC 6902 add ops (not replace) so missing status subresource works', () => {
    const ops = buildJsonPatchOps(completedPatch, 'Dispatched');
    for (const op of ops.slice(1)) {
      expect(op.op).toBe('add');
    }
  });

  it('writes phase, completedAt, result, structuralVerdict for Completed', () => {
    const ops = buildJsonPatchOps(completedPatch, 'Dispatched');
    const paths = ops.map((o) => o.path);
    expect(paths).toContain('/status/phase');
    expect(paths).toContain('/status/completedAt');
    expect(paths).toContain('/status/result');
    expect(paths).toContain('/status/structuralVerdict');
  });

  it('writes error instead of result for Failed', () => {
    const ops = buildJsonPatchOps(
      {
        phase: 'Failed',
        error: 'boom',
        completedAt: '2026-04-26T10:00:00.000Z',
        structuralVerdict: { suspicious: [] },
      },
      'Dispatched',
    );
    const paths = ops.map((o) => o.path);
    expect(paths).toContain('/status/error');
    expect(paths).not.toContain('/status/result');
  });

  it('omits artifacts op when patch.artifacts is undefined', () => {
    const ops = buildJsonPatchOps(completedPatch, 'Dispatched');
    const paths = ops.map((o) => o.path);
    expect(paths).not.toContain('/status/artifacts');
  });

  it('includes artifacts op when patch.artifacts is set', () => {
    const ops = buildJsonPatchOps(
      {
        ...completedPatch,
        artifacts: [{ uri: 'pvc://kagent-artifacts/uid/x.md', mediaType: 'text/markdown' }],
      },
      'Dispatched',
    );
    const paths = ops.map((o) => o.path);
    expect(paths).toContain('/status/artifacts');
  });
});

describe('isPreconditionFailed (H8)', () => {
  it('returns true for code=412', () => {
    const err = Object.assign(new Error('precondition failed'), { code: 412 });
    expect(isPreconditionFailed(err)).toBe(true);
  });

  it('returns false for 409 Conflict — must propagate, not be swallowed', () => {
    const err = Object.assign(new Error('conflict'), { code: 409 });
    expect(isPreconditionFailed(err)).toBe(false);
  });

  it('returns true for code=422 because K3s reports JSON Patch test failure as Invalid', () => {
    const err = Object.assign(new Error('invalid'), { code: 422 });
    expect(isPreconditionFailed(err)).toBe(true);
  });

  it('returns false for 500 Server Error', () => {
    const err = Object.assign(new Error('boom'), { code: 500 });
    expect(isPreconditionFailed(err)).toBe(false);
  });

  it('returns false for plain Errors with no code property', () => {
    expect(isPreconditionFailed(new Error('not http'))).toBe(false);
  });

  it('returns false for null / undefined / non-objects', () => {
    expect(isPreconditionFailed(null)).toBe(false);
    expect(isPreconditionFailed(undefined)).toBe(false);
    expect(isPreconditionFailed('string err')).toBe(false);
    expect(isPreconditionFailed(42)).toBe(false);
  });
});

describe('writeStatus (H8) — JSON Patch with test op + 412/422 guarded writes', () => {
  const podConfig: Pick<PodConfig, 'taskNamespace' | 'taskName'> = {
    taskNamespace: 'default',
    taskName: 'task-1',
  };

  const completedPatch: StatusPatch = {
    phase: 'Completed',
    result: { content: 'done' },
    completedAt: '2026-04-26T10:00:00.000Z',
    structuralVerdict: { suspicious: [] },
  };

  function makeMockApi(
    impl: (req: unknown, opts: unknown) => Promise<unknown>,
    getStatusImpl: () => Promise<unknown> = () =>
      Promise.resolve({ status: { phase: 'Completed' } }),
  ): CustomObjectsApi {
    return {
      patchNamespacedCustomObjectStatus: vi.fn(impl),
      getNamespacedCustomObjectStatus: vi.fn(getStatusImpl),
    } as unknown as CustomObjectsApi;
  }

  it('non-terminal-state attempt → 200 → succeeds (single roundtrip when Dispatched test passes)', async () => {
    let calls = 0;
    const api = makeMockApi(() => {
      calls += 1;
      return Promise.resolve({ status: { phase: 'Completed' } });
    });
    await writeStatus(podConfig as PodConfig, completedPatch, api);
    expect(calls).toBe(1);
  });

  it('uses Content-Type: application/json-patch+json (NOT merge-patch)', async () => {
    // setHeaderOptions returns an opaque middleware-shaped object whose
    // headers aren't reflected on a JSON.stringify. Drive the middleware
    // explicitly to assert the header it injects on outgoing requests.
    let recordedOpts: { middleware?: ReadonlyArray<{ pre?: (ctx: unknown) => unknown }> } = {};
    const api = makeMockApi((_req, opts) => {
      recordedOpts = opts as typeof recordedOpts;
      return Promise.resolve({});
    });
    await writeStatus(podConfig as PodConfig, completedPatch, api);
    expect(Array.isArray(recordedOpts.middleware)).toBe(true);
    // Build a fake RequestContext, run each middleware's `pre` hook, and
    // capture the Content-Type header it sets. This mirrors how the
    // generated client-node API plumbs `Configuration.middleware` into
    // request building.
    const headers: Record<string, string> = {};
    const fakeCtx = {
      setHeaderParam(name: string, value: string) {
        headers[name] = value;
      },
    };
    for (const mw of recordedOpts.middleware ?? []) {
      const out = mw.pre?.(fakeCtx);
      // RxJS observables are returned by middleware.pre — drive the
      // synchronous emission by subscribing.
      const maybeObservable = out as { subscribe?: (cb: (ctx: unknown) => void) => unknown };
      if (typeof maybeObservable?.subscribe === 'function') {
        maybeObservable.subscribe(() => undefined);
      }
    }
    expect(headers['Content-Type']).toBe('application/json-patch+json');
    expect(headers['Content-Type']).not.toContain('merge-patch+json');
  });

  it('sends a body with the test op as the first array entry (RFC 6902)', async () => {
    let recordedReq: { body?: unknown } = {};
    const api = makeMockApi((req) => {
      recordedReq = req as { body?: unknown };
      return Promise.resolve({});
    });
    await writeStatus(podConfig as PodConfig, completedPatch, api);
    expect(Array.isArray(recordedReq.body)).toBe(true);
    const body = recordedReq.body as Array<{ op?: string; path?: string }>;
    expect(body[0]?.op).toBe('test');
    expect(body[0]?.path).toBe('/status/phase');
  });

  it('terminal-state attempt → 412 → swallowed (no throw, no infinite retry)', async () => {
    // Both Dispatched + Pending tests fail with 412 → another writer
    // already terminalized. Drop silently.
    let calls = 0;
    const api = makeMockApi(() => {
      calls += 1;
      return Promise.reject(
        Object.assign(new Error('precondition failed: status.phase != ...'), { code: 412 }),
      );
    });
    // Must NOT throw.
    await writeStatus(podConfig as PodConfig, completedPatch, api);
    // Two attempts: Dispatched, then Pending. Both 412 → drop.
    expect(calls).toBe(2);
  });

  it('Dispatched test fails 412, Pending test succeeds → succeeds without throwing', async () => {
    // Edge case: the apiserver hasn't yet seen the dispatcher's
    // promotion to Dispatched — phase is still Pending. First test op
    // (Dispatched) returns 412; second (Pending) succeeds.
    let calls = 0;
    const api = makeMockApi((req) => {
      calls += 1;
      const body = (req as { body?: Array<{ op: string; value: unknown }> }).body ?? [];
      const testOp = body[0];
      if (testOp?.op === 'test' && testOp.value === 'Dispatched') {
        return Promise.reject(Object.assign(new Error('precondition failed'), { code: 412 }));
      }
      return Promise.resolve({});
    });
    await writeStatus(podConfig as PodConfig, completedPatch, api);
    expect(calls).toBe(2);
  });

  it('Dispatched test fails 422, Pending test succeeds → succeeds without throwing', async () => {
    // Live K3s reports a JSON Patch `test` mismatch as 422 Invalid
    // rather than 412 Precondition Failed. It is still a retryable
    // phase-guard failure when the next expected phase matches.
    let calls = 0;
    const getStatus = vi.fn(() => Promise.reject(new Error('status read should not run')));
    const api = makeMockApi((req) => {
      calls += 1;
      const body = (req as { body?: Array<{ op: string; value: unknown }> }).body ?? [];
      const testOp = body[0];
      if (testOp?.op === 'test' && testOp.value === 'Dispatched') {
        return Promise.reject(Object.assign(new Error('invalid json patch test'), { code: 422 }));
      }
      return Promise.resolve({});
    }, getStatus);
    await writeStatus(podConfig as PodConfig, completedPatch, api);
    expect(calls).toBe(2);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('412 differentiation — 409 Conflict propagates (NOT swallowed)', async () => {
    const api = makeMockApi(() =>
      Promise.reject(Object.assign(new Error('conflict on resourceVersion'), { code: 409 })),
    );
    await expect(writeStatus(podConfig as PodConfig, completedPatch, api)).rejects.toThrow(
      /conflict/,
    );
  });

  it('422 differentiation — propagates when the task is still non-terminal', async () => {
    const api = makeMockApi(
      () => Promise.reject(Object.assign(new Error('invalid'), { code: 422 })),
      () => Promise.resolve({ status: { phase: 'Pending' } }),
    );
    await expect(writeStatus(podConfig as PodConfig, completedPatch, api)).rejects.toThrow(
      /invalid/,
    );
  });

  it('422 differentiation — swallowed only when status read confirms terminal phase', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      let patchCalls = 0;
      let getCalls = 0;
      const api = makeMockApi(
        () => {
          patchCalls += 1;
          return Promise.reject(Object.assign(new Error('invalid json patch test'), { code: 422 }));
        },
        () => {
          getCalls += 1;
          return Promise.resolve({ status: { phase: 'Failed' } });
        },
      );
      await writeStatus(podConfig as PodConfig, completedPatch, api);
      expect(patchCalls).toBe(2);
      expect(getCalls).toBe(1);
      const messages = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toContain('status patch dropped');
      expect(messages).toContain('default/task-1');
      expect(messages).toContain('422');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('412 differentiation — 500 Server Error propagates', async () => {
    const api = makeMockApi(() => Promise.reject(Object.assign(new Error('boom'), { code: 500 })));
    await expect(writeStatus(podConfig as PodConfig, completedPatch, api)).rejects.toThrow(/boom/);
  });

  it('network error (no code property) propagates', async () => {
    const api = makeMockApi(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(writeStatus(podConfig as PodConfig, completedPatch, api)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it('logs (does not throw) when both pre-terminal phases return 412', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const api = makeMockApi(() =>
        Promise.reject(Object.assign(new Error('precondition failed'), { code: 412 })),
      );
      await writeStatus(podConfig as PodConfig, completedPatch, api);
      const messages = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toContain('status patch dropped');
      expect(messages).toContain('default/task-1');
      expect(messages).toContain('412');
    } finally {
      logSpy.mockRestore();
    }
  });
});
