/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * INT-01 — SSE parser unit tests (highest-risk piece per PATTERNS Density Heat Map).
 * Coverage target: 100% line + ≥95% branch (VALIDATION §Coverage Targets).
 *
 * 6 describe blocks cover VALIDATION rows 10-13 + 19 + protocol-error guard.
 */

import { describe, it, expect } from 'vitest';
import { parseSSEStream, type ToolCallDelta } from './sse-parser.js';
import { LLMClientProtocolError } from '@kagent/agent-loop';
import type { ChatDelta } from '@kagent/agent-loop';
import {
  EXO_CONTENT_STREAM,
  EXO_CONTENT_STREAM_CRLF,
  EXO_CONTENT_STREAM_CR,
  VLLM_SEPARATE_USAGE_STREAM,
  PARALLEL_TOOL_CALL_STREAM,
  ABORT_MIDSTREAM_STREAM,
  MALFORMED_JSON_STREAM,
} from './__fixtures__/sse-streams.js';

/** Helper: turn a string body into a ReadableStream<Uint8Array> with optional chunk-boundary splits. */
function streamFromString(body: string, boundaries?: number[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(body);
  const splits = boundaries ?? [fullBytes.length];
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      let prev = 0;
      for (const b of splits) {
        ctrl.enqueue(fullBytes.slice(prev, b));
        prev = b;
      }
      if (prev < fullBytes.length) ctrl.enqueue(fullBytes.slice(prev));
      ctrl.close();
    },
  });
}

/** Helper: collect all deltas from the parser into an array. */
async function collectDeltas(
  body: string,
  signal?: AbortSignal,
  boundaries?: number[],
): Promise<ChatDelta[]> {
  const stream = streamFromString(body, boundaries);
  const sig = signal ?? new AbortController().signal;
  const result: ChatDelta[] = [];
  for await (const delta of parseSSEStream(stream, sig)) {
    result.push(delta);
  }
  return result;
}

