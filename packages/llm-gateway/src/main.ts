/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Gateway entrypoint. Boots once per Pod:
 *
 *   1. parseEnv → freeze GatewayConfig
 *   2. open `pg` Pool from DATABASE_URL
 *   3. apply migrations from ./migrations/
 *   4. construct AIMD + InFlightCounter + ModelIndex
 *   5. start the K8s informer for ModelEndpoint CRs
 *   6. wire the http server (router + admin + health)
 *   7. install SIGTERM/SIGINT shutdown
 *
 * Mirrors `packages/agent-pod/src/main.ts` shape: top-level `main()`,
 * direct-invocation guard, signal handlers translate to graceful
 * close. K8s readiness pings the DB so the cluster doesn't route
 * traffic until pg is reachable.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

import { AimdController } from './aimd.js';
import { createApiKeyRepo } from './db/api-keys.js';
import { applyMigrations, loadMigrationsFromDir } from './db/migrations.js';
import { createPool, pingPool } from './db/pool.js';
import { createUsageRepo } from './db/usage.js';
import { parseEnv } from './env.js';
import { InFlightCounter } from './inflight-counter.js';
import { ModelIndex } from './model-index.js';
import { createModelEndpointWatch } from './model-watch.js';
import { startServer } from './server.js';
import { createUsageRecorder } from './usage-recorder.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const cfg = parseEnv(process.env);

  const configuredBackends = Object.keys(cfg.backendApiKeys).sort().join(',') || '<none>';
  console.log(
    `[llm-gateway] boot port=${String(cfg.port)} ns=${cfg.modelEndpointNamespace} backendApiKeys=[${configuredBackends}]`,
  );

  // Audit B7: split-credential path wins over legacy DSN. parseEnv
  // guarantees exactly one of `cfg.database` / `cfg.databaseUrl` is
  // populated; createPool refuses both paths.
  const pool =
    cfg.database !== null
      ? createPool({ connConfig: cfg.database })
      : createPool({ connectionString: cfg.databaseUrl ?? '' });
  const dbMode =
    cfg.database !== null ? `split sslmode=${cfg.database.sslMode}` : 'dsn (DATABASE_URL)';
  console.log(`[llm-gateway] db config: ${dbMode}`);
  // Migrations run synchronously at boot — keeps the chart's
  // post-install Job optional for dev/local. In production the chart
  // *also* runs them as a Hook so a fresh image deploys against an
  // already-migrated DB; the runner is idempotent so the second pass
  // no-ops.
  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const migrations = await loadMigrationsFromDir(migrationsDir);
  const applied = await applyMigrations(pool, migrations);

  console.log(
    `[llm-gateway] migrations: applied=[${applied.applied.join(',')}] skipped=[${applied.skipped.join(',')}]`,
  );

  const apiKeyRepo = createApiKeyRepo(pool);
  const usageRepo = createUsageRepo(pool);
  const usageRecorder = createUsageRecorder(usageRepo);

  const modelIndex = new ModelIndex();
  const inFlight = new InFlightCounter();
  // The controller defaults are also the absolute fallback bounds for
  // a request that lands BEFORE the K8s informer has cached the CR
  // — we pick conservative numbers (seed=1, max=4, minSafe=1) so a
  // zero-traffic startup can't flood a backend.
  const aimd = new AimdController({ seed: 1, max: 4, minSafe: 1 });

  const kc = new KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    // out-of-cluster (local dev) — fall back to default kubeconfig
    kc.loadFromDefault();
  }
  const customApi = kc.makeApiClient(CustomObjectsApi);
  const watch = createModelEndpointWatch(kc, customApi, modelIndex, aimd, {
    namespace: cfg.modelEndpointNamespace,
  });
  await watch.start();

  console.log('[llm-gateway] ModelEndpoint informer started');

  const server = startServer(cfg.port, {
    modelIndex,
    inFlight,
    aimd,
    usageRepo,
    apiKeyLookup: (
      h,
    ): Promise<ReturnType<typeof apiKeyRepo.getByHash> extends Promise<infer T> ? T : never> =>
      apiKeyRepo.getByHash(h),
    apiKeyRepo,
    adminToken: cfg.adminApiToken,
    readinessProbe: () => pingPool(pool),
    routerDeps: {
      modelIndex,
      inFlight,
      aimd,
      usage: usageRecorder,
      backendApiKeys: cfg.backendApiKeys,
    },
  });

  console.log(`[llm-gateway] http listening on :${String(cfg.port)}`);

  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      console.log(`[llm-gateway] received ${signal} during shutdown — ignoring re-entry`);
      return;
    }
    shuttingDown = true;

    console.log(`[llm-gateway] received ${signal}, draining`);

    const deadline = setTimeout(() => {
      console.error('[llm-gateway] shutdown deadline exceeded — exiting hard');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();

    void (async (): Promise<void> => {
      try {
        await server.close();
        await watch.stop();
        await pool.end();

        console.log('[llm-gateway] clean shutdown');
        process.exit(0);
      } catch (err) {
        console.error('[llm-gateway] shutdown error:', err);
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectInvocation) {
  main().catch((err: unknown) => {
    console.error('[llm-gateway] fatal:', err);
    process.exit(1);
  });
}
