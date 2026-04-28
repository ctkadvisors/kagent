/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { TraceEntry } from '@kagent/agent-loop';
import { describe, expect, it } from 'vitest';

import {
  applyContentMode,
  DEFAULT_CONTENT_MODE,
  formatLlmCallAttrs,
  formatRootSpanAttrs,
  formatRunCompleteAttrs,
  formatToolCallAttrs,
  parseContentMode,
  toLangfuseJsonString,
  truncatePreservingJson,
} from './langfuse-otel-format.js';

describe('parseContentMode', () => {
  it('returns DEFAULT_CONTENT_MODE for undefined / empty', () => {
    expect(parseContentMode(undefined)).toBe(DEFAULT_CONTENT_MODE);
    expect(parseContentMode('')).toBe(DEFAULT_CONTENT_MODE);
  });

  it.each(['none', 'preview', 'full'] as const)('accepts %s', (mode) => {
    expect(parseContentMode(mode)).toBe(mode);
  });

  it('rejects artifact-ref explicitly (reserved, depends on P3 writer)', () => {
    expect(() => parseContentMode('artifact-ref')).toThrow(/artifact-ref.*reserved/);
  });

  it('rejects unknown values', () => {
    expect(() => parseContentMode('garbage')).toThrow(/not a valid ContentMode/);
  });
});

describe('truncatePreservingJson', () => {
  it('preserves outer JSON array shape, truncates per-string content', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(2000) },
      { role: 'assistant', content: 'short reply' },
    ];
    const out = truncatePreservingJson(JSON.stringify(messages), 50);
    const parsed = JSON.parse(out) as typeof messages;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.role).toBe('user');
    // Long content was truncated, not the JSON shape.
    expect(parsed[0]?.content.length).toBeLessThan(2000);
    expect(parsed[0]?.content).toMatch(/truncated 1950 chars/);
    expect(parsed[1]?.content).toBe('short reply');
  });

  it('preserves nested JSON object shape', () => {
    const tree = { outer: { inner: 'y'.repeat(1000), other: 'kept' } };
    const out = truncatePreservingJson(JSON.stringify(tree), 30);
    const parsed = JSON.parse(out) as typeof tree;
    expect(parsed.outer.inner).toMatch(/truncated 970 chars/);
    expect(parsed.outer.other).toBe('kept');
  });

  it('falls back to whole-string truncation for non-JSON', () => {
    const long = 'a'.repeat(1000);
    const out = truncatePreservingJson(long, 100);
    expect(out).toMatch(/truncated 900 chars/);
    // Was not JSON; result should NOT be parseable.
    expect(() => {
      JSON.parse(out);
    }).toThrow();
  });

  it('returns short JSON unchanged', () => {
    const small = JSON.stringify({ ok: true });
    expect(truncatePreservingJson(small, 50)).toBe(small);
  });
});

describe('applyContentMode', () => {
  it('returns undefined for missing or empty', () => {
    expect(applyContentMode(undefined, 'full')).toBeUndefined();
    expect(applyContentMode(null, 'full')).toBeUndefined();
    expect(applyContentMode('', 'full')).toBeUndefined();
  });

  it('returns undefined when mode = none', () => {
    expect(applyContentMode('non-empty', 'none')).toBeUndefined();
  });

  it('passes through unmodified when mode = full', () => {
    const big = 'x'.repeat(10_000);
    expect(applyContentMode(big, 'full')).toBe(big);
  });

  it('truncates when mode = preview', () => {
    const big = 'x'.repeat(10_000);
    const out = applyContentMode(big, 'preview', 100);
    expect(out).not.toBe(big);
    expect(out).toMatch(/truncated/);
  });

  it('throws on artifact-ref (defensive)', () => {
    expect(() => applyContentMode('x', 'artifact-ref')).toThrow(/not implemented/);
  });
});

