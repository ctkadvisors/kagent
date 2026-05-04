/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * RWX storage-class probe — Wave 1 / Workspace sub-team.
 *
 * Workspaces require a `ReadWriteMany` storage class (multi-pod
 * sharing is the whole point of the primitive — see
 * docs/SUBSTRATE-V1.md §3.4). At controller startup we probe the
 * cluster: create a tiny `1Mi` PVC with `accessModes: [ReadWriteMany]`
 * (in the operator's release namespace) and watch whether it binds
 * within a short window. If it does, RWX is available; if it
 * doesn't, the operator emits a clear startup log line and leaves
 * the controller running but reporting `phase: Pending` on every
 * Workspace CR (the controller's regular reconcile path will surface
 * the unbound PVC as a `PVCBound: False` condition + Pending phase).
 *
 * The probe never crashes the operator — `workspaces.enabled=true`
 * with no RWX class is an operational misconfiguration, not a fatal
 * substrate error. Workspaces stay in Pending and ops sees the
 * probe failure in logs.
 *
 * Cleanup: the probe deletes its own PVC after observing the
 * outcome, regardless of whether it bound. Worst case (operator
 * crash mid-probe) the PVC's ownerless and the cluster operator
 * removes it manually — a 1Mi storage waste isn't worth a
 * background reaper for v0.2.1.
 */

import { type CoreV1Api, type V1PersistentVolumeClaim } from '@kubernetes/client-node';

/**
 * Deterministic probe-PVC name. Same name every time so a re-probe
 * after operator restart re-uses the prior PVC (idempotent). The
 * `kagent-rwx-probe-` prefix makes the object easy to grep.
 */
export const RWX_PROBE_PVC_NAME = 'kagent-rwx-probe';

/** How long we wait for the probe PVC to bind before declaring miss. */
export const DEFAULT_RWX_PROBE_TIMEOUT_MS = 30_000;

/** How often we poll PVC.status.phase. K8s typically binds in ~1s on
 *  a healthy provisioner, but flannel-only clusters (no RWX provisioner)
 *  never bind — the probe just times out. */
const POLL_INTERVAL_MS = 1_000;

export interface RwxProbeOptions {
  /** Namespace to create the probe PVC in (typically the operator's). */
  readonly namespace: string;
  /** StorageClass to probe. Defaults to the cluster default when undefined. */
  readonly storageClassName?: string;
  /** Timeout in ms. Defaults to 30s. */
  readonly timeoutMs?: number;
  /**
   * Test seam — replaces the default `setTimeout`-based wait. Tests
   * pass a synchronous fake so they don't sit on a real clock.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type RwxProbeResult =
  | { readonly kind: 'rwx-available'; readonly storageClassName: string | undefined }
  | { readonly kind: 'rwx-unavailable'; readonly reason: string }
  | { readonly kind: 'probe-error'; readonly message: string };

/**
 * Run the probe. Always cleans up its own PVC; the result indicates
 * whether RWX is usable.
 *
 * Pure-ish: the only side effect is creating + deleting the probe
 * PVC; there is no log output (caller handles logging).
 */
export async function probeRwxStorageClass(
  coreApi: CoreV1Api,
  options: RwxProbeOptions,
): Promise<RwxProbeResult> {
  const { namespace } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RWX_PROBE_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;

  const pvc: V1PersistentVolumeClaim = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: RWX_PROBE_PVC_NAME,
      namespace,
      labels: {
        'kagent.knuteson.io/managed-by': 'kagent-rwx-probe',
      },
      annotations: {
        'kagent.knuteson.io/probe-purpose': 'verify ReadWriteMany support',
      },
    },
    spec: {
      accessModes: ['ReadWriteMany'],
      resources: { requests: { storage: '1Mi' } },
      ...(options.storageClassName !== undefined && {
        storageClassName: options.storageClassName,
      }),
    },
  };

  // Best-effort delete-if-exists from a prior probe so a stale
  // unbound PVC doesn't poison this run. 404 is fine.
  await deleteProbePvcQuiet(coreApi, namespace);

  // Create.
  try {
    await coreApi.createNamespacedPersistentVolumeClaim({ namespace, body: pvc });
  } catch (err) {
    if (isInvalidProvisioner(err)) {
      // K8s rejected the PVC outright — typically an unknown
      // StorageClass + RWX combo. The provisioner doesn't exist.
      return {
        kind: 'rwx-unavailable',
        reason: `apiserver rejected ReadWriteMany PVC: ${stringifyErr(err)}`,
      };
    }
    return { kind: 'probe-error', message: stringifyErr(err) };
  }

  // Poll for Bound. Use wall-clock budget; the sleep injection seam
  // makes this fast in tests.
  const deadline = Date.now() + timeoutMs;
  let bound = false;
  let lastPhase: string | undefined;
  try {
    while (Date.now() < deadline) {
      try {
        const cur = await coreApi.readNamespacedPersistentVolumeClaim({
          namespace,
          name: RWX_PROBE_PVC_NAME,
        });
        lastPhase = cur.status?.phase;
        if (lastPhase === 'Bound') {
          bound = true;
          break;
        }
      } catch (err) {
        // Read failures are transient — keep polling until the timeout.
        lastPhase = `read-error:${stringifyErr(err)}`;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    // Always clean up.
    await deleteProbePvcQuiet(coreApi, namespace);
  }

  if (bound) {
    return { kind: 'rwx-available', storageClassName: options.storageClassName };
  }
  return {
    kind: 'rwx-unavailable',
    reason: `probe PVC did not bind within ${String(timeoutMs)}ms (last phase=${lastPhase ?? 'unknown'})`,
  };
}

async function deleteProbePvcQuiet(coreApi: CoreV1Api, namespace: string): Promise<void> {
  try {
    await coreApi.deleteNamespacedPersistentVolumeClaim({
      namespace,
      name: RWX_PROBE_PVC_NAME,
    });
  } catch (err) {
    if (!isNotFound(err)) {
      // Best-effort: log-and-swallow. The probe runs at startup; a
      // delete failure here just leaves a 1Mi PVC behind.
      console.warn(
        `[kagent-workspace] RWX probe: delete probe PVC ${namespace}/${RWX_PROBE_PVC_NAME} failed (continuing):`,
        err,
      );
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 404 || e.statusCode === 404;
}

function isInvalidProvisioner(err: unknown): boolean {
  // K8s returns 422 (Invalid) when an admission plugin rejects an
  // unknown access-mode/storage-class combination. Treating 422 as
  // "rwx unavailable" lets the operator boot with a clean message.
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 422 || e.statusCode === 422;
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}