describe('parseSSEStream — core path (VALIDATION row 10)', () => {
  it('VALIDATION.10: EXO_CONTENT_STREAM yields 3 content deltas + terminal usage/stopReason delta', async () => {
    const deltas = await collectDeltas(EXO_CONTENT_STREAM);
    // First three carry content
    expect(deltas[0]?.content).toBe('The');
    expect(deltas[1]?.content).toBe(' capital');
    expect(deltas[2]?.content).toBe(' is Paris.');
    // Either delta[2] or delta[3] carries stopReason (depending on whether
    // it's emitted with the content delta or as a fabricated terminal)
    const hasStop = deltas.some((d) => d.stopReason === 'end_turn');
    const hasUsage = deltas.some((d) => d.usage?.inputTokens === 12 && d.usage.outputTokens === 5);
    expect(hasStop).toBe(true);
    expect(hasUsage).toBe(true);
  });

  it('VALIDATION.10: every yielded delta uses only D-10 schema fields', async () => {
    const deltas = await collectDeltas(EXO_CONTENT_STREAM);
    const allowedKeys = new Set(['content', 'tool_calls', 'usage', 'stopReason']);
    for (const d of deltas) {
      for (const k of Object.keys(d)) {
        expect(allowedKeys.has(k)).toBe(true);
      }
    }
  });

  it('VALIDATION.10: no delta emitted for the [DONE] sentinel', async () => {
    // [DONE] terminates the stream; the parser must not yield a literal
    // delta containing the string '[DONE]' anywhere
    const deltas = await collectDeltas(EXO_CONTENT_STREAM);
    for (const d of deltas) {
      expect(JSON.stringify(d)).not.toContain('[DONE]');
    }
  });

  it('skips lines that do not start with "data:" (e.g., :keepalive)', async () => {
    const body =
      ':keepalive\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
      'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    expect(deltas[0]?.content).toBe('hi');
  });

  it('empty stream produces zero deltas', async () => {
    const deltas = await collectDeltas('');
    expect(deltas).toEqual([]);
  });

  it('empty data payload (data: with no JSON) is skipped', async () => {
    const body = 'data: \n\n' + 'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    expect(deltas).toEqual([]);
  });

  it('ignores delta with empty-string content (no delta yielded)', async () => {
    // A chunk whose delta.content is an empty string is neither helpful nor
    // the terminal — parser should skip it to keep consumer loops tight.
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n' +
      'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.content).toBe('x');
  });

  it('stream that ends without [DONE] still flushes pending terminal delta', async () => {
    // Truncated stream: usage was accumulated, but backend tore the connection
    // before [DONE]. Parser still emits the fabricated terminal delta.
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n';
    const deltas = await collectDeltas(body);
    // Content delta, then a separate terminal delta with usage
    expect(deltas.some((d) => d.content === 'hi')).toBe(true);
    expect(deltas.some((d) => d.usage?.inputTokens === 2 && d.usage.outputTokens === 1)).toBe(true);
  });

  it('branch coverage: falsy choices[0] (explicit null) is skipped', async () => {
    // Backends may emit a defensive-null choices[0]; parser must skip without throwing.
    const body =
      'data: {"choices":[null]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n' +
      'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.content).toBe('ok');
  });

  it('branch coverage: tool_call without function.arguments fragment (id+name only)', async () => {
    // First tool-call delta announces id+name; args_delta arrives in later
    // fragments. Exercises the `tc.function?.arguments !== undefined` false path.
    const body =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"t"}}]}}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    const fragments: ToolCallDelta[] = [];
    for (const d of deltas) {
      if (d.tool_calls) fragments.push(...(d.tool_calls as unknown as ToolCallDelta[]));
    }
    expect(fragments[0]?.id).toBe('c1');
    expect(fragments[0]?.name).toBe('t');
    expect(fragments[0]?.args_delta).toBeUndefined();
  });

  it('branch coverage: finish_reason maps to undefined (forward-compat unknown value)', async () => {
    // `mapFinishReason` returns undefined for unknown values — parser must
    // NOT assign delta.stopReason (exercises pendingStopReason !== undefined FALSE path).
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"z"},"finish_reason":"novel_unknown_reason"}]}\n\n' +
      'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    // Content delta present; no stopReason field anywhere
    expect(deltas.some((d) => d.content === 'z')).toBe(true);
    expect(deltas.every((d) => d.stopReason === undefined)).toBe(true);
  });

  it('branch coverage: finish_reason chunk arriving AFTER separate usage chunk (OpenAI single-chunk edge)', async () => {
    // Usage arrives first (empty-choices), then the content+finish_reason chunk.
    // Exercises the `pendingUsage !== undefined` TRUE path at line 187 —
    // delta.usage is populated inline alongside delta.stopReason.
    const body =
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"k"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    // The content delta should carry content + stopReason + usage all together
    const bundled = deltas.find((d) => d.content === 'k');
    expect(bundled?.stopReason).toBe('end_turn');
    expect(bundled?.usage?.inputTokens).toBe(7);
    expect(bundled?.usage?.outputTokens).toBe(4);
  });

  it('branch coverage: empty-choices usage chunk with missing prompt_tokens/completion_tokens returns undefined', async () => {
    // `mapStreamUsage` returns undefined when both token counts are absent —
    // pendingUsage stays undefined; terminal delta has neither usage nor stopReason.
    const body =
      'data: {"choices":[],"usage":{}}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"y"}}]}\n\n' +
      'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    expect(deltas.some((d) => d.content === 'y')).toBe(true);
    // No usage delta should have been fabricated (pendingUsage was undefined)
    expect(deltas.every((d) => d.usage === undefined)).toBe(true);
  });

  it('branch coverage: empty-choices usage with ONLY prompt_tokens (no completion_tokens)', async () => {
    // Exercises mapStreamUsage completion_tokens typeof check = false path.
    const body =
      'data: {"choices":[],"usage":{"prompt_tokens":5}}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    const withUsage = deltas.find((d) => d.usage?.inputTokens === 5);
    expect(withUsage).toBeDefined();
    expect(withUsage?.usage?.outputTokens).toBeUndefined();
  });

  it('branch coverage: truncated stream with pending stopReason but no usage (fabricates stopReason-only terminal)', async () => {
    // Stream ends (done: true) without [DONE]; pendingStopReason populated,
    // pendingUsage undefined — `buildTerminalDelta` exercises the `stopReason
    // !== undefined` TRUE path with usage FALSE path.
    const body = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    const deltas = await collectDeltas(body);
    // Just the fabricated terminal delta — stopReason only, no usage, no content
    expect(deltas.some((d) => d.stopReason === 'end_turn' && d.usage === undefined)).toBe(true);
  });

  it('branch coverage: terminal delta with usage but no stopReason (buildTerminalDelta stopReason=undefined path)', async () => {
    // Pre-[DONE] usage chunk arrives, but the last content chunk had an UNKNOWN
    // finish_reason that `mapFinishReason` returns undefined for. pendingUsage
    // set; pendingStopReason undefined — terminal fabrication exercises the
    // `stopReason !== undefined` FALSE branch in `buildTerminalDelta`.
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"q"},"finish_reason":"novel_reason"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
      'data: [DONE]\n\n';
    const deltas = await collectDeltas(body);
    // Terminal delta carries usage only; no stopReason anywhere
    const terminal = deltas.find((d) => d.usage?.inputTokens === 1 && d.usage.outputTokens === 1);
    expect(terminal).toBeDefined();
    expect(terminal?.stopReason).toBeUndefined();
  });
});

