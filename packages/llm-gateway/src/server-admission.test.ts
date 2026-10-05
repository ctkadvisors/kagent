/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { AimdController } from './aimd.js';
import { hashApiKey } from './auth.js';
import { InFlightCounter } from './inflight-counter.js';
import { ModelIndex } from './model-index.js';
import { buildHandler, type ServerDeps } from './server.js';
import { createLongFetch } from './long-fetch.js';
import type { UsageEvent } from './usage-recorder.js';

async function setup(timeoutMs = 2000) {
  const started: string[] = [],
    closed: string[] = [];
  const replies = new Map<string, ServerResponse>();
  const backend = createServer((req, res) => {
    let body = '';
    req.on('data', (data: Buffer) => {
      body += data.toString();
    });
    req.on('end', () => {
      const id = (JSON.parse(body) as { messages: { content: string }[] }).messages[0]!.content;
      started.push(id);
      replies.set(id, res);
      res.on('close', () => {
        closed.push(id);
      });
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const modelIndex = new ModelIndex();
  modelIndex.upsert({
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ModelEndpoint',
    metadata: { name: 'm' },
    spec: {
      model: 'm',
      backendKind: 'localai',
      backendUrl,
      inFlight: { seed: 1, max: 3 },
      minSafe: 1,
    },
  });
  const inFlight = new InFlightCounter(),
    aimd = new AimdController({ seed: 1, max: 3, minSafe: 1 });
  const events: UsageEvent[] = [];
  const handler = buildHandler({
    modelIndex,
    inFlight,
    aimd,
    routerDeps: {
      modelIndex,
      inFlight,
      aimd,
      requestTimeoutMs: timeoutMs,
      usage: {
        record: (event) => {
          events.push(event);
          return Promise.resolve();
        },
      },
      providerFactoryOpts: { fetchImpl: createLongFetch({ maxMs: 2000, idleMs: 2000 }) },
    },
    apiKeyLookup: () =>
      Promise.resolve({
        keyHash: hashApiKey('sk-test-key'),
        keyPrefix: 'test',
        status: 'active',
        expiresAt: null,
      }),
    apiKeyRepo: { touchLastUsed: () => Promise.resolve() } as ServerDeps['apiKeyRepo'],
    usageRepo: { query: () => Promise.resolve([]) } as unknown as ServerDeps['usageRepo'],
    adminToken: 'admin',
    readinessProbe: () => Promise.resolve(true),
    ssePingMs: 10,
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.destroyed) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function call(
    id: string,
    opts: { signal?: AbortSignal; stream?: boolean; timeout?: number } = {},
  ) {
    const pending = fetch(url + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-key',
        'content-type': 'application/json',
        ...(opts.timeout && { 'x-kagent-request-timeout-ms': String(opts.timeout) }),
      },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: id }],
        stream: opts.stream ?? false,
      }),
      ...(opts.signal && { signal: opts.signal }),
    });
    void pending.catch(() => {});
    return pending;
  }
  function finish(id: string) {
    replies
      .get(id)
      ?.writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created: 1,
          model: 'm',
          choices: [
            { index: 0, message: { role: 'assistant', content: id }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
  }
  async function close() {
    server.closeAllConnections();
    backend.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => backend.close(() => resolve())),
    ]);
  }
  return { started, closed, events, backendUrl, inFlight, aimd, call, finish, close, url };
}

describe('real HTTP inference admission', () => {
  it('queues JSON and SSE callers FIFO and observes live AIMD capacity', async () => {
    const s = await setup();
    try {
      const a = s.call('a');
      await vi.waitFor(() => expect(s.started).toEqual(['a']));
      const b = s.call('b');
      const c = await s.call('c', { stream: true });
      const cBody = c.text();
      void cBody.catch(() => {});
      expect(c.status).toBe(200);
      expect(s.started).toEqual(['a']);
      const cap = await fetch(s.url + '/admin/capacity', {
        headers: { authorization: 'Bearer admin' },
      });
      const capacity = (await cap.json()) as { rows: { queued: number; inFlight: number }[] };
      expect(capacity.rows[0]).toMatchObject({ queued: 2, inFlight: 1 });
      s.aimd.updateBounds('m', s.backendUrl, { seed: 2, max: 3, minSafe: 2 });
      await vi.waitFor(() => expect(s.started).toEqual(['a', 'b']));
      s.finish('b');
      expect((await b).status).toBe(200);
      await vi.waitFor(() => expect(s.started).toEqual(['a', 'b', 'c']));
      s.finish('c');
      expect(await cBody).toContain('[DONE]');
      s.finish('a');
      expect((await a).status).toBe(200);
      expect(s.inFlight.current('m', s.backendUrl)).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('disconnect removes a waiter and aborts an active backend without leaking its permit', async () => {
    const s = await setup();
    try {
      const ca = new AbortController();
      const a = s.call('a', { signal: ca.signal }).catch(() => null);
      await vi.waitFor(() => expect(s.started).toEqual(['a']));
      const cb = new AbortController();
      const b = s.call('b', { signal: cb.signal }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 30));
      cb.abort();
      await b;
      await vi.waitFor(() => expect(s.events.some((e) => e.statusCode === 499)).toBe(true));
      ca.abort();
      await a;
      await vi.waitFor(() => expect(s.closed).toContain('a'));
      const c = s.call('c');
      await vi.waitFor(() => expect(s.started).toEqual(['a', 'c']));
      s.finish('c');
      expect((await c).status).toBe(200);
      expect(s.inFlight.current('m', s.backendUrl)).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('caller timeout includes its queue wait and aborts the remaining backend execution', async () => {
    const s = await setup();
    try {
      const a = s.call('a');
      await vi.waitFor(() => expect(s.started).toEqual(['a']));
      const b = s.call('b', { timeout: 180 });
      await new Promise((resolve) => setTimeout(resolve, 90));
      s.finish('a');
      await a;
      await vi.waitFor(() => expect(s.started).toContain('b'));
      const result = await b;
      expect(result.status).toBe(504);
      await vi.waitFor(() => expect(s.closed).toContain('b'));
      expect(s.inFlight.current('m', s.backendUrl)).toBe(0);
      expect(s.events.find((e) => e.statusCode === 504)).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
      });
    } finally {
      await s.close();
    }
  });
});
