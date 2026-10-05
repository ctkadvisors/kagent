/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { AimdController } from './aimd.js';
import type { InFlightCounter } from './inflight-counter.js';

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}
interface Queue {
  readonly model: string;
  readonly endpoint: string;
  readonly waiters: Waiter[];
}

/** One process owns all inference permits. Queued requests hold no GPU permit. */
export class RequestAdmission {
  private readonly queues = new Map<string, Queue>();
  constructor(
    private readonly inFlight: InFlightCounter,
    private readonly aimd: AimdController,
  ) {
    aimd.onCapacityChange((model, endpoint) => {
      const queue = this.queues.get(this.key(model, endpoint));
      if (queue) this.pump(queue);
    });
  }
  acquire(model: string, endpoint: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted)
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new RequestEndedError('request_cancelled'),
      );
    const key = this.key(model, endpoint);
    let queue = this.queues.get(key);
    if (!queue) {
      queue = { model, endpoint, waiters: [] };
      this.queues.set(key, queue);
    }
    const retained = queue;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const position = retained.waiters.indexOf(waiter);
          if (position < 0) return;
          retained.waiters.splice(position, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new RequestEndedError('request_cancelled'),
          );
          this.pump(retained);
        },
      };
      retained.waiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.pump(retained);
    });
  }
  queued(model: string, endpoint: string): number {
    return this.queues.get(this.key(model, endpoint))?.waiters.length ?? 0;
  }
  private pump(queue: Queue): void {
    const { model, endpoint, waiters } = queue;
    while (
      waiters.length &&
      this.inFlight.current(model, endpoint) < this.aimd.currentCap(model, endpoint)
    ) {
      const waiter = waiters.shift();
      if (!waiter) break;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(
          waiter.signal.reason instanceof Error
            ? waiter.signal.reason
            : new RequestEndedError('request_cancelled'),
        );
        continue;
      }
      this.inFlight.acquire(model, endpoint);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.inFlight.release(model, endpoint);
        this.pump(queue);
      });
    }
    if (!waiters.length && this.inFlight.current(model, endpoint) === 0) {
      this.queues.delete(this.key(model, endpoint));
    }
  }
  private key(model: string, endpoint: string): string {
    return JSON.stringify([model, endpoint]);
  }
}

export class RequestEndedError extends Error {
  constructor(readonly kind: 'request_cancelled' | 'request_timeout') {
    super(
      kind === 'request_timeout'
        ? 'inference request deadline exceeded'
        : 'inference caller disconnected',
    );
    this.name = 'RequestEndedError';
  }
}

export interface RequestLifetime {
  readonly signal: AbortSignal;
  wait<T>(operation: Promise<T>): Promise<T>;
  close(): void;
  throwIfEnded(): void;
}

/** Queue and execution share a single deadline; disconnect aborts both. */
export function requestLifetime(deadlineMs: number, caller?: AbortSignal): RequestLifetime {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new RequestEndedError('request_cancelled'));
  const remaining = deadlineMs - Date.now();
  const timer = setTimeout(
    () => controller.abort(new RequestEndedError('request_timeout')),
    Math.max(0, remaining),
  );
  timer.unref();
  if (remaining <= 0) controller.abort(new RequestEndedError('request_timeout'));
  else if (caller?.aborted) onAbort();
  else caller?.addEventListener('abort', onAbort, { once: true });
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // Queue cancellation can occur before the first await continuation.
  void aborted.catch(() => {});
  const reject = () =>
    rejectAbort(
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new RequestEndedError('request_cancelled'),
    );
  if (controller.signal.aborted) reject();
  else controller.signal.addEventListener('abort', reject, { once: true });
  return {
    signal: controller.signal,
    throwIfEnded: () => {
      // Timers may be delayed by other promise continuations on the event loop.
      if (!controller.signal.aborted && Date.now() >= deadlineMs) {
        controller.abort(new RequestEndedError('request_timeout'));
      }
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    wait: <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, aborted]),
    close: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onAbort);
      controller.signal.removeEventListener('abort', reject);
    },
  };
}
