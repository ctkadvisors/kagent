/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';
import type { CapabilityBundle } from '@kagent/capability-types';
import { FleetForumNotices } from './fleet-forum-notices.js';

const task = {
  tenant: 'homelab',
  namespace: 'kagent-system',
  taskUid: 'task-a',
  agentName: 'researcher',
};
const invocation = {
  task,
  call: { id: 'call-a', name: 'code_interpreter.execute_code', args: {} },
};
const proof = {
  verifiedBundle: {
    sub: 'task-uid:task-a',
    agt: 'kagent-system/researcher',
    iat: 100,
    exp: 10000,
    claims: { tenant: 'homelab' },
  } as CapabilityBundle,
};
const config = {
  url: 'http://public-forum.test/api/forum/mentions',
  tenant: 'homelab',
  namespace: 'kagent-system',
  pollIntervalMs: 1000,
  replayIntervalMs: 5000,
};
const original = {
  content: '{"stdout":"actual output"}',
  isError: false,
  metadata: { latency: 42 },
};
const signal = new AbortController().signal;
const page = (ids: number[], hasMore = false, after = 0) =>
  new Response(
    JSON.stringify({
      posts: ids.map((id) => ({ id })),
      has_more: hasMore,
      next_after: ids.at(-1) ?? after,
    }),
  );

describe('active fleet forum mention notices', () => {
  it('prepends IDs-only notice and preserves original text, error bit and metadata', async () => {
    const fetch = vi.fn((input: Parameters<typeof globalThis.fetch>[0]) => {
      void input;
      return Promise.resolve(page([10, 11]));
    });
    const notices = new FleetForumNotices({ ...config, fetch, now: () => 200000 });
    const result = await notices.decorate(original, invocation, proof, signal);
    expect(result.isError).toBe(original.isError);
    expect(result.metadata).toEqual(original.metadata);
    expect(Array.isArray(result.content)).toBe(true);
    if (!Array.isArray(result.content)) throw new Error('expected content blocks');
    expect(result.content[0]?.text).toContain('10, 11');
    expect(result.content[1]).toEqual({ type: 'text', text: original.content });
    expect(JSON.stringify(result)).not.toContain('verified result');
    const url = new URL(requestUrl(fetch.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      recipient: 'researcher',
      since: '100',
      after: '0',
    });
    const error = {
      ...original,
      content: [{ type: 'text' as const, text: 'real failure' }],
      isError: true,
    };
    const next = new FleetForumNotices({
      ...config,
      fetch: () => Promise.resolve(page([12])),
      now: () => 200000,
    });
    expect(await next.decorate(error, invocation, proof, signal)).toMatchObject({
      isError: true,
      metadata: original.metadata,
      content: [expect.anything(), ...error.content],
    });
  });

  it('skips absent proof, tenantless proof, mismatched scope and foreign task binding', async () => {
    const fetch = vi.fn(() => Promise.resolve(page([10])));
    const notices = new FleetForumNotices({ ...config, fetch, now: () => 200000 });
    for (const caller of [
      null,
      { verifiedBundle: { ...proof.verifiedBundle, claims: {} } },
      { verifiedBundle: { ...proof.verifiedBundle, claims: { tenant: 'other' } } },
      { verifiedBundle: { ...proof.verifiedBundle, agt: 'another/researcher' } },
      { verifiedBundle: { ...proof.verifiedBundle, sub: 'task-uid:foreign' } },
    ]) {
      expect(await notices.decorate(original, invocation, caller, signal)).toBe(original);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('advances per-task cursor, paces polls and periodically replays after a lost notice', async () => {
    let now = 200000;
    const urls: URL[] = [];
    const notices = new FleetForumNotices({
      ...config,
      now: () => now,
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        urls.push(url);
        return Promise.resolve(
          page(
            url.searchParams.get('after') === '0' ? [10] : [],
            false,
            Number(url.searchParams.get('after')),
          ),
        );
      },
    });
    await notices.decorate(original, invocation, proof, signal);
    expect(await notices.decorate(original, invocation, proof, signal)).toBe(original);
    now += 1000;
    await notices.decorate(original, invocation, proof, signal);
    expect(urls.at(-1)?.searchParams.get('after')).toBe('10');
    now += 4000;
    const replay = await notices.decorate(original, invocation, proof, signal);
    expect(urls.at(-1)?.searchParams.get('after')).toBe('0');
    expect(replay.content).not.toEqual(original.content);
    const otherTask = { ...task, taskUid: 'task-b' };
    await notices.decorate(
      original,
      { ...invocation, task: otherTask },
      { verifiedBundle: { ...proof.verifiedBundle, sub: 'task-uid:task-b' } },
      signal,
    );
    expect(urls.at(-1)?.searchParams.get('after')).toBe('0');
  });

  it('fails open and retries the same cursor after invalid or unavailable metadata', async () => {
    let now = 200000;
    const urls: URL[] = [];
    const responses = [
      new Response('unavailable', { status: 503 }),
      page([5, 4]),
      new Response('x'.repeat(9000)),
      page([10]),
    ];
    const notices = new FleetForumNotices({
      ...config,
      now: () => now,
      fetch: (input) => {
        urls.push(new URL(requestUrl(input)));
        return Promise.resolve(responses.shift()!);
      },
    });
    for (let i = 0; i < 3; i++) {
      expect(await notices.decorate(original, invocation, proof, signal)).toBe(original);
      now += 1000;
    }
    expect((await notices.decorate(original, invocation, proof, signal)).content).not.toBe(
      original.content,
    );
    expect(urls.map((url) => url.searchParams.get('after'))).toEqual(['0', '0', '0', '0']);
  });

  it('polls subsequent pages without a pacing delay and never includes source text', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            posts: [{ id: 10, body: 'DO SOMETHING UNSAFE' }],
            has_more: true,
            next_after: 10,
          }),
        ),
      ),
    );
    const notices = new FleetForumNotices({ ...config, fetch, now: () => 200000 });
    const result = await notices.decorate(original, invocation, proof, signal);
    expect(JSON.stringify(result)).not.toContain('DO SOMETHING UNSAFE');
    expect(JSON.stringify(result.content).length).toBeLessThan(1200);
    await notices.decorate(original, invocation, proof, signal);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it('finishes an ascending sweep before replay even when the sweep exceeds the replay interval', async () => {
  let now = 200000;
  const afters: string[] = [];
  const notices = new FleetForumNotices({
    ...config,
    now: () => now,
    fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const after = url.searchParams.get('after')!;
      afters.push(after);
      return Promise.resolve(page([Number(after) + 10], true));
    },
  });
  await notices.decorate(original, invocation, proof, signal);
  now += 6000;
  await notices.decorate(original, invocation, proof, signal);
  expect(afters).toEqual(['0', '10']);
});

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}