describe('parseSSEStream — chunk boundary invariance (VALIDATION row 11 / Pitfall 3)', () => {
  it('VALIDATION.11: split at byte offsets 50/100/150/200/250 yields identical deltas', async () => {
    const reference = await collectDeltas(EXO_CONTENT_STREAM);
    const refStr = JSON.stringify(reference);
    const totalBytes = new TextEncoder().encode(EXO_CONTENT_STREAM).length;

    let exercisedSplits = 0;
    for (const splitPoint of [50, 100, 150, 200, 250]) {
      // Skip if split exceeds body length
      if (splitPoint >= totalBytes) continue;
      const split = await collectDeltas(EXO_CONTENT_STREAM, undefined, [
        splitPoint,
        Math.min(splitPoint * 2, totalBytes),
      ]);
      expect(JSON.stringify(split)).toBe(refStr);
      exercisedSplits += 1;
    }
    // Must actually exercise ≥5 split points (EXO_CONTENT_STREAM is ~800 bytes)
    expect(exercisedSplits).toBeGreaterThanOrEqual(5);
  });

  it('chunk boundaries inside a JSON payload do not corrupt parse', async () => {
    // Find a byte offset that splits a `data: {...}` line mid-payload
    const dataLineStart = EXO_CONTENT_STREAM.indexOf('data: {');
    expect(dataLineStart).toBeGreaterThanOrEqual(0);
    const splitInside = dataLineStart + 30; // mid-JSON
    const reference = await collectDeltas(EXO_CONTENT_STREAM);
    const split = await collectDeltas(EXO_CONTENT_STREAM, undefined, [splitInside]);
    expect(JSON.stringify(split)).toBe(JSON.stringify(reference));
  });

  it('byte-level single-byte splits yield identical deltas (extreme stress)', async () => {
    // Split every byte — the buffer must accumulate fragments correctly even
    // under pathologically-small chunk sizes (one char per chunk).
    const reference = await collectDeltas(EXO_CONTENT_STREAM);
    const totalBytes = new TextEncoder().encode(EXO_CONTENT_STREAM).length;
    // Build boundary array [1, 2, 3, ..., totalBytes]
    const boundaries: number[] = [];
    for (let i = 1; i < totalBytes; i += 1) boundaries.push(i);
    const split = await collectDeltas(EXO_CONTENT_STREAM, undefined, boundaries);
    expect(JSON.stringify(split)).toBe(JSON.stringify(reference));
  });
});

