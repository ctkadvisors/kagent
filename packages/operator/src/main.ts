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

import { CoreV1Api, type V1Job, type V1JobList, type V1Pod } from '@kubernetes/client-node';
import { connect, type NatsConnection } from 'nats';

import { StubCapabilityRegistry, type CapabilityRegistry } from './capability-registry.js';
import { StubDispatcher, type Dispatcher } from './dispatcher.js';
import { detectJobFailure, detectPodFailure } from './failure-detector.js';
import type { BuildJobSpecOptions } from './job-spec.js';
import { createJobPodInformer, parentTaskRef } from './job-watch.js';
import { loadKubeConfig, makeBatchApi, makeCustomObjectsApi } from './k8s.js';
import { NatsDispatcher } from './nats-dispatcher.js';
import {
  markAgentTaskFailedFromExternal,
  reconcileAgentTask,
  type ReconcileDeps,
} from './reconcile.js';
import type { AgentTaskHandler } from './watch.js';
import { createAgentTaskInformer } from './watch.js';

/**
 * Build the BuildJobSpecOptions the reconcile loop hands to job-spec
 * for every Pod it materializes. Reads operator env vars; everything
 * is optional. Helm values plumb through here.
 */
function buildJobSpecOptionsFromEnv(): BuildJobSpecOptions {
  const env = process.env;
  const extraEnv: { name: string; value: string }[] = [];
  if (
    typeof env.KAGENT_AGENT_POD_LITELLM_BASE_URL === 'string' &&
    env.KAGENT_AGENT_POD_LITELLM_BASE_URL.length > 0
  ) {
    extraEnv.push({
      name: 'KAGENT_LITELLM_BASE_URL',
      value: env.KAGENT_AGENT_POD_LITELLM_BASE_URL,
    });
  }
  if (
    typeof env.KAGENT_AGENT_POD_LITELLM_API_KEY === 'string' &&
    env.KAGENT_AGENT_POD_LITELLM_API_KEY.length > 0
  ) {
    extraEnv.push({
      name: 'KAGENT_LITELLM_API_KEY',
      value: env.KAGENT_AGENT_POD_LITELLM_API_KEY,
    });
  }
  if (
    typeof env.KAGENT_AGENT_POD_OTLP_ENDPOINT === 'string' &&
    env.KAGENT_AGENT_POD_OTLP_ENDPOINT.length > 0
  ) {
    extraEnv.push({
      name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      value: env.KAGENT_AGENT_POD_OTLP_ENDPOINT,
    });
  }
  if (
    typeof env.KAGENT_AGENT_POD_OTLP_HEADERS === 'string' &&
    env.KAGENT_AGENT_POD_OTLP_HEADERS.length > 0
  ) {
    extraEnv.push({
      name: 'OTEL_EXPORTER_OTLP_HEADERS',
      value: env.KAGENT_AGENT_POD_OTLP_HEADERS,
    });
  }
  const pullPolicy = env.KAGENT_AGENT_POD_IMAGE_PULL_POLICY;
  return {
    ...(typeof env.KAGENT_AGENT_POD_IMAGE === 'string' &&
      env.KAGENT_AGENT_POD_IMAGE.length > 0 && {
        image: env.KAGENT_AGENT_POD_IMAGE,
      }),
    ...((pullPolicy === 'Always' || pullPolicy === 'IfNotPresent' || pullPolicy === 'Never') && {
      imagePullPolicy: pullPolicy,
    }),
    ...(typeof env.KAGENT_AGENT_POD_IMAGE_PULL_SECRET === 'string' &&
      env.KAGENT_AGENT_POD_IMAGE_PULL_SECRET.length > 0 && {
        imagePullSecret: env.KAGENT_AGENT_POD_IMAGE_PULL_SECRET,
      }),
    ...(typeof env.KAGENT_AGENT_POD_SERVICE_ACCOUNT === 'string' &&
      env.KAGENT_AGENT_POD_SERVICE_ACCOUNT.length > 0 && {
        serviceAccountName: env.KAGENT_AGENT_POD_SERVICE_ACCOUNT,
      }),
    ...(extraEnv.length > 0 && { extraEnv }),
  };
}

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

  // Phase 3: KAGENT_NATS_URL toggles real NATS dispatcher; otherwise
  // we fall back to StubDispatcher (in-memory, useful for local
  // out-of-cluster operator testing without a NATS server).
  const natsUrl = process.env.KAGENT_NATS_URL;
  let dispatcher: Dispatcher;
  let capabilityRegistry: CapabilityRegistry;
  let onShutdownExtra: (() => Promise<void>) | undefined;

  if (typeof natsUrl === 'string' && natsUrl.length > 0) {
    console.log(`[kagent-operator] connecting NATS dispatcher → ${natsUrl}`);
    let sharedConnection: NatsConnection | undefined;
    const getConnection = async (): Promise<NatsConnection> => {
      if (sharedConnection === undefined) {
        sharedConnection = await connect({ servers: natsUrl });
      }
      return sharedConnection;
    };
    dispatcher = new NatsDispatcher({ connect: getConnection });
    // CapabilityRegistry: Phase 3 ships the interface + stubs; the
    // NATS KV reader (NatsCapabilityRegistry) needs the agent-pod
    // heartbeat path (Phase 3 C4+). Until that lands, even the
    // NATS-enabled operator uses the stub registry — capability
    // resolution still fails gracefully with a clear error.
    capabilityRegistry = new StubCapabilityRegistry();
    onShutdownExtra = async (): Promise<void> => {
      if (sharedConnection !== undefined) {
        await sharedConnection.close();
      }
    };
  } else {
    console.log('[kagent-operator] no KAGENT_NATS_URL set — using StubDispatcher');
    dispatcher = new StubDispatcher();
    capabilityRegistry = new StubCapabilityRegistry();
  }

  const jobSpecOptions = buildJobSpecOptionsFromEnv();
  const deps: ReconcileDeps = {
    customApi,
    batchApi,
    dispatcher,
    capabilityRegistry,
    ...(Object.keys(jobSpecOptions).length > 0 && { jobSpecOptions }),
  };
  const handler = buildHandler(deps);
  const informer = createAgentTaskInformer(kc, customApi, handler);

  // Phase 4.x — Job/Pod failure watcher. The agent-pod owns success-
  // path status writeback; this watcher closes the loop on failures
  // the pod can't report (image pull, OOMKill, unschedulable, etc).
  const coreApi = kc.makeApiClient(CoreV1Api);
  const jobListFn = async (): Promise<V1JobList> => {
    return await batchApi.listJobForAllNamespaces({
      labelSelector: 'kagent.knuteson.io/managed-by=kagent-operator',
    });
  };
  const surfaceFailure = async (
    ref: { namespace: string; name: string },
    failure: { reason: string; message: string; source: 'job' | 'pod' },
  ): Promise<void> => {
    try {
      const action = await markAgentTaskFailedFromExternal(ref, failure, { customApi });
      if (action.kind === 'marked-failed') {
        console.log(
          `[kagent-operator] marked Failed ${ref.namespace}/${ref.name} ` +
            `(was ${action.previousPhase}) due to ${failure.source}/${failure.reason}: ${failure.message}`,
        );
      }
    } catch (err) {
      console.error(`[kagent-operator] failed to mark ${ref.namespace}/${ref.name} Failed:`, err);
    }
  };
  const jobPodInformer = createJobPodInformer(kc, coreApi, jobListFn, {
    async onJob(job: V1Job): Promise<void> {
      const ref = parentTaskRef(job);
      if (ref === null) return;
      const verdict = detectJobFailure(job);
      if (verdict !== null) await surfaceFailure(ref, verdict);
    },
    async onPod(pod: V1Pod): Promise<void> {
      const ref = parentTaskRef(pod);
      if (ref === null) return;
      const verdict = detectPodFailure(pod);
      if (verdict !== null) await surfaceFailure(ref, verdict);
    },
    onError(err) {
      console.error('[kagent-operator] job/pod watch error:', err);
    },
  });

  // Graceful shutdown — stop the informer cleanly on SIGTERM/SIGINT
  // so K8s can drain the operator pod without orphaning the watch.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[kagent-operator] ${signal} — stopping informers`);
    try {
      await informer.stop();
    } catch (err) {
      console.error('[kagent-operator] informer.stop() failed:', err);
    }
    try {
      await jobPodInformer.stop();
    } catch (err) {
      console.error('[kagent-operator] job/pod informer stop failed:', err);
    }
    if (onShutdownExtra !== undefined) {
      try {
        await onShutdownExtra();
      } catch (err) {
        console.error('[kagent-operator] NATS shutdown failed:', err);
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('[kagent-operator] starting informers on AgentTask + Job + Pod');
  await informer.start();
  await jobPodInformer.start();
  console.log('[kagent-operator] informers started');
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
