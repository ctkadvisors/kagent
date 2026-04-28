/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Job annotation + suspension helpers — narrow surface used by the
 * WS-F suspended-publish dispatch path in `reconcile.ts`. Carved out
 * here so the merge-patch + read interactions stay independently
 * testable and the reconcile flow doesn't hand-roll patch bodies inline.
 *
 * Why three helpers:
 *
 *   - `readJob` — used to inspect the `dispatch-published` annotation
 *     before deciding whether to publish. K8s 409-AlreadyExists on
 *     create-Job is the operator's "this is a retry" signal; the
 *     annotation is the "we already published" signal.
 *
 *   - `markJobPublished` — JSON merge-patch on `metadata.annotations`.
 *     Operator only writes the annotation AFTER a successful publish,
 *     so a retry that crashed mid-publish sees no annotation and
 *     re-publishes (broker's dedupe ID drops the duplicate).
 *
 *   - `unsuspendJob` — JSON merge-patch on `spec.suspend: false`. K8s
 *     starts scheduling the pod the moment the patch lands. Final
 *     step in the dispatch sequence.
 *
 * All three use `application/merge-patch+json` (RFC 7396), matching
 * the Content-Type override in `k8s.ts:mergePatchOptions` (which is
 * for CustomObjectsApi). For BatchV1Api the generated client lets us
 * pass a pre-formatted body and infers the right Content-Type via
 * its options; we pass the body verbatim and let the client decide.
 */

import type { BatchV1Api, V1Job } from '@kubernetes/client-node';

/** Annotation key set on the spawned Job after a successful bus publish. */
export const DISPATCH_PUBLISHED_ANNOTATION = 'kagent.knuteson.io/dispatch-published';

/** Value written under {@link DISPATCH_PUBLISHED_ANNOTATION}. */
export const DISPATCH_PUBLISHED_TRUE = 'true';

/**
 * Read a Job by name. Returns `undefined` on 404 (job not yet created
 * in the watch path, or already GC'd). Any other error propagates.
 */
export async function readJob(
  batchApi: BatchV1Api,
  namespace: string,
  name: string,
): Promise<V1Job | undefined> {
  try {
    const res = await batchApi.readNamespacedJob({ namespace, name });

    return res;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

/**
 * Returns `true` iff the Job carries the `dispatch-published: "true"`
 * annotation. Defensive against missing `metadata` / `annotations`.
 */
export function isDispatchPublished(job: V1Job | undefined): boolean {
  if (job === undefined) return false;
  const annotations = job.metadata?.annotations;
  if (annotations === undefined || annotations === null) return false;
  return annotations[DISPATCH_PUBLISHED_ANNOTATION] === DISPATCH_PUBLISHED_TRUE;
}

/**
 * Stamp the `dispatch-published: "true"` annotation onto a Job via
 * JSON merge-patch. Idempotent — re-stamping is a no-op on the
 * apiserver side.
 *
 * Failure handling note: the WS-F dispatch sequence treats a failure
 * here as "publish succeeded, annotation didn't" — i.e. the message
 * is already on the bus, so a re-reconcile that finds no annotation
 * will republish, which the broker dedupe drops. Caller should log
 * but not propagate.
 */
export async function markJobPublished(
  batchApi: BatchV1Api,
  namespace: string,
  name: string,
): Promise<void> {
  const body = {
    metadata: {
      annotations: {
        [DISPATCH_PUBLISHED_ANNOTATION]: DISPATCH_PUBLISHED_TRUE,
      },
    },
  };
  await batchApi.patchNamespacedJob({ namespace, name, body });
}

/**
 * Patch `spec.suspend: false` to start scheduling the pod. K8s reacts
 * by creating the Pod object immediately; the Job controller picks
 * it up. Idempotent (already-unsuspended job stays unsuspended).
 */
export async function unsuspendJob(
  batchApi: BatchV1Api,
  namespace: string,
  name: string,
): Promise<void> {
  const body = { spec: { suspend: false } };
  await batchApi.patchNamespacedJob({ namespace, name, body });
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 404 || e.statusCode === 404;
}
