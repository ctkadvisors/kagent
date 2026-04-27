/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Operator entrypoint — boots a KubeConfig, opens an informer on
 * AgentTask, and routes events to the (Phase 2 C4) reconcile loop.
 * In Phase 2 C3 the handler is a logging stub; C4 swaps it for the
 * real reconcile body.
 *
 * Run via `pnpm --filter @kagent/operator start` (uses tsx). In-cluster
 * boot loads via service-account mount; out-of-cluster falls back to
 * KUBECONFIG / ~/.kube/config.
 */

import { StubDispatcher, type Dispatcher } from './dispatcher.js';
import type { AgentTaskHandler } from './watch.js';
import { createAgentTaskInformer } from './watch.js';
import { loadKubeConfig, makeCustomObjectsApi } from './k8s.js';

/**
 * Build the handler given a Dispatcher. Phase 2 C3 logs only; C4
 * inserts the reconcile body. Exported so tests can drive it without
 * standing up a real informer.
 */
export function buildHandler(
  _dispatcher: Dispatcher /* will be threaded through to reconcile in C4 */,
): AgentTaskHandler {
  return {
    onAdd(task) {
      console.log(
        `[kagent-operator] add AgentTask ${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'}`,
      );
    },
    onUpdate(task) {
      console.log(
        `[kagent-operator] update AgentTask ${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'} phase=${task.status?.phase ?? 'Pending'}`,
      );
    },
    onDelete(task) {
      console.log(
        `[kagent-operator] delete AgentTask ${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'}`,
      );
    },
    onError(err) {
      console.error('[kagent-operator] watch error:', err);
    },
  };
}

async function main(): Promise<void> {
  const kc = loadKubeConfig();
  const api = makeCustomObjectsApi(kc);
  const dispatcher: Dispatcher = new StubDispatcher();

  const handler = buildHandler(dispatcher);
  const informer = createAgentTaskInformer(kc, api, handler);

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
