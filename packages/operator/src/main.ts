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

import {
  CoreV1Api,
  type CoreV1Event,
  type Informer,
  type KubernetesListObject,
  type ObjectCache,
  type V1Job,
  type V1JobList,
  type V1Pod,
  type V1PodSecurityContext,
  type V1SecurityContext,
  makeInformer,
} from '@kubernetes/client-node';
import { connect, headers as natsHeaders, type NatsConnection } from 'nats';

import {
  buildAdmissionReconciler,
  unsuspendJobApi,
  type AdmissionReconciler,
} from './admission.js';
import { StubCapabilityRegistry, type CapabilityRegistry } from './capability-registry.js';
import {
  API_GROUP,
  API_VERSION,
  isAgent,
  isModelEndpoint,
  type Agent,
  type AgentTask,
  type ModelEndpoint,
} from './crds/index.js';
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
import { PARENT_TASK_UID_LABEL, parentTaskRefFromChild } from './task-graph.js';
import { startTemplateServer } from './template-server.js';
import { buildTriggersBootstrap, type TriggersBootstrapHandle } from './triggers-bootstrap.js';
import type { AgentTaskHandler, AgentTaskInformerWithCache } from './watch.js';
import { createAgentTaskInformer } from './watch.js';

/**
 * Build the BuildJobSpecOptions the reconcile loop hands to job-spec
 * for every Pod it materializes. Reads operator env vars; everything
 * is optional. Helm values plumb through here.
 */
