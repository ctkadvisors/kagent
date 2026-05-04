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

import type { V1Job, V1PodSecurityContext, V1SecurityContext } from '@kubernetes/client-node';

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
  /**
   * Per-sandbox-profile RuntimeClass mapping. Resolved against
   * `Agent.spec.sandboxProfile` (defaulting to `'default'` when unset).
   *
   * - When the resolved profile maps to a non-empty string → that becomes
   *   `runtimeClassName` on the spawned pod spec.
   * - When the mapping is absent OR maps to an empty string → no
   *   `runtimeClassName` is set (cluster default applies).
   *
   * This is the canonical path for Kata Containers wiring: set
   * `runtimeClasses.strict = 'kata'` once Kata is deployed onto the
   * nodes (see docs/ROADMAP.md Phase 6) and agents that declare
   * `sandboxProfile: 'strict'` will then land on the `kata` runtime
   * while agents on `'default'` (or no profile) keep the cluster default
   * (typically `runc`). Per-Agent — never global.
   */
  readonly runtimeClasses?: Readonly<Record<'default' | 'strict', string>>;
  /**
   * @deprecated Use `runtimeClasses` instead — that map is per-Agent
   * (resolved from `Agent.spec.sandboxProfile`) and is the only correct
   * way to opt INDIVIDUAL agents into Kata. This free-form override
   * applies the same `runtimeClassName` to EVERY pod the operator
   * spawns, which is almost never what you want. Kept as a TS-only
   * test/escape-hatch seam; when both are set, `runtimeClasses` wins.
   */
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
   * Pod-level security context. Defaults (WS-A baseline) to:
   *   { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000,
   *     seccompProfile: { type: 'RuntimeDefault' } }
   * Pass `null` to OMIT the pod security context entirely (escape
   * hatch — only useful for runtimes that reject the field). Pass a
   * partial object to override individual fields; the defaults are
   * not deep-merged.
   */
  readonly podSecurityContext?: V1PodSecurityContext | null;
  /**
   * Container-level security context. Defaults (WS-A baseline) to:
   *   { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] },
   *     readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: 1000 }
   * Pass `null` to OMIT entirely. Note that `readOnlyRootFilesystem:
   * true` requires the agent-pod to write only under writable mounts
   * (e.g., the artifact PVC + the always-present `/tmp` emptyDir).
   */
  readonly containerSecurityContext?: V1SecurityContext | null;
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

/** Default pod security context applied when caller doesn't override. */
export const DEFAULT_POD_SECURITY_CONTEXT: V1PodSecurityContext = {
  runAsNonRoot: true,
  runAsUser: 1000,
  fsGroup: 1000,
  seccompProfile: { type: 'RuntimeDefault' },
};

/** Default container security context. */
export const DEFAULT_CONTAINER_SECURITY_CONTEXT: V1SecurityContext = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  runAsUser: 1000,
};

/** Volume name for the writable /tmp emptyDir mounted under
 * readOnlyRootFilesystem. Exported for tests. */
