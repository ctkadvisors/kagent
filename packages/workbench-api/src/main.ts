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
 *   - `WORKBENCH_AUTH_REQUIRED` — fail-closed auth gate. Default
 *     (unset / any value other than the literal `"false"`) requires
 *     `X-Forwarded-User` on every non-probe request. Setting this to
 *     `"false"` disables enforcement and logs a loud warning at boot.
 *     See `auth.ts` for the trust model.
 *   - `LANGFUSE_BASE_URL` — when set, the workbench-api populates a
 *     `traceLink` field on the TaskDetail response so the UI can render
 *     a "View trace" deep-link. Trace IDs are derived in lockstep with
 *     `@kagent/trace-sinks`'s `traceIdFromRunId` (sha256(uid)[0..32]).
 *     When unset, the detail response omits `traceLink` and the UI
 *     hides the affordance. Surface set by the chart's `api.langfuseBaseUrl`.
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

import { resolveAuthRequired } from './auth.js';
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
  let writeCustomApi: CustomObjectsApi | undefined;
  let kubeConfig: KubeConfig | undefined;

  if (!skipInformer) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    kubeConfig = kc;
    const customApi = kc.makeApiClient(CustomObjectsApi);
    const coreApi = kc.makeApiClient(CoreV1Api);
    const batchApi = kc.makeApiClient(BatchV1Api);

    const listJobs = async (): Promise<KubernetesListObject<V1Job>> => {
      return await batchApi.listJobForAllNamespaces({ labelSelector: MANAGED_BY });
    };

    informers = createInformerSet({ kc, customApi, coreApi, listJobs }, cache);

    // WS-J write surface — opt-in via env. The chart's
    // `actions.create=true` flips `WORKBENCH_ACTIONS_ENABLED=true`,
    // which both wires the K8s client into the POST handler AND signals
    // the client that the write surface is live. Default-OFF so a
    // chart install with `actions.create=false` is provably write-proof.
    const actionsEnabled = process.env.WORKBENCH_ACTIONS_ENABLED === 'true';
    if (actionsEnabled) {
      writeCustomApi = customApi;
      console.log('[workbench-api] write surface ENABLED (POST /api/tasks)');
    } else {
      console.log(
        '[workbench-api] write surface disabled (set WORKBENCH_ACTIONS_ENABLED=true to enable)',
      );
    }
  }

  const uiUpstream = process.env.WORKBENCH_UI_UPSTREAM;
  const langfuseBaseUrl = process.env.LANGFUSE_BASE_URL;
  const authRequired = resolveAuthRequired();
  if (!authRequired) {
    console.warn(
      '[workbench-api] WORKBENCH_AUTH_REQUIRED=false — auth is DISABLED. ' +
        'Anyone with network access to this pod can reach every API route. ' +
        'Re-enable by unsetting WORKBENCH_AUTH_REQUIRED or setting it to anything other than "false".',
    );
  }

  // Resolve the default namespace for POST /api/tasks. The chart sets
  // WORKBENCH_DEFAULT_NAMESPACE to .Release.Namespace; out-of-cluster
  // we fall back to the kubeconfig's current context namespace, then
  // 'default' (handled inside the POST handler when undefined).
  const defaultNamespace =
    process.env.WORKBENCH_DEFAULT_NAMESPACE ??
    kubeConfig?.getContextObject(kubeConfig.getCurrentContext())?.namespace;

  const app = buildRouter({
    cache,
    broker,
    ready: () => ready,
    authRequired,
    ...(typeof uiUpstream === 'string' && uiUpstream.length > 0 && { uiUpstream }),
    ...(typeof langfuseBaseUrl === 'string' && langfuseBaseUrl.length > 0 && { langfuseBaseUrl }),
    ...(writeCustomApi !== undefined && { customApi: writeCustomApi }),
    ...(typeof defaultNamespace === 'string' &&
      defaultNamespace.length > 0 && { defaultNamespace }),
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
