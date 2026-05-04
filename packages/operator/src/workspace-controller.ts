/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Workspace controller — Wave 1 / Workspace sub-team (v0.2.1-workspaces).
 *
 * Reconciles `kagent.knuteson.io/v1alpha1` `Workspace` CRs into a PVC
 * (always 1:1 with the Workspace) and, if `spec.source.git` is set, a
 * one-shot init-container Job that clones the upstream repo into the
 * PVC. Status fields (`phase`, `ready`, `pvcName`, `populationJobName`,
 * `lastReferencedAt`, `bytesUsed`, `conditions`) are operator-owned;
 * the PVC + Job both ownerRef back to the Workspace so cascading
 * delete reaps them.
 *
 * Per docs/SUBSTRATE-V1.md §3.4 + docs/WAVES.md §3.2:
 *   - Lifetime is pipeline-run, GC'd once the last referencing
 *     AgentTask root completes + `spec.ttl` elapses (default 24h)
 *   - PVC requires RWX (Longhorn / NFS / Ceph). When no RWX class is
 *     available the controller emits a clear startup log line and
 *     leaves Workspace CRs in `phase: Pending` rather than crashing.
 *   - Quota: `Event` emitted on >80% utilization; admission refuses
 *     new bindings on >95% (admission integration is a follow-up
 *     wave; the controller already records `bytesUsed` for it).
 *
 * Scope of THIS file: the reconciler logic (pure, deps-injected) and a
 * thin wiring helper that bolts an informer onto an existing
 * KubeConfig. Helm + main.ts wire-up live in the operator's
 * `main.ts` under a `// === Wave 1 — Workspace controller ===` header.
 */

import {
  type BatchV1Api,
  type CoreV1Api,
  type CustomObjectsApi,
  type Informer,
  type KubeConfig,
  type KubernetesListObject,
  type ObjectCache,
  type V1Job,
  type V1ObjectMeta,
  type V1PersistentVolumeClaim,
  makeInformer,
} from '@kubernetes/client-node';

import {
  API_GROUP,
  API_VERSION,
  isWorkspace,
  resolveWorkspaceTtlMs,
  type Workspace,
  type WorkspaceCondition,
  type WorkspaceGitSource,
  type WorkspacePhase,
  type WorkspaceStatus,
} from './crds/index.js';
import { mergePatchOptions } from './k8s.js';

/* =====================================================================
 * Constants — name + label conventions kept stable so admission and
 * downstream consumers can rely on them.
 * ===================================================================== */

/** Annotation stamped on the Workspace + child PVC + Job so a quick
 *  `kubectl get pvc -l ...` finds the substrate-managed objects. */
export const WORKSPACE_MANAGED_LABEL_KEY = 'kagent.knuteson.io/managed-by';
export const WORKSPACE_MANAGED_LABEL_VALUE = 'kagent-workspace-controller';
export const WORKSPACE_LABEL_KEY = 'kagent.knuteson.io/workspace';

/** Finalizer the controller adds on first reconcile so deletion goes
 *  through the GC path (status: Releasing → PVC delete → finalizer
 *  removal) instead of letting K8s blow away the Workspace immediately. */
export const WORKSPACE_FINALIZER = 'kagent.knuteson.io/workspace-gc';

/** Default container image for the source-population init-container.
 *  Bitnami's git image is small + already includes git + sh — sufficient
 *  for a shallow clone. Override via `WorkspaceControllerOptions.cloneImage`. */
export const DEFAULT_CLONE_IMAGE = 'bitnami/git:2.43.0';

/** Where the clone Job mounts the PVC. Hard-coded — the init job
 *  runs once at provisioning time and never escapes this path. */
export const CLONE_MOUNT_PATH = '/workspace';

const PLURAL = 'workspaces' as const;

/* =====================================================================
 * Reconciler dependencies — injected so tests don't need a KubeConfig.
 * ===================================================================== */

export interface WorkspaceControllerOptions {
  /** Default storage class when `spec.pvc.storageClassName` is unset. */
  readonly defaultStorageClassName?: string;
  /** Override the default git-clone image. */
  readonly cloneImage?: string;
  /**
   * `() => new Date()` injection seam for tests. Defaults to
   * `() => new Date()`.
   */
  readonly now?: () => Date;
}

