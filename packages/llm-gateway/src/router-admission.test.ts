/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AimdController } from './aimd.js';
import { InFlightCounter } from './inflight-counter.js';
import { ModelIndex } from './model-index.js';
import { route, type RouteContext, type RouterDeps } from './router.js';
import type { AIProvider, ProviderRequest, ProviderResponse } from './types.js';
import type { UsageEvent } from './usage-recorder.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const response: ProviderResponse = {
  response: {
    id: 'test',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  inputTokens: 1,
  outputTokens: 1,
  latencyMs: 1,
};
function setup(cap = 1) {
  const modelIndex = new ModelIndex();
  modelIndex.upsert({
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ModelEndpoint',
    metadata: { name: 'm' },
    spec: {
      model: 'm',
      backendKind: 'mock',
      backendUrl: 'http://x',
      inFlight: { seed: cap, max: 4 },
      minSafe: 1,
    },
  });
  const events: UsageEvent[] = [];
  const deps: RouterDeps = {
    modelIndex,
    inFlight: new InFlightCounter(),
    aimd: new AimdController({ seed: cap, max: 4, minSafe: 1 }),
    usage: {
      record: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
  };
  const ctx = (
    id: string,
    impl: (req: ProviderRequest) => Promise<ProviderResponse>,
    extra = {},
  ): RouteContext => ({
    requestId: id,
    request: { model: 'm', messages: [{ role: 'user', content: id }] },
    apiKeyPrefix: null,
    taskUid: id,
    agentName: 'test',
    providerOverride: { name: 'mock', chatCompletion: impl } as AIProvider,
    ...extra,
  });
  return { deps, events, ctx };
}
afterEach(() => vi.useRealTimers());

describe('inference request admission', () => {
  it('waits FIFO instead of failing a competing request or allowing the incumbent to overtake it', async () => {
    const { deps, ctx } = setup();
    const first = deferred<ProviderResponse>(),
      second = deferred<ProviderResponse>();
    const order: string[] = [];
    const a = route(
      deps,
      ctx('a', () => {
        order.push('a');
        return first.promise;
      }),
    );
    await vi.waitFor(() => expect(order).toEqual(['a']));
    let bSettled = false;
    const b = route(
      deps,
      ctx('b', () => {
        order.push('b');
        return second.promise;
      }),
    ).then((r) => {
      bSettled = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bSettled).toBe(false);
    first.resolve(response);
    await a;
    const c = route(
      deps,
      ctx('c', () => {
        order.push('c');
        return Promise.resolve(response);
      }),
    );
    await vi.waitFor(() => expect(order).toEqual(['a', 'b']));
    expect(deps.inFlight.current('m', 'http://x')).toBe(1);
    second.resolve(response);
    expect((await b).kind).toBe('dispatched');
    expect((await c).kind).toBe('dispatched');
    expect(order).toEqual(['a', 'b', 'c']);
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
  });

  it('removes a cancelled waiter so it never dispatches and records zero-token cancellation', async () => {
    const { deps, ctx, events } = setup();
    const first = deferred<ProviderResponse>();
    const a = route(
      deps,
      ctx('a', () => first.promise),
    );
    await vi.waitFor(() => expect(deps.inFlight.current('m', 'http://x')).toBe(1));
    const controller = new AbortController();
    let calls = 0;
    const b = route(
      deps,
      ctx(
        'b',
        () => {
          calls++;
          return Promise.resolve(response);
        },
        { abortSignal: controller.signal },
      ),
    );
    controller.abort();
    expect((await b).kind).toBe('request_cancelled');
    first.resolve(response);
    await a;
    expect(calls).toBe(0);
    expect(events.find((e) => e.requestId === 'b')).toMatchObject({
      statusCode: 499,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('uses one deadline for queue plus backend execution and aborts the backend at that deadline', async () => {
    vi.useFakeTimers();
    const { deps, ctx } = setup();
    const first = deferred<ProviderResponse>();
    const a = route(
      deps,
      ctx('a', () => first.promise),
    );
    await Promise.resolve();
    await Promise.resolve();
    let signal: AbortSignal | undefined;
    const b = route(
      deps,
      ctx(
        'b',
        (request) => {
          signal = (request as ProviderRequest & { abortSignal: AbortSignal }).abortSignal;
          return new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          );
        },
        { deadlineMs: Date.now() + 100 },
      ),
    );
    await vi.advanceTimersByTimeAsync(70);
    first.resolve(response);
    await a;
    await Promise.resolve();
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(30);
    expect((await b).kind).toBe('request_timeout');
    expect(signal?.aborted).toBe(true);
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
  });

  it('releases permits on caller cancellation during backend execution', async () => {
    const { deps, ctx } = setup();
    const controller = new AbortController();
    let started = false;
    const a = route(
      deps,
      ctx(
        'a',
        () => {
          started = true;
          return new Promise(() => {});
        },
        { abortSignal: controller.signal },
      ),
    );
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort();
    expect((await a).kind).toBe('request_cancelled');
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
    expect(
      (
        await route(
          deps,
          ctx('b', () => Promise.resolve(response)),
        )
      ).kind,
    ).toBe('dispatched');
  });
  it('observes a decreased AIMD cap without releasing another permit early', async () => {
    const { deps, ctx } = setup(2);
    const one = deferred<ProviderResponse>(),
      two = deferred<ProviderResponse>();
    const order: string[] = [];
    const a = route(
      deps,
      ctx('a', () => {
        order.push('a');
        return one.promise;
      }),
    );
    const b = route(
      deps,
      ctx('b', () => {
        order.push('b');
        return two.promise;
      }),
    );
    await vi.waitFor(() => expect(order).toEqual(['a', 'b']));
    const c = route(
      deps,
      ctx('c', () => {
        order.push('c');
        return Promise.resolve(response);
      }),
    );
    deps.aimd.onError('m', 'http://x');
    one.resolve(response);
    await a;
    expect(order).toEqual(['a', 'b']);
    two.resolve(response);
    await b;
    await c;
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('wakes existing waiters when live AIMD bounds increase capacity', async () => {
    const { deps, ctx } = setup();
    const one = deferred<ProviderResponse>();
    let secondCalled = false;
    const a = route(
      deps,
      ctx('a', () => one.promise),
    );
    await vi.waitFor(() => expect(deps.inFlight.current('m', 'http://x')).toBe(1));
    const b = route(
      deps,
      ctx('b', () => {
        secondCalled = true;
        return Promise.resolve(response);
      }),
    );
    expect(secondCalled).toBe(false);
    deps.aimd.updateBounds('m', 'http://x', { seed: 2, max: 4, minSafe: 2 });
    expect((await b).kind).toBe('dispatched');
    expect(secondCalled).toBe(true);
    one.resolve(response);
    await a;
  });

  it('expired waiting requests never reach the provider and do not leak a permit', async () => {
    vi.useFakeTimers();
    const { deps, ctx } = setup();
    const one = deferred<ProviderResponse>();
    const a = route(
      deps,
      ctx('a', () => one.promise),
    );
    await Promise.resolve();
    await Promise.resolve();
    let calls = 0;
    const b = route(
      deps,
      ctx(
        'b',
        () => {
          calls++;
          return Promise.resolve(response);
        },
        { deadlineMs: Date.now() + 20 },
      ),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect((await b).kind).toBe('request_timeout');
    one.resolve(response);
    await a;
    expect(calls).toBe(0);
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
    expect(
      (
        await route(
          deps,
          ctx('c', () => Promise.resolve(response)),
        )
      ).kind,
    ).toBe('dispatched');
  });

  it('does not serialize requests to a different model behind a busy one', async () => {
    const { deps, ctx } = setup();
    const one = deferred<ProviderResponse>();
    const a = route(
      deps,
      ctx('a', () => one.promise),
    );
    await Promise.resolve();
    await Promise.resolve();
    const original = deps.modelIndex.lookup('m')!.endpoint;
    deps.modelIndex.upsert({
      ...original,
      metadata: { name: 'other' },
      spec: { ...original.spec, model: 'other' },
    });
    const b = await route(deps, {
      ...ctx('b', () => Promise.resolve(response)),
      request: { model: 'other', messages: [] },
    });
    expect(b.kind).toBe('dispatched');
    one.resolve(response);
    await a;
  });

  it('rejects an already cancelled caller or expired deadline before dispatch without an unhandled rejection', async () => {
    const { deps, ctx } = setup();
    const cancelled = new AbortController();
    cancelled.abort();
    let calls = 0;
    const provider = () => {
      calls++;
      return Promise.resolve(response);
    };
    expect(
      (await route(deps, ctx('cancelled', provider, { abortSignal: cancelled.signal }))).kind,
    ).toBe('request_cancelled');
    expect((await route(deps, ctx('expired', provider, { deadlineMs: Date.now() - 1 }))).kind).toBe(
      'request_timeout',
    );
    expect(calls).toBe(0);
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
  });
  it('does not dispatch an expired waiter when timer delivery is delayed behind permit completion', async () => {
    vi.useFakeTimers();
    const { deps, ctx } = setup();
    const one = deferred<ProviderResponse>();
    const a = route(
      deps,
      ctx('a', () => one.promise),
    );
    await Promise.resolve();
    await Promise.resolve();
    let calls = 0;
    const b = route(
      deps,
      ctx(
        'b',
        () => {
          calls++;
          return Promise.resolve(response);
        },
        { deadlineMs: Date.now() + 20 },
      ),
    );
    vi.setSystemTime(Date.now() + 30);
    one.resolve(response);
    await a;
    expect((await b).kind).toBe('request_timeout');
    expect(calls).toBe(0);
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
  });
});
