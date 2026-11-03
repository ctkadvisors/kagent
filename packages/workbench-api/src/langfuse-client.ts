/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { scrubDiagnostic, scrubSchemaDiagnostic } from './diagnostic-data.js';

export interface DiagnosticEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly timestamp?: string;
  readonly operationState: string;
  readonly tool?: string;
  readonly model?: string;
  readonly arguments?: unknown;
  readonly inputSchema?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly isError: boolean;
  readonly usage?: unknown;
  readonly operationId?: string;
  readonly finalStatus?: string;
  readonly hitIterationCap?: boolean;
  readonly retryAttempt?: number;
  readonly retryBackoffMs?: number;
}
export interface TraceReadResult {
  readonly state: 'observed' | 'pending' | 'unavailable';
  readonly source: 'langfuse';
  readonly events: readonly DiagnosticEvent[];
  readonly reason?: string;
  readonly nextSequence: number;
  readonly hasMore: boolean;
}
export interface TaskTraceReader {
  read(input: {
    traceId: string;
    runId: string;
    afterSequence: number;
    limit: number;
  }): Promise<TraceReadResult>;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function event(value: unknown, runId: string): DiagnosticEvent | undefined {
  const o = record(value);
  const attrs = record(record(o.metadata).attributes);
  if (attrs['kagent.run_id'] !== runId) return undefined;
  const sequence = Number(attrs['kagent.sequence']);
  if (!Number.isSafeInteger(sequence) || sequence < 0) return undefined;
  const tool = attrs['kagent.tool_name'];
  const input = attrs['kagent.diagnostic.input'] ?? o.input;
  const output = attrs['kagent.diagnostic.output'] ?? o.output;
  const error =
    attrs['kagent.diagnostic.error'] ?? (o.level === 'ERROR' ? o.statusMessage : undefined);
  return {
    id: typeof o.id === 'string' ? o.id : String(sequence),
    sequence,
    type:
      typeof attrs['kagent.trace_type'] === 'string'
        ? attrs['kagent.trace_type']
        : tool !== undefined
          ? 'tool_call'
          : 'llm_call',
    operationState:
      typeof attrs['kagent.operation_state'] === 'string'
        ? attrs['kagent.operation_state']
        : 'completed',
    ...(typeof o.startTime === 'string' && { timestamp: o.startTime }),
    ...(typeof tool === 'string' && { tool }),
    ...(typeof o.model === 'string' && { model: o.model }),
    ...(attrs['kagent.diagnostic.schema'] !== undefined && {
      inputSchema: scrubSchemaDiagnostic(attrs['kagent.diagnostic.schema']),
    }),
    ...(input !== undefined && { arguments: scrubDiagnostic(input) }),
    ...(output !== undefined && { result: scrubDiagnostic(output) }),
    ...(error !== undefined && error !== null && { error: scrubDiagnostic(error) }),
    ...(typeof attrs['kagent.operation_id'] === 'string' && {
      operationId: attrs['kagent.operation_id'],
    }),
    ...(typeof attrs['kagent.final_status'] === 'string' && {
      finalStatus: attrs['kagent.final_status'],
    }),
    ...(typeof attrs['kagent.hit_iteration_cap'] === 'boolean' && {
      hitIterationCap: attrs['kagent.hit_iteration_cap'],
    }),
    ...(typeof attrs['kagent.retry_attempt'] === 'number' && {
      retryAttempt: attrs['kagent.retry_attempt'],
    }),
    ...(typeof attrs['kagent.retry_backoff_ms'] === 'number' && {
      retryBackoffMs: attrs['kagent.retry_backoff_ms'],
    }),
    isError: o.level === 'ERROR' || attrs['kagent.is_error'] === true,
    ...(o.usage !== undefined && { usage: o.usage }),
  };
}
/**
 * The installed Langfuse v3 observations API supports traceId + page/limit.
 * Page upstream before selecting the requested run/sequence window: a trace
 * GET duplicates every input/output and grows beyond the transport byte bound.
 */
export class LangfuseTraceReader implements TaskTraceReader {
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly authorization: string;
  constructor(options: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
    fetch?: typeof globalThis.fetch;
  }) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('invalid Langfuse API URL');
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.authorization =
      'Basic ' + Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64');
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  async read(input: {
    traceId: string;
    runId: string;
    afterSequence: number;
    limit: number;
  }): Promise<TraceReadResult> {
    const empty = {
      source: 'langfuse' as const,
      events: [],
      nextSequence: input.afterSequence,
      hasMore: false,
    };
    try {
      const signal = AbortSignal.timeout(10_000);
      let pageSize = 50;
      let page = 1;
      let observed = false;
      let matching: DiagnosticEvent[] = [];
      while (true) {
        signal.throwIfAborted();
        const url = new URL(`${this.baseUrl}/api/public/observations`);
        url.searchParams.set('traceId', input.traceId);
        url.searchParams.set('page', String(page));
        url.searchParams.set('limit', String(pageSize));
        const response = await this.fetch(url.href, {
          headers: { Authorization: this.authorization, Accept: 'application/json' },
          signal,
          redirect: 'error',
        });
        if (response.status === 404)
          return { ...empty, state: 'pending', reason: 'trace-not-ingested' };
        if (!response.ok)
          return { ...empty, state: 'unavailable', reason: `trace-http-${response.status}` };
        const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
          response.body?.getReader();
        if (reader === undefined)
          return { ...empty, state: 'pending', reason: 'empty-trace-response' };
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 8 * 1024 * 1024) {
              await reader.cancel();
              break;
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        if (size > 8 * 1024 * 1024) {
          if (pageSize === 1)
            return { ...empty, state: 'unavailable', reason: 'trace-response-too-large' };
          // Offset pages depend on the page size. Restart to avoid skipping rows.
          pageSize = Math.max(1, Math.floor(pageSize / 2));
          page = 1;
          observed = false;
          matching = [];
          continue;
        }
        const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        const meta = record(body.meta);
        if (
          !Array.isArray(body.data) ||
          meta.page !== page ||
          meta.limit !== pageSize ||
          !Number.isSafeInteger(meta.totalPages) ||
          Number(meta.totalPages) < 0
        )
          return { ...empty, state: 'unavailable', reason: 'invalid-trace-response' };
        // Langfuse orders by start time, not kagent.sequence. Scan every upstream
        // page, retaining only the smallest limit+1 events after the cursor.
        for (const observation of body.data) {
          const e = event(observation, input.runId);
          if (e === undefined) continue;
          observed = true;
          if (e.sequence <= input.afterSequence) continue;
          if (matching.some((retained) => retained.id === e.id)) continue;
          matching.push(e);
          matching.sort((a, b) => a.sequence - b.sequence);
          if (matching.length > input.limit + 1) matching.pop();
        }
        if (page >= Number(meta.totalPages)) break;
        page += 1;
      }
      const events = matching.slice(0, input.limit);
      return {
        ...empty,
        state: observed ? 'observed' : 'pending',
        events,
        nextSequence: events.at(-1)?.sequence ?? input.afterSequence,
        hasMore: matching.length > events.length,
      };
    } catch {
      // Request/error objects can carry the Authorization header. Keep them out of logs and responses.
      return { ...empty, state: 'unavailable', reason: 'trace-read-failed' };
    }
  }
}
