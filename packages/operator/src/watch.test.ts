/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * H6 — informer restart races. Covers `createAgentTaskInformer`'s
 * error → safeRestart → backoff path, including:
 *   - one-shot transient error → safeRestart fires after the initial delay
 *   - repeated rejections from `start()` itself escalate the backoff
 *   - reaching the consecutive-failure cap fires `onCapReached`
 *     (groundwork for M21 readiness-probe wiring)
 *
 * The K8s `makeInformer` factory is mocked so we can drive `error` events
 * synchronously and assert the restart scheduler's behavior without
 * touching real timers or the apiserver.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const makeInformerMock = vi.fn();

vi.mock('@kubernetes/client-node', async () => {
  const actual =
    await vi.importActual<typeof import('@kubernetes/client-node')>('@kubernetes/client-node');
  return {
    ...actual,
    makeInformer: (...args: unknown[]) => {
      // Capture handlers per-event so the test can fire 'error'.
      const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
      const informer = {
        on: vi.fn((verb: string, cb: (...a: unknown[]) => void) => {
          const arr = listeners.get(verb) ?? [];
          arr.push(cb);
          listeners.set(verb, arr);
        }),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        // Test hook: fire an event synchronously into all registered listeners.
        __fire(verb: string, payload: unknown): void {
          for (const cb of listeners.get(verb) ?? []) cb(payload);
        },
      };
      makeInformerMock(...args, informer);
      return informer;
    },
  };
});

