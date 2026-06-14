/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/* eslint-disable @typescript-eslint/unbound-method */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION, type AgentTask, type ChannelSession } from './crds/index.js';
import type { ChannelControllerStore } from './channel-controller.js';
import { buildChannelGatewayHandler } from './channel-gateway.js';

const namespace = 'kagent-system';
const now = new Date('2026-06-12T17:10:00.000Z');

function makeStore(): ChannelControllerStore {
  return {
    getChannel: vi.fn().mockResolvedValue({
      apiVersion: API_GROUP_VERSION,
      kind: 'Channel',
      metadata: { name: 'wa-main', namespace },
      spec: {
        provider: 'whatsapp',
        accountId: 'acct-main',
        policy: { dmPolicy: 'allowlist', allowFrom: ['user-1'] },
      },
    }),
    listChannelBindings: vi.fn().mockResolvedValue([
      {
        apiVersion: API_GROUP_VERSION,
        kind: 'ChannelBinding',
        metadata: { name: 'wa-user-agent', namespace },
        spec: {
          channelRef: { name: 'wa-main' },
          match: { accountId: 'acct-main' },
          target: { agentRef: { name: 'useful-agent' } },
        },
      },
    ]),
    getChannelSession: vi.fn().mockResolvedValue(undefined),
    createChannelSession: vi.fn((session: ChannelSession) =>
      Promise.resolve({ session, created: true }),
    ),
    patchChannelStatus: vi.fn().mockResolvedValue(undefined),
    patchChannelSessionStatus: vi.fn().mockResolvedValue(undefined),
    createAgentTask: vi.fn((task: AgentTask) =>
      Promise.resolve({
        task: { ...task, metadata: { ...task.metadata, uid: 'task-uid-1' } },
        created: true,
      }),
    ),
  };
}

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'whatsapp',
    accountId: 'acct-main',
    peer: { kind: 'dm', id: 'user-1' },
    sender: { id: 'user-1' },
    messageId: 'wamid.abc',
    text: 'Run a cluster health check.',
    ...overrides,
  };
}

describe('buildChannelGatewayHandler', () => {
  it('accepts an authenticated inbound envelope and returns task/session refs', async () => {
    const store = makeStore();
    const handler = buildChannelGatewayHandler({
      namespace,
      store,
      clock: () => now,
      authenticate: vi.fn().mockResolvedValue(true),
    });
    const { req, res, out } = makeFakeReqRes({
      method: 'POST',
      url: '/channels/wa-main/inbound',
      body: makeBody(),
    });

    await handler(req, res);

    expect(out.status).toBe(202);
    const body = JSON.parse(out.body ?? '{}') as unknown;
    expect(body).toMatchObject({
      action: 'created',
      channel: 'wa-main',
      session: { namespace },
      task: { namespace, uid: 'task-uid-1' },
    });
    if (!isGatewaySuccessBody(body)) throw new Error('expected gateway success body');
    expect(body.session.name).toMatch(/^kcs-wa-main-/);
    expect(body.task.name).toMatch(/^kct-wa-main-/);
    expect(store.createAgentTask).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthenticated requests before reading channel state', async () => {
    const store = makeStore();
    const handler = buildChannelGatewayHandler({
      namespace,
      store,
      authenticate: vi.fn().mockResolvedValue(false),
    });
    const { req, res, out } = makeFakeReqRes({
      method: 'POST',
      url: '/channels/wa-main/inbound',
      body: makeBody(),
    });

    await handler(req, res);

    expect(out.status).toBe(401);
    expect(store.getChannel).not.toHaveBeenCalled();
  });

  it('rejects malformed envelopes with 400', async () => {
    const store = makeStore();
    const handler = buildChannelGatewayHandler({ namespace, store });
    const { req, res, out } = makeFakeReqRes({
      method: 'POST',
      url: '/channels/wa-main/inbound',
      body: makeBody({ peer: { kind: 'dm' } }),
    });

    await handler(req, res);

    expect(out.status).toBe(400);
    const body = JSON.parse(out.body ?? '{}') as unknown;
    expect(body).toMatchObject({
      code: 'invalid_channel_envelope',
    });
    expect(store.getChannel).not.toHaveBeenCalled();
  });

  it('maps controller denials to an explicit non-2xx gateway response', async () => {
    const store = makeStore();
    store.listChannelBindings = vi.fn().mockResolvedValue([]);
    const handler = buildChannelGatewayHandler({ namespace, store, clock: () => now });
    const { req, res, out } = makeFakeReqRes({
      method: 'POST',
      url: '/channels/wa-main/inbound',
      body: makeBody(),
    });

    await handler(req, res);

    expect(out.status).toBe(404);
    const body = JSON.parse(out.body ?? '{}') as unknown;
    expect(body).toEqual({ action: 'denied', reason: 'no_route' });
  });

  it('rejects non-channel routes without touching the store', async () => {
    const store = makeStore();
    const handler = buildChannelGatewayHandler({ namespace, store });
    const { req, res, out } = makeFakeReqRes({
      method: 'POST',
      url: '/templates/summarizer',
      body: makeBody(),
    });

    await handler(req, res);

    expect(out.status).toBe(404);
    expect(store.getChannel).not.toHaveBeenCalled();
  });
});

interface FakeResponse {
  status?: number;
  body?: string;
  headers: Record<string, string>;
}

function isGatewaySuccessBody(value: unknown): value is {
  readonly session: { readonly name: string };
  readonly task: { readonly name: string };
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { session?: unknown; task?: unknown };
  return hasStringName(v.session) && hasStringName(v.task);
}

function hasStringName(value: unknown): value is { readonly name: string } {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { name?: unknown }).name === 'string';
}

function makeFakeReqRes(opts: {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}): { req: IncomingMessage; res: ServerResponse; out: FakeResponse } {
  const out: FakeResponse = { headers: {} };
  const chunks = opts.body !== undefined ? [Buffer.from(JSON.stringify(opts.body), 'utf8')] : [];
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const req = {
    method: opts.method,
    url: opts.url,
    on(event: string, cb: (arg?: unknown) => void): void {
      (handlers[event] ??= []).push(cb);
    },
    destroy(): void {},
  } as unknown as IncomingMessage;
  setImmediate(() => {
    for (const chunk of chunks) handlers.data?.forEach((h) => h(chunk));
    handlers.end?.forEach((h) => h());
  });

  const fakeRes = {
    statusCode: 200,
    setHeader(name: string, value: string): void {
      out.headers[name.toLowerCase()] = value;
    },
    end(body?: string): void {
      out.status = fakeRes.statusCode;
      out.body = body;
    },
  };
  const res = fakeRes as unknown as ServerResponse;

  return { req, res, out };
}
