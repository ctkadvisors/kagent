/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('loads required channel and gateway settings with safe defaults', () => {
    const config = loadConfig({
      KAGENT_CHANNEL_NAME: 'whatsapp-work',
      KAGENT_CHANNEL_ACCOUNT_ID: 'work',
      KAGENT_CHANNEL_GATEWAY_URL: 'http://operator:8089/',
      KAGENT_CHANNEL_GATEWAY_TOKEN: 'secret',
      POD_NAMESPACE: 'kagent-system',
    });

    expect(config).toEqual({
      channelName: 'whatsapp-work',
      namespace: 'kagent-system',
      accountId: 'work',
      gatewayUrl: 'http://operator:8089',
      gatewayToken: 'secret',
      gatewayTimeoutMs: 10000,
      authDir: '/var/lib/kagent/whatsapp-auth',
      sendReadReceipts: false,
      pairingTtlSeconds: 120,
      outboundPollMs: 5000,
      outboundBaseBackoffSeconds: 60,
      outboundMaxFailures: 5,
    });
  });

  it('requires the gateway token fail-closed', () => {
    expect(() =>
      loadConfig({
        KAGENT_CHANNEL_NAME: 'whatsapp-work',
        KAGENT_CHANNEL_ACCOUNT_ID: 'work',
        KAGENT_CHANNEL_GATEWAY_URL: 'http://operator:8089',
      }),
    ).toThrow(/KAGENT_CHANNEL_GATEWAY_TOKEN is required/);
  });

  it('rejects malformed integer knobs', () => {
    expect(() =>
      loadConfig({
        KAGENT_CHANNEL_NAME: 'whatsapp-work',
        KAGENT_CHANNEL_ACCOUNT_ID: 'work',
        KAGENT_CHANNEL_GATEWAY_URL: 'http://operator:8089',
        KAGENT_CHANNEL_GATEWAY_TOKEN: 'secret',
        KAGENT_CHANNEL_GATEWAY_TIMEOUT_MS: '0',
      }),
    ).toThrow(/KAGENT_CHANNEL_GATEWAY_TIMEOUT_MS must be a positive integer/);
  });

  it('loads outbound delivery retry knobs', () => {
    const config = loadConfig({
      KAGENT_CHANNEL_NAME: 'whatsapp-work',
      KAGENT_CHANNEL_ACCOUNT_ID: 'work',
      KAGENT_CHANNEL_GATEWAY_URL: 'http://operator:8089',
      KAGENT_CHANNEL_GATEWAY_TOKEN: 'secret',
      KAGENT_CHANNEL_OUTBOUND_POLL_MS: '2500',
      KAGENT_CHANNEL_OUTBOUND_BASE_BACKOFF_SECONDS: '15',
      KAGENT_CHANNEL_OUTBOUND_MAX_FAILURES: '2',
    });

    expect(config.outboundPollMs).toBe(2500);
    expect(config.outboundBaseBackoffSeconds).toBe(15);
    expect(config.outboundMaxFailures).toBe(2);
  });
});
