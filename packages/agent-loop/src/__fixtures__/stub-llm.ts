/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * In-memory `LLMClient` stubs for `AgentExecutor` and `LLMClient` unit tests.
 *
 * Factory fn (NOT class) — per-test customization is "spread the override"
 * not "subclass + super()". Matches Phase 2's factory-style fixture composition
 * (see `__fixtures__/agents.ts`).
 *
 * SC3-safe: no provider SDK names, no domain identifiers. Never re-exported
 * from the package barrel (Phase 2 D-21).
 */

import type {
  LLMClient,
  ChatRequest,
  ChatResult,
  ChatDelta,
  ChatMessage,
  ClientContext,
} from '../llm-client.js';

export interface StubLLMOptions {
  /** Pre-canned ChatResult sequence; one consumed per `chat()` call. */
  scriptedResponses?: ChatResult[];
  /**
   * Pre-canned sequence of `ChatResult` OR `Error` instances; one consumed per `chat()` call.
   *
   * When set, supersedes `scriptedResponses` — entries that are `Error` instances
   * cause `chat()` to throw the value (used to script 429-retry scenarios).
   * Entries that are `ChatResult` shapes return normally. The same call counter
   * advances across both kinds.
   */
  scriptedChat?: Array<ChatResult | Error>;
  /** Pre-canned delta arrays; one inner array consumed per `chatStream()` call. */
  scriptedDeltas?: ChatDelta[][];
  /** Override the default countTokens (default: chars/4 ceiling matching estimateTokens). */
  countTokens?: (input: string | ChatMessage[]) => number | Promise<number>;
  /** Mutated by the stub: every chat()/chatStream() request is appended for assertions. */
  recordedRequests?: ChatRequest[];
  /** When set, chat() throws this error to test the executor's failure path. */
  throwOnChat?: Error;
  /** Synthetic per-call delay in ms; default 0. */
  callDelayMs?: number;
}

/** Build an in-memory `LLMClient` that yields pre-canned responses. */
export function makeStubLLM(opts: StubLLMOptions = {}): LLMClient {
  let chatIdx = 0;
  let streamIdx = 0;

  const defaultCountTokens = (input: string | ChatMessage[]): number => {
    const text = typeof input === 'string' ? input : input.map((m) => m.content).join('\n');
    return Math.ceil(text.length / 4);
  };

  return {
    async chat(request: ChatRequest, ctx?: ClientContext): Promise<ChatResult> {
      opts.recordedRequests?.push(request);
      if (opts.callDelayMs) {
        await new Promise((r) => setTimeout(r, opts.callDelayMs));
      }
      if (ctx?.abortSignal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (opts.throwOnChat) {
        throw opts.throwOnChat;
      }
      // `scriptedChat` (mixed ChatResult | Error) takes priority over the
      // ChatResult-only `scriptedResponses` so retry tests can script
      // "Throw 429, Throw 429, Return success" without a second stub.
      if (opts.scriptedChat && opts.scriptedChat.length > 0) {
        const next = opts.scriptedChat[chatIdx++];
        if (next instanceof Error) throw next;
        return next ?? { content: '' };
      }
      const next = opts.scriptedResponses?.[chatIdx++];
      return next ?? { content: '' };
    },

    chatStream(request: ChatRequest, ctx?: ClientContext): AsyncIterable<ChatDelta> {
      opts.recordedRequests?.push(request);
      const deltas = opts.scriptedDeltas?.[streamIdx++] ?? [];
      return makeDeltaStream(deltas, ctx?.abortSignal);
    },

    countTokens: opts.countTokens ?? defaultCountTokens,
  };
}

/**
 * Async-generator helper for synthesizing AsyncIterable<ChatDelta> in tests.
 * Honors abort cooperatively — required for D-13 cancellation tests.
 */
function makeDeltaStream(
  deltas: readonly ChatDelta[],
  signal?: AbortSignal,
): AsyncIterable<ChatDelta> {
  return (async function* () {
    for (const delta of deltas) {
      if (signal?.aborted) {
        const reason: unknown = signal.reason;
        if (reason instanceof Error) throw reason;
        throw new DOMException('Aborted', 'AbortError');
      }
      await Promise.resolve();
      yield delta;
    }
  })();
}
