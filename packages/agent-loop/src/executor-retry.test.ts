/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `AgentExecutor` 429-retry policy tests.
 *
 * The executor wraps every `LLMClient.chat()` call with a retry policy that
 * absorbs transient HTTP 429 (rate-limited / at-cap) responses from the
 * downstream gateway. The policy is the right layer for retry because:
 *
 * - The kernel already mediates every chat() (token accounting, tracing).
 * - Retry sequencing emits trace events so observers see the full attempt
 *   ladder ("1st attempt: 429, backoff 800ms, 2nd attempt: 200").
 * - The `LLMClient` adapter stays a thin protocol mapper; consumers stay
 *   minimal.
 *
 * Strict scope: ONLY HTTP 429 retries here. Other HTTP errors (5xx, 401),
 * protocol errors, abort errors, and network failures bubble immediately.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from './registry.js';
import { AgentExecutor } from './executor.js';
import { LLMClientHttpError, LLMClientProtocolError } from './errors.js';
import type { MyType, MyPhase } from './__fixtures__/agents.js';
import { chatAgent } from './__fixtures__/agents.js';
import { makeStubLLM } from './__fixtures__/stub-llm.js';

function buildRegistry(): AgentRegistry<MyType, MyPhase> {
  const reg = new AgentRegistry<MyType, MyPhase>();
  reg.register(chatAgent);
  return reg;
}

