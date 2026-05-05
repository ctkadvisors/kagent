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

import type {
  V1ConfigMap,
  V1Job,
  V1PodSecurityContext,
  V1SecurityContext,
  V1Volume,
  V1VolumeMount,
} from '@kubernetes/client-node';

import * as cacheController from '@kagent/cache-controller';

import type { Agent, AgentTask, InputDecl } from './crds/index.js';
import { isFromWorkspace } from './crds/agent-task.js';

const DEFAULT_IMAGE = 'ghcr.io/ctkadvisors/kagent-agent-pod:v0.0.1-phase2-stub';

/* =====================================================================
 * v0.2.0-typed-io — ConfigMap-projected agent + task spec.
 *
 * Phase 4.x flagged two problems with the env-string transport:
 *
 *   1. ARG_MAX cap. Linux pid_max (Ubuntu 22.04: ~6 MiB) is hard
 *      ceiling; the rendered Job's env array also lands in etcd's
 *      1 MiB per-object limit; large agent specs (toolAllowlists,
 *      systemPrompts, llmParams) push us toward those bounds.
 *
 *   2. `kubectl describe pod` / `/proc/<pid>/environ` leak. Every
 *      env var on the Pod is observable to anyone with read RBAC on
 *      pods AND to anything running as the same UID inside the
 *      container. A multi-line system prompt baked into the env
 *      lands verbatim in `kubectl get pod -o yaml`.
 *
 * v0.2.0 mounts a per-Job ConfigMap at `/var/kagent/config/` carrying
 *   - agent.spec.json
 *   - task.spec.json
 *
 * The agent-pod's `parseEnv` reads those files when present and falls
 * back to the env-JSON path for one release (back-compat with rollout
 * where operator + agent-pod images don't ship in lockstep).
 *
 * Mount path is fixed (`/var/kagent/config/`) — admission depends on
 * the agent-pod knowing the path without an env lookup. The operator
 * still emits `KAGENT_AGENT_MODEL` env so the admission reconciler's
 * model-extraction stays trivial (no ConfigMap read in the hot path).
 * ===================================================================== */

export const CONFIG_MOUNT_PATH = '/var/kagent/config';
export const CONFIG_VOLUME_NAME = 'kagent-config';
export const CONFIG_AGENT_SPEC_KEY = 'agent.spec.json';
export const CONFIG_TASK_SPEC_KEY = 'task.spec.json';

/**
 * Deterministic ConfigMap name for an AgentTask. Same uid-derivation
 * pattern as `jobNameForTask`, with a `kac-` prefix so kubectl users
 * can `get configmap kac-<uid-prefix>` alongside `get job kat-...`.
 */
export function configMapNameForTask(task: AgentTask): string {
  const uid = task.metadata.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new Error('AgentTask is missing metadata.uid — cannot derive ConfigMap name');
  }
  return `kac-${uid.slice(0, 50)}`;
}

/**
 * Build the per-Job ConfigMap carrying `agent.spec.json` +
 * `task.spec.json`. OwnerReferences point at the AgentTask so
 * cascading delete reaps the ConfigMap when the task is deleted.
 *
 * v0.2.0 — replaces the `KAGENT_AGENT_SPEC` + `KAGENT_TASK_SPEC` env
 * transport. See `buildJobSpec` for the corresponding mount.
 */
export function buildAgentTaskConfigMap(agent: Agent, task: AgentTask): V1ConfigMap {
  const namespace = task.metadata.namespace ?? 'default';
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapNameForTask(task),
      namespace,
      labels: {
        'kagent.knuteson.io/agent': agent.metadata.name ?? '',
        'kagent.knuteson.io/task': task.metadata.name ?? '',
        'kagent.knuteson.io/managed-by': 'kagent-operator',
      },
      // OwnerRef → AgentTask so cascading delete reaps the ConfigMap.
      // The Job already has its own ownerRef on the same AgentTask;
      // both get cleaned up on task deletion.
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
    data: {
      [CONFIG_AGENT_SPEC_KEY]: JSON.stringify(agent.spec),
      [CONFIG_TASK_SPEC_KEY]: JSON.stringify(task.spec),
    },
  };
}

/**
 * Job-controller `backoffLimit`. Pinned at 0 — the operator owns retry
 * policy + the agent-pod owns idempotency on its single trip through
 * the LLM loop. Allowing the kubelet to retry would silently re-spawn
 * a fresh agent-pod with the same task UID after the first failure
 * and re-issue all of the run's side effects (LLM calls, child spawns,
 * write_artifact). v0.1.9 — exported (was internal) so tests pin the
 * constant against accidental bumps.
 */
export const DEFAULT_BACKOFF_LIMIT = 0;

/**
 * Job-controller `ttlSecondsAfterFinished`. v0.1.9 reduced from 3600
 * → 300: 1h was a debug convenience; 5 minutes lets completed/failed
 * Jobs (and their Pods) age out fast under bursty workloads. Helm
 * consumers that want longer post-mortem retention override via
 * BuildJobSpecOptions plumbing on the operator chart.
 */
export const DEFAULT_TTL_SECONDS_AFTER_FINISHED = 300;

