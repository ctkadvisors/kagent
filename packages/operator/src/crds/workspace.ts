/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Workspace CRD — v0.2.1-workspaces (Wave 1 / Workspace sub-team).
 *
 * Pre-populated, shared filesystem mounted across multiple AgentTasks in
 * one task tree. Pattern: Tekton Workspaces, SLURM/Lustre, CircleCI
 * workspaces. Lifetime is pipeline-run (root AgentTask of the consuming
 * tree), not per-task. Same checkout, mounted across N agents — no
 * re-clone storm. RWX storage class required (Longhorn / NFS / Ceph).
 *
 * See:
 *   - docs/SUBSTRATE-V1.md §3.4 (Workspace primitive — substrate
 *     responsibility, application responsibility)
 *   - docs/WAVES.md §3.2 (sub-team Workspace deliverables)
 *
 * The TS types here mirror the YAML CRD schema at
 * `packages/operator/manifests/crds/workspaces.yaml` (and the chart-
 * shipped copy at
 * `packages/operator/charts/kagent-operator/crds/workspaces.yaml`).
 * Keep both in sync — schema drift is caught by
 * `pnpm --filter @kagent/operator crd:check`.
 */

import type { V1ObjectMeta } from '@kubernetes/client-node';

import { API_GROUP_VERSION } from './types.js';

/* =====================================================================
 * Workspace.spec
 * ===================================================================== */

/**
 * Source population. v0.2.1 ships only the `git` source — a one-shot
 * shallow clone via init-container Job at provisioning time. Future
 * sources (s3, http tarball, oci image-layer extraction) plug in here
 * as additional oneOf arms; the controller dispatches by which key is
 * set so adding a source is a CRD-bump + one new helper, not a
 * rewrite.
 *
 * Defensive shape: `oneOf` at the YAML level enforces "exactly one
 * source kind". When `source` is absent, the Workspace is provisioned
 * empty (PVC only) — the controller marks `phase: Ready` immediately
 * after the PVC binds.
 */
export interface WorkspaceGitSource {
  /** HTTPS or SSH URL of the upstream repository. */
  readonly url: string;
  /**
   * Branch/tag/SHA to check out. Defaults to the remote's default
   * branch (typically `main`); pinning a commit SHA is the only way to
   * make a Workspace truly content-addressed.
   */
  readonly ref?: string;
  /**
   * Shallow-clone depth. Omit for a full clone; `1` is the cheapest
   * option for read-only consumers. Default `1` at the CRD level —
   * shipping a 5GB git history when N consumers all want the latest
   * tree is the storm we're cancelling.
   */
  readonly depth?: number;
  /**
   * Authentication for private repos. Points at a Secret in the same
   * namespace; the init-container Job reads `key` (typically the
   * username:token combo for HTTPS or the SSH private key for ssh://).
   */
  readonly authSecretRef?: {
    readonly name: string;
    readonly key: string;
  };
}

export interface WorkspaceSource {
  readonly git?: WorkspaceGitSource;
}

/**
 * PVC sizing + access modes. The controller materializes a
 * `PersistentVolumeClaim` in the Workspace's namespace using these
 * fields verbatim — operators provision Longhorn / NFS / Ceph as the
 * backing storage class and supply its name here.
 *
 * `accessModes` defaults to `[ReadWriteMany]` (multi-pod sharing is
 * the whole point). For single-tenant test installs `[ReadWriteOnce]`
 * is allowed but the chart's RWX-detection probe will warn loudly —
 * see `templates/workspace-storage-class-probe.yaml`.
 */
export interface WorkspacePvcSpec {
  /**
   * StorageClass to bind. Omit for the cluster default. The chart's
   * detection probe asserts the chosen class supports `ReadWriteMany`
   * unless `workspaces.allowRWO=true` is set on Helm install.
   */
  readonly storageClassName?: string;
  /**
   * Requested capacity. Same shape as
   * `PersistentVolumeClaim.spec.resources.requests.storage` — `5Gi`,
   * `100Mi`, etc.
   */
  readonly storage: string;
  /**
   * PVC access modes. Defaults to `[ReadWriteMany]` when unset; the
   * controller fills the default at admission so downstream consumers
   * can rely on a populated value.
   */
  readonly accessModes?: readonly ('ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany')[];
}

