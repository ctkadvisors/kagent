/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { WhatsAppAdapterConfig } from './types.js';

type Env = Record<string, string | undefined>;

const DEFAULT_AUTH_DIR = '/var/lib/kagent/whatsapp-auth';
const DEFAULT_GATEWAY_TIMEOUT_MS = 10000;
const DEFAULT_PAIRING_TTL_SECONDS = 120;

export function loadConfig(env: Env = process.env): WhatsAppAdapterConfig {
  return {
    channelName: required(env, 'KAGENT_CHANNEL_NAME'),
    namespace: optional(env.KAGENT_CHANNEL_NAMESPACE) ?? optional(env.POD_NAMESPACE) ?? 'default',
    accountId: required(env, 'KAGENT_CHANNEL_ACCOUNT_ID'),
    gatewayUrl: trimTrailingSlash(required(env, 'KAGENT_CHANNEL_GATEWAY_URL')),
    gatewayToken: required(env, 'KAGENT_CHANNEL_GATEWAY_TOKEN'),
    gatewayTimeoutMs: parsePositiveInteger(
      env.KAGENT_CHANNEL_GATEWAY_TIMEOUT_MS,
      DEFAULT_GATEWAY_TIMEOUT_MS,
      'KAGENT_CHANNEL_GATEWAY_TIMEOUT_MS',
    ),
    authDir: optional(env.KAGENT_WHATSAPP_AUTH_DIR) ?? DEFAULT_AUTH_DIR,
    sendReadReceipts: parseBoolean(env.KAGENT_WHATSAPP_SEND_READ_RECEIPTS, false),
    pairingTtlSeconds: parsePositiveInteger(
      env.KAGENT_WHATSAPP_PAIRING_TTL_SECONDS,
      DEFAULT_PAIRING_TTL_SECONDS,
      'KAGENT_WHATSAPP_PAIRING_TTL_SECONDS',
    ),
  };
}

function required(env: Env, key: string): string {
  const value = optional(env[key]);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = optional(value)?.toLowerCase();
  if (normalized === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`boolean env value expected, got ${value}`);
}

function parsePositiveInteger(value: string | undefined, fallback: number, key: string): number {
  const normalized = optional(value);
  if (normalized === undefined) return fallback;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== normalized) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}