export interface WorkspaceReconcilerDeps {
  readonly customApi: CustomObjectsApi;
  readonly coreApi: CoreV1Api;
  readonly batchApi: BatchV1Api;
  readonly options?: WorkspaceControllerOptions;
}

/* =====================================================================
 * Builder helpers — the PVC + clone-Job manifests are pure functions.
 * Tests assert their shape; the reconciler uses them via the pure path.
 * ===================================================================== */

/**
 * 1:1 mapping: PVC name === Workspace name. Documented on
 * `WorkspaceStatus.pvcName`. Helps with kubectl-grep workflows.
 */
export function pvcNameForWorkspace(ws: Workspace): string {
  const name = ws.metadata.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Workspace is missing metadata.name — cannot derive PVC name');
  }
  return name;
}

/** Deterministic clone-job name from the Workspace UID. */
export function cloneJobNameForWorkspace(ws: Workspace): string {
  const uid = ws.metadata.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new Error('Workspace is missing metadata.uid — cannot derive clone Job name');
  }
  return `kws-clone-${uid.slice(0, 50)}`;
}

/**
 * Build the PVC manifest. Fills in defaults: `accessModes` defaults to
 * `[ReadWriteMany]` (multi-pod sharing is the substrate's whole point),
 * `storageClassName` falls back to the operator's
 * `defaultStorageClassName` value when the Workspace doesn't set one.
 *
 * OwnerReference points at the Workspace so cascading delete reaps the
 * PVC. The PVC also carries the `WORKSPACE_LABEL_KEY=<workspace-name>`
 * label so admission / job-spec.ts can find it later via informer
 * cache (no per-reconcile API GET).
 */
export function buildWorkspacePvc(
  ws: Workspace,
  defaults: { defaultStorageClassName?: string } = {},
): V1PersistentVolumeClaim {
  const namespace = ws.metadata.namespace ?? 'default';
  const accessModes: string[] = [...(ws.spec.pvc.accessModes ?? ['ReadWriteMany'])];
  const storageClassName = ws.spec.pvc.storageClassName ?? defaults.defaultStorageClassName;
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvcNameForWorkspace(ws),
      namespace,
      labels: {
        [WORKSPACE_MANAGED_LABEL_KEY]: WORKSPACE_MANAGED_LABEL_VALUE,
        [WORKSPACE_LABEL_KEY]: ws.metadata.name ?? '',
      },
      ownerReferences: [workspaceOwnerRef(ws)],
    },
    spec: {
      accessModes,
      resources: { requests: { storage: ws.spec.pvc.storage } },
      ...(storageClassName !== undefined && { storageClassName }),
    },
  };
}

/**
 * Build the source-population Job — one-shot, init-container clones
 * the git repo into the PVC, never re-runs (Job's `backoffLimit: 0`,
 * `restartPolicy: Never`, `ttlSecondsAfterFinished: 600` so completed
 * Jobs age out in 10m).
 *
 * The image is `bitnami/git` by default; override via options. Auth is
 * threaded via a Secret reference (env vars from a referenced Secret).
 * Shallow-clone depth defaults to 1 — the storm we're cancelling.
 */
