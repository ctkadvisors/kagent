/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Workbench API entrypoint. Boots a KubeConfig + informers + Hono
 * server. Run via `pnpm --filter @kagent/workbench-api start`.
 *
 * Env knobs:
 *
 *   - `WORKBENCH_PORT` (default 8080) — HTTP listen port.
 *   - `WORKBENCH_HOSTNAME` (default 0.0.0.0).
 *   - `WORKBENCH_UI_UPSTREAM` — loopback URL of the workbench-ui
 *     sidecar (e.g. `http://127.0.0.1:8081`). Enables the non-API
 *     reverse-proxy path. When unset, non-API routes 404 (intended
 *     for out-of-cluster + test contexts).
 *   - `KAGENT_NO_INFORMER` — skip informer boot. Useful for smoke-
 *     testing the entrypoint in CI without a live cluster.
 *
 * Naming: `WORKBENCH_*` (no `KAGENT_` prefix) is the chart contract —
 * see packages/operator/charts/kagent-workbench/templates/deployment.yaml.
 * `KAGENT_NO_INFORMER` keeps the prefix because it's a kagent-internal
 * test knob, not a chart-managed runtime input.
 *
 * In-cluster boot loads via service-account mount; out-of-cluster
 * falls back to KUBECONFIG / ~/.kube/config (same convention as the
 * operator).
 */

import {
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  type KubernetesListObject,
  type V1Job,
} from '@kubernetes/client-node';

import { SnapshotCache } from './cache.js';
import { createInformerSet, type InformerSet } from './informer.js';
import { buildRouter } from './router.js';
import { startServer } from './server.js';
import { SseBroker } from './sse.js';

const MANAGED_BY = 'kagent.knuteson.io/managed-by=kagent-operator';

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.WORKBENCH_PORT ?? '8080', 10);
  const hostname = process.env.WORKBENCH_HOSTNAME ?? '0.0.0.0';
  const skipInformer = process.env.KAGENT_NO_INFORMER === '1';

  const cache = new SnapshotCache();
  const broker = new SseBroker(cache);

  let ready = skipInformer; // in skip mode, we're "ready" immediately
  let informers: InformerSet | undefined;

  if (!skipInformer) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const customApi = kc.makeApiClient(CustomObjectsApi);
    const coreApi = kc.makeApiClient(CoreV1Api);
    const batchApi = kc.makeApiClient(BatchV1Api);

    const listJobs = async (): Promise<KubernetesListObject<V1Job>> => {
      return await batchApi.listJobForAllNamespaces({ labelSelector: MANAGED_BY });
    };

    informers = createInformerSet({ kc, customApi, coreApi, listJobs }, cache);
  }

  const uiUpstream = process.env.WORKBENCH_UI_UPSTREAM;
  const app = buildRouter({
    cache,
    broker,
    ready: () => ready,
    ...(typeof uiUpstream === 'string' && uiUpstream.length > 0 && { uiUpstream }),
  });
  const handle = startServer(app, { port, hostname });

  if (informers !== undefined) {
    console.log('[workbench-api] starting informers');
    await informers.start();
    ready = true;
    console.log('[workbench-api] informers ready');
  } else {
    console.log('[workbench-api] KAGENT_NO_INFORMER=1 — skipping informer boot');
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[workbench-api] ${signal} — shutting down`);
    try {
      if (informers !== undefined) await informers.stop();
    } catch (err) {
      console.error('[workbench-api] informer.stop() failed:', err);
    }
    try {
      await handle.close();
    } catch (err) {
      console.error('[workbench-api] server close failed:', err);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectInvocation) {
  main().catch((err: unknown) => {
    console.error('[workbench-api] fatal:', err);
    process.exit(1);
  });
}