describe('formatRootSpanAttrs', () => {
  it('emits trace.name + trace.tags + trace.metadata.* when runContext is present', () => {
    const attrs = formatRootSpanAttrs('run-1', {
      agentName: 'researcher',
      taskUid: 'uid-1',
      taskName: 'daily',
      namespace: 'kagent-system',
      sandboxProfile: 'strict',
      extraTags: ['custom-tag'],
    });
    expect(attrs['langfuse.trace.name']).toBe('researcher:daily');
    expect(attrs['langfuse.trace.metadata.kagent_agent']).toBe('researcher');
    expect(attrs['langfuse.trace.metadata.kagent_task_uid']).toBe('uid-1');
    expect(attrs['langfuse.trace.metadata.kagent_task_name']).toBe('daily');
    expect(attrs['langfuse.trace.metadata.kagent_namespace']).toBe('kagent-system');
    expect(attrs['langfuse.trace.metadata.kagent_sandbox_profile']).toBe('strict');
    expect(attrs['langfuse.trace.metadata.kagent_run_id']).toBe('run-1');
    expect(attrs['langfuse.trace.tags']).toEqual([
      'kagent',
      'sandbox:strict',
      'ns:kagent-system',
      'custom-tag',
    ]);
  });

  it('falls back to a runId-based trace name when runContext is absent', () => {
    const attrs = formatRootSpanAttrs('run-2', undefined);
    expect(attrs['langfuse.trace.name']).toBe('kagent.run:run-2');
    expect(attrs['langfuse.trace.tags']).toEqual(['kagent']);
    expect(attrs['kagent.run_id']).toBe('run-2');
  });
});

describe('formatLlmCallAttrs', () => {
  const base: TraceEntry = {
    schema_version: '1',
    run_id: 'r1',
    sequence: 1,
    trace_type: 'llm_call',
    timestamp_ms: 0,
    latency_ms: 100,
    model: 'gpt-4',
    input_tokens_est: 10,
    output_tokens_est: 5,
    cost_usd: 0.0001,
    stop_reason: 'end_turn',
    input_messages: '[{"role":"user","content":"hi"}]',
    output_content: 'hello',
  };

  it('emits Langfuse generation + GenAI chat attrs', () => {
    const attrs = formatLlmCallAttrs(base, 'preview');
    expect(attrs['langfuse.observation.type']).toBe('generation');
    expect(attrs['langfuse.observation.name']).toBe('agent.llm.call');
    expect(attrs['langfuse.observation.model.name']).toBe('gpt-4');
    // usage_details + cost_details are JSON-string-shaped per Langfuse OTel ingestion contract.
    expect(JSON.parse(attrs['langfuse.observation.usage_details'] as string)).toEqual({
      input: 10,
      output: 5,
      total: 15,
    });
    expect(JSON.parse(attrs['langfuse.observation.cost_details'] as string)).toEqual({
      total: 0.0001,
    });
    expect(attrs['gen_ai.operation.name']).toBe('chat');
    expect(attrs['gen_ai.request.model']).toBe('gpt-4');
    expect(attrs['gen_ai.response.model']).toBe('gpt-4');
    expect(attrs['gen_ai.usage.input_tokens']).toBe(10);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(5);
  });

  it('omits cost_details when entry.cost_usd is null/undefined', () => {
    const noCost = formatLlmCallAttrs({ ...base, cost_usd: null }, 'preview');
    expect(noCost['langfuse.observation.cost_details']).toBeUndefined();
    const undef = formatLlmCallAttrs({ ...base, cost_usd: undefined }, 'preview');
    expect(undef['langfuse.observation.cost_details']).toBeUndefined();
  });

  it('omits content body when contentMode = none', () => {
    const attrs = formatLlmCallAttrs(base, 'none');
    expect(attrs['langfuse.observation.input']).toBeUndefined();
    expect(attrs['langfuse.observation.output']).toBeUndefined();
    // Token usage still present.
    expect(attrs['gen_ai.usage.input_tokens']).toBe(10);
  });

  it('composes content + tool_calls into a structured output JSON', () => {
    const attrs = formatLlmCallAttrs(
      {
        ...base,
        output_content: 'partial answer',
        output_tool_calls: '[{"name":"fetch","args":{"u":"x"}}]',
      },
      'full',
    );
    const parsed = JSON.parse(attrs['langfuse.observation.output'] as string) as {
      content: string;
      tool_calls: Array<{ name: string; args: Record<string, string> }>;
    };
    expect(parsed.content).toBe('partial answer');
    expect(parsed.tool_calls).toHaveLength(1);
    expect(parsed.tool_calls[0]?.name).toBe('fetch');
  });
});