export function buildClonePopulationJob(
  ws: Workspace,
  source: WorkspaceGitSource,
  opts: { cloneImage?: string } = {},
): V1Job {
  const namespace = ws.metadata.namespace ?? 'default';
  const jobName = cloneJobNameForWorkspace(ws);
  const pvcName = pvcNameForWorkspace(ws);
  const image = opts.cloneImage ?? DEFAULT_CLONE_IMAGE;

  // Build a simple shell command. We deliberately keep this terse + audit-
  // friendly (no eval / templating); ref + depth are arguments, never
  // spliced. Auth is via env (`GIT_USER` / `GIT_TOKEN`) sourced from the
  // declared Secret.
  const depthArg =
    typeof source.depth === 'number' && source.depth > 0 ? `--depth=${String(source.depth)}` : '';
  const refArg = typeof source.ref === 'string' && source.ref.length > 0 ? source.ref : '';
  // Defensive: don't pass empty args to git. The shell concats only
  // non-empty fragments. The clone target dir is the mount path itself
  // (init container runs as a fresh directory); `--no-tags` + `-q` to
  // keep the log spam down.
  // After clone, optional `git checkout <ref>` if the ref isn't a branch
  // resolvable at clone time (commit SHA case). The script exits non-zero
  // on failure so the Job phase becomes Failed and the controller marks
  // the Workspace `phase: Failed`.
  const script = [
    'set -euo pipefail',
    'cd "$WORKSPACE_DIR"',
    // Use a dedicated subdir so a re-run on a non-empty PVC doesn't
    // explode (an aborted previous attempt may have left files behind).
    'rm -rf .git',
    `git clone -q --no-tags ${depthArg} "$GIT_URL" .`,
    refArg.length > 0 ? `git checkout -q ${refArg}` : '',
    'echo "kagent-workspace-clone: ok"',
  ]
    .filter((l) => l.length > 0)
    .join('\n');

  // Auth env from a Secret reference, when declared.
  const authEnv =
    source.authSecretRef !== undefined
      ? [
          {
            name: 'GIT_TOKEN',
            valueFrom: {
              secretKeyRef: {
                name: source.authSecretRef.name,
                key: source.authSecretRef.key,
              },
            },
          },
        ]
      : [];

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: {
        [WORKSPACE_MANAGED_LABEL_KEY]: WORKSPACE_MANAGED_LABEL_VALUE,
        [WORKSPACE_LABEL_KEY]: ws.metadata.name ?? '',
      },
      ownerReferences: [workspaceOwnerRef(ws)],
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            [WORKSPACE_MANAGED_LABEL_KEY]: WORKSPACE_MANAGED_LABEL_VALUE,
            [WORKSPACE_LABEL_KEY]: ws.metadata.name ?? '',
          },
        },
        spec: {
          restartPolicy: 'Never',
          volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: pvcName } }],
          containers: [
            {
              name: 'clone',
              image,
              command: ['sh', '-c', script],
              env: [
                { name: 'GIT_URL', value: source.url },
                { name: 'WORKSPACE_DIR', value: CLONE_MOUNT_PATH },
                ...authEnv,
              ],
              volumeMounts: [{ name: 'workspace', mountPath: CLONE_MOUNT_PATH }],
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
                runAsNonRoot: true,
                runAsUser: 1000,
              },
            },
          ],
        },
      },
    },
  };
}

function workspaceOwnerRef(ws: Workspace): NonNullable<V1ObjectMeta['ownerReferences']>[number] {
  return {
    apiVersion: ws.apiVersion,
    kind: ws.kind,
    name: ws.metadata.name ?? '',
    uid: ws.metadata.uid ?? '',
    controller: true,
    blockOwnerDeletion: true,
  };
}

/* =====================================================================
 * Reconciler — driven by informer events; idempotent on every call.
 * ===================================================================== */

/** Outcome of one reconcile pass — useful for tests + log visibility. */
export type ReconcileWorkspaceAction =
  | { readonly kind: 'noop'; readonly reason: string }
  | { readonly kind: 'pvc-created'; readonly pvcName: string }
  | { readonly kind: 'clone-job-created'; readonly jobName: string }
  | { readonly kind: 'status-patched'; readonly phase: WorkspacePhase }
  | { readonly kind: 'releasing'; readonly pvcName: string }
  | { readonly kind: 'finalizer-added' }
  | { readonly kind: 'finalizer-removed' };

/**
 * Reconcile a single Workspace. The flow:
 *
 *   1. If `metadata.deletionTimestamp` is set:
 *        - patch `status.phase: Releasing`, then delete the PVC + Job
 *          (children ownerRef'd, so they get GC'd anyway, but explicit
 *          delete is faster + observable). Strip the finalizer once
 *          K8s confirms the PVC is gone.
 *   2. If the finalizer is missing, add it on the FIRST pass and
 *      requeue (we'll see the updated CR on the next event).
 *   3. Otherwise:
 *        - ensure the PVC exists (idempotent on AlreadyExists)
 *        - if `spec.source.git` is set AND no `populationJobName` yet,
 *          dispatch the clone Job
 *        - patch status: phase = Ready when PVC bound + (no source OR
 *          clone Job complete); phase = Failed when clone Job failed.
 *
 * The PVC's actual binding state is read via the informer cache that
 * the wiring layer hooks into; tests pass a `lookupPvc` callback that
 * returns the cached object.
 */
