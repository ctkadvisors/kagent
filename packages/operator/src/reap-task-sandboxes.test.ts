/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { reapTaskSandboxes } from './main.js';
import type { AgentTask } from './crds/index.js';

const now = Date.parse('2026-09-28T01:00:00Z');
const task = (phase: string, completedAt?: string) =>
  ({
    metadata: { name: 't', namespace: 'kagent-system', uid: 'uid-1' },
    spec: { targetAgent: 'a', payload: {} },
    status: { phase, ...(completedAt !== undefined && { completedAt }) },
  }) as unknown as AgentTask;

function batch() {
  const calls: { list: string[]; deleted: string[] } = { list: [], deleted: [] };
  const batchApi = {
    listJobForAllNamespaces: ({ labelSelector }: { labelSelector: string }) => {
      calls.list.push(labelSelector);
      return Promise.resolve({
        items: [{ metadata: { name: 'kagent-sbx-uid-1-abc', namespace: 'kagent-system' } }],
      });
    },
    deleteNamespacedJob: ({ name }: { name: string }) => {
      calls.deleted.push(name);
      return Promise.resolve({});
    },
  };
  return { calls, deps: { batchApi } as never };
}

describe('reapTaskSandboxes', () => {
  it("removes a task's sandbox Jobs when it has just finished", async () => {
    const b = batch();
    expect(await reapTaskSandboxes(task('Completed', '2026-09-28T00:50:00Z'), b.deps, now)).toBe(1);
    expect(b.calls.list).toEqual(['kagent.knuteson.io/sandbox-task=uid-1']);
    expect(b.calls.deleted).toEqual(['kagent-sbx-uid-1-abc']);
  });

  it('leaves running tasks and long-finished tasks alone, with no API call', async () => {
    const b = batch();
    expect(await reapTaskSandboxes(task('Running'), b.deps, now)).toBe(0);
    expect(await reapTaskSandboxes(task('Failed', '2026-09-27T20:00:00Z'), b.deps, now)).toBe(0);
    expect(b.calls.list).toEqual([]);
  });
});