describe('AgentExecutor — 429 retry policy', () => {
  let registry: AgentRegistry<MyType, MyPhase>;
  beforeEach(() => {
    registry = buildRegistry();
  });

  it('single 429 → retry → success: status="completed", finalContent set, 2 chat() calls', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap'), { content: 'ok' }],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('ok');
    expect(recordedSleeps).toEqual([200]); // one backoff before retry #1
    const llmTraces = result.traces.filter((t) => t.trace_type === 'llm_call');
    expect(llmTraces).toHaveLength(2); // attempt 0 (429) + attempt 1 (success)
    expect(llmTraces[0]?.retry_attempt).toBe(0);
    expect(llmTraces[1]?.retry_attempt).toBe(1);
    expect(llmTraces[1]?.retry_backoff_ms).toBe(200);
  });

  it('two 429s → two retries → success: 3 chat() calls; backoffs 200ms then 800ms', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [
        new LLMClientHttpError(429, 'at cap'),
        new LLMClientHttpError(429, 'still at cap'),
        { content: 'finally' },
      ],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('finally');
    expect(recordedSleeps).toEqual([200, 800]);
    const llmTraces = result.traces.filter((t) => t.trace_type === 'llm_call');
    expect(llmTraces).toHaveLength(3);
    expect(llmTraces.map((t) => t.retry_attempt)).toEqual([0, 1, 2]);
  });

  it('three 429s with maxRetries=2 → exhausts retries → propagates final 429 → status="failed"', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [
        new LLMClientHttpError(429, 'at cap 1'),
        new LLMClientHttpError(429, 'at cap 2'),
        new LLMClientHttpError(429, 'at cap 3'),
      ],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('429');
    expect(result.error?.cause).toBeInstanceOf(LLMClientHttpError);
    expect((result.error?.cause as LLMClientHttpError).status).toBe(429);
    // Two backoffs — original attempt + 2 retries = 3 chat() calls total, 2 sleeps.
    expect(recordedSleeps).toEqual([200, 800]);
    const llmTraces = result.traces.filter((t) => t.trace_type === 'llm_call');
    expect(llmTraces).toHaveLength(3);
    expect(llmTraces[2]?.error).toContain('429');
  });

  it('non-429 HTTP error (500) → no retry → propagates immediately', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(500, 'internal error')],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('failed');
    expect(recordedSleeps).toEqual([]); // never slept — no retry
    const llmTraces = result.traces.filter((t) => t.trace_type === 'llm_call');
    expect(llmTraces).toHaveLength(1);
  });

  it('non-LLMClientHttpError (protocol error) → no retry → propagates immediately', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientProtocolError('malformed JSON', null)],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('failed');
    expect(recordedSleeps).toEqual([]);
  });

  it('Retry-After honored when present on the LLMClientHttpError', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [
        new LLMClientHttpError(429, 'at cap', undefined, 2), // retryAfterSec=2
        { content: 'ok' },
      ],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    // Retry-After=2s wins over the 200ms first-default-backoff.
    expect(recordedSleeps).toEqual([2000]);
    const llmTraces = result.traces.filter((t) => t.trace_type === 'llm_call');
    expect(llmTraces[1]?.retry_backoff_ms).toBe(2000);
  });

  it('Retry-After=0 honored as 0 (immediate retry, not converted to default)', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap', undefined, 0), { content: 'ok' }],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    expect(recordedSleeps).toEqual([0]);
  });

  it('default retry policy (no opts) absorbs a single 429 with the default backoff schedule', async () => {
    // No retryPolicy supplied → executor uses its built-in defaults
    // (maxRetries=2, [200,800,3200]). Inject sleep through the policy
    // instead by passing only `sleep` to keep the test deterministic;
    // assert the schedule values via recordedSleeps.
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap'), { content: 'ok' }],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    expect(recordedSleeps).toEqual([200]); // confirms default backoffSchedule[0]
  });

  it('disabled retry policy (maxRetries=0) → 429 fails immediately', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap')],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 0,
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('failed');
    expect(recordedSleeps).toEqual([]);
  });

  it('429 retry path is abort-aware: aborting during backoff → status="cancelled" without further chat() call', async () => {
    const recordedSleeps: number[] = [];
    const recordedRequests: import('./llm-client.js').ChatRequest[] = [];
    const controller = new AbortController();
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap'), { content: 'should not be reached' }],
      recordedRequests,
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        // Abort during the sleep — mirrors a SIGTERM landing while the
        // executor waits on backoff. The retry path MUST honor it and
        // not issue the second chat() call.
        sleep: (ms) => {
          recordedSleeps.push(ms);
          controller.abort();
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(recordedSleeps).toEqual([200]);
    expect(recordedRequests).toHaveLength(1); // only the first attempt
  });

  /* ===================================================================
   * NH2 (audit-rev2 C2 §3) — Retry-After cap + abort-interruptible sleep.
   * =================================================================== */

  it('NH2-A: Retry-After: 600 (10 min) is CAPPED at 30s', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [
        new LLMClientHttpError(429, 'at cap', undefined, 600), // 10 minutes — adversarial / misbehaving gateway
        { content: 'ok' },
      ],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    // Pre-fix: recordedSleeps = [600_000]. Post-fix: clamped to 30_000.
    expect(recordedSleeps).toEqual([30_000]);
    const llmTraces = result.traces.filter((t) => t.trace_type === 'llm_call');
    expect(llmTraces[1]?.retry_backoff_ms).toBe(30_000);
  });

  it('NH2-A: Retry-After: 3600 (1 hour) is CAPPED at 30s', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap', undefined, 3600), { content: 'ok' }],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    expect(recordedSleeps).toEqual([30_000]);
  });

  it('NH2-A: Retry-After at exactly 30s passes through unchanged', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap', undefined, 30), { content: 'ok' }],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    expect(recordedSleeps).toEqual([30_000]);
  });

  it('NH2-A: Retry-After under 30s is NOT artificially capped (5s pass-through)', async () => {
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap', undefined, 5), { content: 'ok' }],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    expect(recordedSleeps).toEqual([5_000]);
  });

  it('NH2-B: SIGTERM mid-sleep produces immediate abort throw (sleep does not wait its full duration)', async () => {
    const recordedSleeps: number[] = [];
    const recordedRequests: import('./llm-client.js').ChatRequest[] = [];
    const controller = new AbortController();
    let sleepResolveDelayMs: number | undefined;
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap'), { content: 'should not be reached' }],
      recordedRequests,
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [60_000, 800, 3200], // 60s default — would burn the kubelet's grace period
        // Inject a long-running fake sleep, then abort externally.
        // The sleepWithAbort race MUST resolve via the abort path,
        // not by waiting for this fake to settle.
        sleep: (ms) => {
          recordedSleeps.push(ms);
          // Schedule the abort on the microtask queue so the abort
          // event fires AFTER `sleepWithAbort` has registered its
          // 'abort' listener.
          queueMicrotask(() => controller.abort());
          // Return a promise that does NOT resolve quickly —
          // simulating "the timer would have waited 60s." If
          // sleepWithAbort waits for THIS to resolve, the run loop
          // will hang for 60s. The race against abort MUST win first.
          return new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              sleepResolveDelayMs = 60_000;
              resolve();
            }, 60_000);
            // Defensive: vitest will time out at 5s; tear down the
            // timer if the controller signals at the test scope.
            controller.signal.addEventListener('abort', () => {
              clearTimeout(t);
              // Do NOT resolve here — that would defeat the point.
              // Let the race resolve via sleepWithAbort's own abort
              // listener. We just clean up the timer so it doesn't
              // keep the event loop alive after the test.
            });
          });
        },
      },
    });
    const startMs = Date.now();
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startMs;
    expect(result.status).toBe('cancelled');
    // The abort must have unwound the run loop in well under 1s
    // (in practice, microtask-time). If the sleep was non-interruptible,
    // elapsedMs would approach 60_000 and the test would time out.
    expect(elapsedMs).toBeLessThan(1000);
    // The injected fake's timer never fired (its resolve callback
    // never ran). If sleepResolveDelayMs were set, sleepWithAbort
    // would have waited for the fake to finish.
    expect(sleepResolveDelayMs).toBeUndefined();
    // Only the first chat() ran — the retry was aborted.
    expect(recordedRequests).toHaveLength(1);
    expect(recordedSleeps).toEqual([60_000]);
  });

  it('NH2-B: existing 429/backoff tests still pass — abort-aware sleep is back-compat with non-aborting flows', async () => {
    // Smoke regression: the standard "single 429 → success" path
    // still records the configured backoff and produces 2 LLM
    // traces. If sleepWithAbort accidentally short-circuited the
    // happy path, this test would catch it.
    const recordedSleeps: number[] = [];
    const llm = makeStubLLM({
      scriptedChat: [new LLMClientHttpError(429, 'at cap'), { content: 'ok' }],
    });
    const exec = new AgentExecutor({
      registry,
      llm,
      retryPolicy: {
        maxRetries: 2,
        backoffSchedule: [200, 800, 3200],
        sleep: (ms) => {
          recordedSleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    const result = await exec.run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.status).toBe('completed');
    expect(result.finalContent).toBe('ok');
    expect(recordedSleeps).toEqual([200]);
  });
});
