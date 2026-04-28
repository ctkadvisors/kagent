/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { trace, type Context, type Span, type SpanOptions, type Tracer } from '@opentelemetry/api';
import type { TraceEntry } from '@kagent/agent-loop';
import { describe, expect, it, vi } from 'vitest';

import { OtelTraceSink, isOtelEnabled, langfuseTraceUrl, traceIdFromRunId } from './otel-sink.js';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
  status?: { code: number; message?: string };
  ended: boolean;
  /** Trace ID propagated by the parent context that was passed to startSpan(). */
  parentTraceId?: string;
  /** Span ID propagated by the parent context that was passed to startSpan(). */
  parentSpanId?: string;
}

function makeStubTracer(): Tracer & { recorded: RecordedSpan[] } {
  const recorded: RecordedSpan[] = [];
  const tracer = {
    recorded,
    startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
      // Mirror the SDK behavior we care about for these tests: when the
      // caller hands us a Context with a parent SpanContext, the new
      // span adopts that trace ID. We capture both `parentTraceId` and
      // the resulting `spanContext().traceId` so determinism tests can
      // assert against either surface.
      const parent = ctx !== undefined ? trace.getSpanContext(ctx) : undefined;
      const adoptedTraceId = parent?.traceId ?? '0';
      const rec: RecordedSpan = {
        name,
        attributes: { ...(options?.attributes ?? {}) },
        events: [],
        ended: false,
        ...(parent !== undefined && {
          parentTraceId: parent.traceId,
          parentSpanId: parent.spanId,
        }),
      };
      recorded.push(rec);
      const span: Span = {
        spanContext: () => ({ traceId: adoptedTraceId, spanId: '0', traceFlags: 0 }),
        setAttribute: (k, v) => {
          rec.attributes[k] = v;
          return span;
        },
        setAttributes: (a) => {
          Object.assign(rec.attributes, a);
          return span;
        },
        addEvent: (n, attrs) => {
          rec.events.push({ name: n, attributes: { ...attrs } });
          return span;
        },
        setStatus: (s) => {
          rec.status = s;
          return span;
        },
        updateName: (n) => {
          rec.name = n;
          return span;
        },
        isRecording: () => true,
        end: () => {
          rec.ended = true;
        },
        recordException: () => {
          /* no-op */
        },
        addLink: () => span,
        addLinks: () => span,
      };
      return span;
    },
    startActiveSpan: vi.fn(),
  } as unknown as Tracer & { recorded: RecordedSpan[] };
  return tracer;
}

const llmEntry: TraceEntry = {
  schema_version: '1',
  run_id: 'r1',
  sequence: 1,
  trace_type: 'llm_call',
  timestamp_ms: 0,
  latency_ms: 100,
  model: 'workers-ai/@cf/meta/llama-4-scout',
  input_tokens_est: 50,
  output_tokens_est: 25,
  cost_usd: 0.001,
  stop_reason: 'end_turn',
  input_messages: '[{"role":"user","content":"hello"}]',
  output_content: 'hi there',
};

const toolEntry: TraceEntry = {
  schema_version: '1',
  run_id: 'r1',
  sequence: 2,
  trace_type: 'tool_call',
  timestamp_ms: 0,
  latency_ms: 50,
  tool_name: 'fetch_url',
  tool_input: '{"url":"https://example.com"}',
  tool_output: 'page body',
  is_error: false,
};

const errorToolEntry: TraceEntry = {
  ...toolEntry,
  sequence: 3,
  is_error: true,
  error: 'connection refused',
};

const runCompleteEntry: TraceEntry = {
  schema_version: '1',
  run_id: 'r1',
  sequence: 9,
  trace_type: 'run_complete',
  timestamp_ms: 0,
  latency_ms: 0,
  final_content: 'final answer',
  final_status: 'completed',
  cumulative_input_tokens: 50,
  cumulative_output_tokens: 25,
  cumulative_cost_usd: 0.001,
  hit_iteration_cap: false,
};

