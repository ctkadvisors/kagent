/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Component 1 — `KagentContextSafetyMiddleware` (R3 §4.1).
 *
 * Vercel AI SDK `LanguageModelV3` middleware that mirrors
 * `@kagent/agent-loop`'s `chatWithRetry` pre-call refusal at the
 * 95% threshold (default) — the substrate's circuit breaker, ported
 * to a Vercel-AI-SDK call boundary.
 *
 * Reads:
 *   - `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` (operator-projected per
 *     `docs/CONTEXT-AWARENESS.md` §4.1).
 *   - `KAGENT_CONTEXT_SAFETY_THRESHOLD` (default `0.95`).
 *
 * Maintains cumulative input/output token state across `doGenerate`
 * and `doStream` invocations on the same middleware instance. A new
 * middleware instance per agent-task run keeps the accounting
 * isolated — `streamText` calls into the same wrapped model multiple
 * times within one agent loop, all of which share the same cumulative
 * counter (matching `@kagent/agent-loop`'s per-run `RunBudget`).
 *
 * Refusal shape mirrors `LLMClientHttpError(0, 'context_window_substrate_refused: …')`
 * from `@kagent/agent-loop/errors.ts`. Vercel AI SDK propagates thrown
 * errors out of the wrapped model verbatim, so `streamText` /
 * `generateText` callers see the exact same structured reason the
 * kagent agent-loop produces.
 *
 * Back-compat (R3 §4.5): when `contextWindowTokens` is undefined the
 * middleware is a no-op — the underlying model is called unmodified.
 * Mirrors `RunBudget.contextWindowTokens === undefined` semantics.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';

/**
 * The kagent-shaped error that the middleware throws when the
 * cumulative-tokens-vs-window check fails. Mirrors
 * `LLMClientHttpError(0, 'context_window_substrate_refused: …')` from
 * `@kagent/agent-loop/errors.ts` — `status: 0` so any retry policy
 * gated to `status === 429` (matching the agent-loop's contract)
 * cannot kick in. The `message` carries the structured reason the
 * status writer surfaces verbatim.
 */
export class KagentContextWindowRefusedError extends Error {
  readonly status = 0 as const;
  readonly cumulativeTokens: number;
  readonly contextWindowTokens: number;
  readonly safetyThreshold: number;
  constructor(cumulativeTokens: number, contextWindowTokens: number, safetyThreshold: number) {
    super(
      `context_window_substrate_refused: cumulative=${String(cumulativeTokens)} window=${String(contextWindowTokens)} threshold=${String(safetyThreshold)}`,
    );
    this.name = 'KagentContextWindowRefusedError';
    this.cumulativeTokens = cumulativeTokens;
    this.contextWindowTokens = contextWindowTokens;
    this.safetyThreshold = safetyThreshold;
  }
}

/**
 * Construction inputs. All optional with sensible defaults so the
 * middleware can be built from a bare `process.env` if desired.
 *
 * Production path (in a kagent pod): the runner's wireup parses
 * `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` + `KAGENT_CONTEXT_SAFETY_THRESHOLD`
 * once, calls `buildKagentContextSafetyMiddleware` with the resolved
 * numbers, and hands the resulting middleware to `wrapLanguageModel`.
 *
 * Test path: opts are passed directly so the middleware can be
 * exercised without env state.
 */
export interface KagentContextSafetyOpts {
  /** Model's declared context-window. Undefined = no-op (back-compat). */
  readonly contextWindowTokens?: number;
  /** Refusal threshold in `(0, 1]`. Defaults to 0.95 per §4.1. */
  readonly safetyThreshold?: number;
}

/**
 * Stateful middleware instance. The cumulative counters are private
 * fields; `currentCumulativeTokens()` exposes a read-only snapshot
 * for tests and the budget extractor.
 *
 * One instance per agent-task run. The middleware does not reset
 * itself between runs — the caller (typically `runVercelAiAgentTask`)
 * constructs a fresh instance per task.
 */
export class KagentContextSafetyMiddleware {
  readonly specificationVersion = 'v3' as const;

  private readonly contextWindowTokens: number | undefined;
  private readonly safetyThreshold: number;
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;

  constructor(opts: KagentContextSafetyOpts = {}) {
    this.contextWindowTokens = opts.contextWindowTokens;
    this.safetyThreshold = opts.safetyThreshold ?? 0.95;
    if (
      !Number.isFinite(this.safetyThreshold) ||
      this.safetyThreshold <= 0 ||
      this.safetyThreshold > 1
    ) {
      // Mirrors `executor.ts:651-660` — fail-FAST on misconfiguration
      // rather than silently degrading.
      throw new Error(
        `KagentContextSafetyMiddleware: safetyThreshold must be in (0, 1] (got ${String(this.safetyThreshold)})`,
      );
    }
  }

  /** Read-only snapshot for the budget extractor + tests. */
  currentCumulativeTokens(): { input: number; output: number; total: number } {
    return {
      input: this.cumulativeInputTokens,
      output: this.cumulativeOutputTokens,
      total: this.cumulativeInputTokens + this.cumulativeOutputTokens,
    };
  }

  /**
   * Pre-call check shared by `wrapGenerate` + `wrapStream`. Returns
   * void on success; throws `KagentContextWindowRefusedError` when
   * cumulative tokens have reached the threshold. Gated on
   * `contextWindowTokens !== undefined` so the back-compat path is a
   * no-op (matches `RunBudget.contextWindowTokens` semantics).
   */
  private assertBelowThreshold(): void {
    const window = this.contextWindowTokens;
    if (window === undefined) return;
    const used = this.cumulativeInputTokens + this.cumulativeOutputTokens;
    const limit = this.safetyThreshold * window;
    if (used >= limit) {
      throw new KagentContextWindowRefusedError(used, window, this.safetyThreshold);
    }
  }

  /** Update accounting after a successful call. */
  private recordUsage(input: number | undefined, output: number | undefined): void {
    if (typeof input === 'number' && Number.isFinite(input)) {
      this.cumulativeInputTokens += input;
    }
    if (typeof output === 'number' && Number.isFinite(output)) {
      this.cumulativeOutputTokens += output;
    }
  }

  /**
   * Vercel AI SDK middleware contract — `wrapGenerate`. Refuses
   * before forwarding when the threshold is reached.
   */
  wrapGenerate = async ({
    doGenerate,
  }: {
    doGenerate: () => PromiseLike<LanguageModelV3GenerateResult>;
    doStream: () => PromiseLike<LanguageModelV3StreamResult>;
    params: LanguageModelV3CallOptions;
    model: LanguageModelV3;
  }): Promise<LanguageModelV3GenerateResult> => {
    this.assertBelowThreshold();
    const result = await doGenerate();
    this.recordUsage(result.usage.inputTokens.total, result.usage.outputTokens.total);
    return result;
  };

  /**
   * Vercel AI SDK middleware contract — `wrapStream`. Refuses before
   * forwarding when the threshold is reached. Stream usage is
   * surfaced via the terminal `finish` chunk; we capture it via a
   * `TransformStream` so the cumulative counter stays in sync with
   * `wrapGenerate`'s post-call accounting.
   */
  wrapStream = async ({
    doStream,
  }: {
    doGenerate: () => PromiseLike<LanguageModelV3GenerateResult>;
    doStream: () => PromiseLike<LanguageModelV3StreamResult>;
    params: LanguageModelV3CallOptions;
    model: LanguageModelV3;
  }): Promise<LanguageModelV3StreamResult> => {
    this.assertBelowThreshold();
    const result = await doStream();
    // Wrap the stream to observe the terminal `finish` chunk's usage
    // without consuming the stream. `TransformStream` is the
    // documented pattern in the AI SDK middleware guide.
    //
    // Type-erasure note: the AI SDK's `LanguageModelV3StreamPart`
    // union is provider-specific; declaring the TransformStream
    // generic over it would couple us to that exact shape. We treat
    // the chunk as `unknown` inside the transformer, narrow with a
    // structural type guard for the `finish` variant, and cast the
    // resulting transformed stream back to the SDK's expected
    // `LanguageModelV3StreamResult.stream` type — the wire shape is
    // unchanged; only the local TS view widened.
    const recordUsage = this.recordUsage.bind(this);
    const transformed = result.stream.pipeThrough(
      new TransformStream<unknown, unknown>({
        transform(chunk, controller) {
          // Structural narrow — the `finish` variant carries `.usage`.
          // Any provider that omits usage on a finish chunk produces
          // undefined, which `recordUsage` tolerates.
          const c = chunk as {
            type?: string;
            usage?: {
              inputTokens?: { total?: number };
              outputTokens?: { total?: number };
            };
          };
          if (c?.type === 'finish' && c.usage) {
            recordUsage(c.usage.inputTokens?.total, c.usage.outputTokens?.total);
          }
          controller.enqueue(chunk);
        },
      }),
    ) as LanguageModelV3StreamResult['stream'];
    return { ...result, stream: transformed };
  };
}

/**
 * Helper-style alias. Returns a `LanguageModelV3Middleware` shape so
 * the caller can pass directly to `wrapLanguageModel({ middleware })`.
 * Exposed alongside the class export so integrators can pick whichever
 * shape is more natural — the class for direct usage when the cumulative
 * snapshot is needed (e.g. by the budget extractor), the helper for
 * one-shot wrapping where the snapshot is not.
 */
export function buildKagentContextSafetyMiddleware(opts: KagentContextSafetyOpts = {}): {
  readonly middleware: LanguageModelV3Middleware;
  readonly instance: KagentContextSafetyMiddleware;
} {
  const instance = new KagentContextSafetyMiddleware(opts);
  // The class IS structurally a LanguageModelV3Middleware; cast is
  // safe because `specificationVersion` + `wrapGenerate` + `wrapStream`
  // are the required surface.
  return { middleware: instance, instance };
}
