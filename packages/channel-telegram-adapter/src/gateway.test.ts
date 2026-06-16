/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { ChannelGatewayClient, ChannelGatewayHttpError } from './gateway.js';
import type { ChannelInboundEnvelope } from './types.js';

const envelope: ChannelInboundEnvelope = {
  channelName: 'telegram-work',
  provider: 'telegram',
  accountId: 'work',
  peer: { kind: 'dm', id: '3175140114' },
  threadId: '3175140114',
  sender: { id: '3175140114' },
  messageId: 'telegram:update:101:message:1',
  text: 'hello',
};

describe('ChannelGatewayClient', () => {
  it('posts bearer-authenticated inbound envelopes to the channel route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ action: 'created' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ChannelGatewayClient({
      baseUrl: 'http://operator:8089/',
      token: 'token',
      timeoutMs: 5000,
      fetchImpl,
    });

    await expect(client.postInbound(envelope)).resolves.toEqual({ action: 'created' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://operator:8089/channels/telegram-work/inbound',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope),
      }),
    );
  });

  it('throws structured errors for non-2xx gateway responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ action: 'denied', reason: 'pairing_required' }), {
        status: 403,
      }),
    );
    const client = new ChannelGatewayClient({
      baseUrl: 'http://operator:8089',
      token: 'token',
      fetchImpl,
    });

    await expect(client.postInbound(envelope)).rejects.toMatchObject({
      status: 403,
      body: { action: 'denied', reason: 'pairing_required' },
    } satisfies Partial<ChannelGatewayHttpError>);
  });
});
