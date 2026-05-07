/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * M16 — per-user + global SSE connection caps. We don't test the
 * full streaming response here (that needs a real Node server +
 * EventSource); instead we lock the admission path: 6th request from
 * the same user gets 429 when perUserLimit=5, 1001st request total
 * gets 503 when totalLimit=1000.
 *
 * The handler returns immediately on cap-reject (no streamSSE).
 * Otherwise it enters Hono's streaming handler which keeps the
 * promise pending until `stream.onAbort` fires; we test reject paths
 * by hitting caps before any successful subscribe.
 */

import { describe, expect, it } from 'vitest';

import { SnapshotCache } from '../cache.js';
import { SseBroker } from '../sse.js';
import { streamRoute } from './stream.js';

function reqAs(user: string | null): Request {
  const headers: Record<string, string> = {};
  if (user !== null) headers['X-Forwarded-User'] = user;
  return new Request('http://test/api/stream', { method: 'GET', headers });
}

describe('stream.ts — M16 SSE connection caps', () => {
  it('rejects 6th concurrent connection from the same user with 429 (perUserLimit=5)', async () => {
    const cache = new SnapshotCache();
    const broker = new SseBroker(cache);
    const app = streamRoute({
      broker,
      // Disable timer so the streamSSE handler doesn't actually fire
      // setInterval; the slot stays reserved as long as the response
      // body promise is pending — same behavior as production.
      setInterval: () => 0,
      clearInterval: () => undefined,
      perUserLimit: 5,
      totalLimit: 0, // disable global so we test perUser in isolation
    });
    // Open 5 connections from `alice` — each enters streamSSE; the
    // returned Response is a pending stream we don't have to read.
    const opened: Response[] = [];
    for (let i = 0; i < 5; i++) {
      opened.push(await app.request(reqAs('alice')));
    }
    expect(opened.every((r) => r.status === 200)).toBe(true);

    // 6th from alice → 429.
    const sixth = await app.request(reqAs('alice'));
    expect(sixth.status).toBe(429);
    const body = (await sixth.json()) as { error: string };
    expect(body.error).toBe('sse-per-user-cap');

    // Different user (bob) is unaffected by alice's count.
    const bobFirst = await app.request(reqAs('bob'));
    expect(bobFirst.status).toBe(200);

    // Cancel alice's first 5 to release the slots.
    for (const r of opened) await r.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Now the next alice request should be admitted.
    const after = await app.request(reqAs('alice'));
    expect(after.status).toBe(200);
    await after.body?.cancel();
    await bobFirst.body?.cancel();
  });

  it('rejects connection past the global totalLimit with 503', async () => {
    const cache = new SnapshotCache();
    const broker = new SseBroker(cache);
    const app = streamRoute({
      broker,
      setInterval: () => 0,
      clearInterval: () => undefined,
      perUserLimit: 0, // disable per-user so we test global in isolation
      totalLimit: 3,
    });
    const a = await app.request(reqAs('alice'));
    const b = await app.request(reqAs('bob'));
    const c = await app.request(reqAs('carol'));
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);

    const d = await app.request(reqAs('dave'));
    expect(d.status).toBe(503);
    const body = (await d.json()) as { error: string };
    expect(body.error).toBe('sse-total-cap');

    // Release one slot.
    await a.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const e = await app.request(reqAs('eve'));
    expect(e.status).toBe(200);
    await b.body?.cancel();
    await c.body?.cancel();
    await e.body?.cancel();
  });

  it('admits anonymous connections under <anonymous> bucket when no header is present', async () => {
    const cache = new SnapshotCache();
    const broker = new SseBroker(cache);
    const app = streamRoute({
      broker,
      setInterval: () => 0,
      clearInterval: () => undefined,
      perUserLimit: 1,
      totalLimit: 0,
    });
    const a = await app.request(reqAs(null));
    expect(a.status).toBe(200);
    // 2nd anonymous request → cap (single bucket).
    const b = await app.request(reqAs(null));
    expect(b.status).toBe(429);
    await a.body?.cancel();
    await b.body?.cancel();
  });

  it('disables enforcement when both limits are 0 (back-compat)', async () => {
    const cache = new SnapshotCache();
    const broker = new SseBroker(cache);
    const app = streamRoute({
      broker,
      setInterval: () => 0,
      clearInterval: () => undefined,
      perUserLimit: 0,
      totalLimit: 0,
    });
    const open: Response[] = [];
    for (let i = 0; i < 50; i++) open.push(await app.request(reqAs('flood')));
    expect(open.every((r) => r.status === 200)).toBe(true);
    for (const r of open) await r.body?.cancel();
  });
});
