/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config — proxies `/api`, `/healthz`, `/readyz` to a workbench-api
 * target. Default target is the live homelab cluster
 * (https://kagent.knuteson.io) — reachable from a developer mac because
 * Tailscale is up and the cluster Ingress is exposed via the elitemini
 * tailscale router. This means `npm run dev` Just Works against real
 * cluster state with no port-forwards required (which CLAUDE.md forbids
 * anyway).
 *
 * Override with `VITE_API_TARGET=http://localhost:8080` when running a
 * workbench-api locally; the value is whatever URL the API listens on.
 *
 * In production, same-origin still holds because the UI is served
 * behind the same Ingress as the API; this proxy is dev-only.
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'https://kagent.knuteson.io';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        secure: true,
        ws: true,
      },
      '/healthz': { target: API_TARGET, changeOrigin: true, secure: true },
      '/readyz': { target: API_TARGET, changeOrigin: true, secure: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
