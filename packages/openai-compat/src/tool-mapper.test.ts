/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * INT-01 — tool-mapper pure-fn tests (VALIDATION row 7).
 * Coverage target: 100% line + 100% branch.
 */

import { describe, it, expect } from 'vitest';
import { toOpenAITools, toOpenAIToolCalls, fromOpenAIToolCalls } from './tool-mapper.js';
import { LLMClientProtocolError } from '@kagent/agent-loop';
import type { ToolDescriptor, ToolCall } from '@kagent/agent-loop';

const sampleDescriptor: ToolDescriptor = {
  name: 'get_weather',
  description: 'Returns the current weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

describe('toOpenAITools (VALIDATION row 7)', () => {
  it('VALIDATION.7: ToolDescriptor → OpenAI tool envelope', () => {
    const result = toOpenAITools([sampleDescriptor]);
    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Returns the current weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ]);
  });

  it('VALIDATION.7: inputSchema → parameters (key rename per D-12)', () => {
    const result = toOpenAITools([sampleDescriptor]);
    expect(result?.[0]?.function).toHaveProperty('parameters');
    expect(result?.[0]?.function).not.toHaveProperty('inputSchema');
  });

  it('every result envelope has type === "function"', () => {
    const result = toOpenAITools([sampleDescriptor, { ...sampleDescriptor, name: 'other' }]);
    for (const tool of result ?? []) {
      expect(tool.type).toBe('function');
    }
  });

  it('undefined input returns undefined (NOT [])', () => {
    expect(toOpenAITools(undefined)).toBeUndefined();
  });

  it('empty array returns undefined (NOT empty array)', () => {
    expect(toOpenAITools([])).toBeUndefined();
  });
});

