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

describe('OtelTraceSink', () => {
  it('creates one root span per run on first emit', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    sink.emit({ ...llmEntry, sequence: 2 });
    const roots = tracer.recorded.filter((s) => s.name === 'agent.run');
    expect(roots).toHaveLength(1);
    expect(roots[0]?.attributes).toMatchObject({ 'kagent.run_id': 'r1' });
  });

  it('creates a child span per llm_call with model + usage attributes', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(llmEntry);
    const llm = tracer.recorded.find((s) => s.name === 'agent.llm.call');
    expect(llm?.attributes['kagent.model']).toBe('workers-ai/@cf/meta/llama-4-scout');
    expect(llm?.attributes['kagent.input_tokens']).toBe(50);
    expect(llm?.attributes['kagent.output_tokens']).toBe(25);
    expect(llm?.attributes['kagent.cost_usd']).toBe(0.001);
    expect(llm?.attributes['kagent.stop_reason']).toBe('end_turn');
    expect(llm?.ended).toBe(true);
  });

  it('creates a child span per tool_call with name + input/output preview', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(toolEntry);
    const tool = tracer.recorded.find((s) => s.name === 'agent.tool.call.fetch_url');
    expect(tool?.attributes['kagent.tool_name']).toBe('fetch_url');
    expect(tool?.attributes['kagent.tool_input.preview']).toBe('{"url":"https://example.com"}');
    expect(tool?.attributes['kagent.tool_output.preview']).toBe('page body');
    expect(tool?.attributes['kagent.is_error']).toBe(false);
  });

  it('marks tool spans ERROR when is_error=true', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit(errorToolEntry);
    const tool = tracer.recorded.find((s) => s.name === 'agent.tool.call.fetch_url');
    // SpanStatusCode.ERROR === 2 (from @opentelemetry/api)
    expect(tool?.status?.code).toBe(2);
    expect(tool?.status?.message).toBe('connection refused');
  });

  it('truncates long tool_input/output previews', () => {
    const tracer = makeStubTracer();
    const sink = new OtelTraceSink({ tracer });
    sink.emit({ ...toolEntry, tool_input: 'x'.repeat(500) });
    const tool = tracer.recorded.find((s) => s.name === 'agent.tool.call.fetch_url');
    const preview = tool?.attributes['kagent.tool_input.preview'] as string;
    expect(preview).toMatch(/truncated 244 chars/);
  });

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
