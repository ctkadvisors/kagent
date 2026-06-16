/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { TelegramApiError, TelegramHttpClient } from './telegram.js';

describe('TelegramHttpClient', () => {
  it('long-polls getUpdates with offset, timeout, and allowed update types', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                message_id: 1,
                chat: { id: 3175140114, type: 'private' },
                text: 'hello',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new TelegramHttpClient({
      apiBaseUrl: 'https://api.telegram.org/',
      botToken: '123456:token',
      fetchImpl,
    });

    await expect(client.getUpdates({ offset: 10, timeoutSeconds: 25 })).resolves.toEqual([
      {
        update_id: 10,
        message: {
          message_id: 1,
          chat: { id: 3175140114, type: 'private' },
          text: 'hello',
        },
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:token/getUpdates',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          timeout: 25,
          offset: 10,
          allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
        }),
      }),
    );
  });

  it('omits offset until a Telegram update has been processed', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }));
    const client = new TelegramHttpClient({
      apiBaseUrl: 'https://api.telegram.org',
      botToken: '123456:token',
      fetchImpl,
    });

    await client.getUpdates({ timeoutSeconds: 25 });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:token/getUpdates',
      expect.objectContaining({
        body: JSON.stringify({
          timeout: 25,
          allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
        }),
      }),
    );
  });

  it('sends outbound text messages to the selected chat', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), { status: 200 }),
      );
    const client = new TelegramHttpClient({
      apiBaseUrl: 'https://api.telegram.org',
      botToken: '123456:token',
      fetchImpl,
    });

    await client.sendMessage({ chatId: '-100123', text: 'Daily check done' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '-100123', text: 'Daily check done' }),
      }),
    );
  });

  it('throws structured errors for Telegram API failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }), {
        status: 403,
      }),
    );
    const client = new TelegramHttpClient({
      apiBaseUrl: 'https://api.telegram.org',
      botToken: '123456:token',
      fetchImpl,
    });

    await expect(client.sendMessage({ chatId: '123', text: 'hello' })).rejects.toMatchObject({
      method: 'sendMessage',
      status: 403,
      body: { ok: false, description: 'Forbidden: bot was blocked' },
    } satisfies Partial<TelegramApiError>);
  });
});
