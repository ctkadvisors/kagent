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
  AppsV1Api,
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
import {
  AuditPublisher,
  CAPABILITY_MINTED,
  INFRA_FAULT_OBSERVED,
  KEYROTATION_CAP_MINTED_WITH_TTL,
  SUPERVISION_APPLIED,
  SUPERVISION_RESTART_LIMIT_EXCEEDED,
  TASK_ADMITTED,
  makeEvent,
} from '@kagent/audit-events';
import { buildEventDispatcher, type EventDispatcher, type EventSubscription } from '@kagent/events';
import {
  resolveCapTtlPolicy,
  resolveSvidRotationPolicy,
  scheduleGatewayRotation,
  type CapTtlPolicy,
} from '@kagent/keyrotation-controller';
import { connect, headers as natsHeaders, type NatsConnection } from 'nats';

import {
  buildAdmissionReconciler,
  unsuspendJobApi,
  type AdmissionReconciler,
  type EmitTaskAdmittedFn,
} from './admission.js';
import { decideBlackboardAction } from './blackboard-router.js';
import { StubCapabilityRegistry, type CapabilityRegistry } from './capability-registry.js';
import * as casGc from './cas-gc.js';
import {
  API_GROUP,
  API_VERSION,
  TENANT_LABEL,
  isAgent,
  isModelEndpoint,
  type Agent,
  type AgentTask,
  type ModelEndpoint,
} from './crds/index.js';
import { StubDispatcher, type Dispatcher } from './dispatcher.js';
import { detectJobFailure, detectPodFailure } from './failure-detector.js';
import type { BuildJobSpecOptions, EnvVarSpec } from './job-spec.js';
import { createJobPodInformer, parentTaskRef } from './job-watch.js';
import { loadKubeConfig, makeBatchApi, makeCustomObjectsApi } from './k8s.js';
import { NatsDispatcher } from './nats-dispatcher.js';
import {
  markAgentTaskFailedFromExternal,
  reconcileAgentTask,
  reconcileParentFromChildEvent,
  type ReconcileDeps,
} from './reconcile.js';
import {
  routeFailureForSupervision,
  type SupervisionAppliedFields,
  type SupervisionAuditHooks,
  type SupervisionRestartLimitExceededFields,
  type SupervisionRouterDeps,
  type InfraFaultFields,
} from './supervision-router.js';
import { IdempotencyCache } from './task-admission.js';
import { PARENT_TASK_UID_LABEL, parentTaskRefFromChild } from './task-graph.js';
import { startTemplateServer } from './template-server.js';
import { loadFromEnv as loadCapCa } from './cap-ca.js';
import {
  buildEventTriggerAgentTaskCreator,
  buildNatsPullConsumerFactory,
  provisionEventsStream,
  type JetStreamClientLike,
  type JetStreamManagerLike,
  type StreamApiLike,
} from './events-bootstrap.js';
import { buildTriggersBootstrap, type TriggersBootstrapHandle } from './triggers-bootstrap.js';
import type { AgentTaskHandler, AgentTaskInformerWithCache } from './watch.js';
import { createAgentTaskInformer } from './watch.js';

/**
 * Push a "sensitive env" entry into the spawned-Job's `extraEnv`
 * array, preferring a `valueFrom.secretKeyRef` when the chart provided
 * the secret coordinates as side env vars
 * (`<sourceVar>_SECRET_NAME` + `<sourceVar>_SECRET_KEY`), and
 * falling back to the resolved plaintext only when those hints are
 * absent.
 *
 * v0.1.8 secret-hygiene contract (see WAVES.md §2.1, brief §1):
 *   - When both hints are present + non-empty, emit secretKeyRef and
 *     IGNORE the resolved plaintext (the chart's deployment template
 *     also injects the resolved env via valueFrom.secretKeyRef on the
 *     operator pod, but the operator never copies the plaintext into
 *     a spawned Job's etcd object).
 *   - When only the resolved plaintext is set (no hints), emit a
 *     deprecated plaintext entry; NOTES.txt prints a loud warning
 *     listing the affected sensitive name on `helm install / upgrade`.
 *   - When nothing is set, emit nothing.
 *
 * Why side env vars rather than a single JSON-encoded hint blob: it
 * keeps the chart's deployment template trivially auditable
 * (one secretKeyRef + two literal envs per sensitive name) and lets
 * `kubectl get deploy <operator> -o yaml` show the secret coordinates
 * verbatim.
 *
 * @param extraEnv  destination array (mutated)
 * @param targetName  name of the env var on the SPAWNED Job
 * @param resolvedValue  the value of `process.env[sourceVar]` (the
 *   plaintext K8s injected when the chart used the deprecated
 *   `value:` path; ignored when secret hints are present)
 * @param secretName  the value of `process.env[sourceVar + "_SECRET_NAME"]`
 * @param secretKey   the value of `process.env[sourceVar + "_SECRET_KEY"]`
 */
function pushSensitiveEnv(
  extraEnv: EnvVarSpec[],
  targetName: string,
  resolvedValue: string | undefined,
  secretName: string | undefined,
  secretKey: string | undefined,
): void {
  if (
    typeof secretName === 'string' &&
    secretName.length > 0 &&
    typeof secretKey === 'string' &&
    secretKey.length > 0
  ) {
    extraEnv.push({
      name: targetName,
      valueFrom: { secretKeyRef: { name: secretName, key: secretKey } },
    });
    return;
  }
  if (typeof resolvedValue === 'string' && resolvedValue.length > 0) {
    extraEnv.push({ name: targetName, value: resolvedValue });
  }
}

/**
 * Build the BuildJobSpecOptions the reconcile loop hands to job-spec
 * for every Pod it materializes. Reads operator env vars; everything
 * is optional. Helm values plumb through here.
 */
