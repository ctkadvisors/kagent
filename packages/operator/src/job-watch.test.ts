/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * H6 — Job + Pod informer restart races. Covers `createJobPodInformer`'s
 * error → safeRestart → backoff path for BOTH informers, with explicit
 * assertion that:
 *   - Job and Pod restart counters are independent (one flapping does
 *     not poison the other's backoff)
 *   - cap-reached fires per-informer
 *   - parentTaskRef preserves prior behavior (no-regression)
 *
 * The K8s `makeInformer` factory is mocked so we can drive `error`
 * events synchronously and assert the restart scheduler's behavior
 * without touching real timers or the apiserver.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const makeInformerMock = vi.fn();

vi.mock('@kubernetes/client-node', async () => {
  const actual =
    await vi.importActual<typeof import('@kubernetes/client-node')>('@kubernetes/client-node');
  return {
    ...actual,
    makeInformer: (...args: unknown[]) => {
      const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
      const informer = {
        on: vi.fn((verb: string, cb: (...a: unknown[]) => void) => {
          const arr = listeners.get(verb) ?? [];
          arr.push(cb);
          listeners.set(verb, arr);
        }),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        __fire(verb: string, payload: unknown): void {
          for (const cb of listeners.get(verb) ?? []) cb(payload);
        },
      };
      makeInformerMock(...args, informer);
      return informer;
    },
  };
});

import type { CoreV1Api, KubeConfig } from '@kubernetes/client-node';

import {
  createJobPodInformer,
  parentTaskRef,
  TASK_LABEL_KEY,
  type JobPodHandler,
} from './job-watch.js';

const fakeKc = {} as KubeConfig;

function makeCoreApi(): CoreV1Api {
  return {
    listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
    listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: [] }),
  } as unknown as CoreV1Api;
}

const batchListFn = vi.fn().mockResolvedValue({ items: [] });

interface TestInformer {
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  __fire(verb: string, payload: unknown): void;
}

interface ScheduledTask {
  cb: () => void;
  delayMs: number;
}

function makeFakeTimer(): {
  scheduled: ScheduledTask[];
  setTimeout: (cb: () => void, ms: number) => void;
  flushNext(): number;
} {
  const scheduled: ScheduledTask[] = [];
  return {
    scheduled,
    setTimeout(cb, delayMs): void {
      scheduled.push({ cb, delayMs });
    },
    flushNext(): number {
      const next = scheduled.shift();
      if (next === undefined) throw new Error('no scheduled tasks');
      next.cb();
      return next.delayMs;
    },
  };
}

const noopHandler: JobPodHandler = {
  onJob: () => {},
  onPod: () => {},
};

describe('createJobPodInformer — H6 safeRestart (per-informer)', () => {
  beforeEach(() => {
    makeInformerMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Job error schedules a retry; Pod backoff state is unaffected', async () => {
    const onError = vi.fn();
    const handler: JobPodHandler = { ...noopHandler, onError };
    const fakeTimer = makeFakeTimer();
    createJobPodInformer(fakeKc, makeCoreApi(), batchListFn, handler, {
      restartOpts: { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1_000 },
      restartTimer: fakeTimer,
    });
    // makeInformer was called twice (Job, then Pod).
    expect(makeInformerMock).toHaveBeenCalledTimes(2);
    const jobInformer = makeInformerMock.mock.calls[0]?.at(-1) as TestInformer;
    const podInformer = makeInformerMock.mock.calls[1]?.at(-1) as TestInformer;

    // Job flap: schedules a retry.
    jobInformer.__fire('error', new Error('job watch flap'));
    expect(fakeTimer.scheduled.length).toBe(1);
    expect(fakeTimer.scheduled[0]?.delayMs).toBe(100);

    // Pod has not flapped → no extra schedule.
    expect(fakeTimer.scheduled.length).toBe(1);

    // Pod flap: schedules its OWN retry (also at the initial delay
    // because the Pod restarter has independent state).
    podInformer.__fire('error', new Error('pod watch flap'));
    expect(fakeTimer.scheduled.length).toBe(2);
    expect(fakeTimer.scheduled[1]?.delayMs).toBe(100);

    // Drain the Pod retry; Pod's start() resolves OK → no further pod schedule.
    podInformer.start.mockResolvedValueOnce(undefined);
    fakeTimer.flushNext(); // job retry — start() resolves
    await Promise.resolve();
    fakeTimer.flushNext(); // pod retry — start() resolves
    await Promise.resolve();
    expect(fakeTimer.scheduled.length).toBe(0);
  });

  it('Job restart cap fires onCapReached without affecting Pod', async () => {
    const onError = vi.fn();
    const handler: JobPodHandler = { ...noopHandler, onError };
    const fakeTimer = makeFakeTimer();
    createJobPodInformer(fakeKc, makeCoreApi(), batchListFn, handler, {
      restartOpts: {
        initialDelayMs: 1,
        backoffFactor: 2,
        maxDelayMs: 100,
        maxConsecutiveFailures: 2,
      },
      restartTimer: fakeTimer,
    });
    const jobInformer = makeInformerMock.mock.calls[0]?.at(-1) as TestInformer;
    const podInformer = makeInformerMock.mock.calls[1]?.at(-1) as TestInformer;
    jobInformer.start.mockRejectedValue(new Error('apiserver 401'));

    jobInformer.__fire('error', new Error('initial'));
    expect(fakeTimer.scheduled.length).toBe(1);
    fakeTimer.flushNext(); // attempt #1 → start() rejects → schedule #2
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeTimer.scheduled.length).toBe(1);
    fakeTimer.flushNext(); // attempt #2 → start() rejects → cap reached
    await Promise.resolve();
    await Promise.resolve();

    // No more Job retries scheduled.
    expect(fakeTimer.scheduled.length).toBe(0);

    // Pod independence: a Pod error after the Job has hit the cap still
    // gets its own first-attempt schedule (Pod restarter's state was
    // never touched).
    podInformer.__fire('error', new Error('pod flap'));
    expect(fakeTimer.scheduled.length).toBe(1);
    expect(fakeTimer.scheduled[0]?.delayMs).toBe(1);
  });

  it('a second error mid-pending Job retry is a no-op (no double-schedule)', () => {
    const handler: JobPodHandler = { ...noopHandler, onError: vi.fn() };
    const fakeTimer = makeFakeTimer();
    createJobPodInformer(fakeKc, makeCoreApi(), batchListFn, handler, {
      restartOpts: { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1_000 },
      restartTimer: fakeTimer,
    });
    const jobInformer = makeInformerMock.mock.calls[0]?.at(-1) as TestInformer;

    jobInformer.__fire('error', new Error('a'));
    jobInformer.__fire('error', new Error('b'));
    jobInformer.__fire('error', new Error('c'));

    expect(fakeTimer.scheduled.length).toBe(1);
  });
});

describe('parentTaskRef — no-regression', () => {
  it('returns null when label is missing', () => {
    expect(parentTaskRef({ metadata: { labels: {}, namespace: 'ns' } })).toBe(null);
  });

  it('returns null when namespace is missing', () => {
    expect(parentTaskRef({ metadata: { labels: { [TASK_LABEL_KEY]: 't1' } } })).toBe(null);
  });

  it('returns the labeled ref when both label and namespace are present', () => {
    const ref = parentTaskRef({
      metadata: { labels: { [TASK_LABEL_KEY]: 't1' }, namespace: 'ns' },
    });
    expect(ref).toEqual({ namespace: 'ns', name: 't1' });
  });
});
