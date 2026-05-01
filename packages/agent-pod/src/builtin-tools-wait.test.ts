/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  buildWaitToolProvider,
  DEFAULT_WAIT_ALL_POLL_SECONDS,
  DEFAULT_WAIT_CHILD_POLL_SECONDS,
} from './builtin-tools-wait.js';
import type {
  ChildSnapshot,
  ChildTaskCreated,
  ChildTaskInput,
  K8sTaskCreator,
  LiveChildSummary,
  ParentIdentity,
} from './k8s-task-creator.js';

const PARENT: ParentIdentity = {
  uid: 'uid-parent-fixture',
  name: 'parent-task-001',
  namespace: 'kagent-system',
};

/**
 * Build a controllable fake K8sTaskCreator for the wait tools.
 *
 *   - `byUidSequence`: each `getTaskByUid` call shifts the next snapshot
 *     off the queue. `undefined` simulates "not found yet".
 *   - `allChildrenSequence`: each `listAllChildren` call returns the
 *     next array — same indexing semantics.
 */
function makeFakeK8s(opts: {
  readonly byUidSequence?: readonly (ChildSnapshot | undefined)[];
  readonly allChildrenSequence?: readonly (readonly ChildSnapshot[])[];
}): K8sTaskCreator & {
  readonly uidCalls: readonly { ns: string; uid: string }[];
  readonly listAllCalls: number;
} {
  const uidCalls: { ns: string; uid: string }[] = [];
  let uidCursor = 0;
  let listAllCursor = 0;
  const result: K8sTaskCreator & {
    readonly uidCalls: readonly { ns: string; uid: string }[];
    readonly listAllCalls: number;
  } = {
    uidCalls,
    get listAllCalls(): number {
      return listAllCursor;
    },
    createChildTask(_p: ParentIdentity, _input: ChildTaskInput): Promise<ChildTaskCreated> {
      throw new Error('createChildTask not used in wait tests');
    },
    listLiveChildren(_p: ParentIdentity): Promise<readonly LiveChildSummary[]> {
      return Promise.resolve([]);
    },
    listAllChildren(_p: ParentIdentity): Promise<readonly ChildSnapshot[]> {
      const next = opts.allChildrenSequence?.[listAllCursor] ?? [];
      listAllCursor++;
      return Promise.resolve(next);
    },
    getTaskByUid(ns: string, uid: string): Promise<ChildSnapshot | undefined> {
      uidCalls.push({ ns, uid });
      const next = opts.byUidSequence?.[uidCursor];
      uidCursor++;
      return Promise.resolve(next);
    },
  };
  return result;
}

/**
 * Build a controllable clock pair (sleep + now) for the wait tools.
 * Each `sleep(ms)` advances the virtual clock by `ms` and resolves
 * synchronously — the test runs in real time but the polling loop
 * sees a deterministic timeline.
 */
function makeClock(): { sleep: (ms: number) => Promise<void>; now: () => number } {
  let virtualNow = 0;
  return {
    sleep: (ms: number) => {
      virtualNow += ms;
      return Promise.resolve();
    },
    now: () => virtualNow,
  };
}

const ABORT_CTX = {
  abortSignal: new AbortController().signal,
  runId: 'test-run',
};

function resultText(result: { content: unknown }): string {
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    const block = result.content[0] as { type?: string; text?: string } | undefined;
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  throw new Error('unexpected ToolResult content shape');
}

async function callWaitChild(provider: ReturnType<typeof buildWaitToolProvider>, args: unknown) {
  return provider.executeTool({ id: '1', name: 'wait_for_child_task', args }, ABORT_CTX);
}

async function callWaitAll(provider: ReturnType<typeof buildWaitToolProvider>, args: unknown) {
  return provider.executeTool({ id: '2', name: 'wait_for_children_all', args }, ABORT_CTX);
}