describe('isOtelEnabled', () => {
  it('returns true when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set', () => {
    expect(isOtelEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://x:4318' })).toBe(true);
  });

  it('falls back to OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    expect(isOtelEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318' })).toBe(true);
  });

  it('returns false when neither is set', () => {
    expect(isOtelEnabled({})).toBe(false);
  });

  it('returns false on empty-string value', () => {
    expect(isOtelEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '' })).toBe(false);
  });
});

describe('OtelTraceSink — root span', () => {
  it('creates one root span per run on first emit', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    sink.emit({ ...llmEntry, sequence: 2 });
    const roots = tracer.recorded.filter((s) => s.name === 'agent.run');
    expect(roots).toHaveLength(1);
    // langfuse.trace.* attrs land on the root.
    expect(roots[0]?.attributes).toMatchObject({
      'kagent.run_id': 'r1',
      'langfuse.trace.metadata.kagent_run_id': 'r1',
    });
    expect(roots[0]?.attributes['langfuse.trace.tags']).toEqual(expect.arrayContaining(['kagent']));
  });

  it('stamps runContext metadata onto the root span', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({
      tracer,
      runContext: {
        agentName: 'researcher',
        taskUid: 'task-uid-abc',
        taskName: 'daily-digest',
        namespace: 'kagent-system',
        sandboxProfile: 'strict',
      },
    });
    sink.emit(llmEntry);
    const root = tracer.recorded.find((s) => s.name === 'agent.run');
    expect(root?.attributes['langfuse.trace.name']).toBe('researcher:daily-digest');
    expect(root?.attributes['langfuse.trace.metadata.kagent_agent']).toBe('researcher');
    expect(root?.attributes['langfuse.trace.metadata.kagent_task_uid']).toBe('task-uid-abc');
    expect(root?.attributes['langfuse.trace.metadata.kagent_task_name']).toBe('daily-digest');
    expect(root?.attributes['langfuse.trace.metadata.kagent_namespace']).toBe('kagent-system');
    expect(root?.attributes['langfuse.trace.metadata.kagent_sandbox_profile']).toBe('strict');
    expect(root?.attributes['langfuse.trace.tags']).toEqual(
      expect.arrayContaining(['kagent', 'sandbox:strict', 'ns:kagent-system']),
    );
  });
});

describe('OtelTraceSink — LLM call (Langfuse generation + GenAI chat semconv)', () => {
  it('renders an llm_call as a Langfuse generation with usage + cost details', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    const llm = tracer.recorded.find((s) => s.name === 'agent.llm.call');
    // Langfuse explicit keys.
    expect(llm?.attributes['langfuse.observation.type']).toBe('generation');
    expect(llm?.attributes['langfuse.observation.model.name']).toBe(
      'workers-ai/@cf/meta/llama-4-scout',
    );
    expect(llm?.attributes['langfuse.observation.usage_details.input']).toBe(50);
    expect(llm?.attributes['langfuse.observation.usage_details.output']).toBe(25);
    expect(llm?.attributes['langfuse.observation.usage_details.total']).toBe(75);
    expect(llm?.attributes['langfuse.observation.cost_details.total']).toBe(0.001);
    // OTel GenAI semconv.
    expect(llm?.attributes['gen_ai.operation.name']).toBe('chat');
    expect(llm?.attributes['gen_ai.request.model']).toBe('workers-ai/@cf/meta/llama-4-scout');
    expect(llm?.attributes['gen_ai.response.model']).toBe('workers-ai/@cf/meta/llama-4-scout');
    expect(llm?.attributes['gen_ai.usage.input_tokens']).toBe(50);
    expect(llm?.attributes['gen_ai.usage.output_tokens']).toBe(25);
    // Secondary kagent.* metadata still present (WS-D log-grep continuity).
    expect(llm?.attributes['kagent.model']).toBe('workers-ai/@cf/meta/llama-4-scout');
    expect(llm?.attributes['kagent.cost_usd']).toBe(0.001);
    expect(llm?.ended).toBe(true);
  });

  it('attaches input messages + output content as Langfuse JSON-string bodies', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    const llm = tracer.recorded.find((s) => s.name === 'agent.llm.call');
    const input = llm?.attributes['langfuse.observation.input'] as string;
    const output = llm?.attributes['langfuse.observation.output'] as string;
    expect(input).toContain('"role":"user"');
    expect(input).toContain('"content":"hello"');
    // Output is a composed JSON object so the Langfuse Generation viewer
    // can render content + tool_calls side by side.
    expect(JSON.parse(output)).toMatchObject({ content: 'hi there' });
  });

  it('omits input/output bodies when contentMode = "none"', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer, contentMode: 'none' });
    sink.emit(llmEntry);
    const llm = tracer.recorded.find((s) => s.name === 'agent.llm.call');
    expect(llm?.attributes['langfuse.observation.input']).toBeUndefined();
    expect(llm?.attributes['langfuse.observation.output']).toBeUndefined();
    // Token usage still present — only the content body is suppressed.
    expect(llm?.attributes['gen_ai.usage.input_tokens']).toBe(50);
  });
});

