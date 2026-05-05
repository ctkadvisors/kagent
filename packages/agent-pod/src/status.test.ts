/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { createArtifactRegistry } from './artifacts.js';
import type { RunResult } from './runner.js';
import { buildArtifactsOnlyPatch, buildStatusPatch } from './status.js';

const baseResult: RunResult = {
  runId: 'task-uid-1',
  status: 'completed',
  finalContent: 'K3s uses containerd by default.',
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
