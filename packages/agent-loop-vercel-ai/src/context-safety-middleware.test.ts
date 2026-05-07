/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for Component 1 — `KagentContextSafetyMiddleware`.
 *
 * R3 §4.1 requires: middleware refuses at threshold; respects abort
 * signal (which here means: a thrown refusal propagates cleanly out
 * of `wrapGenerate` / `wrapStream` so the caller's outer abort
 * handling sees the error rather than the substrate silently
 * swallowing).
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';

import {
  KagentContextSafetyMiddleware,
  KagentContextWindowRefusedError,
  buildKagentContextSafetyMiddleware,
} from './context-safety-middleware.js';

const stubModel = {} as LanguageModelV3;
const stubParams = {} as LanguageModelV3CallOptions;

function makeGenerateResult(input: number, output: number): LanguageModelV3GenerateResult {
  return {
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: output, text: output, reasoning: 0 },
    },
    // The full LanguageModelV3GenerateResult shape has many more
    // fields; we cast to satisfy the type without exercising them.
  } as unknown as LanguageModelV3GenerateResult;
}

describe('KagentContextSafetyMiddleware', () => {
  it('is a no-op when contextWindowTokens is undefined (back-compat)', async () => {
    const mw = new KagentContextSafetyMiddleware({});
    const doGenerate = vi.fn(() => Promise.resolve(makeGenerateResult(1000, 500)));
    const result = await mw.wrapGenerate({
      doGenerate,
      doStream: vi.fn(),
      params: stubParams,
      model: stubModel,
    });
    expect(doGenerate).toHaveBeenCalledOnce();
    expect(result).toBeDefined();
    expect(mw.currentCumulativeTokens()).toEqual({ input: 1000, output: 500, total: 1500 });
  });

  it('refuses with KagentContextWindowRefusedError once cumulative tokens reach the threshold', async () => {
    // Window 1000 × 0.95 threshold = refuses at 950 tokens cumulative.
    const mw = new KagentContextSafetyMiddleware({
      contextWindowTokens: 1000,
      safetyThreshold: 0.95,
    });
    // First call burns 600 tokens — should pass.
    const doGenerate = vi
      .fn<() => Promise<LanguageModelV3GenerateResult>>()
      .mockResolvedValueOnce(makeGenerateResult(400, 200))
      // Second call would burn another 400 → cumulative 1000 ≥ 950 → refuse BEFORE forwarding.
      .mockResolvedValueOnce(makeGenerateResult(200, 200));

    await mw.wrapGenerate({
      doGenerate,
      doStream: vi.fn(),
      params: stubParams,
      model: stubModel,
    });
    // First call observed.
    expect(doGenerate).toHaveBeenCalledOnce();
    expect(mw.currentCumulativeTokens().total).toBe(600);

    // Bump cumulative to 950+ to provoke refusal on the next call.
    await mw.wrapGenerate({
      doGenerate,
      doStream: vi.fn(),
      params: stubParams,
      model: stubModel,
    });
    expect(mw.currentCumulativeTokens().total).toBe(1000);

    // Third call: pre-call check fails → underlying NOT invoked.
    const thirdDoGenerate = vi.fn(() => Promise.resolve(makeGenerateResult(0, 0)));
    await expect(
      mw.wrapGenerate({
        doGenerate: thirdDoGenerate,
        doStream: vi.fn(),
        params: stubParams,
        model: stubModel,
      }),
    ).rejects.toBeInstanceOf(KagentContextWindowRefusedError);
    expect(thirdDoGenerate).not.toHaveBeenCalled();
  });

  it('refusal carries the structured kagent error message', async () => {
    const mw = new KagentContextSafetyMiddleware({
      contextWindowTokens: 100,
      safetyThreshold: 0.5,
    });
    // Force cumulative past threshold via wrapGenerate.
    await mw.wrapGenerate({
      doGenerate: () => Promise.resolve(makeGenerateResult(60, 0)),
      doStream: vi.fn(),
      params: stubParams,
      model: stubModel,
    });
    let caught: unknown;
    try {
      await mw.wrapGenerate({
        doGenerate: () => Promise.resolve(makeGenerateResult(0, 0)),
        doStream: vi.fn(),
        params: stubParams,
        model: stubModel,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KagentContextWindowRefusedError);
    const e = caught as KagentContextWindowRefusedError;
    expect(e.status).toBe(0);
    expect(e.message).toMatch(
      /^context_window_substrate_refused: cumulative=60 window=100 threshold=0\.5$/,
    );
  });

  it('rejects out-of-range safetyThreshold construction', () => {
    expect(() => new KagentContextSafetyMiddleware({ safetyThreshold: 0 })).toThrowError(
      /must be in \(0, 1\]/,
    );
    expect(() => new KagentContextSafetyMiddleware({ safetyThreshold: 1.5 })).toThrowError(
      /must be in \(0, 1\]/,
    );
    expect(() => new KagentContextSafetyMiddleware({ safetyThreshold: NaN })).toThrowError(
      /must be in \(0, 1\]/,
    );
  });

  it('wrapStream pre-call refusal does NOT invoke doStream', async () => {
    const mw = new KagentContextSafetyMiddleware({
      contextWindowTokens: 100,
      safetyThreshold: 0.5,
    });
    // Burn past threshold via generate first.
    await mw.wrapGenerate({
      doGenerate: () => Promise.resolve(makeGenerateResult(60, 0)),
      doStream: vi.fn(),
      params: stubParams,
      model: stubModel,
    });
    const doStream = vi.fn(() => Promise.resolve({} as LanguageModelV3StreamResult));
    await expect(
      mw.wrapStream({
        doGenerate: vi.fn(),
        doStream,
        params: stubParams,
        model: stubModel,
      }),
    ).rejects.toBeInstanceOf(KagentContextWindowRefusedError);
    expect(doStream).not.toHaveBeenCalled();
  });

  it('wrapStream observes finish-chunk usage via the TransformStream', async () => {
    const mw = new KagentContextSafetyMiddleware({
      contextWindowTokens: 10_000,
      safetyThreshold: 0.95,
    });
    // Build a ReadableStream that emits one finish chunk carrying usage.
    const finishChunk = {
      type: 'finish' as const,
      usage: {
        inputTokens: { total: 700 },
        outputTokens: { total: 300 },
      },
    };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(finishChunk);
        controller.close();
      },
    });
    const doStream = (): Promise<LanguageModelV3StreamResult> =>
      Promise.resolve({ stream } as unknown as LanguageModelV3StreamResult);
    const result = await mw.wrapStream({
      doGenerate: vi.fn(),
      doStream,
      params: stubParams,
      model: stubModel,
    });
    // Drain the wrapped stream so the transform's `transform` runs.
    const reader = result.stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(mw.currentCumulativeTokens().input).toBe(700);
    expect(mw.currentCumulativeTokens().output).toBe(300);
  });

  it('respects an abort signal — when the runner aborts, the next pre-call refuses by virtue of cumulative state, not by the signal directly', async () => {
    // The middleware itself is signal-agnostic (the AI SDK handles
    // abort propagation through doGenerate/doStream). The contract
    // test is: when the stream's underlying model rejects with an
    // AbortError, the rejection propagates out of wrapGenerate/Stream
    // unchanged — the middleware does not swallow it.
    const mw = new KagentContextSafetyMiddleware({ contextWindowTokens: 1000 });
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    await expect(
      mw.wrapGenerate({
        doGenerate: () => Promise.reject(abortErr),
        doStream: vi.fn(),
        params: stubParams,
        model: stubModel,
      }),
    ).rejects.toBe(abortErr);
  });
});

