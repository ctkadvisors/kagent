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
  reconcileParentFromChildEvent,
  type ReconcileDeps,
} from './reconcile.js';
import { parentTaskRefFromChild } from './task-graph.js';
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
  // Built-in tool HTTP allowlist — Helm's chart values
  // `agentPod.builtinTools.httpAllowDomains` are comma-joined into
  // KAGENT_AGENT_POD_HTTP_ALLOW_DOMAINS on the operator's own
  // deployment; we forward it verbatim into spawned Jobs as
  // KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS, which is what
  // packages/agent-pod/src/builtin-tools.ts reads (default-deny when
  // unset/empty). Renaming on the way through keeps the env-var
  // surface stable for the agent-pod and lets operator-side knobs
  // grow a `KAGENT_AGENT_POD_*` prefix consistently.
  if (
    typeof env.KAGENT_AGENT_POD_HTTP_ALLOW_DOMAINS === 'string' &&
    env.KAGENT_AGENT_POD_HTTP_ALLOW_DOMAINS.length > 0
  ) {
    extraEnv.push({
      name: 'KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS',
      value: env.KAGENT_AGENT_POD_HTTP_ALLOW_DOMAINS,
    });
  }
  const pullPolicy = env.KAGENT_AGENT_POD_IMAGE_PULL_POLICY;
  // Artifact PVC plumbing — Helm sets KAGENT_ARTIFACT_PVC_NAME +
  // (optionally) KAGENT_ARTIFACT_MOUNT_PATH on the operator deployment;
  // we forward both into BuildJobSpecOptions so spawned Jobs mount the
  // PVC and the agent-pod's `write_artifact` tool can write under
  // <mountPath>/<task-uid>/<name>. When unset, no PVC plumbing is
  // added and the tool fails fast at boot if invoked.
  const artifactPvcName = env.KAGENT_ARTIFACT_PVC_NAME;
  const artifactMountPath = env.KAGENT_ARTIFACT_MOUNT_PATH;

  // RuntimeClass mapping per Agent.spec.sandboxProfile (WS-C). Helm
  // values `agentPod.runtimeClasses.{default,strict}` plumb through as
  // these env vars on the operator deployment. Empty string means
  // "not set — omit runtimeClassName for that profile" (cluster default
  // applies). When NEITHER env var is set the map is omitted entirely;
  // `buildJobSpec` then falls back to the deprecated
  // `opts.runtimeClassName` (which `buildJobSpecOptionsFromEnv` itself
  // never sets, leaving that field as a TS-only escape hatch).
  const runtimeClassDefault = env.KAGENT_RUNTIME_CLASS_DEFAULT;
  const runtimeClassStrict = env.KAGENT_RUNTIME_CLASS_STRICT;
  const runtimeClassesMap =
    typeof runtimeClassDefault === 'string' || typeof runtimeClassStrict === 'string'
      ? {
          default: typeof runtimeClassDefault === 'string' ? runtimeClassDefault : '',
          strict: typeof runtimeClassStrict === 'string' ? runtimeClassStrict : '',
        }
      : undefined;
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
    ...(typeof artifactPvcName === 'string' &&
      artifactPvcName.length > 0 && {
        artifactPvc: {
          claimName: artifactPvcName,
          ...(typeof artifactMountPath === 'string' &&
            artifactMountPath.length > 0 && { mountPath: artifactMountPath }),
        },
      }),
    ...(runtimeClassesMap !== undefined && { runtimeClasses: runtimeClassesMap }),
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
 * Two-pass routing on add/update:
 *
 *   1. ALWAYS run `reconcileAgentTask(task)` — the existing dispatch
 *      path. Idempotent for terminal/Dispatched phases.
 *   2. WHEN the event resource carries the `parent-task-name` label
 *      (i.e. it's a child AgentTask), ALSO run
 *      `reconcileParentFromChildEvent(parentRef)` so the parent's
 *      `status.children` / `status.aggregatePhase` projection stays
 *      live. This is the Workstream 5 / Phase 5 wire-up — see
 *      `docs/TASK-GRAPH.md` §3 for the rationale (operator-driven
 *      parent re-reconcile, no in-pod NATS subscription in v0.1).
 *
 * The two paths are independent: failures in one are logged but never
 * propagate to the other. This keeps a misbehaving child-aggregation
 * path from blocking dispatch (and vice versa).
 *
 * Exported for tests and for any embedded harness that wants to drive
 * the operator without booting an informer.
 */
export function buildHandler(deps: ReconcileDeps): AgentTaskHandler {
  return {
    async onAdd(task) {
      const result = await reconcileAgentTask(task, deps);
      logResult('add', task, result);
      await maybeReconcileParent('add', task, deps);
    },
    async onUpdate(task) {
      const result = await reconcileAgentTask(task, deps);
      logResult('update', task, result);
      await maybeReconcileParent('update', task, deps);
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

/**
 * If the event resource carries the parent-task labels written by
 * `buildChildTaskManifest`, fire `reconcileParentFromChildEvent` for
 * the parent. Logs failures but never re-throws — the dispatch path
 * for THIS task already completed; we don't want a parent-aggregation
 * hiccup to surface as a watch error and trigger informer restart.
 */
async function maybeReconcileParent(
  verb: 'add' | 'update',
  task: import('./crds/index.js').AgentTask,
  deps: ReconcileDeps,
): Promise<void> {
  const parentRef = parentTaskRefFromChild(task);
  if (parentRef === null) return;
  try {
    const action = await reconcileParentFromChildEvent(
      { namespace: parentRef.namespace, name: parentRef.name },
      { customApi: deps.customApi },
    );
    const childId = `${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'}`;
    const parentId = `${parentRef.namespace}/${parentRef.name}`;
    if (action.kind === 'updated') {
      console.log(
        `[kagent-operator] ${verb} ${childId} → re-aggregated parent ${parentId} ` +
          `(aggregatePhase=${action.aggregatePhase}, children=${action.childCount})`,
      );
    } else {
      console.log(
        `[kagent-operator] ${verb} ${childId} → parent re-aggregate skipped (${action.reason})`,
      );
    }
  } catch (err) {
    console.error(
      `[kagent-operator] ${verb} ${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'} ` +
        `parent re-aggregate failed for ${parentRef.namespace}/${parentRef.name}:`,
      err,
    );
  }
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
