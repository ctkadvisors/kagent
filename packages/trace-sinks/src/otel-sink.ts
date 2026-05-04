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
 *   - LLM calls map to spans named `agent.llm.call` carrying the
 *     Langfuse + OTel-GenAI semconv attributes
 *     (`langfuse.observation.type='generation'`,
 *     `gen_ai.operation.name='chat'`, model + usage + cost) so
 *     Langfuse renders them as first-class generations rather than
 *     opaque generic spans.
 *   - Tool calls map to `execute_tool <toolName>` spans (per OTel
 *     GenAI semconv) with `gen_ai.tool.*` + `langfuse.observation.*`
 *     attributes.
 *   - The `run_complete` finalization entry stamps trace-level
 *     Langfuse fields (final output, totals, terminal status) onto
 *     the root span and ends it.
 *   - Iteration boundaries map to span events on the root span, NOT
 *     separate spans (they're zero-duration markers).
 *   - Per-run trace-level metadata (agent name, task uid, namespace,
 *     sandbox profile) is sourced via the `runContext` constructor
 *     option — the executor itself doesn't know these, so the
 *     agent-pod (which constructs the sink) feeds them in.
 *   - Content capture is governed by `contentMode`
 *     (`none|preview|full`); see `langfuse-otel-format.ts` for the
 *     truncation policy. `artifact-ref` mode is reserved (depends on
 *     Phase 5 P3 artifact writer).
 *   - The provider is created lazily on first emit so unit tests can
 *     inject a stubbed processor; production uses the OTel SDK's
 *     `BatchSpanProcessor` + `OTLPTraceExporter`.
 *   - When `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is unset, the sink
 *     no-ops (emits nothing) — keeps local dev silent without forcing
 *     callers to gate the sink behind their own conditional.
 *
 * Reshape rationale (was the WS-D follow-up "second red item"):
 * pre-reshape, the sink emitted only `kagent.*`-keyed attributes,
 * which Langfuse rendered as opaque generic spans — not first-class
 * generations / tool executions. WS-D landed deterministic trace IDs
 * (navigation primitive); this reshape lands the *payload shape* so
 * the trace itself is useful evidence. `kagent.*` attributes still
 * ship as secondary debug metadata so existing log-grep workflows +
 * the WS-D determinism tests remain valid.
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
import {
  DEFAULT_CONTENT_MODE,
  formatLlmCallAttrs,
  formatRootSpanAttrs,
  formatRunCompleteAttrs,
  formatToolCallAttrs,
  type ContentMode,
  type RunContext,
} from './langfuse-otel-format.js';

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
 * v0.1.11 — derive a deterministic 16-char lowercase-hex OTel span ID
 * for the *root* `agent.run` span of a given `runId`. Companion to
 * `traceIdFromRunId`: the trace ID consumes the first 16 bytes of
 * `sha256(runId)`; the root-span ID consumes the SECOND 16 bytes
 * (truncated to 8 bytes / 16 hex chars). Disjoint byte ranges so an
 * observer can never confuse one for the other.
 *
 * Determinism is the goal: when the parent agent-pod's
 * `spawn_child_task` issues a child AgentTask, it stamps a
 * `traceparent` derived via `buildTraceparentFromRunId(parentRunId)`
 * onto the child spec. The child's agent-pod parses that traceparent
 * and seeds its OtelTraceSink root span context with it. Because both
 * sides arrive at the same span ID via the same hash, the child's
 * `agent.run` span genuinely lands as a child of the parent's
 * `agent.run` span in Langfuse / Tempo / Jaeger — no coordination
 * channel required.
 */
export function spanIdFromRunId(runId: string): string {
  // Bytes 16..24 of sha256(runId) → 16 hex chars.
  return createHash('sha256').update(runId).digest('hex').slice(32, 48);
}

/**
 * v0.1.11 — build the W3C v00 traceparent header value for a given
 * substrate `runId`. Format:
 *
 *     00-<32 hex traceId>-<16 hex spanId>-01
 *
 * Sampled flag (`01`) is hard-pinned: the substrate either traces or
 * doesn't (governed by `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` presence);
 * partial sampling is out of scope for v0.1. When the substrate isn't
 * tracing, the parent agent-pod simply doesn't stamp `runConfig.traceparent`
 * on the child spec — there's no "header for an unsampled run" case.
 */
export function buildTraceparentFromRunId(runId: string): string {
  return `00-${traceIdFromRunId(runId)}-${spanIdFromRunId(runId)}-01`;
}

export interface ParsedTraceparent {
  readonly version: '00';
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

/**
 * v0.1.11 — parse a W3C v00 traceparent string into its constituent
 * fields. Returns `undefined` for any malformed input (wrong shape,
 * non-hex chars, all-zero IDs which W3C reserves as invalid). The
 * agent-pod's main.ts uses this to validate `OTEL_TRACEPARENT` env
 * before feeding the parsed context into OtelTraceSink — a malformed
 * env value lands at "ignore + log" rather than "fail boot" so a
 * mis-stamped traceparent can't gate a child task from running.
 */
export function parseTraceparent(value: string): ParsedTraceparent | undefined {
  if (typeof value !== 'string') return undefined;
  // 2 + 1 + 32 + 1 + 16 + 1 + 2 = 55 chars exactly for v00.
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (m === null) return undefined;
  if (m[1] !== '00') return undefined;
  const traceId = m[2] ?? '';
  const spanId = m[3] ?? '';
  // W3C: all-zero IDs are reserved as invalid.
  if (/^0+$/.test(traceId)) return undefined;
  if (/^0+$/.test(spanId)) return undefined;
  return {
    version: '00',
    traceId,
    spanId,
    traceFlags: parseInt(m[4] ?? '00', 16),
  };
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
  /**
   * Per-run metadata stamped onto the root `agent.run` span as
   * Langfuse trace-level fields. Sourced from the agent-pod's
   * operator-injected env (agent name, task uid, namespace, sandbox
   * profile).
   */
  readonly runContext?: RunContext;
  /**
   * Content-capture policy for input/output bodies attached to
   * generation + tool spans. Defaults to `'preview'` so production
   * traces aren't silently shipping full prompts to Langfuse — opt
   * into `'full'` explicitly via env when you want them.
   */
  readonly contentMode?: ContentMode;
  /**
   * v0.1.11 — W3C Trace Context parent. When set, the sink starts each
   * `agent.run` root span as a CHILD of this remote SpanContext rather
   * than seeding from the runId-derived deterministic ID. Threaded in
   * by the agent-pod's main.ts when `OTEL_TRACEPARENT` env is present
   * (which the operator's job-spec builder threads from
   * `AgentTask.spec.runConfig.traceparent` — a value the parent
   * agent-pod's `spawn_child_task` stamped). Effect: the child task's
   * trace tree becomes a child of the parent's trace, not a sibling
   * with its own root.
   *
   * When undefined, behavior is the pre-v0.1.11 deterministic-from-runId
   * path — root tasks remain root-of-their-own-trace.
   */
  readonly parentSpanContext?: {
    readonly traceId: string;
    readonly spanId: string;
  };
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
  private readonly runContext: RunContext | undefined;
  private readonly contentMode: ContentMode;
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
  /**
   * v0.1.11 — W3C Trace Context parent supplied at construction time.
   * Captured here (instead of read off options each emit) so the call
   * path stays cheap.
   */
  private readonly parentSpanContext:
    | { readonly traceId: string; readonly spanId: string }
    | undefined;

  constructor(options: OtelTraceSinkOptions) {
    this.tracer = options.tracer;
    this.runContext = options.runContext;
    this.contentMode = options.contentMode ?? DEFAULT_CONTENT_MODE;
    this.parentSpanContext = options.parentSpanContext;
  }

  /**
   * Public: look up the deterministic OTel trace ID we used (or would
   * use) for a given `runId`. Callers building "View trace" URLs from
   * a runId go through this method so they always get the same id the
   * span tree was emitted under, regardless of whether the SDK
   * honored the remote-parent context we passed to `startSpan()`.
   *
   * v0.1.11 — when a `parentSpanContext` was supplied at construction,
   * the sink threads the parent's trace ID into `agent.run` so the
   * child run lands inside the parent's trace tree. This method
   * therefore returns the PARENT trace ID (not the runId-derived one)
   * whenever a parent is wired — that's the correct id for "View trace"
   * deep links to resolve to the unified parent+child tree in Langfuse.
   */
  traceIdFor(runId: string): string {
    const cached = this.derivedTraceIds.get(runId);
    if (cached !== undefined) return cached;
    const id = this.parentSpanContext?.traceId ?? traceIdFromRunId(runId);
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

    if (entry.trace_type === 'run_complete') {
      // Stamp final-state attrs on the root span and end it. The
      // executor's flush loop still calls flush() afterwards; that's
      // a safe no-op once the root is closed (Span.end() is
      // idempotent in the OTel SDK and flush() simply iterates open
      // root spans).
      const attrs = formatRunCompleteAttrs(entry, this.contentMode);
      root.setAttributes(attrs);
      if (entry.final_status !== undefined && entry.final_status !== 'completed') {
        root.setStatus({
          code: SpanStatusCode.ERROR,
          message: `run ${entry.final_status}`,
        });
      }
      root.end();
      this.rootSpans.delete(entry.run_id);
      return;
    }

    if (entry.trace_type === 'llm_call') {
      const attrs = formatLlmCallAttrs(entry, this.contentMode);
      const span = this.tracer.startSpan('agent.llm.call', { attributes: attrs }, ctx);
      span.end();
      return;
    }

    if (entry.trace_type === 'tool_call') {
      const { spanName, attributes } = formatToolCallAttrs(entry, this.contentMode);
      const span = this.tracer.startSpan(spanName, { attributes }, ctx);
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
      // v0.1.11 — branch on whether a W3C parent was supplied:
      //   - Parent supplied → seed the remote parent SpanContext with
      //     the parent's traceId + spanId. The child's `agent.run`
      //     starts as a real child of the parent's span; the child's
      //     subsequent llm/tool spans inherit transitively.
      //   - No parent → original deterministic-from-runId behavior.
      //
      // Either way we still go through `traceIdFor()` so the cache
      // stays the single source of truth for provider-link construction.
      let traceId: string;
      let spanId: string;
      if (this.parentSpanContext !== undefined) {
        traceId = this.parentSpanContext.traceId;
        spanId = this.parentSpanContext.spanId;
        // Seed the cache so traceIdFor() returns the parent's id.
        this.derivedTraceIds.set(runId, traceId);
      } else {
        traceId = this.traceIdFor(runId);
        spanId = randomBytes(8).toString('hex');
      }
      const parentCtx = trace.setSpanContext(context.active(), {
        traceId,
        spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });
      root = this.tracer.startSpan(
        'agent.run',
        {
          attributes: formatRootSpanAttrs(runId, this.runContext),
        },
        parentCtx,
      );
      this.rootSpans.set(runId, root);
    }
    return root;
  }
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