describe('OtelTraceSink — tool call (GenAI execute_tool semconv)', () => {
  it('uses the GenAI-semconv span name `execute_tool <toolName>`', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(toolEntry);
    expect(tracer.recorded.find((s) => s.name === 'execute_tool fetch_url')).toBeDefined();
    // And the legacy span name is gone.
    expect(tracer.recorded.find((s) => s.name === 'agent.tool.call.fetch_url')).toBeUndefined();
  });

  it('attaches gen_ai.tool.* + Langfuse observation attrs', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(toolEntry);
    const tool = tracer.recorded.find((s) => s.name === 'execute_tool fetch_url');
    expect(tool?.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(tool?.attributes['gen_ai.tool.name']).toBe('fetch_url');
    expect(tool?.attributes['gen_ai.tool.call.arguments']).toBe('{"url":"https://example.com"}');
    expect(tool?.attributes['gen_ai.tool.call.result']).toBe('page body');
    expect(tool?.attributes['langfuse.observation.input']).toBe('{"url":"https://example.com"}');
    expect(tool?.attributes['langfuse.observation.output']).toBe('page body');
    expect(tool?.attributes['kagent.tool_name']).toBe('fetch_url');
  });

  it('marks tool spans ERROR + langfuse.observation.level=ERROR when is_error=true', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(errorToolEntry);
    const tool = tracer.recorded.find((s) => s.name === 'execute_tool fetch_url');
    // SpanStatusCode.ERROR === 2 (from @opentelemetry/api)
    expect(tool?.status?.code).toBe(2);
    expect(tool?.status?.message).toBe('connection refused');
    expect(tool?.attributes['langfuse.observation.level']).toBe('ERROR');
  });
});

describe('OtelTraceSink — iteration boundary', () => {
  it('records iteration_boundary as a span event on the root, not a new span', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit({
      schema_version: '1',
      run_id: 'r1',
      sequence: 5,
      trace_type: 'iteration_boundary',
      timestamp_ms: 0,
      latency_ms: 0,
      iteration: 1,
    });
    expect(tracer.recorded.find((s) => s.name === 'agent.run')?.events).toHaveLength(1);
    // No span named 'iteration_boundary' was created
    expect(tracer.recorded.find((s) => s.name === 'iteration_boundary')).toBeUndefined();
  });
});

describe('OtelTraceSink — run_complete finalization', () => {
  it('stamps trace-level totals + final output on the root span and ends it', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    sink.emit(runCompleteEntry);
    const root = tracer.recorded.find((s) => s.name === 'agent.run');
    expect(root?.attributes['langfuse.trace.output']).toBe('final answer');
    expect(root?.attributes['langfuse.trace.metadata.cumulative_input_tokens']).toBe(50);
    expect(root?.attributes['langfuse.trace.metadata.cumulative_output_tokens']).toBe(25);
    expect(root?.attributes['langfuse.trace.metadata.cumulative_cost_usd']).toBe(0.001);
    expect(root?.attributes['kagent.final_status']).toBe('completed');
    expect(root?.ended).toBe(true);
  });

  it('marks the root span ERROR for non-completed terminal statuses', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    sink.emit({ ...runCompleteEntry, final_status: 'failed' });
    const root = tracer.recorded.find((s) => s.name === 'agent.run');
    expect(root?.status?.code).toBe(2); // SpanStatusCode.ERROR
    expect(root?.status?.message).toContain('failed');
  });

  it('flush() is a safe no-op after run_complete ended the root', async () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    sink.emit(runCompleteEntry);
    // Already ended.
    expect(tracer.recorded.find((s) => s.name === 'agent.run')?.ended).toBe(true);
    // flush() should not double-end (Span.end() is idempotent in the
    // OTel SDK; we don't model that explicitly in the stub but verify
    // flush() doesn't throw).
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});

