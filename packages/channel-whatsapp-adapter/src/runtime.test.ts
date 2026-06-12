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

  it('reconnects in-process on transient connection close', async () => {
    const harness = await startHarness({ socketCount: 2, reconnectDelayMs: 1 });

    harness.emitConnection({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    await harness.flush();
    await harness.advanceReconnect();

    expect(harness.socketFactory).toHaveBeenCalledTimes(2);
    expect(harness.requestRestart).not.toHaveBeenCalled();
    expect(harness.statusPatches.at(-1)).toMatchObject({
      phase: 'Pairing',
      pairing: { state: 'unpaired' },
    });
  });

  it('keeps the reconnect timer referenced so the process waits for reconnect', async () => {
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => fakeTimer);
    try {
      const harness = await startHarness({ socketCount: 2, reconnectDelayMs: 1000 });

      harness.emitConnection({
        connection: 'close',
        lastDisconnect: { error: { message: 'QR refs attempts ended' } },
      });
      await harness.flush();

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      expect(unref).not.toHaveBeenCalled();
      expect(harness.requestRestart).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
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

async function startHarness(
  options: {
    readonly socketCount?: number;
    readonly reconnectDelayMs?: number;
  } = {},
): Promise<{
  readonly socket: FakeSocket;
  readonly sockets: readonly FakeSocket[];
  readonly saveCreds: ReturnType<typeof vi.fn>;
  readonly socketFactory: ReturnType<typeof vi.fn>;
  readonly gateway: { readonly postInbound: ReturnType<typeof vi.fn> };
  readonly requestRestart: ReturnType<typeof vi.fn>;
  readonly statusPatches: ChannelStatusPatch[];
  emitConnection(update: WhatsAppConnectionUpdate): void;
  emitMessages(upsert: WhatsAppMessagesUpsert): void;
  emitCreds(): void;
  advanceReconnect(): Promise<void>;
  flush(): Promise<void>;
}> {
  vi.useRealTimers();
  const sockets = Array.from({ length: options.socketCount ?? 1 }, () => new FakeSocket());
  const socket = sockets[0] ?? new FakeSocket();
  const saveCreds = vi.fn().mockResolvedValue(undefined);
  const socketFactory = vi.fn();
  for (const s of sockets) {
    socketFactory.mockResolvedValueOnce({ socket: s, saveCreds });
  }
  socketFactory.mockResolvedValue({ socket: sockets.at(-1) ?? socket, saveCreds });
  const gateway = { postInbound: vi.fn().mockResolvedValue({ action: 'created' }) };
  const requestRestart = vi.fn();
  const statusPatches: ChannelStatusPatch[] = [];
  await startWhatsAppAdapter(config, {
    socketFactory,
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
    reconnectDelayMs: options.reconnectDelayMs,
  });
  return {
    socket,
    sockets,
    saveCreds,
    socketFactory,
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
    async advanceReconnect(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, options.reconnectDelayMs ?? 0));
      await new Promise((resolve) => setImmediate(resolve));
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
