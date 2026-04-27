/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Job-spec builder — translates an Agent + AgentTask pair into the
 * Kubernetes Job that runs `@kagent/agent-pod`. v0.1 ships only the
 * shape; the real container image is built in Phase 3 (the agent pod
 * runtime). Image tag here is a placeholder so the spec is complete
 * + applies cleanly + is overridable from the operator's Helm values.
 *
 * Job-per-task model (DESIGN-V0.1.md §5 "In scope" #5). Warm pool /
 * StatefulSet is a v0.2 affordance once cold-start latency matters.
 */

import type { V1Job } from '@kubernetes/client-node';

import type { Agent, AgentTask } from './crds/index.js';

const DEFAULT_IMAGE = 'ghcr.io/ctkadvisors/kagent-agent-pod:v0.0.1-phase2-stub';
const DEFAULT_BACKOFF_LIMIT = 0; // Don't retry — operator owns retry policy.
const DEFAULT_TTL_SECONDS_AFTER_FINISHED = 3600; // GC completed Pods after 1h.

export interface BuildJobSpecOptions {
  /** Container image for the agent pod. Defaults to the v0.0.1 placeholder. */
  readonly image?: string;
  /** Optional `imagePullSecrets[].name` (e.g. ghcr-pull). */
  readonly imagePullSecret?: string;
  /** ServiceAccount the agent pod runs under. */
  readonly serviceAccountName?: string;
  /** Set to 'kata' when Agent.spec.sandboxProfile === 'strict' (v0.2). */
  readonly runtimeClassName?: string;
  /**
   * Extra env vars appended to the agent-pod container after the
   * KAGENT_TASK_*, KAGENT_AGENT_* defaults. Used by the operator to
   * plumb agent-pod runtime config (e.g. KAGENT_LITELLM_BASE_URL,
   * KAGENT_NATS_URL, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) from its
   * own env into the spawned pod without per-Agent overrides.
   */
  readonly extraEnv?: readonly { readonly name: string; readonly value: string }[];
}

/**
 * Deterministic Job name from an AgentTask. Uses the task UID (which
 * K8s assigns at creation) so a re-reconcile of the same task picks
 * the same Job name and CreateNamespacedJob returns AlreadyExists
 * instead of producing a duplicate Pod.
 */
export function jobNameForTask(task: AgentTask): string {
  const uid = task.metadata.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new Error('AgentTask is missing metadata.uid — cannot derive Job name');
  }
  // K8s names: [a-z0-9-]{,63}. UID is hyphenated lowercase already; truncate
  // to leave room for the prefix.
  return `kat-${uid.slice(0, 50)}`;
}

/**
 * Build a Job spec for an AgentTask under a given Agent.
 *
 * The spec mounts the AgentTask + Agent definitions as env vars on the
 * pod (downward-API-style, but injected directly as JSON strings since
 * we don't need the K8s downward API for this — the operator already
 * has the resolved objects in hand). The agent pod reads them at boot.
 */
export function buildJobSpec(agent: Agent, task: AgentTask, opts: BuildJobSpecOptions = {}): V1Job {
  const namespace = task.metadata.namespace ?? 'default';
  const jobName = jobNameForTask(task);
  const image = opts.image ?? DEFAULT_IMAGE;

  const env: { name: string; value: string }[] = [
    { name: 'KAGENT_TASK_ID', value: task.metadata.uid ?? '' },
    { name: 'KAGENT_TASK_NAME', value: task.metadata.name ?? '' },
    { name: 'KAGENT_TASK_NAMESPACE', value: namespace },
    { name: 'KAGENT_AGENT_NAME', value: agent.metadata.name ?? '' },
    { name: 'KAGENT_AGENT_SPEC', value: JSON.stringify(agent.spec) },
    { name: 'KAGENT_TASK_SPEC', value: JSON.stringify(task.spec) },
    ...(opts.extraEnv ?? []).map((e) => ({ name: e.name, value: e.value })),
  ];

  const podSpec: V1Job['spec'] = {
    backoffLimit: DEFAULT_BACKOFF_LIMIT,
    ttlSecondsAfterFinished: DEFAULT_TTL_SECONDS_AFTER_FINISHED,
    template: {
      metadata: {
        labels: {
          'kagent.knuteson.io/agent': agent.metadata.name ?? '',
          'kagent.knuteson.io/task': task.metadata.name ?? '',
          'kagent.knuteson.io/managed-by': 'kagent-operator',
        },
      },
      spec: {
        restartPolicy: 'Never',
        ...(opts.serviceAccountName !== undefined && {
          serviceAccountName: opts.serviceAccountName,
        }),
        ...(opts.runtimeClassName !== undefined && {
          runtimeClassName: opts.runtimeClassName,
        }),
        ...(opts.imagePullSecret !== undefined && {
          imagePullSecrets: [{ name: opts.imagePullSecret }],
        }),
        containers: [
          {
            name: 'agent',
            image,
            env,
            // Resources are tunable via Helm values in operator chart;
            // the spec here is a defensible default for v0.1.
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '1000m', memory: '512Mi' },
            },
          },
        ],
      },
    },
  };

  // sandboxProfile: 'strict' will plumb to runtimeClassName: kata in v0.2.
  // We surface the spec field today so consumers can opt in once Kata
  // is on the nodes; operator's Helm values then auto-fill the runtime
  // class.

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: {
        'kagent.knuteson.io/agent': agent.metadata.name ?? '',
        'kagent.knuteson.io/task': task.metadata.name ?? '',
        'kagent.knuteson.io/managed-by': 'kagent-operator',
      },
      // OwnerReference makes the Job a child of the AgentTask — kubectl
      // delete agenttask cleans up the Job (and its Pod) automatically.
      ownerReferences: [
        {
          apiVersion: task.apiVersion,
          kind: task.kind,
          name: task.metadata.name ?? '',
          uid: task.metadata.uid ?? '',
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: podSpec,
  };
}
