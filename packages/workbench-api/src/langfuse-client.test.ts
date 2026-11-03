/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { LangfuseTraceReader } from './langfuse-client.js';

function observation(sequence: number, runId = 'run', padding = 160_000) {
  return {
    id: `${runId}-${sequence}`,
    input: { code: `step ${sequence}`, password: 'private-value' },
    output: `result ${sequence}`,
    metadata: {
      padding: 'x'.repeat(padding),
      attributes: { 'kagent.run_id': runId, 'kagent.sequence': sequence },
    },
  };
}
function reader(fetch: typeof globalThis.fetch) {
  return new LangfuseTraceReader({
    baseUrl: 'http://langfuse',
    publicKey: 'pk',
    secretKey: 'sk',
    fetch,
  });
}
const input = { traceId: 'trace', runId: 'run', afterSequence: -1, limit: 2 };

function pagedFetch(rows: unknown[], requests: URL[]): typeof globalThis.fetch {
  return (url) => {
    const parsed = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    requests.push(parsed);
    if (parsed.pathname.startsWith('/api/public/traces/'))
      return Promise.resolve(new Response(JSON.stringify({ observations: rows })));
    const limit = Number(parsed.searchParams.get('limit'));
    const page = Number(parsed.searchParams.get('page'));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: rows.slice((page - 1) * limit, page * limit),
          meta: {
            page,
            limit,
            totalItems: rows.length,
            totalPages: Math.ceil(rows.length / limit),
          },
        }),
      ),
    );
  };
}

describe('bounded Langfuse observations', () => {
  it('reads and sequences a retained trace beyond 8 MiB without fetching the entire trace', async () => {
    const rows = [
      observation(999, 'parent'),
      ...Array.from({ length: 60 }, (_, i) => observation(59 - i)),
    ];
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(8 * 1024 * 1024);
    const requests: URL[] = [];
    const traceReader = reader(pagedFetch(rows, requests));
    const first = await traceReader.read(input);
    expect(first.state).toBe('observed');
    expect(first.events.map((e) => e.sequence)).toEqual([0, 1]);
    expect(first.nextSequence).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(JSON.stringify(first)).not.toContain('private-value');
    const last = await traceReader.read({ ...input, afterSequence: 58 });
    expect(last.events.map((e) => e.sequence)).toEqual([59]);
    expect(last.hasMore).toBe(false);
    const exhausted = await traceReader.read({ ...input, afterSequence: 59 });
    expect(exhausted.state).toBe('observed');
    expect(exhausted.events).toEqual([]);
    expect(requests.every((url) => url.pathname === '/api/public/observations')).toBe(true);
    expect(requests.every((url) => url.searchParams.get('traceId') === 'trace')).toBe(true);
    expect(requests.some((url) => Number(url.searchParams.get('page')) > 1)).toBe(true);
  });

  it('shrinks oversized pages without skipping observations', async () => {
    const rows = Array.from({ length: 18 }, (_, i) => observation(17 - i, 'run', 512_000));
    const requests: URL[] = [];
    const result = await reader(pagedFetch(rows, requests)).read({ ...input, limit: 100 });
    expect(result.state).toBe('observed');
    expect(result.events.map((e) => e.sequence)).toEqual(Array.from({ length: 18 }, (_, i) => i));
    expect(result.hasMore).toBe(false);
    expect(new Set(requests.map((url) => url.searchParams.get('limit'))).size).toBeGreaterThan(1);
  });

  it('does not report a partial successful trace when a later page fails', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => observation(i, 'run', 0));
    const requests: URL[] = [];
    const fetchPage = pagedFetch(rows, requests);
    const result = await reader((url, init) => {
      if (
        new URL(
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        ).searchParams.get('page') === '2'
      )
        return Promise.resolve(new Response('private-value', { status: 503 }));
      return fetchPage(url, init);
    }).read(input);
    expect(result.state).toBe('unavailable');
    expect(result.events).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-value');
  });
});

it('deduplicates observations repeated across upstream offset pages', async () => {
  const result = await reader((url) => {
    const parsed = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    const page = Number(parsed.searchParams.get('page'));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: (page === 1 ? [0, 2] : [0, 1]).map((sequence) => observation(sequence, 'run', 0)),
          meta: { page, limit: 50, totalPages: 2 },
        }),
      ),
    );
  }).read(input);
  expect(result.events.map((e) => e.sequence)).toEqual([0, 1]);
  expect(result.hasMore).toBe(true);
});

it('keeps the byte bound when an individual observation is oversized', async () => {
  const requests: URL[] = [];
  const result = await reader(pagedFetch([observation(0, 'run', 8 * 1024 * 1024)], requests)).read(
    input,
  );
  expect(result.state).toBe('unavailable');
  expect(result.reason).toBe('trace-response-too-large');
  expect(result.events).toEqual([]);
  expect(requests.at(-1)?.searchParams.get('limit')).toBe('1');
});