describe('parseSSEStream — vllm separate usage chunk (VALIDATION row 12 / Pitfall 2)', () => {
  it('VALIDATION.12: usage chunk after finish_reason merged into fabricated terminal delta', async () => {
    const deltas = await collectDeltas(VLLM_SEPARATE_USAGE_STREAM);
    // Must see content "hi", a stopReason 'end_turn', and usage {inputTokens:3, outputTokens:1}
    expect(deltas.some((d) => d.content === 'hi')).toBe(true);
    expect(deltas.some((d) => d.stopReason === 'end_turn')).toBe(true);
    expect(deltas.some((d) => d.usage?.inputTokens === 3 && d.usage.outputTokens === 1)).toBe(true);
  });
});

describe('parseSSEStream — parallel tool_calls (VALIDATION row 13)', () => {
  it('VALIDATION.13: ToolCallDeltas keyed by index with args_delta fragments per D-10', async () => {
    const deltas = await collectDeltas(PARALLEL_TOOL_CALL_STREAM);
    // Collect all ToolCallDelta fragments (cast through unknown — Phase 3
    // ChatDelta.tool_calls is Array<Partial<ToolCall>>, D-10 narrows to
    // ToolCallDelta[] additively)
    const allFragments: ToolCallDelta[] = [];
    for (const d of deltas) {
      if (d.tool_calls) {
        allFragments.push(...(d.tool_calls as unknown as ToolCallDelta[]));
      }
    }
    // index 0: id+name first (call_a / get_time), then 2 args_delta fragments
    const index0 = allFragments.filter((f) => f.index === 0);
    expect(index0[0]?.id).toBe('call_a');
    expect(index0[0]?.name).toBe('get_time');
    // Concatenated args_delta should produce the full JSON `{"tz":"UTC"}`
    const concatenated0 = index0.map((f) => f.args_delta ?? '').join('');
    expect(concatenated0).toContain('"tz"');
    expect(concatenated0).toContain('"UTC"');
    // index 1: single fragment with id + name + complete args
    const index1 = allFragments.filter((f) => f.index === 1);
    expect(index1[0]?.id).toBe('call_b');
    expect(index1[0]?.name).toBe('get_date');
    expect(index1[0]?.args_delta).toBe('{}');
    // Final stopReason should be tool_use
    expect(deltas.some((d) => d.stopReason === 'tool_use')).toBe(true);
  });
});