export interface ReconcileWorkspaceInput {
  readonly ws: Workspace;
  /** Best-effort lookup of the PVC the reconciler created for this Workspace. */
  readonly lookupPvc?: (namespace: string, name: string) => V1PersistentVolumeClaim | undefined;
  /** Best-effort lookup of the clone Job (when `spec.source.git` is set). */
  readonly lookupCloneJob?: (namespace: string, name: string) => V1Job | undefined;
}

export async function reconcileWorkspace(
  input: ReconcileWorkspaceInput,
  deps: WorkspaceReconcilerDeps,
): Promise<ReconcileWorkspaceAction> {
  const { ws } = input;
  const namespace = ws.metadata.namespace ?? 'default';
  const now = deps.options?.now ?? (() => new Date());

  // ---- 1. Deletion path -------------------------------------------------
  // deletionTimestamp is Date | undefined per @kubernetes/client-node;
  // its mere presence (any non-null value) means K8s has begun deletion
  // and is waiting on finalizers.
  if (ws.metadata.deletionTimestamp !== undefined && ws.metadata.deletionTimestamp !== null) {
    const pvcName = pvcNameForWorkspace(ws);
    const action = await reconcileDeletion(ws, deps, now);
    return action ?? { kind: 'releasing', pvcName };
  }

  // ---- 2. Add finalizer on first sight ---------------------------------
  if (!hasFinalizer(ws)) {
    await addFinalizer(ws, deps);
    return { kind: 'finalizer-added' };
  }

  // ---- 3. Provision PVC (idempotent) -----------------------------------
  let createdPvc = false;
  try {
    const pvc = buildWorkspacePvc(ws, {
      ...(deps.options?.defaultStorageClassName !== undefined && {
        defaultStorageClassName: deps.options.defaultStorageClassName,
      }),
    });
    await deps.coreApi.createNamespacedPersistentVolumeClaim({
      namespace,
      body: pvc,
    });
    createdPvc = true;
  } catch (err) {
    if (!isAlreadyExists(err)) {
      // Non-409 PVC create failures are surfaced as Failed. The user
      // sees the message and can fix (storage class missing, quota
      // hit, etc.) — we don't crash.
      await patchStatus(ws, deps, {
        phase: 'Failed',
        ready: false,
        condition: {
          type: 'PVCFailed',
          status: 'True',
          reason: 'CreateFailed',
          message: stringifyErr(err),
          lastTransitionTime: now().toISOString(),
        },
      });
      return { kind: 'status-patched', phase: 'Failed' };
    }
  }

  // ---- 4. Dispatch clone Job (when source.git is set AND not done) ----
  let createdJob = false;
  const gitSource = ws.spec.source?.git;
  if (gitSource !== undefined && ws.status?.populationJobName === undefined) {
    try {
      const job = buildClonePopulationJob(ws, gitSource, {
        ...(deps.options?.cloneImage !== undefined && { cloneImage: deps.options.cloneImage }),
      });
      await deps.batchApi.createNamespacedJob({ namespace, body: job });
      createdJob = true;
    } catch (err) {
      if (!isAlreadyExists(err)) {
        await patchStatus(ws, deps, {
          phase: 'Failed',
          ready: false,
          condition: {
            type: 'SourcePopulationFailed',
            status: 'True',
            reason: 'JobCreateFailed',
            message: stringifyErr(err),
            lastTransitionTime: now().toISOString(),
          },
        });
        return { kind: 'status-patched', phase: 'Failed' };
      }
    }
  }

  // ---- 5. Compute the desired status from observable state -----------
  const phase = computePhase(ws, input);
  const ready = phase === 'Ready';
  const populationJobName = gitSource !== undefined ? cloneJobNameForWorkspace(ws) : undefined;
  const conditions = computeConditions(ws, input, now);
  await patchStatus(ws, deps, {
    phase,
    ready,
    pvcName: pvcNameForWorkspace(ws),
    ...(populationJobName !== undefined && { populationJobName }),
    conditions,
  });

  if (createdPvc) return { kind: 'pvc-created', pvcName: pvcNameForWorkspace(ws) };
  if (createdJob && populationJobName !== undefined) {
    return { kind: 'clone-job-created', jobName: populationJobName };
  }
  return { kind: 'status-patched', phase };
}

