/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('loads required channel, Telegram, and gateway settings with safe defaults', () => {
    const config = loadConfig({
      KAGENT_CHANNEL_NAME: 'telegram-work',
      KAGENT_CHANNEL_ACCOUNT_ID: 'work',
      KAGENT_TELEGRAM_BOT_TOKEN: '123456:bot-token',
      KAGENT_CHANNEL_GATEWAY_URL: 'http://operator:8089/',
      KAGENT_CHANNEL_GATEWAY_TOKEN: 'secret',
      POD_NAMESPACE: 'kagent-system',
    });

    expect(config).toEqual({
      channelName: 'telegram-work',
      namespace: 'kagent-system',
      accountId: 'work',
      botToken: '123456:bot-token',
      telegramApiBaseUrl: 'https://api.telegram.org',
      gatewayUrl: 'http://operator:8089',
      gatewayToken: 'secret',
      gatewayTimeoutMs: 10000,
      pollTimeoutSeconds: 25,
      pollIntervalMs: 1000,
      outboundPollMs: 5000,
      outboundBaseBackoffSeconds: 60,
      outboundMaxFailures: 5,
    });
  });

  it('requires the Telegram bot token fail-closed', () => {
    expect(() =>
      loadConfig({
        KAGENT_CHANNEL_NAME: 'telegram-work',
        KAGENT_CHANNEL_ACCOUNT_ID: 'work',
        KAGENT_CHANNEL_GATEWAY_URL: 'http://operator:8089',
        KAGENT_CHANNEL_GATEWAY_TOKEN: 'secret',
      }),
    ).toThrow(/KAGENT_TELEGRAM_BOT_TOKEN is required/);
  });

  it('rejects malformed integer knobs', () => {
    expect(() =>
      loadConfig({
        KAGENT_CHANNEL_NAME: 'telegram-work',
        KAGENT_CHANNEL_ACCOUNT_ID: 'work',
        KAGENT_TELEGRAM_BOT_TOKEN: '123456:bot-token',
        KAGENT_CHANNEL_GATEWAY_URL: 'http://operator:8089',
        KAGENT_CHANNEL_GATEWAY_TOKEN: 'secret',
        KAGENT_TELEGRAM_POLL_TIMEOUT_SECONDS: '0',
      }),
    ).toThrow(/KAGENT_TELEGRAM_POLL_TIMEOUT_SECONDS must be a positive integer/);
  });

  it('loads polling and outbound retry knobs', () => {
    const config = loadConfig({
      KAGENT_CHANNEL_NAME: 'telegram-work',
      KAGENT_CHANNEL_ACCOUNT_ID: 'work',
      KAGENT_TELEGRAM_BOT_TOKEN: '123456:bot-token',
      KAGENT_TELEGRAM_API_BASE_URL: 'http://telegram.local/',
      KAGENT_CHANNEL_GATEWAY_URL: 'http://operator:8089',
      KAGENT_CHANNEL_GATEWAY_TOKEN: 'secret',
      KAGENT_TELEGRAM_POLL_TIMEOUT_SECONDS: '10',
      KAGENT_TELEGRAM_POLL_INTERVAL_MS: '250',
      KAGENT_CHANNEL_OUTBOUND_POLL_MS: '2500',
      KAGENT_CHANNEL_OUTBOUND_BASE_BACKOFF_SECONDS: '15',
      KAGENT_CHANNEL_OUTBOUND_MAX_FAILURES: '2',
    });

    expect(config.telegramApiBaseUrl).toBe('http://telegram.local');
    expect(config.pollTimeoutSeconds).toBe(10);
    expect(config.pollIntervalMs).toBe(250);
    expect(config.outboundPollMs).toBe(2500);
    expect(config.outboundBaseBackoffSeconds).toBe(15);
    expect(config.outboundMaxFailures).toBe(2);
  });
});
