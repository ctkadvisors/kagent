/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { AimdController } from './aimd.js';
import { BackendError } from './backend-error.js';
import { FailureBackoffController } from './failure-backoff.js';
import { InFlightCounter } from './inflight-counter.js';
import { ModelIndex } from './model-index.js';
import { route, type RouterDeps } from './router.js';
import type { UsageEvent, UsageRecorder } from './usage-recorder.js';
import type {
  AIProvider,
  BackendKind,
  ChatCompletionResponse,
  ModelEndpoint,
  ProviderRequest,
  ProviderResponse,
  StreamingProviderResponse,
} from './types.js';

class FakeUsage implements UsageRecorder {
  readonly events: UsageEvent[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async record(event: UsageEvent): Promise<void> {
    this.events.push(event);
  }
}

class FakeProvider implements AIProvider {
  readonly name: BackendKind;
  constructor(
    name: BackendKind,
    private readonly impl: (req: ProviderRequest) => Promise<ProviderResponse>,
  ) {
    this.name = name;
  }
  supportsModel(): boolean {
    return true;
  }
  chatCompletion(req: ProviderRequest): Promise<ProviderResponse> {
    return this.impl(req);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async chatCompletionStream(): Promise<StreamingProviderResponse> {
    throw new Error('not used');
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function chatResponse(): ChatCompletionResponse {
  return {
    id: 'r-1',
    object: 'chat.completion',
    created: 1,
    model: 'mock',
    choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

function modelEp(model: string, max = 4, seed = 2): ModelEndpoint {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ModelEndpoint',
    metadata: { name: 'm' },
    spec: {
      model,
      backendKind: 'mock',
      backendUrl: 'http://x',
      inFlight: { seed, max },
    },
  };
}

function buildDeps(
  model: ModelEndpoint,
  opts: { capStartingAt?: number } = {},
): RouterDeps & {
  modelIndex: ModelIndex;
  inFlight: InFlightCounter;
  aimd: AimdController;
  usage: FakeUsage;
} {
  const idx = new ModelIndex();
  idx.upsert(model);
  const aimd = new AimdController({
    seed: opts.capStartingAt ?? model.spec.inFlight.seed,
    max: model.spec.inFlight.max,
    minSafe: model.spec.minSafe ?? 1,
  });
  return {
    modelIndex: idx,
    inFlight: new InFlightCounter(),
    aimd,
    usage: new FakeUsage(),
  };
}

describe('route', () => {
  it('returns 400 unknown_model when no ModelEndpoint matches', async () => {
    const deps = buildDeps(modelEp('m'));
    const result = await route(deps, {
      requestId: 'r-1',
      request: { model: 'unknown', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: 'sk-pfx',
      taskUid: null,
      agentName: null,
    });
    expect(result.kind).toBe('unknown_model');
    expect(result.statusCode).toBe(400);
  });

  it('returns 503 and does not call the provider when dispatch is disabled', async () => {
    const deps = { ...buildDeps(modelEp('m')), providerDispatchDisabled: true };
    let providerCalled = false;
    const provider = new FakeProvider('mock', () => {
      providerCalled = true;
      return Promise.resolve({
        response: chatResponse(),
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      });
    });
    const result = await route(deps, {
      requestId: 'r-disabled',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: 'sk-pfx',
      taskUid: 'task-disabled',
      agentName: 'researcher',
      providerOverride: provider,
    });

    expect(result.kind).toBe('provider_dispatch_disabled');
    expect(result.statusCode).toBe(503);
    expect(providerCalled).toBe(false);
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.usage.events.at(-1)).toMatchObject({
      statusCode: 503,
      inputTokens: 0,
      outputTokens: 0,
      taskUid: 'task-disabled',
    });
  });

  it('opens a provider-failure backoff circuit and stops calling the backend after repeated failures', async () => {
    const deps = {
      ...buildDeps(modelEp('m', 8, 8)),
      failureBackoff: new FailureBackoffController({
        failureThreshold: 2,
        backoffSeconds: 60,
        clock: () => 1_000,
      }),
    };
    let providerCalls = 0;
    const provider = new FakeProvider('mock', () => {
      providerCalls += 1;
      return Promise.reject(
        new BackendError({
          backend: 'mock',
          status: 500,
          message: 'mock error 500: upstream exploded',
        }),
      );
    });
    const ctx = {
      requestId: 'r-backoff',
      request: { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] },
      apiKeyPrefix: 'sk-pfx',
      taskUid: 'task-backoff',
      agentName: 'researcher',
      providerOverride: provider,
    };

    const first = await route(deps, ctx);
    const second = await route(deps, ctx);
    const third = await route(deps, ctx);

    expect(first.kind).toBe('dispatch_error');
    expect(second.kind).toBe('dispatch_error');
    expect(third.kind).toBe('provider_failure_backoff');
    if (third.kind === 'provider_failure_backoff') {
      expect(third.statusCode).toBe(503);
      expect(third.retryAfterSec).toBe(60);
      expect(third.message).toContain('provider failure backoff');
    }
    expect(providerCalls).toBe(2);
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.usage.events.at(-1)).toMatchObject({
      statusCode: 503,
      inputTokens: 0,
      outputTokens: 0,
      taskUid: 'task-backoff',
    });
  });

  it('classifies provider invalid-model 400s as non-retryable config errors and opens backoff', async () => {
    const deps = {
      ...buildDeps(modelEp('workers-ai/@cf/meta/bad-model', 8, 8)),
      failureBackoff: new FailureBackoffController({
        failureThreshold: 1,
        backoffSeconds: 300,
        clock: () => 10_000,
      }),
    };
    let providerCalls = 0;
    const provider = new FakeProvider('mock', () => {
      providerCalls += 1;
      return Promise.reject(
        new BackendError({
          backend: 'cloudflare',
          status: 400,
          message:
            'cloudflare error 400: {"message":"AiError: No such model: No such model @cf/meta/bad-model or task"}',
        }),
      );
    });
    const ctx = {
      requestId: 'r-invalid-model',
      request: {
        model: 'workers-ai/@cf/meta/bad-model',
        messages: [{ role: 'user' as const, content: 'hi' }],
      },
      apiKeyPrefix: 'sk-pfx',
      taskUid: 'task-invalid-model',
      agentName: 'researcher',
      providerOverride: provider,
    };

    const first = await route(deps, ctx);
    const second = await route(deps, ctx);

    expect(first.kind).toBe('provider_config_error');
    if (first.kind === 'provider_config_error') {
      expect(first.statusCode).toBe(400);
      expect(first.message).toContain('No such model');
    }
    expect(second.kind).toBe('provider_failure_backoff');
    expect(providerCalls).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.usage.events.at(-2)).toMatchObject({
      statusCode: 400,
      inputTokens: 0,
      outputTokens: 0,
      taskUid: 'task-invalid-model',
    });
    expect(deps.usage.events.at(-1)).toMatchObject({
      statusCode: 503,
      inputTokens: 0,
      outputTokens: 0,
      taskUid: 'task-invalid-model',
    });
  });

  it('returns 200 + records usage on a successful dispatch', async () => {
    const deps = buildDeps(modelEp('m'));
    const provider = new FakeProvider('mock', () =>
      Promise.resolve({
        response: chatResponse(),
        inputTokens: 3,
        outputTokens: 1,
        latencyMs: 12,
      }),
    );
    const result = await route(deps, {
      requestId: 'r-2',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: 'sk-pfx',
      taskUid: 'task-1',
      agentName: 'researcher',
      providerOverride: provider,
    });
    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      expect(result.statusCode).toBe(200);
      expect(result.body.choices[0]?.message.content).toBe('pong');
    }
    // Usage flushes asynchronously via fire-and-forget — `record` was awaited inside route's Promise.then path, so a microtask flush is enough.
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.usage.events).toHaveLength(1);
    expect(deps.usage.events[0]?.taskUid).toBe('task-1');
    expect(deps.usage.events[0]?.agentName).toBe('researcher');
    expect(deps.usage.events[0]?.statusCode).toBe(200);
    expect(deps.usage.events[0]?.inputTokens).toBe(3);
  });

