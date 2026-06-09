/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { startToolGatewayServer, parseToolGatewayServerConfig } from './server.js';

const config = parseToolGatewayServerConfig();
const server = await startToolGatewayServer(config);

console.log(`[kagent-tool-gateway] listening on :${config.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
