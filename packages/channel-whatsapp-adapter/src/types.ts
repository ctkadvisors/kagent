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
  readonly outboundPollMs: number;
  readonly outboundBaseBackoffSeconds: number;
  readonly outboundMaxFailures: number;
}

export interface ObjectMetaLike {
  readonly name?: string;
  readonly namespace?: string;
  readonly uid?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
  readonly generation?: number;
}

export interface ChannelLocalRef {
  readonly name: string;
}

export interface ChannelTaskRef {
  readonly namespace: string;
  readonly name: string;
  readonly uid?: string;
}

export type ChannelSessionPhase = 'Pending' | 'Active' | 'Paused' | 'Backoff' | 'Failed';

export interface ChannelBindingTarget {
  readonly agentRef?: ChannelLocalRef;
  readonly capability?: string;
  readonly profileRef?: string;
  readonly modelClass?: string;
  readonly toolProfileRef?: string;
  readonly runConfig?: Record<string, unknown>;
  readonly session?: {
    readonly scope?: 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer';
    readonly mainKey?: string;
  };
}

export interface ChannelSessionSpec {
  readonly channelRef: ChannelLocalRef;
  readonly provider: ChannelProvider;
  readonly accountId: string;
  readonly peer: ChannelPeer;
  readonly threadId?: string;
  readonly sessionKey: string;
  readonly bindingRef?: ChannelLocalRef;
  readonly target: ChannelBindingTarget;
  readonly paused?: boolean;
}

export interface ChannelSessionStatus {
  readonly phase?: ChannelSessionPhase;
  readonly observedGeneration?: number;
  readonly conditions?: readonly ChannelCondition[];
  readonly lastInboundAt?: string;
  readonly lastOutboundAt?: string;
  readonly lastTaskRef?: ChannelTaskRef;
  readonly lastOutboundTaskRef?: ChannelTaskRef;
  readonly consecutiveFailures?: number;
  readonly backoffUntil?: string;
  readonly lastFailureReason?: string;
}

export interface ChannelSessionStatusPatch {
  readonly phase?: ChannelSessionPhase;
  readonly lastOutboundAt?: string;
  readonly lastOutboundTaskRef?: ChannelTaskRef;
  readonly consecutiveFailures?: number;
  readonly backoffUntil?: string | null;
  readonly lastFailureReason?: string | null;
}

export interface ChannelSession {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'ChannelSession';
  readonly metadata: ObjectMetaLike;
  readonly spec: ChannelSessionSpec;
  readonly status?: ChannelSessionStatus;
}

export type AgentTaskPhase = 'Pending' | 'Dispatched' | 'Completed' | 'Failed';

export interface AgentTaskStatus {
  readonly phase?: AgentTaskPhase;
  readonly result?: unknown;
  readonly error?: string;
  readonly completedAt?: string;
}

export interface AgentTask {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'AgentTask';
  readonly metadata: ObjectMetaLike;
  readonly spec: Record<string, unknown>;
  readonly status?: AgentTaskStatus;
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

export interface ChannelOutboxStore {
  listChannelSessions(input: {
    readonly namespace: string;
    readonly channelName: string;
    readonly accountId: string;
  }): Promise<readonly ChannelSession[]>;
  getAgentTask(ref: ChannelTaskRef): Promise<AgentTask | undefined>;
  patchSessionStatus(
    namespace: string,
    name: string,
    status: ChannelSessionStatusPatch,
  ): Promise<void>;
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
  sendMessage?(jid: string, content: { readonly text: string }): Promise<unknown>;
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