describe('fromOpenAIToolCalls (VALIDATION row 7)', () => {
  it('VALIDATION.7: function.arguments JSON.parsed into ToolCall.args', () => {
    const raw = [
      {
        id: 'call_abc',
        type: 'function' as const,
        function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result).toEqual([{ id: 'call_abc', name: 'get_time', args: { tz: 'UTC' } }]);
  });

  it('VALIDATION.7: id + name preserved', () => {
    const raw = [
      {
        id: 'call_xyz',
        type: 'function' as const,
        function: { name: 'compute', arguments: '{}' },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result?.[0]?.id).toBe('call_xyz');
    expect(result?.[0]?.name).toBe('compute');
  });

  it('JSON.parse failure on arguments throws LLMClientProtocolError carrying raw', () => {
    const raw = [
      {
        id: 'call_bad',
        type: 'function' as const,
        function: { name: 'broken', arguments: '{not_valid_json' },
      },
    ];
    expect(() => fromOpenAIToolCalls(raw)).toThrow(LLMClientProtocolError);
    try {
      fromOpenAIToolCalls(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(LLMClientProtocolError);
      expect((err as LLMClientProtocolError).raw).toBe('{not_valid_json');
      expect((err as LLMClientProtocolError).message).toContain('call_bad');
      expect((err as LLMClientProtocolError).message).toContain('broken');
    }
  });

  it('undefined input returns undefined', () => {
    expect(fromOpenAIToolCalls(undefined)).toBeUndefined();
  });

  it('empty array returns undefined', () => {
    expect(fromOpenAIToolCalls([])).toBeUndefined();
  });

  it('strips a leaked </tool_call> closing tag from function.name (Qwen3/vLLM)', () => {
    const raw = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'browser.goto\n</tool_call>', arguments: '{}' },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result?.[0]?.name).toBe('browser.goto');
  });

  it('strips a dangling "=" left before the leaked closing tag', () => {
    const raw = [
      {
        id: 'call_2',
        type: 'function' as const,
        function: { name: 'browser.start_session=\n</tool_call>', arguments: '{}' },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result?.[0]?.name).toBe('browser.start_session');
  });

  it('strips a leaked Qwen parameter tag from function.name', () => {
    const raw = [
      {
        id: 'call_4',
        type: 'function' as const,
        function: {
          name: 'spawn_child_task\n<parameter=agentName',
          arguments:
            '{"agentName":"homelab-builder","originalUserMessage":"SSH into jetson2 and tell me the disk usage"}',
        },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result?.[0]?.name).toBe('spawn_child_task');
    expect(result?.[0]?.args).toEqual({
      agentName: 'homelab-builder',
      originalUserMessage: 'SSH into jetson2 and tell me the disk usage',
    });
  });

  it('strips leaked inline JSON arguments from function.name', () => {
    const raw = [
      {
        id: 'call_wait',
        type: 'function' as const,
        function: {
          name: 'wait_for_child_task\n{"uid":"child-uid","timeoutSeconds":180}',
          arguments: '{}',
        },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result?.[0]?.name).toBe('wait_for_child_task');
    expect(result?.[0]?.args).toEqual({ uid: 'child-uid', timeoutSeconds: 180 });
  });

  it('recovers leaked inline JSON arguments glued directly to function.name', () => {
    const raw = [
      {
        id: 'call_wait_glued',
        type: 'function' as const,
        function: {
          name: 'wait_for_child_task{"uid":"child-uid","timeoutSeconds":180}',
          arguments: '{}',
        },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result?.[0]?.name).toBe('wait_for_child_task');
    expect(result?.[0]?.args).toEqual({ uid: 'child-uid', timeoutSeconds: 180 });
  });

  it('strips leaked parenthesized inline arguments from function.name', () => {
    const raw = [
      {
        id: 'call_shell',
        type: 'function' as const,
        function: {
          name: 'shell.exec(host="jetson2", command="df -h")',
          arguments: '{"host":"jetson2","command":"df -h"}',
        },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result?.[0]?.name).toBe('shell.exec');
    expect(result?.[0]?.args).toEqual({ host: 'jetson2', command: 'df -h' });
  });

  it('leaves well-formed names from other backends untouched', () => {
    const raw = [
      {
        id: 'call_3',
        type: 'function' as const,
        function: { name: 'code_interpreter.execute_code', arguments: '{}' },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result?.[0]?.name).toBe('code_interpreter.execute_code');
  });

  it('args round-trips arrays + nested objects (not just primitives)', () => {
    const raw = [
      {
        id: 'call_complex',
        type: 'function' as const,
        function: { name: 'fn', arguments: '{"items":[1,2,{"x":"y"}],"flag":true}' },
      },
    ];
    const result = fromOpenAIToolCalls(raw);
    expect(result?.[0]?.args).toEqual({ items: [1, 2, { x: 'y' }], flag: true });
  });
});

describe('toOpenAIToolCalls (kernel → OpenAI wire)', () => {
  it('returns undefined for undefined/empty input (caller can omit the field)', () => {
    expect(toOpenAIToolCalls(undefined)).toBeUndefined();
    expect(toOpenAIToolCalls([])).toBeUndefined();
  });

  it('translates a single tool call, JSON-stringifying args', () => {
    const calls: ToolCall[] = [{ id: 'c1', name: 'fetch_rss', args: { url: 'https://x.example' } }];
    expect(toOpenAIToolCalls(calls)).toEqual([
      {
        id: 'c1',
        type: 'function',
        function: { name: 'fetch_rss', arguments: '{"url":"https://x.example"}' },
      },
    ]);
  });

  it('preserves nested objects and arrays in args via JSON.stringify', () => {
    const calls: ToolCall[] = [
      {
        id: 'c2',
        name: 'search',
        args: { query: 'q', filters: { limit: 10, tags: ['a', 'b'] } },
      },
    ];
    const out = toOpenAIToolCalls(calls);
    expect(JSON.parse(out?.[0]?.function.arguments ?? '')).toEqual({
      query: 'q',
      filters: { limit: 10, tags: ['a', 'b'] },
    });
  });

  it('encodes empty-object args as "{}" (not "undefined")', () => {
    const calls: ToolCall[] = [{ id: 'c3', name: 'today', args: {} }];
    expect(toOpenAIToolCalls(calls)?.[0]?.function.arguments).toBe('{}');
  });

  it('encodes null/undefined args as "{}" (fallback for older kernels)', () => {
    const calls: ToolCall[] = [{ id: 'c4', name: 'noop', args: null }];
    expect(toOpenAIToolCalls(calls)?.[0]?.function.arguments).toBe('{}');
  });

  it('round-trips through fromOpenAIToolCalls without loss', () => {
    const original: ToolCall[] = [
      { id: 'c5', name: 'multi', args: { a: 1, b: 'two', c: { nested: true } } },
    ];
    const wire = toOpenAIToolCalls(original);
    const back = fromOpenAIToolCalls(wire);
    expect(back).toEqual(original);
  });
});