  it('returns 429 with Retry-After when at cap', async () => {
    // seed=1, max=4 → starting cap=1; pre-bump in-flight to 1.
    const deps = buildDeps(modelEp('m', 4, 1), { capStartingAt: 1 });
    deps.inFlight.acquire('m', 'http://x');
    const result = await route(deps, {
      requestId: 'r-3',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: null,
      taskUid: null,
      agentName: null,
      providerOverride: new FakeProvider('mock', () =>
        Promise.resolve({
          response: chatResponse(),
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
        }),
      ),
    });
    expect(result.kind).toBe('at_cap');
    if (result.kind === 'at_cap') {
      expect(result.statusCode).toBe(429);
      expect(result.retryAfterSec).toBeGreaterThan(0);
      expect(result.currentCap).toBe(1);
      expect(result.inFlight).toBe(1);
    }
  });

  it('decrements in-flight after a successful dispatch', async () => {
    const deps = buildDeps(modelEp('m'));
    const provider = new FakeProvider('mock', () =>
      Promise.resolve({
        response: chatResponse(),
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      }),
    );
    await route(deps, {
      requestId: 'r-4',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: null,
      taskUid: null,
      agentName: null,
      providerOverride: provider,
    });
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
  });

  it('on provider throw — halves AIMD cap, returns 502, releases in-flight', async () => {
    const deps = buildDeps(modelEp('m', 8, 8));
    const provider = new FakeProvider('mock', () => Promise.reject(new Error('upstream 500')));
    const before = deps.aimd.currentCap('m', 'http://x');
    expect(before).toBe(8);
    const result = await route(deps, {
      requestId: 'r-5',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: 'sk-pfx',
      taskUid: 'task-1',
      agentName: 'researcher',
      providerOverride: provider,
    });
    expect(result.kind).toBe('dispatch_error');
    if (result.kind === 'dispatch_error') {
      expect(result.statusCode).toBe(502);
      expect(result.message).toContain('upstream 500');
    }
    expect(deps.aimd.currentCap('m', 'http://x')).toBe(4);
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.usage.events.at(-1)?.statusCode).toBe(502);
    expect(deps.usage.events.at(-1)?.errorMessage).toContain('upstream 500');
  });