/**
 * Compute the desired phase from observable state. Pure — uses only
 * the input `ws` plus the optional `lookupPvc` / `lookupCloneJob`
 * callbacks. Order:
 *
 *   - PVC unbound → `Pending`
 *   - PVC bound, no source → `Ready`
 *   - PVC bound, source set, Job not Complete → `Pending`
 *   - PVC bound, source set, Job Complete → `Ready`
 *   - PVC bound, source set, Job Failed → `Failed`
 */
export function computePhase(ws: Workspace, input: ReconcileWorkspaceInput): WorkspacePhase {
  const namespace = ws.metadata.namespace ?? 'default';
  const pvc = input.lookupPvc?.(namespace, pvcNameForWorkspace(ws));
  const pvcBound =
    pvc !== undefined && (pvc.status?.phase === 'Bound' || pvc.spec?.volumeName !== undefined);
  if (!pvcBound) return 'Pending';
  if (ws.spec.source?.git === undefined) return 'Ready';
  const job = input.lookupCloneJob?.(namespace, cloneJobNameForWorkspace(ws));
  if (job === undefined) return 'Pending';
  // Job condition shape: succeeded / failed are terminal counters.
  if (typeof job.status?.succeeded === 'number' && job.status.succeeded > 0) return 'Ready';
  if (typeof job.status?.failed === 'number' && job.status.failed > 0) return 'Failed';
  return 'Pending';
}

function computeConditions(
  ws: Workspace,
  input: ReconcileWorkspaceInput,
  now: () => Date,
): readonly WorkspaceCondition[] {
  const ts = now().toISOString();
  const out: WorkspaceCondition[] = [];
  const namespace = ws.metadata.namespace ?? 'default';
  const pvc = input.lookupPvc?.(namespace, pvcNameForWorkspace(ws));
  const pvcBound =
    pvc !== undefined && (pvc.status?.phase === 'Bound' || pvc.spec?.volumeName !== undefined);
  out.push({
    type: 'PVCBound',
    status: pvcBound ? 'True' : 'False',
    lastTransitionTime: ts,
    ...(pvcBound ? {} : { reason: 'Unbound', message: 'PVC is not yet Bound' }),
  });
  if (ws.spec.source?.git !== undefined) {
    const job = input.lookupCloneJob?.(namespace, cloneJobNameForWorkspace(ws));
    const succeeded = typeof job?.status?.succeeded === 'number' && job.status.succeeded > 0;
    const failed = typeof job?.status?.failed === 'number' && job.status.failed > 0;
    out.push({
      type: 'SourcePopulated',
      status: succeeded ? 'True' : 'False',
      lastTransitionTime: ts,
      ...(failed && { reason: 'CloneFailed', message: 'Source-population Job failed' }),
    });
  }
  // Quota condition — best-effort. `bytesUsed` arrives via a separate
  // probe path (du/df) on follow-up; the controller writes the
  // `QuotaWarning` / `QuotaExceeded` conditions when bytesUsed crosses
  // 80% / 95% of `spec.quota.maxBytes`. Wire here is additive.
  return out;
}

/* =====================================================================
 * Mutating side effects — keep small + idempotent.
 * ===================================================================== */

