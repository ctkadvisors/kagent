/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import type { V1Job, V1Pod } from '@kubernetes/client-node';

import {
  detectFailure,
  detectJobFailure,
  detectPodFailure,
  type FailureVerdict,
} from './failure-detector.js';

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

  it('flags Failed=True with the condition reason + message', () => {
    const v = detectJobFailure(
      jobWithCondition('Failed', 'True', { reason: 'BackoffLimitExceeded', message: 'gave up' }),
    );
    expect(v).toEqual<FailureVerdict>({
      reason: 'BackoffLimitExceeded',
      message: 'gave up',
      source: 'job',
    });
  });

  it('flags DeadlineExceeded condition (newer K8s split)', () => {
    const v = detectJobFailure(
      jobWithCondition('DeadlineExceeded', 'True', { message: 'over limit' }),
    );
    expect(v).toEqual<FailureVerdict>({
      reason: 'DeadlineExceeded',
      message: 'over limit',
      source: 'job',
    });
  });

  it('flags backoff exhaustion when status.failed exceeds backoffLimit', () => {
    const v = detectJobFailure({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'kat', namespace: 'n' },
      spec: { backoffLimit: 0, template: { spec: { containers: [] } } },
      status: { failed: 1 },
    });
    expect(v?.reason).toBe('BackoffLimitExceeded');
    expect(v?.source).toBe('job');
  });

  it('falls back to a default reason when condition omits it', () => {
    const v = detectJobFailure(jobWithCondition('Failed', 'True'));
    expect(v?.reason).toBe('JobFailed');
  });
});

describe('detectPodFailure', () => {
  it('returns null for a Running pod with no terminal waiting reasons', () => {
    expect(detectPodFailure(podWithStatus({ phase: 'Running' }))).toBeNull();
  });

  it('returns null for a Pending pod whose containers are still scheduling', () => {
    expect(
      detectPodFailure(
        podWithStatus({
          phase: 'Pending',
          containerStatuses: [
            {
              name: 'agent',
              ready: false,
              restartCount: 0,
              image: 'x',
              imageID: '',
              state: { waiting: { reason: 'ContainerCreating' } },
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('flags phase=Failed with the pod-level reason', () => {
    const v = detectPodFailure(
      podWithStatus({
        phase: 'Failed',
        reason: 'OOMKilled',
        message: 'killed for memory',
      }),
    );
    expect(v).toEqual<FailureVerdict>({
      reason: 'OOMKilled',
      message: 'killed for memory',
      source: 'pod',
    });
  });

  it('flags ImagePullBackOff in container waiting state', () => {
    const v = detectPodFailure(
      podWithStatus({
        phase: 'Pending',
        containerStatuses: [
          {
            name: 'agent',
            ready: false,
            restartCount: 0,
            image: 'x',
            imageID: '',
            state: {
              waiting: { reason: 'ImagePullBackOff', message: 'manifest unknown' },
            },
          },
        ],
      }),
    );
    expect(v?.reason).toBe('ImagePullBackOff');
    expect(v?.message).toContain('agent');
    expect(v?.message).toContain('manifest unknown');
    expect(v?.source).toBe('pod');
  });

  it.each([
    'ErrImagePull',
    'CrashLoopBackOff',
    'CreateContainerConfigError',
    'CreateContainerError',
    'RunContainerError',
    'InvalidImageName',
    'PreCreateHookError',
    'PostStartHookError',
  ])('flags %s as terminal', (reason) => {
    const v = detectPodFailure(
      podWithStatus({
        phase: 'Pending',
        containerStatuses: [
          {
            name: 'agent',
            ready: false,
            restartCount: 0,
            image: 'x',
            imageID: '',
            state: { waiting: { reason } },
          },
        ],
      }),
    );
    expect(v?.reason).toBe(reason);
  });

  it('flags PodScheduled=False with reason=Unschedulable', () => {
    const v = detectPodFailure(
      podWithStatus({
        phase: 'Pending',
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message: '0/4 nodes are available: 4 Insufficient cpu.',
          },
        ],
      }),
    );
    expect(v?.reason).toBe('Unschedulable');
    expect(v?.message).toContain('Insufficient cpu');
  });

  it('does NOT flag PodScheduled=False when reason is something benign (e.g. retry)', () => {
    const v = detectPodFailure(
      podWithStatus({
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', reason: 'SchedulerError' }],
      }),
    );
    expect(v).toBeNull();
  });
});

describe('detectFailure (combined)', () => {
  it('prefers pod verdict over job verdict when both are non-null', () => {
    const job = jobWithCondition('Failed', 'True', { reason: 'BackoffLimitExceeded' });
    const pod = podWithStatus({
      phase: 'Pending',
      containerStatuses: [
        {
          name: 'agent',
          ready: false,
          restartCount: 0,
          image: 'x',
          imageID: '',
          state: { waiting: { reason: 'ImagePullBackOff' } },
        },
      ],
    });
    const v = detectFailure(job, pod);
    expect(v?.reason).toBe('ImagePullBackOff');
    expect(v?.source).toBe('pod');
  });

  it('falls back to job verdict when no pod is supplied', () => {
    const v = detectFailure(jobWithCondition('Failed', 'True', { reason: 'X' }));
    expect(v?.source).toBe('job');
  });

  it('returns null when both healthy', () => {
    expect(
      detectFailure({ status: { active: 1 } }, podWithStatus({ phase: 'Running' })),
    ).toBeNull();
  });
});
