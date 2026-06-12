/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

export const API_GROUP = 'kagent.knuteson.io';
export const API_VERSION = 'v1alpha1';
export const API_GROUP_VERSION = `${API_GROUP}/${API_VERSION}` as const;

export type ChannelProvider = 'whatsapp';
export type ChannelPeerKind = 'dm' | 'group' | 'channel' | 'room';
export type ChannelPhase = 'Pending' | 'Pairing' | 'Ready' | 'Paused' | 'Failed';

export interface ChannelPeer {
  readonly kind: ChannelPeerKind;
  readonly id: string;
}

export interface ChannelInboundEnvelope {
  readonly channelName: string;
  readonly provider: ChannelProvider;
  readonly accountId: string;
  readonly peer: ChannelPeer;
  readonly threadId?: string;
  readonly sender?: { readonly id: string; readonly displayName?: string };
  readonly messageId: string;
  readonly text: string;
}

export interface ChannelPairingStatus {
  readonly state: 'unpaired' | 'qr' | 'paired' | 'failed';
  readonly qrCode?: string;
  readonly pairingCode?: string;
  readonly expiresAt?: string;
  readonly accountJid?: string;
  readonly message?: string;
}

export interface ChannelCondition {
  readonly type: string;
  readonly status: 'True' | 'False' | 'Unknown';
  readonly reason?: string;
  readonly message?: string;
  readonly lastTransitionTime?: string;
}

export interface ChannelStatusPatch {
  readonly phase?: ChannelPhase;
  readonly observedGeneration?: number;
  readonly conditions?: readonly ChannelCondition[];
  readonly pairing?: ChannelPairingStatus;
  readonly lastHeartbeatAt?: string;
  readonly activeSessionCount?: number;
}

export interface WhatsAppAdapterConfig {
  readonly channelName: string;
  readonly namespace: string;
  readonly accountId: string;
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  readonly gatewayTimeoutMs: number;
  readonly authDir: string;
  readonly sendReadReceipts: boolean;
  readonly pairingTtlSeconds: number;
}

export interface WhatsAppMessageKey {
  readonly id?: string | null;
  readonly remoteJid?: string | null;
  readonly fromMe?: boolean | null;
  readonly participant?: string | null;
}

export interface WhatsAppMessageLike {
  readonly key?: WhatsAppMessageKey;
  readonly pushName?: string | null;
  readonly message?: unknown;
}

export interface WhatsAppMessagesUpsert {
  readonly type?: string;
  readonly messages: readonly WhatsAppMessageLike[];
}

export interface WhatsAppConnectionUpdate {
  readonly connection?: 'connecting' | 'open' | 'close';
  readonly qr?: string;
  readonly receivedPendingNotifications?: boolean;
  readonly lastDisconnect?: unknown;
}

export interface ChannelGateway {
  postInbound(envelope: ChannelInboundEnvelope): Promise<unknown>;
}

export interface ChannelStatusPatcher {
  patch(status: ChannelStatusPatch): Promise<void>;
}

export interface AdapterLogger {
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export interface WhatsAppEventBus {
  on(event: 'connection.update', handler: (update: WhatsAppConnectionUpdate) => void): void;
  on(event: 'creds.update', handler: () => void): void;
  on(event: 'messages.upsert', handler: (upsert: WhatsAppMessagesUpsert) => void): void;
}

export interface WhatsAppSocketLike {
  readonly ev: WhatsAppEventBus;
  readonly user?: { readonly id?: string | null };
  readMessages?(keys: readonly WhatsAppMessageKey[]): Promise<void>;
  end?(error?: Error): void;
}

export interface WhatsAppSocketSession {
  readonly socket: WhatsAppSocketLike;
  readonly saveCreds: () => Promise<void> | void;
}

export type WhatsAppSocketFactory = (input: {
  readonly authDir: string;
}) => Promise<WhatsAppSocketSession>;
