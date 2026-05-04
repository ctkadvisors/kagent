/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion --
   `Partial<AgentTask>` overrides need a final `as AgentTask` cast so
   the test fixture compiles against the strict CRD shape; the
   linter's "unnecessary assertion" check fires after structural type
   resolution but the cast is what made the structural type compatible
   in the first place. */

import { describe, expect, it } from 'vitest';

import {
  bucketTtlMsFromTask,
  decideBlackboardAction,
  isRootTask,
  isTerminalPhase,
  rootUidForTask,
} from './blackboard-router.js';
import type { AgentTask } from './crds/index.js';

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'AgentTask',
    metadata: { name: 't', namespace: 'default', uid: 'uid-root', ...overrides.metadata },
    spec: { payload: {}, ...overrides.spec },
    ...(overrides.status !== undefined && { status: overrides.status }),
  } as AgentTask;
}

describe('isRootTask', () => {
  it('returns true for a task with no parent label or spec.parentTask', () => {
    expect(isRootTask(makeTask())).toBe(true);
  });

  it('returns false when spec.parentTask is set', () => {
    expect(
      isRootTask(
        makeTask({ spec: { payload: {}, parentTask: 'uid-parent' } } as Partial<AgentTask>),
      ),
    ).toBe(false);
  });

  it('returns false when parent label + name are set', () => {
    expect(
      isRootTask(
        makeTask({
          metadata: {
            name: 't',
            namespace: 'default',
            uid: 'uid',
            labels: {
              'kagent.knuteson.io/parent-task-uid': 'uid-parent',
              'kagent.knuteson.io/parent-task-name': 'p',
            },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('rootUidForTask', () => {
  it('returns own UID for a root task', () => {
    expect(rootUidForTask(makeTask())).toBe('uid-root');
  });

  it('returns null for a child task', () => {
    expect(
      rootUidForTask(makeTask({ spec: { payload: {}, parentTask: 'p' } } as Partial<AgentTask>)),
    ).toBeNull();
  });

  it('returns null when uid is missing', () => {
    // Bypass makeTask spread (which would re-inject uid: 'uid-root')
    // by constructing the AgentTask directly without a uid.
    const t: AgentTask = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'AgentTask',
      metadata: { name: 't', namespace: 'default' },
      spec: { payload: {} },
    } as AgentTask;
    expect(rootUidForTask(t)).toBeNull();
  });
});

describe('bucketTtlMsFromTask', () => {
  it('returns runConfig.timeoutSeconds * 1000 when set', () => {
    const t = makeTask({
      spec: { payload: {}, runConfig: { timeoutSeconds: 60 } } as Partial<AgentTask>,
    });
    expect(bucketTtlMsFromTask(t)).toBe(60_000);
  });

  it('falls back to deprecated top-level timeoutSeconds', () => {
    const t = makeTask({
      spec: { payload: {}, timeoutSeconds: 30 } as Partial<AgentTask>,
    });
    expect(bucketTtlMsFromTask(t)).toBe(30_000);
  });

  it('returns undefined when neither is set', () => {
    expect(bucketTtlMsFromTask(makeTask())).toBeUndefined();
  });

  it('returns undefined for non-positive values', () => {
    expect(
      bucketTtlMsFromTask(
        makeTask({ spec: { payload: {}, runConfig: { timeoutSeconds: 0 } } as Partial<AgentTask> }),
      ),
    ).toBeUndefined();
  });
});

describe('isTerminalPhase', () => {
  it('classifies terminal vs non-terminal correctly', () => {
    expect(isTerminalPhase('Completed')).toBe(true);
    expect(isTerminalPhase('Failed')).toBe(true);
    expect(isTerminalPhase('Cancelled')).toBe(true);
    expect(isTerminalPhase('Pending')).toBe(false);
    expect(isTerminalPhase('Running')).toBe(false);
    expect(isTerminalPhase(undefined)).toBe(false);
  });
});

describe('decideBlackboardAction', () => {
  it('returns ensure for a non-terminal root task', () => {
    const d = decideBlackboardAction(makeTask());
    expect(d.kind).toBe('ensure');
    if (d.kind === 'ensure') expect(d.rootUid).toBe('uid-root');
  });

  it('returns destroy for a terminal root task', () => {
    const d = decideBlackboardAction(
      makeTask({ status: { phase: 'Completed' } } as Partial<AgentTask>),
    );
    expect(d.kind).toBe('destroy');
  });

  it('returns noop for a child task', () => {
    const d = decideBlackboardAction(
      makeTask({ spec: { payload: {}, parentTask: 'p' } } as Partial<AgentTask>),
    );
    expect(d.kind).toBe('noop');
  });
});