describe('wait_for_child_task', () => {
  it('returns once the child reaches Completed and includes the result', async () => {
    const k8s = makeFakeK8s({
      byUidSequence: [
        { name: 'c1', namespace: PARENT.namespace, uid: 'uid-c1', phase: 'Pending' },
        { name: 'c1', namespace: PARENT.namespace, uid: 'uid-c1', phase: 'Dispatched' },
        {
          name: 'c1',
          namespace: PARENT.namespace,
          uid: 'uid-c1',
          phase: 'Completed',
          result: { content: 'done' },
        },
      ],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitChild(provider, {
      uid: 'uid-c1',
      timeoutSeconds: 60,
      pollIntervalSeconds: 1,
    });
    const parsed = JSON.parse(resultText(result)) as {
      phase: string;
      result?: { content?: string };
      timedOut: boolean;
    };
    expect(parsed.phase).toBe('Completed');
    expect(parsed.timedOut).toBe(false);
    expect(parsed.result?.content).toBe('done');
    expect(k8s.uidCalls.length).toBe(3);
  });

  it('returns once the child reaches Failed and includes the error', async () => {
    const k8s = makeFakeK8s({
      byUidSequence: [
        {
          name: 'c2',
          namespace: PARENT.namespace,
          uid: 'uid-c2',
          phase: 'Failed',
          error: 'deadline exceeded',
        },
      ],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitChild(provider, {
      uid: 'uid-c2',
      timeoutSeconds: 60,
      pollIntervalSeconds: 1,
    });
    const parsed = JSON.parse(resultText(result)) as { phase: string; error?: string };
    expect(parsed.phase).toBe('Failed');
    expect(parsed.error).toBe('deadline exceeded');
  });

  it('returns timedOut=true when the child never reaches terminal', async () => {
    const k8s = makeFakeK8s({
      byUidSequence: [
        { name: 'c3', namespace: PARENT.namespace, uid: 'uid-c3', phase: 'Pending' },
        { name: 'c3', namespace: PARENT.namespace, uid: 'uid-c3', phase: 'Dispatched' },
        { name: 'c3', namespace: PARENT.namespace, uid: 'uid-c3', phase: 'Dispatched' },
      ],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitChild(provider, {
      uid: 'uid-c3',
      timeoutSeconds: 2,
      pollIntervalSeconds: 1,
    });
    const parsed = JSON.parse(resultText(result)) as { phase: string | null; timedOut: boolean };
    expect(parsed.timedOut).toBe(true);
    expect(parsed.phase).toBe('Dispatched');
  });

  it('keeps polling when the uid is briefly invisible (informer race)', async () => {
    const k8s = makeFakeK8s({
      byUidSequence: [
        undefined, // not found yet
        undefined,
        {
          name: 'late',
          namespace: PARENT.namespace,
          uid: 'uid-late',
          phase: 'Completed',
          result: { content: 'arrived' },
        },
      ],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitChild(provider, {
      uid: 'uid-late',
      timeoutSeconds: 60,
      pollIntervalSeconds: 1,
    });
    const parsed = JSON.parse(resultText(result)) as { phase: string; timedOut: boolean };
    expect(parsed.phase).toBe('Completed');
    expect(parsed.timedOut).toBe(false);
    expect(k8s.uidCalls.length).toBe(3);
  });

  it('clamps timeoutSeconds to remaining parent budget', async () => {
    const k8s = makeFakeK8s({
      byUidSequence: [{ name: 'c5', namespace: PARENT.namespace, uid: 'uid-c5', phase: 'Pending' }],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({
      parent: PARENT,
      k8s,
      remainingBudgetSeconds: () => 1, // parent has 1s left
      ...clock,
    });
    // Caller asks for 600s; should get clamped to 1s and time out fast.
    const result = await callWaitChild(provider, {
      uid: 'uid-c5',
      timeoutSeconds: 600,
      pollIntervalSeconds: 1,
    });
    const parsed = JSON.parse(resultText(result)) as {
      timedOut: boolean;
      waitedSeconds: number;
    };
    expect(parsed.timedOut).toBe(true);
    expect(parsed.waitedSeconds).toBe(1);
  });

  it('rejects out-of-range pollIntervalSeconds', async () => {
    const k8s = makeFakeK8s({});
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitChild(provider, {
      uid: 'uid-x',
      pollIntervalSeconds: 999,
    });
    expect(result.isError).toBe(true);
  });

  it('uses default poll cadence when pollIntervalSeconds omitted', async () => {
    const k8s = makeFakeK8s({
      byUidSequence: [
        {
          name: 'c',
          namespace: PARENT.namespace,
          uid: 'uid-c',
          phase: 'Completed',
          result: { content: 'ok' },
        },
      ],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    await callWaitChild(provider, { uid: 'uid-c' });
    // 1 call before the terminal-phase return; clock advanced 0
    // because the loop returns before the first sleep.
    expect(clock.now()).toBeLessThanOrEqual(DEFAULT_WAIT_CHILD_POLL_SECONDS * 1000);
  });
});

describe('wait_for_children_all', () => {
  it('returns immediately with successCount=0 when there are no children', async () => {
    const k8s = makeFakeK8s({ allChildrenSequence: [[]] });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitAll(provider, {});
    const parsed = JSON.parse(resultText(result)) as {
      aggregatePhase: string;
      successCount: number;
      failureCount: number;
      children: unknown[];
      timedOut: boolean;
    };
    expect(parsed.aggregatePhase).toBe('AllComplete');
    expect(parsed.successCount).toBe(0);
    expect(parsed.failureCount).toBe(0);
    expect(parsed.children).toEqual([]);
    expect(parsed.timedOut).toBe(false);
  });

  it('returns AllComplete when all children Completed', async () => {
    const k8s = makeFakeK8s({
      allChildrenSequence: [
        [
          {
            name: 'c1',
            namespace: PARENT.namespace,
            uid: 'u1',
            phase: 'Completed',
            result: { content: 'a' },
          },
          {
            name: 'c2',
            namespace: PARENT.namespace,
            uid: 'u2',
            phase: 'Completed',
            result: { content: 'b' },
          },
        ],
      ],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitAll(provider, {});
    const parsed = JSON.parse(resultText(result)) as {
      aggregatePhase: string;
      successCount: number;
      failureCount: number;
    };
    expect(parsed.aggregatePhase).toBe('AllComplete');
    expect(parsed.successCount).toBe(2);
    expect(parsed.failureCount).toBe(0);
  });

  it('returns AnyFailed when any child Failed', async () => {
    const k8s = makeFakeK8s({
      allChildrenSequence: [
        [
          { name: 'c1', namespace: PARENT.namespace, uid: 'u1', phase: 'Completed' },
          { name: 'c2', namespace: PARENT.namespace, uid: 'u2', phase: 'Failed', error: 'boom' },
        ],
      ],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitAll(provider, {});
    const parsed = JSON.parse(resultText(result)) as {
      aggregatePhase: string;
      successCount: number;
      failureCount: number;
    };
    expect(parsed.aggregatePhase).toBe('AnyFailed');
    expect(parsed.successCount).toBe(1);
    expect(parsed.failureCount).toBe(1);
  });

  it('blocks until inFlight=0 across multiple polls', async () => {
    const k8s = makeFakeK8s({
      allChildrenSequence: [
        [
          { name: 'c1', namespace: PARENT.namespace, uid: 'u1', phase: 'Pending' },
          { name: 'c2', namespace: PARENT.namespace, uid: 'u2', phase: 'Dispatched' },
        ],
        [
          { name: 'c1', namespace: PARENT.namespace, uid: 'u1', phase: 'Completed' },
          { name: 'c2', namespace: PARENT.namespace, uid: 'u2', phase: 'Dispatched' },
        ],
        [
          { name: 'c1', namespace: PARENT.namespace, uid: 'u1', phase: 'Completed' },
          { name: 'c2', namespace: PARENT.namespace, uid: 'u2', phase: 'Completed' },
        ],
      ],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitAll(provider, {
      timeoutSeconds: 60,
      pollIntervalSeconds: 1,
    });
    const parsed = JSON.parse(resultText(result)) as {
      aggregatePhase: string;
      timedOut: boolean;
      successCount: number;
    };
    expect(parsed.aggregatePhase).toBe('AllComplete');
    expect(parsed.timedOut).toBe(false);
    expect(parsed.successCount).toBe(2);
    expect(k8s.listAllCalls).toBe(3);
  });

  it('returns PartiallyComplete with timedOut=true when mid-flight', async () => {
    // Same response repeated; the loop sees inFlight > 0 each poll
    // until the budget runs out.
    const stuck = [
      { name: 'c1', namespace: PARENT.namespace, uid: 'u1', phase: 'Completed' as const },
      { name: 'c2', namespace: PARENT.namespace, uid: 'u2', phase: 'Pending' as const },
    ];
    const k8s = makeFakeK8s({
      allChildrenSequence: [stuck, stuck, stuck, stuck, stuck],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    const result = await callWaitAll(provider, {
      timeoutSeconds: 3,
      pollIntervalSeconds: 1,
    });
    const parsed = JSON.parse(resultText(result)) as {
      aggregatePhase: string;
      timedOut: boolean;
      inFlightCount?: number;
    };
    expect(parsed.timedOut).toBe(true);
    expect(parsed.aggregatePhase).toBe('PartiallyComplete');
    expect(parsed.inFlightCount).toBe(1);
  });

  it('uses default poll cadence when pollIntervalSeconds omitted', async () => {
    const k8s = makeFakeK8s({
      allChildrenSequence: [
        [{ name: 'c', namespace: PARENT.namespace, uid: 'u', phase: 'Completed' }],
      ],
    });
    const clock = makeClock();
    const provider = buildWaitToolProvider({ parent: PARENT, k8s, ...clock });
    await callWaitAll(provider, {});
    // First poll returns terminal; clock should NOT have advanced past
    // one default poll interval.
    expect(clock.now()).toBeLessThanOrEqual(DEFAULT_WAIT_ALL_POLL_SECONDS * 1000);
  });
});