describe('OtelTraceSink — flush + close fallback (no run_complete emitted)', () => {
  it('flush() ends all open root spans', async () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    sink.emit({ ...llmEntry, run_id: 'r2' });
    expect(tracer.recorded.filter((s) => s.name === 'agent.run').every((s) => s.ended)).toBe(false);
    await sink.flush();
    expect(tracer.recorded.filter((s) => s.name === 'agent.run').every((s) => s.ended)).toBe(true);
  });

  it('close() is an alias for flush()', async () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    await sink.close();
    expect(tracer.recorded.find((s) => s.name === 'agent.run')?.ended).toBe(true);
  });

  it('keeps separate root spans for distinct runs', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    sink.emit({ ...llmEntry, run_id: 'r2' });
    expect(tracer.recorded.filter((s) => s.name === 'agent.run')).toHaveLength(2);
  });
});

/* =====================================================================
 * Deterministic trace-ID derivation — WS-D fix #1.
 * ===================================================================== */

describe('traceIdFromRunId', () => {
  it('returns a 32-char lowercase-hex string', () => {
    const id = traceIdFromRunId('any-run');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic — same runId always produces the same id', () => {
    expect(traceIdFromRunId('r1')).toBe(traceIdFromRunId('r1'));
  });

  it('different runIds produce different ids (no trivial collision)', () => {
    expect(traceIdFromRunId('r1')).not.toBe(traceIdFromRunId('r2'));
  });
});

describe('langfuseTraceUrl', () => {
  it('constructs `<base>/trace/<traceId>` with the derived id', () => {
    const url = langfuseTraceUrl('https://langfuse.example.com', 'task-uid-1');
    expect(url).toBe(`https://langfuse.example.com/trace/${traceIdFromRunId('task-uid-1')}`);
  });

  it('strips trailing slashes from the base URL', () => {
    const url = langfuseTraceUrl('https://langfuse.example.com///', 'task-uid-1');
    expect(url).toBe(`https://langfuse.example.com/trace/${traceIdFromRunId('task-uid-1')}`);
  });
});

describe('OtelTraceSink — deterministic trace ID', () => {
  it('hands the derived trace ID to startSpan via a remote parent context', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry); // run_id='r1'
    const root = tracer.recorded.find((s) => s.name === 'agent.run');
    expect(root?.parentTraceId).toBe(traceIdFromRunId('r1'));
    expect(root?.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('two sink instances emit the SAME traceId for the same runId (proof of determinism)', () => {
    const tracerA = makeStubTracer();
    const tracerB = makeStubTracer();
    const sinkA = new OtelTraceSink({ tracer: tracerA });
    const sinkB = new OtelTraceSink({ tracer: tracerB });
    sinkA.emit(llmEntry);
    sinkB.emit(llmEntry);
    const rootA = tracerA.recorded.find((s) => s.name === 'agent.run');
    const rootB = tracerB.recorded.find((s) => s.name === 'agent.run');
    // Proof line — both sinks adopted the same derived trace ID.
    expect(rootA?.parentTraceId).toBe(rootB?.parentTraceId);
    // And it equals what the public helper says.
    expect(rootA?.parentTraceId).toBe(traceIdFromRunId('r1'));
  });

  it('traceIdFor() returns the same id used for the root span', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    expect(sink.traceIdFor('r1')).toBe(traceIdFromRunId('r1'));
  });

  it('traceIdFor() works without an emit (consumer building a deep-link before any spans flush)', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    expect(sink.traceIdFor('not-yet-emitted')).toBe(traceIdFromRunId('not-yet-emitted'));
  });
});
