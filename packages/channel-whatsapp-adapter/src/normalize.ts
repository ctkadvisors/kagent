/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type {
  ChannelInboundEnvelope,
  ChannelPeerKind,
  WhatsAppAdapterConfig,
  WhatsAppMessageLike,
} from './types.js';

export function normalizeWhatsAppMessage(
  config: Pick<WhatsAppAdapterConfig, 'channelName' | 'accountId'>,
  message: WhatsAppMessageLike,
): ChannelInboundEnvelope | undefined {
  const key = message.key;
  if (key?.fromMe === true) return undefined;

  const remoteJid = nonEmpty(key?.remoteJid);
  const messageId = nonEmpty(key?.id);
  if (remoteJid === undefined || messageId === undefined) return undefined;

  const text = extractWhatsAppText(message.message)?.trim();
  if (text === undefined || text.length === 0) return undefined;

  const peerKind = peerKindForJid(remoteJid);
  const senderId = peerKind === 'group' ? nonEmpty(key?.participant) : remoteJid;
  const displayName = nonEmpty(message.pushName);

  return {
    channelName: config.channelName,
    provider: 'whatsapp',
    accountId: config.accountId,
    peer: { kind: peerKind, id: remoteJid },
    threadId: remoteJid,
    ...(senderId !== undefined && {
      sender: {
        id: senderId,
        ...(displayName !== undefined && { displayName }),
      },
    }),
    messageId,
    text,
  };
}

export function extractWhatsAppText(message: unknown): string | undefined {
  const unwrapped = unwrapMessage(message);
  const direct = readString(unwrapped, ['conversation']);
  if (direct !== undefined) return direct;

  const candidates: readonly (readonly string[])[] = [
    ['extendedTextMessage', 'text'],
    ['imageMessage', 'caption'],
    ['videoMessage', 'caption'],
    ['documentMessage', 'caption'],
    ['buttonsResponseMessage', 'selectedDisplayText'],
    ['buttonsResponseMessage', 'selectedButtonId'],
    ['templateButtonReplyMessage', 'selectedDisplayText'],
    ['templateButtonReplyMessage', 'selectedId'],
    ['listResponseMessage', 'title'],
    ['listResponseMessage', 'description'],
  ];

  for (const path of candidates) {
    const value = readString(unwrapped, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function peerKindForJid(jid: string): ChannelPeerKind {
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@broadcast')) return 'channel';
  return 'dm';
}

function unwrapMessage(message: unknown): unknown {
  let current = message;
  for (let i = 0; i < 4; i += 1) {
    const record = asRecord(current);
    const next =
      nested(record, ['ephemeralMessage', 'message']) ??
      nested(record, ['viewOnceMessage', 'message']) ??
      nested(record, ['viewOnceMessageV2', 'message']) ??
      nested(record, ['documentWithCaptionMessage', 'message']) ??
      nested(record, ['editedMessage', 'message']);
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

function readString(value: unknown, path: readonly string[]): string | undefined {
  const found = nested(asRecord(value), path);
  return typeof found === 'string' && found.trim().length > 0 ? found : undefined;
}

function nested(record: Record<string, unknown> | undefined, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    const currentRecord = asRecord(current);
    if (currentRecord === undefined) return undefined;
    current = currentRecord[segment];
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
