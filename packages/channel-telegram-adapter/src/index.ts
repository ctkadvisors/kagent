/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

export { loadConfig } from './config.js';
export { ChannelGatewayClient, ChannelGatewayHttpError } from './gateway.js';
export { normalizeTelegramUpdate } from './normalize.js';
export { deliverOutboundTurns } from './outbound.js';
export {
  processTelegramUpdates,
  startTelegramAdapter,
  type RunningTelegramAdapter,
  type StartTelegramAdapterDeps,
  type TelegramUpdateProcessingResult,
} from './runtime.js';
export { adapterCondition, buildKubernetesChannelStatusPatcher } from './status.js';
export { TelegramApiError, TelegramHttpClient } from './telegram.js';
export type {
  AdapterLogger,
  ChannelGateway,
  ChannelInboundEnvelope,
  ChannelPairingStatus,
  ChannelPeer,
  ChannelStatusPatch,
  ChannelStatusPatcher,
  TelegramAdapterConfig,
  TelegramChat,
  TelegramClient,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from './types.js';