/**
 * Quota fields. The controller probes the underlying PVC periodically
 * via init-container `du`/`df`-style readout; emits a `Workspace`
 * Event on > 80% utilization and refuses new bindings on > 95% (see
 * `WorkspaceController` in `packages/workspace-controller`).
 */
export interface WorkspaceQuota {
  /**
   * Hard ceiling on bytes used inside the PVC. Same shape as
   * `WorkspacePvcSpec.storage` — `10Gi`, `500Mi`.
   *
   * The controller does NOT enforce this with a kernel-level quota
   * (would require RWX storage classes that support quotas, which
   * Longhorn / NFS don't all). It's a soft ceiling enforced by
   * admission: refuses to admit AgentTasks that would push utilization
   * above the configured ratio.
   */
  readonly maxBytes: string;
}

export interface WorkspaceSpec {
  /**
   * Source population. When absent, the PVC is provisioned empty.
   */
  readonly source?: WorkspaceSource;
  /** PVC shape — sizing + access modes + storage class. */
  readonly pvc: WorkspacePvcSpec;
  /**
   * Time-to-live AFTER the last referencing AgentTask root completes.
   * Go-style duration string (`24h`, `30m`, `1h30m`). When unset, the
   * controller defaults to `24h`. Setting to `0` disables auto-GC; the
   * Workspace must then be hand-deleted to reclaim the PVC.
   */
  readonly ttl?: string;
  /** Optional storage cap; see `WorkspaceQuota`. */
  readonly quota?: WorkspaceQuota;
}

/* =====================================================================
 * Workspace.status
 * ===================================================================== */

export type WorkspacePhase = 'Pending' | 'Ready' | 'Failed' | 'Releasing';

/**
 * Standard Kubernetes condition pattern. Mirrors `AgentTaskCondition`
 * but kept distinct (different domain — different condition `type`
 * vocabularies).
 *
 * Known condition types emitted by the workspace controller:
 *
 *   - `PVCBound`           — PVC is in `phase: Bound` (provisioned)
 *   - `SourcePopulated`    — init-container Job completed successfully
 *   - `Ready`              — PVC bound + source populated (or none)
 *   - `Failed`             — init-container failed; cause in `message`
 *   - `Releasing`          — last reference dropped; ttl elapsed; PVC
 *                            being deleted in this reconcile pass
 *   - `QuotaWarning`       — utilization > 80%
 *   - `QuotaExceeded`      — utilization > 95%; admission refusing new
 *                            bindings
 */
export interface WorkspaceCondition {
  /** CamelCase identifier; see list above. */
  readonly type: string;
  readonly status: 'True' | 'False' | 'Unknown';
  readonly reason?: string;
  readonly message?: string;
  /** RFC 3339 timestamp; preserved across no-op rewrites. */
  readonly lastTransitionTime: string;
  /** `metadata.generation` observed when this condition was emitted. */
  readonly observedGeneration?: number;
}

export interface WorkspaceStatus {
  /**
   * Convenience boolean — true iff `phase === 'Ready'`. Operator-owned;
   * the operator's job-spec builder gates on this when deciding whether
   * to mount a Workspace input on a referencing AgentTask.
   */
  readonly ready?: boolean;
  /**
   * Lifecycle phase. `Pending` until PVC binds + source populates;
   * `Ready` once both complete; `Failed` if either step fails;
   * `Releasing` once the controller decides to GC.
   */
  readonly phase?: WorkspacePhase;
  /**
   * Number of bytes the PVC currently holds. Updated periodically by
   * the controller's quota probe. May lag reality by up to one probe
   * interval; readers tolerate stale data.
   */
  readonly bytesUsed?: number;
  /**
   * RFC 3339 timestamp of the most recent successful AgentTask binding
   * resolution. The TTL clock starts ticking from this timestamp once
   * no live consumers remain — see the controller's GC pass.
   */
  readonly lastReferencedAt?: string;
  /**
   * `metadata.generation` the operator most recently reconciled.
   * Standard Kubernetes pattern.
   */
  readonly observedGeneration?: number;
  /**
   * Append-only list of discrete conditions. The controller writes
   * `PVCBound`, `SourcePopulated`, `Ready`, `Failed`, `Releasing`,
   * `QuotaWarning`, `QuotaExceeded` here.
   */
  readonly conditions?: readonly WorkspaceCondition[];
  /**
   * Name of the Job the controller spawned to populate `source`. Empty
   * when `source` is unset (no clone needed).
   */
  readonly populationJobName?: string;
  /**
   * Name of the PVC the controller materialized for this Workspace.
   * Always equal to the Workspace's own name in v0.2.1 (1:1 mapping).
   */
  readonly pvcName?: string;
}

