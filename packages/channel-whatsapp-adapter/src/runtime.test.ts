/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { startWhatsAppAdapter } from './runtime.js';
import type {
  AdapterLogger,
  ChannelStatusPatch,
  WhatsAppAdapterConfig,
  WhatsAppConnectionUpdate,
  WhatsAppEventBus,
  WhatsAppMessagesUpsert,
  WhatsAppSocketLike,
} from './types.js';

const config: WhatsAppAdapterConfig = {
  channelName: 'whatsapp-work',
  namespace: 'kagent-system',
  accountId: 'work',
  gatewayUrl: 'http://operator:8089',
  gatewayToken: 'token',
  gatewayTimeoutMs: 10000,
  authDir: '/auth',
  sendReadReceipts: true,
  pairingTtlSeconds: 120,
};

describe('startWhatsAppAdapter', () => {
  it('patches QR pairing state from Baileys connection updates', async () => {
    const harness = await startHarness();

    harness.emitConnection({ qr: 'qr-data' });

    expect(harness.statusPatches.at(-1)).toEqual({
      phase: 'Pairing',
      pairing: {
        state: 'qr',
        qrCode: 'qr-data',
        expiresAt: '2026-06-12T12:02:00.000Z',
      },
      lastHeartbeatAt: '2026-06-12T12:00:00.000Z',
    });
  });

  it('posts notify messages to the gateway and marks them read', async () => {
    const harness = await startHarness();

    harness.emitMessages({
      type: 'notify',
      messages: [
        {
          key: {
            id: 'msg-1',
            remoteJid: '15551234567@s.whatsapp.net',
            fromMe: false,
          },
          message: { conversation: 'Run the daily check' },
        },
      ],
    });
    await harness.flush();

    expect(harness.gateway.postInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        channelName: 'whatsapp-work',
        provider: 'whatsapp',
        messageId: 'msg-1',
        text: 'Run the daily check',
      }),
    );
    expect(harness.socket.readMessages).toHaveBeenCalledWith([
      {
        id: 'msg-1',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false,
      },
    ]);
  });

  it('saves credentials when Baileys updates auth material', async () => {
    const harness = await startHarness();

    harness.emitCreds();
    await harness.flush();

    expect(harness.saveCreds).toHaveBeenCalledTimes(1);
  });

  it('requests a pod restart on transient connection close', async () => {
    const harness = await startHarness();

    harness.emitConnection({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    await harness.flush();

    expect(harness.requestRestart).toHaveBeenCalledWith('connection_closed');
    expect(harness.statusPatches.at(-1)).toMatchObject({
      phase: 'Pairing',
      pairing: { state: 'unpaired' },
    });
  });

  it('does not restart on logged-out sessions that require human re-pairing', async () => {
    const harness = await startHarness();

    harness.emitConnection({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await harness.flush();

    expect(harness.requestRestart).not.toHaveBeenCalled();
    expect(harness.statusPatches.at(-1)).toMatchObject({
      phase: 'Failed',
      pairing: { state: 'failed' },
    });
  });
});

async function startHarness(): Promise<{
  readonly socket: FakeSocket;
  readonly saveCreds: ReturnType<typeof vi.fn>;
  readonly gateway: { readonly postInbound: ReturnType<typeof vi.fn> };
  readonly requestRestart: ReturnType<typeof vi.fn>;
  readonly statusPatches: ChannelStatusPatch[];
  emitConnection(update: WhatsAppConnectionUpdate): void;
  emitMessages(upsert: WhatsAppMessagesUpsert): void;
  emitCreds(): void;
  flush(): Promise<void>;
}> {
  const socket = new FakeSocket();
  const saveCreds = vi.fn().mockResolvedValue(undefined);
  const gateway = { postInbound: vi.fn().mockResolvedValue({ action: 'created' }) };
  const requestRestart = vi.fn();
  const statusPatches: ChannelStatusPatch[] = [];
  await startWhatsAppAdapter(config, {
    socketFactory: vi.fn().mockResolvedValue({ socket, saveCreds }),
    gateway,
    status: {
      patch: (patch) => {
        statusPatches.push(patch);
        return Promise.resolve();
      },
    },
    logger: quietLogger,
    clock: () => new Date('2026-06-12T12:00:00.000Z'),
    requestRestart,
  });
  return {
    socket,
    saveCreds,
    gateway,
    requestRestart,
    statusPatches,
    emitConnection(update): void {
      socket.emitConnection(update);
    },
    emitMessages(upsert): void {
      socket.emitMessages(upsert);
    },
    emitCreds(): void {
      socket.emitCreds();
    },
    async flush(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

class FakeSocket implements WhatsAppSocketLike {
  readonly readMessages = vi.fn().mockResolvedValue(undefined);
  private connectionHandler: ((update: WhatsAppConnectionUpdate) => void) | undefined;
  private credsHandler: (() => void) | undefined;
  private messagesHandler: ((upsert: WhatsAppMessagesUpsert) => void) | undefined;

  readonly ev: WhatsAppEventBus = {
    on: (event, handler): void => {
      if (event === 'connection.update') {
        this.connectionHandler = handler as (update: WhatsAppConnectionUpdate) => void;
      } else if (event === 'creds.update') {
        this.credsHandler = handler as () => void;
      } else {
        this.messagesHandler = handler as (upsert: WhatsAppMessagesUpsert) => void;
      }
    },
  };

  emitConnection(update: WhatsAppConnectionUpdate): void {
    this.connectionHandler?.(update);
  }

  emitMessages(upsert: WhatsAppMessagesUpsert): void {
    this.messagesHandler?.(upsert);
  }

  emitCreds(): void {
    this.credsHandler?.();
  }
}

const quietLogger: AdapterLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