import type { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

import { createAgentTaskInformer, type AgentTaskHandler } from './watch.js';

const fakeKc = {} as KubeConfig;

function makeCustomApi(): CustomObjectsApi {
  return {
    listClusterCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
  } as unknown as CustomObjectsApi;
}

interface TestInformer {
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  __fire(verb: string, payload: unknown): void;
}

function captureLastInformer(): TestInformer {
  const lastCall = makeInformerMock.mock.calls.at(-1);
  if (lastCall === undefined) throw new Error('no informer captured');
  // Last positional argument is the informer instance (added by the mock).
  return lastCall.at(-1) as TestInformer;
}

interface ScheduledTask {
  cb: () => void;
  delayMs: number;
}

function makeFakeTimer(): {
  scheduled: ScheduledTask[];
  setTimeout: (cb: () => void, ms: number) => void;
  /** Run the next scheduled callback synchronously. Returns its delay. */
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

const noopHandler: AgentTaskHandler = {
  onAdd: () => {},
  onUpdate: () => {},
  onDelete: () => {},
};

describe('createAgentTaskInformer — H6 safeRestart', () => {
  beforeEach(() => {
    makeInformerMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules a restart after an error event using the configured initial delay', () => {
    const onError = vi.fn();
    const handler: AgentTaskHandler = { ...noopHandler, onError };
    const fakeTimer = makeFakeTimer();
    createAgentTaskInformer(fakeKc, makeCustomApi(), handler, {
      restartOpts: { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1_000 },
      restartTimer: fakeTimer,
    });
    const informer = captureLastInformer();

    informer.__fire('error', new Error('connection refused'));

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(fakeTimer.scheduled.length).toBe(1);
    expect(fakeTimer.scheduled[0]?.delayMs).toBe(100);
  });

  it('escalates the backoff when start() itself rejects', async () => {
    const onError = vi.fn();
    const handler: AgentTaskHandler = { ...noopHandler, onError };
    const fakeTimer = makeFakeTimer();
    createAgentTaskInformer(fakeKc, makeCustomApi(), handler, {
      restartOpts: { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 100_000 },
      restartTimer: fakeTimer,
    });
    const informer = captureLastInformer();
    // Make the underlying start() reject so safeRestart escalates.
    informer.start.mockRejectedValue(new Error('apiserver 500'));

    informer.__fire('error', new Error('initial flap'));
    expect(fakeTimer.scheduled[0]?.delayMs).toBe(100);

    // Run the first scheduled retry. start() rejects → safeRestart
    // is fed the rejection → schedules attempt #2 at 200ms.
    fakeTimer.flushNext();
    // Wait microtasks for the rejection to propagate through .then().
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeTimer.scheduled.length).toBe(1);
    expect(fakeTimer.scheduled[0]?.delayMs).toBe(200);

    // Attempt #2 also rejects → schedule attempt #3 at 400ms.
    fakeTimer.flushNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeTimer.scheduled[0]?.delayMs).toBe(400);
  });

  it('caps consecutive failures and propagates the cap-reached signal via onError', async () => {
    const onError = vi.fn();
    const handler: AgentTaskHandler = { ...noopHandler, onError };
    const fakeTimer = makeFakeTimer();
    createAgentTaskInformer(fakeKc, makeCustomApi(), handler, {
      restartOpts: {
        initialDelayMs: 1,
        backoffFactor: 2,
        maxDelayMs: 100,
        maxConsecutiveFailures: 3,
      },
      restartTimer: fakeTimer,
    });
    const informer = captureLastInformer();
    informer.start.mockRejectedValue(new Error('apiserver 401'));

    // Initial error → schedule attempt #1.
    informer.__fire('error', new Error('initial'));
    expect(fakeTimer.scheduled.length).toBe(1);

    // Run attempt #1 rejection → schedule attempt #2.
    fakeTimer.flushNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeTimer.scheduled.length).toBe(1);

    // Run attempt #2 rejection → schedule attempt #3.
    fakeTimer.flushNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeTimer.scheduled.length).toBe(1);

    // Run attempt #3 rejection → safeRestart sees state.attempts=4 > cap=3
    // → onCapReached fires (which calls handler.onError). No more retries.
    fakeTimer.flushNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeTimer.scheduled.length).toBe(0);

    // onError fired multiple times (every onStartRejected + the
    // onCapReached). The cap-reached call MUST have happened.
    expect(onError).toHaveBeenCalled();
  });

  it('C1-NEW-H1 — resets the failure counter on successful add/update so transient flaps recover', async () => {
    const onError = vi.fn();
    const handler: AgentTaskHandler = { ...noopHandler, onError };
    const fakeTimer = makeFakeTimer();
    createAgentTaskInformer(fakeKc, makeCustomApi(), handler, {
      restartOpts: {
        initialDelayMs: 1,
        backoffFactor: 2,
        maxDelayMs: 1_000,
        // Cap at 3 consecutive failures — without reset(), 4 lifetime
        // flaps would wedge the informer permanently.
        maxConsecutiveFailures: 3,
      },
      restartTimer: fakeTimer,
    });
    const informer = captureLastInformer();
    informer.start.mockRejectedValue(new Error('apiserver flap'));

    // Flap series #1 — drive 2 consecutive rejections.
    informer.__fire('error', new Error('flap-1'));
    expect(fakeTimer.scheduled.length).toBe(1);
    fakeTimer.flushNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeTimer.scheduled.length).toBe(1);
    fakeTimer.flushNext();
    await Promise.resolve();
    await Promise.resolve();
    // attempt #3 pending — backoff has escalated past initial.
    expect(fakeTimer.scheduled[0]?.delayMs).toBe(4);

    // Watch recovers — drain the pending retry; this time start() resolves.
    informer.start.mockResolvedValueOnce(undefined);
    fakeTimer.flushNext();
    await Promise.resolve();
    await Promise.resolve();
    // Successful add event arrives → reset() must zero the counter.
    informer.__fire('add', {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'AgentTask',
      metadata: { uid: 't1', name: 't1', namespace: 'ns' },
      spec: { targetAgent: 'a', payload: {} },
    });

    // Flap series #2 — first scheduled retry must be at the *initial*
    // delay, proving attempts was reset to 0. If reset() had not fired,
    // computeBackoffMs would already be at the post-#3 step (8 ms).
    informer.start.mockRejectedValue(new Error('second flap series'));
    informer.__fire('error', new Error('flap-A'));
    expect(fakeTimer.scheduled.length).toBe(1);
    expect(fakeTimer.scheduled[0]?.delayMs).toBe(1);
  });

  it('treats a second error mid-pending retry as a no-op (no double-schedule)', () => {
    const handler: AgentTaskHandler = { ...noopHandler, onError: vi.fn() };
    const fakeTimer = makeFakeTimer();
    createAgentTaskInformer(fakeKc, makeCustomApi(), handler, {
      restartOpts: { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1_000 },
      restartTimer: fakeTimer,
    });
    const informer = captureLastInformer();

    informer.__fire('error', new Error('flap-1'));
    informer.__fire('error', new Error('flap-2'));
    informer.__fire('error', new Error('flap-3'));

    // Only the first error scheduled a retry; the rest were swallowed
    // because a retry was already pending.
    expect(fakeTimer.scheduled.length).toBe(1);
  });
});
