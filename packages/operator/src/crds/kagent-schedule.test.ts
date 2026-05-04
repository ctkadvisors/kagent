/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION } from './types.js';
import { isKagentSchedule, type KagentSchedule } from './kagent-schedule.js';

const validResource: KagentSchedule = {
  apiVersion: API_GROUP_VERSION,
  kind: 'KagentSchedule',
  metadata: { name: 'daily', namespace: 'kagent-system' },
  spec: {
    schedule: '0 6 * * *',
    taskTemplate: {
      targetAgent: 'researcher',
      payload: { prompt: 'go' },
    },
  },
};

describe('isKagentSchedule', () => {
  it('accepts a valid KagentSchedule resource', () => {
    expect(isKagentSchedule(validResource)).toBe(true);
  });

  it('rejects an object with the wrong apiVersion', () => {
    expect(isKagentSchedule({ ...validResource, apiVersion: 'apps/v1' })).toBe(false);
  });

  it('rejects an object with the wrong kind', () => {
    expect(isKagentSchedule({ ...validResource, kind: 'AgentTask' })).toBe(false);
  });

  it('rejects when spec is missing', () => {
    const { spec: _spec, ...rest } = validResource;
    expect(isKagentSchedule(rest)).toBe(false);
  });

  it('rejects when spec.schedule is empty', () => {
    expect(
      isKagentSchedule({
        ...validResource,
        spec: { ...validResource.spec, schedule: '' },
      }),
    ).toBe(false);
  });

  it('rejects when spec.schedule is non-string', () => {
    expect(
      isKagentSchedule({
        ...validResource,
        spec: { ...validResource.spec, schedule: 5 as unknown as string },
      }),
    ).toBe(false);
  });

  it('rejects when spec.taskTemplate is missing', () => {
    expect(
      isKagentSchedule({
        ...validResource,
        spec: { schedule: '* * * * *' } as unknown as KagentSchedule['spec'],
      }),
    ).toBe(false);
  });

  it('rejects null and primitives', () => {
    expect(isKagentSchedule(null)).toBe(false);
    expect(isKagentSchedule(42)).toBe(false);
    expect(isKagentSchedule('whatever')).toBe(false);
  });
});
