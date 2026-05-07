/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Regression test for Audit Rev2 BLOCKER B3 — verifier↔job-watch label
 * collision.
 *
 * Verifier Jobs carry both:
 *   - `kagent.knuteson.io/managed-by=kagent-operator` (selected by
 *     job-watch's informer)
 *   - `kagent.knuteson.io/task=<parent-name>`         (resolved by
 *     `parentTaskRef`)
 *
 * Plus the verifier-only label:
 *   - `kagent.knuteson.io/verifier=true`
 *
 * Before the fix, a verifier Job that exited non-zero (the "fail"
 * verdict) routed through `markAgentTaskFailedFromExternal` and
 * appended `JobFailedAfterComplete` to the parent AgentTask — even
 * though the parent had already terminated `Completed` and the
 * verdict belonged on `status.verification`, not on the parent's
 * phase.
 *
 * The guard in `routeJobEventToFailureSurface` short-circuits on
 * `isVerifierJob(job)` BEFORE calling `parentTaskRef` or
 * `detectJobFailure`, so verifier verdicts no longer clobber parent
 * AgentTask conditions.
 */

import type { V1Job } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';

import { routeJobEventToFailureSurface } from './main.js';
import { TASK_LABEL_KEY } from './job-watch.js';
import { VERIFIER_JOB_LABEL } from './verifier.js';

function failedJob(extraLabels: Record<string, string>): V1Job {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: 'kat-abc-123-verify',
      namespace: 'kagent-system',
      labels: {
        'kagent.knuteson.io/managed-by': 'kagent-operator',
        [TASK_LABEL_KEY]: 'researcher-1',
        ...extraLabels,
      },
    },
    spec: { backoffLimit: 0, template: { spec: { containers: [] } } },
    status: {
      conditions: [
        {
          type: 'Failed',
          status: 'True',
          reason: 'BackoffLimitExceeded',
          message: 'verifier exited non-zero',
        },
      ],
    },
  };
}

describe('routeJobEventToFailureSurface — B3 verifier guard', () => {
  it('does NOT call surfaceFailure for a verifier-labeled Job', async () => {
    const surfaceFailure = vi.fn(async () => {});
    const job = failedJob({ [VERIFIER_JOB_LABEL]: 'true' });

    await routeJobEventToFailureSurface(job, surfaceFailure);

    expect(surfaceFailure).not.toHaveBeenCalled();
  });

  it('DOES call surfaceFailure for a regular dispatch Job (no verifier label) on terminal Failed', async () => {
    const surfaceFailure = vi.fn(async () => {});
    const job = failedJob({});

    await routeJobEventToFailureSurface(job, surfaceFailure);

    expect(surfaceFailure).toHaveBeenCalledTimes(1);
    expect(surfaceFailure).toHaveBeenCalledWith(
      { namespace: 'kagent-system', name: 'researcher-1' },
      expect.objectContaining({ source: 'job', reason: 'BackoffLimitExceeded' }),
    );
  });

  it('skips Jobs missing the parent-task label even without the verifier label', async () => {
    const surfaceFailure = vi.fn(async () => {});
    // Strip the parent-task label entirely.
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: 'orphan-job',
        namespace: 'kagent-system',
        labels: { 'kagent.knuteson.io/managed-by': 'kagent-operator' },
      },
      spec: { backoffLimit: 0, template: { spec: { containers: [] } } },
      status: { conditions: [{ type: 'Failed', status: 'True' }] },
    };

    await routeJobEventToFailureSurface(job, surfaceFailure);

    expect(surfaceFailure).not.toHaveBeenCalled();
  });

  it('does NOT call surfaceFailure for a non-terminal Job even when not a verifier Job', async () => {
    const surfaceFailure = vi.fn(async () => {});
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: 'kat-abc-123',
        namespace: 'kagent-system',
        labels: {
          'kagent.knuteson.io/managed-by': 'kagent-operator',
          [TASK_LABEL_KEY]: 'researcher-1',
        },
      },
      spec: { backoffLimit: 0, template: { spec: { containers: [] } } },
      status: { active: 1 },
    };

    await routeJobEventToFailureSurface(job, surfaceFailure);

    expect(surfaceFailure).not.toHaveBeenCalled();
  });
});
