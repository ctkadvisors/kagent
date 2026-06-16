/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { TelegramAdapterConfig } from './types.js';

type Env = Record<string, string | undefined>;

const DEFAULT_TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_GATEWAY_TIMEOUT_MS = 10000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_OUTBOUND_POLL_MS = 5000;
const DEFAULT_OUTBOUND_BASE_BACKOFF_SECONDS = 60;
const DEFAULT_OUTBOUND_MAX_FAILURES = 5;

export function loadConfig(env: Env = process.env): TelegramAdapterConfig {
  return {
    channelName: required(env, 'KAGENT_CHANNEL_NAME'),
    namespace: optional(env.KAGENT_CHANNEL_NAMESPACE) ?? optional(env.POD_NAMESPACE) ?? 'default',
    accountId: required(env, 'KAGENT_CHANNEL_ACCOUNT_ID'),
    botToken: required(env, 'KAGENT_TELEGRAM_BOT_TOKEN'),
    telegramApiBaseUrl: trimTrailingSlash(
      optional(env.KAGENT_TELEGRAM_API_BASE_URL) ?? DEFAULT_TELEGRAM_API_BASE_URL,
    ),
    gatewayUrl: trimTrailingSlash(required(env, 'KAGENT_CHANNEL_GATEWAY_URL')),
    gatewayToken: required(env, 'KAGENT_CHANNEL_GATEWAY_TOKEN'),
    gatewayTimeoutMs: parsePositiveInteger(
      env.KAGENT_CHANNEL_GATEWAY_TIMEOUT_MS,
      DEFAULT_GATEWAY_TIMEOUT_MS,
      'KAGENT_CHANNEL_GATEWAY_TIMEOUT_MS',
    ),
    pollTimeoutSeconds: parsePositiveInteger(
      env.KAGENT_TELEGRAM_POLL_TIMEOUT_SECONDS,
      DEFAULT_POLL_TIMEOUT_SECONDS,
      'KAGENT_TELEGRAM_POLL_TIMEOUT_SECONDS',
    ),
    pollIntervalMs: parsePositiveInteger(
      env.KAGENT_TELEGRAM_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      'KAGENT_TELEGRAM_POLL_INTERVAL_MS',
    ),
    outboundPollMs: parsePositiveInteger(
      env.KAGENT_CHANNEL_OUTBOUND_POLL_MS,
      DEFAULT_OUTBOUND_POLL_MS,
      'KAGENT_CHANNEL_OUTBOUND_POLL_MS',
    ),
    outboundBaseBackoffSeconds: parsePositiveInteger(
      env.KAGENT_CHANNEL_OUTBOUND_BASE_BACKOFF_SECONDS,
      DEFAULT_OUTBOUND_BASE_BACKOFF_SECONDS,
      'KAGENT_CHANNEL_OUTBOUND_BASE_BACKOFF_SECONDS',
    ),
    outboundMaxFailures: parsePositiveInteger(
      env.KAGENT_CHANNEL_OUTBOUND_MAX_FAILURES,
      DEFAULT_OUTBOUND_MAX_FAILURES,
      'KAGENT_CHANNEL_OUTBOUND_MAX_FAILURES',
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

function parsePositiveInteger(value: string | undefined, fallback: number, key: string): number {
  const normalized = optional(value);
  if (normalized === undefined) return fallback;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== normalized) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}
