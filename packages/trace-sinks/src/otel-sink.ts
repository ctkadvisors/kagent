/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `OtelTraceSink` — implements the `@kagent/agent-loop` `TraceSink`
 * contract by emitting OTel spans through OTLP/HTTP. Langfuse 4.x
 * ingests OTLP natively at `<base>/api/public/otel/v1/traces`, so
 * pointing this sink at Langfuse needs only a base-URL config — no
 * Langfuse-specific SDK.
 *
 * Design choices:
 *
 *   - One root span per run (`agent.run`), keyed by `runId`. Every
 *     trace entry becomes a child span underneath it.
 *   - LLM calls map to spans named `agent.llm.call` with model + usage
 *     attributes (input/output tokens, cost when reported).
 *   - Tool calls map to `agent.tool.call.<name>` spans with input +
 *     output snippets + isError as attributes.
 *   - Iteration boundaries map to span events on the root span, NOT
 *     separate spans (they're zero-duration markers).
 *   - The provider is created lazily on first emit so unit tests can
 *     inject a stubbed processor; production uses the OTel SDK's
 *     `BatchSpanProcessor` + `OTLPTraceExporter`.
 *   - When `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is unset, the sink
 *     no-ops (emits nothing) — keeps local dev silent without forcing
 *     callers to gate the sink behind their own conditional.
 */

import { context, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import type { TraceEntry, TraceSink } from '@kagent/agent-loop';

const TRACER_NAME = '@kagent/agent-loop';

export interface OtelTraceSinkOptions {
  /**
   * Tracer instance — production passes the result of `trace.getTracer(...)`
   * after the SDK has been registered. Tests pass a stub.
   */
  readonly tracer: Tracer;
  /**
   * Service name attribute for emitted spans. Defaults to the agent
   * name when supplied; otherwise OTel's resource detection wins.
   */
  readonly serviceName?: string;
}

/**
 * Build an OTLP/HTTP exporter pointing at the standard OTel env-var
 * endpoint. Returns null when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is
 * unset — caller should not register the sink in that case.
 *
 * Lives in its own export so consumers can opt out of the heavyweight
 * SDK initialization for unit testing while still using the same
 * span-emission code paths.
 */
export function isOtelEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return typeof endpoint === 'string' && endpoint.length > 0;
}

export class OtelTraceSink implements TraceSink {
  private readonly tracer: Tracer;
  private readonly rootSpans = new Map<string, Span>();

  constructor(options: OtelTraceSinkOptions) {
    this.tracer = options.tracer;
  }

  emit(entry: TraceEntry): void {
    const root = this.ensureRootSpan(entry.run_id);
    const ctx = trace.setSpan(context.active(), root);

    if (entry.trace_type === 'iteration_boundary') {
      // Iteration boundaries are markers, not durations — record as a
      // span event on the root span.
      root.addEvent('iteration_boundary', {
        sequence: entry.sequence,
        iteration: entry.iteration ?? 0,
      });
      return;
    }

    if (entry.trace_type === 'llm_call') {
      const span = this.tracer.startSpan(
        'agent.llm.call',
        {
          attributes: {
            'kagent.run_id': entry.run_id,
            'kagent.sequence': entry.sequence,
            'kagent.latency_ms': entry.latency_ms,
            'kagent.input_tokens': entry.input_tokens_est ?? 0,
            'kagent.output_tokens': entry.output_tokens_est ?? 0,
            ...(entry.model !== undefined && { 'kagent.model': entry.model }),
            ...(entry.cost_usd !== undefined &&
              entry.cost_usd !== null && {
                'kagent.cost_usd': entry.cost_usd,
              }),
            ...(entry.stop_reason !== undefined && { 'kagent.stop_reason': entry.stop_reason }),
          },
        },
        ctx,
      );
      span.end();
      return;
    }

    if (entry.trace_type === 'tool_call') {
      const name = entry.tool_name ?? 'unknown';
      const span = this.tracer.startSpan(
        `agent.tool.call.${name}`,
        {
          attributes: {
            'kagent.run_id': entry.run_id,
            'kagent.sequence': entry.sequence,
            'kagent.latency_ms': entry.latency_ms,
            'kagent.tool_name': name,
            ...(entry.tool_input !== undefined && {
              'kagent.tool_input.preview': previewString(entry.tool_input),
            }),
            ...(entry.tool_output !== undefined && {
              'kagent.tool_output.preview': previewString(entry.tool_output),
            }),
            ...(entry.is_error !== undefined && { 'kagent.is_error': entry.is_error }),
          },
        },
        ctx,
      );
      if (entry.is_error === true) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: entry.error ?? 'tool error',
        });
      }
      span.end();
      return;
    }
  }

  /** Closes any outstanding root spans. Safe to call multiple times. */
  flush(): Promise<void> {
    for (const span of this.rootSpans.values()) {
      span.end();
    }
    this.rootSpans.clear();
    return Promise.resolve();
  }

  /** Same as flush() — TraceSink contract has both. */
  close(): Promise<void> {
    return this.flush();
  }

  private ensureRootSpan(runId: string): Span {
    let root = this.rootSpans.get(runId);
    if (root === undefined) {
      root = this.tracer.startSpan('agent.run', {
        attributes: { 'kagent.run_id': runId },
      });
      this.rootSpans.set(runId, root);
    }
    return root;
  }
}

function previewString(s: string, limit = 256): string {
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…(truncated ${s.length - limit} chars)`;
}

/**
 * Convenience: register a global OTel SDK with an OTLP/HTTP exporter
 * pointed at OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, and return a Tracer
 * + a `shutdown()` that flushes the batch processor.
 *
 * Lives outside the OtelTraceSink class so a single agent pod can
 * call it once on boot and pass the resulting tracer to multiple
 * sink instances if needed.
 */
export async function setupOtelExporter(options?: {
  serviceName?: string;
}): Promise<{ tracer: Tracer; shutdown: () => Promise<void> }> {
  const { NodeTracerProvider, BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options?.serviceName ?? 'kagent-agent-pod',
  });

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  const tracer = trace.getTracer(TRACER_NAME);

  return {
    tracer,
    shutdown: async (): Promise<void> => {
      await provider.shutdown();
    },
  };
}
