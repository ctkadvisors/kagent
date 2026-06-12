/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { normalizeWhatsAppMessage } from './normalize.js';
import { deliverOutboundTurns } from './outbound.js';
import { adapterCondition } from './status.js';
import type {
  AdapterLogger,
  ChannelGateway,
  ChannelOutboxStore,
  ChannelStatusPatcher,
  WhatsAppAdapterConfig,
  WhatsAppConnectionUpdate,
  WhatsAppMessagesUpsert,
  WhatsAppSocketFactory,
  WhatsAppSocketLike,
} from './types.js';

export interface StartWhatsAppAdapterDeps {
  readonly socketFactory: WhatsAppSocketFactory;
  readonly gateway: ChannelGateway;
  readonly status: ChannelStatusPatcher;
  readonly outbox?: ChannelOutboxStore;
  readonly logger?: AdapterLogger;
  readonly clock?: () => Date;
  readonly requestRestart?: (reason: string) => void;
}

export interface RunningWhatsAppAdapter {
  readonly socket: WhatsAppSocketLike;
  close(): void;
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

export async function startWhatsAppAdapter(
  config: WhatsAppAdapterConfig,
  deps: StartWhatsAppAdapterDeps,
): Promise<RunningWhatsAppAdapter> {
  const logger = deps.logger ?? consoleLogger;
  const clock = deps.clock ?? (() => new Date());
  const session = await deps.socketFactory({ authDir: config.authDir });
  let connected = false;

  const deliverOutbound = async (): Promise<void> => {
    if (!connected || deps.outbox === undefined) return;
    await deliverOutboundTurns({
      config,
      store: deps.outbox,
      socket: session.socket,
      logger,
      clock,
    });
  };

  const outboundPoller =
    deps.outbox === undefined
      ? undefined
      : setInterval(() => {
          void deliverOutbound().catch((err: unknown) => {
            logger.error('[channel-whatsapp] failed to deliver outbound replies', err);
          });
        }, config.outboundPollMs);
  outboundPoller?.unref();

  await deps.status.patch({
    phase: 'Pairing',
    pairing: { state: 'unpaired', message: 'waiting for WhatsApp pairing' },
    lastHeartbeatAt: clock().toISOString(),
  });

  session.socket.ev.on('creds.update', () => {
    void Promise.resolve(session.saveCreds()).catch((err: unknown) => {
      logger.error('[channel-whatsapp] failed to save Baileys credentials', err);
    });
  });
  session.socket.ev.on('connection.update', (update) => {
    if (update.connection === 'open') connected = true;
    if (update.connection === 'close') connected = false;
    void handleConnectionUpdate({
      config,
      update,
      socket: session.socket,
      status: deps.status,
      logger,
      clock,
      ...(deps.requestRestart !== undefined && { requestRestart: deps.requestRestart }),
    })
      .catch((err: unknown) => {
        logger.error('[channel-whatsapp] failed to handle Baileys connection update', err);
      })
      .then(() => {
        if (update.connection === 'open') {
          void deliverOutbound().catch((err: unknown) => {
            logger.error('[channel-whatsapp] failed to deliver outbound replies', err);
          });
        }
      });
  });
  session.socket.ev.on('messages.upsert', (upsert) => {
    void handleMessagesUpsert({
      config,
      upsert,
      socket: session.socket,
      gateway: deps.gateway,
      logger,
    }).catch((err: unknown) => {
      logger.error('[channel-whatsapp] failed to handle Baileys message update', err);
    });
  });

  return {
    socket: session.socket,
    close(): void {
      if (outboundPoller !== undefined) clearInterval(outboundPoller);
      session.socket.end?.();
    },
  };
}

async function handleConnectionUpdate(input: {
  readonly config: WhatsAppAdapterConfig;
  readonly update: WhatsAppConnectionUpdate;
  readonly socket: WhatsAppSocketLike;
  readonly status: ChannelStatusPatcher;
  readonly logger: AdapterLogger;
  readonly clock: () => Date;
  readonly requestRestart?: (reason: string) => void;
}): Promise<void> {
  const now = input.clock();
  if (input.update.qr !== undefined && input.update.qr.length > 0) {
    const expiresAt = new Date(now.getTime() + input.config.pairingTtlSeconds * 1000).toISOString();
    await input.status.patch({
      phase: 'Pairing',
      pairing: { state: 'qr', qrCode: input.update.qr, expiresAt },
      lastHeartbeatAt: now.toISOString(),
    });
    input.logger.info('[channel-whatsapp] pairing QR received');
    return;
  }

  if (input.update.connection === 'open') {
    await input.status.patch({
      phase: 'Ready',
      pairing: {
        state: 'paired',
        ...(input.socket.user?.id !== undefined &&
          input.socket.user.id !== null && { accountJid: input.socket.user.id }),
      },
      lastHeartbeatAt: now.toISOString(),
    });
    input.logger.info('[channel-whatsapp] connected');
    return;
  }

  if (input.update.connection === 'close') {
    const statusCode = disconnectStatusCode(input.update.lastDisconnect);
    const loggedOut = statusCode === 401 || statusCode === 403;
    await input.status.patch({
      phase: loggedOut ? 'Failed' : 'Pairing',
      pairing: {
        state: loggedOut ? 'failed' : 'unpaired',
        message: loggedOut
          ? 'WhatsApp session logged out; clear auth storage and pair again'
          : 'WhatsApp connection closed; adapter will wait for reconnect',
      },
      conditions: [
        adapterCondition({
          type: 'WhatsAppConnected',
          status: 'False',
          reason: loggedOut ? 'LoggedOut' : 'ConnectionClosed',
          message: `Baileys connection closed${statusCode === undefined ? '' : ` (${statusCode})`}`,
          now,
        }),
      ],
      lastHeartbeatAt: now.toISOString(),
    });
    input.logger.warn('[channel-whatsapp] connection closed', input.update.lastDisconnect);
    if (!loggedOut) input.requestRestart?.('connection_closed');
  }
}

async function handleMessagesUpsert(input: {
  readonly config: WhatsAppAdapterConfig;
  readonly upsert: WhatsAppMessagesUpsert;
  readonly socket: WhatsAppSocketLike;
  readonly gateway: ChannelGateway;
  readonly logger: AdapterLogger;
}): Promise<void> {
  if (input.upsert.type !== undefined && input.upsert.type !== 'notify') return;

  for (const message of input.upsert.messages) {
    const envelope = normalizeWhatsAppMessage(input.config, message);
    if (envelope === undefined) continue;
    try {
      await input.gateway.postInbound(envelope);
      if (
        input.config.sendReadReceipts &&
        input.socket.readMessages !== undefined &&
        message.key !== undefined
      ) {
        await input.socket.readMessages([message.key]);
      }
      input.logger.info('[channel-whatsapp] inbound message accepted', {
        channelName: envelope.channelName,
        peer: envelope.peer,
        messageId: envelope.messageId,
      });
    } catch (err) {
      input.logger.error('[channel-whatsapp] inbound message rejected by channel gateway', err);
    }
  }
}

function disconnectStatusCode(lastDisconnect: unknown): number | undefined {
  const record = asRecord(lastDisconnect);
  const error = asRecord(record?.error);
  const output = asRecord(error?.output);
  const statusCode = output?.statusCode ?? error?.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
