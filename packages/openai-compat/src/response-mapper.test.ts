/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * INT-01 — response-mapper pure-fn tests (VALIDATION row 9 + 17).
 * Coverage target: 100% line + 100% branch.
 */

import { describe, it, expect } from 'vitest';
import { mapOpenAIResponseToChatResult, mapUsage } from './response-mapper.js';
import { LLMClientProtocolError } from '@kagent/agent-loop';
import {
  COMPLETED_RESPONSE,
  TOOL_CALL_RESPONSE,
  MALFORMED_RESPONSE,
} from './__fixtures__/responses.js';

describe('mapOpenAIResponseToChatResult (VALIDATION row 9)', () => {
  it('VALIDATION.9: COMPLETED_RESPONSE → content + usage + stopReason; NO costUsd', () => {
    const result = mapOpenAIResponseToChatResult(COMPLETED_RESPONSE);
    expect(result.content).toBe('Paris.');
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 1 });
    expect(result.usage?.costUsd).toBeUndefined();
    expect(result.stopReason).toBe('end_turn');
    expect(result.tool_calls).toBeUndefined();
  });

  it('VALIDATION.9: TOOL_CALL_RESPONSE → tool_calls with JSON-parsed args; stopReason tool_use', () => {
    const result = mapOpenAIResponseToChatResult(TOOL_CALL_RESPONSE);
    expect(result.content).toBe('');
    expect(result.tool_calls).toEqual([{ id: 'call_x', name: 'get_time', args: { tz: 'UTC' } }]);
    expect(result.stopReason).toBe('tool_use');
  });

  it('content === null normalizes to empty string', () => {
    const raw = {
      choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
    };
    const result = mapOpenAIResponseToChatResult(raw);
    expect(result.content).toBe('');
  });

  it('VALIDATION.17: missing choices array throws LLMClientProtocolError', () => {
    expect(() => mapOpenAIResponseToChatResult(MALFORMED_RESPONSE)).toThrow(LLMClientProtocolError);
  });

  it('VALIDATION.17: empty choices array throws LLMClientProtocolError', () => {
    expect(() => mapOpenAIResponseToChatResult({ choices: [] })).toThrow(LLMClientProtocolError);
  });

  it('VALIDATION.17: missing message throws LLMClientProtocolError', () => {
    expect(() => mapOpenAIResponseToChatResult({ choices: [{ finish_reason: 'stop' }] })).toThrow(
      LLMClientProtocolError,
    );
  });

  it('non-object input throws LLMClientProtocolError carrying raw', () => {
    expect(() => mapOpenAIResponseToChatResult(null)).toThrow(LLMClientProtocolError);
    expect(() => mapOpenAIResponseToChatResult('string body')).toThrow(LLMClientProtocolError);
    try {
      mapOpenAIResponseToChatResult(null);
    } catch (err) {
      expect((err as LLMClientProtocolError).raw).toBeNull();
    }
  });

  it('missing usage produces usage: undefined (NOT {})', () => {
    const raw = {
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    };
    const result = mapOpenAIResponseToChatResult(raw);
    expect(result.usage).toBeUndefined();
  });

  it('null finish_reason yields stopReason undefined', () => {
    const raw = {
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: null }],
    };
    const result = mapOpenAIResponseToChatResult(raw);
    expect(result.stopReason).toBeUndefined();
  });

  describe('reasoning-field fallback (Nemotron / Qwen-QwQ / DeepSeek-R1)', () => {
    it('empty content + reasoning present + no tool_calls → reasoning surfaces as content', () => {
      const raw = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning: 'Let me think… the answer is blue.',
            },
            finish_reason: 'length',
          },
        ],
      };
      const result = mapOpenAIResponseToChatResult(raw);
      expect(result.content).toBe('Let me think… the answer is blue.');
      expect(result.stopReason).toBe('max_tokens');
    });

    it('null content + reasoning present → reasoning surfaces as content', () => {
      const raw = {
        choices: [
          {
            message: { role: 'assistant', content: null, reasoning: 'CoT output' },
            finish_reason: 'stop',
          },
        ],
      };
      expect(mapOpenAIResponseToChatResult(raw).content).toBe('CoT output');
    });

    it('non-empty content wins over reasoning (content is authoritative)', () => {
      const raw = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'final answer',
              reasoning: 'CoT scratchpad',
            },
            finish_reason: 'stop',
          },
        ],
      };
      expect(mapOpenAIResponseToChatResult(raw).content).toBe('final answer');
    });

    it('empty content + tool_calls present → does NOT fall back to reasoning (preserves wire-format)', () => {
      const raw = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning: 'should not leak into content',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      const result = mapOpenAIResponseToChatResult(raw);
      expect(result.content).toBe('');
      expect(result.tool_calls).toHaveLength(1);
    });

    it('empty content + empty reasoning stays empty', () => {
      const raw = {
        choices: [
          { message: { role: 'assistant', content: '', reasoning: '' }, finish_reason: 'stop' },
        ],
      };
      expect(mapOpenAIResponseToChatResult(raw).content).toBe('');
    });

    it('empty content + null reasoning stays empty', () => {
      const raw = {
        choices: [
          {
            message: { role: 'assistant', content: '', reasoning: null },
            finish_reason: 'stop',
          },
        ],
      };
      expect(mapOpenAIResponseToChatResult(raw).content).toBe('');
    });

    it('empty content + non-string reasoning ignored (type-safety)', () => {
      const raw = {
        choices: [
          {
            message: { role: 'assistant', content: '', reasoning: 12345 },
            finish_reason: 'stop',
          },
        ],
      };
      expect(mapOpenAIResponseToChatResult(raw).content).toBe('');
    });
  });
});

