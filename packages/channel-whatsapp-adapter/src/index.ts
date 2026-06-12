/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

export { createBaileysSocketFactory } from './baileys.js';
export { loadConfig } from './config.js';
export { ChannelGatewayClient, ChannelGatewayHttpError } from './gateway.js';
export { extractWhatsAppText, normalizeWhatsAppMessage } from './normalize.js';
export { startWhatsAppAdapter } from './runtime.js';
export { adapterCondition, buildKubernetesChannelStatusPatcher } from './status.js';
export type {
  AdapterLogger,
  ChannelGateway,
  ChannelInboundEnvelope,
  ChannelPairingStatus,
  ChannelPeer,
  ChannelStatusPatch,
  ChannelStatusPatcher,
  WhatsAppAdapterConfig,
  WhatsAppConnectionUpdate,
  WhatsAppMessageKey,
  WhatsAppMessageLike,
  WhatsAppMessagesUpsert,
  WhatsAppSocketFactory,
  WhatsAppSocketLike,
  WhatsAppSocketSession,
} from './types.js';
