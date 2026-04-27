/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Canonical SSE transcripts for sse-parser unit tests + chunk-boundary stress tests.
 *
 * SC3-safe: synthetic IDs (no real OpenAI request ids); generic model names.
 * Consumed only by `*.test.ts` siblings — never re-exported from the
 * package barrel (Phase 2 D-21).
 *
 * Per CONTEXT D-11: usage + stopReason ride the terminal delta. The Exo / OpenAI
 * pattern is "empty-choices final chunk carries usage" — sse-parser fabricates
 * the terminal delta from that.
 *
 * Per RESEARCH §Pitfall 2: vLLM emits usage in a SEPARATE chunk after
 * finish_reason. The parser handles both shapes via pendingUsage accumulation.
 */

// Exo / OpenAI happy path: 3 content deltas, then empty-choices usage chunk, then [DONE]
export const EXO_CONTENT_STREAM =
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"The"},"finish_reason":null}]}\n\n' +
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" capital"},"finish_reason":null}]}\n\n' +
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" is Paris."},"finish_reason":"stop"}]}\n\n' +
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n' +
  'data: [DONE]\n\n';

// vLLM-shape: usage in a SEPARATE chunk after finish_reason (Pitfall 2)
export const VLLM_SEPARATE_USAGE_STREAM =
  'data: {"id":"test-2","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
  'data: {"id":"test-2","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n' +
  'data: [DONE]\n\n';

// Parallel tool_calls fragments keyed by index (assistant calls 2 tools at once)
// Each call's args arrive across multiple chunks; caller merges via index.
export const PARALLEL_TOOL_CALL_STREAM =
  'data: {"id":"test-3","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_time","arguments":""}}]},"finish_reason":null}]}\n\n' +
  'data: {"id":"test-3","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"tz\\":"}}]},"finish_reason":null}]}\n\n' +
  'data: {"id":"test-3","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"UTC\\"}"}}]},"finish_reason":null}]}\n\n' +
  'data: {"id":"test-3","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"get_date","arguments":"{}"}}]},"finish_reason":null}]}\n\n' +
  'data: {"id":"test-3","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
  'data: [DONE]\n\n';

// Truncated stream — caller aborts mid-way; no [DONE] terminator
export const ABORT_MIDSTREAM_STREAM =
  'data: {"id":"test-4","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
  'data: {"id":"test-4","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" wo"},"finish_reason":null}]}\n\n';

// Malformed JSON in a data: line — parser must throw LLMClientProtocolError
export const MALFORMED_JSON_STREAM =
  'data: {"id":"test-5","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}\n\n' +
  'data: [DONE]\n\n';

// WR-03: CRLF-separated events, as emitted by LiteLLM-behind-nginx and
// some Azure OpenAI deployments. HTML5 SSE spec §event-stream accepts
// `\r\n\r\n` as an event terminator; parser must normalize and parse
// these identically to the LF-only variants above.
export const EXO_CONTENT_STREAM_CRLF =
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"The"},"finish_reason":null}]}\r\n\r\n' +
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" capital"},"finish_reason":null}]}\r\n\r\n' +
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" is Paris."},"finish_reason":"stop"}]}\r\n\r\n' +
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\r\n\r\n' +
  'data: [DONE]\r\n\r\n';

// WR-03: CR-only separators (`\r\r`) — rare but spec-legal (old-Mac-style).
// Same content as EXO_CONTENT_STREAM; used to assert the second replace()
// branch in the CRLF-normalization path.
export const EXO_CONTENT_STREAM_CR =
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"The"},"finish_reason":null}]}\r\r' +
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" capital"},"finish_reason":null}]}\r\r' +
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" is Paris."},"finish_reason":"stop"}]}\r\r' +
  'data: {"id":"test-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\r\r' +
  'data: [DONE]\r\r';
