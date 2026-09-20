/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLongFetch, type LongFetchInit } from './long-fetch.js';

let server: Server | undefined;

function serve(handler: (res: ServerResponse, body: string) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        handler(res, body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${String((server?.address() as AddressInfo).port)}/v1/chat`);
    });
  });
}

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

const post = (streaming: boolean): LongFetchInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
  body: '{"q":1}',
  streaming,
});

describe('createLongFetch', () => {
  it('returns a real Response: status, headers, the body, and sends the request body', async () => {
    const url = await serve((res, body) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end(JSON.stringify({ echoed: body }));
    });
    const res = await createLongFetch({ maxMs: 5000, idleMs: 5000 })(url, post(false));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(await res.json()).toEqual({ echoed: '{"q":1}' });
  });

  it('a slow backend that keeps writing outlives the idle timer many times over', async () => {
    // The 2026-09-20 shape: a long turn. Bytes (pings or tokens) every 50 ms, idle limit 600 ms,
    // total 1500 ms: the call lives 2.5 idle limits because it is never silent for one. (Wide
    // margins on purpose; the CI runner is a loaded Kata VM.) Under Node's fetch the
    // equivalent turn died at 300 s.
    const url = await serve((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const t = setInterval(() => {
        res.write(n % 2 === 0 ? ': ping\n\n' : `data: {"n":${String(n)}}\n\n`);
        if (++n === 30) {
          clearInterval(t);
          res.end('data: [DONE]\n\n');
        }
      }, 50);
    });
    const res = await createLongFetch({ maxMs: 10_000, idleMs: 600 })(url, post(true));
    const text = await res.text();
    expect(text).toContain('"n":29');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('a streamed call whose backend never answers fails on the idle timer', async () => {
    const url = await serve(() => undefined); // accepts, says nothing
    await expect(createLongFetch({ maxMs: 5000, idleMs: 80 })(url, post(true))).rejects.toThrow(
      /backend silent for 80 ms/,
    );
  });

  it('a backend that goes quiet mid-body fails the body read, not the whole process', async () => {
    const url = await serve((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":0}\n\n'); // then silence
    });
    const res = await createLongFetch({ maxMs: 5000, idleMs: 80 })(url, post(true));
    await expect(res.text()).rejects.toThrow();
  });

  it('a non-streamed call is allowed its silence, up to the hard cap', async () => {
    const url = await serve((res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, 200); // silent for longer than idleMs
    });
    const res = await createLongFetch({ maxMs: 5000, idleMs: 50 })(url, post(false));
    expect(await res.json()).toEqual({ ok: true });

    await expect(createLongFetch({ maxMs: 60, idleMs: 50 })(url, post(false))).rejects.toThrow(
      /exceeded 60 ms/,
    );
  });

  it('honours an abort signal', async () => {
    const url = await serve(() => undefined);
    const ac = new AbortController();
    const p = createLongFetch({ maxMs: 5000, idleMs: 5000 })(url, {
      ...post(true),
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
