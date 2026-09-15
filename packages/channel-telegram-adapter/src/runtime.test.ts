/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { processTelegramUpdates, startTelegramAdapter } from './runtime.js';
import { ChannelGatewayHttpError } from './gateway.js';
import type {
  AdapterLogger,
  ChannelStatusPatch,
  TelegramAdapterConfig,
  TelegramClient,
} from './types.js';
const config: TelegramAdapterConfig = {
  channelName: 'telegram-work',
  namespace: 'kagent-system',
  accountId: 'work',
  botToken: '123456:token',
  telegramApiBaseUrl: 'https://api.telegram.org',
  gatewayUrl: 'http://operator:8089',
  gatewayToken: 'token',
  gatewayTimeoutMs: 10000,
  pollTimeoutSeconds: 25,
  pollIntervalMs: 1000,
  outboundPollMs: 5000,
  outboundBaseBackoffSeconds: 60,
  outboundMaxFailures: 2,
};

describe('processTelegramUpdates', () => {
  it('skips an update the gateway definitively rejects instead of retrying it forever', async () => {
    const client = makeClient({
      updates: [
        {
          update_id: 10,
          message: {
            message_id: 1,
            from: { id: 3175140114, is_bot: false, first_name: 'Chris' },
            chat: { id: 3175140114, type: 'private' },
            text: 'You dont need me to approve this',
          },
        },
      ],
    });
    const gateway = {
      postInbound: vi
        .fn()
        .mockRejectedValue(new ChannelGatewayHttpError(400, { code: 'invalid_json' })),
    };

    const result = await processTelegramUpdates({
      config,
      client,
      gateway,
      logger: quietLogger,
      offset: 10,
    });

    expect(result).toEqual({ nextOffset: 11, accepted: 0, ignored: 0, failed: 1 });
  });

  it('posts accepted Telegram updates and advances the polling offset', async () => {
    const client = makeClient({
      updates: [
        {
          update_id: 10,
          message: {
            message_id: 1,
            from: { id: 3175140114, is_bot: false, first_name: 'Chris' },
            chat: { id: 3175140114, type: 'private' },
            text: 'Run the daily check',
          },
        },
      ],
    });
    const gateway = { postInbound: vi.fn().mockResolvedValue({ action: 'created' }) };

    const result = await processTelegramUpdates({
      config,
      client,
      gateway,
      logger: quietLogger,
      offset: 10,
    });

    expect(result).toEqual({ nextOffset: 11, accepted: 1, ignored: 0, failed: 0 });
    expect(client.getUpdates).toHaveBeenCalledWith({ offset: 10, timeoutSeconds: 25 });
    expect(gateway.postInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'telegram',
        messageId: 'telegram:update:10:message:1',
        text: 'Run the daily check',
      }),
    );
  });

  it('bridges the previous exchange into the next message when an outbox is wired', async () => {
    const client = makeClient({
      updates: [
        {
          update_id: 11,
          message: {
            message_id: 2,
            from: { id: 3175140114, is_bot: false, first_name: 'Chris' },
            chat: { id: 3175140114, type: 'private' },
            text: 'and the second biggest?',
          },
        },
      ],
    });
    const gateway = { postInbound: vi.fn().mockResolvedValue({ action: 'created' }) };
    const taskRef = { namespace: 'kagent-system', name: 'kat-1' };
    const outbox = {
      listChannelSessions: vi.fn().mockResolvedValue([
        {
          apiVersion: 'kagent.knuteson.io/v1alpha1',
          kind: 'ChannelSession',
          metadata: { name: 'kcs', namespace: 'kagent-system' },
          spec: {
            channelRef: { name: 'telegram-work' },
            provider: 'telegram',
            accountId: 'work',
            peer: { kind: 'dm', id: '3175140114' },
            sessionKey: 'k',
            target: { agentRef: { name: 'concierge' } },
          },
          status: { phase: 'Active', lastTaskRef: taskRef },
        },
      ]),
      getAgentTask: vi.fn().mockResolvedValue({
        apiVersion: 'kagent.knuteson.io/v1alpha1',
        kind: 'AgentTask',
        metadata: {
          ...taskRef,
          annotations: { 'kagent.knuteson.io/channel-message': 'whats the biggest pod' },
        },
        spec: { targetAgent: 'concierge' },
        status: { phase: 'Completed', result: { content: 'ornith-b12x-serve' } },
      }),
      patchSessionStatus: vi.fn(),
    };

    await processTelegramUpdates({
      config: {
        ...config,
        brain: { mcpUrl: 'http://brain/mcp', token: 't', operatorName: 'Chris' },
      },
      client,
      gateway,
      outbox,
      logger: quietLogger,
    });

    expect(gateway.postInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '[earlier in this conversation]\nChris: whats the biggest pod\nYou: ornith-b12x-serve\n[current message]\nand the second biggest?',
      }),
    );
  });

  it('advances the polling offset past ignored updates', async () => {
    const client = makeClient({
      updates: [
        {
          update_id: 12,
          message: {
            message_id: 1,
            from: { id: 99, is_bot: true },
            chat: { id: 3175140114, type: 'private' },
            text: 'bot loop',
          },
        },
      ],
    });
    const gateway = { postInbound: vi.fn() };

    const result = await processTelegramUpdates({
      config,
      client,
      gateway,
      logger: quietLogger,
    });

    expect(result).toEqual({ nextOffset: 13, accepted: 0, ignored: 1, failed: 0 });
    expect(gateway.postInbound).not.toHaveBeenCalled();
  });

  it('does not advance past a gateway failure', async () => {
    const client = makeClient({
      updates: [
        {
          update_id: 20,
          message: {
            message_id: 1,
            from: { id: 3175140114, is_bot: false },
            chat: { id: 3175140114, type: 'private' },
            text: 'this should retry',
          },
        },
        {
          update_id: 21,
          message: {
            message_id: 2,
            from: { id: 3175140114, is_bot: false },
            chat: { id: 3175140114, type: 'private' },
            text: 'do not skip ahead',
          },
        },
      ],
    });
    const gateway = { postInbound: vi.fn().mockRejectedValue(new Error('gateway unavailable')) };

    const result = await processTelegramUpdates({
      config,
      client,
      gateway,
      logger: quietLogger,
      offset: 20,
    });

    expect(result).toEqual({ nextOffset: 20, accepted: 0, ignored: 0, failed: 1 });
    expect(gateway.postInbound).toHaveBeenCalledTimes(1);
  });
});