describe('formatToolCallAttrs', () => {
  const base: TraceEntry = {
    schema_version: '1',
    run_id: 'r1',
    sequence: 2,
    trace_type: 'tool_call',
    timestamp_ms: 0,
    latency_ms: 50,
    tool_name: 'fetch_url',
    tool_provider_id: 'http',
    tool_input: '{"url":"https://x"}',
    tool_output: 'page',
    is_error: false,
  };

  it('uses GenAI semconv span name `execute_tool <toolName>`', () => {
    const { spanName } = formatToolCallAttrs(base, 'preview');
    expect(spanName).toBe('execute_tool fetch_url');
  });

  it('emits gen_ai.tool.* + langfuse.observation.* attrs', () => {
    const { attributes } = formatToolCallAttrs(base, 'full');
    expect(attributes['langfuse.observation.type']).toBe('span');
    expect(attributes['langfuse.observation.name']).toBe('execute_tool fetch_url');
    expect(attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(attributes['gen_ai.tool.name']).toBe('fetch_url');
    // gen_ai.tool.call.* ride raw payloads; langfuse.observation.* must
    // always parse as JSON. Already-JSON tool_input passes through; raw
    // text tool_output gets wrapped as { preview }.
    expect(attributes['gen_ai.tool.call.arguments']).toBe('{"url":"https://x"}');
    expect(attributes['gen_ai.tool.call.result']).toBe('page');
    expect(JSON.parse(attributes['langfuse.observation.input'] as string)).toEqual({
      url: 'https://x',
    });
    expect(JSON.parse(attributes['langfuse.observation.output'] as string)).toEqual({
      preview: 'page',
    });
  });

  it('flags errors with langfuse.observation.level=ERROR', () => {
    const { attributes } = formatToolCallAttrs({ ...base, is_error: true }, 'preview');
    expect(attributes['langfuse.observation.level']).toBe('ERROR');
  });

  it('falls back to "unknown" when tool_name is absent', () => {
    const { spanName } = formatToolCallAttrs({ ...base, tool_name: undefined }, 'preview');
    expect(spanName).toBe('execute_tool unknown');
  });
});

describe('formatRunCompleteAttrs', () => {
  const base: TraceEntry = {
    schema_version: '1',
    run_id: 'r1',
    sequence: 99,
    trace_type: 'run_complete',
    timestamp_ms: 0,
    latency_ms: 0,
    final_content: 'final',
    final_status: 'completed',
    cumulative_input_tokens: 50,
    cumulative_output_tokens: 25,
    cumulative_cost_usd: 0.001,
    hit_iteration_cap: false,
  };

  it('puts final output + totals on the root span as Langfuse trace.* fields', () => {
    const attrs = formatRunCompleteAttrs(base, 'full');
    expect(attrs['langfuse.trace.output']).toBe('final');
    expect(attrs['langfuse.trace.metadata.cumulative_input_tokens']).toBe(50);
    expect(attrs['langfuse.trace.metadata.cumulative_output_tokens']).toBe(25);
    expect(attrs['langfuse.trace.metadata.cumulative_cost_usd']).toBe(0.001);
    expect(attrs['kagent.final_status']).toBe('completed');
    expect(attrs['kagent.hit_iteration_cap']).toBe(false);
  });

  it('omits trace.output when contentMode = none', () => {
    const attrs = formatRunCompleteAttrs(base, 'none');
    expect(attrs['langfuse.trace.output']).toBeUndefined();
    // Totals still exposed.
    expect(attrs['langfuse.trace.metadata.cumulative_input_tokens']).toBe(50);
  });

  it('handles null cumulative_cost_usd (no backend reported cost)', () => {
    const attrs = formatRunCompleteAttrs({ ...base, cumulative_cost_usd: null }, 'full');
    expect(attrs['langfuse.trace.metadata.cumulative_cost_usd']).toBeUndefined();
    expect(attrs['kagent.cumulative_cost_usd']).toBeUndefined();
  });
});

describe('toLangfuseJsonString — JSON-string contract', () => {
  it('returns undefined for missing or empty values', () => {
    expect(toLangfuseJsonString(undefined, 'full')).toBeUndefined();
    expect(toLangfuseJsonString(null, 'full')).toBeUndefined();
    expect(toLangfuseJsonString('', 'full')).toBeUndefined();
  });

  it('returns undefined when mode = none', () => {
    expect(toLangfuseJsonString('anything', 'none')).toBeUndefined();
    expect(toLangfuseJsonString('{"k":"v"}', 'none')).toBeUndefined();
  });

  it('throws on artifact-ref (defensive — parseContentMode rejects upstream)', () => {
    expect(() => toLangfuseJsonString('x', 'artifact-ref')).toThrow(/not implemented/);
  });

  it('parses + re-stringifies JSON-shaped input (full mode)', () => {
    const out = toLangfuseJsonString('{"a":1,"b":[true,false]}', 'full');
    expect(out).toBeDefined();
    // Round-trip preserves shape (whitespace not guaranteed identical).
    expect(JSON.parse(out!)).toEqual({ a: 1, b: [true, false] });
  });

  it('walks + truncates JSON leaves in preview mode', () => {
    const big = JSON.stringify({ msg: 'x'.repeat(2000) });
    const out = toLangfuseJsonString(big, 'preview', 50);
    expect(out).toBeDefined();
    const parsed = JSON.parse(out!) as { msg: string };
    expect(parsed.msg.length).toBeLessThan(2000);
    expect(parsed.msg).toMatch(/truncated 1950 chars/);
  });

  it('wraps non-JSON text as { preview: <text> } (full mode)', () => {
    const out = toLangfuseJsonString('plain raw text', 'full');
    expect(JSON.parse(out!)).toEqual({ preview: 'plain raw text' });
  });

  it('wraps non-JSON text as { preview: <truncated text> } (preview mode)', () => {
    const long = 'a'.repeat(1000);
    const out = toLangfuseJsonString(long, 'preview', 100);
    const parsed = JSON.parse(out!) as { preview: string };
    expect(parsed.preview.length).toBeLessThan(1000);
    expect(parsed.preview).toMatch(/truncated 900 chars/);
  });

  it('always produces a valid JSON string for malformed JSON-looking input', () => {
    // Common case: stringification was truncated mid-character so
    // JSON.parse fails. Spec point 6: still must produce a valid JSON string.
    const malformed = '{"role":"user","content":"abc'; // no closing quote/brace
    const out = toLangfuseJsonString(malformed, 'preview');
    expect(() => {
      JSON.parse(out!);
    }).not.toThrow();
    expect(JSON.parse(out!) as unknown).toEqual({ preview: malformed });
  });
});

describe('formatLlmCallAttrs — JSON-string contract for input/output', () => {
  const base: TraceEntry = {
    schema_version: '1',
    run_id: 'r1',
    sequence: 1,
    trace_type: 'llm_call',
    timestamp_ms: 0,
    latency_ms: 100,
    model: 'gpt-4',
    input_tokens_est: 10,
    output_tokens_est: 5,
  };

  it('langfuse.observation.input is always parseable JSON, even for non-JSON input_messages', () => {
    const attrs = formatLlmCallAttrs({ ...base, input_messages: 'not json at all' }, 'preview');
    const v = attrs['langfuse.observation.input'] as string;
    expect(() => {
      JSON.parse(v);
    }).not.toThrow();
    expect(JSON.parse(v) as unknown).toEqual({ preview: 'not json at all' });
  });

  it('output_tool_calls that fail to parse are wrapped, not raw-concatenated', () => {
    const attrs = formatLlmCallAttrs(
      {
        ...base,
        output_content: 'partial',
        output_tool_calls: '[malformed {',
      },
      'full',
    );
    const v = attrs['langfuse.observation.output'] as string;
    const parsed = JSON.parse(v) as { content: string; tool_calls: { preview: string } };
    expect(parsed.content).toBe('partial');
    expect(parsed.tool_calls.preview).toBe('[malformed {');
  });
});

describe('formatToolCallAttrs — JSON-string contract for input/output', () => {
  const base: TraceEntry = {
    schema_version: '1',
    run_id: 'r1',
    sequence: 2,
    trace_type: 'tool_call',
    timestamp_ms: 0,
    latency_ms: 50,
    tool_name: 'fetch_url',
    tool_input: '{"url":"https://x"}',
    tool_output: 'page',
  };

  it('non-JSON tool_input wraps as { preview }, gen_ai stays raw', () => {
    const { attributes } = formatToolCallAttrs({ ...base, tool_input: 'plain text args' }, 'full');
    expect(JSON.parse(attributes['langfuse.observation.input'] as string)).toEqual({
      preview: 'plain text args',
    });
    expect(attributes['gen_ai.tool.call.arguments']).toBe('plain text args');
  });

  it('non-JSON tool_output wraps as { preview }, gen_ai stays raw', () => {
    const { attributes } = formatToolCallAttrs(base, 'full');
    expect(JSON.parse(attributes['langfuse.observation.output'] as string)).toEqual({
      preview: 'page',
    });
    expect(attributes['gen_ai.tool.call.result']).toBe('page');
  });

  it('truncated mid-string JSON tool_input still produces parseable JSON', () => {
    const malformed = '{"url":"https://x","body":"abc'; // truncated mid-char
    const { attributes } = formatToolCallAttrs({ ...base, tool_input: malformed }, 'preview');
    const v = attributes['langfuse.observation.input'] as string;
    expect(() => {
      JSON.parse(v);
    }).not.toThrow();
    expect(JSON.parse(v) as unknown).toEqual({ preview: malformed });
  });
});
