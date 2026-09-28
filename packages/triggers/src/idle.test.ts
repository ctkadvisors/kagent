/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { ABANDON_GRACE_SECONDS, assessNamespaceIdle, type JobView, type TaskView } from './idle.js';

const now = new Date('2026-09-28T16:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

function task(
  name: string,
  createdMinAgo: number,
  phase = 'Pending',
  extra: { schedule?: string; timeoutSeconds?: number; completedMinAgo?: number } = {},
): TaskView {
  return {
    metadata: {
      name,
      creationTimestamp: ago(createdMinAgo),
      ...(extra.schedule !== undefined && {
        labels: { 'kagent.knuteson.io/trigger-name': extra.schedule },
      }),
    },
    spec: { runConfig: { timeoutSeconds: extra.timeoutSeconds ?? 14400 } },
    status: {
      phase,
      ...(extra.completedMinAgo !== undefined && { completedAt: ago(extra.completedMinAgo) }),
    },
  };
}
const job = (taskName: string, state: 'running' | 'suspended' | 'failed'): JobView => ({
  metadata: { labels: { 'kagent.knuteson.io/task': taskName } },
  spec: { suspend: state === 'suspended' },
  status: state === 'running' ? { active: 1 } : state === 'failed' ? { failed: 1 } : {},
});

describe('assessNamespaceIdle', () => {
  it('a running task does not make the namespace busy; its own schedule is active', () => {
    const a = assessNamespaceIdle(
      [task('inv-1', 230, 'Pending', { schedule: 'fleet-nightly-invention' })],
      [job('inv-1', 'running')],
      now,
    );
    expect(a.idleSince?.toISOString()).toBe(ago(230));
    expect(a.activeSchedules.has('fleet-nightly-invention')).toBe(true);
    expect(a.activeSchedules.has('fleet-dispose-open-flags')).toBe(false);
  });

  it('a task waiting for admission (suspended Job, or no Job yet) makes it busy', () => {
    expect(
      assessNamespaceIdle([task('q', 2)], [job('q', 'suspended')], now).idleSince,
    ).toBeUndefined();
    expect(assessNamespaceIdle([task('q', 1)], [], now).idleSince).toBeUndefined();
  });

  it('a failed child with a running parent blocks nothing', () => {
    const a = assessNamespaceIdle(
      [
        task('inv-1', 230, 'Pending', { schedule: 'inv' }),
        task('inv-1-c-x', 120, 'Failed', { completedMinAgo: 90 }),
      ],
      [job('inv-1', 'running'), job('inv-1-c-x', 'failed')],
      now,
    );
    expect(a.idleSince).toBeDefined();
  });

  it('a task stuck Pending past its deadline with no Job is abandoned: ignored and reported', () => {
    const stuck = task('stuck', 60, 'Pending', { schedule: 'inv', timeoutSeconds: 1800 });
    expect(60 * 60).toBeGreaterThan(1800 + ABANDON_GRACE_SECONDS);
    const a = assessNamespaceIdle(
      [stuck, task('old', 200, 'Completed', { completedMinAgo: 100 })],
      [],
      now,
    );
    expect(a.idleSince?.toISOString()).toBe(ago(100));
    expect(a.abandoned).toEqual(['stuck']);
    expect(a.activeSchedules.has('inv')).toBe(false);
  });

  it('a Job that finished before its task wrote status is not queued work', () => {
    expect(assessNamespaceIdle([task('t', 20)], [job('t', 'failed')], now).idleSince).toBeDefined();
  });

  it('once the parent is terminal its schedule is free and quiet counts from its completion', () => {
    const a = assessNamespaceIdle(
      [task('inv-1', 240, 'Completed', { schedule: 'inv', completedMinAgo: 10 })],
      [],
      now,
    );
    expect(a.activeSchedules.size).toBe(0);
    expect(a.idleSince?.toISOString()).toBe(ago(10));
  });
});
