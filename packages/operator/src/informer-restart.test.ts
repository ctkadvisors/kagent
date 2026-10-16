/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * 2026-10-16 network outage: the AgentTask watch hit its consecutive-failure
 * cap and the operator stayed Running and Ready while dispatching nothing for
 * 33 minutes. At the cap the restarter now escalates to `timer.exit(1)` so
 * Kubernetes restarts the operator with fresh watches.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Informer, KubernetesObject } from '@kubernetes/client-node';

import {
  PROCESS_TIMER,
  createRestarter,
  superviseInformer,
  type RestartTimer,
} from './informer-restart.js';

function fakeTimer() {
  const pending: (() => void)[] = [];
  const exit = vi.fn();
  const timer: RestartTimer = { setTimeout: (cb) => void pending.push(cb), exit };
  const flush = async (): Promise<void> => {
    while (pending.length > 0) {
      pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { timer, exit, flush };
}

describe('informer restart cap', () => {
  it('exits once the consecutive-failure cap is reached, and only then', async () => {
    const { timer, exit, flush } = fakeTimer();
    const informer = {
      start: vi.fn(() => Promise.reject(new Error('connect ETIMEDOUT 10.43.0.1:443'))),
    };
    const restarter = createRestarter(
      informer,
      { onStartRejected: () => undefined, onCapReached: () => undefined },
      { maxConsecutiveFailures: 3 },
      timer,
    );
    restarter.safeRestart(new Error('watch error'));
    await flush();
    expect(informer.start).toHaveBeenCalledTimes(3);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(restarter.state.capReached).toBe(true);
  });

  it('production timers exit; a recovered watch never does', async () => {
    expect(typeof PROCESS_TIMER.exit).toBe('function');
    const { timer, exit, flush } = fakeTimer();
    const handlers = new Map<string, (arg: unknown) => void>();
    let failures = 2;
    const informer = {
      on: (verb: string, cb: (arg: unknown) => void) => void handlers.set(verb, cb),
      start: vi.fn(() => (failures-- > 0 ? Promise.reject(new Error('down')) : Promise.resolve())),
    };
    superviseInformer('[test] watch', informer as unknown as Informer<KubernetesObject>, timer);
    handlers.get('error')?.(new Error('connect ETIMEDOUT'));
    await flush();
    expect(informer.start).toHaveBeenCalledTimes(3);
    handlers.get('add')?.({});
    handlers.get('error')?.(new Error('flap'));
    await flush();
    expect(exit).not.toHaveBeenCalled();
  });
});