/**
 * AgentTask label whose value carries the task's depth in the spawn
 * tree. Root tasks have no label (depth = 0). Children get
 * `<parent-depth + 1>` stamped on by the agent-pod's K8sTaskCreator
 * at child-create time, and the operator reads it here when building
 * the Job env so the in-pod runtime can return depth via
 * `get_my_context()` and gate further spawns at the cluster cap.
 * v0.1.9 — see docs/SUBSTRATE-V1.md §6 (audit gap "Tree depth unbounded").
 */
export const TASK_DEPTH_LABEL = 'kagent.knuteson.io/task-depth';

/**
 * v0.4.1-blackboard — Wave 3 / Blackboard sub-team.
 *
 * AgentTask label whose value carries the *root* task UID. Root
 * tasks themselves carry no label; the job-spec falls back to
 * `task.metadata.uid` when the label is absent. Children get the
 * parent's resolved root-uid stamped on by K8sTaskCreator at child-
 * create time so a deep spawn tree shares ONE bucket across every
 * descendant. Read by `buildJobSpec` to emit
 * `KAGENT_BLACKBOARD_BUCKET=kagent-kv-<root-uid>` on every spawned
 * pod's env. Per-task-tree NATS KV bucket lifecycle lives in
 * `blackboard-router.ts` + `@kagent/blackboard`.
 */
export const ROOT_TASK_UID_LABEL = 'kagent.knuteson.io/root-task-uid';

/**
 * Single env-var entry on a spawned Job. Either an inline plaintext
 * value or a `valueFrom.secretKeyRef` pointing at an existing Secret in
 * the AgentTask's namespace.
 *
 * The two shapes are mutually exclusive at the type level — pick one.
 * `buildJobSpec` forwards each entry verbatim into the rendered Job's
 * env array (no shape coercion). The secret-ref shape is the v0.1.8
 * secret-hygiene contract: any name matching `/KEY|SECRET/i` MUST be
 * supplied via `valueFrom.secretKeyRef` so the plaintext never lives in
 * the operator's memory or in the Job's etcd object. See
 * `docs/WAVES.md` §2.1 + the unit test
 * `buildJobSpec > emits ZERO inline value: entries for ...` which fails
 * the build on any inline `value:` for a sensitive name.
 */
