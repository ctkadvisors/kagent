/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { classifyFailure, isInfraFault, shouldTriggerSupervision } from './failure-classifier.js';

describe('failure-classifier — structured catalog', () => {
  it.each([
    'InvalidInputs',
    'MissingRequiredOutputs',
    'IdempotencyConflict',
    'capability_violation',
    'verify_failed',
    'contract.violated',
    'PolicyDenied',
    'restart_limit_exceeded',
    'supervision_terminated',
  ])('%s is structured', (reason) => {
    expect(classifyFailure(reason)).toBe('structured');
  });

  it('policy_denied:<X> prefix is structured', () => {
    expect(classifyFailure('policy_denied:depth_exceeded')).toBe('structured');
    expect(classifyFailure('policy_denied:capability_violation')).toBe('structured');
    expect(classifyFailure('policy_denied:IdempotencyConflict')).toBe('structured');
  });
});

describe('failure-classifier — infra catalog', () => {
  it.each([
    'JobFailed',
    'BackoffLimitExceeded',
    'DeadlineExceeded',
    'OOMKilled',
    'PodFailed',
    'Unschedulable',
    'ImagePullBackOff',
    'ErrImagePull',
    'CrashLoopBackOff',
    'CreateContainerConfigError',
    'CreateContainerError',
    'RunContainerError',
    'InvalidImageName',
    'PreCreateHookError',
    'PostStartHookError',
    'NodeNotReady',
    'NodeLost',
    'Evicted',
    'ContainerCannotRun',
  ])('%s is infra', (reason) => {
    expect(classifyFailure(reason)).toBe('infra');
  });

  it('strips Job/ prefix before matching', () => {
    expect(classifyFailure('Job/JobFailed')).toBe('infra');
    expect(classifyFailure('Job/BackoffLimitExceeded')).toBe('infra');
  });

  it('strips Pod/ prefix before matching', () => {
    expect(classifyFailure('Pod/OOMKilled')).toBe('infra');
    expect(classifyFailure('Pod/Unschedulable')).toBe('infra');
  });

  it('case-insensitive matches for common families (imagepull, oomkilled, evicted)', () => {
    expect(classifyFailure('SomePrefix-imagepull-error')).toBe('infra');
    expect(classifyFailure('killed-by-oomkilled')).toBe('infra');
    expect(classifyFailure('node-evicted-pod')).toBe('infra');
  });
});

describe('failure-classifier — unknown + edge cases', () => {
  it('empty / undefined → unknown (conservative)', () => {
    expect(classifyFailure(undefined)).toBe('unknown');
    expect(classifyFailure('')).toBe('unknown');
  });

  it('an arbitrary string the operator never emits → unknown', () => {
    expect(classifyFailure('SomeNewReasonNobodyCatalogedYet')).toBe('unknown');
  });
});

describe('shouldTriggerSupervision', () => {
  it('routes structured failures through supervision', () => {
    expect(shouldTriggerSupervision('MissingRequiredOutputs')).toBe(true);
    expect(shouldTriggerSupervision('policy_denied:capability_violation')).toBe(true);
  });

  it('does NOT route infra failures through supervision', () => {
    expect(shouldTriggerSupervision('OOMKilled')).toBe(false);
    expect(shouldTriggerSupervision('Job/BackoffLimitExceeded')).toBe(false);
    expect(shouldTriggerSupervision('Pod/ImagePullBackOff')).toBe(false);
  });

  it('routes unknown failures through supervision (conservative default)', () => {
    expect(shouldTriggerSupervision('SomeNewReason')).toBe(true);
    expect(shouldTriggerSupervision(undefined)).toBe(true);
  });
});

describe('isInfraFault', () => {
  it('true only for explicitly infra-classed reasons', () => {
    expect(isInfraFault('OOMKilled')).toBe(true);
    expect(isInfraFault('Pod/Unschedulable')).toBe(true);
    expect(isInfraFault('MissingRequiredOutputs')).toBe(false);
    expect(isInfraFault('SomeNewReason')).toBe(false);
    expect(isInfraFault(undefined)).toBe(false);
  });
});