/* =====================================================================
 * Workspace top-level CR
 * ===================================================================== */

export interface Workspace {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'Workspace';
  readonly metadata: V1ObjectMeta;
  readonly spec: WorkspaceSpec;
  readonly status?: WorkspaceStatus;
}

/* =====================================================================
 * Type guard — runtime check for events handed back as `unknown`.
 * ===================================================================== */

export function isWorkspace(obj: unknown): obj is Workspace {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'Workspace') return false;
  const spec = o.spec as { pvc?: unknown } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  const pvc = spec.pvc as { storage?: unknown } | null;
  if (typeof pvc !== 'object' || pvc === null) return false;
  if (typeof pvc.storage !== 'string' || pvc.storage.length === 0) return false;
  return true;
}

/* =====================================================================
 * Helpers — TTL parsing + readiness predicates.
 * ===================================================================== */

/** Default TTL when `spec.ttl` is unset (24h, per Wave 1 spec). */
export const DEFAULT_WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a Go-style duration string into milliseconds. Supports `s`,
 * `m`, `h`, `d` suffixes (and combinations: `1h30m`). Returns null on
 * malformed input — the controller treats null as "use the default
 * TTL" rather than erroring (defensive: a bad string in the CR
 * shouldn't brick the controller's GC sweep).
 */
export function parseDuration(s: string | undefined): number | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  // Special-case "0" — explicit "no auto-GC".
  if (s === '0') return 0;
  let total = 0;
  let cursor = 0;
  // Walk pairs of (digits, suffix).
  const re = /(\d+)([smhd])/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== cursor) return null;
    const n = Number.parseInt(m[1] ?? '', 10);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = m[2];
    let mult: number;
    switch (unit) {
      case 's':
        mult = 1000;
        break;
      case 'm':
        mult = 60 * 1000;
        break;
      case 'h':
        mult = 60 * 60 * 1000;
        break;
      case 'd':
        mult = 24 * 60 * 60 * 1000;
        break;
      default:
        return null;
    }
    total += n * mult;
    cursor = m.index + m[0].length;
    consumed = cursor;
  }
  if (consumed === 0) return null;
  if (consumed !== s.length) return null;
  return total;
}

/**
 * Resolve the effective TTL in milliseconds for a Workspace. Returns:
 *   - the parsed `spec.ttl` when valid + non-zero,
 *   - `0` when `spec.ttl: '0'` (explicit GC opt-out),
 *   - `DEFAULT_WORKSPACE_TTL_MS` when `spec.ttl` is unset / malformed.
 */
export function resolveWorkspaceTtlMs(ws: Workspace | WorkspaceSpec): number {
  const spec = 'spec' in ws ? ws.spec : ws;
  const parsed = parseDuration(spec.ttl);
  if (parsed === null) return DEFAULT_WORKSPACE_TTL_MS;
  return parsed;
}

/**
 * Whether the Workspace is mountable by an AgentTask. The operator's
 * job-spec builder consults this before resolving an
 * `inputs[].from.workspace` binding to a real volume mount.
 *
 * "Ready" semantics: `status.phase === 'Ready'` AND `status.ready ===
 * true`. The two fields are kept in lockstep by the controller; we
 * check both as belt-and-suspenders against a partial status patch.
 */
export function isWorkspaceReady(ws: Workspace): boolean {
  if (ws.status === undefined) return false;
  if (ws.status.phase !== 'Ready') return false;
  return ws.status.ready === true;
}

/**
 * Whether the Workspace is in a terminal-bad phase. The operator's
 * admission path uses this to fail an AgentTask fast (rather than
 * leaving it suspended forever) when its referenced Workspace is
 * `Failed`.
 */
export function isWorkspaceFailed(ws: Workspace): boolean {
  return ws.status?.phase === 'Failed';
}