describe('parseSSEStream — abort mid-stream (VALIDATION row 19 / Pitfall 4)', () => {
  it('VALIDATION.19: AbortSignal fired mid-iteration throws DOMException AbortError; reader released', async () => {
    const controller = new AbortController();
    const stream = streamFromString(ABORT_MIDSTREAM_STREAM);
    const iter = parseSSEStream(stream, controller.signal);

    // Consume one delta successfully
    const first = await iter.next();
    expect(first.done).toBe(false);

    // Abort and try to consume next
    controller.abort();
    let thrown: unknown;
    try {
      await iter.next();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
  });

  it('aborts honor signal.reason if it is an Error (read-reason-first)', async () => {
    const controller = new AbortController();
    const stream = streamFromString(ABORT_MIDSTREAM_STREAM);
    const iter = parseSSEStream(stream, controller.signal);

    await iter.next(); // consume first

    const customReason = new Error('custom abort reason');
    controller.abort(customReason);

    let thrown: unknown;
    try {
      await iter.next();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(customReason);
  });

  it('pre-aborted signal causes immediate throw on first iteration', async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = streamFromString(EXO_CONTENT_STREAM);
    const iter = parseSSEStream(stream, controller.signal);
    let thrown: unknown;
    try {
      await iter.next();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
  });

  it('pre-aborted signal with NON-Error reason falls through to fabricated DOMException', async () => {
    // Branch-coverage case: signal.reason is a string (not an Error instance).
    // The read-reason-first pattern only re-throws Error instances; everything
    // else becomes a fabricated `DOMException('Aborted', 'AbortError')`.
    const controller = new AbortController();
    controller.abort('string-reason-not-an-error');
    const stream = streamFromString(EXO_CONTENT_STREAM);
    const iter = parseSSEStream(stream, controller.signal);
    let thrown: unknown;
    try {
      await iter.next();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
  });

  it('mid-stream abort with NON-Error reason fabricates DOMException (inner-loop branch)', async () => {
    // Same branch coverage as above but for the INNER abort check (fires when
    // abort happens between yielded deltas while generator is paused).
    const controller = new AbortController();
    const stream = streamFromString(ABORT_MIDSTREAM_STREAM);
    const iter = parseSSEStream(stream, controller.signal);

    await iter.next(); // consume first successfully

    controller.abort(42); // numeric reason — not an Error

    let thrown: unknown;
    try {
      await iter.next();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
  });
});

describe('parseSSEStream — protocol errors', () => {
  it('malformed JSON in a data: line throws LLMClientProtocolError carrying the payload', async () => {
    let thrown: unknown;
    try {
      await collectDeltas(MALFORMED_JSON_STREAM);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMClientProtocolError);
    const proto = thrown as LLMClientProtocolError;
    expect(typeof proto.raw).toBe('string');
    expect((proto.raw as string).length).toBeGreaterThan(0);
    expect(proto.message).toContain('JSON');
  });
});

describe('parseSSEStream — CRLF event separator normalization (WR-03)', () => {
  it('WR-03: CRLF-separated events parse identically to LF-separated events', async () => {
    // Reference parse from the canonical LF-only fixture
    const reference = await collectDeltas(EXO_CONTENT_STREAM);
    const crlf = await collectDeltas(EXO_CONTENT_STREAM_CRLF);
    expect(JSON.stringify(crlf)).toBe(JSON.stringify(reference));
  });

  it('WR-03: CR-only separators (classic-Mac style) parse identically', async () => {
    // Rare but spec-legal per HTML5 SSE event-stream grammar.
    const reference = await collectDeltas(EXO_CONTENT_STREAM);
    const cr = await collectDeltas(EXO_CONTENT_STREAM_CR);
    expect(JSON.stringify(cr)).toBe(JSON.stringify(reference));
  });

  it('WR-03: CRLF stream split BETWEEN \\r and \\n on chunk boundary parses identically', async () => {
    // Regression case for pendingCR buffering: chunk N ends with `\r`,
    // chunk N+1 starts with `\n`. Without pendingCR carry-over the `\r`
    // would be normalized to `\n` in pass 1, then `\n` from chunk N+1
    // would be left alone, yielding `\n\n` accidentally in the right place
    // by coincidence. Construct a case where the boundary lands INSIDE a
    // `\r\n` pair and the separator is `\r\n\r\n` so miscounting corrupts
    // the event boundary.
    const totalBytes = new TextEncoder().encode(EXO_CONTENT_STREAM_CRLF).length;
    // Find the first `\r\n\r\n` sequence and split between its first CR and LF
    const firstSep = EXO_CONTENT_STREAM_CRLF.indexOf('\r\n\r\n');
    expect(firstSep).toBeGreaterThan(0);
    // Split point lands just after the first `\r`: buffer ends with `\r`,
    // next chunk starts with `\n\r\n`.
    const boundary = firstSep + 1;
    expect(boundary).toBeLessThan(totalBytes);

    const reference = await collectDeltas(EXO_CONTENT_STREAM);
    const split = await collectDeltas(EXO_CONTENT_STREAM_CRLF, undefined, [boundary]);
    expect(JSON.stringify(split)).toBe(JSON.stringify(reference));
  });

  it('WR-03: CRLF stream with single-byte chunk splits parses identically (stress)', async () => {
    // Byte-level splits on the CRLF fixture: ensures pendingCR buffering
    // survives pathologically-small chunk sizes where EVERY `\r`/`\n` is
    // delivered in its own chunk.
    const reference = await collectDeltas(EXO_CONTENT_STREAM);
    const totalBytes = new TextEncoder().encode(EXO_CONTENT_STREAM_CRLF).length;
    const boundaries: number[] = [];
    for (let i = 1; i < totalBytes; i += 1) boundaries.push(i);
    const split = await collectDeltas(EXO_CONTENT_STREAM_CRLF, undefined, boundaries);
    expect(JSON.stringify(split)).toBe(JSON.stringify(reference));
  });
});
