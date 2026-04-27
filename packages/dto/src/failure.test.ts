/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import type { V1Job, V1Pod } from '@kubernetes/client-node';

import {
  type FailureVerdict,
  detectFailure,
  detectJobFailure,
  detectPodFailure,
} from './failure.js';

function jobWithCondition(
  type: string,
  status: 'True' | 'False',
  extras: Partial<{ reason: string; message: string }> = {},
): V1Job {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'kat-abc-123', namespace: 'kagent-system' },
    spec: { backoffLimit: 0, template: { spec: { containers: [] } } },
    status: { conditions: [{ type, status, ...extras }] },
  };
}

function podWithStatus(status: NonNullable<V1Pod['status']>): V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'kat-abc-123-xyz', namespace: 'kagent-system' },
    spec: { containers: [{ name: 'agent', image: 'x' }] },
    status,
  };
}

describe('detectJobFailure', () => {
  it('returns null for a healthy in-progress Job', () => {
    expect(
      detectJobFailure({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: 'k', namespace: 'n' },
        status: { active: 1 },
      }),
    ).toBeNull();
  });

  it('returns null for a Job that succeeded (success path is owned by agent-pod)', () => {
    expect(
      detectJobFailure({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: 'k', namespace: 'n' },
        status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] },
      }),
    ).toBeNull();
  });

  it('flags Failed=True with reason + message', () => {
    expect(
      detectJobFailure(
        jobWithCondition('Failed', 'True', { reason: 'BackoffLimitExceeded', message: 'gave up' }),
      ),
    ).toEqual<FailureVerdict>({
      reason: 'BackoffLimitExceeded',
      message: 'gave up',
      source: 'job',
    });
  });

  it('flags DeadlineExceeded condition (newer K8s split)', () => {
    expect(
      detectJobFailure(jobWithCondition('DeadlineExceeded', 'True', { message: 'over limit' })),
    ).toEqual<FailureVerdict>({
      reason: 'DeadlineExceeded',
      message: 'over limit',
      source: 'job',
    });
  });

  it('falls back to defaults when reason/message are absent', () => {
    expect(detectJobFailure(jobWithCondition('Failed', 'True'))).toEqual<FailureVerdict>({
      reason: 'JobFailed',
      message: 'Job kat-abc-123 reached condition Failed=True',
      source: 'job',
    });
  });

  it('flags backoff exhaustion past backoffLimit', () => {
    const v = detectJobFailure({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'kat-abc-123' },
      spec: { backoffLimit: 0, template: { spec: { containers: [] } } },
      status: { failed: 1 },
    });
    expect(v).toEqual<FailureVerdict>({
      reason: 'BackoffLimitExceeded',
      message: 'Job kat-abc-123 failed 1 times (backoffLimit=0)',
      source: 'job',
    });
  });
});

describe('detectPodFailure', () => {
  it('returns null for a Running pod', () => {
    expect(
      podWithStatus({ phase: 'Running' }) && detectPodFailure(podWithStatus({ phase: 'Running' })),
    ).toBeNull();
  });

  it('flags phase=Failed', () => {
    expect(
      detectPodFailure(podWithStatus({ phase: 'Failed', reason: 'OOMKilled', message: 'killed' })),
    ).toEqual<FailureVerdict>({
      reason: 'OOMKilled',
      message: 'killed',
      source: 'pod',
    });
  });

  it('flags Unschedulable', () => {
    const v = detectPodFailure(
      podWithStatus({
        phase: 'Pending',
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message: '0/3 nodes',
          },
        ],
      }),
    );
    expect(v).toEqual<FailureVerdict>({
      reason: 'Unschedulable',
      message: '0/3 nodes',
      source: 'pod',
    });
  });

  it('flags ImagePullBackOff via container waiting state', () => {
    const v = detectPodFailure(
      podWithStatus({
        phase: 'Pending',
        containerStatuses: [
          {
            name: 'agent',
            image: 'ghcr.io/x:y',
            imageID: '',
            ready: false,
            restartCount: 0,
            started: false,
            state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling' } },
          },
        ],
      }),
    );
    expect(v).toEqual<FailureVerdict>({
      reason: 'ImagePullBackOff',
      message: 'kat-abc-123-xyz container agent ImagePullBackOff: Back-off pulling',
      source: 'pod',
    });
  });

  it('returns null for a non-terminal waiting reason (e.g. PodInitializing)', () => {
    expect(
      detectPodFailure(
        podWithStatus({
          phase: 'Pending',
          containerStatuses: [
            {
              name: 'agent',
              image: 'x',
              imageID: '',
              ready: false,
              restartCount: 0,
              started: false,
              state: { waiting: { reason: 'PodInitializing' } },
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe('detectFailure (combined)', () => {
  it('prefers Pod verdict when both fire', () => {
    const job = jobWithCondition('Failed', 'True', { reason: 'BackoffLimitExceeded' });
    const pod = podWithStatus({
      phase: 'Pending',
      containerStatuses: [
        {
          name: 'agent',
          image: 'x',
          imageID: '',
          ready: false,
          restartCount: 0,
          started: false,
          state: { waiting: { reason: 'ImagePullBackOff' } },
        },
      ],
    });
    expect(detectFailure(job, pod)?.reason).toBe('ImagePullBackOff');
  });

  it('falls back to Job verdict when Pod is healthy', () => {
    const job = jobWithCondition('DeadlineExceeded', 'True');
    const pod = podWithStatus({ phase: 'Running' });
    expect(detectFailure(job, pod)?.reason).toBe('DeadlineExceeded');
  });

  it('returns null when both healthy', () => {
    expect(
      detectFailure(
        { apiVersion: 'batch/v1', kind: 'Job', metadata: {}, status: { active: 1 } },
        podWithStatus({ phase: 'Running' }),
      ),
    ).toBeNull();
  });
});