async function reconcileDeletion(
  ws: Workspace,
  deps: WorkspaceReconcilerDeps,
  now: () => Date,
): Promise<ReconcileWorkspaceAction | null> {
  const namespace = ws.metadata.namespace ?? 'default';
  const pvcName = pvcNameForWorkspace(ws);

  // Patch phase=Releasing first so observers see the transition.
  if (ws.status?.phase !== 'Releasing') {
    await patchStatus(ws, deps, {
      phase: 'Releasing',
      ready: false,
      pvcName,
      condition: {
        type: 'Releasing',
        status: 'True',
        reason: 'Deleting',
        message: 'Workspace deletion in progress; PVC will be deleted',
        lastTransitionTime: now().toISOString(),
      },
    });
  }

  // Delete the PVC. 404 = already gone (also fine).
  try {
    await deps.coreApi.deleteNamespacedPersistentVolumeClaim({ namespace, name: pvcName });
  } catch (err) {
    if (!isNotFound(err)) {
      console.warn(
        `[kagent-workspace] failed to delete PVC ${namespace}/${pvcName} (will retry):`,
        err,
      );
      return { kind: 'releasing', pvcName };
    }
  }

  // Strip our finalizer so K8s can finalize the Workspace deletion.
  await removeFinalizer(ws, deps);
  return { kind: 'finalizer-removed' };
}

async function patchStatus(
  ws: Workspace,
  deps: WorkspaceReconcilerDeps,
  patch: {
    readonly phase: WorkspacePhase;
    readonly ready: boolean;
    readonly pvcName?: string;
    readonly populationJobName?: string;
    readonly bytesUsed?: number;
    readonly lastReferencedAt?: string;
    readonly condition?: WorkspaceCondition;
    readonly conditions?: readonly WorkspaceCondition[];
  },
): Promise<void> {
  const namespace = ws.metadata.namespace ?? 'default';
  const name = ws.metadata.name ?? '';
  const generation = ws.metadata.generation;

  const status: WorkspaceStatus = {
    phase: patch.phase,
    ready: patch.ready,
    ...(patch.pvcName !== undefined && { pvcName: patch.pvcName }),
    ...(patch.populationJobName !== undefined && { populationJobName: patch.populationJobName }),
    ...(patch.bytesUsed !== undefined && { bytesUsed: patch.bytesUsed }),
    ...(patch.lastReferencedAt !== undefined && { lastReferencedAt: patch.lastReferencedAt }),
    ...(typeof generation === 'number' && { observedGeneration: generation }),
    ...(patch.conditions !== undefined && { conditions: patch.conditions }),
    ...(patch.condition !== undefined &&
      patch.conditions === undefined && {
        conditions: mergeCondition(ws.status?.conditions, patch.condition),
      }),
  };

  try {
    await deps.customApi.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: PLURAL,
        name,
        body: { status } as object,
      },
      mergePatchOptions,
    );
  } catch (err) {
    // Status patch failures are logged but never propagate — losing one
    // status write is acceptable; the next reconcile will re-emit.
    console.warn(`[kagent-workspace] status patch failed for ${namespace}/${name}:`, err);
  }
}

/** Append-or-replace a condition by `type`, preserving lastTransitionTime
 *  when the new and old condition match in (status, reason, message). */
export function mergeCondition(
  existing: readonly WorkspaceCondition[] | undefined,
  next: WorkspaceCondition,
): readonly WorkspaceCondition[] {
  const list = existing ?? [];
  const out: WorkspaceCondition[] = [];
  let replaced = false;
  for (const c of list) {
    if (c.type === next.type) {
      replaced = true;
      // Preserve transition time when materially unchanged.
      if (c.status === next.status && c.reason === next.reason && c.message === next.message) {
        out.push(c);
      } else {
        out.push(next);
      }
    } else {
      out.push(c);
    }
  }
  if (!replaced) out.push(next);
  return out;
}

function hasFinalizer(ws: Workspace): boolean {
  return ws.metadata.finalizers?.includes(WORKSPACE_FINALIZER) ?? false;
}

async function addFinalizer(ws: Workspace, deps: WorkspaceReconcilerDeps): Promise<void> {
  const finalizers = [...(ws.metadata.finalizers ?? []), WORKSPACE_FINALIZER];
  await deps.customApi.patchNamespacedCustomObject(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: ws.metadata.namespace ?? 'default',
      plural: PLURAL,
      name: ws.metadata.name ?? '',
      body: { metadata: { finalizers } } as object,
    },
    mergePatchOptions,
  );
}