describe('mapUsage (VALIDATION row 9)', () => {
  it('VALIDATION.9: prompt_tokens → inputTokens', () => {
    expect(mapUsage({ prompt_tokens: 50 })).toEqual({ inputTokens: 50 });
  });

  it('VALIDATION.9: completion_tokens → outputTokens', () => {
    expect(mapUsage({ completion_tokens: 25 })).toEqual({ outputTokens: 25 });
  });

  it('VALIDATION.9: both fields populated', () => {
    expect(mapUsage({ prompt_tokens: 50, completion_tokens: 25 })).toEqual({
      inputTokens: 50,
      outputTokens: 25,
    });
  });

  it('VALIDATION.9: costUsd undefined when raw omits cost_usd (plain Exo / Ollama / vLLM)', () => {
    const u = mapUsage({ prompt_tokens: 50, completion_tokens: 25 });
    expect(u?.costUsd).toBeUndefined();
  });

  it('Plan 07-04: cost_usd → costUsd when raw includes it (LiteLLM extension + mock fixture)', () => {
    expect(mapUsage({ prompt_tokens: 50, completion_tokens: 25, cost_usd: 0.0001 })).toEqual({
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 0.0001,
    });
  });

  it('Plan 07-04: cost_usd alone (no token counts) still surfaces costUsd', () => {
    expect(mapUsage({ cost_usd: 0.5 })).toEqual({ costUsd: 0.5 });
  });

  it('Plan 07-04: non-numeric cost_usd ignored', () => {
    expect(
      mapUsage({
        prompt_tokens: 50,
        cost_usd: 'free' as unknown as number,
      }),
    ).toEqual({ inputTokens: 50 });
  });

  it('undefined input returns undefined', () => {
    expect(mapUsage(undefined)).toBeUndefined();
  });

  it('input with no recognized fields returns undefined', () => {
    expect(mapUsage({})).toBeUndefined();
  });

  it('non-numeric prompt_tokens ignored', () => {
    expect(mapUsage({ prompt_tokens: 'fifty' as unknown as number })).toBeUndefined();
  });
});