export function buildJobSpecOptionsFromEnv(): BuildJobSpecOptions {
  const env = process.env;
  const extraEnv: { name: string; value: string }[] = [];
  // LLM endpoint resolution. When the operator was started with
  // KAGENT_LLM_GATEWAY_BASE_URL (chart's llmGateway.enabled=true), we
  // route spawned agent-pods through the gateway by overriding their
  // KAGENT_LITELLM_BASE_URL with the gateway service URL. The gateway
  // then enforces its AIMD-tuned per-(model, backend) cap as last-
  // resort safety; the operator's admission reconciler (admission.ts)
  // is the primary queue.
  const gatewayUrl = env.KAGENT_LLM_GATEWAY_BASE_URL;
  const gatewayApiKey = env.KAGENT_LLM_GATEWAY_API_KEY;
  const gatewayActive = typeof gatewayUrl === 'string' && gatewayUrl.length > 0;
  const effectiveLlmUrl = gatewayActive ? gatewayUrl : env.KAGENT_AGENT_POD_LITELLM_BASE_URL;
  const effectiveLlmKey = gatewayActive ? gatewayApiKey : env.KAGENT_AGENT_POD_LITELLM_API_KEY;
  if (typeof effectiveLlmUrl === 'string' && effectiveLlmUrl.length > 0) {
    extraEnv.push({
      name: 'KAGENT_LITELLM_BASE_URL',
      value: effectiveLlmUrl,
    });
  }
  if (typeof effectiveLlmKey === 'string' && effectiveLlmKey.length > 0) {
    extraEnv.push({
      name: 'KAGENT_LITELLM_API_KEY',
      value: effectiveLlmKey,
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
  // Trace content-capture mode — controls whether OtelTraceSink ships
  // input messages / output content / tool args+results as Langfuse
  // observation bodies. `none|preview|full`; default `preview`. Operator
  // env is `KAGENT_AGENT_POD_TRACE_CONTENT_MODE` (Helm-set); forwarded
  // into the agent-pod as `KAGENT_TRACE_CONTENT_MODE`. `artifact-ref`
  // is reserved (depends on the Phase 5 P3 artifact writer); the
  // agent-pod's env parser rejects it explicitly.
  if (
    typeof env.KAGENT_AGENT_POD_TRACE_CONTENT_MODE === 'string' &&
    env.KAGENT_AGENT_POD_TRACE_CONTENT_MODE.length > 0
  ) {
    extraEnv.push({
      name: 'KAGENT_TRACE_CONTENT_MODE',
      value: env.KAGENT_AGENT_POD_TRACE_CONTENT_MODE,
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
  // WS-K — substrate kill switch for the spawn_child_task tool. Helm's
  // `agentPod.spawnChild.enabled` flips KAGENT_AGENT_POD_SPAWN_CHILD_ENABLED
  // on the operator deployment; the operator forwards it into spawned
  // Jobs as KAGENT_SPAWN_CHILD_ENABLED. The agent-pod treats only the
  // exact literal "true" as on (default off so an install where the
  // value isn't deliberately set stays free of the substrate write tool).
  if (env.KAGENT_AGENT_POD_SPAWN_CHILD_ENABLED === 'true') {
    extraEnv.push({
      name: 'KAGENT_SPAWN_CHILD_ENABLED',
      value: 'true',
    });
  }
  // v0.1.6 — Langfuse-managed prompt fetcher plumbing. Forwarded into
  // spawned agent-pods only when the operator chart's
  // `langfuse.enabled=true` set the corresponding KAGENT_AGENT_POD_*
  // env on the operator deployment. Renamed on the way through (same
  // pattern as KAGENT_AGENT_POD_LITELLM_BASE_URL → KAGENT_LITELLM_BASE_URL).
  if (
    typeof env.KAGENT_AGENT_POD_LANGFUSE_HOST === 'string' &&
    env.KAGENT_AGENT_POD_LANGFUSE_HOST.length > 0
  ) {
    extraEnv.push({
      name: 'KAGENT_LANGFUSE_HOST',
      value: env.KAGENT_AGENT_POD_LANGFUSE_HOST,
    });
    if (
      typeof env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY === 'string' &&
      env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY.length > 0
    ) {
      extraEnv.push({
        name: 'KAGENT_LANGFUSE_PUBLIC_KEY',
        value: env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY,
      });
    }
    if (
      typeof env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY === 'string' &&
      env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY.length > 0
    ) {
      extraEnv.push({
        name: 'KAGENT_LANGFUSE_SECRET_KEY',
        value: env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY,
      });
    }
  }
  // WS-M — substrate kill switch + URL plumbing for the in-pod
  // ensure_agent_from_template tool. Forwarded only when the
  // template-server is enabled on the operator side; the chart binds
  // both flags to the same `agentPod.templates.enabled` values key so
  // they can't drift.
  if (env.KAGENT_TEMPLATES_ENABLED === 'true') {
    extraEnv.push({
      name: 'KAGENT_TEMPLATES_ENABLED',
      value: 'true',
    });
    if (
      typeof env.KAGENT_AGENT_POD_TEMPLATE_SERVER_URL === 'string' &&
      env.KAGENT_AGENT_POD_TEMPLATE_SERVER_URL.length > 0
    ) {
      extraEnv.push({
        name: 'KAGENT_TEMPLATE_SERVER_URL',
        value: env.KAGENT_AGENT_POD_TEMPLATE_SERVER_URL,
      });
    }
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

  // WS-A — security contexts for spawned agent pods. Helm's
  // `agentPodSecurityContext.pod` / `.container` are JSON-encoded
  // into env vars; we parse them here and forward into
  // BuildJobSpecOptions. Parse failure logs and falls back to
  // job-spec.ts defaults.
  const podSecurityContext = parseSecurityContextEnv<V1PodSecurityContext>(
    'KAGENT_AGENT_POD_SECURITY_CONTEXT',
    env.KAGENT_AGENT_POD_SECURITY_CONTEXT,
  );
  const containerSecurityContext = parseSecurityContextEnv<V1SecurityContext>(
    'KAGENT_AGENT_POD_CONTAINER_SECURITY_CONTEXT',
    env.KAGENT_AGENT_POD_CONTAINER_SECURITY_CONTEXT,
  );

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
    ...(podSecurityContext !== undefined && { podSecurityContext }),
    ...(containerSecurityContext !== undefined && { containerSecurityContext }),
    ...(runtimeClassesMap !== undefined && { runtimeClasses: runtimeClassesMap }),
    ...(extraEnv.length > 0 && { extraEnv }),
  };
}

/**
 * Parse a JSON-encoded security-context env var. Returns the parsed
 * object on success; logs + returns undefined on parse failure (so the
 * caller falls back to job-spec.ts defaults instead of erroring at
 * operator boot).
 */
function parseSecurityContextEnv<T>(varName: string, raw: string | undefined): T | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(
        `[kagent-operator] ${varName} is not a JSON object — falling back to job-spec defaults`,
      );
      return undefined;
    }
    return parsed as T;
  } catch (err) {
    console.warn(
      `[kagent-operator] failed to parse ${varName} as JSON (falling back to job-spec defaults):`,
      err,
    );
    return undefined;
  }
}

/**
 * Wiring container for the LLM-gateway admission reconciler. Built
 * lazily by `main()` only when KAGENT_ADMISSION_CONTROL_ENABLED=true
 * — when disabled, none of these informers are started and the only
 * surface area we add is one new ReconcileDeps field
 * (`admissionControlEnabled: false`).
 *
 * Keeps three informers (Job + ModelEndpoint + Agent) plus the
 * reconciler stitched together so `main()` can `start()` / `stop()`
 * them as a unit.
 */
interface AdmissionWiring {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed for tests + diagnostic logging — not invoked by main(). */
  reconciler: AdmissionReconciler;
}

interface BuildAdmissionWiringInput {
  readonly kc: import('@kubernetes/client-node').KubeConfig;
  readonly batchApi: import('@kubernetes/client-node').BatchV1Api;
  readonly customApi: import('@kubernetes/client-node').CustomObjectsApi;
  readonly watchNamespace: string | undefined;
}

/**
 * Build the admission reconciler + its supporting informers. Caller
 * (`main()`) gates on KAGENT_ADMISSION_CONTROL_ENABLED so this
 * function never runs in the disabled path. All three informers
 * share the same namespace scoping as the existing AgentTask /
 * Job-Pod informers — when the operator runs cluster-wide
 * (`KAGENT_WATCH_NAMESPACE` unset) so does admission control.
 *
 * Why split into a helper rather than inline in main():
 *   - Keeps main() readable; the wiring touches three informers +
 *     three event subscriptions + the reconciler factory call.
 *   - Lets tests construct the same wiring against a fake KubeConfig
 *     without booting the entire operator (future smoke test).
 */
function buildAdmissionWiring(input: BuildAdmissionWiringInput): AdmissionWiring {
  const { kc, batchApi, customApi, watchNamespace } = input;
  const managedBySelector = 'kagent.knuteson.io/managed-by=kagent-operator';

  // ---- Job informer (admission-cache flavor) -------------------------
  // Watches only Jobs we manage (label-selected). The cache exposes
  // .list(namespace?) which the reconciler reads on every tick.
  const jobListFn = async (): Promise<KubernetesListObject<V1Job>> => {
    const res =
      watchNamespace !== undefined
        ? await batchApi.listNamespacedJob({
            namespace: watchNamespace,
            labelSelector: managedBySelector,
          })
        : await batchApi.listJobForAllNamespaces({ labelSelector: managedBySelector });
    return res;
  };
  const jobLabelQuery = `labelSelector=${encodeURIComponent(managedBySelector)}`;
  const jobWatchPath =
    watchNamespace !== undefined
      ? `/apis/batch/v1/namespaces/${encodeURIComponent(watchNamespace)}/jobs?${jobLabelQuery}`
      : `/apis/batch/v1/jobs?${jobLabelQuery}`;
  const jobInformer: Informer<V1Job> & ObjectCache<V1Job> = makeInformer<V1Job>(
    kc,
    jobWatchPath,
    jobListFn,
  );

  // ---- ModelEndpoint informer ---------------------------------------
  const meListFn = async (): Promise<KubernetesListObject<ModelEndpoint>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res =
      watchNamespace !== undefined
        ? await customApi.listNamespacedCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            namespace: watchNamespace,
            plural: 'modelendpoints',
          })
        : await customApi.listClusterCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            plural: 'modelendpoints',
          });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    return res as KubernetesListObject<ModelEndpoint>;
  };
  const meWatchPath =
    watchNamespace !== undefined
      ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${encodeURIComponent(watchNamespace)}/modelendpoints`
      : `/apis/${API_GROUP}/${API_VERSION}/modelendpoints`;
  const meInformer: Informer<ModelEndpoint> & ObjectCache<ModelEndpoint> =
    makeInformer<ModelEndpoint>(kc, meWatchPath, meListFn);

  // ---- Agent informer (per-Agent maxInFlightTasks lookup) -----------
  const agentListFn = async (): Promise<KubernetesListObject<Agent>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res =
      watchNamespace !== undefined
        ? await customApi.listNamespacedCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            namespace: watchNamespace,
            plural: 'agents',
          })
        : await customApi.listClusterCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            plural: 'agents',
          });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    return res as KubernetesListObject<Agent>;
  };
  const agentWatchPath =
    watchNamespace !== undefined
      ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${encodeURIComponent(watchNamespace)}/agents`
      : `/apis/${API_GROUP}/${API_VERSION}/agents`;
  const agentInformer: Informer<Agent> & ObjectCache<Agent> = makeInformer<Agent>(
    kc,
    agentWatchPath,
    agentListFn,
  );

  // ---- Build the reconciler against the informer caches -------------
  const reconciler = buildAdmissionReconciler({
    enabled: true,
    listJobs: (namespace) => {
      // Informer cache is namespace-keyed; passing undefined returns
      // the full cluster view. Reconciler does its own namespace
      // partitioning by reading job.metadata.namespace.
      return jobInformer.list(namespace);
    },
    listModelEndpoints: (namespace) => {
      const items = meInformer.list(namespace);
      // Defensive type-narrow — the apiserver validates schema, but
      // the cache returns whatever it received.
      return items.filter(isModelEndpoint);
    },
    lookupAgent: (namespace, name) => {
      const agent = agentInformer.get(name, namespace);
      return agent !== undefined && isAgent(agent) ? agent : undefined;
    },
    unsuspendJob: (namespace, name) => unsuspendJobApi(batchApi, namespace, name),
  });

  // ---- Subscribe events → re-evaluate ------------------------------
  // Per spec §3.2 + the WS-I "watch-cache discipline" pattern: the
  // reconciler is event-driven, NOT polled. Any add/update/delete on
  // a managed Job (suspend flip, completion, deletion) AND any
  // ModelEndpoint event (status.observedInFlight bump from the
  // gateway, spec change from GitOps) re-runs the admission pass.
  // Re-firing on every event is cheap when nothing has changed; the
  // reconciler issues zero patches when no Job is admittable.
  const fireOnJobEvent = (): void => {
    void reconciler.onJobEvent().catch((err: unknown) => {
      console.error('[kagent-operator] admission onJobEvent failed:', err);
    });
  };
  const fireOnMeEvent = (): void => {
    void reconciler.onModelEndpointEvent().catch((err: unknown) => {
      console.error('[kagent-operator] admission onModelEndpointEvent failed:', err);
    });
  };

  jobInformer.on('add', fireOnJobEvent);
  jobInformer.on('update', fireOnJobEvent);
  jobInformer.on('delete', fireOnJobEvent);
  jobInformer.on('error', (err) => {
    console.error('[kagent-operator] admission Job watch error:', err);
    setTimeout(() => {
      void jobInformer.start();
    }, 5000);
  });

  meInformer.on('add', fireOnMeEvent);
  meInformer.on('update', fireOnMeEvent);
  meInformer.on('delete', fireOnMeEvent);
  meInformer.on('error', (err) => {
    console.error('[kagent-operator] admission ModelEndpoint watch error:', err);
    setTimeout(() => {
      void meInformer.start();
    }, 5000);
  });

  // Agent informer is read-on-demand (lookupAgent); we don't need to
  // re-evaluate on Agent events — the next Job or ModelEndpoint event
  // will pick up the new cap. We DO still need the watch open so the
  // cache stays warm.
  agentInformer.on('error', (err) => {
    console.error('[kagent-operator] admission Agent watch error:', err);
    setTimeout(() => {
      void agentInformer.start();
    }, 5000);
  });

  return {
    async start(): Promise<void> {
      await jobInformer.start();
      await meInformer.start();
      await agentInformer.start();
    },
    async stop(): Promise<void> {
      try {
        await jobInformer.stop();
      } catch (err) {
        console.error('[kagent-operator] admission Job informer stop failed:', err);
      }
      try {
        await meInformer.stop();
      } catch (err) {
        console.error('[kagent-operator] admission ModelEndpoint informer stop failed:', err);
      }
      try {
        await agentInformer.stop();
      } catch (err) {
        console.error('[kagent-operator] admission Agent informer stop failed:', err);
      }
    },
    reconciler,
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
 *   2. WHEN the event resource carries parent-task metadata written by
 *      `buildChildTaskManifest` (label/annotation/ownerRef), ALSO run
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
      {
        customApi: deps.customApi,
        // WS-I: forward informer-cache + cycle-event hooks when the
        // operator boot wired them. Tests typically leave them unset
        // (which intentionally makes the function fall back to a fresh
        // API list and skip cycle detection — see ReconcileDeps docs).
        ...(deps.listChildrenForParent !== undefined && {
          listChildren: deps.listChildrenForParent,
        }),
        ...(deps.getTaskByUid !== undefined && { getTaskByUid: deps.getTaskByUid }),
        ...(deps.emitCycleEvent !== undefined && { emitCycleEvent: deps.emitCycleEvent }),
      },
    );
    const childId = `${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'}`;
    const parentId = `${parentRef.namespace}/${parentRef.name}`;
    if (action.kind === 'updated') {
      console.log(
        `[kagent-operator] ${verb} ${childId} → re-aggregated parent ${parentId} ` +
          `(aggregatePhase=${action.aggregatePhase}, children=${action.childCount})`,
      );
    } else if (action.kind === 'unchanged') {
      // Idempotency hit — no etcd write. Logged at debug level only;
      // re-firing on every relist of every child would otherwise spam
      // `kubectl logs` for no operational signal.
      console.debug(
        `[kagent-operator] ${verb} ${childId} → parent ${parentId} projection unchanged ` +
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
  const watchNamespace = normalizeOptionalEnv(process.env.KAGENT_WATCH_NAMESPACE);

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
    dispatcher = new NatsDispatcher({
      connect: getConnection,
      // WS-F: wire JetStream's `Nats-Msg-Id` dedupe header. The
      // reconcile loop passes `task.metadata.uid` as `dedupeId` on
      // every publish; JetStream's per-stream `duplicate_window`
      // (default 2m) drops the second one when the operator
      // re-reconciles after a mid-flight crash.
      headersFactory: () => natsHeaders(),
    });
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

  // Phase 4.x — Job/Pod failure watcher. The agent-pod owns success-
  // path status writeback; this watcher closes the loop on failures
  // the pod can't report (image pull, OOMKill, unschedulable, etc).
  // Built early so it's also available to the WS-I cycle-event emitter
  // wired into ReconcileDeps below.
  const coreApi = kc.makeApiClient(CoreV1Api);

  // WS-I — informer-cache plumbing for parent re-aggregate. The
  // informer doesn't exist yet (we need the handler first, which needs
  // deps, which closes over these callbacks). A mutable ref-object
  // breaks the cycle: the closures read `informerRef.current`, which
  // we populate just below the `createAgentTaskInformer` call. Until
  // then the callbacks return empty/undefined, matching the desired
  // "informer hasn't synced yet" semantics
  // (`reconcileParentFromChildEvent` falls back gracefully).
  const informerRef: { current: AgentTaskInformerWithCache | undefined } = {
    current: undefined,
  };

  const listChildrenForParent = (parentUid: string, namespace: string): readonly AgentTask[] => {
    const informer = informerRef.current;
    if (informer === undefined) return [];
    return informer
      .list(namespace)
      .filter((t) => t.metadata.labels?.[PARENT_TASK_UID_LABEL] === parentUid);
  };
  const getTaskByUid = (uid: string): AgentTask | undefined => {
    const informer = informerRef.current;
    if (informer === undefined) return undefined;
    // Cache is per-namespace; pass undefined to walk the full cluster
    // view (the operator's informer is either namespaced or
    // cluster-wide based on `watchNamespace`, so list(undefined)
    // returns whatever the informer is configured to see).
    for (const t of informer.list()) {
      if (t.metadata.uid === uid) return t;
    }
    return undefined;
  };
  const emitCycleEvent = async (
    parent: { readonly name: string; readonly namespace: string; readonly uid: string },
    cycle: readonly string[],
  ): Promise<void> => {
    // K8s v1 Event — surfaces via `kubectl describe agenttask <name>`
    // and Workbench TaskDetail. Reason `AgentTaskCycleDetected` is
    // matched by ops dashboards / alerting.
    const ts = new Date();
    const event: CoreV1Event = {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: {
        // Generate a unique name per cycle detection — the apiserver
        // dedupes events with the same involvedObject + reason +
        // message via `count`, but a unique metadata.name keeps the
        // create call safe to retry.
        generateName: `${parent.name}-cycle-`,
        namespace: parent.namespace,
      },
      involvedObject: {
        apiVersion: 'kagent.knuteson.io/v1alpha1',
        kind: 'AgentTask',
        name: parent.name,
        namespace: parent.namespace,
        uid: parent.uid,
      },
      reason: 'AgentTaskCycleDetected',
      message: `Refused to project parent.status.children: cycle detected in parent chain (${cycle.join(' → ')})`,
      type: 'Warning',
      source: { component: 'kagent-operator' },
      // V1MicroTime extends Date and adds nothing structurally, so a
      // plain Date is assignable to both the eventTime (V1MicroTime)
      // and *Timestamp (Date) fields. The K8s API server serializes
      // them to ISO-8601 either way.
      eventTime: ts,
      reportingComponent: 'kagent-operator',
      reportingInstance: process.env.HOSTNAME ?? 'kagent-operator',
      action: 'SkipProjection',
      firstTimestamp: ts,
      lastTimestamp: ts,
      count: 1,
    };
    await coreApi.createNamespacedEvent({ namespace: parent.namespace, body: event });
  };

  // LLM-gateway bundle (spec §3.2). When admission control is on, the
  // dispatch path stops short of un-suspending the Job — the admission
  // reconciler (built below) takes over the un-suspend decision based
  // on per-(model, namespace) + per-Agent capacity. Default OFF for
  // backwards compatibility with installs that don't deploy the LLM
  // gateway sub-chart. The chart's `llmGateway.enabled=true` flips
  // KAGENT_ADMISSION_CONTROL_ENABLED on this deployment.
  const admissionControlEnabled = process.env.KAGENT_ADMISSION_CONTROL_ENABLED === 'true';

  const deps: ReconcileDeps = {
    customApi,
    batchApi,
    dispatcher,
    capabilityRegistry,
    listChildrenForParent,
    getTaskByUid,
    emitCycleEvent,
    admissionControlEnabled,
    ...(Object.keys(jobSpecOptions).length > 0 && { jobSpecOptions }),
  };
  const handler = buildHandler(deps);
  // Single informer-opts object reused for both the AgentTask and the
  // Job/Pod informers — keeps the namespace toggle in lockstep so a
  // misconfiguration can't scope one watch but not the other.
  const informerOpts: { namespace?: string } =
    watchNamespace !== undefined ? { namespace: watchNamespace } : {};
  // Forward-reference assignment: the closures above capture
  // `informerRef` so the cache lookups work as soon as the informer
  // is constructed.
  const informer = createAgentTaskInformer(kc, customApi, handler, informerOpts);
  informerRef.current = informer;
  const jobListFn = async (): Promise<V1JobList> => {
    return watchNamespace !== undefined
      ? await batchApi.listNamespacedJob({
          namespace: watchNamespace,
          labelSelector: 'kagent.knuteson.io/managed-by=kagent-operator',
        })
      : await batchApi.listJobForAllNamespaces({
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
  const jobPodInformer = createJobPodInformer(
    kc,
    coreApi,
    jobListFn,
    {
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
    },
    informerOpts,
  );

  // LLM-gateway bundle (spec §3.2). When admission control is enabled
  // we boot three additional informers (Job + ModelEndpoint + Agent),
  // construct the admission reconciler, and wire event subscriptions.
  // When disabled, none of the below runs — preserving today's
  // dispatch path with zero new K8s watches.
  //
  // Why a separate Job informer (vs. reusing `jobPodInformer`):
  //   - The existing one is private inside `createJobPodInformer`; it
  //     doesn't expose the cache.list() we need for capacity counting.
  //   - The two have different responsibilities — failure detection
  //     vs. admission scheduling — and decoupling lets either be
  //     restarted independently.
  //   - Both use the same `managed-by` label selector so the watch
  //     stream is identical. K8s watch is push, not pull, so an
  //     "extra" informer is one extra HTTP/2 stream + memory-cached
  //     copy of the same Jobs list — cheap.
  const admissionWiring = admissionControlEnabled
    ? buildAdmissionWiring({
        kc,
        batchApi,
        customApi,
        watchNamespace,
      })
    : undefined;

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
    if (admissionWiring !== undefined) {
      try {
        await admissionWiring.stop();
      } catch (err) {
        console.error('[kagent-operator] admission informer stop failed:', err);
      }
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

  const scope = watchNamespace ?? 'all namespaces';
  console.log(`[kagent-operator] starting informers on AgentTask + Job + Pod (${scope})`);
  await informer.start();
  await jobPodInformer.start();
  if (admissionWiring !== undefined) {
    await admissionWiring.start();
    console.log(
      `[kagent-operator] admission control ENABLED — Job + ModelEndpoint + Agent informers started`,
    );
  } else {
    console.log(
      '[kagent-operator] admission control disabled (set KAGENT_ADMISSION_CONTROL_ENABLED=true to enable)',
    );
  }
  console.log('[kagent-operator] informers started');

  // Wave 0 / sub-team Entry — KagentSchedule controller + HMAC webhook
  // receiver (see docs/WAVES.md §2.6). Default-OFF: when
  // KAGENT_TRIGGERS_ENABLED is anything other than `true` the schedule
  // informer + webhook port stay unbound, preserving today's surface.
  // The chart's `triggers.enabled=true` value flips both the env on
  // this deployment AND the Service/Ingress that fronts the webhook.
  //
  // Per-trigger HMAC secrets live in a single Secret named by env
  // (`KAGENT_TRIGGER_SECRETS_NAME`, default `kagent-trigger-secrets`)
  // in the operator's release namespace. The receiver's resolver reads
  // process.env keys prefixed `KAGENT_TRIGGER_SECRET_<id>` so the
  // chart's Deployment template can mount the Secret as envFrom or
  // explicit env (single source of truth for the trust boundary).
  if (process.env.KAGENT_TRIGGERS_ENABLED === 'true') {
    const triggers: TriggersBootstrapHandle = buildTriggersBootstrap({
      kc,
      customApi,
      ...(watchNamespace !== undefined && { watchNamespace }),
      resolveTriggerSecret: (id) => process.env[`KAGENT_TRIGGER_SECRET_${id.toUpperCase()}`],
    });
    await triggers.start();
    console.log('[kagent-operator] triggers (KagentSchedule + webhook) wired');
    const previousTriggersHook = onShutdownExtra;
    onShutdownExtra = async (): Promise<void> => {
      try {
        await triggers.stop();
      } catch (err) {
        console.error('[kagent-operator] triggers stop failed:', err);
      }
      if (previousTriggersHook !== undefined) await previousTriggersHook();
    };
  } else {
    console.log('[kagent-operator] triggers disabled (set KAGENT_TRIGGERS_ENABLED=true to enable)');
  }

  // WS-M — boot the template-server when enabled. Default-OFF; the
  // chart's `agentPod.templates.enabled=true` flips
  // KAGENT_TEMPLATES_ENABLED on this deployment AND
  // KAGENT_TEMPLATE_SERVER_URL on every spawned agent-pod Job. The
  // namespace-resolver short-circuits to the operator's release
  // namespace; v0.1 is single-namespace per AGENT-TEMPLATES.md §8.4.
  if (process.env.KAGENT_TEMPLATES_ENABLED === 'true') {
    const port = Number.parseInt(process.env.KAGENT_TEMPLATE_SERVER_PORT ?? '8081', 10);
    const releaseNamespace = watchNamespace ?? process.env.KAGENT_RELEASE_NAMESPACE ?? 'default';
    const tplServer = startTemplateServer(port, {
      customApi,
      resolveNamespace: () => releaseNamespace,
    });
    console.log(
      `[kagent-operator] template-server listening on :${String(port)} (namespace=${releaseNamespace})`,
    );
    const previous = onShutdownExtra;
    onShutdownExtra = async (): Promise<void> => {
      try {
        await tplServer.close();
      } catch (err) {
        console.error('[kagent-operator] template-server close failed:', err);
      }
      if (previous !== undefined) await previous();
    };
  }
}

function normalizeOptionalEnv(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
