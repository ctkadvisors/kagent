/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { SnapshotCache } from '../cache.js';
import { taskDiagnosticsRoute } from './task-diagnostics.js';
import { LangfuseTraceReader } from '../langfuse-client.js';

interface Body {
  pod: { state: string };
  trace: {
    state: string;
    nextSequence: number;
    hasMore: boolean;
    events: { sequence: number; arguments: { code: string }; operationState: string }[];
  };
}
async function read(response: Response): Promise<Body> {
  return (await response.json()) as Body;
}

function cache() {
  const c = new SnapshotCache();
  c.upsertTask({
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'AgentTask',
    metadata: { name: 'failed', namespace: 'kagent-system', uid: 'task-uid' },
    spec: { targetAgent: 'fleet-auditor', runConfig: { maxIterations: 4 } },
    status: { phase: 'Failed', error: 'maxIterations', children: [] },
  });
  return c;
}
const observations = [2, 1, 3].map((sequence) => ({
  id: `o${sequence}`,
  name: 'execute_tool code',
  startTime: '2026-10-02T01:00:00Z',
  level: sequence === 2 ? 'ERROR' : 'DEFAULT',
  input: { code: 'x'.repeat(1400), password: 'private-value' },
  output: `result ${sequence}`,
  metadata: {
    attributes: {
      'kagent.run_id': 'task-uid',
      'kagent.sequence': sequence,
      'kagent.tool_name': 'code',
      'kagent.operation_state': sequence === 3 ? 'started' : 'completed',
    },
  },
}));

describe('task diagnostics', () => {
  it('reads retained exact task events after pod GC, pages by sequence and masks credentials', async () => {
    const reader = new LangfuseTraceReader({
      baseUrl: 'http://langfuse',
      publicKey: 'pk',
      secretKey: 'secret',
      fetch: () => Promise.resolve(new Response(JSON.stringify({ observations }), { status: 200 })),
    });
    const app = taskDiagnosticsRoute({ cache: cache(), traceReader: reader });
    const first = await app.request('/api/tasks/kagent-system/failed/diagnostics?limit=2');
    const body = await read(first);
    expect(first.status).toBe(200);
    expect(body.pod.state).toBe('gone');
    expect(body.trace.state).toBe('observed');
    expect(body.trace.events.map((e: { sequence: number }) => e.sequence)).toEqual([1, 2]);
    expect(body.trace.events[0].arguments.code).toHaveLength(1400);
    expect(JSON.stringify(body)).not.toContain('private-value');
    expect(body.trace.nextSequence).toBe(2);
    expect(body.trace.hasMore).toBe(true);
    const next = await app.request(
      '/api/tasks/kagent-system/failed/diagnostics?limit=2&afterSequence=2',
    );
    expect((await read(next)).trace.events[0].operationState).toBe('started');
  });
  it('reports absent traces as pending and outages as unavailable without leaking upstream response', async () => {
    for (const [status, state] of [
      [404, 'pending'],
      [503, 'unavailable'],
    ] as const) {
      const reader = new LangfuseTraceReader({
        baseUrl: 'http://langfuse',
        publicKey: 'pk',
        secretKey: 'secret',
        fetch: () => Promise.resolve(new Response('Authorization: Basic private-key', { status })),
      });
      const response = await taskDiagnosticsRoute({ cache: cache(), traceReader: reader }).request(
        '/api/tasks/kagent-system/failed/diagnostics',
      );
      const body = await read(response);
      expect(body.trace.state).toBe(state);
      expect(JSON.stringify(body)).not.toContain('private-key');
    }
  });
  it('rejects unbounded/invalid pagination and unknown tasks before trace access', async () => {
    const app = taskDiagnosticsRoute({ cache: cache() });
    expect((await app.request('/api/tasks/kagent-system/missing/diagnostics')).status).toBe(404);
    expect((await app.request('/api/tasks/kagent-system/failed/diagnostics?limit=0')).status).toBe(
      400,
    );
    expect(
      (await app.request('/api/tasks/kagent-system/failed/diagnostics?afterSequence=nan')).status,
    ).toBe(400);
    // Fleet HTTP tools render absent optional args as empty query values;
    // empty must mean "default", not 400 (and must not drop sequence 0).
    expect(
      (await app.request('/api/tasks/kagent-system/failed/diagnostics?afterSequence=&limit='))
        .status,
    ).toBe(200);
    expect(
      (await read(await app.request('/api/tasks/kagent-system/failed/diagnostics'))).trace.state,
    ).toBe('unavailable');
  });
  it('reads a child from its inherited trace, excluding its parent and siblings', async () => {
    const c = cache();
    const task = c.getTask('kagent-system', 'failed')!;
    c.upsertTask({
      ...task,
      spec: {
        ...task.spec,
        runConfig: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
      },
    });
    let requested = '';
    const reader = new LangfuseTraceReader({
      baseUrl: 'http://langfuse',
      publicKey: 'pk',
      secretKey: 'secret',
      fetch: async (url) => {
        await Promise.resolve();
        requested = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        return new Response(
          JSON.stringify({
            observations: [
              ...observations,
              {
                ...observations[0],
                metadata: { attributes: { 'kagent.run_id': 'other', 'kagent.sequence': 0 } },
              },
            ],
          }),
        );
      },
    });
    const response = await taskDiagnosticsRoute({ cache: c, traceReader: reader }).request(
      '/api/tasks/kagent-system/failed/diagnostics',
    );
    expect(requested).toContain('a'.repeat(32));
    expect((await read(response)).trace.events).toHaveLength(3);
  });
});

it('reads credential-named schema structure without exposing literal secrets or argument values', async () => {
  const schema = {
    type: 'object',
    required: ['token'],
    properties: {
      token: {
        type: 'string',
        default: 'legacy-default-private',
        examples: ['legacy-example-private'],
      },
    },
  };
  const reader = new LangfuseTraceReader({
    baseUrl: 'http://langfuse',
    publicKey: 'pk',
    secretKey: 'secret',
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            observations: [
              {
                ...observations[0],
                input: { token: 'legacy-argument-private' },
                metadata: {
                  attributes: {
                    ...observations[0].metadata.attributes,
                    'kagent.diagnostic.schema': JSON.stringify(schema),
                  },
                },
              },
            ],
          }),
        ),
      ),
  });
  const response = await taskDiagnosticsRoute({ cache: cache(), traceReader: reader }).request(
    '/api/tasks/kagent-system/failed/diagnostics',
  );
  const body = (await response.json()) as { trace: { events: { inputSchema: unknown }[] } };
  expect(body.trace.events[0].inputSchema).toMatchObject({
    required: ['token'],
    properties: { token: { type: 'string', examples: ['[REDACTED]'] } },
  });
  expect(JSON.stringify(body)).not.toContain('legacy-default-private');
  expect(JSON.stringify(body)).not.toContain('legacy-example-private');
  expect(JSON.stringify(body)).not.toContain('legacy-argument-private');
});
