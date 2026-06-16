/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { normalizeTelegramUpdate } from './normalize.js';

const config = { channelName: 'telegram-work', accountId: 'work' };

describe('normalizeTelegramUpdate', () => {
  it('normalizes private text messages into channel gateway envelopes', () => {
    const envelope = normalizeTelegramUpdate(config, {
      update_id: 101,
      message: {
        message_id: 42,
        from: {
          id: 3175140114,
          is_bot: false,
          first_name: 'Chris',
          last_name: 'Knuteson',
          username: 'ctk',
        },
        chat: { id: 3175140114, type: 'private', first_name: 'Chris' },
        text: 'Investigate the failing backup',
      },
    });

    expect(envelope).toEqual({
      channelName: 'telegram-work',
      provider: 'telegram',
      accountId: 'work',
      peer: { kind: 'dm', id: '3175140114' },
      threadId: '3175140114',
      sender: { id: '3175140114', displayName: 'Chris Knuteson' },
      messageId: 'telegram:update:101:message:42',
      text: 'Investigate the failing backup',
    });
  });

  it('normalizes supergroup captions with sender identity', () => {
    const envelope = normalizeTelegramUpdate(config, {
      update_id: 102,
      message: {
        message_id: 12,
        from: { id: 111, is_bot: false, username: 'ada' },
        chat: { id: -1001234567890, type: 'supergroup', title: 'Ops' },
        caption: 'summarize this screenshot',
      },
    });

    expect(envelope?.peer).toEqual({ kind: 'group', id: '-1001234567890' });
    expect(envelope?.sender).toEqual({ id: '111', displayName: '@ada' });
    expect(envelope?.text).toBe('summarize this screenshot');
  });

  it('normalizes channel posts with sender_chat identity', () => {
    const envelope = normalizeTelegramUpdate(config, {
      update_id: 103,
      channel_post: {
        message_id: 7,
        sender_chat: { id: -100999, type: 'channel', title: 'Alerts' },
        chat: { id: -100999, type: 'channel', title: 'Alerts' },
        text: 'route this alert',
      },
    });

    expect(envelope?.peer).toEqual({ kind: 'channel', id: '-100999' });
    expect(envelope?.sender).toEqual({ id: '-100999', displayName: 'Alerts' });
    expect(envelope?.messageId).toBe('telegram:update:103:message:7');
  });

  it('ignores bot, missing-id, and non-text updates', () => {
    expect(
      normalizeTelegramUpdate(config, {
        update_id: 104,
        message: {
          message_id: 1,
          from: { id: 99, is_bot: true },
          chat: { id: 123, type: 'private' },
          text: 'self',
        },
      }),
    ).toBeUndefined();
    expect(
      normalizeTelegramUpdate(config, {
        update_id: 105,
        message: {
          chat: { id: 123, type: 'private' },
          text: 'missing message id',
        },
      }),
    ).toBeUndefined();
    expect(
      normalizeTelegramUpdate(config, {
        update_id: 106,
        message: {
          message_id: 2,
          chat: { id: 123, type: 'private' },
        },
      }),
    ).toBeUndefined();
  });
});