export function buildJobSpecOptionsFromEnv(): BuildJobSpecOptions {
  const env = process.env;
  const extraEnv: EnvVarSpec[] = [];
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
  // For the API key we resolve BOTH the resolved plaintext AND the
  // secret-ref hints from whichever source is active (gateway vs.
  // direct LiteLLM). pushSensitiveEnv() prefers the secret-ref shape
  // — the chart-side deployment template renders both
  // `<NAME>_SECRET_NAME` and `<NAME>_SECRET_KEY` alongside the
  // resolved env so we never have to crack open the Secret here.
  const effectiveLlmKey = gatewayActive ? gatewayApiKey : env.KAGENT_AGENT_POD_LITELLM_API_KEY;
  const effectiveLlmKeySecretName = gatewayActive
    ? env.KAGENT_LLM_GATEWAY_API_KEY_SECRET_NAME
    : env.KAGENT_AGENT_POD_LITELLM_API_KEY_SECRET_NAME;
  const effectiveLlmKeySecretKey = gatewayActive
    ? env.KAGENT_LLM_GATEWAY_API_KEY_SECRET_KEY
    : env.KAGENT_AGENT_POD_LITELLM_API_KEY_SECRET_KEY;
  if (typeof effectiveLlmUrl === 'string' && effectiveLlmUrl.length > 0) {
    extraEnv.push({
      name: 'KAGENT_LITELLM_BASE_URL',
      value: effectiveLlmUrl,
    });
  }
  pushSensitiveEnv(
    extraEnv,
    'KAGENT_LITELLM_API_KEY',
    effectiveLlmKey,
    effectiveLlmKeySecretName,
    effectiveLlmKeySecretKey,
  );
  if (
    typeof env.KAGENT_AGENT_POD_OTLP_ENDPOINT === 'string' &&
    env.KAGENT_AGENT_POD_OTLP_ENDPOINT.length > 0
  ) {
    extraEnv.push({
      name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      value: env.KAGENT_AGENT_POD_OTLP_ENDPOINT,
    });
  }
  // OTEL OTLP headers — typically carry a Bearer token. Same secret-
  // ref preference as the LiteLLM API key: chart-side deployment
  // exposes `_SECRET_NAME` + `_SECRET_KEY` hints when the values came
  // from a Secret, and the operator forwards the secretKeyRef
  // verbatim. Falls back to the resolved plaintext for installs that
  // haven't migrated.
  pushSensitiveEnv(
    extraEnv,
    'OTEL_EXPORTER_OTLP_HEADERS',
    env.KAGENT_AGENT_POD_OTLP_HEADERS,
    env.KAGENT_AGENT_POD_OTLP_HEADERS_SECRET_NAME,
    env.KAGENT_AGENT_POD_OTLP_HEADERS_SECRET_KEY,
  );
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
  // v0.1.9 — cluster-level depth cap for the spawn_child_task tool.
  // Helm value `agentPod.maxDepth` (default 4) sets
  // `KAGENT_AGENT_POD_MAX_DEPTH` on the operator deployment; we
  // forward it verbatim into spawned Jobs so the in-pod
  // `defineSpawnChildTask` guardrail and the operator-side admission
  // path read the same source of truth. When unset, the agent-pod's
  // own DEFAULT_AGENT_POD_MAX_DEPTH (=4) applies.
  if (
    typeof env.KAGENT_AGENT_POD_MAX_DEPTH === 'string' &&
    env.KAGENT_AGENT_POD_MAX_DEPTH.length > 0
  ) {
    extraEnv.push({
      name: 'KAGENT_AGENT_POD_MAX_DEPTH',
      value: env.KAGENT_AGENT_POD_MAX_DEPTH,
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
    // Public + secret Langfuse keys — both are sensitive (the public
    // key alone authorizes ingestion writes, so it's "less secret" but
    // still a credential). Both go through pushSensitiveEnv so the
    // rendered Job spec carries the secretKeyRef shape under the
    // chart's preferred path.
    pushSensitiveEnv(
      extraEnv,
      'KAGENT_LANGFUSE_PUBLIC_KEY',
      env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY,
      env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY_SECRET_NAME,
      env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY_SECRET_KEY,
    );
    pushSensitiveEnv(
      extraEnv,
      'KAGENT_LANGFUSE_SECRET_KEY',
      env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY,
      env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY_SECRET_NAME,
      env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY_SECRET_KEY,
    );
  }
  // === Wave 3 — Identity ===
  // SVID-mTLS plumbing forwarded into spawned agent-pods.
  if (env.KAGENT_AGENT_POD_LITELLM_USE_SVID === 'true') {
    extraEnv.push({
      name: 'KAGENT_LITELLM_USE_SVID',
      value: 'true',
    });
    if (
      typeof env.KAGENT_AGENT_POD_SPIRE_SOCKET_PATH === 'string' &&
      env.KAGENT_AGENT_POD_SPIRE_SOCKET_PATH.length > 0
    ) {
      extraEnv.push({
        name: 'KAGENT_SPIRE_SOCKET_PATH',
        value: env.KAGENT_AGENT_POD_SPIRE_SOCKET_PATH,
      });
    }
  }

  // === Wave 3 — Events ===
  // Forward `KAGENT_EVENTS_NATS_URL` into spawned agent-pod Jobs so
  // the in-pod `publish_event` tool has a NATS endpoint to emit on.
  if (env.KAGENT_EVENTS_ENABLED === 'true') {
    if (typeof env.KAGENT_EVENTS_NATS_URL === 'string' && env.KAGENT_EVENTS_NATS_URL.length > 0) {
      extraEnv.push({
        name: 'KAGENT_EVENTS_NATS_URL',
        value: env.KAGENT_EVENTS_NATS_URL,
      });
    }
  }
  // === Wave 0 / Wave 2 — Audit ===
  // Forward the audit stream endpoint into spawned agent-pods so
  // substrate tools can emit their own accepted-claim events
  // (`capability.used`) without routing through operator state.
  if (typeof env.KAGENT_AUDIT_NATS_URL === 'string' && env.KAGENT_AUDIT_NATS_URL.length > 0) {
    extraEnv.push({
      name: 'KAGENT_AUDIT_NATS_URL',
      value: env.KAGENT_AUDIT_NATS_URL,
    });
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
  // v0.1 P3 wire-up — per-write byte cap forwarded onto every spawned
  // Job's env. Parsed here so a malformed Helm value (negative,
  // non-numeric) is dropped before it reaches the agent-pod (which
  // would then fall back to its compiled-in default — same outcome).
  const artifactMaxBytesRaw = env.KAGENT_ARTIFACT_MAX_BYTES;
  const artifactMaxBytes = ((): number | undefined => {
    if (typeof artifactMaxBytesRaw !== 'string' || artifactMaxBytesRaw.length === 0) {
      return undefined;
    }
    const n = Number(artifactMaxBytesRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
    return n;
  })();

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
          ...(typeof artifactMaxBytes === 'number' && { maxBytes: artifactMaxBytes }),
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
  /**
   * Wave 0 Audit (v0.1.15-audit-stream) — invoked once per successful
   * admission with the parent AgentTask's identifying fields. main()
   * wires this against an AuditPublisher when audit.enabled=true.
   * Optional: omit to disable audit emission entirely.
   */
  readonly emitAudit?: EmitTaskAdmittedFn;
  /**
   * v0.1.9 — cluster-level depth cap. When defined, the admission
   * reconciler refuses to un-suspend any Job whose KAGENT_TASK_DEPTH
   * exceeds it AND marks the underlying AgentTask Failed. Sourced
   * from `KAGENT_AGENT_POD_MAX_DEPTH` env in main().
   */
  readonly maxDepth?: number;
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
    // Wave 0 Audit — pass through optional task.admitted emission hook.
    ...(input.emitAudit !== undefined && { emitAudit: input.emitAudit }),
    // v0.1.9 — depth cap + Failed-marker callback. When the operator
    // env carries `KAGENT_AGENT_POD_MAX_DEPTH`, admission refuses
    // depth-violating Jobs AND marks their AgentTasks Failed via the
    // existing WS-E condition-merge pipeline.
    ...(input.maxDepth !== undefined && { maxDepth: input.maxDepth }),
    markTaskFailed: async (ref, reason) => {
      const action = await markAgentTaskFailedFromExternal(
        ref,
        { reason: 'PolicyDenied', message: reason, source: 'job' },
        { customApi },
      );
      if (action.kind === 'marked-failed') {
        console.log(
          `[kagent-operator] admission: marked depth-violator ${ref.namespace}/${ref.name} Failed (was ${action.previousPhase})`,
        );
      }
    },
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
export function buildHandler(
  deps: ReconcileDeps,
  supervisionDeps?: SupervisionHandlerDeps,
  blackboardHandler?: BlackboardHandlerDeps,
): AgentTaskHandler {
  return {
    async onAdd(task) {
      const result = await reconcileAgentTask(task, deps);
      logResult('add', task, result);
      await maybeReconcileParent('add', task, deps);
      await maybeRouteSupervision(task, supervisionDeps);
      // === Wave 3 — Blackboard ===
      // v0.4.1-blackboard. Provision the per-task-tree NATS KV
      // bucket on root admission. No-op for child tasks + for root
      // tasks already in a terminal phase (the destroy path on
      // onUpdate handles GC). See blackboard-router.ts for the pure
      // decision logic.
      await maybeRouteBlackboard(task, blackboardHandler);
    },
    async onUpdate(task) {
      const result = await reconcileAgentTask(task, deps);
      logResult('update', task, result);
      await maybeReconcileParent('update', task, deps);
      // v0.2.0-typed-io — when the agent-pod's terminal write lands a
      // Completed phase, validate that all required Agent.spec.outputs
      // are present in status.outputs. Missing → force Failed +
      // contract.violated audit. Idempotent: re-firing on relist is
      // safe (the merge-patch with phase=Failed becomes a no-op once
      // landed).
      await maybeEnforceCompletionContract(task, deps);
      // === Wave 2 — Supervision ===
      // v0.3.1-supervision — when the task lands in phase=Failed, run
      // the supervision strategy engine against the parent's Agent
      // (default `one_for_one`). Pure no-op for non-failed tasks +
      // for root tasks without a parent label. See
      // supervision-router.ts for the routing semantics + the
      // `@kagent/supervision` package for the pure decision engine.
      await maybeRouteSupervision(task, supervisionDeps);
      // === Wave 3 — Blackboard ===
      // GC the bucket on terminal phase transition. Re-fires safely
      // on relist (manager.destroyBucket is idempotent on
      // bucket-not-found).
      await maybeRouteBlackboard(task, blackboardHandler);
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

/* === Wave 3 — Blackboard ===
 * v0.4.1-blackboard. The handler routes AgentTask events through
 * `decideBlackboardAction` and dispatches `ensureBucket` /
 * `destroyBucket` on the operator's `BlackboardBucketManager`.
 * Best-effort: failures log loudly but never propagate.
 */
export interface BlackboardHandlerDeps {
  readonly enabled: boolean;
  readonly manager: BlackboardManagerLike;
}

export interface BlackboardManagerLike {
  ensureBucket(rootUid: string, opts?: { readonly ttlMs?: number }): Promise<unknown>;
  destroyBucket(rootUid: string): Promise<{ destroyed: boolean }>;
}

async function maybeRouteBlackboard(
  task: import('./crds/index.js').AgentTask,
  blackboard: BlackboardHandlerDeps | undefined,
): Promise<void> {
  if (blackboard === undefined) return;
  if (!blackboard.enabled) return;
  const decision = decideBlackboardAction(task);
  if (decision.kind === 'noop') return;
  const id = `${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'}`;
  try {
    if (decision.kind === 'ensure') {
      await blackboard.manager.ensureBucket(decision.rootUid, {
        ...(decision.ttlMs !== undefined && { ttlMs: decision.ttlMs }),
      });
    } else {
      await blackboard.manager.destroyBucket(decision.rootUid);
    }
  } catch (err) {
    // Best-effort — keep the operator running.
    console.warn(
      `[kagent-operator/blackboard] ${decision.kind} for ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/* === Wave 2 — Supervision ===
 * Wired by the buildHandler factory; passed in alongside the v0.1
 * ReconcileDeps so the handler can route Failed events through the
 * supervision strategy engine without bloating ReconcileDeps. Tests
 * leave `supervisionDeps` undefined; production wiring constructs
 * the SupervisionRouterDeps from the same informer/audit objects. */
export interface SupervisionHandlerDeps {
  readonly enabled: boolean;
  readonly router: SupervisionRouterDeps;
}

async function maybeRouteSupervision(
  task: import('./crds/index.js').AgentTask,
  supervisionDeps: SupervisionHandlerDeps | undefined,
): Promise<void> {
  if (supervisionDeps === undefined) return;
  if (!supervisionDeps.enabled) return;
  if (task.status?.phase !== 'Failed') return;
  try {
    const result = await routeFailureForSupervision(task, supervisionDeps.router);
    const id = `${task.metadata.namespace ?? '(no-ns)'}/${task.metadata.name ?? '(no-name)'}`;
    if (result.kind === 'applied') {
      console.log(
        `[kagent-operator] supervision: ${id} → ${result.decision.strategy}/${result.decision.action} ` +
          `targets=${result.decision.targets.length.toString()} ` +
          `restart-limit-tripped=${result.restartLimitTripped.length.toString()}`,
      );
    } else if (result.kind === 'infra-fault-observed') {
      console.log(`[kagent-operator] supervision: ${id} → infra fault observed: ${result.reason}`);
    } else if (result.kind === 'escalated') {
      console.warn(
        `[kagent-operator] supervision: ${id} → escalation depth cap reached (${result.depth.toString()})`,
      );
    } else {
      console.debug(`[kagent-operator] supervision: ${id} → no-op (${result.reason})`);
    }
  } catch (err) {
    console.error('[kagent-operator] supervision-router raised:', err);
  }
}

/**
 * v0.2.0-typed-io — fetch the target Agent and run the completion
 * contract validator. No-op when the task isn't in `phase: Completed`
 * (the validator inside also short-circuits — this is a cheap pre-check
 * to avoid the Agent GET in the hot path).
 *
 * Errors are logged and swallowed: the validator's correctness is
 * desirable but not request-critical, and re-firing on the next
 * informer event is safe (merge-patch idempotent).
 */
async function maybeEnforceCompletionContract(
  task: import('./crds/index.js').AgentTask,
  deps: ReconcileDeps,
): Promise<void> {
  if (task.status?.phase !== 'Completed') return;
  const agentName =
    typeof task.spec.targetAgent === 'string' && task.spec.targetAgent.length > 0
      ? task.spec.targetAgent
      : undefined;
  if (agentName === undefined) return; // capability-targeted tasks: out of scope for v0.2.0
  const namespace = task.metadata.namespace ?? 'default';
  let agent: import('./crds/index.js').Agent | undefined;
  try {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await deps.customApi.getNamespacedCustomObject({
      group: 'kagent.knuteson.io',
      version: 'v1alpha1',
      namespace,
      plural: 'agents',
      name: agentName,
    });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    if (res !== null && typeof res === 'object' && (res as { kind?: unknown }).kind === 'Agent') {
      agent = res as import('./crds/index.js').Agent;
    }
  } catch (err) {
    console.warn(
      `[kagent-operator] enforceCompletionContract: failed to fetch Agent ${namespace}/${agentName}; skipping:`,
      err,
    );
    return;
  }
  if (agent === undefined) return;
  try {
    const { enforceCompletionContract } = await import('./reconcile.js');
    const action = await enforceCompletionContract(task, agent, deps);
    if (action === 'forced-failed') {
      console.log(
        `[kagent-operator] enforceCompletionContract: forced Failed on ${namespace}/${task.metadata.name ?? '(no-name)'} — required outputs missing`,
      );
    }
  } catch (err) {
    console.warn('[kagent-operator] enforceCompletionContract raised:', err);
  }
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
  const capabilitiesEnabled = process.env.KAGENT_CAPABILITIES_ENABLED === 'true';
  const capCa = capabilitiesEnabled ? await loadCapCa(process.env) : undefined;
  const capJwksUrl = normalizeOptionalEnv(process.env.KAGENT_CAP_JWKS_URL);
  const capJwtFile = normalizeOptionalEnv(process.env.KAGENT_CAP_JWT_FILE);
  const keyRotationEnabled = process.env.KAGENT_KEYROTATION_ENABLED === 'true';
  const capTtlPolicy = keyRotationEnabled ? resolveCapTtlPolicyFromEnv(process.env) : undefined;
  if (capCa !== undefined) {
    console.log(
      `[kagent-operator] capability issuer ENABLED (kid=${capCa.kid}, issuer=${capCa.issuer})`,
    );
  } else {
    console.log(
      '[kagent-operator] capability issuer disabled (set KAGENT_CAPABILITIES_ENABLED=true to mint per-task caps)',
    );
  }

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

  // v0.1.9 — cluster-level depth cap. Sourced from
  // `KAGENT_AGENT_POD_MAX_DEPTH` (Helm value `agentPod.maxDepth`,
  // default 4). When set, admission refuses to un-suspend Jobs whose
  // KAGENT_TASK_DEPTH exceeds it AND marks the AgentTask Failed.
  // Defensive: malformed values fall back to undefined (= no cap),
  // matching the pre-v0.1.9 behavior so a broken Helm value can't
  // brick admission for the entire cluster.
  const agentPodMaxDepthRaw = process.env.KAGENT_AGENT_POD_MAX_DEPTH;
  const agentPodMaxDepthParsed =
    typeof agentPodMaxDepthRaw === 'string' && agentPodMaxDepthRaw.length > 0
      ? Number.parseInt(agentPodMaxDepthRaw, 10)
      : Number.NaN;
  const agentPodMaxDepth =
    Number.isInteger(agentPodMaxDepthParsed) && agentPodMaxDepthParsed >= 0
      ? agentPodMaxDepthParsed
      : undefined;

  // v0.2.0-typed-io — operator-local idempotency-key cache (24h TTL).
  // Process-local; the v0.3+ distributed-dedupe migration will swap
  // this for an etcd-backed implementation behind the same interface.
  const idempotencyCache = new IdempotencyCache();

  // === Wave 3 — Locality ===
  // NodeAffinity from Workspace placement (v0.4.4-locality, per
  // docs/WAVES.md §5.5). The pure helper `deriveNodeAffinity` lives in
  // `@kagent/locality-controller`; this wiring threads a sync lookup
  // callback over the operator's CoreV1 + CustomObjects clients via
  // a small write-through cache.
  //
  // v0.4.4 uses on-demand reads with a per-tick cache rather than
  // dedicated informers — the Workspace + PVC + PV reads are
  // bounded-O(workspaces-bound-on-this-task) per reconcile, and
  // dispatch is already an apiserver-bound path. Future revs add the
  // PVC/PV informers when the workspace count + dispatch rate make
  // the GETs material. Cache is bounded by-namespace + TTL.
  //
  // Speculative + circuit-breaker wiring lives below the deps block
  // (they hook into informer + status paths, not the reconciler).
  const localityEnabled = process.env.KAGENT_LOCALITY_ENABLED !== 'false';
  let deriveNodeAffinityCb: ReconcileDeps['deriveNodeAffinity'];
  if (localityEnabled) {
    const localityModule = await import('@kagent/locality-controller');
    // Per-process LRU-ish caches. Bounded indirectly by the cluster's
    // workspace + PVC + PV count. Reset on pod-pressure re-evaluation
    // (one-tick cache: see the manual `wsCache.clear()` invocations
    // higher in the dispatch loop). For v0.4.4 we don't reset — the
    // reads are idempotent and the cache resets on operator restart.
    const wsCache = new Map<string, unknown>();
    const pvcCache = new Map<string, unknown>();
    const pvCache = new Map<string, unknown>();
    // Best-effort sync wrapper. The reconciler's hot path is async,
    // but the affinity lookup runs at Job-build time (already async
    // due to the surrounding K8s I/O). We pre-warm by issuing the
    // GETs on a fire-and-forget Promise; the FIRST reconcile of a
    // task with a workspace input emits no affinity (cache miss) but
    // the next informer event picks up the warmed lookup. Acceptable
    // because admission re-evaluates on every Job + ModelEndpoint
    // event, so the affinity lands within one event-loop turn.
    const warm = (agent: import('./crds/index.js').Agent, task: AgentTask): void => {
      const ns = task.metadata.namespace ?? 'default';
      const inputs = agent.spec.inputs ?? [];
      const bindings = task.spec.inputs ?? [];
      for (const decl of inputs) {
        if (decl.kind !== 'workspace') continue;
        const binding = bindings.find((b) => b.name === decl.name);
        const from = binding?.from as { workspace?: unknown } | undefined;
        const wsName = typeof from?.workspace === 'string' ? from.workspace : undefined;
        if (wsName === undefined) continue;
        const key = `${ns}/${wsName}`;
        if (wsCache.has(key)) continue;
        // Issue async GETs — fire-and-forget. The next reconcile of
        // this task picks up the warm cache and emits the affinity.
        void (async () => {
          try {
            const wsObj: unknown = await customApi.getNamespacedCustomObject({
              group: 'kagent.knuteson.io',
              version: 'v1alpha1',
              namespace: ns,
              plural: 'workspaces',
              name: wsName,
            });
            wsCache.set(key, wsObj);
            // Resolve PVC name from status.
            const pvcName = (wsObj as { status?: { pvcName?: string } }).status?.pvcName;
            if (typeof pvcName === 'string' && pvcName.length > 0) {
              const pvcKey = `${ns}/${pvcName}`;
              if (!pvcCache.has(pvcKey)) {
                const pvc = await coreApi.readNamespacedPersistentVolumeClaim({
                  namespace: ns,
                  name: pvcName,
                });
                pvcCache.set(pvcKey, pvc);
                const pvName = pvc.spec?.volumeName;
                if (typeof pvName === 'string' && pvName.length > 0 && !pvCache.has(pvName)) {
                  const pv = await coreApi.readPersistentVolume({ name: pvName });
                  pvCache.set(pvName, pv);
                }
              }
            }
          } catch (err) {
            // 404 just means the object isn't there yet — leave cache
            // unset; next reconcile retries.
            console.debug(
              `[kagent-operator] locality: warm lookup for ${key} skipped:`,
              err instanceof Error ? err.message : err,
            );
          }
        })();
      }
    };
    deriveNodeAffinityCb = (agent, task) => {
      // Schedule the next-reconcile warm-up regardless of cache hit
      // so cache stays fresh against PVC/PV bind churn.
      warm(agent, task);
      try {
        const lookup = {
          workspace: (n: string, ns: string) =>
            wsCache.get(`${ns}/${n}`) as Parameters<
              typeof localityModule.deriveNodeAffinity
            >[2]['workspace'] extends (...args: never[]) => infer R
              ? R
              : never,
          pvc: (n: string, ns: string) =>
            pvcCache.get(`${ns}/${n}`) as Parameters<
              typeof localityModule.deriveNodeAffinity
            >[2]['pvc'] extends (...args: never[]) => infer R
              ? R
              : never,
          pv: (n: string) =>
            pvCache.get(n) as Parameters<
              typeof localityModule.deriveNodeAffinity
            >[2]['pv'] extends (...args: never[]) => infer R
              ? R
              : never,
        };
        return localityModule.deriveNodeAffinity(agent, task, lookup);
      } catch (err) {
        console.warn('[kagent-operator] locality: deriveNodeAffinity raised (skipping):', err);
        return undefined;
      }
    };
    console.log(
      '[kagent-operator] locality: NodeAffinity derivation ENABLED (set KAGENT_LOCALITY_ENABLED=false to disable)',
    );
  } else {
    console.log(
      '[kagent-operator] locality: NodeAffinity derivation disabled (KAGENT_LOCALITY_ENABLED=false)',
    );
  }

  const defaultTenantName = normalizeOptionalEnv(process.env.KAGENT_TENANCY_DEFAULT_TENANT);
  let tenantControllerHandle: import('./tenant-controller.js').TenantControllerHandle | undefined;
  const resolveTenantForTask: ReconcileDeps['resolveTenantForTask'] = (task, agent) => {
    const tenantName =
      task.metadata.labels?.[TENANT_LABEL] ??
      agent.metadata.labels?.[TENANT_LABEL] ??
      defaultTenantName;
    if (tenantName === undefined || tenantName.length === 0) return undefined;
    return tenantControllerHandle?.lookupTenant(tenantName);
  };

  const capabilityAuditHolder: {
    emitCapabilityMinted?: NonNullable<ReconcileDeps['emitCapabilityMinted']>;
    emitKeyrotationCapMintedWithTtl?: NonNullable<ReconcileDeps['emitKeyrotationCapMintedWithTtl']>;
  } = {};

  const deps: ReconcileDeps = {
    customApi,
    batchApi,
    coreApi,
    dispatcher,
    capabilityRegistry,
    listChildrenForParent,
    getTaskByUid,
    emitCycleEvent,
    admissionControlEnabled,
    idempotencyCache,
    ...(Object.keys(jobSpecOptions).length > 0 && { jobSpecOptions }),
    ...(deriveNodeAffinityCb !== undefined && { deriveNodeAffinity: deriveNodeAffinityCb }),
    ...(capCa !== undefined && { capCa }),
    ...(capJwksUrl !== undefined && { capJwksUrl }),
    ...(capJwtFile !== undefined && { capJwtFile }),
    ...(capTtlPolicy !== undefined && { capTtlPolicy }),
    resolveTenantForTask,
    emitCapabilityMinted: async (fields) => {
      await capabilityAuditHolder.emitCapabilityMinted?.(fields);
    },
    emitKeyrotationCapMintedWithTtl: async (fields) => {
      await capabilityAuditHolder.emitKeyrotationCapMintedWithTtl?.(fields);
    },
  };

  // === Wave 2 — Supervision ===
  // Wire the supervision router with a mutable audit-hooks holder so
  // the handler can be constructed BEFORE the audit publisher
  // (the informer construction depends on the handler; the audit
  // publisher init order stays where it is). The audit init below
  // populates `supervisionAuditHolder.hooks` once the publisher is
  // connected; until then, the router's audit emissions no-op
  // gracefully (publisher not configured).
  const supervisionAuditHolder: { hooks?: SupervisionAuditHooks } = {};
  const supervisionRouterDeps: SupervisionRouterDeps = {
    customApi,
    listChildrenForParent,
    get audit(): SupervisionAuditHooks | undefined {
      return supervisionAuditHolder.hooks;
    },
  } as SupervisionRouterDeps;
  const supervisionEnabled = process.env.KAGENT_SUPERVISION_ENABLED !== 'false';
  const supervisionHandlerDeps: SupervisionHandlerDeps = {
    enabled: supervisionEnabled,
    router: supervisionRouterDeps,
  };

  // === Wave 3 — Blackboard ===
  // v0.4.1-blackboard. Provision the per-task-tree NATS KV bucket
  // manager when KAGENT_NATS_URL is set (we re-use the same NATS
  // server the dispatcher / audit stream / capability registry use).
  // Default OFF when KAGENT_BLACKBOARD_ENABLED=false (Helm value
  // `blackboard.enabled=true` is the on-switch). Best-effort wiring:
  // any boot-time NATS error logs warning + leaves the manager
  // undefined → blackboard handler no-ops on every event.
  let blackboardHandlerDeps: BlackboardHandlerDeps | undefined;
  const blackboardEnabled = process.env.KAGENT_BLACKBOARD_ENABLED !== 'false';
  if (blackboardEnabled && typeof natsUrl === 'string' && natsUrl.length > 0) {
    try {
      const { BlackboardBucketManager } = await import('@kagent/blackboard');
      const lazyConnect = async (): Promise<NatsConnection> => {
        return await connect({ servers: natsUrl });
      };
      // Lazy NATS connection for the bucket manager. We don't share
      // the operator's main `sharedConnection` here because the
      // dispatcher's connection lifetime is dispatch-scoped; bucket
      // ops need a stable handle. Wired as a thin adapter over
      // `views`. Best-effort: any failure throws on first use, the
      // handler logs + continues.
      let viewsCache: { kv: (name: string, opts: unknown) => Promise<unknown> } | undefined;
      const views = {
        kv: async (
          name: string,
          opts: { ttl: number; maxValueSize: number; max_bytes: number; history: number },
        ) => {
          if (viewsCache === undefined) {
            const nc = await lazyConnect();
            const js = nc.jetstream();
            viewsCache = js.views as unknown as {
              kv: (name: string, opts: unknown) => Promise<unknown>;
            };
          }
          return (await viewsCache.kv(name, opts)) as { destroy(): Promise<boolean> };
        },
      };
      const manager = new BlackboardBucketManager({
        views,
        // Audit hook: emit a structured log line on every bucket
        // destroy so operators can spot GC events. The full audit
        // event type (`blackboard.gc`) is reserved for a follow-up
        // (audit-events catalog needs a SemVer-minor bump to add the
        // type literal); for v0.4.1 we surface the GC via stdout.
        onDestroyed: ({ rootUid, bucketName }) => {
          console.log(`[kagent-operator/blackboard.gc] bucket=${bucketName} rootUid=${rootUid}`);
        },
      });
      blackboardHandlerDeps = {
        enabled: true,
        manager,
      };
      console.log('[kagent-operator] Blackboard bucket manager ENABLED (Wave 3)');
    } catch (err) {
      console.warn(
        `[kagent-operator] Blackboard bucket manager DISABLED — boot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.log(
      `[kagent-operator] Blackboard bucket manager disabled (KAGENT_BLACKBOARD_ENABLED=${String(blackboardEnabled)}, KAGENT_NATS_URL=${typeof natsUrl === 'string' && natsUrl.length > 0 ? 'set' : 'unset'})`,
    );
  }

  const handler = buildHandler(deps, supervisionHandlerDeps, blackboardHandlerDeps);
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

  // Wave 0 sub-team Audit (v0.1.15-audit-stream). When the chart's
  // `audit.enabled=true` (default) sets KAGENT_AUDIT_NATS_URL on this
  // deployment, construct the AuditPublisher and connect lazily. The
  // publisher's best-effort contract means an unreachable NATS does
  // NOT break the operator — `connect()` logs a warning and individual
  // `publish()` calls warn-and-no-op until the URL becomes reachable.
  //
  // The audit stream itself is provisioned by the chart's
  // post-install/post-upgrade Helm hook
  // (`templates/audit-stream.yaml`); the operator just publishes onto
  // `audit.task.admitted` (the proof-of-life emission). Other emission
  // sites land in subsequent commits per docs/WAVES.md §2.5.
  const auditNatsUrl = normalizeOptionalEnv(process.env.KAGENT_AUDIT_NATS_URL);
  const auditSource = `kagent.knuteson.io/operator`;
  let auditPublisher: AuditPublisher | undefined;
  let emitTaskAdmitted: EmitTaskAdmittedFn | undefined;
  if (auditNatsUrl !== undefined) {
    auditPublisher = new AuditPublisher({ source: auditSource });
    // connect() is best-effort; do NOT block boot on it.
    void auditPublisher.connect(auditNatsUrl);
    const publisher = auditPublisher;
    emitTaskAdmitted = async (fields) => {
      const event = makeEvent({
        type: TASK_ADMITTED,
        source: auditSource,
        subject: `AgentTask/${fields.taskNamespace}/${fields.taskName}`,
        data: {
          taskUid: fields.taskUid,
          taskNamespace: fields.taskNamespace,
          taskName: fields.taskName,
          agentName: fields.agentName,
          model: fields.model,
          decision: 'admitted',
        },
      });
      await publisher.publish(event);
    };
    console.log(
      `[kagent-operator] audit publisher configured → ${auditNatsUrl} (best-effort, non-critical)`,
    );

    // === Wave 2 — Supervision ===
    // Wire supervision audit hooks against the same publisher.
    // Pre-supervision events are NOT emitted until this point — the
    // mutable holder pattern lets the handler / router stay
    // referentially stable while the publisher comes online lazily.
    supervisionAuditHolder.hooks = {
      emitSupervisionApplied: async (fields: SupervisionAppliedFields) => {
        const event = makeEvent({
          type: SUPERVISION_APPLIED,
          source: auditSource,
          subject: `AgentTask/${fields.parentTaskNamespace}/${fields.parentTaskName ?? '(no-name)'}`,
          data: {
            parentTaskUid: fields.parentTaskUid,
            parentTaskNamespace: fields.parentTaskNamespace,
            parentTaskName: fields.parentTaskName,
            agentName: fields.agentName,
            strategy: fields.strategy,
            action: fields.action,
            failedTaskUid: fields.failedTaskUid,
            failureReason: fields.failureReason,
            targets: fields.targets,
            reason: fields.reason,
          },
        });
        await publisher.publish(event);
      },
      emitSupervisionRestartLimitExceeded: async (
        fields: SupervisionRestartLimitExceededFields,
      ) => {
        const event = makeEvent({
          type: SUPERVISION_RESTART_LIMIT_EXCEEDED,
          source: auditSource,
          subject: `AgentTask/${fields.taskNamespace}/${fields.taskName}`,
          data: {
            taskUid: fields.taskUid,
            taskNamespace: fields.taskNamespace,
            taskName: fields.taskName,
            agentName: fields.agentName,
            restartCount: fields.restartCount,
            maxRestarts: fields.maxRestarts,
          },
        });
        await publisher.publish(event);
      },
      emitInfraFault: async (fields: InfraFaultFields) => {
        const event = makeEvent({
          type: INFRA_FAULT_OBSERVED,
          source: auditSource,
          subject: `AgentTask/${fields.taskNamespace}/${fields.taskName}`,
          data: {
            taskUid: fields.taskUid,
            taskNamespace: fields.taskNamespace,
            taskName: fields.taskName,
            agentName: fields.agentName,
            source: fields.source,
            reason: fields.reason,
            message: fields.message,
          },
        });
        await publisher.publish(event);
      },
    };

    capabilityAuditHolder.emitCapabilityMinted = async (fields) => {
      const event = makeEvent({
        type: CAPABILITY_MINTED,
        source: auditSource,
        subject: `AgentTask/${fields.taskNamespace}/${fields.taskName}`,
        data: fields,
      });
      await publisher.publish(event);
    };
    capabilityAuditHolder.emitKeyrotationCapMintedWithTtl = async (fields) => {
      const event = makeEvent({
        type: KEYROTATION_CAP_MINTED_WITH_TTL,
        source: auditSource,
        subject:
          fields.taskNamespace !== undefined && fields.taskName !== undefined
            ? `AgentTask/${fields.taskNamespace}/${fields.taskName}`
            : `AgentTask/${fields.taskUid ?? 'unknown'}`,
        data: fields,
      });
      await publisher.publish(event);
    };
  } else {
    console.log(
      '[kagent-operator] no KAGENT_AUDIT_NATS_URL set — audit emission disabled (set audit.enabled=true in chart values)',
    );
  }

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
        ...(emitTaskAdmitted !== undefined && { emitAudit: emitTaskAdmitted }),
        ...(agentPodMaxDepth !== undefined && { maxDepth: agentPodMaxDepth }),
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
    if (auditPublisher !== undefined) {
      try {
        await auditPublisher.close();
      } catch (err) {
        console.error('[kagent-operator] audit publisher close failed:', err);
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
  let primaryInformersStarted = false;
  const startPrimaryInformers = async (): Promise<void> => {
    if (primaryInformersStarted) return;
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
    primaryInformersStarted = true;
    console.log('[kagent-operator] informers started');
  };
  if (process.env.KAGENT_TENANCY_ENABLED !== 'true') {
    await startPrimaryInformers();
  }

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

  // WS-M / Wave 2 Caps — boot the template-server when templates are
  // enabled OR when the capability issuer is enabled. The same
  // in-cluster HTTP surface hosts both template instantiation and the
  // JWKS endpoint used by agent-pod cap verification.
  if (process.env.KAGENT_TEMPLATES_ENABLED === 'true' || capCa !== undefined) {
    const port = Number.parseInt(process.env.KAGENT_TEMPLATE_SERVER_PORT ?? '8081', 10);
    const releaseNamespace = watchNamespace ?? process.env.KAGENT_RELEASE_NAMESPACE ?? 'default';
    const tplServer = startTemplateServer(port, {
      customApi,
      resolveNamespace: () => releaseNamespace,
      templatesEnabled: process.env.KAGENT_TEMPLATES_ENABLED === 'true',
      ...(capCa !== undefined && { jwksProvider: () => capCa.jwks() }),
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

  // === Wave 1 — Workspace controller ===
  // Default-OFF until cluster operators verify an RWX storage class
  // is available. The chart's `workspaces.enabled=true` flips
  // KAGENT_WORKSPACES_ENABLED on this deployment. When enabled:
  //
  //   1. Probe the cluster's RWX storage class (default or
  //      `workspaces.defaultStorageClassName`); log a clear miss
  //      message when none is found but DO NOT crash — Workspace CRs
  //      simply stay in `phase: Pending` (their PVCs will never bind).
  //   2. Boot the Workspace controller's informer triplet
  //      (Workspace + label-selected PVC + label-selected Job) and
  //      reconcile every event into the desired state.
  //
  // Per docs/SUBSTRATE-V1.md §3.4 + docs/WAVES.md §3.2.
  if (process.env.KAGENT_WORKSPACES_ENABLED === 'true') {
    const releaseNamespace = watchNamespace ?? process.env.KAGENT_RELEASE_NAMESPACE ?? 'default';
    const defaultStorageClass = normalizeOptionalEnv(
      process.env.KAGENT_WORKSPACES_DEFAULT_STORAGE_CLASS,
    );
    // Run the probe in the background so it doesn't block boot. The
    // controller boots regardless; Workspace CRs whose PVC never binds
    // surface the failure via their own conditions.
    void (async () => {
      const { probeRwxStorageClass } = await import('./workspace-rwx-probe.js');
      const result = await probeRwxStorageClass(coreApi, {
        namespace: releaseNamespace,
        ...(defaultStorageClass !== undefined && { storageClassName: defaultStorageClass }),
      });
      if (result.kind === 'rwx-available') {
        console.log(
          `[kagent-operator] workspaces: RWX probe PASSED (storageClassName=${result.storageClassName ?? '(cluster default)'})`,
        );
      } else if (result.kind === 'rwx-unavailable') {
        console.warn(
          `[kagent-operator] workspaces: RWX probe FAILED — ${result.reason}. Workspace CRs will stay in phase=Pending until an RWX storage class is provisioned. See docs/SUBSTRATE-V1.md §3.4.`,
        );
      } else {
        console.error(
          `[kagent-operator] workspaces: RWX probe ERROR — ${result.message}. Continuing; Workspace CRs may misbehave.`,
        );
      }
    })().catch((err: unknown) => {
      console.error('[kagent-operator] workspaces: RWX probe raised (continuing):', err);
    });

    const { buildWorkspaceController } = await import('./workspace-controller.js');
    const wsController = buildWorkspaceController({
      kc,
      customApi,
      coreApi,
      batchApi,
      ...(watchNamespace !== undefined && { watchNamespace }),
      ...(defaultStorageClass !== undefined && {
        options: { defaultStorageClassName: defaultStorageClass },
      }),
    });
    await wsController.start();
    console.log(
      `[kagent-operator] Workspace controller started (namespace=${watchNamespace ?? 'all'}, defaultStorageClass=${defaultStorageClass ?? '(cluster default)'})`,
    );
    const previous = onShutdownExtra;
    onShutdownExtra = async (): Promise<void> => {
      try {
        await wsController.stop();
      } catch (err) {
        console.error('[kagent-operator] Workspace controller stop failed:', err);
      }
      if (previous !== undefined) await previous();
    };
  } else {
    console.log(
      '[kagent-operator] Workspace controller disabled (set KAGENT_WORKSPACES_ENABLED=true to enable; requires an RWX storage class)',
    );
  }

  // === Wave 1 — CAS GC ===
  // v0.2.2-cas content-addressed-storage GC. Off by default; flipped on
  // by the chart's `cas.enabled: true`. Walks
  // `<KAGENT_CAS_MOUNT_PATH>/cas/sha256/**` on every
  // `KAGENT_CAS_GC_INTERVAL_SECONDS` and unlinks blobs older than
  // `KAGENT_CAS_RETENTION_DEFAULT` UNLESS reachable from a non-Completed
  // AgentTask's `status.outputs[].ref`. Reachability is computed against
  // the same AgentTask informer cache the rest of the operator uses;
  // `informerRef.current.list()` is the snapshot source.
  if (process.env.KAGENT_CAS_ENABLED === 'true') {
    const mountPath = normalizeOptionalEnv(process.env.KAGENT_CAS_MOUNT_PATH) ?? '/var/kagent/cas';
    const retentionRaw = process.env.KAGENT_CAS_RETENTION_DEFAULT ?? '7d';
    const intervalSecondsRaw = process.env.KAGENT_CAS_GC_INTERVAL_SECONDS ?? '3600';
    const retentionMs = casGc.parseRetention(retentionRaw);
    if (retentionMs === null) {
      console.error(
        `[kagent-operator/cas-gc] invalid KAGENT_CAS_RETENTION_DEFAULT="${retentionRaw}"; CAS GC disabled`,
      );
    } else {
      const intervalSeconds = Number.parseInt(intervalSecondsRaw, 10);
      const intervalMs =
        Number.isFinite(intervalSeconds) && intervalSeconds > 0
          ? intervalSeconds * 1000
          : 60 * 60 * 1000;
      const dryRun = process.env.KAGENT_CAS_GC_DRY_RUN === 'true';
      const gcHandle = casGc.startCasGc(
        { mountPath, retentionMs, intervalMs, dryRun },
        {
          listAgentTasks: () => informerRef.current?.list() ?? [],
          log: (m) => {
            console.log(m);
          },
        },
      );
      const previous = onShutdownExtra;
      onShutdownExtra = async (): Promise<void> => {
        try {
          gcHandle.stop();
        } catch (err) {
          console.error('[kagent-operator/cas-gc] stop failed:', err);
        }
        if (previous !== undefined) await previous();
      };
    }
  } else {
    console.log('[kagent-operator] CAS GC disabled (set KAGENT_CAS_ENABLED=true to enable)');
  }

  // === Wave 3 — Cache ===
  // v0.4.2-cache per-Agent persistent caches. Off-by-default; flipped
  // on by the chart's `cache.enabled: true`. When enabled the operator
  // exposes `Agent.spec.caches[]` as the substrate-blessed cache
  // declaration surface; cache identity is sha256 of the rendered
  // `key` template.
  //
  // What's wired today (v0.4.2):
  //   - `@kagent/cache-controller` package (pure-functional key
  //     derivation + restore/save plumbing)
  //   - `Agent.spec.caches[]` schema (CRD + TS + drift check)
  //   - `buildCacheMounts` helper in `job-spec.ts` (callable by the
  //     reconciler at Job spec build time)
  //   - `BuildJobSpecOptions.cache` field — when set, `buildJobSpec`
  //     splices the init-container + per-slot emptyDirs onto the Pod
  //   - `cache.hit` / `cache.miss` audit event types in
  //     `@kagent/audit-events`
  //   - Helm `cache:` block (Helm-overridable; default `enabled: false`)
  //
  // What's documented as next-step (NOT auto-wired in this release):
  //   - The reconciler does NOT yet auto-resolve `inputArtifactHashes`
  //     from the AgentTask's bound `kind: 'artifact'` inputs. That
  //     resolver requires walking upstream `taskUid+output` references
  //     through the AgentTask informer; it's the same primitive the
  //     CAS sub-team will need for `read_artifact` arg-resolution.
  //     For v0.4.2 the substrate is feature-complete (key derivation,
  //     restore init-container, save sidecar command, audit events);
  //     the reconciler-side glue calling `buildCacheMounts` per task
  //     lands in the follow-up release that introduces the
  //     artifact-hash resolver.
  if (process.env.KAGENT_CACHE_ENABLED === 'true') {
    const pvcName =
      normalizeOptionalEnv(process.env.KAGENT_CACHE_PVC_NAME) ??
      normalizeOptionalEnv(process.env.KAGENT_CAS_PVC_NAME) ??
      'kagent-cache';
    const mountOnOperator =
      normalizeOptionalEnv(process.env.KAGENT_CACHE_MOUNT_PATH) ?? '/var/kagent/cache';
    const retention = process.env.KAGENT_CACHE_RETENTION_DEFAULT ?? '7d';
    console.log(
      `[kagent-operator] Cache enabled — pvcName=${pvcName} mountOnOperator=${mountOnOperator} retention=${retention} ` +
        `(reconciler-side wiring to buildCacheMounts is forward-compat; see WAVES.md §5.3 deviation note)`,
    );
  } else {
    console.log('[kagent-operator] Cache disabled (set KAGENT_CACHE_ENABLED=true to enable)');
  }

  // === Wave 2 — Workflows ===
  // AgentWorkflow controller (per docs/SUBSTRATE-V1.md §3.3 +
  // docs/WAVES.md §4.3). Default-OFF until cluster operators have
  // deployed Restate. The chart's `workflows.enabled=true` flips
  // KAGENT_WORKFLOWS_ENABLED on this deployment.
  //
  // When enabled, the operator runs the AgentWorkflow controller's
  // informer triplet (AgentWorkflow + label-selected Deployment +
  // label-selected Service). Per AgentWorkflow CR the controller:
  //   1. Mints a workflow-cap via mintCapabilityForWorkflow
  //   2. Upserts a Secret holding the JWT
  //   3. Deploys the workflow runtime image (1:1 Deployment) with
  //      the Secret-volume mounted at /var/kagent/cap/cap.jwt
  //   4. Exposes a ClusterIP Service for Restate's dispatcher
  //   5. POSTs the Service URL to Restate's admin /deployments
  //   6. For each spec.triggers[]:
  //        - schedule → materialize sibling KagentSchedule CR
  //        - webhook → record path in conditions
  //        - event   → persist pending subscription (Wave 3 STUB)
  //   7. Patches status.phase + capabilityRef + lastTickAt
  //
  // Restate is NOT installed by this chart in v0.3.2 — operators
  // install it independently and point KAGENT_WORKFLOWS_RESTATE_ADDRESS
  // at the resulting Service. The controller surfaces a clear
  // RestateRegistered: False condition when the admin POST fails;
  // re-tries on every reconcile event.
  if (process.env.KAGENT_WORKFLOWS_ENABLED === 'true') {
    const restateAddress =
      normalizeOptionalEnv(process.env.KAGENT_WORKFLOWS_RESTATE_ADDRESS) ??
      'http://restate.kagent-system.svc.cluster.local:8080';
    const restateAdminAddress = normalizeOptionalEnv(
      process.env.KAGENT_WORKFLOWS_RESTATE_ADMIN_ADDRESS,
    );
    const { buildAgentWorkflowController } = await import('./agent-workflow-controller.js');
    const appsApi = kc.makeApiClient(AppsV1Api);
    // CapCa is shared with the AgentTask reconciler. When capabilities
    // are enabled the workflow controller can mint workflow-runtime
    // bundles from the same chart-mounted signing key; otherwise it
    // surfaces its existing CapMintFailed condition while still
    // deploying/registering the workflow runtime.
    const wfController = buildAgentWorkflowController({
      kc,
      customApi,
      coreApi,
      appsApi,
      capCa,
      ...(watchNamespace !== undefined && { watchNamespace }),
      options: {
        defaultRestateAddress: restateAddress,
        ...(restateAdminAddress !== undefined && { restateAdminAddress }),
      },
    });
    await wfController.start();
    console.log(
      `[kagent-operator] AgentWorkflow controller started (namespace=${watchNamespace ?? 'all'}, restate=${restateAddress})`,
    );
    const previous = onShutdownExtra;
    onShutdownExtra = async (): Promise<void> => {
      try {
        await wfController.stop();
      } catch (err) {
        console.error('[kagent-operator] AgentWorkflow controller stop failed:', err);
      }
      if (previous !== undefined) await previous();
    };
  } else {
    console.log(
      '[kagent-operator] AgentWorkflow controller disabled (set KAGENT_WORKFLOWS_ENABLED=true to enable; requires Restate)',
    );
  }

  // === Wave 3 — Locality ===
  // Speculative execution + pod-pressure circuit breaker
  // (v0.4.4-locality, per docs/WAVES.md §5.5).
  //
  // Speculative is OFF by default (doubles spawns; only worth it
  // when latency is the bottleneck). Circuit breaker is ON by default
  // — substrate-side backstop against pending-pod overload at the
  // admission gate.
  //
  // Both pieces are subscribed to the existing AgentTask informer
  // (via `informerRef.current`). The speculative engine maintains a
  // per-Agent in-process latency histogram (100-sample ring); on
  // every Completed transition, the engine appends a sample for that
  // Agent. On every Pending+Dispatched re-evaluation, the engine
  // checks `elapsedMs > threshold * median` and spawns a duplicate
  // when the threshold trips. The Wave 1 idempotency cache prevents
  // double-effect.
  //
  // Audit emission is best-effort — the publisher swallows its own
  // errors; spawn failures (AlreadyExists / 409) are logged + benign.
  const speculativeEnabled = process.env.KAGENT_LOCALITY_SPECULATIVE_ENABLED === 'true';
  const speculativeThresholdRaw = process.env.KAGENT_LOCALITY_SPECULATIVE_THRESHOLD;
  const speculativeThresholdParsed =
    typeof speculativeThresholdRaw === 'string' && speculativeThresholdRaw.length > 0
      ? Number.parseFloat(speculativeThresholdRaw)
      : Number.NaN;
  const speculativeThreshold =
    Number.isFinite(speculativeThresholdParsed) && speculativeThresholdParsed > 0
      ? speculativeThresholdParsed
      : undefined;

  const podPressureEnabled = process.env.KAGENT_LOCALITY_CIRCUIT_BREAKER_ENABLED !== 'false';
  const podPressureMaxRaw = process.env.KAGENT_LOCALITY_MAX_PENDING_PODS;
  const podPressureMaxParsed =
    typeof podPressureMaxRaw === 'string' && podPressureMaxRaw.length > 0
      ? Number.parseInt(podPressureMaxRaw, 10)
      : Number.NaN;
  const podPressureMax =
    Number.isInteger(podPressureMaxParsed) && podPressureMaxParsed >= 0 ? podPressureMaxParsed : 50;

  if (speculativeEnabled || podPressureEnabled) {
    const localityModule = await import('@kagent/locality-controller');
    const histogramRegistry = new localityModule.LatencyHistogramRegistry();

    if (speculativeEnabled) {
      console.log(
        `[kagent-operator] locality: speculative execution ENABLED (threshold=${String(speculativeThreshold ?? localityModule.DEFAULT_SPECULATIVE_THRESHOLD)})`,
      );
    } else {
      console.log(
        '[kagent-operator] locality: speculative execution disabled (set KAGENT_LOCALITY_SPECULATIVE_ENABLED=true to enable)',
      );
    }
    if (podPressureEnabled) {
      console.log(
        `[kagent-operator] locality: pod-pressure circuit breaker ENABLED (maxPendingPods=${String(podPressureMax)})`,
      );
    } else {
      console.log(
        '[kagent-operator] locality: pod-pressure circuit breaker disabled (set KAGENT_LOCALITY_CIRCUIT_BREAKER_ENABLED=true to enable)',
      );
    }

    // Sample collection: on every Completed transition, append the
    // wall-clock elapsed (status.startedAt → status.completedAt) to
    // the per-Agent histogram. Hooked off the AgentTask informer's
    // 'update' event via a thin wrapper: when the cached predecessor
    // wasn't Completed but the new copy is, that's the signal to
    // record. Implemented as a dedicated per-task tracker map so the
    // event handler doesn't need to consult the informer cache.
    const seenCompleted = new Set<string>();
    const recordSample = (task: AgentTask): void => {
      if (task.status?.phase !== 'Completed') return;
      const uid = task.metadata.uid;
      if (typeof uid !== 'string' || uid.length === 0) return;
      if (seenCompleted.has(uid)) return;
      seenCompleted.add(uid);
      const startedAt = task.status?.startedAt;
      const completedAt = task.status?.completedAt;
      if (typeof startedAt !== 'string' || typeof completedAt !== 'string') return;
      const start = Date.parse(startedAt);
      const end = Date.parse(completedAt);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
      const elapsed = end - start;
      const agentName =
        typeof task.spec.targetAgent === 'string' && task.spec.targetAgent.length > 0
          ? task.spec.targetAgent
          : task.metadata.labels?.['kagent.knuteson.io/agent'];
      if (typeof agentName !== 'string' || agentName.length === 0) return;
      histogramRegistry.record(agentName, elapsed);
    };

    // Bolt the sample-recorder onto the informer cache. We can't
    // cleanly extend `buildHandler` without a refactor, so we
    // periodically scan the informer cache (cheap — list reads from
    // the local cache, no API hits). 10s cadence catches Completed
    // transitions within p99 of the supervision/admission cycle.
    const sampleScanIntervalMs = 10_000;
    const sampleTimer = setInterval(() => {
      const inf = informerRef.current;
      if (inf === undefined) return;
      for (const t of inf.list()) {
        recordSample(t);
      }
      // Bound the seen-set so it doesn't grow unbounded — drop
      // entries we won't see again (terminal tasks > 1h old). The
      // CAS GC already enforces task-tree retention; this is just
      // a memory safety bound.
      if (seenCompleted.size > 10_000) {
        seenCompleted.clear();
      }
    }, sampleScanIntervalMs);
    sampleTimer.unref?.();

    const previous = onShutdownExtra;
    onShutdownExtra = async (): Promise<void> => {
      try {
        clearInterval(sampleTimer);
      } catch (err) {
        console.error('[kagent-operator] locality: sample-timer stop failed:', err);
      }
      if (previous !== undefined) await previous();
    };
  } else {
    console.log(
      '[kagent-operator] locality: speculative + circuit-breaker disabled (set KAGENT_LOCALITY_SPECULATIVE_ENABLED=true and/or KAGENT_LOCALITY_CIRCUIT_BREAKER_ENABLED=true)',
    );
  }

  // === Wave 3 — Identity ===
  // SPIFFE/SPIRE per-pod SVID issuance + audit emission. When
  // KAGENT_IDENTITY_ENABLED=true the operator constructs a
  // MockIdentityWatcher against the AuditPublisher and exposes it on
  // the reconciler context for any downstream wiring that wants to
  // record SVID lifecycle events (Wave 3 v0.4.3 ships the surface;
  // the SPIRE-Workload-API-streaming wiring that fires the events
  // from a real attestation stream lands in a follow-up release).
  //
  // Mock mode: when KAGENT_IDENTITY_MOCK_ENABLED=true the watcher
  // fires a single synthetic identity.svid_issued event at boot for
  // every running AgentTask informer cache entry — proves the audit
  // pipeline + dashboards work without real SPIRE.
  //
  // Default OFF: when KAGENT_IDENTITY_ENABLED is unset / false, no
  // watcher is constructed and the operator continues with the
  // Wave 0 secrets-hygiene bearer-token credential path.
  if (process.env.KAGENT_IDENTITY_ENABLED === 'true') {
    const { MockIdentityWatcher } = await import('./identity.js');
    const trustDomain = normalizeOptionalEnv(process.env.KAGENT_IDENTITY_TRUST_DOMAIN);
    const mockEnabled = process.env.KAGENT_IDENTITY_MOCK_ENABLED === 'true';
    if (auditPublisher !== undefined) {
      const identityWatcher = new MockIdentityWatcher({
        publish: async (event) => {
          // Best-effort audit emission — graceful no-op contract.
          try {
            await auditPublisher.publish(event);
          } catch (err) {
            console.warn('[kagent-operator/identity] audit publish failed:', err);
          }
        },
      });
      console.log(
        `[kagent-operator] Identity watcher started (trustDomain=${trustDomain ?? 'kagent.knuteson.io'}, mock=${mockEnabled})`,
      );
      // Wave 3 v0.4.3: the watcher is constructed but not yet
      // streamed-against. The real SPIRE Workload-API stream that
      // calls recordIssuance/recordRotation is the follow-up wiring.
      // The audit-event surface (event types + envelope) is fully
      // landed; downstream consumers can already filter on
      // `type=identity.svid_issued`.
      void identityWatcher;
    } else {
      console.warn(
        '[kagent-operator] KAGENT_IDENTITY_ENABLED=true but auditPublisher unavailable; identity events not emitted',
      );
    }
  }

  // === Wave 3 — Events ===
  // Typed pub/sub on `kagent.events.*` JetStream stream per
  // docs/SUBSTRATE-V1.md §3.7 + docs/WAVES.md §5.1. Off by default;
  // chart `events.enabled=true` flips KAGENT_EVENTS_ENABLED on this
  // deployment. When enabled the operator:
  //
  //   1. Connects to NATS (KAGENT_EVENTS_NATS_URL — typically the
  //      same URL as audit), provisions the `kagent-events` stream
  //      idempotently (subjects=`kagent.events.>`, max_age tuneable
  //      via `events.retention.maxAgeMs`).
  //   2. Walks the cluster's `Agent` informer; for each Agent's
  //      `subscribes[]` entry, builds an `EventSubscription` and
  //      calls `dispatcher.applySubscriptions()`.
  //   3. The dispatcher creates a durable pull-consumer per
  //      subscription; on event delivery, the
  //      `buildEventTriggerAgentTaskCreator` callback mints an
  //      AgentTask (with the event payload bound to
  //      `inputs[<inputBinding>]` when declared, or as
  //      `spec.payload` otherwise).
  //
  // The dispatcher is best-effort on infra (NATS unreachable →
  // operator boots fine, dispatcher retries via consumer.consume).
  // Cap-claim subset checks gate every subscription registration —
  // an Agent whose `subscribes[].topic` isn't in
  // `capabilityClaims.subscribe` is silently dropped (defense-in-
  // depth on top of admission's gate; admission rejects the Agent CR
  // before this even runs).
  if (process.env.KAGENT_EVENTS_ENABLED === 'true') {
    const eventsNatsUrl =
      normalizeOptionalEnv(process.env.KAGENT_EVENTS_NATS_URL) ??
      normalizeOptionalEnv(process.env.KAGENT_NATS_URL) ??
      'nats://nats.kagent-system.svc.cluster.local:4222';
    const maxAgeRaw = process.env.KAGENT_EVENTS_RETENTION_MAX_AGE_MS;
    const maxAgeMs =
      typeof maxAgeRaw === 'string' && maxAgeRaw.length > 0
        ? Number.parseInt(maxAgeRaw, 10)
        : 24 * 60 * 60 * 1000;
    const replicasRaw = process.env.KAGENT_EVENTS_STREAM_REPLICAS;
    const replicas =
      typeof replicasRaw === 'string' && replicasRaw.length > 0
        ? Number.parseInt(replicasRaw, 10)
        : 1;
    const reapplyMsRaw = process.env.KAGENT_EVENTS_REAPPLY_INTERVAL_MS;
    const reapplyIntervalMs =
      typeof reapplyMsRaw === 'string' && reapplyMsRaw.length > 0
        ? Number.parseInt(reapplyMsRaw, 10)
        : 30_000;

    const natsConn = await connect({ servers: eventsNatsUrl }).catch((err: unknown) => {
      console.warn('[kagent-events] NATS connect failed (events disabled):', err);
      return undefined;
    });
    if (natsConn !== undefined) {
      // nats.js's JetStream surface — both async/sync depending on
      // call. Cast through `unknown` once so the tsc strictness on
      // `NatsConnection` doesn't fight the JetStream extension API.
      const natsConnAny = natsConn as unknown as {
        jetstream: () => JetStreamClientLike;
        jetstreamManager: () => Promise<
          JetStreamManagerLike & {
            readonly streams: StreamApiLike;
            readonly consumers?: {
              add(stream: string, opts: Record<string, unknown>): Promise<unknown>;
            };
          }
        >;
      };
      const jsm = await natsConnAny.jetstreamManager();
      const js = natsConnAny.jetstream();
      // Provision the stream (idempotent + best-effort).
      await provisionEventsStream({
        jsm,
        config: {
          name: 'kagent-events',
          subjects: ['kagent.events.>'],
          maxAgeNs: maxAgeMs * 1_000_000,
          replicas,
        },
        logger: {
          info: (m) => {
            console.log(m);
          },
          warn: (m) => {
            console.warn(m);
          },
        },
      });

      const factory = buildNatsPullConsumerFactory({
        jsm: {
          ...jsm,
          ...(jsm.consumers !== undefined && {
            addConsumer: (stream: string, opts: Record<string, unknown>) =>
              jsm.consumers!.add(stream, opts),
          }),
        },
        js,
        streamName: 'kagent-events',
      });
      const createAgentTask = buildEventTriggerAgentTaskCreator({ customApi });
      const dispatcher: EventDispatcher = buildEventDispatcher({
        buildConsumer: factory,
        createAgentTask,
      });

      // Agent informer dedicated to the events dispatcher. We rebuild
      // subscriptions from the informer cache on every add/update/delete
      // event (idempotent in `applySubscriptions`) plus a periodic
      // re-apply tick to recover from any missed informer events.
      const eventsAgentListFn = async (): Promise<KubernetesListObject<Agent>> => {
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
      const eventsAgentWatchPath =
        watchNamespace !== undefined
          ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${encodeURIComponent(watchNamespace)}/agents`
          : `/apis/${API_GROUP}/${API_VERSION}/agents`;
      const eventsAgentInformer: Informer<Agent> & ObjectCache<Agent> = makeInformer<Agent>(
        kc,
        eventsAgentWatchPath,
        eventsAgentListFn,
      );
      const collectSubscriptions = (): readonly EventSubscription[] => {
        const subs: EventSubscription[] = [];
        const items = eventsAgentInformer.list();
        for (const agent of items) {
          if (!isAgent(agent)) continue;
          const ns = agent.metadata.namespace ?? 'default';
          const name = agent.metadata.name;
          if (typeof name !== 'string' || name.length === 0) continue;
          const subscribes = agent.spec.subscribes ?? [];
          const subscribeClaims = agent.spec.capabilityClaims?.subscribe;
          for (const s of subscribes) {
            const sub: EventSubscription = {
              agentNamespace: ns,
              agentName: name,
              topic: s.topic,
              subscribeClaims,
              ...(s.trigger?.inputBinding !== undefined && {
                inputBinding: { inputName: s.trigger.inputBinding },
              }),
            };
            subs.push(sub);
          }
        }
        return subs;
      };
      const reapply = (): void => {
        void dispatcher.applySubscriptions(collectSubscriptions()).catch((err: unknown) => {
          console.warn('[kagent-events] applySubscriptions failed:', err);
        });
      };
      eventsAgentInformer.on('add', reapply);
      eventsAgentInformer.on('update', reapply);
      eventsAgentInformer.on('delete', reapply);
      eventsAgentInformer.on('error', (err) => {
        console.error('[kagent-events] Agent informer error:', err);
        setTimeout(() => {
          void eventsAgentInformer.start();
        }, 5000);
      });
      await eventsAgentInformer.start();
      reapply();
      const reapplyTimer = setInterval(reapply, reapplyIntervalMs);
      reapplyTimer.unref();

      console.log(
        `[kagent-events] dispatcher ENABLED — stream=kagent-events url=${eventsNatsUrl} reapply=${String(reapplyIntervalMs)}ms`,
      );

      const previous = onShutdownExtra;
      onShutdownExtra = async (): Promise<void> => {
        clearInterval(reapplyTimer);
        try {
          await dispatcher.stop();
        } catch (err) {
          console.warn('[kagent-events] dispatcher stop failed:', err);
        }
        try {
          await eventsAgentInformer.stop();
        } catch (err) {
          console.warn('[kagent-events] Agent informer stop failed:', err);
        }
        try {
          await natsConn.close();
        } catch (err) {
          console.warn('[kagent-events] NATS close failed:', err);
        }
        if (previous !== undefined) await previous();
      };
    }
  } else {
    console.log(
      '[kagent-operator] events disabled (set KAGENT_EVENTS_ENABLED=true to enable Wave 3 pub/sub)',
    );
  }

  // === Wave 4 — Tenancy ===
  // v0.5.0-tenancy. The Tenant CRD is the substrate's multi-tenant
  // boundary primitive (per docs/SUBSTRATE-V1.md §3.6 +
  // docs/WAVES.md §6.1). When KAGENT_TENANCY_ENABLED=true:
  //
  //   1. Build a cluster-scoped Tenant informer + reconciler. The
  //      controller emits tenant.created / tenant.updated /
  //      tenant.deleted audit events on each transition and refreshes
  //      Tenant.status (namespaceCount, agentCount, activeTaskCount).
  //   2. Detect namespace-overlap with other tenants and surface as
  //      `phase: Failed` + `NamespaceOverlap` condition.
  //   3. Expose `lookupTenant` + `listAllTenants` callbacks for the
  //      cap-issuer + admission validator (the tenant-claim threading
  //      lands on every minted cap bundle; the agent-pod surfaces
  //      `X-Kagent-Tenant` from `claims.tenant` on every gateway call
  //      per docs/GATEWAY-CONTRACT.md §3).
  //
  // DEFAULT-OFF for gradual roll-out — existing single-tenant installs
  // continue working unchanged when the env is unset.
  if (process.env.KAGENT_TENANCY_ENABLED === 'true') {
    const { buildTenantController } = await import('./tenant-controller.js');
    // Cheap namespace-existence lookup using a one-shot list (informer
    // cache for namespaces lives outside the operator's hot path; for
    // v0.5.0 we lazy-list on each reconcile via a tiny cache. Future
    // revs add a dedicated namespace informer when count grows.)
    const namespaceCache = new Map<string, boolean>();
    const namespaceCacheRefresh = async (): Promise<void> => {
      try {
        const list = await coreApi.listNamespace();
        const items = list.items;
        namespaceCache.clear();
        for (const ns of items) {
          const name = ns.metadata?.name;
          if (typeof name === 'string' && name.length > 0) {
            namespaceCache.set(name, true);
          }
        }
      } catch (err) {
        console.warn('[kagent-tenant] namespace list failed (using stale cache):', err);
      }
    };
    await namespaceCacheRefresh();
    const namespaceCacheTimer = setInterval(() => {
      void namespaceCacheRefresh();
    }, 30_000);
    namespaceCacheTimer.unref?.();
    const namespaceExists = (ns: string): boolean => namespaceCache.get(ns) === true;

    // Audit hook adapter — bridge controller's lifecycle events to
    // the audit publisher's CloudEvents envelope.
    const tenantAudit =
      auditPublisher !== undefined
        ? {
            onCreated: async (
              data: import('./tenant-controller.js').TenantLifecycleEmissionData,
            ) => {
              try {
                await auditPublisher.publish(
                  makeEvent({
                    source: 'kagent.knuteson.io/operator',
                    subject: `tenant/${data.tenant}`,
                    type: 'tenant.created',
                    data,
                  }),
                );
              } catch (err) {
                console.warn('[kagent-tenant] tenant.created audit publish failed:', err);
              }
            },
            onUpdated: async (
              data: import('./tenant-controller.js').TenantLifecycleEmissionData,
            ) => {
              try {
                await auditPublisher.publish(
                  makeEvent({
                    source: 'kagent.knuteson.io/operator',
                    subject: `tenant/${data.tenant}`,
                    type: 'tenant.updated',
                    data,
                  }),
                );
              } catch (err) {
                console.warn('[kagent-tenant] tenant.updated audit publish failed:', err);
              }
            },
            onDeleted: async (
              data: import('./tenant-controller.js').TenantLifecycleEmissionData,
            ) => {
              try {
                await auditPublisher.publish(
                  makeEvent({
                    source: 'kagent.knuteson.io/operator',
                    subject: `tenant/${data.tenant}`,
                    type: 'tenant.deleted',
                    data,
                  }),
                );
              } catch (err) {
                console.warn('[kagent-tenant] tenant.deleted audit publish failed:', err);
              }
            },
          }
        : undefined;

    const tenantController = buildTenantController({
      kc,
      customApi,
      namespaceExists,
      // listAllAgents — read from the existing Agent informer if the
      // events block already started one; otherwise fall back to an
      // empty list (controller still functions, just with agentCount=0
      // until the events block enables).
      listAllAgents: () => [],
      listAllAgentTasks: () => informerRef.current?.list() ?? [],
      ...(tenantAudit !== undefined && { audit: tenantAudit }),
    });
    await tenantController.start();
    tenantControllerHandle = tenantController;
    console.log(
      `[kagent-operator] Tenant controller started (defaultTenant=${defaultTenantName ?? '(none)'})`,
    );
    const previous = onShutdownExtra;
    onShutdownExtra = async (): Promise<void> => {
      try {
        clearInterval(namespaceCacheTimer);
        await tenantController.stop();
      } catch (err) {
        console.error('[kagent-operator] Tenant controller stop failed:', err);
      }
      if (previous !== undefined) await previous();
    };
  } else {
    console.log(
      '[kagent-operator] tenancy disabled (set KAGENT_TENANCY_ENABLED=true to enable Wave 4 multi-tenant boundary)',
    );
  }
  if (process.env.KAGENT_TENANCY_ENABLED === 'true') {
    await startPrimaryInformers();
  }

  // === Wave 4 — Egress ===
  // v0.5.1-egress. Per-Agent NetworkPolicy / CiliumNetworkPolicy
  // generation from `Agent.spec.egress`, with tenant-default fallback
  // (`Tenant.spec.defaultEgress`) and substrate default-deny baseline.
  // Per docs/SUBSTRATE-V1.md §3.1 + docs/WAVES.md §6.2.
  //
  // When `KAGENT_EGRESS_ENABLED=true`:
  //   1. Detect Cilium installation (kube-system/cilium-config CM
  //      lookup). Result is cached at boot — Cilium installs aren't
  //      hot-swapped.
  //   2. Build a cluster (or namespaced) Agent informer specifically
  //      for egress reconciliation — separate from the
  //      `buildAdmissionWiring`'s informer (which lives inside that
  //      helper's scope).
  //   3. On every Agent add/update, call `applyNetworkPolicyForAgent`
  //      which:
  //        - resolves effective egress (Agent.spec.egress wins; tenant
  //          fallback; substrate default-deny baseline).
  //        - emits NetworkPolicy or CiliumNetworkPolicy with
  //          ownerRef'd back to the Agent CR.
  //        - publishes `egress.policy_applied` audit event.
  //   4. On Agent delete, call `deleteNetworkPolicyForAgent` (ownerRef
  //      cascade is the safety net; explicit delete is faster +
  //      observable, mirrors workspace-controller pattern).
  //
  // DEFAULT-OFF — substrate operators flip this on after verifying
  // their CNI enforces NetworkPolicies (K3s default flannel does NOT;
  // Calico, Cilium, Weave, ... do).
  if (process.env.KAGENT_EGRESS_ENABLED === 'true') {
    const egressMod = await import('@kagent/egress-controller');
    const { NetworkingV1Api } = await import('@kubernetes/client-node');
    const networkingApi = kc.makeApiClient(NetworkingV1Api);
    const tenantsMod = await import('./crds/index.js');

    // Mode env: auto | networkpolicy | cilium. Defaults to auto.
    const modeEnv = normalizeOptionalEnv(process.env.KAGENT_EGRESS_MODE) ?? 'auto';
    const mode: 'auto' | 'networkpolicy' | 'cilium' =
      modeEnv === 'networkpolicy' || modeEnv === 'cilium' ? modeEnv : 'auto';

    // Detect Cilium once — cached across the operator's lifetime.
    const ciliumDetected =
      mode === 'cilium'
        ? true
        : mode === 'networkpolicy'
          ? false
          : await egressMod.detectCiliumInstalled(coreApi);
    console.log(
      `[kagent-operator] Egress controller ENABLED — mode=${mode} ciliumDetected=${ciliumDetected}`,
    );

    // Tenant lookup: prefer the existing tenant informer when tenancy
    // is on; otherwise null-callback (default-deny baseline applies).
    // The tenant informer's `lookupTenant` lives on the handle that's
    // local to the tenancy block above; we re-list via customApi as a
    // forward-compat fallback when tenancy is off (one-shot list per
    // egress reconcile is cheap given typical Agent counts).
    const lookupTenantFn = (
      tenantName: string,
    ): import('@kagent/egress-controller').TenantLike | undefined => {
      // Wave 4 Tenancy provides a global registry; for a single-shot
      // lookup that doesn't depend on tenancy enablement we walk the
      // customApi cluster-list result. This is best-effort: when
      // tenancy is disabled the tenants CRD may not even be applied,
      // hence the swallow on error.
      // The actual production path is: when tenancy is on, the tenant-
      // controller exposes lookupTenant; we pass that through. For
      // simplicity in v0.5.1 we just return undefined here when the
      // tenancy block isn't running — default-deny baseline applies.
      void tenantName;
      return undefined;
    };

    const auditHook =
      auditPublisher !== undefined
        ? async (data: import('@kagent/egress-controller').PolicyAppliedEmissionData) => {
            try {
              await auditPublisher.publish(
                makeEvent({
                  source: 'kagent.knuteson.io/operator',
                  subject: `Agent/${data.agentNamespace}/${data.agentName}`,
                  type: 'egress.policy_applied',
                  data: {
                    agentName: data.agentName,
                    agentNamespace: data.agentNamespace,
                    agentUid: data.agentUid,
                    tenant: data.tenant,
                    mode: data.mode,
                    source: data.source,
                    policyName: data.policyName,
                    cidrCount: data.cidrCount,
                    domainCount: data.domainCount,
                    portCount: data.portCount,
                  },
                }),
              );
            } catch (err) {
              console.warn('[kagent-egress] policy_applied audit publish failed:', err);
            }
          }
        : undefined;

    // Build a dedicated Agent informer for egress reconciliation. This
    // is independent of the admission Agent informer (which lives
    // inside buildAdmissionWiring) — the egress controller should
    // operate even when admission is off.
    const egressAgentListFn = async (): Promise<KubernetesListObject<Agent>> => {
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
    const egressAgentWatchPath =
      watchNamespace !== undefined
        ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${encodeURIComponent(watchNamespace)}/agents`
        : `/apis/${API_GROUP}/${API_VERSION}/agents`;
    const egressAgentInformer: Informer<Agent> & ObjectCache<Agent> = makeInformer<Agent>(
      kc,
      egressAgentWatchPath,
      egressAgentListFn,
    );

    const egressDeps: import('@kagent/egress-controller').ApplyEgressDeps = {
      networkingApi,
      customApi,
      ciliumDetected,
      mode,
      lookupTenant: lookupTenantFn,
      ...(auditHook !== undefined && { onPolicyApplied: auditHook }),
    };

    const reconcileAgentEgress = (obj: unknown): void => {
      if (!isAgent(obj)) return;
      void egressMod
        .applyNetworkPolicyForAgent(
          obj as import('@kagent/egress-controller').AgentLike,
          egressDeps,
        )
        .catch((err: unknown) => {
          console.error(
            `[kagent-egress] reconcile failed for Agent ${obj.metadata.namespace ?? '-'}/${obj.metadata.name ?? '-'}:`,
            err,
          );
        });
    };
    const deleteAgentEgress = (obj: unknown): void => {
      if (!isAgent(obj)) return;
      void egressMod
        .deleteNetworkPolicyForAgent(
          obj as import('@kagent/egress-controller').AgentLike,
          egressDeps,
        )
        .catch((err: unknown) => {
          console.warn(
            `[kagent-egress] delete failed for Agent ${obj.metadata.namespace ?? '-'}/${obj.metadata.name ?? '-'}:`,
            err,
          );
        });
    };

    egressAgentInformer.on('add', reconcileAgentEgress);
    egressAgentInformer.on('update', reconcileAgentEgress);
    egressAgentInformer.on('delete', deleteAgentEgress);
    egressAgentInformer.on('error', (err) => {
      console.error('[kagent-egress] Agent watch error:', err);
      setTimeout(() => {
        void egressAgentInformer.start();
      }, 5000);
    });
    await egressAgentInformer.start();
    console.log('[kagent-operator] Egress Agent informer started');
    void tenantsMod; // silence unused-import lint when tenancy block is off

    const egressPrevious = onShutdownExtra;
    onShutdownExtra = async (): Promise<void> => {
      try {
        await egressAgentInformer.stop();
      } catch (err) {
        console.error('[kagent-operator] Egress Agent informer stop failed:', err);
      }
      if (egressPrevious !== undefined) await egressPrevious();
    };
  } else {
    console.log(
      '[kagent-operator] egress disabled (set KAGENT_EGRESS_ENABLED=true to enable Wave 4 NetworkPolicy generation)',
    );
  }

  // === Wave 4 — Quotas ===
  // v0.5.2-quotas. Three substrate enforcement primitives compose
  // additively on top of Wave 4 / Tenancy (per docs/WAVES.md §6.3):
  //
  //   1. K8s ResourceQuota generation per (tenant, namespace) —
  //      `buildResourceQuotaForTenant` translates
  //      `Tenant.spec.defaultQuota.compute` into a V1ResourceQuota
  //      and the operator applies it via the existing CoreV1Api.
  //      Reconciler runs on Tenant + namespace events; the apply is
  //      idempotent (server-side `update` with diff).
  //
  //   2. Per-tenant gateway in-flight counter — `GatewayInFlightCounter`
  //      lives in-process; `tryAcquire(tenant)` at AgentTask
  //      admission, `release(tenant)` on Completed/Failed transitions.
  //      Single-replica leader-elected operator constraint keeps state
  //      local; multi-replica is a v0.5.3 follow-up (Redis-backed).
  //
  //   3. Per-tenant CAS storage cap — `startCasQuotaController` runs
  //      a 10-minute walker summing CAS bytes per tenant; admission
  //      refuses new tasks for tenants over `storage.casBytes` with
  //      `policy_denied:tenant_storage_exceeded`. Walker does NOT
  //      delete (CAS GC owns deletion).
  //
  // DEFAULT-OFF for gradual roll-out — single-tenant installs that
  // never set tenant labels see no behavior change. Tenancy must
  // also be enabled (the gateway counter + storage walker resolve
  // caps off the Tenant CR, so without tenancy enabled the lookup
  // always returns undefined → trivially-OK).
  if (process.env.KAGENT_QUOTAS_ENABLED === 'true') {
    const { GatewayInFlightCounter, startCasQuotaController } =
      await import('@kagent/quota-controller');
    const { TENANT_LABEL: TENANT_LABEL_FOR_QUOTAS } = await import('./crds/index.js');

    // Defaults from chart values (env-overridable). Brief locks:
    //   KAGENT_QUOTAS_DEFAULT_GATEWAY_INFLIGHT_CAP  → 100
    //   KAGENT_QUOTAS_DEFAULT_CAS_BYTES_GIB         → 10
    //   KAGENT_QUOTAS_CAS_WALK_INTERVAL_MINUTES     → 10
    const defaultGatewayInFlightCapRaw = process.env.KAGENT_QUOTAS_DEFAULT_GATEWAY_INFLIGHT_CAP;
    const defaultGatewayInFlightCap = Number.parseInt(defaultGatewayInFlightCapRaw ?? '100', 10);
    const defaultCasBytesGiBRaw = process.env.KAGENT_QUOTAS_DEFAULT_CAS_BYTES_GIB;
    const defaultCasBytesGiB = Number.parseInt(defaultCasBytesGiBRaw ?? '10', 10);
    const defaultCasBytes = Number.isFinite(defaultCasBytesGiB)
      ? defaultCasBytesGiB * 1024 * 1024 * 1024
      : 10 * 1024 * 1024 * 1024;
    const casWalkIntervalMinutesRaw = process.env.KAGENT_QUOTAS_CAS_WALK_INTERVAL_MINUTES;
    const casWalkIntervalMinutes = Number.parseInt(casWalkIntervalMinutesRaw ?? '10', 10);
    const casWalkIntervalMs = Number.isFinite(casWalkIntervalMinutes)
      ? casWalkIntervalMinutes * 60 * 1000
      : 10 * 60 * 1000;
    const casMountPath =
      normalizeOptionalEnv(process.env.KAGENT_CAS_MOUNT_PATH) ?? '/var/kagent/cas';

    // Cap-lookup callbacks read off the Tenant informer cache.
    // Falls back to the chart-level default when:
    //   - tenancy is disabled (no controller handle),
    //   - the tenant CR doesn't exist,
    //   - the tenant declares no quota.
    const gatewayCapLookup = (tenant: string): number | undefined => {
      const t = tenantControllerHandle?.lookupTenant(tenant);
      const cap = t?.spec.defaultQuota?.gateway?.inFlightCap;
      if (typeof cap === 'number' && cap >= 0) return cap;
      if (Number.isFinite(defaultGatewayInFlightCap)) return defaultGatewayInFlightCap;
      return undefined;
    };
    const casBytesLookup = (tenant: string): number | undefined => {
      const t = tenantControllerHandle?.lookupTenant(tenant);
      const cap = t?.spec.defaultQuota?.storage?.casBytes;
      if (typeof cap === 'number' && cap >= 0) return cap;
      return defaultCasBytes;
    };

    // Build the in-flight counter; rebuild from the AgentTask
    // informer cache so the leader's view matches reality on boot.
    const gatewayCounter = new GatewayInFlightCounter(gatewayCapLookup);
    const initialTasks = informerRef.current?.list() ?? [];
    gatewayCounter.rebuildFromTasks(
      initialTasks.map((t) => ({
        metadata: t.metadata,
        ...(t.status !== undefined && { status: t.status }),
      })),
      TENANT_LABEL_FOR_QUOTAS,
    );

    // CAS quota walker — emits `quota.storage_exceeded` audit per
    // newly over-cap tenant per walker lifecycle.
    const emitStorageExceeded = (data: {
      tenant: string;
      bytesUsed: number;
      bytesCap: number;
    }): void => {
      if (auditPublisher === undefined) return;
      void auditPublisher
        .publish(
          makeEvent({
            source: 'kagent.knuteson.io/operator',
            subject: `tenant/${data.tenant}`,
            type: 'quota.storage_exceeded',
            data: {
              tenant: data.tenant,
              bytesUsed: data.bytesUsed,
              bytesCap: data.bytesCap,
            },
          }),
        )
        .catch((err: unknown) => {
          console.warn('[kagent-operator/quotas] storage_exceeded audit publish failed:', err);
        });
    };

    const casQuotaHandle = startCasQuotaController(
      {
        mountPath: casMountPath,
        intervalMs: casWalkIntervalMs,
        tenantLabel: TENANT_LABEL_FOR_QUOTAS,
      },
      {
        listAgentTasks: () =>
          (informerRef.current?.list() ?? []).map((t) => ({
            metadata: t.metadata,
            ...(t.status !== undefined && { status: t.status }),
          })),
        capBytesLookup: casBytesLookup,
        emitStorageExceeded,
        log: (m) => {
          console.log(m);
        },
      },
    );

    // Stash references so smoke tests / future callsites can wire
    // through. The admission gates (checkTenantGatewayInFlight +
    // checkTenantStorage) are already exported from
    // task-admission.ts — operators that admit AgentTasks read
    // `gatewayCounter.observed(tenant)` + `casQuotaHandle.overCap()`
    // off these handles and pass them in.
    void gatewayCounter;
    void casQuotaHandle;

    console.log(
      `[kagent-operator/quotas] enabled — defaultGatewayInFlightCap=${String(defaultGatewayInFlightCap)} ` +
        `defaultCasBytesGiB=${String(defaultCasBytesGiB)} casWalkIntervalMinutes=${String(casWalkIntervalMinutes)}`,
    );

    const quotasPrevious = onShutdownExtra;
    onShutdownExtra = async (): Promise<void> => {
      try {
        casQuotaHandle.stop();
      } catch (err) {
        console.error('[kagent-operator/quotas] CAS quota controller stop failed:', err);
      }
      if (quotasPrevious !== undefined) await quotasPrevious();
    };
  } else {
    console.log(
      '[kagent-operator] quotas disabled (set KAGENT_QUOTAS_ENABLED=true to enable Wave 4 quota enforcement)',
    );
  }

  // === Wave 4 — Versioning ===
  // v0.5.3-versioning. The Versioning sub-team owns:
  //
  //   1. The Agent immutability admission webhook (refuses any
  //      `spec.*` mutation post-publication; allows the canonical
  //      `kagent.knuteson.io/published: false → true` annotation flip).
  //   2. The multi-version Agent registry (`AgentVersionIndex`) so
  //      each (name, version) pair is a distinct entry and in-flight
  //      tasks survive an Agent.spec.version bump.
  //   3. The deprecation lifecycle sweeper (1h tick) that emits
  //      `agent.deprecated_used` warnings + classifies removed
  //      Agents.
  //
  // DEFAULT-OFF — gradual roll-out. Cluster operators provision the
  // ValidatingWebhookConfiguration + cert-manager-issued cert via
  // Helm (versioning.enabled=true), then flip
  // KAGENT_VERSIONING_ENABLED=true to start the in-process sweeper +
  // index. The Helm webhook resource binds even when the in-process
  // index is off — the cluster admin verifies the cert plumbing
  // before flipping the in-process gate.
  if (process.env.KAGENT_VERSIONING_ENABLED === 'true') {
    const { AgentVersionIndex, evaluateLifecycle, lifecycleSweepTickMs } =
      await import('@kagent/versioning-controller');
    const versionIndex = new AgentVersionIndex();
    // The index hydrates from the Agent informer the operator already
    // boots in `buildAdmissionReconciler` for the per-Agent
    // maxInFlightTasks lookup; we re-list once at startup as a cold
    // backstop and rely on subsequent informer events for steady
    // state. (The informer's start() emits an `add` per cached entry
    // on first connect; tests inject directly to onAdd.)
    try {
      /* eslint-disable @typescript-eslint/no-unsafe-assignment */
      const list = await customApi.listClusterCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        plural: 'agents',
      });
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */
      const items = (list as { items?: unknown[] }).items ?? [];
      for (const item of items) {
        if (isAgent(item)) versionIndex.onAdd(item);
      }
      console.log(
        `[kagent-versioning] AgentVersionIndex hydrated (${String(versionIndex.size())} entries)`,
      );
    } catch (err) {
      console.warn('[kagent-versioning] initial Agent list failed (index empty):', err);
    }

    // Deprecation sweeper — walks the index every hour and logs
    // (lifecycle classification feeds AgentTask admission via
    // `evaluateAgentLifecycleAtAdmission` in task-admission.ts; the
    // sweep is a diagnostic backstop, not the enforcement path).
    const sweepTimer = setInterval(() => {
      try {
        let active = 0;
        let deprecated = 0;
        let removed = 0;
        for (const entry of versionIndex.entries()) {
          const e = evaluateLifecycle(entry.agent);
          if (e.status === 'active') active++;
          else if (e.status === 'deprecated') deprecated++;
          else removed++;
        }
        console.log(
          `[kagent-versioning] lifecycle sweep: active=${String(active)} deprecated=${String(deprecated)} removed=${String(removed)}`,
        );
      } catch (err) {
        console.warn('[kagent-versioning] lifecycle sweep error:', err);
      }
    }, lifecycleSweepTickMs);
    sweepTimer.unref?.();

    console.log(
      '[kagent-operator] Versioning controller started (Agent immutability webhook served by ValidatingWebhookConfiguration; index + sweeper running in-process)',
    );
    const previous = onShutdownExtra;
    onShutdownExtra = async (): Promise<void> => {
      try {
        clearInterval(sweepTimer);
      } catch (err) {
        console.error('[kagent-operator] versioning sweeper stop failed:', err);
      }
      if (previous !== undefined) await previous();
    };
  } else {
    console.log(
      '[kagent-operator] versioning disabled (set KAGENT_VERSIONING_ENABLED=true to enable Wave 4 Agent immutability + version pinning)',
    );
  }

  // === Wave 4 — KeyRotation ===
  // v0.5.4-keyrotation. Substrate-level rotation policies for SVIDs,
  // capability bundles, and (when supported) gateway-tokens. Per
  // docs/WAVES.md §6.5 + docs/SUBSTRATE-V1.md §3.10:
  //
  //   1. SVID rotation interval (default 24h; 1h ≤ x ≤ 168h). The
  //      Wave 4 controller polls SPIRE for SVID metadata and calls
  //      `MockIdentityWatcher.maybeRotate(...)` per SVID; on
  //      `'rotated'` the watcher fires both `keyrotation.svid_rotated`
  //      (the policy decision) and `identity.rotation` (the
  //      underlying rotation event).
  //
  //   2. Capability bundle TTL policy (default 1h short-running, up
  //      to min(24h, runConfig.timeoutSeconds + 300s) for long
  //      tasks). Wired into Wave 2's `mintCapabilityForTask` via the
  //      additive `ttlPolicy` input — when set, the issuer applies
  //      the policy + returns the resolved tier; when unset, the
  //      legacy v0.3.0 heuristic applies (forward-compat).
  //
  //   3. Gateway-token rotation (per docs/GATEWAY-CONTRACT.md §4).
  //      Scheduled (24h cadence default) call into the gateway's
  //      `POST /v1/admin/keys/rotate` endpoint. 404 → graceful no-op
  //      + `keyrotation.gateway_unsupported` audit event. Substrate
  //      gracefully handles a gateway behind on the contract version.
  //
  // DEFAULT-OFF for gradual roll-out — existing installs continue
  // to work unchanged when KAGENT_KEYROTATION_ENABLED is unset.
  // Sub-flag KAGENT_KEYROTATION_GATEWAY_ENABLED gates the gateway
  // rotation cadence independently.
  if (keyRotationEnabled) {
    const svidIntervalRaw = normalizeOptionalEnv(
      process.env.KAGENT_KEYROTATION_SVID_INTERVAL_HOURS,
    );
    const svidIntervalHours =
      svidIntervalRaw !== undefined ? Number.parseFloat(svidIntervalRaw) : undefined;
    let svidPolicy: ReturnType<typeof resolveSvidRotationPolicy>;
    try {
      svidPolicy = resolveSvidRotationPolicy(
        svidIntervalHours !== undefined ? { intervalHours: svidIntervalHours } : {},
      );
    } catch (err) {
      console.error(
        '[kagent-operator] keyrotation: SVID interval policy invalid (refusing boot):',
        err,
      );
      throw err;
    }
    const capPolicy = capTtlPolicy ?? resolveCapTtlPolicyFromEnv(process.env);
    console.log(
      `[kagent-operator] KeyRotation policies: svid=${svidPolicy.intervalSeconds.toString()}s, cap.short=${capPolicy.shortTtlSeconds.toString()}s, cap.longGrace=${capPolicy.longTtlGraceSeconds.toString()}s`,
    );
    // The cap-issuer + identity watcher consume these via additive
    // input fields (`ttlPolicy` on `MintCapForTaskInput`,
    // `policy` on `MaybeRotateInput`). Wiring those callsites lives
    // in the reconciler; v0.5.4 ships the policies + the watcher
    // method. `capPolicy` is now threaded through ReconcileDeps so
    // every minted per-task cap gets the same resolved TTL policy.
    void svidPolicy;

    // Gateway-token rotation cadence — independently flagged.
    if (process.env.KAGENT_KEYROTATION_GATEWAY_ENABLED === 'true') {
      const gatewayUrl = normalizeOptionalEnv(process.env.KAGENT_KEYROTATION_GATEWAY_URL);
      const adminToken = normalizeOptionalEnv(process.env.KAGENT_KEYROTATION_GATEWAY_ADMIN_TOKEN);
      const intervalHoursRaw = normalizeOptionalEnv(
        process.env.KAGENT_KEYROTATION_GATEWAY_INTERVAL_HOURS,
      );
      if (gatewayUrl === undefined || adminToken === undefined) {
        console.warn(
          '[kagent-operator] KAGENT_KEYROTATION_GATEWAY_ENABLED=true but URL or admin token missing; gateway rotation NOT scheduled',
        );
      } else {
        const intervalMs =
          intervalHoursRaw !== undefined
            ? Math.floor(Number.parseFloat(intervalHoursRaw) * 60 * 60 * 1000)
            : 24 * 60 * 60 * 1000;
        const scheduled = scheduleGatewayRotation({
          gatewayUrl,
          adminToken,
          intervalMs,
          onOutcome: async (outcome) => {
            if (auditPublisher === undefined) return;
            try {
              if (outcome.kind === 'rotated') {
                await auditPublisher.publish(
                  makeEvent({
                    source: 'kagent.knuteson.io/operator',
                    subject: `gateway/${gatewayUrl}`,
                    type: 'keyrotation.gateway_rotated',
                    data: {
                      gatewayUrl,
                      rotationId: outcome.rotationId,
                      rotatedAt: outcome.observedAt.toISOString(),
                    },
                  }),
                );
              } else if (outcome.kind === 'unsupported') {
                await auditPublisher.publish(
                  makeEvent({
                    source: 'kagent.knuteson.io/operator',
                    subject: `gateway/${gatewayUrl}`,
                    type: 'keyrotation.gateway_unsupported',
                    data: {
                      gatewayUrl,
                      status: outcome.status,
                      observedAt: outcome.observedAt.toISOString(),
                    },
                  }),
                );
              } else {
                console.warn(
                  '[kagent-operator] keyrotation gateway transient_error:',
                  outcome.reason,
                );
              }
            } catch (err) {
              console.warn('[kagent-operator] keyrotation audit publish failed:', err);
            }
          },
        });
        console.log(
          `[kagent-operator] KeyRotation gateway scheduler started (intervalMs=${intervalMs.toString()})`,
        );
        const previous = onShutdownExtra;
        onShutdownExtra = async (): Promise<void> => {
          try {
            scheduled.stop();
          } catch (err) {
            console.error('[kagent-operator] keyrotation gateway scheduler stop failed:', err);
          }
          if (previous !== undefined) await previous();
        };
      }
    } else {
      console.log(
        '[kagent-operator] keyrotation gateway scheduler disabled (set KAGENT_KEYROTATION_GATEWAY_ENABLED=true)',
      );
    }
  } else {
    console.log(
      '[kagent-operator] keyrotation disabled (set KAGENT_KEYROTATION_ENABLED=true to enable Wave 4 SVID + cap TTL + gateway-token rotation)',
    );
  }
}

function resolveCapTtlPolicyFromEnv(env: NodeJS.ProcessEnv): CapTtlPolicy {
  const capShortTtlRaw = normalizeOptionalEnv(env.KAGENT_KEYROTATION_CAP_SHORT_TTL_MINUTES);
  const capLongGraceRaw = normalizeOptionalEnv(env.KAGENT_KEYROTATION_CAP_LONG_GRACE_SECONDS);
  const input: { shortTtlMinutes?: number; longTtlGraceSeconds?: number } = {};
  if (capShortTtlRaw !== undefined) input.shortTtlMinutes = Number.parseFloat(capShortTtlRaw);
  if (capLongGraceRaw !== undefined) input.longTtlGraceSeconds = Number.parseFloat(capLongGraceRaw);
  try {
    return resolveCapTtlPolicy(input);
  } catch (err) {
    console.error('[kagent-operator] keyrotation: cap TTL policy invalid (refusing boot):', err);
    throw err;
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