export const TMP_VOLUME_NAME = 'tmp';

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

  // v0.1.11 — W3C Trace Context propagation. When the parent
  // agent-pod's `spawn_child_task` stamped `runConfig.traceparent`
  // on this AgentTask, surface it as `OTEL_TRACEPARENT` so the
  // spawned agent-pod's main.ts can seed its OtelTraceSink root
  // span context with the parent's span. The string is the literal
  // W3C traceparent header value
  // (`<2hex>-<32hex traceId>-<16hex spanId>-<2hex flags>`) — no
  // re-encoding. The CRD admission schema enforces the shape, so
  // this stage trusts the value verbatim. Absence (root tasks, or
  // any spawned task whose parent didn't have OTel wired) just
  // omits the env var; the child becomes a fresh root trace, the
  // pre-v0.1.11 behavior.
  const traceparentEnv: { name: string; value: string }[] = [];
  const traceparent = task.spec.runConfig?.traceparent;
  if (typeof traceparent === 'string' && traceparent.length > 0) {
    traceparentEnv.push({ name: 'OTEL_TRACEPARENT', value: traceparent });
  }

  const env: { name: string; value: string }[] = [
    { name: 'KAGENT_TASK_ID', value: task.metadata.uid ?? '' },
    { name: 'KAGENT_TASK_NAME', value: task.metadata.name ?? '' },
    { name: 'KAGENT_TASK_NAMESPACE', value: namespace },
    { name: 'KAGENT_AGENT_NAME', value: agent.metadata.name ?? '' },
    { name: 'KAGENT_AGENT_SPEC', value: JSON.stringify(agent.spec) },
    { name: 'KAGENT_TASK_SPEC', value: JSON.stringify(task.spec) },
    ...artifactEnv,
    ...traceparentEnv,
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

  // WS-A — security baseline. Default-deny on the container surface:
  // non-root, no privilege escalation, drop all caps, read-only root
  // FS. Because the root FS is read-only, we mount an emptyDir at /tmp
  // so the agent-pod runtime (and any subprocess it spawns — MCP
  // servers via npx, etc.) can write there.
  const podSecurityContext: V1PodSecurityContext | undefined =
    opts.podSecurityContext === null
      ? undefined
      : (opts.podSecurityContext ?? DEFAULT_POD_SECURITY_CONTEXT);
  const containerSecurityContext: V1SecurityContext | undefined =
    opts.containerSecurityContext === null
      ? undefined
      : (opts.containerSecurityContext ?? DEFAULT_CONTAINER_SECURITY_CONTEXT);
  // /tmp emptyDir is included whenever the container security context
  // sets readOnlyRootFilesystem true (the default). Cheap insurance —
  // adding the volume when not strictly needed has no observable cost.
  const needsTmpVolume = containerSecurityContext?.readOnlyRootFilesystem === true;
  const tmpVolume = needsTmpVolume
    ? { name: TMP_VOLUME_NAME, emptyDir: {} as Record<string, never> }
    : undefined;
  const tmpVolumeMount = needsTmpVolume ? { name: TMP_VOLUME_NAME, mountPath: '/tmp' } : undefined;

  const podVolumes = [artifactVolume, tmpVolume].filter(
    (v): v is NonNullable<typeof v> => v !== undefined,
  );
  const containerVolumeMounts = [artifactVolumeMount, tmpVolumeMount].filter(
    (v): v is NonNullable<typeof v> => v !== undefined,
  );

  // WS-C — RuntimeClass resolution: map-driven (per-Agent) wins over
  // the deprecated free-form `opts.runtimeClassName`. Profile defaults
  // to 'default' when Agent.spec.sandboxProfile is unset, so the
  // absence of a profile never accidentally lands on the 'strict'
  // runtime class. Empty-string entries in the map are treated as
  // "not set" so a partially-populated map (e.g. only strict='kata'
  // set) cleanly omits runtimeClassName for the other profile.
  const profile: 'default' | 'strict' = agent.spec.sandboxProfile ?? 'default';
  const mappedRuntimeClass = opts.runtimeClasses?.[profile];
  const resolvedRuntimeClassName: string | undefined =
    typeof mappedRuntimeClass === 'string' && mappedRuntimeClass.length > 0
      ? mappedRuntimeClass
      : opts.runtimeClassName;

  // Honor the resolved AgentTask wall-clock deadline via
  // Job.spec.activeDeadlineSeconds so K8s itself terminates the pod
  // when the deadline passes — belt-and-suspenders alongside the
  // agent-pod's AbortSignal.timeout. This catches the case where the
  // agent-pod is wedged BEFORE the executor arms its signal (e.g.
  // crashed during boot, hung on K8s API client init), or where the
  // AbortSignal fires but the runtime doesn't honor the cancel for
  // some reason. The Job's failure then surfaces via job-watch.ts →
  // markAgentTaskFailedFromExternal as DeadlineExceeded.
  //
  // WS-G: resolution rule mirrors the agent-pod runner —
  // `runConfig.timeoutSeconds` wins over the deprecated top-level
  // `timeoutSeconds` field when both are present.
  const timeoutSeconds = task.spec.runConfig?.timeoutSeconds ?? task.spec.timeoutSeconds;
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
        ...(resolvedRuntimeClassName !== undefined && {
          runtimeClassName: resolvedRuntimeClassName,
        }),
        ...(opts.imagePullSecret !== undefined && {
          imagePullSecrets: [{ name: opts.imagePullSecret }],
        }),
        ...(podSecurityContext !== undefined && { securityContext: podSecurityContext }),
        ...(podVolumes.length > 0 && { volumes: podVolumes }),
        containers: [
          {
            name: 'agent',
            image,
            env,
            ...(opts.imagePullPolicy !== undefined && {
              imagePullPolicy: opts.imagePullPolicy,
            }),
            ...(containerSecurityContext !== undefined && {
              securityContext: containerSecurityContext,
            }),
            ...(containerVolumeMounts.length > 0 && {
              volumeMounts: containerVolumeMounts,
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

  // sandboxProfile → runtimeClassName resolution happens above via
  // `opts.runtimeClasses[profile]` (Helm values
  // `agentPod.runtimeClasses.{default,strict}` plumb through main.ts).
  // Set `strict: kata` on Helm install once Kata Containers is deployed
  // onto the K3s nodes per docs/ROADMAP.md Phase 6.

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
