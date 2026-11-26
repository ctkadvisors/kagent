/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { buildSnapshot } from './k8s-task-creator.js';

describe('buildSnapshot', () => {
  it("carries the child's followable artifact refs to a waiting parent", () => {
    const snapshot = buildSnapshot(
      {
        metadata: { name: 'child', namespace: 'kagent-system', uid: 'uid-child' },
        status: {
          phase: 'Completed',
          result: { content: 'done' },
          artifacts: [
            {
              uri: 'pvc://kagent-artifacts/uid-child/report.md',
              name: 'report.md',
              mediaType: 'text/markdown',
              sizeBytes: 12,
              checksum: 'sha256:abc',
              producedAt: '2026-11-26T16:00:00Z',
            },
            { uri: 'inline://sha256:def', name: 'candidate.yaml', payloadBase64: 'eA==' },
            'not a ref',
          ],
        },
      },
      'kagent-system',
    );
    expect(snapshot.artifacts).toEqual([
      {
        uri: 'pvc://kagent-artifacts/uid-child/report.md',
        name: 'report.md',
        mediaType: 'text/markdown',
        sizeBytes: 12,
        checksum: 'sha256:abc',
      },
    ]);
  });

  it('has no artifacts key when the child wrote none', () => {
    const snapshot = buildSnapshot(
      { metadata: { name: 'c', uid: 'u' }, status: { phase: 'Failed', error: 'boom' } },
      'kagent-system',
    );
    expect('artifacts' in snapshot).toBe(false);
  });
});
