/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Operator entrypoint — boots a KubeConfig, opens an informer on
 * AgentTask, and routes events into the reconcile loop.
 *
 * Run via `pnpm --filter @kagent/operator start` (uses tsx). In-cluster
 * boot loads via service-account mount; out-of-cluster falls back to
 * KUBECONFIG / ~/.kube/config.
 */

import { StubDispatcher } from './dispatcher.js';
import { loadKubeConfig, makeBatchApi, makeCustomObjectsApi } from './k8s.js';
import { reconcileAgentTask, type ReconcileDeps } from './reconcile.js';
import type { AgentTaskHandler } from './watch.js';
import { createAgentTaskInformer } from './watch.js';

/**
 * Build the watch handler given a set of reconcile dependencies. The
 * informer fires onAdd/onUpdate/onDelete; we route add+update through
 * reconcile (which is idempotent — re-reconciling a phase=Dispatched
 * task is a no-op short-circuit). Delete is a logging-only path
 * because the Job is OwnerRef'd to the AgentTask, so K8s GC removes
 * the Job (and its Pod) automatically when the AgentTask disappears.
 *
 * Exported for tests and for any embedded harness that wants to drive
 * the operator without booting an informer.
 */
export function buildHandler(deps: ReconcileDeps): AgentTaskHandler {
  return {
    async onAdd(task) {
      const result = await reconcileAgentTask(task, deps);
      logResult('add', task, result);
    },
    async onUpdate(task) {
      const result = await reconcileAgentTask(task, deps);
      logResult('update', task, result);
    },
    onDelete(task) {
      console.log(
        `[kagent-operator] delete AgentTask ${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'} (Job GC by ownerRef)`,
      );
    },
    onError(err) {
      console.error('[kagent-operator] watch error:', err);
    },
  };
}

function logResult(
  verb: 'add' | 'update',
  task: { metadata: { namespace?: string; name?: string } },
  result: { action: string; reason?: string; jobName?: string },
): void {
  const id = `${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'}`;
  const tail = result.jobName !== undefined ? ` job=${result.jobName}` : '';
  const why = result.reason !== undefined ? ` (${result.reason})` : '';
  console.log(`[kagent-operator] ${verb} ${id} → ${result.action}${tail}${why}`);
}

async function main(): Promise<void> {
  const kc = loadKubeConfig();
  const customApi = makeCustomObjectsApi(kc);
  const batchApi = makeBatchApi(kc);
  const dispatcher = new StubDispatcher();

  const deps: ReconcileDeps = { customApi, batchApi, dispatcher };
  const handler = buildHandler(deps);
  const informer = createAgentTaskInformer(kc, customApi, handler);

  // Graceful shutdown — stop the informer cleanly on SIGTERM/SIGINT
  // so K8s can drain the operator pod without orphaning the watch.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[kagent-operator] ${signal} — stopping informer`);
    try {
      await informer.stop();
    } catch (err) {
      console.error('[kagent-operator] informer.stop() failed:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('[kagent-operator] starting informer on AgentTask (cluster-wide)');
  await informer.start();
  console.log('[kagent-operator] informer started');
}

// Only run main() when this module is the entrypoint — unit tests
// import buildHandler() and friends without booting K8s.
const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectInvocation) {
  main().catch((err: unknown) => {
    console.error('[kagent-operator] fatal:', err);
    process.exit(1);
  });
}