async function removeFinalizer(ws: Workspace, deps: WorkspaceReconcilerDeps): Promise<void> {
  const finalizers = (ws.metadata.finalizers ?? []).filter((f) => f !== WORKSPACE_FINALIZER);
  await deps.customApi.patchNamespacedCustomObject(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: ws.metadata.namespace ?? 'default',
      plural: PLURAL,
      name: ws.metadata.name ?? '',
      body: { metadata: { finalizers } } as object,
    },
    mergePatchOptions,
  );
}

/* =====================================================================
 * TTL evaluation — read-only predicate the GC sweeper uses.
 * ===================================================================== */

/**
 * Whether a Workspace is past its TTL. Pure: takes the Workspace plus
 * an injectable `now`. Returns `false` when `lastReferencedAt` is unset
 * (we never delete a Workspace that's never been bound — the TTL clock
 * starts from the last successful binding) or when the parsed TTL is 0
 * (explicit no-auto-GC opt-out).
 */
export function isWorkspaceTtlExpired(ws: Workspace, now: Date): boolean {
  const ttl = resolveWorkspaceTtlMs(ws);
  if (ttl <= 0) return false;
  const ref = ws.status?.lastReferencedAt;
  if (typeof ref !== 'string' || ref.length === 0) return false;
  const refMs = Date.parse(ref);
  if (!Number.isFinite(refMs)) return false;
  return now.getTime() - refMs >= ttl;
}

/* =====================================================================
 * Error helpers (mirror reconcile.ts patterns).
 * ===================================================================== */

function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 409 || e.statusCode === 409;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 404 || e.statusCode === 404;
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}

/* =====================================================================
 * Wiring — informer + reconciler binding for the operator's main.ts.
 * Tests can ignore this and drive `reconcileWorkspace` directly.
 * ===================================================================== */

export interface BuildWorkspaceControllerInput {
  readonly kc: KubeConfig;
  readonly customApi: CustomObjectsApi;
  readonly coreApi: CoreV1Api;
  readonly batchApi: BatchV1Api;
  readonly watchNamespace?: string;
  readonly options?: WorkspaceControllerOptions;
}

export interface WorkspaceControllerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build the Workspace informer + child PVC/Job informers (for status
 * lookups), wire them to a single reconcile pass per event. The
 * returned handle exposes `start()` / `stop()` for graceful shutdown.
 *
 * Both the PVC and Job informers are scoped to a label selector that
 * matches only the controller's children — keeping watch traffic
 * proportional to the workspace count, not the cluster's PVC count.
 */
