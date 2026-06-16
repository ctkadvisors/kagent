/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

import { loadConfig } from './config.js';
import { ChannelGatewayClient } from './gateway.js';
import { startTelegramAdapter } from './runtime.js';
import {
  buildKubernetesChannelOutboxStore,
  buildKubernetesChannelStatusPatcher,
} from './status.js';
import { TelegramHttpClient } from './telegram.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  const customApi = kubeConfig.makeApiClient(CustomObjectsApi);

  const running = await startTelegramAdapter(config, {
    client: new TelegramHttpClient({
      apiBaseUrl: config.telegramApiBaseUrl,
      botToken: config.botToken,
    }),
    gateway: new ChannelGatewayClient({
      baseUrl: config.gatewayUrl,
      token: config.gatewayToken,
      timeoutMs: config.gatewayTimeoutMs,
    }),
    status: buildKubernetesChannelStatusPatcher({
      customApi,
      namespace: config.namespace,
      channelName: config.channelName,
    }),
    outbox: buildKubernetesChannelOutboxStore({ customApi }),
  });

  const shutdown = (): void => {
    running.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error('[channel-telegram] fatal startup error', err);
  process.exit(1);
});
