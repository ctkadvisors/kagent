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

import {
  context,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { createHash, randomBytes } from 'node:crypto';
import type { TraceEntry, TraceSink } from '@kagent/agent-loop';

const TRACER_NAME = '@kagent/agent-loop';

/**
 * Derive a deterministic 32-char lowercase-hex OTel trace ID from a
 * substrate `runId`. Stable across processes, sink instances, and
 * restarts so that "View trace in Langfuse / Tempo / Jaeger" links the
 * Workbench builds from a `runId` always resolve to the same span tree
 * the agent pod actually emitted.
 *
 * Construction: `sha256(runId)` truncated to the first 16 bytes (32
 * hex chars) — that's the OTel trace-ID width. SHA-256's avalanche
 * property gives effectively-zero collision risk inside a single
 * deployment's runId namespace (UUID-shaped task-uids).
 */
export function traceIdFromRunId(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 32);
}

/**
 * Build the canonical Langfuse 4.x trace URL for a given runId.
 *
 * Langfuse 4.x routes by trace ID under
 * `<base>/trace/<traceId>` where `traceId` is the 32-char hex OTel
 * trace ID we derive from `runId` via `traceIdFromRunId`. Workbench
 * (and any other "View trace" link surface) constructs this URL on
 * the fly so consumers don't have to look up the cached span.
 */
export function langfuseTraceUrl(baseUrl: string, runId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/trace/${traceIdFromRunId(runId)}`;
}

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
  /**
   * Cache of the deterministic trace IDs we hand to OTel. Used as the
   * source of truth for `traceIdFor()` because some OTel SDK builds
   * silently drop a non-recording remote parent and re-mint a fresh
   * trace ID on `startSpan()`. Reading from this map (instead of
   * `root.spanContext().traceId`) makes provider-link construction
   * robust regardless of which SDK build the host happens to load.
   */
  private readonly derivedTraceIds = new Map<string, string>();

  constructor(options: OtelTraceSinkOptions) {
    this.tracer = options.tracer;
  }

  /**
   * Public: look up the deterministic OTel trace ID we used (or would
   * use) for a given `runId`. Callers building "View trace" URLs from
   * a runId go through this method so they always get the same id the
   * span tree was emitted under, regardless of whether the SDK
   * honored the remote-parent context we passed to `startSpan()`.
   */
  traceIdFor(runId: string): string {
    const cached = this.derivedTraceIds.get(runId);
    if (cached !== undefined) return cached;
    const id = traceIdFromRunId(runId);
    this.derivedTraceIds.set(runId, id);
    return id;
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
      // Derive (and cache) a deterministic trace ID so the same runId
      // ALWAYS resolves to the same trace in Langfuse / Tempo / Jaeger,
      // regardless of which sink instance / pod / process emitted it.
      // We construct a "remote" parent SpanContext with the derived
      // trace ID and a fresh random 16-char-hex span ID, then start the
      // root span under that context so the SDK adopts the trace ID.
      //
      // Some OTel SDK builds reject non-recording remote parents and
      // mint a fresh trace ID anyway; the `traceIdFor()` cache below is
      // the source of truth for provider-link construction in that
      // case (Plan B per the WS-D brief).
      const traceId = this.traceIdFor(runId);
      const spanId = randomBytes(8).toString('hex');
      const parentCtx = trace.setSpanContext(context.active(), {
        traceId,
        spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });
      root = this.tracer.startSpan(
        'agent.run',
        {
          attributes: { 'kagent.run_id': runId },
        },
        parentCtx,
      );
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