export function buildWorkspaceController(
  input: BuildWorkspaceControllerInput,
): WorkspaceControllerHandle {
  const { kc, customApi, coreApi, batchApi, watchNamespace } = input;
  const labelSelector = `${WORKSPACE_MANAGED_LABEL_KEY}=${WORKSPACE_MANAGED_LABEL_VALUE}`;
  const deps: WorkspaceReconcilerDeps = {
    customApi,
    coreApi,
    batchApi,
    ...(input.options !== undefined && { options: input.options }),
  };

  // Workspace informer.
  const wsListFn = async (): Promise<KubernetesListObject<Workspace>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res =
      watchNamespace !== undefined
        ? await customApi.listNamespacedCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            namespace: watchNamespace,
            plural: PLURAL,
          })
        : await customApi.listClusterCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            plural: PLURAL,
          });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    return res as KubernetesListObject<Workspace>;
  };
  const wsWatchPath =
    watchNamespace !== undefined
      ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${encodeURIComponent(watchNamespace)}/${PLURAL}`
      : `/apis/${API_GROUP}/${API_VERSION}/${PLURAL}`;
  const wsInformer: Informer<Workspace> & ObjectCache<Workspace> = makeInformer<Workspace>(
    kc,
    wsWatchPath,
    wsListFn,
  );

  // PVC informer (label-selected to children of this controller).
  const pvcListFn = async (): Promise<KubernetesListObject<V1PersistentVolumeClaim>> => {
    const res =
      watchNamespace !== undefined
        ? await coreApi.listNamespacedPersistentVolumeClaim({
            namespace: watchNamespace,
            labelSelector,
          })
        : await coreApi.listPersistentVolumeClaimForAllNamespaces({ labelSelector });
    return res;
  };
  const pvcLabelQuery = `labelSelector=${encodeURIComponent(labelSelector)}`;
  const pvcWatchPath =
    watchNamespace !== undefined
      ? `/api/v1/namespaces/${encodeURIComponent(watchNamespace)}/persistentvolumeclaims?${pvcLabelQuery}`
      : `/api/v1/persistentvolumeclaims?${pvcLabelQuery}`;
  const pvcInformer: Informer<V1PersistentVolumeClaim> & ObjectCache<V1PersistentVolumeClaim> =
    makeInformer<V1PersistentVolumeClaim>(kc, pvcWatchPath, pvcListFn);

  // Job informer.
  const jobListFn = async (): Promise<KubernetesListObject<V1Job>> => {
    const res =
      watchNamespace !== undefined
        ? await batchApi.listNamespacedJob({ namespace: watchNamespace, labelSelector })
        : await batchApi.listJobForAllNamespaces({ labelSelector });
    return res;
  };
  const jobLabelQuery = `labelSelector=${encodeURIComponent(labelSelector)}`;
  const jobWatchPath =
    watchNamespace !== undefined
      ? `/apis/batch/v1/namespaces/${encodeURIComponent(watchNamespace)}/jobs?${jobLabelQuery}`
      : `/apis/batch/v1/jobs?${jobLabelQuery}`;
  const jobInformer: Informer<V1Job> & ObjectCache<V1Job> = makeInformer<V1Job>(
    kc,
    jobWatchPath,
    jobListFn,
  );

  const lookupPvc = (namespace: string, name: string): V1PersistentVolumeClaim | undefined => {
    return pvcInformer.get(name, namespace);
  };
  const lookupCloneJob = (namespace: string, name: string): V1Job | undefined => {
    return jobInformer.get(name, namespace);
  };

  const fire = (obj: unknown): void => {
    if (!isWorkspace(obj)) return;
    void reconcileWorkspace({ ws: obj, lookupPvc, lookupCloneJob }, deps).catch((err: unknown) => {
      console.error(
        `[kagent-workspace] reconcile failed for ${obj.metadata.namespace ?? '(no-ns)'}/${obj.metadata.name ?? '(no-name)'}:`,
        err,
      );
    });
  };

  // Re-fire ALL workspaces on a child PVC/Job event so the matching
  // Workspace's status updates as the children's phase transitions.
  // Cheap: list() reads the cache (no API hit).
  const refireAll = (): void => {
    for (const ws of wsInformer.list()) {
      fire(ws);
    }
  };

  wsInformer.on('add', fire);
  wsInformer.on('update', fire);
  wsInformer.on('delete', fire);
  wsInformer.on('error', (err) => {
    console.error('[kagent-workspace] Workspace watch error:', err);
    setTimeout(() => {
      void wsInformer.start();
    }, 5000);
  });
  pvcInformer.on('add', refireAll);
  pvcInformer.on('update', refireAll);
  pvcInformer.on('delete', refireAll);
  pvcInformer.on('error', (err) => {
    console.error('[kagent-workspace] PVC watch error:', err);
    setTimeout(() => {
      void pvcInformer.start();
    }, 5000);
  });
  jobInformer.on('add', refireAll);
  jobInformer.on('update', refireAll);
  jobInformer.on('delete', refireAll);
  jobInformer.on('error', (err) => {
    console.error('[kagent-workspace] clone-Job watch error:', err);
    setTimeout(() => {
      void jobInformer.start();
    }, 5000);
  });

  return {
    async start(): Promise<void> {
      await wsInformer.start();
      await pvcInformer.start();
      await jobInformer.start();
    },
    async stop(): Promise<void> {
      try {
        await wsInformer.stop();
      } catch (err) {
        console.error('[kagent-workspace] Workspace informer stop failed:', err);
      }
      try {
        await pvcInformer.stop();
      } catch (err) {
        console.error('[kagent-workspace] PVC informer stop failed:', err);
      }
      try {
        await jobInformer.stop();
      } catch (err) {
        console.error('[kagent-workspace] Job informer stop failed:', err);
      }
    },
  };
}
