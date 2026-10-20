/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION, type AgentTask } from './crds/index.js';
import { runOnce, shouldDeleteTask } from './task-gc.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T00:00:00Z');

function task(
  name: string,
  phase: 'Pending' | 'Dispatched' | 'Completed' | 'Failed',
  completedDaysAgo: number | undefined,
  extra: { annotations?: Record<string, string>; owned?: boolean } = {},
): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name,
      namespace: 'kagent-system',
      creationTimestamp: new Date(NOW - 30 * DAY),
      ...(extra.annotations !== undefined && { annotations: extra.annotations }),
      ...(extra.owned === true && {
        ownerReferences: [
          { apiVersion: API_GROUP_VERSION, kind: 'AgentTask', name: 'parent', uid: 'u' },
        ],
      }),
    },
    spec: {} as AgentTask['spec'],
    status: {
      phase,
      ...(completedDaysAgo !== undefined && {
        completedAt: new Date(NOW - completedDaysAgo * DAY).toISOString(),
      }),
    },
  };
}

describe('task-gc', () => {
  it('deletes only finished tasks older than the window, keeping pending reviews and children', () => {
    const week = 7 * DAY;
    expect(shouldDeleteTask(task('old-done', 'Completed', 8), NOW, week)).toBe(true);
    expect(shouldDeleteTask(task('old-failed', 'Failed', 8), NOW, week)).toBe(true);
    expect(shouldDeleteTask(task('fresh', 'Completed', 2), NOW, week)).toBe(false);
    expect(shouldDeleteTask(task('running', 'Dispatched', undefined), NOW, week)).toBe(false);
    const candidate = { 'kagent.knuteson.io/template-candidate': 'true' };
    expect(
      shouldDeleteTask(
        task('awaiting-review', 'Completed', 30, { annotations: candidate }),
        NOW,
        week,
      ),
    ).toBe(false);
    expect(
      shouldDeleteTask(
        task('reviewed', 'Completed', 30, {
          annotations: { ...candidate, 'kagent.knuteson.io/review-decision': 'accepted' },
        }),
        NOW,
        week,
      ),
    ).toBe(true);
    expect(shouldDeleteTask(task('child', 'Completed', 30, { owned: true }), NOW, week)).toBe(
      false,
    );
    // Failed before it ran: no completedAt, so creation (30 days ago) is the floor.
    expect(shouldDeleteTask(task('never-ran', 'Failed', undefined), NOW, week)).toBe(true);
    // Applied from a manifest: its owner re-applies it, and deleting it re-runs it.
    for (const key of [
      'argocd.argoproj.io/tracking-id',
      'kubectl.kubernetes.io/last-applied-configuration',
    ]) {
      expect(
        shouldDeleteTask(
          task('gitops', 'Completed', 30, { annotations: { [key]: 'x' } }),
          NOW,
          week,
        ),
      ).toBe(false);
    }
  });

  it('keeps undecided flagged tasks unless a separate flagged window has passed', () => {
    const week = 7 * DAY;
    const suspicious = {
      ...task('suspicious', 'Completed', 20),
      status: {
        phase: 'Completed' as const,
        completedAt: new Date(NOW - 20 * DAY).toISOString(),
        structuralVerdict: { suspicious: ['loop_detected'] },
      },
    } as AgentTask;
    const requested = task('requested', 'Failed', 20, {
      annotations: { 'kagent.knuteson.io/review-requested': 'true' },
    });
    expect(shouldDeleteTask(suspicious, NOW, week)).toBe(false);
    expect(shouldDeleteTask(requested, NOW, week)).toBe(false);
    expect(shouldDeleteTask(suspicious, NOW, week, 30 * DAY)).toBe(false);
    expect(shouldDeleteTask(suspicious, NOW, week, 14 * DAY)).toBe(true);
    const decided = task('decided', 'Failed', 20, {
      annotations: {
        'kagent.knuteson.io/review-requested': 'true',
        'kagent.knuteson.io/review-decision': 'rejected',
      },
    });
    expect(shouldDeleteTask(decided, NOW, week)).toBe(true);
  });

  it('deletes the eligible tasks, survives a failed delete, and dry-run deletes nothing', async () => {
    const tasks = [task('a', 'Completed', 9), task('b', 'Failed', 9), task('c', 'Completed', 1)];
    const deleted: string[] = [];
    const deps = {
      listAgentTasks: () => tasks,
      deleteAgentTask: (_ns: string, name: string): Promise<void> => {
        if (name === 'b') return Promise.reject(new Error('404'));
        deleted.push(name);
        return Promise.resolve();
      },
      now: () => NOW,
      log: () => undefined,
    };
    expect(await runOnce({ retentionMs: 7 * DAY, intervalMs: 60_000 }, deps)).toEqual({
      scanned: 3,
      eligible: 2,
      deleted: 1,
    });
    expect(deleted).toEqual(['a']);
    deleted.length = 0;
    const dry = await runOnce({ retentionMs: 7 * DAY, intervalMs: 60_000, dryRun: true }, deps);
    expect(dry.deleted).toBe(0);
    expect(deleted).toEqual([]);
  });
});
