/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { extractWhatsAppText, normalizeWhatsAppMessage } from './normalize.js';

const config = { channelName: 'whatsapp-work', accountId: 'work' };

describe('normalizeWhatsAppMessage', () => {
  it('normalizes direct messages into channel gateway envelopes', () => {
    const envelope = normalizeWhatsAppMessage(config, {
      key: {
        id: 'msg-1',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false,
      },
      pushName: 'Ada',
      message: { conversation: 'Investigate the alert' },
    });

    expect(envelope).toEqual({
      channelName: 'whatsapp-work',
      provider: 'whatsapp',
      accountId: 'work',
      peer: { kind: 'dm', id: '15551234567@s.whatsapp.net' },
      threadId: '15551234567@s.whatsapp.net',
      sender: { id: '15551234567@s.whatsapp.net', displayName: 'Ada' },
      messageId: 'msg-1',
      text: 'Investigate the alert',
    });
  });

  it('normalizes group messages with participant sender identity', () => {
    const envelope = normalizeWhatsAppMessage(config, {
      key: {
        id: 'group-msg-1',
        remoteJid: '1203630@g.us',
        participant: '15557654321@s.whatsapp.net',
        fromMe: false,
      },
      message: { extendedTextMessage: { text: '@kagent summarize' } },
    });

    expect(envelope?.peer).toEqual({ kind: 'group', id: '1203630@g.us' });
    expect(envelope?.sender).toEqual({ id: '15557654321@s.whatsapp.net' });
    expect(envelope?.text).toBe('@kagent summarize');
  });

  it('ignores outbound, missing-id, and non-text messages', () => {
    expect(
      normalizeWhatsAppMessage(config, {
        key: { id: 'msg-1', remoteJid: '15551234567@s.whatsapp.net', fromMe: true },
        message: { conversation: 'self' },
      }),
    ).toBeUndefined();
    expect(
      normalizeWhatsAppMessage(config, {
        key: { remoteJid: '15551234567@s.whatsapp.net' },
        message: { conversation: 'missing id' },
      }),
    ).toBeUndefined();
    expect(
      normalizeWhatsAppMessage(config, {
        key: { id: 'msg-2', remoteJid: '15551234567@s.whatsapp.net' },
        message: { imageMessage: {} },
      }),
    ).toBeUndefined();
  });
});

describe('extractWhatsAppText', () => {
  it('unwraps ephemeral image captions', () => {
    expect(
      extractWhatsAppText({
        ephemeralMessage: {
          message: {
            imageMessage: { caption: 'chart this receipt' },
          },
        },
      }),
    ).toBe('chart this receipt');
  });
});
