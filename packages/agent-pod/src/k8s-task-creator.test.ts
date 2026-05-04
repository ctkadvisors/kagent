/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Unit tests for the agent-pod K8sTaskCreator manifest builder. Covers:
 *
 *   - Parent → child ownerReferences propagation (cascading delete via
 *     `kubectl delete agenttask <root>`).
 *   - v0.1.9 task-depth label propagation: child gets
 *     `kagent.knuteson.io/task-depth=<parent.depth + 1>`.
 *
 * Uses a stub CustomObjectsApi so the manifest the creator submits to
 * the apiserver is observable without a live K8s client.
 */

import type { CustomObjectsApi } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

import {
  buildK8sTaskCreator,
  PARENT_TASK_UID_LABEL,
  TASK_DEPTH_LABEL,
  type ParentIdentity,
} from './k8s-task-creator.js';

interface RecordedCreate {
  readonly group: string;
  readonly version: string;
  readonly namespace: string;
  readonly plural: string;
  readonly body: Record<string, unknown>;
}

/**
 * Build a fake CustomObjectsApi that records every create request and
 * echoes back a synthetic resource (uid = `uid-<name>`). We only need
 * `createNamespacedCustomObject` for these tests.
 */
function fakeApi(): {
  api: {
    createNamespacedCustomObject(args: {
      group: string;
      version: string;
      namespace: string;
      plural: string;
      body: Record<string, unknown>;
    }): Promise<unknown>;
  };
  creates: RecordedCreate[];
} {
  const creates: RecordedCreate[] = [];
  const api = {
    createNamespacedCustomObject(args: {
      group: string;
      version: string;
      namespace: string;
      plural: string;
      body: Record<string, unknown>;
    }): Promise<unknown> {
      creates.push(args);
      const meta = (args.body.metadata as { name?: string; namespace?: string }) ?? {};
      return Promise.resolve({
        metadata: {
          name: meta.name,
          namespace: meta.namespace,
          uid: `uid-${meta.name ?? 'unknown'}`,
        },
      });
    },
  };
  return { api, creates };
}

const PARENT_ROOT: ParentIdentity = {
  uid: 'parent-uid-root',
  name: 'parent-task',
  namespace: 'kagent-system',
};

describe('K8sTaskCreator.createChildTask (manifest shape)', () => {
  it('attaches the parent-task-uid label and ownerReferences to the parent AgentTask', async () => {
    const { api, creates } = fakeApi();
    const creator = buildK8sTaskCreator(api as unknown as CustomObjectsApi);
    await creator.createChildTask(PARENT_ROOT, {
      name: 'child-1',
      targetAgent: 'summarizer',
      originalUserMessage: 'do the thing',
    });
    expect(creates).toHaveLength(1);
    const body = creates[0]!.body;
    const meta = body.metadata as Record<string, unknown>;
    const labels = meta.labels as Record<string, string>;
    expect(labels[PARENT_TASK_UID_LABEL]).toBe(PARENT_ROOT.uid);
    const ownerRefs = meta.ownerReferences as Array<Record<string, unknown>>;
    expect(ownerRefs).toHaveLength(1);
    const ref = ownerRefs[0]!;
    expect(ref.apiVersion).toBe('kagent.knuteson.io/v1alpha1');
    expect(ref.kind).toBe('AgentTask');
    expect(ref.name).toBe(PARENT_ROOT.name);
    expect(ref.uid).toBe(PARENT_ROOT.uid);
    // Parent AgentTask is NOT the controller (Job owns that slot for the
    // spawned Pod). blockOwnerDeletion=true so etcd GC waits for the
    // child to acknowledge before removing the parent — propagated cascade.
    expect(ref.controller).toBe(false);
    expect(ref.blockOwnerDeletion).toBe(true);
  });

  // v0.1.9 — task-depth threading. Operator stamps `KAGENT_TASK_DEPTH`
  // on each spawned Job from the AgentTask label
  // `kagent.knuteson.io/task-depth`. The agent-pod's K8sTaskCreator is
  // the writer that sets THAT label on every child it creates, sourcing
  // its own depth from PodConfig (so the chain stays consistent through
  // operator → agent-pod → k8sTaskCreator → next operator-build).
  it('stamps kagent.knuteson.io/task-depth=<parent.depth + 1> on the child', async () => {
    const { api, creates } = fakeApi();
    const creator = buildK8sTaskCreator(api as unknown as CustomObjectsApi);
    const parentAtDepth2: ParentIdentity = { ...PARENT_ROOT, depth: 2 };
    await creator.createChildTask(parentAtDepth2, {
      name: 'child-d3',
      targetAgent: 'summarizer',
      originalUserMessage: 'go deeper',
    });
    const body = creates[0]!.body;
    const meta = body.metadata as Record<string, unknown>;
    const labels = meta.labels as Record<string, string>;
    expect(labels[TASK_DEPTH_LABEL]).toBe('3');
  });

  it('defaults child task-depth label to 1 when parent depth is unset (root)', async () => {
    const { api, creates } = fakeApi();
    const creator = buildK8sTaskCreator(api as unknown as CustomObjectsApi);
    // PARENT_ROOT lacks `depth` — treated as root (depth=0); child = 1.
    await creator.createChildTask(PARENT_ROOT, {
      name: 'child-d1',
      targetAgent: 'summarizer',
      originalUserMessage: 'first hop',
    });
    const body = creates[0]!.body;
    const meta = body.metadata as Record<string, unknown>;
    const labels = meta.labels as Record<string, string>;
    expect(labels[TASK_DEPTH_LABEL]).toBe('1');
  });

  it('preserves managed-by + parent-task-uid labels alongside task-depth', async () => {
    const { api, creates } = fakeApi();
    const creator = buildK8sTaskCreator(api as unknown as CustomObjectsApi);
    await creator.createChildTask(
      { ...PARENT_ROOT, depth: 1 },
      {
        name: 'child-mixed',
        targetAgent: 'summarizer',
        originalUserMessage: 'mixed',
      },
    );
    const body = creates[0]!.body;
    const meta = body.metadata as Record<string, unknown>;
    const labels = meta.labels as Record<string, string>;
    expect(labels['kagent.knuteson.io/managed-by']).toBe('kagent-operator');
    expect(labels[PARENT_TASK_UID_LABEL]).toBe(PARENT_ROOT.uid);
    expect(labels[TASK_DEPTH_LABEL]).toBe('2');
  });
});