export type EnvVarSpec =
  | { readonly name: string; readonly value: string; readonly valueFrom?: never }
  | {
      readonly name: string;
      readonly value?: never;
      readonly valueFrom: {
        readonly secretKeyRef: {
          readonly name: string;
          readonly key: string;
        };
      };
    };

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
   *
   * v0.1.8 — secret-hygiene: each entry is EITHER an inline
   * `{ name, value }` (plaintext, fine for non-sensitive config) OR a
   * `{ name, valueFrom: { secretKeyRef: { name, key } } }` (preferred
   * for any name matching `/KEY|SECRET/i`). The secretRef shape is
   * forwarded verbatim into the spawned-Job's `env[i].valueFrom`, so
   * the plaintext never lives in the operator's memory or in the
   * Job's etcd object — `kubectl describe pod` and `/proc/<pid>/environ`
   * surface the resolved value only at runtime, never in the rendered
   * Job spec. See `EnvVarSpec` above + the unit test that locks the
   * shape.
   */
  readonly extraEnv?: readonly EnvVarSpec[];
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
    /**
     * v0.1 P3 wire-up — per-write byte cap forwarded as
     * `KAGENT_ARTIFACT_MAX_BYTES` on the spawned Job's env. The agent-
     * pod's `write_artifact` tool refuses any write whose UTF-8 /
     * decoded-base64 length exceeds this value. Optional — when unset,
     * the agent-pod falls back to its compiled-in default (25 MiB).
     * Helm value: `agentPod.artifactStorage.maxBytes`.
     */
    readonly maxBytes?: number;
  };
  /**
   * v0.3.0-capabilities — per-task capability JWT Secret mounted into
   * the agent-pod. The reconciler owns minting + Secret creation; the
   * Job spec only renders the read-only Secret volume plus the env
   * paths the agent-pod cap consumer needs.
   */
  readonly capabilityJwt?: {
    /** Secret name in the AgentTask namespace. */
    readonly secretName: string;
    /** JWT file path exposed to the agent-pod. */
    readonly filePath?: string;
    /** Operator JWKS URL used by the agent-pod verifier. */
    readonly jwksUrl?: string;
    /** Expected JWT issuer used by the agent-pod verifier. */
    readonly issuer?: string;
  };
  /**
   * v0.4.2-cache — Wave 3 / Cache sub-team. Per-Agent persistent cache
   * plumbing. When set + the Agent declares `Agent.spec.caches[]`,
   * `buildJobSpec` calls {@link buildCacheMounts} internally to derive
   * keys, probe the cache PVC for hits, and splice an init-container
   * (cache restore) + per-slot emptyDir mounts onto the rendered Pod.
   *
   * The caller is responsible for:
   *   - emitting `cache.hit` / `cache.miss` audit events from the
   *     returned `BuildJobSpecResult.cacheSlots[]` (NOT yet exposed
   *     in v0.4.2; tracked in WAVES.md follow-up — for now, use the
   *     standalone `buildCacheMounts` helper if you need the slots).
   *   - resolving the `imageDigest` + `inputArtifactHashes` (the
   *     reconciler walks the AgentTask informer for upstream artifact
   *     refs).
   *
   * When unset OR when the Agent declares no caches, NO cache plumbing
   * is added — the field is additive, never invasive.
   */
  readonly cache?: {
    /** Cache PVC claim name. Same PVC the operator pod mounts. */
    readonly pvcName: string;
    /** Cache PVC mount path on the OPERATOR pod (NOT the agent-pod). */
    readonly cachePvcMountOnOperator: string;
    /** Disk probe — defaults to `existsSync` in main.ts plumbing. */
    readonly existsOnDisk: (absolutePath: string) => boolean;
    /** Resolved image digest the operator stamps onto cache key derivation. */
    readonly imageDigest: string;
    /** sha256-hex hashes of every kind:'artifact' input bound on the task. */
    readonly inputArtifactHashes: readonly string[];
    /** Optional helper-image override (busybox by default). */
    readonly helperImage?: string;
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
  /**
   * v0.2.0-typed-io — opt-out of the ConfigMap projection. Default
   * `true` (i.e. mount ConfigMap, drop the JSON env). Pass `false`
   * to keep the v0.1 env-JSON path (tests, mid-rollout where the
   * agent-pod image hasn't been updated yet — its `parseEnv` falls
   * back to env JSON when the mounted files are absent).
   *
   * The ConfigMap itself is owned + created by the reconciler
   * BEFORE the Job (see `buildAgentTaskConfigMap`); buildJobSpec
   * just renders the volume + volumeMount that points at it.
   */
  readonly useConfigMap?: boolean;
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

/** Default path for the operator-minted per-task capability JWT. */
export const DEFAULT_CAP_JWT_FILE = '/var/kagent/cap/cap.jwt';

/** Secret data key used inside per-task capability JWT Secrets. */
export const CAP_JWT_SECRET_KEY = 'cap.jwt';

/** Volume name used for the per-task capability JWT Secret. */
export const CAP_JWT_VOLUME_NAME = 'cap-jwt';

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
  //
  // v0.1 P3 wire-up — `KAGENT_ARTIFACT_MAX_BYTES` is forwarded when
  // `artifactPvc.maxBytes` is set (Helm value
  // `agentPod.artifactStorage.maxBytes`). When unset, the agent-pod
  // falls back to its compiled-in default (25 MiB).
  const artifactEnv: { name: string; value: string }[] = [];
  if (opts.artifactPvc !== undefined) {
    const mountPath = opts.artifactPvc.mountPath ?? DEFAULT_ARTIFACT_MOUNT_PATH;
    artifactEnv.push(
      { name: 'KAGENT_ARTIFACTS_DIR', value: mountPath },
      { name: 'KAGENT_ARTIFACT_PVC_NAME', value: opts.artifactPvc.claimName },
    );
    if (
      typeof opts.artifactPvc.maxBytes === 'number' &&
      Number.isFinite(opts.artifactPvc.maxBytes) &&
      opts.artifactPvc.maxBytes > 0
    ) {
      artifactEnv.push({
        name: 'KAGENT_ARTIFACT_MAX_BYTES',
        value: String(Math.floor(opts.artifactPvc.maxBytes)),
      });
    }
  }

  // v0.1.11 — W3C Trace Context propagation. When the parent
  // agent-pod's `spawn_child_task` stamped `runConfig.traceparent`
  // on this AgentTask, surface it as `OTEL_TRACEPARENT` so the
  // spawned agent-pod's main.ts can seed its OtelTraceSink root
  // span context with the parent's span. The CRD admission schema
  // enforces the shape, so this stage trusts the value verbatim.
  const traceparentEnv: { name: string; value: string }[] = [];
  const traceparent = task.spec.runConfig?.traceparent;
  if (typeof traceparent === 'string' && traceparent.length > 0) {
    traceparentEnv.push({ name: 'OTEL_TRACEPARENT', value: traceparent });
  }

  // v0.1.9 — task-depth threading. Read off the task's own
  // `kagent.knuteson.io/task-depth` label (default 0). The
  // K8sTaskCreator stamps `<parent-depth + 1>` on each child; the
  // operator's admission path uses the same label to enforce the cap
  // before un-suspending the Job. Forwarded as KAGENT_TASK_DEPTH for
  // in-pod `get_my_context()` and the spawn-tool cap check.
  const taskDepth = parseTaskDepthLabel(task.metadata.labels?.[TASK_DEPTH_LABEL]);

  // v0.4.1-blackboard — Wave 3 / Blackboard sub-team.
  // Per-task-tree NATS KV bucket env. The bucket is named
  // `kagent-kv-<root-uid>` where root-uid is read from the
  // `ROOT_TASK_UID_LABEL` (stamped by K8sTaskCreator on every spawned
  // child) OR `task.metadata.uid` itself for root tasks. Empty string
  // when no UID is available (defensive — pre-K8s-persist task can't
  // have a bucket; the agent-pod's main.ts main-loop sees an empty
  // `KAGENT_BLACKBOARD_BUCKET` and skips registering blackboard tools).
  const labeledRootUid = task.metadata.labels?.[ROOT_TASK_UID_LABEL];
  const ownUid = task.metadata.uid;
  const blackboardRootUid =
    typeof labeledRootUid === 'string' && labeledRootUid.length > 0
      ? labeledRootUid
      : typeof ownUid === 'string' && ownUid.length > 0
        ? ownUid
        : undefined;
  const blackboardEnv: { name: string; value: string }[] =
    blackboardRootUid !== undefined
      ? [{ name: 'KAGENT_BLACKBOARD_BUCKET', value: `kagent-kv-${blackboardRootUid}` }]
      : [];

  // v0.1.8 — secret-hygiene. Each env entry is one of:
  //   - inline plaintext: { name, value }
  //   - secret-ref:       { name, valueFrom: { secretKeyRef: { name, key } } }
  // The two shapes are deliberately mixed here so the secret-ref entries
  // forwarded by the operator's main.ts pass through to the rendered Job
  // spec verbatim, never coerced back into a plaintext value:.
  type RenderedEnv =
    | { readonly name: string; readonly value: string }
    | {
        readonly name: string;
        readonly valueFrom: {
          readonly secretKeyRef: { readonly name: string; readonly key: string };
        };
      };
  // v0.2.0-typed-io — ConfigMap projection.
  // When `opts.useConfigMap !== false`, agent.spec.json + task.spec.json
  // are mounted at /var/kagent/config/ via the per-Job ConfigMap (see
  // `buildAgentTaskConfigMap`). The full-JSON env vars are dropped to
  // close the ARG_MAX cap and the `ps`-visible-env leak (Phase 4.x
  // hardening surface). KAGENT_AGENT_MODEL stays as a tiny env var so
  // the admission reconciler's model-extraction stays trivial (no
  // ConfigMap read in the hot path).
  // Default: ON. Tests / older operators can pass useConfigMap: false
  // for one release of back-compat (the agent-pod's parseEnv keeps the
  // env-JSON fallback path).
  const useConfigMap = opts.useConfigMap !== false;

  const env: RenderedEnv[] = [
    { name: 'KAGENT_TASK_ID', value: task.metadata.uid ?? '' },
    { name: 'KAGENT_TASK_NAME', value: task.metadata.name ?? '' },
    { name: 'KAGENT_TASK_NAMESPACE', value: namespace },
    { name: 'KAGENT_AGENT_NAME', value: agent.metadata.name ?? '' },
    // Always emit the model as a tiny env var — admission consults
    // this without reading the ConfigMap (hot path).
    { name: 'KAGENT_AGENT_MODEL', value: agent.spec.model },
    // Back-compat path: when useConfigMap is explicitly false (tests +
    // pre-v0.2.0 agent-pod images), the full JSON env entries stay.
    ...(useConfigMap
      ? []
      : [
          { name: 'KAGENT_AGENT_SPEC', value: JSON.stringify(agent.spec) },
          { name: 'KAGENT_TASK_SPEC', value: JSON.stringify(task.spec) },
        ]),
    { name: 'KAGENT_TASK_DEPTH', value: String(taskDepth) },
    ...(opts.capabilityJwt !== undefined
      ? [
          {
            name: 'KAGENT_CAP_JWT_FILE',
            value: opts.capabilityJwt.filePath ?? DEFAULT_CAP_JWT_FILE,
          },
          ...(opts.capabilityJwt.jwksUrl !== undefined
            ? [{ name: 'KAGENT_CAP_JWKS_URL', value: opts.capabilityJwt.jwksUrl }]
            : []),
          ...(opts.capabilityJwt.issuer !== undefined
            ? [{ name: 'KAGENT_CAP_ISSUER', value: opts.capabilityJwt.issuer }]
            : []),
        ]
      : []),
    ...artifactEnv,
    ...traceparentEnv,
    ...blackboardEnv,
    ...(opts.extraEnv ?? []).map((e): RenderedEnv => {
      // Discriminate by presence of valueFrom. The EnvVarSpec union
      // makes the two arms mutually exclusive; we forward the
      // secretKeyRef object verbatim — no copy / no coerce — so a
      // future addition to the K8s `valueFrom` schema (configMapKeyRef,
      // fieldRef) is a one-line union extension above and a one-line
      // arm extension here.
      if ('valueFrom' in e && e.valueFrom !== undefined) {
        return {
          name: e.name,
          valueFrom: {
            secretKeyRef: {
              name: e.valueFrom.secretKeyRef.name,
              key: e.valueFrom.secretKeyRef.key,
            },
          },
        };
      }
      return { name: e.name, value: e.value };
    }),
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

  // v0.2.0-typed-io — ConfigMap volume + mount for agent.spec.json +
  // task.spec.json. The reconciler creates the ConfigMap BEFORE the
  // Job (idempotent on AlreadyExists); we just render the volume here.
  // mode 0444 keeps the mount read-only (defense in depth — the
  // agent-pod has no business mutating these).
  const configVolume = useConfigMap
    ? {
        name: CONFIG_VOLUME_NAME,
        configMap: {
          name: configMapNameForTask(task),
          defaultMode: 0o444,
          items: [
            { key: CONFIG_AGENT_SPEC_KEY, path: CONFIG_AGENT_SPEC_KEY },
            { key: CONFIG_TASK_SPEC_KEY, path: CONFIG_TASK_SPEC_KEY },
          ],
        },
      }
    : undefined;
  const configVolumeMount = useConfigMap
    ? {
        name: CONFIG_VOLUME_NAME,
        mountPath: CONFIG_MOUNT_PATH,
        readOnly: true,
      }
    : undefined;

  const capJwtFilePath = opts.capabilityJwt?.filePath ?? DEFAULT_CAP_JWT_FILE;
  const capJwtMountPath = capJwtFilePath.slice(0, capJwtFilePath.lastIndexOf('/'));
  const capJwtFileName = capJwtFilePath.slice(capJwtFilePath.lastIndexOf('/') + 1);
  const capJwtVolume =
    opts.capabilityJwt !== undefined
      ? {
          name: CAP_JWT_VOLUME_NAME,
          secret: {
            secretName: opts.capabilityJwt.secretName,
            items: [{ key: CAP_JWT_SECRET_KEY, path: capJwtFileName }],
          },
        }
      : undefined;
  const capJwtVolumeMount =
    opts.capabilityJwt !== undefined
      ? {
          name: CAP_JWT_VOLUME_NAME,
          mountPath: capJwtMountPath,
          readOnly: true,
        }
      : undefined;

  const podVolumes: V1Volume[] = [artifactVolume, tmpVolume, configVolume, capJwtVolume].filter(
    (v): v is NonNullable<typeof v> => v !== undefined,
  );
  const containerVolumeMounts: V1VolumeMount[] = [
    artifactVolumeMount,
    tmpVolumeMount,
    configVolumeMount,
    capJwtVolumeMount,
  ].filter((v): v is NonNullable<typeof v> => v !== undefined);

  // v0.4.2-cache — Wave 3 / Cache sub-team. When the operator threads
  // a `cache:` block (Helm `cache.enabled: true`), call the
  // `buildCacheMounts` helper to derive cache keys + probe the cache
  // PVC. Splice the result onto the rendered Pod spec:
  //   - per-slot emptyDirs (always emitted, hit OR miss)
  //   - one read-only PVC mount + one init-container (only when ≥1 hit)
  // Returned `cacheResult.perSlot` is intentionally NOT surfaced from
  // `buildJobSpec` itself — callers that need audit emission should
  // call `buildCacheMounts` directly. The reconciler's plumbing in
  // main.ts emits the audit events from a separate helper call.
  let cacheInitContainers: import('@kubernetes/client-node').V1Container[] = [];
  if (opts.cache !== undefined && (agent.spec.caches?.length ?? 0) > 0) {
    const cacheResult = buildCacheMounts({
      agent,
      task,
      pvcName: opts.cache.pvcName,
      cachePvcMountOnOperator: opts.cache.cachePvcMountOnOperator,
      existsOnDisk: opts.cache.existsOnDisk,
      imageDigest: opts.cache.imageDigest,
      inputArtifactHashes: opts.cache.inputArtifactHashes,
      ...(opts.cache.helperImage !== undefined && { helperImage: opts.cache.helperImage }),
    });
    podVolumes.push(...cacheResult.volumes);
    containerVolumeMounts.push(...cacheResult.volumeMounts);
    cacheInitContainers = [...cacheResult.initContainers];
  }

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
        ...(cacheInitContainers.length > 0 && { initContainers: cacheInitContainers }),
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

/**
 * Parse the value of an AgentTask's `kagent.knuteson.io/task-depth`
 * label into a non-negative integer, defaulting to 0 on any failure.
 * Defensive: a hostile / malformed label cannot make us stamp a
 * negative or NaN depth into the agent-pod env (which would break the
 * admission depth-cap math). Exported for the unit-test suite.
 */
export function parseTaskDepthLabel(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return n;
}

/* =====================================================================
 * v0.2.1-workspaces — Wave 1 / Workspace sub-team.
 *
 * `buildWorkspaceMounts` translates an Agent's declared workspace
 * inputs (`Agent.spec.inputs[]` with `kind: 'workspace'`) plus the
 * AgentTask's matching `inputs[].from.workspace` bindings into the
 * volumes + volumeMounts that go onto the spawned Job pod.
 *
 * Distinct from `buildArtifactMounts` (CAS sub-team v0.2.2) — that
 * helper resolves `kind: 'artifact'` inputs against content-addressed
 * URIs. Both helpers share a job-spec but never share a volume name
 * (`kws-<sanitized-name>` vs. CAS's own prefix). Coordination per
 * docs/WAVES.md §3.4: additive, no-conflict.
 *
 * Mount-path discipline (per Agent typed-I/O contract): every workspace
 * input MUST declare `mountPath`. Admission rejects missing mountPath at
 * Agent admission time, so this helper's contract is "given a valid
 * Agent spec, never invent a path"; if a binding shows up here without
 * a mountPath, we skip it silently — the upstream contract violation
 * surfaces elsewhere.
 *
 * Read-only enforcement (`mode: 'ro'`): forwarded as `readOnly: true`
 * on the volumeMount. The kernel enforces it; the agent-pod has no
 * way around the bind-mount flag from inside the container.
 * ===================================================================== */

/**
 * Volume-name prefix the operator stamps on the Pod spec for every
 * Workspace volumeMount. Distinct from CAS's prefix to avoid name
 * collisions when both sub-systems mount inputs onto the same Pod.
 * K8s volume names: `[a-z0-9]([-a-z0-9]*[a-z0-9])?`, ≤63 chars; the
 * helper sanitizes the binding name into that grammar.
 */
export const WORKSPACE_VOLUME_PREFIX = 'kws-';

/**
 * Sanitize a binding name into the K8s volume-name grammar. Replaces
 * any non-`[a-z0-9-]` rune with `-`, lowercases, and truncates to keep
 * the prefixed name ≤63 chars (K8s DNS-1123 label).
 *
 * Defensive: the InputDecl name has already passed the CRD schema
 * (a-zA-Z0-9-_), but volumes use a stricter grammar — uppercase + `_`
 * are illegal. A round-trip through this function is idempotent for
 * names that already match.
 */
function sanitizeVolumeName(raw: string): string {
  // Replace runs of non-conforming chars with '-', lowercase, and drop
  // leading/trailing hyphens (volume names must start + end with
  // [a-z0-9]).
  const lower = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = lower.replace(/^-+|-+$/g, '');
  // Reserve the prefix length when truncating.
  const max = 63 - WORKSPACE_VOLUME_PREFIX.length;
  return trimmed.slice(0, max);
}

/**
 * Result of `buildWorkspaceMounts` — a flat pair of arrays the caller
 * splices onto the rendered Pod's `volumes` + container's
 * `volumeMounts`. Empty arrays are valid output (Agent declares no
 * workspace inputs, or the AgentTask binds none of them — both legal).
 *
 * Returned shapes match `@kubernetes/client-node`'s `V1Volume` /
 * `V1VolumeMount` so a caller can pass them through verbatim.
 */
export interface WorkspaceMountResult {
  readonly volumes: readonly V1Volume[];
  readonly volumeMounts: readonly V1VolumeMount[];
}

export interface BuildWorkspaceMountsInput {
  /** Agent declaring `inputs[]`. */
  readonly agent: Agent;
  /** AgentTask supplying bindings for those inputs. */
  readonly task: AgentTask;
  /**
   * Resolver: given a Workspace name, return the bound PVC's claim
   * name. The Workspace controller materializes PVCs 1:1 with
   * Workspaces in v0.2.1 (`status.pvcName` always equals the
   * Workspace's own metadata.name) — but threading the resolver here
   * keeps the helper testable without an informer cache and lets v0.3
   * Workspace controllers diverge from the 1:1 mapping if needed.
   *
   * Returns `undefined` when the workspace doesn't exist or hasn't
   * bound a PVC yet — the helper SKIPS that mount rather than
   * fabricating one. Admission catches "workspace not Ready" earlier
   * (validateWorkspaceBindings, follow-up commit); this helper is the
   * last line of defense.
   */
  readonly resolveWorkspacePvcName: (workspaceName: string) => string | undefined;
}

/**
 * Build volumes + volumeMounts for the Workspace inputs an AgentTask
 * binds. Iterates the Agent's declared inputs (only those with
 * `kind: 'workspace'`), looks up each binding on the task, and emits
 * one `{ volume, volumeMount }` pair per resolved binding.
 *
 * The function is deliberately stateless — caller controls when it
 * runs. The reconciler invokes it from the Job-build path (after
 * validating Workspace.status.ready === true on each referenced
 * Workspace).
 */
export function buildWorkspaceMounts(input: BuildWorkspaceMountsInput): WorkspaceMountResult {
  const { agent, task, resolveWorkspacePvcName } = input;
  const volumes: V1Volume[] = [];
  const volumeMounts: V1VolumeMount[] = [];

  const declaredInputs: readonly InputDecl[] = agent.spec.inputs ?? [];
  const bindings = task.spec.inputs ?? [];
  if (declaredInputs.length === 0 || bindings.length === 0) {
    return { volumes, volumeMounts };
  }

  // Index bindings by name for O(1) lookup as we walk the Agent's decls.
  const bindingByName = new Map(bindings.map((b) => [b.name, b]));

  for (const decl of declaredInputs) {
    if (decl.kind !== 'workspace') continue;
    if (typeof decl.mountPath !== 'string' || decl.mountPath.length === 0) continue;
    const binding = bindingByName.get(decl.name);
    if (binding === undefined) continue;
    if (!isFromWorkspace(binding.from)) continue;
    const wsName = binding.from.workspace;
    if (typeof wsName !== 'string' || wsName.length === 0) continue;
    const claimName = resolveWorkspacePvcName(wsName);
    if (claimName === undefined || claimName.length === 0) continue;

    const volumeName = `${WORKSPACE_VOLUME_PREFIX}${sanitizeVolumeName(decl.name)}`;
    const readOnly = decl.mode !== 'rw'; // default 'ro' when unset
    volumes.push({
      name: volumeName,
      persistentVolumeClaim: { claimName, ...(readOnly && { readOnly: true }) },
    });
    volumeMounts.push({
      name: volumeName,
      mountPath: decl.mountPath,
      readOnly,
    });
  }

  return { volumes, volumeMounts };
}

/* =====================================================================
 * Wave 1 — CAS artifact mount helper (v0.2.2-cas).
 *
 * Distinct from the Workspace sub-team's `buildWorkspaceMounts` (which
 * lives on the parallel feat/wave1-workspaces branch) — additive only,
 * no shared state. The two helpers are merged independently into main;
 * neither writes into the other's volume / mount namespace.
 *
 * `buildArtifactMounts(opts)` translates an Agent's `spec.inputs[]` of
 * `kind: 'artifact'` into the (volume, volumeMounts) pair the operator
 * appends to a spawned Job's pod spec. The shared CAS PVC is mounted
 * read-only at `/var/kagent/cas/` (the agent-pod's `read_artifact`
 * tool resolves `cas://` URIs against the same prefix). The mount is
 * read-only because writes go through the in-pod CAS backend (which
 * resolves the actual on-disk shard path from sha256 of the bytes), and
 * because read-only RWX mounts let many agent-pods share the volume
 * without any per-task fencing.
 *
 * The helper returns empty arrays when the Agent declares no artifact
 * inputs OR when CAS Helm values are disabled — additive, never invasive.
 * ===================================================================== */

/** Default mount path the CAS PVC lands at inside every agent-pod. */
export const DEFAULT_CAS_MOUNT_PATH = '/var/kagent/cas';

/** Volume name used for the CAS PVC in spawned pod specs. */
export const CAS_VOLUME_NAME = 'kagent-cas';

/**
 * Inputs the operator passes to `buildArtifactMounts`. Mirrors the
 * Helm-time `cas:` block — `pvcName` + `mountPath` come from operator
 * env (KAGENT_CAS_PVC_NAME / KAGENT_CAS_MOUNT_PATH); `agent` is the
 * resolved CR the reconciler is materializing.
 */
export interface BuildArtifactMountsOptions {
  /** PVC claim name in the AgentTask's namespace (e.g. `kagent-cas`). */
  readonly pvcName: string;
  /** Container path the PVC mounts at. Defaults to `/var/kagent/cas`. */
  readonly mountPath?: string;
  /**
   * Resolved Agent for this AgentTask. The helper inspects
   * `spec.inputs[]` to decide whether the mount is needed.
   */
  readonly agent: Agent;
}

/**
 * One pod-level Volume + zero-or-more containerVolumeMounts the helper
 * returns. The reconciler concatenates these onto the existing volume
 * lists in `buildJobSpec` — additive only.
 */
export interface BuildArtifactMountsResult {
  readonly volumes: readonly {
    readonly name: string;
    readonly persistentVolumeClaim: { readonly claimName: string };
  }[];
  readonly volumeMounts: readonly {
    readonly name: string;
    readonly mountPath: string;
    readonly readOnly?: boolean;
  }[];
}

/**
 * Build the CAS PVC volume + read-only mount when the Agent declares at
 * least one `kind: 'artifact'` input. Returns empty arrays otherwise so
 * the caller can unconditionally spread the result without branching.
 *
 * Admission validates the schema-level inputs[] contract (see Wave 1.1
 * I/O sub-team's `validateAgentTaskInputs`); this helper only consumes
 * the resolved Agent and emits the K8s plumbing.
 */
export function buildArtifactMounts(opts: BuildArtifactMountsOptions): BuildArtifactMountsResult {
  if (typeof opts.pvcName !== 'string' || opts.pvcName.length === 0) {
    return { volumes: [], volumeMounts: [] };
  }
  const inputs = opts.agent.spec.inputs ?? [];
  let needsMount = false;
  for (const i of inputs) {
    if (i.kind === 'artifact') {
      needsMount = true;
      break;
    }
  }
  // Outputs of `kind: 'artifact'` ALSO trigger the mount because the
  // agent-pod's writer publishes via the in-pod CAS backend, which
  // currently writes onto the same PVC. (When the v0.3 S3 backend lands
  // and an Agent uses S3-only outputs, this branch flips to inputs-only.)
  const outputs = opts.agent.spec.outputs ?? [];
  if (!needsMount) {
    for (const o of outputs) {
      if (o.kind === 'artifact') {
        needsMount = true;
        break;
      }
    }
  }
  if (!needsMount) return { volumes: [], volumeMounts: [] };

  const mountPath = opts.mountPath ?? DEFAULT_CAS_MOUNT_PATH;
  return {
    volumes: [{ name: CAS_VOLUME_NAME, persistentVolumeClaim: { claimName: opts.pvcName } }],
    volumeMounts: [{ name: CAS_VOLUME_NAME, mountPath, readOnly: true }],
  };
}

/* =====================================================================
 * v0.4.2-cache — Wave 3 / Cache sub-team.
 *
 * `buildCacheMounts` translates `Agent.spec.caches[]` declarations into
 * the (initContainers, volumes, volumeMounts, perSlotResults) bundle the
 * operator splices onto the rendered Job spec. Distinct from the Wave 1
 * helpers (`buildWorkspaceMounts`, `buildArtifactMounts`) — additive
 * only, no shared state, no shared volume names.
 *
 * Topology summary (see `@kagent/cache-controller`'s `restore.ts` for the
 * gory details):
 *
 *   - Per declared cache slot: one emptyDir volume, mounted at the
 *     slot's `mountPath` on the agent container. Always present.
 *   - When at least one slot HIT in the PVC probe: one read-only PVC
 *     volume mounted on a single `kagent-cache-restore` init-container,
 *     plus all the per-slot emptyDirs mounted there too. The init-
 *     container `cp -r`s each hit slot's blob from the PVC into the
 *     emptyDir.
 *   - When zero slots hit: no init-container, no PVC volume. The
 *     emptyDirs are still emitted so the agent's mountPath is writable
 *     on cold start.
 *
 * Audit emission (`cache.hit` / `cache.miss`) is the operator's
 * responsibility AFTER calling this helper — caller pulls
 * `perSlotResults` and emits one event per entry. Helper stays
 * pure-functional + side-effect-free.
 * ===================================================================== */

/**
 * Inputs to {@link buildCacheMounts}. The caller supplies the PVC name
 * + mount path (Helm-config'd in `cache:` block) plus a probe that
 * resolves cache hits on disk.
 */
export interface BuildCacheMountsOptions {
  readonly agent: Agent;
  readonly task: AgentTask;
  /**
   * Cache PVC claim name in the AgentTask's namespace. The same PVC
   * the operator pod mounts at `cachePvcMountOnOperator` for the disk
   * probe. v0.4.2 supports the cache PVC and the CAS PVC being the
   * same volume (Helm `cache.pvcName` defaults to `cas.pvcName`); the
   * file layouts don't collide (`cas/sha256/...` vs. `cache/sha256/...`).
   */
  readonly pvcName: string;
  /**
   * Cache PVC mount path on the OPERATOR pod, NOT the agent-pod.
   * Operator probes for hits via `existsOnDisk(<this>/<rel>)`.
   */
  readonly cachePvcMountOnOperator: string;
  /** Caller-supplied disk probe; defaults to `existsSync` in main.ts. */
  readonly existsOnDisk: (absolutePath: string) => boolean;
  /**
   * Image digest the operator resolved for this Agent's container.
   * Threaded through so `deriveCacheKey` can substitute `{image_digest}`.
   * Empty string is acceptable (key derivation handles it deterministically).
   */
  readonly imageDigest: string;
  /**
   * sha256-hex hashes of every `kind: 'artifact'` input bound on the
   * task. Resolved by the caller (the reconciler walks
   * `task.spec.inputs[]` matching `Agent.spec.inputs[].kind === 'artifact'`
   * and looks up the `cas://sha256:<hex>` URIs from the upstream
   * AgentTask's status). Empty array when the task binds no artifacts.
   */
  readonly inputArtifactHashes: readonly string[];
  /** Helper image override (defaults to busybox). */
  readonly helperImage?: string;
}

/**
 * Per-slot lookup result the caller emits as `cache.hit` /
 * `cache.miss` audit events. Distinct from
 * `@kagent/cache-controller`'s internal `CacheLookupResult` so the
 * operator's audit-emission code doesn't have to re-derive the slot
 * name + mount path.
 */
export interface BuildCacheMountsSlotResult {
  /** `Agent.spec.caches[].name` — for the audit event subject. */
  readonly slotName: string;
  /** sha256-hex of the rendered key. */
  readonly key: string;
  /** Container path the cache mounts at; for the audit event payload. */
  readonly mountPath: string;
  readonly outcome: 'hit' | 'miss';
}

/**
 * Result the caller splices onto the rendered Job spec. Empty everything
 * when the Agent declares no caches.
 *
 * `initContainers` is shaped as `V1Container` from
 * `@kubernetes/client-node`; consumers may pass it through to a
 * `V1PodSpec.initContainers` field unchanged.
 */
export interface BuildCacheMountsResult {
  readonly initContainers: readonly import('@kubernetes/client-node').V1Container[];
  readonly volumes: readonly V1Volume[];
  readonly volumeMounts: readonly V1VolumeMount[];
  readonly perSlot: readonly BuildCacheMountsSlotResult[];
  readonly hitCount: number;
  readonly missCount: number;
}

/**
 * Build the cache-mount bundle for an Agent + Task pair. Unconditional
 * call — returns empty arrays when the Agent declares no caches, so
 * the caller can spread the result into the Job spec without
 * branching.
 *
 * The caller is responsible for emitting `cache.hit` / `cache.miss`
 * audit events from `perSlot`. Pure-functional otherwise.
 */
export function buildCacheMounts(opts: BuildCacheMountsOptions): BuildCacheMountsResult {
  const slots = opts.agent.spec.caches ?? [];
  if (slots.length === 0 || typeof opts.pvcName !== 'string' || opts.pvcName.length === 0) {
    return {
      initContainers: [],
      volumes: [],
      volumeMounts: [],
      perSlot: [],
      hitCount: 0,
      missCount: 0,
    };
  }

  // Stage 1 — derive keys + probe each slot. Done via the
  // pure-functional `lookupCacheEntries` helper from
  // `@kagent/cache-controller`.
  const lookups = cacheController.lookupCacheEntries({
    agent: { spec: { model: opts.agent.spec.model, caches: slots } },
    task: {
      spec: { ...(opts.task.spec.inputs !== undefined && { inputs: opts.task.spec.inputs }) },
    },
    ctx: {
      imageDigest: opts.imageDigest,
      inputArtifactHashes: opts.inputArtifactHashes,
    },
    cachePvcMountOnOperator: opts.cachePvcMountOnOperator,
    existsOnDisk: opts.existsOnDisk,
  });

  // Stage 2 — build the init-container + volumes via the same
  // pure-functional helper.
  const restore = cacheController.buildCacheRestoreInitContainer({
    slots,
    lookups,
    pvcName: opts.pvcName,
    ...(opts.helperImage !== undefined && { image: opts.helperImage }),
  });

  // Stage 3 — flatten into the operator-facing slot summary.
  const perSlot: BuildCacheMountsSlotResult[] = slots.map((s, i) => ({
    slotName: s.name,
    key: lookups[i]!.key,
    mountPath: s.mountPath,
    outcome: lookups[i]!.outcome,
  }));

  return {
    initContainers: restore.initContainers,
    volumes: restore.volumes,
    volumeMounts: restore.volumeMounts,
    perSlot,
    hitCount: restore.hitCount,
    missCount: restore.missCount,
  };
}
