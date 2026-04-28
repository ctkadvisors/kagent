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
  /** `imagePullPolicy` for the agent container. Defaults to K8s default
   * (`IfNotPresent`); set `Always` while iterating on a mutable tag. */
  readonly imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
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
  /**
   * Artifact PVC plumbing — Phase 5 / P3. When set, the operator mounts
   * the named PVC at `mountPath` in the agent container and injects
   * `KAGENT_ARTIFACTS_DIR=<mountPath>` + `KAGENT_ARTIFACT_PVC_NAME=<claimName>`
   * env vars so the in-pod `write_artifact` tool can write under the
   * task-uid subdirectory. When unset, no PVC plumbing is added — the
   * agent-pod can still spawn but `write_artifact` will fail at boot
   * because `KAGENT_ARTIFACT_PVC_NAME` is absent.
   *
   * Cluster operators set the PVC via Helm
   * (`agentPod.artifactStorage.{enabled,pvcName,mountPath}`); the
   * operator's main.ts forwards those into `BuildJobSpecOptions`.
   */
  readonly artifactPvc?: {
    /** PVC claim name in the AgentTask's namespace. */
    readonly claimName: string;
    /** Container path the PVC mounts at. Defaults to `/var/kagent/artifacts`. */
    readonly mountPath?: string;
  };
  /**
   * Create the Job in suspended state (`spec.suspend: true`). Used by
   * the WS-F suspended-publish dispatch path so the operator can publish
   * the dispatch envelope to the bus BEFORE K8s schedules the pod —
   * preventing the orphan-on-publish-failure case where the agent-pod
   * would boot without ever seeing its task assignment.
   *
   * Default `false` (job runs immediately on create) for backward
   * compatibility with callers / tests that don't opt into the
   * publish-then-unsuspend ordering.
   */
  readonly suspend?: boolean;
}

/** Default mount path for the artifact PVC inside the agent-pod. */
export const DEFAULT_ARTIFACT_MOUNT_PATH = '/var/kagent/artifacts';

/** Volume name used for the artifact PVC in the spawned pod spec. */
export const ARTIFACT_VOLUME_NAME = 'artifacts';

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

  // Artifact PVC plumbing: when supplied, inject the env vars the
  // in-pod `write_artifact` tool reads + add a matching volume mount
  // below. Done here (rather than at the writer level) so the agent-pod
  // image stays unaware of K8s primitives.
  const artifactEnv: { name: string; value: string }[] = [];
  if (opts.artifactPvc !== undefined) {
    const mountPath = opts.artifactPvc.mountPath ?? DEFAULT_ARTIFACT_MOUNT_PATH;
    artifactEnv.push(
      { name: 'KAGENT_ARTIFACTS_DIR', value: mountPath },
      { name: 'KAGENT_ARTIFACT_PVC_NAME', value: opts.artifactPvc.claimName },
    );
  }

  const env: { name: string; value: string }[] = [
    { name: 'KAGENT_TASK_ID', value: task.metadata.uid ?? '' },
    { name: 'KAGENT_TASK_NAME', value: task.metadata.name ?? '' },
    { name: 'KAGENT_TASK_NAMESPACE', value: namespace },
    { name: 'KAGENT_AGENT_NAME', value: agent.metadata.name ?? '' },
    { name: 'KAGENT_AGENT_SPEC', value: JSON.stringify(agent.spec) },
    { name: 'KAGENT_TASK_SPEC', value: JSON.stringify(task.spec) },
    ...artifactEnv,
    ...(opts.extraEnv ?? []).map((e) => ({ name: e.name, value: e.value })),
  ];

  // Volume + volumeMount for the artifact PVC. Volume lives at the
  // pod level; the mount lives on the agent container only (no
  // sidecars in v0.1).
  const artifactVolume =
    opts.artifactPvc !== undefined
      ? {
          name: ARTIFACT_VOLUME_NAME,
          persistentVolumeClaim: { claimName: opts.artifactPvc.claimName },
        }
      : undefined;
  const artifactVolumeMount =
    opts.artifactPvc !== undefined
      ? {
          name: ARTIFACT_VOLUME_NAME,
          mountPath: opts.artifactPvc.mountPath ?? DEFAULT_ARTIFACT_MOUNT_PATH,
        }
      : undefined;

  // Honor AgentTask.spec.timeoutSeconds via Job.spec.activeDeadlineSeconds
  // so K8s itself terminates the pod when the deadline passes — belt-
  // and-suspenders alongside the agent-pod's AbortSignal.timeout. This
  // catches the case where the agent-pod is wedged BEFORE the executor
  // arms its signal (e.g. crashed during boot, hung on K8s API client
  // init), or where the AbortSignal fires but the runtime doesn't honor
  // the cancel for some reason. The Job's failure then surfaces via
  // job-watch.ts → markAgentTaskFailedFromExternal as DeadlineExceeded.
  const timeoutSeconds = task.spec.timeoutSeconds;
  const activeDeadlineSeconds =
    typeof timeoutSeconds === 'number' && timeoutSeconds > 0 ? timeoutSeconds : undefined;

  const podSpec: V1Job['spec'] = {
    backoffLimit: DEFAULT_BACKOFF_LIMIT,
    ttlSecondsAfterFinished: DEFAULT_TTL_SECONDS_AFTER_FINISHED,
    ...(activeDeadlineSeconds !== undefined && { activeDeadlineSeconds }),
    // WS-F: opt-in suspended creation. When set, K8s won't schedule the
    // pod until reconcile.ts publishes the dispatch envelope and patches
    // the Job to `spec.suspend: false`. This makes the publish step the
    // ordering dependency rather than the Job-create step.
    ...(opts.suspend === true && { suspend: true }),
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
        ...(artifactVolume !== undefined && { volumes: [artifactVolume] }),
        containers: [
          {
            name: 'agent',
            image,
            env,
            ...(opts.imagePullPolicy !== undefined && {
              imagePullPolicy: opts.imagePullPolicy,
            }),
            ...(artifactVolumeMount !== undefined && {
              volumeMounts: [artifactVolumeMount],
            }),
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
