/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { normalizeTelegramUpdate } from './normalize.js';
import { deliverOutboundTurns } from './outbound.js';
import { adapterCondition } from './status.js';
import type {
  AdapterLogger,
  ChannelGateway,
  ChannelOutboxStore,
  ChannelStatusPatcher,
  TelegramAdapterConfig,
  TelegramClient,
  TelegramUpdate,
} from './types.js';

export interface StartTelegramAdapterDeps {
  readonly client: TelegramClient;
  readonly gateway: ChannelGateway;
  readonly status: ChannelStatusPatcher;
  readonly outbox?: ChannelOutboxStore;
  readonly logger?: AdapterLogger;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RunningTelegramAdapter {
  close(): void;
}

export interface TelegramUpdateProcessingResult {
  readonly nextOffset: number | undefined;
  readonly accepted: number;
  readonly ignored: number;
  readonly failed: number;
}

const consoleLogger: AdapterLogger = {
  info(message, extra): void {
    console.log(message, extra ?? '');
  },
  warn(message, extra): void {
    console.warn(message, extra ?? '');
  },
  error(message, extra): void {
    console.error(message, extra ?? '');
  },
};

export async function startTelegramAdapter(
  config: TelegramAdapterConfig,
  deps: StartTelegramAdapterDeps,
): Promise<RunningTelegramAdapter> {
  const logger = deps.logger ?? consoleLogger;
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? timeoutSleep;
  let stopped = false;
  let offset: number | undefined;

  const deliverOutbound = async (): Promise<void> => {
    if (deps.outbox === undefined) return;
    await deliverOutboundTurns({
      config,
      store: deps.outbox,
      client: deps.client,
      logger,
      clock,
    });
  };

  await deps.status.patch({
    phase: 'Ready',
    pairing: { state: 'paired', message: 'Telegram bot token configured' },
    lastHeartbeatAt: clock().toISOString(),
  });

  void pollLoop().catch((err: unknown) => {
    logger.error('[channel-telegram] polling loop stopped unexpectedly', err);
  });

  const outboundPoller =
    deps.outbox === undefined
      ? undefined
      : setInterval(() => {
          void deliverOutbound().catch((err: unknown) => {
            logger.error('[channel-telegram] failed to deliver outbound replies', err);
          });
        }, config.outboundPollMs);
  outboundPoller?.unref();

  async function pollLoop(): Promise<void> {
    while (!stopped) {
      try {
        const result = await processTelegramUpdates({
          config,
          client: deps.client,
          gateway: deps.gateway,
          logger,
          ...(offset !== undefined && { offset }),
        });
        offset = result.nextOffset;
        await deps.status.patch({
          phase: 'Ready',
          pairing: { state: 'paired' },
          lastHeartbeatAt: clock().toISOString(),
        });
      } catch (err) {
        logger.error('[channel-telegram] failed to poll Telegram updates', err);
        await deps.status.patch({
          phase: 'Ready',
          pairing: { state: 'paired' },
          conditions: [
            adapterCondition({
              type: 'TelegramPolling',
              status: 'False',
              reason: 'PollFailed',
              message: String(err instanceof Error ? err.message : err),
              now: clock(),
            }),
          ],
          lastHeartbeatAt: clock().toISOString(),
        });
      }
      if (!stopped) await sleep(config.pollIntervalMs);
    }
  }

  return {
    close(): void {
      stopped = true;
      if (outboundPoller !== undefined) clearInterval(outboundPoller);
    },
  };
}

export async function processTelegramUpdates(input: {
  readonly config: TelegramAdapterConfig;
  readonly client: TelegramClient;
  readonly gateway: ChannelGateway;
  readonly logger: AdapterLogger;
  readonly offset?: number;
}): Promise<TelegramUpdateProcessingResult> {
  const updates = await input.client.getUpdates({
    ...(input.offset !== undefined && { offset: input.offset }),
    timeoutSeconds: input.config.pollTimeoutSeconds,
  });
  let nextOffset = input.offset;
  let accepted = 0;
  let ignored = 0;
  let failed = 0;

  for (const update of updates) {
    const updateId = validUpdateId(update);
    if (updateId === undefined) {
      ignored += 1;
      continue;
    }

    const envelope = normalizeTelegramUpdate(input.config, update);
    if (envelope === undefined) {
      ignored += 1;
      nextOffset = Math.max(nextOffset ?? 0, updateId + 1);
      continue;
    }

    try {
      await input.gateway.postInbound(envelope);
      accepted += 1;
      nextOffset = Math.max(nextOffset ?? 0, updateId + 1);
      input.logger.info('[channel-telegram] inbound message accepted', {
        channelName: envelope.channelName,
        peer: envelope.peer,
        messageId: envelope.messageId,
      });
    } catch (err) {
      failed += 1;
      input.logger.error('[channel-telegram] inbound message rejected by channel gateway', err);
      break;
    }
  }

  return { nextOffset, accepted, ignored, failed };
}

function validUpdateId(update: TelegramUpdate): number | undefined {
  return typeof update.update_id === 'number' && Number.isSafeInteger(update.update_id)
    ? update.update_id
    : undefined;
}

function timeoutSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
