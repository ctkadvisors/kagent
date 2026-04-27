/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Canonical non-stream JSON response fixtures for client + response-mapper tests.
 *
 * SC3-safe: synthetic ids; no real OpenAI request ids.
 * Consumed only by `*.test.ts` siblings — never re-exported from the
 * package barrel (Phase 2 D-21).
 */

export const COMPLETED_RESPONSE = {
  id: 'test-resp-1',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Paris.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
};

export const TOOL_CALL_RESPONSE = {
  id: 'test-resp-2',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_x',
            type: 'function',
            function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
};

export const RATE_LIMITED_RESPONSE = {
  error: {
    message: 'Rate limit reached',
    type: 'rate_limit_error',
    code: 'rate_limit_exceeded',
  },
};

export const CONTEXT_OVERFLOW_RESPONSE = {
  error: {
    message: 'This model has a context length limit of 4096 tokens',
    type: 'invalid_request_error',
    code: 'context_length_exceeded',
  },
};

// Missing `choices` key — protocol error
export const MALFORMED_RESPONSE = {
  id: 'test-resp-3',
  object: 'chat.completion',
};
