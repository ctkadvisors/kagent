/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type {
  ChannelInboundEnvelope,
  ChannelPeerKind,
  TelegramAdapterConfig,
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from './types.js';

export function normalizeTelegramUpdate(
  config: Pick<TelegramAdapterConfig, 'channelName' | 'accountId'>,
  update: TelegramUpdate,
): ChannelInboundEnvelope | undefined {
  const updateId = telegramId(update.update_id);
  const message = telegramMessage(update);
  const messageId = telegramId(message?.message_id);
  const chatId = telegramId(message?.chat?.id);
  if (updateId === undefined || message === undefined || messageId === undefined) {
    return undefined;
  }
  if (chatId === undefined) return undefined;
  if (message.from?.is_bot === true) return undefined;

  const text = messageText(message);
  if (text === undefined) return undefined;

  const sender = senderIdentity(message);

  return {
    channelName: config.channelName,
    provider: 'telegram',
    accountId: config.accountId,
    peer: { kind: peerKind(message.chat), id: chatId },
    threadId: chatId,
    ...(sender !== undefined && { sender }),
    messageId: `telegram:update:${updateId}:message:${messageId}`,
    text,
  };
}

function telegramMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return (
    update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post
  );
}

function messageText(message: TelegramMessage): string | undefined {
  const text = nonEmpty(message.text) ?? nonEmpty(message.caption);
  return text === undefined ? undefined : text;
}

function peerKind(chat: TelegramChat | undefined): ChannelPeerKind {
  switch (chat?.type) {
    case 'private':
      return 'dm';
    case 'group':
    case 'supergroup':
      return 'group';
    case 'channel':
      return 'channel';
    default:
      return 'room';
  }
}

function senderIdentity(
  message: TelegramMessage,
): { readonly id: string; readonly displayName?: string } | undefined {
  const fromId = telegramId(message.from?.id);
  if (fromId !== undefined) {
    const displayName = userDisplayName(message.from);
    return {
      id: fromId,
      ...(displayName !== undefined && { displayName }),
    };
  }

  const senderChatId = telegramId(message.sender_chat?.id);
  if (senderChatId === undefined) return undefined;
  const displayName = chatDisplayName(message.sender_chat);
  return {
    id: senderChatId,
    ...(displayName !== undefined && { displayName }),
  };
}

function userDisplayName(user: TelegramUser | undefined): string | undefined {
  return personDisplayName(user?.first_name, user?.last_name, user?.username);
}

function chatDisplayName(chat: TelegramChat | undefined): string | undefined {
  return (
    nonEmpty(chat?.title) ??
    prefixedUsername(chat?.username) ??
    personDisplayName(chat?.first_name, chat?.last_name)
  );
}

function personDisplayName(
  firstName: string | undefined,
  lastName: string | undefined,
  username?: string,
): string | undefined {
  const joined = [firstName, lastName]
    .map((part) => nonEmpty(part))
    .filter((part): part is string => part !== undefined)
    .join(' ');
  if (joined.length > 0) return joined;
  return prefixedUsername(username);
}

function prefixedUsername(username: string | undefined): string | undefined {
  const value = nonEmpty(username);
  return value === undefined ? undefined : `@${value}`;
}

function telegramId(value: string | number | undefined): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  return nonEmpty(value);
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