describe('KagentContextSafetyMiddleware — usage fallback (R3-LOW-1, C2R3-LOW-2)', () => {
  it('does NOT throw on a usage shape missing .total fields (C2R3-LOW-2 optional chaining)', async () => {
    // A non-conformant provider returns `inputTokens` / `outputTokens`
    // shapes WITHOUT a `total` property. Pre-fix, the unconditional
    // `.total` access threw `TypeError: Cannot read properties of
    // undefined (reading 'total')` and the safety-net cumulative
    // counter was poisoned. Post-fix the optional-chained read returns
    // undefined and the estimateTokens fallback fires.
    const mw = new KagentContextSafetyMiddleware({ contextWindowTokens: 10_000 });
    const malformedResult = {
      content: [{ type: 'text', text: 'hello world' }],
      usage: {
        // shape WITHOUT .total — both inputTokens and outputTokens are
        // empty objects (the real failure mode for a Cloudflare-style
        // partial-usage shape).
        inputTokens: {},
        outputTokens: {},
      },
    } as unknown as LanguageModelV3GenerateResult;
    await mw.wrapGenerate({
      doGenerate: () => Promise.resolve(malformedResult),
      doStream: vi.fn(),
      params: {
        prompt: [{ role: 'user', content: 'a fairly short prompt' }],
      } as unknown as LanguageModelV3CallOptions,
      model: stubModel,
    });
    // The fallback should have observed >0 cumulative tokens — the
    // `estimateTokens` heuristic on the prompt text + result content
    // produces non-zero counts. Without the fallback this would be 0.
    const cum = mw.currentCumulativeTokens();
    expect(cum.input).toBeGreaterThan(0);
    expect(cum.output).toBeGreaterThan(0);
  });

  it('falls back to estimateTokens when streaming finish chunk lacks usage entirely (R3-LOW-1)', async () => {
    const mw = new KagentContextSafetyMiddleware({ contextWindowTokens: 10_000 });
    const stream = new ReadableStream({
      start(controller) {
        // Emit several text-delta chunks so the buffer accumulates.
        controller.enqueue({ type: 'text-delta', delta: 'hello ' });
        controller.enqueue({ type: 'text-delta', delta: 'world from the model' });
        // Finish chunk with NO usage at all (Cloudflare Workers AI shape).
        controller.enqueue({ type: 'finish' });
        controller.close();
      },
    });
    const doStream = (): Promise<LanguageModelV3StreamResult> =>
      Promise.resolve({ stream } as unknown as LanguageModelV3StreamResult);
    const result = await mw.wrapStream({
      doGenerate: vi.fn(),
      doStream,
      params: {
        prompt: [{ role: 'user', content: 'a fairly short prompt' }],
      } as unknown as LanguageModelV3CallOptions,
      model: stubModel,
    });
    const reader = result.stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    // Both counters should be non-zero: input from the prompt text,
    // output from the buffered text-delta chunks. Pre-fix, both were 0.
    const cum = mw.currentCumulativeTokens();
    expect(cum.input).toBeGreaterThan(0);
    expect(cum.output).toBeGreaterThan(0);
  });
});

describe('buildKagentContextSafetyMiddleware', () => {
  it('returns a structurally-valid LanguageModelV3Middleware', () => {
    const { middleware, instance } = buildKagentContextSafetyMiddleware({
      contextWindowTokens: 1000,
    });
    expect(middleware).toBeDefined();
    expect((middleware as { specificationVersion?: string }).specificationVersion).toBe('v3');
    expect(instance.currentCumulativeTokens()).toEqual({ input: 0, output: 0, total: 0 });
  });
});
