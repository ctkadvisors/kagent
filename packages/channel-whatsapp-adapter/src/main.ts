/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

import { createBaileysSocketFactory } from './baileys.js';
import { loadConfig } from './config.js';
import { ChannelGatewayClient } from './gateway.js';
import { startWhatsAppAdapter } from './runtime.js';
import {
  buildKubernetesChannelOutboxStore,
  buildKubernetesChannelStatusPatcher,
} from './status.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  const customApi = kubeConfig.makeApiClient(CustomObjectsApi);

  const running = await startWhatsAppAdapter(config, {
    socketFactory: createBaileysSocketFactory(),
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
    requestRestart: (reason) => {
      console.warn(`[channel-whatsapp] ${reason}; exiting for Kubernetes restart`);
      setTimeout(() => process.exit(1), 1000).unref();
    },
  });

  const shutdown = (): void => {
    running.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error('[channel-whatsapp] fatal startup error', err);
  process.exit(1);
});
