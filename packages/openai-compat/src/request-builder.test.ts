/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * INT-01 — request-builder pure-fn tests (VALIDATION row 8).
 * Coverage target: 100% line + 100% branch.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildOpenAIRequestBody, buildOpenAIHeaders } from './request-builder.js';
import type { ChatRequest } from '@kagent/agent-loop';

describe('buildOpenAIRequestBody (VALIDATION row 8)', () => {
  it('VALIDATION.8: messages pass through for plain user/assistant turns', () => {
    const req: ChatRequest = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi back' },
      ],
    };
    const body = buildOpenAIRequestBody(req, 'm', { stream: false });
    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi back' },
    ]);
  });

  it('REGRESSION: assistant tool_calls translated to OpenAI wire envelope (nested function.{name, arguments:JSON-string})', () => {
    // Kernel shape on the assistant continuation turn — `{id, name, args}`
    // with args as parsed `unknown`. Without translation, OpenAI-compat
    // backends 400 "invalid tool call arguments".
    const req: ChatRequest = {
      messages: [
        { role: 'user', content: 'fetch the feed' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_abc', name: 'fetch_rss', args: { url: 'https://example.com/feed.rss' } },
          ],
        },
        {
          role: 'tool',
          content: '{"entries":[]}',
          tool_call_id: 'call_abc',
          name: 'fetch_rss',
        },
      ],
    };
    const body = buildOpenAIRequestBody(req, 'm', { stream: false });
    expect(body.messages).toEqual([
      { role: 'user', content: 'fetch the feed' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: {
              name: 'fetch_rss',
              // JSON-string per OpenAI spec; NOT an object.
              arguments: '{"url":"https://example.com/feed.rss"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"entries":[]}',
        tool_call_id: 'call_abc',
        name: 'fetch_rss',
      },
    ]);
    // tool_calls arguments MUST be a string (OpenAI spec requirement).
    expect(typeof body.messages[1]?.tool_calls?.[0]?.function.arguments).toBe('string');
  });

  it('REGRESSION: assistant message without tool_calls omits the field entirely', () => {
    const req: ChatRequest = {
      messages: [{ role: 'assistant', content: 'plain reply' }],
    };
    const body = buildOpenAIRequestBody(req, 'm', { stream: false });
    expect(body.messages[0]).toEqual({ role: 'assistant', content: 'plain reply' });
    expect('tool_calls' in (body.messages[0] ?? {})).toBe(false);
  });

  it('REGRESSION: empty tool_calls array is also omitted (no tools:[] drift)', () => {
    const req: ChatRequest = {
      messages: [{ role: 'assistant', content: 'x', tool_calls: [] }],
    };
    const body = buildOpenAIRequestBody(req, 'm', { stream: false });
    expect('tool_calls' in (body.messages[0] ?? {})).toBe(false);
  });

  it('REGRESSION: tool message without name field does not add an undefined name', () => {
    const req: ChatRequest = {
      messages: [{ role: 'tool', content: 'ok', tool_call_id: 'call_x' }],
    };
    const body = buildOpenAIRequestBody(req, 'm', { stream: false });
    expect(body.messages[0]).toEqual({
      role: 'tool',
      content: 'ok',
      tool_call_id: 'call_x',
    });
    expect('name' in (body.messages[0] ?? {})).toBe(false);
  });

  it('REGRESSION: tool_calls with complex args JSON-stringifies nested objects', () => {
    const req: ChatRequest = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_complex',
              name: 'search',
              args: { query: 'hello', filters: { type: 'feed', limit: 10 } },
            },
          ],
        },
      ],
    };
    const body = buildOpenAIRequestBody(req, 'm', { stream: false });
    const argsStr = body.messages[0]?.tool_calls?.[0]?.function.arguments;
    expect(typeof argsStr).toBe('string');
    expect(JSON.parse(argsStr as string)).toEqual({
      query: 'hello',
      filters: { type: 'feed', limit: 10 },
    });
  });

  it('VALIDATION.8: stream_options.include_usage === true when stream=true', () => {
    const body = buildOpenAIRequestBody({ messages: [] }, 'm', { stream: true });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('omits stream_options when stream=false', () => {
    const body = buildOpenAIRequestBody({ messages: [] }, 'm', { stream: false });
    expect(body.stream).toBe(false);
    expect(body.stream_options).toBeUndefined();
  });

  it('VALIDATION.8: temperature, maxTokens (→ max_tokens), stopSequences (→ stop) mapped', () => {
    const body = buildOpenAIRequestBody(
      {
        messages: [],
        temperature: 0.7,
        maxTokens: 1024,
        stopSequences: ['END', 'STOP'],
      },
      'm',
      { stream: false },
    );
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(1024);
    expect(body.stop).toEqual(['END', 'STOP']);
  });

  it('VALIDATION.8: systemPrompt prepended as role:system message', () => {
    const body = buildOpenAIRequestBody(
      { messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'you are helpful' },
      'm',
      { stream: false },
    );
    expect(body.messages[0]).toEqual({ role: 'system', content: 'you are helpful' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('VALIDATION.8: tools translated via toOpenAITools', () => {
    const body = buildOpenAIRequestBody(
      {
        messages: [],
        tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
      },
      'm',
      { stream: false },
    );
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object' } },
      },
    ]);
  });

  it('omits tools when request.tools is undefined or empty', () => {
    const body1 = buildOpenAIRequestBody({ messages: [] }, 'm', { stream: false });
    expect(body1.tools).toBeUndefined();
    const body2 = buildOpenAIRequestBody({ messages: [], tools: [] }, 'm', { stream: false });
    expect(body2.tools).toBeUndefined();
  });

  it('request.model overrides defaultModel', () => {
    const body = buildOpenAIRequestBody({ messages: [], model: 'gpt-4o' }, 'gpt-3.5', {
      stream: false,
    });
    expect(body.model).toBe('gpt-4o');
  });

  it('falls back to defaultModel when request.model not set', () => {
    const body = buildOpenAIRequestBody({ messages: [] }, 'gpt-3.5', { stream: false });
    expect(body.model).toBe('gpt-3.5');
  });

  it('omits stopSequences when empty array', () => {
    const body = buildOpenAIRequestBody({ messages: [], stopSequences: [] }, 'm', {
      stream: false,
    });
    expect(body.stop).toBeUndefined();
  });
});

describe('buildOpenAIHeaders (VALIDATION row 8)', () => {
  it('VALIDATION.8: Authorization: Bearer <key> when apiKey set', () => {
    const h = buildOpenAIHeaders('sk-test-key-123', {}, { stream: false });
    expect(h.Authorization).toBe('Bearer sk-test-key-123');
  });

  it('omits Authorization when apiKey undefined', () => {
    const h = buildOpenAIHeaders(undefined, {}, { stream: false });
    expect(h.Authorization).toBeUndefined();
  });

  it('omits Authorization when apiKey is empty string', () => {
    const h = buildOpenAIHeaders('', {}, { stream: false });
    expect(h.Authorization).toBeUndefined();
  });

  it('Accept: text/event-stream when stream=true', () => {
    const h = buildOpenAIHeaders(undefined, {}, { stream: true });
    expect(h.Accept).toBe('text/event-stream');
  });

  it('Accept: application/json when stream=false', () => {
    const h = buildOpenAIHeaders(undefined, {}, { stream: false });
    expect(h.Accept).toBe('application/json');
  });

  it('always sets Content-Type: application/json', () => {
    const h = buildOpenAIHeaders(undefined, {}, { stream: false });
    expect(h['Content-Type']).toBe('application/json');
  });

  it('VALIDATION.8: defaultHeaders merged (LAST — caller override wins)', () => {
    const h = buildOpenAIHeaders(
      'k',
      { 'api-version': '2024-10-21', 'x-custom': 'v' },
      { stream: false },
    );
    expect(h['api-version']).toBe('2024-10-21');
    expect(h['x-custom']).toBe('v');
    expect(h.Authorization).toBe('Bearer k');
  });

  it('defaultHeaders can override Accept (Azure pattern)', () => {
    const h = buildOpenAIHeaders('k', { Accept: 'custom/type' }, { stream: false });
    expect(h.Accept).toBe('custom/type');
  });

  it('VALIDATION.8: T-LLM-01 — never console.logs apiKey', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      buildOpenAIHeaders('sk-secret-12345', { custom: 'v' }, { stream: false });
      // None of these are called by the function under test
      expect(spy).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
