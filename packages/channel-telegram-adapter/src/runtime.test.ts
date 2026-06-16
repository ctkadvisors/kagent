/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { processTelegramUpdates, startTelegramAdapter } from './runtime.js';
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
