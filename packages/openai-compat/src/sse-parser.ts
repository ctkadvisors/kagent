/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Hand-rolled SSE parser for OpenAI Chat Completions streaming protocol (D-10 + D-13).
 *
 * Async generator: consumes `ReadableStream<Uint8Array>` (the body of an SSE
 * fetch response in Node 22), yields `ChatDelta` per the minimal D-10 schema.
 *
 * Wire details (CITED: https://platform.openai.com/docs/api-reference/chat/streaming):
 * - Events terminated by `\n\n`, `\r\n\r\n`, or `\r\r` per HTML5 SSE spec
 *   (https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)
 *   OpenAI and Exo emit LF-only, but LiteLLM-behind-nginx and some Azure
 *   deployments can emit CRLF separators — we normalize all CR[LF?] to LF
 *   before splitting so one `\n\n` path handles every variant (WR-03).
 * - Each event is one or more lines; only `data: ...` lines carry payload
 * - `data: [DONE]` is the terminator sentinel — emit no delta for it
 * - With `stream_options.include_usage: true`, the FINAL chunk before `[DONE]`
 *   carries `choices: []` (empty) + populated `usage` (Pitfall 1)
 * - vLLM may emit usage in a SEPARATE chunk AFTER finish_reason (Pitfall 2)
 *
 * **Abort handling (D-15):**
 * - Pre-iteration check: signal.aborted → DOMException(AbortError) (caller
 *   re-throws as LLMClientAbortError at the chatStream() boundary)
 * - Pitfall 4: try/finally guarantees reader.cancel() on every exit path
 *
 * **Chunk-boundary safety (Pitfall 3):**
 * - Internal `buffer` accumulates incomplete events
 * - Splits on `\n\n` after CRLF→LF normalization; partial events at
 *   end-of-chunk wait for next chunk. A trailing `\r` at the end of a chunk
 *   is preserved in the buffer so the next chunk's leading `\n` can pair
 *   with it on the next pass (avoiding split-mid-CRLF corruption).
 *
 * **Verbatim port of stub-llm.ts:88-92 read-reason-first abort pattern.**
 */

import type { ChatDelta, ChatResult } from '@kagent/agent-loop';
import { LLMClientProtocolError } from '@kagent/agent-loop';
import { mapFinishReason } from './stop-reason-map.js';

/**
 * Tool-call streaming delta (D-10).
 *
 * Caller (executor or test) merges fragments by `index` to assemble the
 * complete ToolCall: `id` and `name` arrive on the first delta for an
 * index; `args_delta` arrives across N deltas and concatenates to the
 * complete JSON-string the caller then `JSON.parse`s into `ToolCall.args`.
 */
export interface ToolCallDelta {
  /** Which tool call (parallel call disambiguation). */
  index: number;
  /** Present on first delta for that index. */
  id?: string;
  /** Present on first delta for that index. */
  name?: string;
  /** JSON-string fragment; caller concatenates across deltas, then JSON.parses. */
  args_delta?: string;
}

/** Internal: OpenAI SSE chunk shape — defensively narrowed inside the parser. */
interface OpenAIStreamChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * Parse an SSE response body into a stream of `ChatDelta`s.
 *
 * Yields content deltas, tool_call deltas, and (per D-11) a fabricated
 * terminal delta carrying usage + stopReason when the stream ends.
 *
 * Throws:
 * - `LLMClientProtocolError` on malformed JSON in a `data:` line
 * - `DOMException('Aborted', 'AbortError')` on AbortSignal — caller
 *   re-throws as `LLMClientAbortError` at the chatStream() boundary
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ChatDelta, void, void> {
  const reader = body.pipeThrough(new TextDecoderStream('utf-8')).getReader();

  let buffer = '';
  // WR-03: Holds a trailing `\r` from the previous chunk when a chunk boundary
  // falls between CR and LF. We prepend it to the next chunk BEFORE CRLF
  // normalization so a `\r\n` pair never gets split across two passes.
  let pendingCR = false;
  let pendingUsage: ChatResult['usage'] | undefined;
  let pendingStopReason: ChatResult['stopReason'] | undefined;

  try {
    while (true) {
      // Pre-read abort check — read-reason-first pattern (stub-llm.ts:88-92)
      if (signal.aborted) {
        const reason: unknown = signal.reason;
        if (reason instanceof Error) throw reason;
        throw new DOMException('Aborted', 'AbortError');
      }

      const { done, value } = await reader.read();
      if (done) {
        // Stream ended without [DONE] — flush any pending terminal delta
        if (pendingUsage !== undefined || pendingStopReason !== undefined) {
          yield buildTerminalDelta(pendingUsage, pendingStopReason);
        }
        return;
      }
      // WR-03: Normalize CRLF/CR line endings to LF BEFORE appending to the
      // buffer. HTML5 SSE spec allows `\n\n`, `\r\n\r\n`, or `\r\r` event
      // terminators; OpenAI/Exo emit LF-only but LiteLLM-behind-nginx and
      // some Azure deployments can emit CRLF. If the previous chunk ended in
      // a bare `\r` we carry it over here via `pendingCR` so a chunk boundary
      // landing between CR and LF cannot split a `\r\n` pair across two
      // normalization passes. Post-normalization the buffer contains only LF.
      let incoming = pendingCR ? '\r' + value : value;
      pendingCR = false;
      if (incoming.endsWith('\r')) {
        incoming = incoming.slice(0, -1);
        pendingCR = true;
      }
      buffer += incoming.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      // Events are terminated by `\n\n` (after CRLF normalization above).
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        // Pre-event abort check — matches stub-llm.ts:88-92 pattern.
        // Outer abort check catches pre-read aborts; this catches aborts
        // fired between yielded deltas (consumer's abort happens while the
        // generator is paused mid-inner-loop) before we emit the next delta.
        if (signal.aborted) {
          const reason: unknown = signal.reason;
          if (reason instanceof Error) throw reason;
          throw new DOMException('Aborted', 'AbortError');
        }
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (payload === '') continue;
        if (payload === '[DONE]') {
          // Terminal sentinel: emit fabricated delta if we have pending data
          if (pendingUsage !== undefined || pendingStopReason !== undefined) {
            yield buildTerminalDelta(pendingUsage, pendingStopReason);
          }
          return;
        }

        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIStreamChunk;
        } catch (err) {
          throw new LLMClientProtocolError(
            `SSE event is not valid JSON: ${(err as Error).message}`,
            payload,
          );
        }

        // Pitfall 1: empty-choices + populated-usage chunk = include_usage marker
        if ((!chunk.choices || chunk.choices.length === 0) && chunk.usage) {
          pendingUsage = mapStreamUsage(chunk.usage);
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta: ChatDelta = {};

        if (choice.delta?.content !== undefined && choice.delta.content !== '') {
          delta.content = choice.delta.content;
        }

        if (choice.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
          const toolCalls: ToolCallDelta[] = choice.delta.tool_calls.map((tc) => {
            const out: ToolCallDelta = { index: tc.index };
            if (tc.id !== undefined) out.id = tc.id;
            if (tc.function?.name !== undefined) out.name = tc.function.name;
            if (tc.function?.arguments !== undefined) out.args_delta = tc.function.arguments;
            return out;
          });
          // ChatDelta.tool_calls is typed `Array<Partial<ToolCall>>` in Phase 3; all
          // fields are optional, so a `ToolCallDelta[]` (extra `index` + `args_delta`
          // fields) is structurally assignable per TS excess-property rules at
          // non-literal sites. Per D-10's additive narrowing, this is intentional —
          // consumers that still type against `Partial<ToolCall>` continue to work.
          delta.tool_calls = toolCalls;
        }

        if (choice.finish_reason) {
          // Pitfall 2 (vLLM separate-usage): accumulate stopReason; merge with
          // pendingUsage at terminal. Also emit on this delta IF backend already
          // delivered usage (OpenAI single-chunk pattern).
          pendingStopReason = mapFinishReason(choice.finish_reason);
          if (pendingStopReason !== undefined) delta.stopReason = pendingStopReason;
          if (pendingUsage !== undefined) delta.usage = pendingUsage;
        }

        // Only yield non-empty deltas
        if (
          delta.content !== undefined ||
          delta.tool_calls !== undefined ||
          delta.stopReason !== undefined ||
          delta.usage !== undefined
        ) {
          yield delta;
        }
      }
    }
  } finally {
    // Pitfall 4: always release the reader, even on throw / early return
    try {
      await reader.cancel();
    } catch {
      // swallow — cancel after stream end is normal
    }
  }
}

/** Construct the fabricated terminal delta from accumulated usage + stopReason (D-11). */
function buildTerminalDelta(
  usage: ChatResult['usage'] | undefined,
  stopReason: ChatResult['stopReason'] | undefined,
): ChatDelta {
  const d: ChatDelta = {};
  if (usage !== undefined) d.usage = usage;
  if (stopReason !== undefined) d.stopReason = stopReason;
  return d;
}

/** Map streaming usage chunk fields (same shape as non-stream usage). */
function mapStreamUsage(raw: {
  prompt_tokens?: number;
  completion_tokens?: number;
}): ChatResult['usage'] {
  const out: NonNullable<ChatResult['usage']> = {};
  if (typeof raw.prompt_tokens === 'number') out.inputTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === 'number') out.outputTokens = raw.completion_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}