// bridgeFleetNow is exercised through processTelegramUpdates: the envelope it
// produces is what the gateway receives. The four cases the review asked for
// — absent+no rule, absent+rule, stale+no rule, stale+rule — each assert the
// block the bridge prepends (or, for absent+no rule, that it prepends nothing).
describe('bridgeFleetNow', () => {
  const baseConfig = (): TelegramAdapterConfig => ({ ...config, fleetUrl: 'http://launcher:8080' });

  it('leaves the message untouched when the launcher is absent and there is no rule', async () => {
    const client = makeClient({
      updates: [
        {
          update_id: 30,
          message: { message_id: 1, from: { id: 1, is_bot: false }, chat: { id: 1, type: 'private' }, text: 'hi' },
        },
      ],
    });
    // absent launcher: 200 with a fleet payload that has neither summary nor rules.
    const fleetFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ fleet: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fleetFetch);
    try {
      const gateway = { postInbound: vi.fn().mockResolvedValue(null) };
      await processTelegramUpdates({ config: baseConfig(), client, gateway, logger: quietLogger });
      expect(gateway.postInbound).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'hi' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('appends a rule line even when the launcher is absent', async () => {
    const client = makeClient({
      updates: [
        {
          update_id: 31,
          message: {
            message_id: 2,
            from: { id: 1, is_bot: false },
            chat: { id: 1, type: 'private' },
            text: 'rule: keep it one line',
          },
        },
      ],
    });
    // A fresh body per call: recordRule also calls fetch for /remember, so a
    // single shared Response would be read twice.
    const fleetFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ fleet: {} }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fleetFetch);
    try {
      const gateway = { postInbound: vi.fn().mockResolvedValue(null) };
      await processTelegramUpdates({ config: baseConfig(), client, gateway, logger: quietLogger });
      const [env] = gateway.postInbound.mock.calls[0];
      const text = env as { readonly text: string };
      expect(text.text).toContain('[rule]');
      expect(text.text).toContain('keep it one line');
      expect(text.text).not.toContain('[fleet now]');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces a stale launcher without appending the stale block, when there is no rule', async () => {
    const client = makeClient({
      updates: [
        {
          update_id: 32,
          message: { message_id: 1, from: { id: 1, is_bot: false }, chat: { id: 1, type: 'private' }, text: 'hi' },
        },
      ],
    });
    // stale launcher: 503.
    const fleetFetch = vi.fn(() => Promise.resolve(new Response('', { status: 503 })));
    vi.stubGlobal('fetch', fleetFetch);
    try {
      const gateway = { postInbound: vi.fn().mockResolvedValue(null) };
      await processTelegramUpdates({ config: baseConfig(), client, gateway, logger: quietLogger });
      const [env] = gateway.postInbound.mock.calls[0];
      const text = env as { readonly text: string };
      expect(text.text).toContain('[fleet now] launcher fetch failed');
      expect(text.text).not.toContain('\n[fleet now]');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces a stale launcher alongside the rule line', async () => {
    const client = makeClient({
      updates: [
        {
          update_id: 33,
          message: {
            message_id: 3,
            from: { id: 1, is_bot: false },
            chat: { id: 1, type: 'private' },
            text: 'rule: stay on one line',
          },
        },
      ],
    });
    const fleetFetch = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));
    vi.stubGlobal('fetch', fleetFetch);
    try {
      const gateway = { postInbound: vi.fn().mockResolvedValue(null) };
      await processTelegramUpdates({ config: baseConfig(), client, gateway, logger: quietLogger });
      const [env] = gateway.postInbound.mock.calls[0];
      const text = env as { readonly text: string };
      expect(text.text).toContain('[fleet now] launcher fetch failed');
      expect(text.text).toContain('[rule]');
      expect(text.text).toContain('stay on one line');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('startTelegramAdapter', () => {
  it('marks the Telegram channel ready and starts from an unacknowledged offset', async () => {
    const client = makeClient({ updates: [] });
    const statusPatches: ChannelStatusPatch[] = [];
    const running = await startTelegramAdapter(config, {
      client,
      gateway: { postInbound: vi.fn() },
      status: {
        patch: (patch) => {
          statusPatches.push(patch);
          return Promise.resolve();
        },
      },
      logger: quietLogger,
      sleep: () => new Promise(() => undefined),
      clock: () => new Date('2026-06-12T12:00:00.000Z'),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(statusPatches[0]).toEqual({
      phase: 'Ready',
      pairing: { state: 'paired', message: 'Telegram bot token configured' },
      lastHeartbeatAt: '2026-06-12T12:00:00.000Z',
    });
    expect(client.getUpdates).toHaveBeenCalledWith({ timeoutSeconds: 25 });

    running.close();
  });

  it('keeps the poll and outbound timers referenced so the process stays alive', async () => {
    const timeoutUnref = vi.fn();
    const intervalUnref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(
        () => ({ unref: timeoutUnref }) as unknown as ReturnType<typeof setTimeout>,
      );
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(
        () => ({ unref: intervalUnref }) as unknown as ReturnType<typeof setInterval>,
      );
    try {
      const client = makeClient({ updates: [] });
      const running = await startTelegramAdapter(config, {
        client,
        gateway: { postInbound: vi.fn() },
        status: { patch: () => Promise.resolve() },
        outbox: {
          listChannelSessions: vi.fn().mockResolvedValue([]),
          getAgentTask: vi.fn(),
          patchSessionStatus: vi.fn(),
        },
        logger: quietLogger,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), config.outboundPollMs);
      expect(intervalUnref).not.toHaveBeenCalled();
      expect(timeoutUnref).not.toHaveBeenCalled();

      running.close();
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });
});

function makeClient(input: {
  readonly updates: Parameters<TelegramClient['getUpdates']>[0] extends never
    ? never
    : readonly Awaited<ReturnType<TelegramClient['getUpdates']>>[number][];
}): TelegramClient & {
  readonly getUpdates: ReturnType<typeof vi.fn>;
  readonly sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    getUpdates: vi.fn().mockResolvedValue(input.updates),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

const quietLogger: AdapterLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};