  it('on BackendError 429 — emits backend_throttled with retryAfterSec from upstream (H13)', async () => {
    const deps = buildDeps(modelEp('m', 8, 8));
    const provider = new FakeProvider('mock', () =>
      Promise.reject(
        new BackendError({
          backend: 'openai',
          status: 429,
          message: 'openai error 429: rate limit',
          retryAfter: 7,
        }),
      ),
    );
    const result = await route(deps, {
      requestId: 'r-throttle-1',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: 'sk-pfx',
      taskUid: 'task-1',
      agentName: 'researcher',
      providerOverride: provider,
    });
    expect(result.kind).toBe('backend_throttled');
    if (result.kind === 'backend_throttled') {
      expect(result.statusCode).toBe(429);
      expect(result.retryAfterSec).toBe(7);
      expect(result.backend).toBe('mock');
      expect(result.message).toContain('429');
    }
    // AIMD still halves on a backend_throttled — local admission needs
    // to feel the upstream pressure too.
    expect(deps.aimd.currentCap('m', 'http://x')).toBe(4);
    expect(deps.inFlight.current('m', 'http://x')).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.usage.events.at(-1)?.statusCode).toBe(429);
  });

  it('on BackendError 503 without Retry-After — falls back to a non-zero default (H13)', async () => {
    const deps = buildDeps(modelEp('m', 8, 8));
    const provider = new FakeProvider('mock', () =>
      Promise.reject(
        new BackendError({
          backend: 'openai',
          status: 503,
          message: 'openai error 503: maintenance',
        }),
      ),
    );
    const result = await route(deps, {
      requestId: 'r-throttle-2',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: null,
      taskUid: null,
      agentName: null,
      providerOverride: provider,
    });
    expect(result.kind).toBe('backend_throttled');
    if (result.kind === 'backend_throttled') {
      expect(result.statusCode).toBe(503);
      expect(result.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('on BackendError outside 429/503 — falls through to dispatch_error (H13)', async () => {
    const deps = buildDeps(modelEp('m', 8, 8));
    const provider = new FakeProvider('mock', () =>
      Promise.reject(
        new BackendError({
          backend: 'openai',
          status: 500,
          message: 'openai error 500: oops',
        }),
      ),
    );
    const result = await route(deps, {
      requestId: 'r-non-throttle',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: null,
      taskUid: null,
      agentName: null,
      providerOverride: provider,
    });
    expect(result.kind).toBe('dispatch_error');
  });

  it('on dispatch_error path — scrubs secrets in errorMessage before recording (H15)', async () => {
    const deps = buildDeps(modelEp('m', 8, 8));
    const provider = new FakeProvider('mock', () =>
      Promise.reject(new Error('upstream 500: token sk-abcdefghijklmnopqrstuvwx invalid')),
    );
    const result = await route(deps, {
      requestId: 'r-scrub',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: null,
      taskUid: null,
      agentName: null,
      providerOverride: provider,
    });
    expect(result.kind).toBe('dispatch_error');
    if (result.kind === 'dispatch_error') {
      expect(result.message).toContain('[REDACTED]');
      expect(result.message).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    }
    await Promise.resolve();
    await Promise.resolve();
    const lastEvent = deps.usage.events.at(-1);
    expect(lastEvent?.errorMessage).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });

  it('synchronises AIMD bounds with the latest ModelEndpoint observation', async () => {
    const deps = buildDeps(modelEp('m', 8, 4));
    // Update the endpoint to a smaller max + smaller seed BEFORE the
    // first call — so the router's first updateBounds reseeds the
    // freshly-ensured AIMD entry to the new spec.seed.
    deps.modelIndex.upsert(modelEp('m', 2, 1));
    await route(deps, {
      requestId: 'r-6',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: null,
      taskUid: null,
      agentName: null,
      providerOverride: new FakeProvider('mock', () =>
        Promise.resolve({
          response: chatResponse(),
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        }),
      ),
    });
    // After the first updateBounds, the fresh entry seeds to spec.seed (1).
    expect(deps.aimd.currentCap('m', 'http://x')).toBe(1);
  });

  /* =====================================================================
   * C3-REV3-H1 — full attack reproduction. A CR with `spec.minSafe: 0`
   * was already clamped at watch time, but the router calls
   * `aimd.updateBounds` with `lookup.minSafe` on EVERY request. If
   * `ModelIndex.lookup()` returns the unclamped value, the first
   * request after watch-time normalization overwrites the clamp.
   * Subsequent `onError` calls would then halve the cap toward 0,
   * pinning the (model, endpoint) at zero capacity (DoS).
   *
   * Post-fix: lookup itself clamps via `normalizeBounds`, so
   * `aimd.state.bounds.minSafe` stays at 1 across the request, and
   * `onError` floors at 1.
   * ===================================================================== */

  it('lookup-time clamp prevents the router-path B5 bypass (C3-REV3-H1)', async () => {
    // Construct a CR that simulates a malicious / misconfigured spec.
    const malicious: ModelEndpoint = {
      ...modelEp('m', 4, 2),
      spec: { ...modelEp('m', 4, 2).spec, minSafe: 0 },
    };
    const deps = buildDeps(malicious);
    // Sanity: lookup must already report the clamped floor.
    const lookup = deps.modelIndex.lookup('m');
    expect(lookup?.minSafe).toBe(1);

    // Drive a request through. The router's `aimd.updateBounds` must
    // be fed the clamped value, NOT 0.
    const provider = new FakeProvider('mock', () =>
      Promise.resolve({
        response: chatResponse(),
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      }),
    );
    await route(deps, {
      requestId: 'r-c3rev3h1-1',
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyPrefix: null,
      taskUid: null,
      agentName: null,
      providerOverride: provider,
    });

    // Now hammer the controller with errors — without the lookup-time
    // clamp, the cap would collapse toward 0. With the clamp, it
    // floors at minSafe = 1.
    for (let i = 0; i < 10; i++) {
      deps.aimd.onError('m', 'http://x');
    }
    expect(deps.aimd.currentCap('m', 'http://x')).toBe(1);

    // Snapshot's bounds.minSafe is the load-bearing invariant.
    const snap = deps.aimd.snapshot().find((s) => s.model === 'm');
    expect(snap?.minSafe).toBe(1);
  });
});
