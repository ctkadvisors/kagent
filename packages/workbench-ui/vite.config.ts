/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config — proxies `/api` and `/healthz`/`/readyz` to the
 * workbench-api dev server (default :8080). In production the same-
 * origin assumption holds because the UI is served behind the same
 * Ingress as the API.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/readyz': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
